import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { type ObjectId, ObjectStore } from "../engine/objects.ts";
import { type Commit, type Signature, writeCommit } from "../engine/model.ts";
import { isAncestor, mergeBases, mergeContent, reachable } from "../engine/merge.ts";
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
