import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { VcsError } from "../git.ts";
import { isTrackerPath, itemIdFromPath, previewMerge, streamResolution } from "../preview.ts";
import { type Sandbox, createDivergedSandbox, createSandbox } from "./helpers/sandbox.ts";

const sandboxes: Sandbox[] = [];

/**
 * Registers a sandbox for teardown and returns it.
 *
 * @param sandbox - Sandbox to track.
 * @returns The same sandbox.
 */
function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

after(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

test("preview predicts exactly what a real merge produces", () => {
  const { sandbox, itemId } = createDivergedSandbox();
  track(sandbox);

  const report = previewMerge({
    ref: "agent-b",
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });

  const item = report.entries.find((entry) => entry.path.endsWith(`${itemId}.toon`));
  assert.ok(item, "the diverged item document should appear in the preview");
  assert.equal(item.artifact, "item");
  assert.equal(item.resolution, "conflict");
  assert.deepEqual(item.conflict_fields, ["priority"]);
  assert.ok(item.union_fields.includes("notes"), "notes is a union collection");
  assert.equal(item.item_id, itemId);

  const history = report.entries.find((entry) => entry.path.endsWith(`${itemId}.jsonl`));
  assert.ok(history, "the item's history stream should appear in the preview");
  assert.equal(history.artifact, "history");
  assert.equal(history.resolution, "union");
  assert.equal(history.stream_strategy, "union_reanchor");
  assert.ok(history.entries_total !== null && history.entries_total > 0);

  assert.equal(report.totals.conflict, 1);
  assert.equal(report.totals.union, 1);
  assert.equal(report.already_merged, false);

  // The prediction is only worth anything if the real merge agrees. Perform it.
  let mergeFailed = false;
  try {
    execFileSync("git", ["merge", "--no-edit", "agent-b"], {
      cwd: sandbox.root,
      encoding: "utf8",
      env: { ...process.env, GIT_PAGER: "cat" },
    });
  } catch {
    mergeFailed = true;
  }

  // The driver signals the unresolvable scalar by failing the merge, which is
  // what `resolution: "conflict"` predicted for this exact path.
  assert.ok(mergeFailed, "git should report the predicted conflict");
  const conflicted = sandbox.git("diff", "--name-only", "--diff-filter=U");
  assert.ok(
    conflicted.includes(`${itemId}.toon`),
    `git should mark the predicted path conflicted, got: ${conflicted}`,
  );

  // And the field-aware outcome must match the prediction's detail: ours won the
  // conflicted scalar, and both sides' notes survived the union.
  const merged = sandbox.pm("get", itemId, "--json");
  const document = JSON.parse(merged) as { item: { priority: number; notes_count: number } };
  assert.equal(document.item.priority, 1, "ours wins the conflicted scalar");
  assert.equal(document.item.notes_count, 2, "both agents' notes survive");
});

test("preview reports an ancestor ref as already merged with nothing to decide", () => {
  const sandbox = track(createSandbox());
  sandbox.createItem("Task", "Only item");
  const base = sandbox.commit("Add an item");
  sandbox.git("checkout", "-q", "-b", "ahead");
  sandbox.pm("update", sandbox.createItem("Task", "Second item"), "--priority", "2");
  sandbox.commit("Move ahead");

  const report = previewMerge({
    ref: base,
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });
  assert.equal(report.already_merged, true);
  assert.equal(report.entries.length, 0, "an ancestor changes nothing on both sides");
  assert.equal(report.base, base);
});

test("preview reports a one-sided change as nothing to decide", () => {
  const sandbox = track(createSandbox());
  const itemId = sandbox.createItem("Task", "Touched on one side only");
  const base = sandbox.commit("Add an item");

  sandbox.git("checkout", "-q", "-b", "only-theirs");
  sandbox.pm("update", itemId, "--priority", "1");
  sandbox.commit("Change it on theirs only");
  sandbox.git("checkout", "-q", "main");

  const report = previewMerge({
    ref: "only-theirs",
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });
  assert.equal(report.base, base);
  assert.equal(report.entries.length, 0, "a fast-forward consults no driver");
});

test("preview classifies a tracker JSON artifact and a driverless path", () => {
  const sandbox = track(createSandbox());
  const base = sandbox.git("rev-parse", "HEAD");

  // A plain-text tracker file matches no fence pattern, so git reports no merge
  // driver for it: the `unprotected` finding, which is a silent line-merge risk.
  const unprotected = join(sandbox.pmRoot, "scratch.txt");

  sandbox.git("checkout", "-q", "-b", "json-a");
  // Both sides must move the same key away from its default, or the artifact
  // changes on one side only and no driver is consulted for it.
  sandbox.pm("config", "project", "set", "locks_ttl_seconds", "111");
  writeFileSync(unprotected, "ours\n");
  sandbox.commit("Ours: settings and a driverless file");

  sandbox.git("checkout", "-q", "-b", "json-b", base);
  sandbox.pm("config", "project", "set", "locks_ttl_seconds", "222");
  writeFileSync(unprotected, "theirs\n");
  sandbox.commit("Theirs: settings and a driverless file");

  sandbox.git("checkout", "-q", "json-a");
  const report = previewMerge({
    ref: "json-b",
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });

  const settings = report.entries.find((entry) => entry.path.endsWith("settings.json"));
  assert.ok(settings, "settings.json changed on both sides");
  assert.equal(settings.artifact, "json");
  assert.equal(settings.driver, "pm-json");
  assert.equal(settings.item_id, null, "settings.json belongs to no single item");

  const driverless = report.entries.find((entry) => entry.path.endsWith("scratch.txt"));
  assert.ok(driverless, "the driverless file changed on both sides");
  assert.equal(driverless.resolution, "unprotected");
  assert.equal(driverless.driver, null);
  assert.equal(driverless.artifact, null);
  assert.equal(report.totals.unprotected, 1);
});

test("preview merges a relationship event stream through its own driver", () => {
  const sandbox = track(createSandbox());
  const base = sandbox.git("rev-parse", "HEAD");
  // A tracker JSONL outside history/ resolves to the pm-relationship driver.
  const store = join(sandbox.pmRoot, "relationships", "events.jsonl");
  // Recreated before each write: checking out a commit that lacks the tracked
  // file also removes the directory that held it.
  const writeStore = (body: string): void => {
    mkdirSync(join(sandbox.pmRoot, "relationships"), { recursive: true });
    writeFileSync(store, body);
  };

  const event = (sequence: number, id: string): string =>
    `${JSON.stringify({ sequence, eventId: id, at: `2026-07-30T00:0${sequence}:00.000Z` })}\n`;

  sandbox.git("checkout", "-q", "-b", "rel-a");
  writeStore(event(1, "shared") + event(2, "ours"));
  sandbox.commit("Ours: append an event");

  sandbox.git("checkout", "-q", "-b", "rel-b", base);
  writeStore(event(1, "shared") + event(2, "theirs"));
  sandbox.commit("Theirs: append a different event");

  sandbox.git("checkout", "-q", "rel-a");
  const report = previewMerge({
    ref: "rel-b",
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });

  const relationship = report.entries.find((entry) => entry.path.endsWith("events.jsonl"));
  assert.ok(relationship, "the relationship store changed on both sides");
  assert.equal(relationship.artifact, "relationship");
  assert.equal(relationship.driver, "pm-relationship");
  assert.equal(relationship.resolution, "union");
  assert.equal(relationship.entries_total, 3, "both divergent events survive the union");
});

test("preview restricts itself to tracker paths", () => {
  const sandbox = track(createSandbox());
  const base = sandbox.git("rev-parse", "HEAD");
  const source = join(sandbox.root, "src.ts");

  sandbox.git("checkout", "-q", "-b", "code-a");
  writeFileSync(source, "export const value = 1;\n");
  sandbox.commit("Ours: add source");

  sandbox.git("checkout", "-q", "-b", "code-b", base);
  writeFileSync(source, "export const value = 2;\n");
  sandbox.commit("Theirs: add the same source differently");

  sandbox.git("checkout", "-q", "code-a");
  const report = previewMerge({
    ref: "code-b",
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });
  assert.equal(report.entries.length, 0, "source files are not tracker artifacts");
});

test("preview refuses a ref that does not resolve", () => {
  const sandbox = track(createSandbox());
  assert.throws(
    () => previewMerge({ ref: "no-such-ref", repoRoot: sandbox.root, trackerPrefix: ".agents/pm" }),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.equal(error.code, "ref_not_found");
      assert.match(error.message, /git fetch origin/);
      return true;
    },
  );
});

