import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { VcsError } from "../git.ts";
import { changeKind, itemDocumentId, itemsInRange } from "../ledger.ts";
import { type Sandbox, createSandbox } from "./helpers/sandbox.ts";

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

test("a range reports the items it created, modified and deleted", () => {
  const sandbox = track(createSandbox());
  const preexisting = sandbox.createItem("Task", "Existed before the range");
  const doomed = sandbox.createItem("Task", "Will be deleted in the range");
  const start = sandbox.commit("Add two items before the range");

  const created = sandbox.createItem("Feature", "Created inside the range");
  sandbox.commit("Create a feature");
  sandbox.pm("update", preexisting, "--priority", "1");
  sandbox.commit("Modify the pre-existing item");
  sandbox.pm("delete", doomed);
  sandbox.commit("Delete an item");

  const report = itemsInRange({
    range: `${start}..HEAD`,
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });

  assert.equal(report.commits, 3);
  assert.equal(report.range, `${start}..HEAD`);

  const byId = new Map(report.items.map((item) => [item.id, item]));
  assert.equal(byId.get(created)?.kind, "created");
  assert.equal(byId.get(preexisting)?.kind, "modified");
  assert.equal(byId.get(doomed)?.kind, "deleted");
  assert.deepEqual(report.totals, { created: 1, modified: 1, deleted: 1 });

  // Items are ordered by id so the output is stable across runs, which matters
  // when this feeds a PR body or release notes. Compared against an
  // independently sorted copy rather than sorting both sides — sorting the actual
  // output too would make this assertion unable to detect unordered output at all.
  const returned = report.items.map((item) => item.id);
  assert.deepEqual(returned, [...returned].sort(), "items must already be ordered by id");
  assert.deepEqual([...returned].sort(), [...byId.keys()].sort(), "and cover the same set");

  // Each item carries the commits that touched it, newest first, with the
  // authorship a changelog needs.
  const feature = byId.get(created);
  assert.ok(feature);
  assert.equal(feature.commits.length, 1);
  assert.equal(feature.commits[0]?.subject, "Create a feature");
  assert.equal(feature.commits[0]?.author, "pm-vcs harness");
  assert.match(feature.commits[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.match(feature.path, /\.agents\/pm\/features\//);
});

test("an item created and then edited inside the range reads as created", () => {
  // The earliest change in the range decides the kind: an item that did not
  // exist before the range was created by it, however many times it then changed.
  const sandbox = track(createSandbox());
  const start = sandbox.git("rev-parse", "HEAD");
  const itemId = sandbox.createItem("Task", "Created then edited");
  sandbox.commit("Create it");
  sandbox.pm("notes", itemId, "--add", "First edit");
  sandbox.commit("Edit it");
  sandbox.pm("notes", itemId, "--add", "And again");
  sandbox.commit("Edit it again");

  const report = itemsInRange({
    range: `${start}..HEAD`,
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0]?.kind, "created");
  assert.equal(report.items[0]?.commits.length, 3, "every touching commit is retained");
  // Newest first, so a reader sees the latest state of the work first.
  assert.equal(report.items[0]?.commits[0]?.subject, "Edit it again");
  assert.equal(report.items[0]?.commits[2]?.subject, "Create it");
});

test("an item modified and then deleted inside the range reads as deleted", () => {
  const sandbox = track(createSandbox());
  const itemId = sandbox.createItem("Task", "Modified then deleted");
  const start = sandbox.commit("Add the item");
  sandbox.pm("update", itemId, "--priority", "1");
  sandbox.commit("Modify it");
  sandbox.pm("delete", itemId);
  sandbox.commit("Delete it");

  const report = itemsInRange({
    range: `${start}..HEAD`,
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0]?.kind, "deleted", "the final state in the range wins");
});

test("a range counts each item once, ignoring history streams and settings", () => {
  // Every item mutation also writes the item's history stream and can touch
  // tracker config. Counting those would double or triple each item.
  const sandbox = track(createSandbox());
  const start = sandbox.git("rev-parse", "HEAD");
  const itemId = sandbox.createItem("Task", "One item, several artifacts");
  sandbox.pm("config", "project", "set", "locks_ttl_seconds", "321");
  sandbox.commit("One commit touching item, history and settings");

  const report = itemsInRange({
    range: `${start}..HEAD`,
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });
  assert.deepEqual(report.items.map((item) => item.id), [itemId]);
});

test("a range ignores changes outside the tracker", () => {
  const sandbox = track(createSandbox());
  const start = sandbox.git("rev-parse", "HEAD");
  writeFileSync(join(sandbox.root, "source.ts"), "export const x = 1;\n");
  sandbox.commit("Add source outside the tracker");

  const report = itemsInRange({
    range: `${start}..HEAD`,
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });
  assert.equal(report.items.length, 0);
  assert.equal(report.commits, 1, "the commit is still counted, it just touched no items");
});

test("a range git cannot parse fails with a remediation", () => {
  const sandbox = track(createSandbox());
  assert.throws(
    () =>
      itemsInRange({
        range: "not-a-ref..also-not-a-ref",
        repoRoot: sandbox.root,
        trackerPrefix: ".agents/pm",
      }),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.equal(error.code, "git_command_failed");
      assert.match(error.message, /revision range and paths are valid/);
      return true;
    },
  );
});

test("item-document paths are recognised and non-item artifacts are not", () => {
  assert.equal(itemDocumentId(".agents/pm/tasks/sbx-a1b2.toon", ".agents/pm"), "sbx-a1b2");
  // A tracker at the repository root: the same one-level-below shape applies.
  assert.equal(itemDocumentId("tasks/sbx-a1b2.toon", ""), "sbx-a1b2");
  // History streams are counted through their document, never on their own.
  assert.equal(itemDocumentId(".agents/pm/history/sbx-a1b2.toon", ".agents/pm"), null);
  // Not a .toon at all.
  assert.equal(itemDocumentId(".agents/pm/history/sbx-a1b2.jsonl", ".agents/pm"), null);
  assert.equal(itemDocumentId(".agents/pm/settings.json", ".agents/pm"), null);
  // Directly under the tracker root: one segment, so not an item document.
  assert.equal(itemDocumentId(".agents/pm/loose.toon", ".agents/pm"), null);
  // Two levels below the tracker root: three segments, so not an item document.
  assert.equal(itemDocumentId(".agents/pm/tasks/nested/deep.toon", ".agents/pm"), null);
  // A `.toon` with an empty basename yields no id.
  assert.equal(itemDocumentId(".agents/pm/tasks/.toon", ".agents/pm"), null);
});

test("git status letters map onto change kinds", () => {
  assert.equal(changeKind("A"), "created");
  assert.equal(changeKind("M"), "modified");
  assert.equal(changeKind("D"), "deleted");
  // A rename or copy destination did not exist under that id before the commit.
  assert.equal(changeKind("R100"), "created");
  assert.equal(changeKind("C75"), "created");
  // Anything else is a content change.
  assert.equal(changeKind("T"), "modified");
});

test("a range reports touched items regardless of status, unlike a changelog", () => {
  // This is the distinction that makes `pm vcs items` and pm-changelog different
  // tools rather than two implementations of one answer, and it is worth pinning
  // because the difference is easy to mistake for a bug.
  //
  // pm-changelog answers "which items belong in this release's notes" and lists
  // completed work. `pm vcs items` answers "which items did these commits touch"
  // and is status-blind. So for the same range the changelog's set is a SUBSET:
  // measured on pm-web's real v2026.07.29..v2026.07.30 range, the changelog
  // listed 2 items and this reported 4 — the extra two being open items that were
  // touched but not finished.
  const sandbox = track(createSandbox());
  const start = sandbox.git("rev-parse", "HEAD");
  const closed = sandbox.createItem("Task", "Finished inside the range");
  const open = sandbox.createItem("Task", "Still in progress at the end of the range");
  sandbox.pm("close", closed, "--reason", "Done within the range");
  sandbox.commit("Touch one item that closes and one that stays open");

  const report = itemsInRange({
    range: `${start}..HEAD`,
    repoRoot: sandbox.root,
    trackerPrefix: ".agents/pm",
  });
  assert.deepEqual(
    report.items.map((item) => item.id).sort(),
    [closed, open].sort(),
    "both the closed and the still-open item must be reported",
  );
});
