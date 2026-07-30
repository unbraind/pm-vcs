import assert from "node:assert/strict";
import { test } from "node:test";

import { type RecordDocument } from "../engine/model.ts";
import { mergeAppendOnlyLog, mergeRecords } from "../engine/records.ts";

test("disjoint field changes merge clean and report both changed fields", () => {
  const base: RecordDocument = { title: "x", priority: 1, status: "open" };
  const ours: RecordDocument = { title: "ours", priority: 1, status: "open" };
  const theirs: RecordDocument = { title: "x", priority: 3, status: "open" };
  const result = mergeRecords(base, ours, theirs);
  assert.equal(result.clean, true);
  assert.equal(result.document.title, "ours");
  assert.equal(result.document.priority, 3);
  assert.equal(result.document.status, "open");
  assert.deepEqual([...result.changedFields].sort(), ["priority", "title"]);
});

test("a scalar disagreement conflicts on that field alone while other fields still merge", () => {
  // Both sides move priority to different values (a conflict), but only one side
  // touches title (clean). The conflict must not poison the clean field.
  const base: RecordDocument = { title: "x", priority: 1 };
  const ours: RecordDocument = { title: "ours", priority: 2 };
  const theirs: RecordDocument = { title: "x", priority: 3 };
  const result = mergeRecords(base, ours, theirs);
  assert.equal(result.clean, false);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].field, "priority");
  assert.equal(result.conflicts[0].ours, 2);
  assert.equal(result.conflicts[0].theirs, 3);
  // The clean title change survives the conflict.
  assert.equal(result.document.title, "ours");
});

test("both sides making the same scalar change is agreement, not conflict", () => {
  const base: RecordDocument = { priority: 1 };
  const both: RecordDocument = { priority: 5 };
  const result = mergeRecords(base, both, both);
  assert.equal(result.clean, true);
  assert.equal(result.document.priority, 5);
});

test("a field one side deleted is deleted", () => {
  const base: RecordDocument = { keep: 1, drop: 2 };
  const ours: RecordDocument = { keep: 1 };
  const theirs: RecordDocument = { keep: 1, drop: 2 };
  const result = mergeRecords(base, ours, theirs);
  assert.equal(result.clean, true);
  assert.equal("drop" in result.document, false);
  assert.ok(result.changedFields.includes("drop"));
});

test("a field both sides added independently merges by the inferred strategy", () => {
  // No base field at all. Arrays merge as a set by inference, scalars conflict.
  const base: RecordDocument = {};
  const setResult = mergeRecords(base, { tags: ["a", "b"] }, { tags: ["b", "c"] });
  assert.equal(setResult.clean, true);
  assert.deepEqual(setResult.document.tags, ["a", "b", "c"].sort());

  const scalarResult = mergeRecords(base, { kind: "task" }, { kind: "bug" });
  assert.equal(scalarResult.clean, false);
  assert.equal(scalarResult.conflicts[0].field, "kind");
});

test("set strategy unions and de-duplicates regardless of order", () => {
  const base: RecordDocument = { watchers: ["a"] };
  const ours: RecordDocument = { watchers: ["a", "b"] };
  const theirs: RecordDocument = { watchers: ["a", "c"] };
  const result = mergeRecords(base, ours, theirs, { fields: { watchers: "set" } });
  assert.equal(result.clean, true);
  assert.deepEqual(result.document.watchers, ["a", "b", "c"].sort());
});

test("set strategy honours a removal by one side", () => {
  // Both sides start with a, b. Ours removes b; theirs leaves it. Removal is a
  // change like any other, and the untouched side defers — so b is gone.
  const base: RecordDocument = { watchers: ["a", "b"] };
  const ours: RecordDocument = { watchers: ["a"] };
  const theirs: RecordDocument = { watchers: ["a", "b"] };
  const result = mergeRecords(base, ours, theirs, { fields: { watchers: "set" } });
  assert.equal(result.clean, true);
  assert.deepEqual(result.document.watchers, ["a"]);
});

test("sequence strategy preserves both sides' additions in arrival order", () => {
  const base: RecordDocument = { log: ["base"] };
  const ours: RecordDocument = { log: ["base", "ours"] };
  const theirs: RecordDocument = { log: ["base", "theirs"] };
  const result = mergeRecords(base, ours, theirs, { fields: { log: "sequence" } });
  assert.equal(result.clean, true);
  // Base members first, then ours' additions, then theirs'.
  assert.deepEqual(result.document.log, ["base", "ours", "theirs"]);
});

test("a fallback strategy applies to fields the policy does not name", () => {
  const base: RecordDocument = { x: 1, y: 2 };
  const ours: RecordDocument = { x: 10, y: 20 };
  const theirs: RecordDocument = { x: 11, y: 21 };
  // A scalar fallback makes both fields conflict; a set fallback would union them.
  const scalarResult = mergeRecords(base, ours, theirs, { fallback: "scalar" });
  assert.equal(scalarResult.clean, false);
  assert.deepEqual(scalarResult.conflicts.map((c) => c.field).sort(), ["x", "y"]);

  const setResult = mergeRecords(base, ours, theirs, { fallback: "set" });
  assert.equal(setResult.clean, true);
  assert.deepEqual(setResult.document.x, [10, 11].sort());
});

test("mergeAppendOnlyLog unions, de-duplicates and orders by timestamp", () => {
  const base = [
    JSON.stringify({ at: "2024-01-01T00:00:00Z", v: 1 }),
    JSON.stringify({ at: "2024-01-02T00:00:00Z", v: 2 }),
  ];
  const ours = [
    JSON.stringify({ at: "2024-01-02T00:00:00Z", v: 2 }),
    JSON.stringify({ at: "2024-01-03T00:00:00Z", v: 3 }),
  ];
  const theirs = [JSON.stringify({ at: "2024-01-04T00:00:00Z", v: 4 })];
  const merged = mergeAppendOnlyLog(base, ours, theirs);
  // Deduplicated (v:2 appears once) and ordered by `at`.
  const values = merged.map((line) => (JSON.parse(line) as { v: number }).v);
  assert.deepEqual(values, [1, 2, 3, 4]);
});

test("mergeAppendOnlyLog keeps non-JSON and duplicate lines without crashing", () => {
  // A torn or non-JSON line still belongs in the union; it carries no timestamp
  // of its own and inherits the last one seen so it stays adjacent to neighbours.
  const base = ["plain-before"];
  const ours = [JSON.stringify({ at: "2024-01-05T00:00:00Z", v: 5 }), "plain-after"];
  const theirs = ["plain-before", JSON.stringify({ at: "2024-01-03T00:00:00Z", v: 3 })];
  const merged = mergeAppendOnlyLog(base, ours, theirs);
  // The duplicate "plain-before" appears once.
  assert.equal(merged.filter((line) => line === "plain-before").length, 1);
  // Everything from every side survives.
  assert.ok(merged.includes("plain-after"));
  assert.ok(merged.some((line) => line.includes("\"v\":3")));
  assert.ok(merged.some((line) => line.includes("\"v\":5")));
});