test("preview refuses an unborn HEAD", () => {
  const sandbox = track(createSandbox());
  // An orphan branch leaves HEAD pointing at an unborn ref while `main` still
  // resolves, which is the only way `theirs` can resolve while `ours` cannot.
  sandbox.git("checkout", "-q", "--orphan", "fresh");
  assert.throws(
    () => previewMerge({ ref: "main", repoRoot: sandbox.root, trackerPrefix: ".agents/pm" }),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.equal(error.code, "head_not_found");
      return true;
    },
  );
});

test("preview refuses two histories that share no ancestor", () => {
  const sandbox = track(createSandbox());
  sandbox.git("checkout", "-q", "--orphan", "unrelated");
  writeFileSync(join(sandbox.root, "unrelated.txt"), "unrelated\n");
  sandbox.git("add", "-A");
  sandbox.git("commit", "-q", "-m", "Unrelated root commit");

  assert.throws(
    () => previewMerge({ ref: "main", repoRoot: sandbox.root, trackerPrefix: ".agents/pm" }),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.equal(error.code, "git_command_failed");
      assert.match(error.message, /share no common ancestor/);
      return true;
    },
  );
});

test("tracker-path and item-id derivation cover their edge cases", () => {
  // A tracker at the repository root treats every path as in scope.
  assert.equal(isTrackerPath("anything.toon", ""), true);
  assert.equal(isTrackerPath(".agents/pm", ".agents/pm"), true);
  assert.equal(isTrackerPath(".agents/pm/tasks/a.toon", ".agents/pm"), true);
  // A sibling directory sharing the prefix must not be mistaken for the tracker.
  assert.equal(isTrackerPath(".agents/pm-other/tasks/a.toon", ".agents/pm"), false);
  assert.equal(isTrackerPath("src/index.ts", ".agents/pm"), false);

  assert.equal(itemIdFromPath(".agents/pm/tasks/sbx-a1b2.toon", "item"), "sbx-a1b2");
  assert.equal(itemIdFromPath(".agents/pm/history/sbx-a1b2.jsonl", "history"), "sbx-a1b2");
  assert.equal(itemIdFromPath(".agents/pm/settings.json", "json"), null);
  assert.equal(itemIdFromPath(".agents/pm/rel/events.jsonl", "relationship"), null);
  assert.equal(itemIdFromPath("scratch.txt", null), null);
  // A dotfile basename has no extension to strip and no id to report.
  assert.equal(itemIdFromPath(".agents/pm/tasks/.toon", "item"), null);
  // A basename with no dot at all still yields its whole name as the id.
  assert.equal(itemIdFromPath(".agents/pm/tasks/plain", "item"), "plain");
});

