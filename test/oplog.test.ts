import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { ObjectStoreError } from "../engine/objects.ts";
import { RefStore } from "../engine/refs.ts";
import { OperationLog } from "../engine/oplog.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

/**
 * Creates a log and a ref store sharing a fresh directory.
 *
 * @returns The log, the ref store, and the directory root.
 */
function fresh(): { log: OperationLog; refs: RefStore; root: string } {
  dir = makeTempDir();
  const root = join(dir.root, ".pmvcs");
  return { log: new OperationLog(join(root, "oplog.jsonl")), refs: new RefStore(root), root };
}

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

const id = "abcdef0123456789".repeat(4);
const otherId = "0123456789abcdef".repeat(4);

test("read returns nothing for a log with no file, and append assigns monotonic sequence numbers", () => {
  const { log } = fresh();
  assert.deepEqual(log.read(), []);
  const first = log.append("commit", "first", [{ ref: "refs/heads/main", before: null, after: id }], new Date(0));
  const second = log.append("commit", "second", [{ ref: "refs/heads/main", before: id, after: otherId }], new Date(1));
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(log.read().length, 2);
});

test("append survives a non-parseable earlier line by skipping it", () => {
  // A torn append leaves a half-written line. The next append recomputes the
  // sequence from the readable entries alone, so the log stays usable.
  const { log, root } = fresh();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "oplog.jsonl"), "this is not json\n");
  const op = log.append("commit", "after-torn", [], new Date(0));
  assert.equal(op.sequence, 1);
  // The bad line is skipped on read.
  assert.equal(log.read().length, 1);
});

test("undo of the most recent operation restores every ref it moved", () => {
  const { log, refs } = fresh();
  refs.compareAndSwap("refs/heads/main", null, id);
  log.append("commit", "move main", [{ ref: "refs/heads/main", before: null, after: id }], new Date(0));
  // Move it on, then undo the move: the ref returns to its before value.
  refs.compareAndSwap("refs/heads/main", id, otherId);
  log.append("commit", "advance main", [{ ref: "refs/heads/main", before: id, after: otherId }], new Date(1));

  log.undo(refs, null, new Date(2));
  assert.equal(refs.read("refs/heads/main"), id);
});

test("undo of a specific earlier operation restores only that one", () => {
  const { log, refs } = fresh();
  refs.compareAndSwap("refs/heads/a", null, id);
  log.append("commit", "a", [{ ref: "refs/heads/a", before: null, after: id }], new Date(0));
  refs.compareAndSwap("refs/heads/b", null, otherId);
  log.append("commit", "b", [{ ref: "refs/heads/b", before: null, after: otherId }], new Date(1));

  log.undo(refs, 1, new Date(2));
  assert.equal(refs.read("refs/heads/a"), null);
  assert.equal(refs.read("refs/heads/b"), otherId);
});

test("undo refuses an empty log and an unknown sequence", () => {
  const { log, refs } = fresh();
  assert.throws(
    () => log.undo(refs, null, new Date(0)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "nothing_to_undo",
  );

  log.append("commit", "only", [], new Date(0));
  assert.throws(
    () => log.undo(refs, 42, new Date(0)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unknown_operation",
  );
});

test("undo refuses when a ref has since moved on", () => {
  const { log, refs } = fresh();
  refs.compareAndSwap("refs/heads/main", null, id);
  log.append("commit", "set", [{ ref: "refs/heads/main", before: null, after: id }], new Date(0));
  // Simulate another operation moving the ref out from under the recorded `after`.
  refs.compareAndSwap("refs/heads/main", id, otherId);
  assert.throws(
    () => log.undo(refs, 1, new Date(1)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "ref_changed",
  );
});
