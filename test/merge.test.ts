import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { type ObjectId, ObjectStore } from "../engine/objects.ts";
import { type Commit, type Signature, writeCommit } from "../engine/model.ts";
import { divergence, isAncestor, mergeBases, mergeContent, reachable } from "../engine/merge.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

/**
 * Creates a fresh object store.
 *
 * @returns The store.
 */
function freshStore(): ObjectStore {
  dir = makeTempDir();
  return new ObjectStore(join(dir.root, "objects"));
}

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

const signature: Signature = { name: "A", email: "a@b", timestamp: 1, timezoneOffsetMinutes: 0 };

/**
 * Writes a commit with the given parents and a one-tree id placeholder.
 *
 * @param store - Destination store.
 * @param parents - Parent commit ids.
 * @param label - Message label, also used as the tree id seed.
 * @returns The commit id.
 */
function commit(store: ObjectStore, parents: readonly ObjectId[], label: string): ObjectId {
  const body: Commit = {
    tree: "0".repeat(64),
    parents,
    author: signature,
    committer: signature,
    message: `${label}\n`,
  };
  return writeCommit(store, body);
}

test("reachable includes the start and all its ancestors, de-duplicated", () => {
  const store = freshStore();
  const root = commit(store, [], "root");
  const child = commit(store, [root], "child");
  const merge = commit(store, [child, root], "merge");
  assert.deepEqual([...reachable(store, merge)].sort(), [merge, child, root].sort());
  assert.ok(reachable(store, merge).has(root));
});

test("isAncestor treats a commit as its own ancestor", () => {
  const store = freshStore();
  const root = commit(store, [], "root");
  const tip = commit(store, [root], "tip");
  assert.equal(isAncestor(store, root, tip), true);
  assert.equal(isAncestor(store, tip, root), false);
  // A commit reaches itself.
  assert.equal(isAncestor(store, root, root), true);
});

test("divergence separates the three relationships a push has to tell apart", () => {
  const store = freshStore();
  const base = commit(store, [], "base");
  const ours = commit(store, [base], "ours");
  const theirs = commit(store, [base], "theirs");

  // Identical: nothing to send, nothing to take.
  assert.deepEqual(divergence(store, reachable(store, base), base), { ahead: 0, behind: 0 });
  // Strictly ahead is a fast-forward for the other side; strictly behind is one
  // for this side. The counts have to be asymmetric or the two read alike.
  assert.deepEqual(divergence(store, reachable(store, ours), base), { ahead: 1, behind: 0 });
  assert.deepEqual(divergence(store, reachable(store, base), ours), { ahead: 0, behind: 1 });
  // Both non-zero is the case a push refuses, and the only one needing a merge.
  assert.deepEqual(divergence(store, reachable(store, ours), theirs), { ahead: 1, behind: 1 });
});

test("divergence counts every commit on both sides of unrelated histories", () => {
  const store = freshStore();
  const ourRoot = commit(store, [], "our-root");
  const ourTip = commit(store, [ourRoot], "our-tip");
  const theirRoot = commit(store, [], "their-root");
  // Sharing no ancestor is not an error here: the answer is that all of each
  // side is missing from the other, which is exactly what the counts say.
  assert.deepEqual(divergence(store, reachable(store, ourTip), theirRoot), { ahead: 2, behind: 1 });
});

test("divergence counts commits once when branches remerge", () => {
  const store = freshStore();
  const base = commit(store, [], "base");
  const ours = commit(store, [base], "ours");
  const theirs = commit(store, [base], "theirs");
  const merged = commit(store, [ours, theirs], "merged");
  // `merged` reaches `theirs` through its *second* parent, so `theirs` is not
  // ahead of itself and nothing is behind. Walking every parent rather than a
  // first-parent line is what keeps `behind` at 0 here instead of counting
  // `theirs` as a commit the merge has not seen.
  assert.deepEqual(divergence(store, reachable(store, merged), theirs), { ahead: 2, behind: 0 });
  assert.deepEqual(divergence(store, reachable(store, theirs), merged), { ahead: 0, behind: 2 });
});

test("mergeBases finds the single base of a simple fork", () => {
  const store = freshStore();
  const base = commit(store, [], "base");
  const ours = commit(store, [base], "ours");
  const theirs = commit(store, [base], "theirs");
  assert.deepEqual(mergeBases(store, ours, theirs), [base]);
});

test("mergeBases returns nothing for unrelated histories", () => {
  const store = freshStore();
  const ours = commit(store, [], "ours");
  const theirs = commit(store, [], "theirs");
  assert.deepEqual(mergeBases(store, ours, theirs), []);
});

test("mergeBases finds two bases for a criss-cross history", () => {
  // root merged into both lines once, then both lines fork again — a classic
  // criss-cross that leaves two equally-good bases.
  const store = freshStore();
  const root = commit(store, [], "root");
  const a1 = commit(store, [root], "a1");
  const b1 = commit(store, [root], "b1");
  // Two merges with swapped parents. Merging the two merges directly leaves a1
  // and b1 as the minimal common ancestors — neither reaches the other.
  const m1 = commit(store, [a1, b1], "m1");
  const m2 = commit(store, [b1, a1], "m2");
  const bases = mergeBases(store, m1, m2);
  assert.equal(bases.length, 2);
  assert.deepEqual([...bases].sort(), [a1, b1].sort());
});

test("mergeBases discards an ancestor that another base reaches", () => {
  // root -> mid -> fork: root is a common ancestor but mid is closer, so root is
  // not minimal and must be discarded.
  const store = freshStore();
  const root = commit(store, [], "root");
  const mid = commit(store, [root], "mid");
  const ours = commit(store, [mid], "ours");
  const theirs = commit(store, [mid], "theirs");
  assert.deepEqual(mergeBases(store, ours, theirs), [mid]);
});