test("stream strategies map onto resolutions", () => {
  assert.equal(streamResolution("union_reanchor"), "union");
  assert.equal(streamResolution("identical"), "clean");
  assert.equal(streamResolution("fast_forward_ours"), "clean");
  assert.equal(streamResolution("fast_forward_theirs"), "clean");
});

test("a tracker path claimed by a non-pm merge driver is still unprotected", () => {
  // A driver name git reports that pm does not ship has no field-aware merge
  // function behind it, so the path is as unprotected as one with no driver at
  // all — and saying so is the whole point of the finding.
  const sandbox = track(createSandbox());
  const base = sandbox.git("rev-parse", "HEAD");
  const foreign = join(sandbox.pmRoot, "foreign.dat");
  writeFileSync(join(sandbox.root, ".gitattributes"), '".agents/pm/*.dat" merge=ours\n', {
    flag: "a",
  });
  sandbox.commit("Claim a tracker path with a non-pm driver");

  sandbox.git("checkout", "-q", "-b", "foreign-a");
  writeFileSync(foreign, "ours\n");
  sandbox.commit("Ours");
  sandbox.git("checkout", "-q", "-b", "foreign-b", "HEAD~1");
  writeFileSync(foreign, "theirs\n");
  sandbox.commit("Theirs");
  sandbox.git("checkout", "-q", "foreign-a");

  const report = previewMerge({
    ref: "foreign-b",
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });
  const entry = report.entries.find((candidate) => candidate.path.endsWith("foreign.dat"));
  assert.ok(entry, "the foreign-driver path changed on both sides");
  assert.equal(entry.driver, "ours", "git reports the driver it would use");
  assert.equal(entry.artifact, null, "pm ships no merge function for it");
  assert.equal(entry.resolution, "unprotected");
  assert.notEqual(base, report.base);
});