test("mergeContent takes one side when only one changed a region", () => {
  const base = "line1\nline2\nline3\n";
  const ours = "line1\nLINE2\nline3\n";
  const theirs = "line1\nline2\nline3\n";
  const result = mergeContent(base, ours, theirs);
  assert.equal(result.clean, true);
  assert.equal(result.text, ours);
});

test("mergeContent keeps edits to disjoint regions from both sides", () => {
  const base = "a\nb\nc\nd\ne\nf\n";
  const ours = "A\nb\nc\nd\ne\nf\n";
  const theirs = "a\nb\nc\nd\ne\nF\n";
  const result = mergeContent(base, ours, theirs);
  assert.equal(result.clean, true);
  assert.equal(result.text, "A\nb\nc\nd\ne\nF\n");
});

test("mergeContent treats identical concurrent edits as agreement, not conflict", () => {
  const base = "a\nb\nc\n";
  const same = "a\nB\nc\n";
  const result = mergeContent(base, same, same);
  assert.equal(result.clean, true);
  assert.equal(result.text, same);
});

test("mergeContent reports overlapping edits as a conflict preserving both sides", () => {
  const base = "a\nb\nc\n";
  const ours = "a\nOURS\nc\n";
  const theirs = "a\nTHEIRS\nc\n";
  const result = mergeContent(base, ours, theirs);
  assert.equal(result.clean, false);
  assert.equal(result.conflicts.length, 1);
  assert.ok(result.text.includes("<<<<<<< ours"));
  assert.ok(result.text.includes("OURS"));
  assert.ok(result.text.includes("======="));
  assert.ok(result.text.includes("THEIRS"));
  assert.ok(result.text.includes(">>>>>>> theirs"));
});

test("mergeContent applies custom conflict labels", () => {
  const base = "a\nb\nc\n";
  const result = mergeContent(base, "a\nO\nc\n", "a\nT\nc\n", { ours: "head", base: "origin", theirs: "incoming" });
  assert.ok(result.text.includes("<<<<<<< head"));
  assert.ok(result.text.includes("||||||| origin"));
  assert.ok(result.text.includes(">>>>>>> incoming"));
});

test("mergeContent returns empty text for three empty inputs", () => {
  const result = mergeContent("", "", "");
  assert.equal(result.clean, true);
  assert.equal(result.text, "");
  assert.equal(result.conflicts.length, 0);
});

test("a line one side deleted and the other changed is a conflict, not a silent choice", () => {
  // A base with a repeated line where one side drops the duplicate and the other
  // changes it. This also exercises the probe-loop guard that skips a match whose
  // mapped position sits before the current cursors.
  //
  // Delete-versus-modify is the canonical case a three-way merge must NOT guess
  // at: taking theirs discards a deliberate deletion, taking ours discards a
  // deliberate edit, and nothing in the inputs says which was intended. diff3
  // conflicts, and so does this.
  const result = mergeContent("a\na\nc\n", "a\nc\n", "a\nb\nc\n");
  assert.equal(result.clean, false);
  assert.equal(result.conflicts.length, 1);

  const [conflict] = result.conflicts;
  assert.deepEqual(conflict.base, ["a"]);
  assert.deepEqual(conflict.ours, [], "our side deleted the line, so it contributes nothing");
  assert.deepEqual(conflict.theirs, ["b"]);

  // The unchanged lines on either side of the region are emitted plainly.
  assert.ok(result.text.startsWith("a\n<<<<<<< ours"));
  assert.ok(result.text.endsWith("c\n"));
});

test("a wide duplicate-heavy merge is pinned and stable under the routed diff engine", () => {
  // Above `linearSpaceDiffWidthThreshold` the divide-and-conquer engine serves
  // `diffLines`, and on tie-heavy inputs it may emit a different - equally
  // short - edit script than the banded engine would. This test pins what that
  // means for merges: with changes confined to unambiguous regions, the merged
  // text is exactly the base with both sides' edits applied, whatever the
  // engines do with the duplicated middle. Width here (~11k combined lines per
  // comparison) routes to the linear-space engine.
  const duplicates = (count: number, marker: string): string[] =>
    Array.from({ length: count }, (_, i) => `${marker}-${i % 7}`);
  const baseLines = [
    "header",
    ...duplicates(2400, "alpha"),
    "middle-1",
    "middle-2",
    ...duplicates(600, "beta"),
    "footer",
  ];
  const oursLines = baseLines.map((line) => (line === "header" ? "header-ours" : line));
  const theirsLines = baseLines.map((line) => (line === "footer" ? "footer-theirs" : line));

  const result = mergeContent(
    baseLines.join("\n"),
    oursLines.join("\n"),
    theirsLines.join("\n"),
  );
  assert.equal(result.clean, true);
  assert.deepEqual(result.conflicts, []);
  const expectedLines = [
    "header-ours",
    ...duplicates(2400, "alpha"),
    "middle-1",
    "middle-2",
    ...duplicates(600, "beta"),
    "footer-theirs",
  ];
  // Neither side terminates its last line, so the merged text records that
  // rather than appending a byte neither side contributed.
  assert.equal(result.text, expectedLines.join("\n"));
  // And the behaviour is deterministic: a second merge of the same inputs
  // produces byte-identical output.
  const again = mergeContent(baseLines.join("\n"), oursLines.join("\n"), theirsLines.join("\n"));
  assert.equal(again.text, result.text);
});