test("an item deleted on one side and edited on the other is a delete/modify", () => {
  // Git settles delete/modify at the tree level and never runs a merge driver, so
  // neither does the preview. Handing the item primitive an empty side is not
  // what a real merge does, and it rejects it outright ("not a readable item
  // document") rather than reading it as a deletion — so the structural decision
  // is what gets reported.
  const sandbox = track(createSandbox());
  const itemId = sandbox.createItem("Task", "Deleted on one side");
  const base = sandbox.commit("Add the item");

  sandbox.git("checkout", "-q", "-b", "editor");
  sandbox.pm("notes", itemId, "--add", "Edited rather than deleted");
  sandbox.commit("Edit the item");

  sandbox.git("checkout", "-q", "-b", "deleter", base);
  sandbox.pm("delete", itemId);
  sandbox.commit("Delete the item");

  sandbox.git("checkout", "-q", "editor");
  const report = previewMerge({
    ref: "deleter",
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });
  const entry = report.entries.find((candidate) => candidate.path.endsWith(`${itemId}.toon`));
  assert.ok(entry, "the item document changed on both sides");
  assert.equal(entry.artifact, "item");
  assert.equal(entry.resolution, "delete_modify");
  assert.deepEqual(entry.conflict_fields, []);
  assert.equal(report.totals.delete_modify, 1);
  assert.equal(report.totals.conflict, 0, "a delete/modify is not a field collision");
});

test("an item diverging only on a union collection predicts union, not conflict", () => {
  // Two agents appending notes touch no shared scalar, so the item merges by
  // element-identity union with nothing to decide. This is the case that should
  // reassure an agent it can merge, and it must not be reported as a conflict.
  const sandbox = track(createSandbox());
  const itemId = sandbox.createItem("Task", "Notes only on both sides");
  const base = sandbox.commit("Add the item");

  sandbox.git("checkout", "-q", "-b", "notes-a");
  sandbox.pm("notes", itemId, "--add", "Only agent A wrote this");
  sandbox.commit("Agent A note");

  sandbox.git("checkout", "-q", "-b", "notes-b", base);
  sandbox.pm("notes", itemId, "--add", "Only agent B wrote this");
  sandbox.commit("Agent B note");

  sandbox.git("checkout", "-q", "notes-a");
  const report = previewMerge({
    ref: "notes-b",
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });
  const entry = report.entries.find((candidate) => candidate.path.endsWith(`${itemId}.toon`));
  assert.ok(entry, "the item document changed on both sides");
  assert.equal(entry.resolution, "union");
  assert.deepEqual(entry.conflict_fields, []);
  assert.ok(entry.union_fields.includes("notes"));
  assert.equal(report.totals.conflict, 0);
});
