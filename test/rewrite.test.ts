// History rewriting: change identities, descendant replay, and the transactional
// and per-field-merge properties the engine exists to provide.
//
// Every fixture here builds a real repository through the real engine and asserts
// on the objects, refs and working-tree files it leaves behind. Two properties
// are pinned explicitly because they are the reason this slab exists: that two
// agents editing different fields of one record converge across a rebase with no
// conflict and no line merge, and that a rewrite that discovers a conflict
// halfway through changes no ref and no file.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { type ObjectId, ObjectStoreError } from "../engine/objects.ts";
import { type Signature, effectiveChangeId, readCommit } from "../engine/model.ts";
import { type RepositoryConfig } from "../engine/config.ts";
import { Repository, type ResetMode } from "../engine/repo.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

/**
 * Creates a fresh empty directory and returns its path.
 *
 * @returns The directory handle.
 */
function freshDir(): { root: string } {
  dir = makeTempDir();
  return { root: dir.root };
}

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

const author: Signature = { name: "Author", email: "author@local", timestamp: 1_000, timezoneOffsetMinutes: 0 };
const committer: Signature = { name: "Committer", email: "committer@local", timestamp: 9_000, timezoneOffsetMinutes: 0 };

/** Record configuration used by the per-field merge fixtures. */
const recordConfig: RepositoryConfig = {
  recordPaths: ["item.toon"],
  recordPolicy: { fields: { status: "scalar", priority: "scalar", tags: "set" } },
};

/**
 * Stages and commits one file with the given content.
 *
 * @param repo - The repository.
 * @param path - Path to write and stage.
 * @param content - File content.
 * @param message - Commit message.
 * @param now - Timestamp.
 * @returns The new commit id.
 */
function commitFile(repo: Repository, path: string, content: string, message: string, now: Date): ObjectId {
  writeFileSync(join(repo.root, path), content);
  repo.stage([path]);
  return repo.commit({ message: `${message}\n`, author }, now);
}

/**
 * Writes a record file's canonical content.
 *
 * @param root - Repository root.
 * @param doc - The record document.
 */
function writeRecord(root: string, doc: object): void {
  writeFileSync(join(root, "item.toon"), JSON.stringify(doc, null, 2));
}

/**
 * Reads the record file back as parsed JSON.
 *
 * @param root - Repository root.
 * @returns The parsed record.
 */
function readRecord(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "item.toon"), "utf8")) as Record<string, unknown>;
}

test("describe preserves the change id, moves the commit, and re-materialises the tree", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "first", now);
  commitFile(repo, "a.txt", "ab", "second", new Date(1));
  const before = repo.log("HEAD")[0];
  const beforeChange = before.changeId;

  repo.describe("HEAD", "reworded\n", committer, new Date(2));

  const after = repo.log("HEAD")[0];
  assert.notEqual(after.id, before.id, "the commit id changes because the message did");
  assert.equal(after.changeId, beforeChange, "the change id is preserved across a describe");
  assert.equal(after.commit.message, "reworded\n");
  assert.equal(after.commit.committer.name, "Committer", "the committer is fresh");
  assert.equal(after.commit.author.name, "Author", "the author is preserved");
  // The working tree re-materialised to the rewritten commit's content.
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "ab");
});

test("describe rewrites an ancestor and moves every descendant branch to its counterpart", () => {
  // Descendant rewriting is the hard part: describing a commit deep in history
  // must replay every descendant so no branch is left pointing at a commit whose
  // ancestry no longer leads to it.
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  const first = commitFile(repo, "a.txt", "a", "first", now);
  commitFile(repo, "a.txt", "ab", "second", new Date(1));
  repo.createBranch("feature", "HEAD", new Date(2));
  commitFile(repo, "a.txt", "abc", "third on main", new Date(3));

  const mainBefore = repo.refs.read("refs/heads/main");
  const featureBefore = repo.refs.read("refs/heads/feature");

  // Describe the oldest commit: every later commit on both branches is replayed.
  repo.describe(first, "reworded root\n", committer, new Date(4));

  const mainAfter = repo.refs.read("refs/heads/main");
  const featureAfter = repo.refs.read("refs/heads/feature");
  assert.notEqual(mainAfter, mainBefore, "main moved to its rewritten tip");
  assert.notEqual(featureAfter, featureBefore, "feature moved to its rewritten tip");
  // first's own change id is preserved on its rewritten counterpart.
  assert.equal(effectiveChangeId(first, readCommit(repo.objects, first)), repo.log("main").at(-1)?.changeId);
  // The rewritten history is still connected: walking from main reaches the
  // rewritten root, not the original one.
  assert.ok(repo.log("main").some((entry) => entry.commit.message === "reworded root\n"));
});

test("rebase replays a range onto a new base, preserving change ids and the author", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "base.txt", "base", "base", now);
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  const replayed = commitFile(repo, "feat.txt", "feat", "feature work", new Date(3));
  repo.switchTo("main", new Date(4));
  commitFile(repo, "main.txt", "main", "main work", new Date(5));

  repo.rebase("feature", "main", committer, new Date(6));

  repo.switchTo("feature", new Date(7));
  const log = repo.log("HEAD");
  // The replayed commit lands on top of main, keeping both files.
  assert.ok(log.some((entry) => entry.commit.message === "feature work\n"));
  assert.ok(log.some((entry) => entry.commit.message === "main work\n"));
  const replayedEntry = log.find((entry) => entry.commit.message === "feature work\n");
  assert.equal(replayedEntry?.changeId, effectiveChangeId(replayed, readCommit(repo.objects, replayed)));
  assert.equal(replayedEntry?.commit.author.name, "Author");
  assert.equal(replayedEntry?.commit.committer.name, "Committer");
  assert.ok(readFileSync(join(root, "feat.txt"), "utf8") === "feat");
  assert.ok(readFileSync(join(root, "main.txt"), "utf8") === "main");
});

test("rebase onto an already-contained tip is a no-op", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "first", now);
  repo.createBranch("feature", "HEAD", new Date(1));
  commitFile(repo, "a.txt", "ab", "main advance", new Date(2));
  // feature is within main, so there is nothing to replay.
  const mainBefore = repo.refs.read("refs/heads/main");
  repo.rebase("feature", "main", committer, new Date(3));
  assert.equal(repo.refs.read("refs/heads/main"), mainBefore);
});

test("two agents editing different fields of one record converge across a rebase with no conflict", () => {
  // The multi-agent property: agent A and agent B branch from one record and each
  // edit a *different* scalar field. Rebased across each other, both edits survive
  // and there is no conflict — because the merge is per field, not per line.
  const { root } = freshDir();
  const repo = Repository.init(root, "main", recordConfig);
  const now = new Date(0);
  writeRecord(root, { id: "x", status: "open", priority: 1, tags: ["a"] });
  repo.stage(["item.toon"]);
  repo.commit({ message: "base\n", author }, now);

  repo.createBranch("agent-a", "HEAD", new Date(1));
  repo.switchTo("agent-a", new Date(2));
  writeRecord(root, { id: "x", status: "closed", priority: 1, tags: ["a"] });
  repo.stage(["item.toon"]);
  repo.commit({ message: "agent A closes\n", author }, new Date(3));

  repo.switchTo("main", new Date(4));
  writeRecord(root, { id: "x", status: "open", priority: 5, tags: ["a", "b"] });
  repo.stage(["item.toon"]);
  repo.commit({ message: "agent B reprioritises and tags\n", author }, new Date(5));

  // Rebase agent-a onto main: disjoint fields (status vs priority+tags) converge.
  repo.rebase("agent-a", "main", committer, new Date(6));
  repo.switchTo("agent-a", new Date(7));
  const merged = readRecord(root);
  assert.equal(merged.status, "closed", "agent A's status edit survived");
  assert.equal(merged.priority, 5, "agent B's priority edit survived");
  assert.deepEqual(merged.tags, ["a", "b"].sort(), "agent B's tag edit survived");
});

test("a genuine scalar disagreement across a rebase is refused and names the field", () => {
  // The other half of the property: when both sides move the *same* scalar to
  // different values, the rebase refuses and says which field disagreed — rather
  // than picking a side or running a line merge.
  const { root } = freshDir();
  const repo = Repository.init(root, "main", recordConfig);
  const now = new Date(0);
  writeRecord(root, { id: "x", status: "open", priority: 1 });
  repo.stage(["item.toon"]);
  repo.commit({ message: "base\n", author }, now);

  repo.createBranch("agent-a", "HEAD", new Date(1));
  repo.switchTo("agent-a", new Date(2));
  writeRecord(root, { id: "x", status: "closed", priority: 1 });
  repo.stage(["item.toon"]);
  repo.commit({ message: "agent A closes\n", author }, new Date(3));

  repo.switchTo("main", new Date(4));
  writeRecord(root, { id: "x", status: "blocked", priority: 1 });
  repo.stage(["item.toon"]);
  repo.commit({ message: "agent B blocks\n", author }, new Date(5));

  assert.throws(
    () => repo.rebase("agent-a", "main", committer, new Date(6)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "rewrite_conflict" && /status/.test(error.message),
  );
});

test("a rewrite that conflicts changes no ref and no working-tree file", () => {
  // Transactional: force a conflict mid-rebase and assert every ref and the
  // working tree are byte-identical to before.
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "line\n", "base", now);
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  commitFile(repo, "a.txt", "feature\n", "feature side", new Date(3));
  repo.switchTo("main", new Date(4));
  commitFile(repo, "a.txt", "main\n", "main side", new Date(5));

  const snapshot = (): { refs: Record<string, string | null>; file: string; index: string } => ({
    refs: {
      main: repo.refs.read("refs/heads/main"),
      feature: repo.refs.read("refs/heads/feature"),
    },
    file: readFileSync(join(root, "a.txt"), "utf8"),
    index: readFileSync(join(repo.controlDirectory, "index"), "utf8"),
  });
  const before = snapshot();

  // A genuine text disagreement on the same line aborts the rebase.
  assert.throws(
    () => repo.rebase("feature", "main", committer, new Date(6)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "rewrite_conflict",
  );

  const after = snapshot();
  assert.deepEqual(after.refs, before.refs, "no ref moved");
  assert.equal(after.file, before.file, "the working file is untouched");
  assert.equal(after.index, before.index, "the index is untouched");
});

test("squash folds a commit into its first parent, joining messages and keeping the parent's change id", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  const first = commitFile(repo, "a.txt", "a", "first", now);
  const second = commitFile(repo, "b.txt", "b", "second", new Date(1));
  const parentChange = repo.log("HEAD")[1].changeId;

  repo.squash("HEAD", committer, new Date(2));

  const log = repo.log("HEAD");
  assert.equal(log.length, 1, "two commits became one");
  assert.equal(log[0].commit.message, "first\n\nsecond\n", "messages join with a blank line");
  assert.equal(log[0].changeId, parentChange, "the survivor keeps the parent's change id");
  // The survivor carries the combined tree: both files are present.
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a");
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "b");
});

test("squash reparents the folded commit's descendants to the survivor", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "first", now);
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  commitFile(repo, "b.txt", "b", "second", new Date(3));
  commitFile(repo, "c.txt", "c", "third", new Date(4));
  const featureBefore = repo.refs.read("refs/heads/feature");

  // Squash the second commit (which has a descendant) into the first.
  repo.squash(repo.log("HEAD")[1].id, committer, new Date(5));

  const featureAfter = repo.refs.read("refs/heads/feature");
  assert.notEqual(featureAfter, featureBefore);
  // feature's tip is the replayed descendant, still carrying the third commit's
  // message, now parented to the survivor.
  const log = repo.log("feature");
  assert.equal(log[0].commit.message, "third\n");
  assert.equal(log.length, 2);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a");
  assert.equal(readFileSync(join(root, "c.txt"), "utf8"), "c");
});

test("squash refuses a root commit, which has no parent to fold into", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  commitFile(repo, "a.txt", "a", "only", new Date(0));
  assert.throws(
    () => repo.squash("HEAD", committer, new Date(1)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "rewrite_conflict",
  );
});

test("split replaces one commit with two, the first keeping the change id and the second getting a fresh one", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "base.txt", "base", "base", now);
  // One commit that changes two files, so the split has something to divide.
  writeFileSync(join(root, "x.txt"), "x");
  writeFileSync(join(root, "y.txt"), "y");
  repo.stage(["x.txt", "y.txt"]);
  repo.commit({ message: "two changes\n", author }, new Date(1));
  const originalChange = repo.log("HEAD")[0].changeId;

  repo.split("HEAD", ["x.txt"], committer, new Date(2));

  const log = repo.log("HEAD");
  // base, then the two halves.
  assert.equal(log.length, 3);
  // The first half (parent of the second) keeps the original change id.
  assert.equal(log[1].changeId, originalChange);
  // The second half has a fresh change id, distinct from the original.
  assert.notEqual(log[0].changeId, originalChange);
  // The split is by path: x.txt's change and y.txt's change landed separately.
  assert.equal(readFileSync(join(root, "x.txt"), "utf8"), "x");
  assert.equal(readFileSync(join(root, "y.txt"), "utf8"), "y");
  // The second half's parent is the first half.
  assert.equal(log[0].commit.parents[0], log[1].id);
});

test("split refuses when the named paths carry none of the commit's changes", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "base.txt", "base", "base", now);
  commitFile(repo, "x.txt", "x", "x", new Date(1));
  assert.throws(
    () => repo.split("HEAD", ["nonexistent.txt"], committer, new Date(2)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "rewrite_conflict",
  );
});

test("split refuses when every change matches the named paths, leaving the remainder empty", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "base.txt", "base", "base", now);
  commitFile(repo, "x.txt", "x", "x", new Date(1));
  // Every change the commit made is to x.txt, so the second half would be empty.
  assert.throws(
    () => repo.split("HEAD", ["x.txt"], committer, new Date(2)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "rewrite_conflict",
  );
});

test("cherry-pick applies a change onto HEAD with a new change id and the original message", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "base", now);
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  const picked = commitFile(repo, "a.txt", "a\nfeature\n", "feature change", new Date(3));
  repo.switchTo("main", new Date(4));

  const newCommit = repo.cherryPick("feature", committer, new Date(5));

  assert.notEqual(newCommit, picked, "a cherry-pick is a distinct commit");
  assert.notEqual(effectiveChangeId(newCommit, readCommit(repo.objects, newCommit)), effectiveChangeId(picked, readCommit(repo.objects, picked)), "a new change id");
  assert.equal(repo.log("HEAD")[0].commit.message, "feature change\n", "the message is preserved");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\nfeature\n");
});

test("cherry-pick refuses when the change does not apply cleanly", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "line\n", "base", now);
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  commitFile(repo, "a.txt", "feature\n", "feature side", new Date(3));
  repo.switchTo("main", new Date(4));
  commitFile(repo, "a.txt", "main\n", "main side", new Date(5));
  assert.throws(
    () => repo.cherryPick("feature", committer, new Date(6)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "rewrite_conflict",
  );
});

test("revert applies the inverse of a commit's change onto HEAD", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "base", now);
  commitFile(repo, "a.txt", "ab", "extend", new Date(1));

  repo.revert("HEAD", "undo the extension\n", committer, new Date(2));

  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a", "the change was inverted");
  assert.equal(repo.log("HEAD")[0].commit.message, "undo the extension\n");
});

test("revert refuses when the inverse does not apply cleanly", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "base\n", "base", now);
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  commitFile(repo, "a.txt", "feature\n", "feature", new Date(3));
  repo.switchTo("main", new Date(4));
  commitFile(repo, "a.txt", "main\n", "main", new Date(5));
  // Reverting the feature commit onto main: HEAD changed the same line.
  assert.throws(
    () => repo.revert("feature", "undo\n", committer, new Date(6)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "rewrite_conflict",
  );
});

test("reset soft moves only the branch; mixed rewrites the index; hard rewrites the tree", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  const first = commitFile(repo, "a.txt", "a", "first", now);
  commitFile(repo, "a.txt", "ab", "second", new Date(1));

  // soft: branch moves back to first; index and worktree keep "ab".
  repo.reset(first, "soft", new Date(2));
  assert.equal(repo.refs.resolveHead(), first);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "ab", "soft leaves the working tree");
  assert.equal(repo.readIndex()[0].id, repo.objects.write("blob", Buffer.from("ab")), "soft leaves the index");

  // mixed: branch moves and the index is rewritten to first's tree; worktree stays.
  commitFile(repo, "a.txt", "ab", "second again", new Date(3));
  repo.reset(first, "mixed" as ResetMode, new Date(4));
  assert.equal(repo.refs.resolveHead(), first);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "ab", "mixed leaves the working tree");
  assert.equal(repo.readIndex()[0].id, repo.objects.write("blob", Buffer.from("a")), "mixed rewrites the index");

  // hard: branch, index and worktree all move to first.
  commitFile(repo, "a.txt", "ab", "third", new Date(5));
  repo.reset(first, "hard", new Date(6));
  assert.equal(repo.refs.resolveHead(), first);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a", "hard rewrites the working tree");
});

test("reset on an unborn head is refused", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  assert.throws(
    () => repo.reset("HEAD", "soft", new Date(0)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unborn_head",
  );
});

test("restore copies named paths from a revision into the index and working tree", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "original", "first", now);
  const first = repo.refs.resolveHead() as ObjectId;
  commitFile(repo, "a.txt", "changed", "second", new Date(1));

  const restored = repo.restore(["a.txt"], first);
  assert.deepEqual(restored, ["a.txt"]);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "original", "the working file is restored");
  assert.equal(repo.readIndex()[0].id, repo.objects.write("blob", Buffer.from("original")), "the index is restored");
});

test("restore removes a path that the revision does not carry", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "first", now);
  const first = repo.refs.resolveHead() as ObjectId;
  commitFile(repo, "b.txt", "b", "add b", new Date(1));

  repo.restore(["b.txt"], first);
  assert.throws(() => readFileSync(join(root, "b.txt"), "utf8"), "the added file is removed");
  assert.equal(repo.readIndex().find((entry) => entry.path === "b.txt"), undefined, "and dropped from the index");
});

test("every rewrite refuses a dirty working tree before changing anything", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "first", now);
  // Leave an uncommitted change.
  writeFileSync(join(root, "a.txt"), "dirty");
  repo.stage(["a.txt"]);

  for (const op of [
    () => repo.describe("HEAD", "x\n", committer, new Date(1)),
    () => repo.rebase("HEAD", "HEAD", committer, new Date(1)),
    () => repo.squash("HEAD", committer, new Date(1)),
    () => repo.split("HEAD", ["a.txt"], committer, new Date(1)),
    () => repo.cherryPick("HEAD", committer, new Date(1)),
    () => repo.revert("HEAD", "x\n", committer, new Date(1)),
  ]) {
    assert.throws(op, (error: unknown) => error instanceof ObjectStoreError && error.code === "dirty_worktree");
  }
});

test("cherry-pick and revert refuse an unborn head", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  assert.throws(
    () => repo.cherryPick("HEAD", committer, new Date(0)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unborn_head",
  );
  assert.throws(
    () => repo.revert("HEAD", "x\n", committer, new Date(0)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unborn_head",
  );
});

test("undo reverses a rewrite, restoring the ref and re-materialising the tree", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "first", now);
  const before = repo.refs.resolveHead();
  repo.describe("HEAD", "reworded\n", committer, new Date(1));
  assert.notEqual(repo.refs.resolveHead(), before);

  repo.undo(null, new Date(2));
  assert.equal(repo.refs.resolveHead(), before, "the rewrite's ref move is reversed");
  assert.equal(repo.log("HEAD")[0].commit.message, "first\n", "and the tree re-materialised");
});

test("a rewrite of a detached HEAD moves HEAD itself, recorded for undo", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  const tip = commitFile(repo, "a.txt", "a", "first", now);
  repo.switchTo(tip, new Date(1));
  assert.equal(repo.refs.readHead().kind, "detached");

  repo.describe("HEAD", "reworded\n", committer, new Date(2));
  const detached = repo.refs.readHead();
  assert.equal(detached.kind, "detached");
  assert.notEqual(detached.target, tip);

  // Undo reverses the HEAD move recorded under the literal name "HEAD".
  repo.undo(null, new Date(3));
  assert.equal(repo.refs.resolveHead(), tip);
});

test("a change id stays stable across a describe and a rebase of the same change", () => {
  // The point of change ids: one stable identity for a change that has been
  // described and then rebased. Each rewrite changes the commit id but not the
  // change id, so `log` can speak of one thing across a rewrite.
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "base", now);
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  const original = commitFile(repo, "a.txt", "ab", "the change", new Date(3));
  const identity = effectiveChangeId(original, readCommit(repo.objects, original));

  // Describe it: identity preserved.
  repo.describe("HEAD", "the change, described\n", committer, new Date(4));
  assert.equal(repo.log("HEAD")[0].changeId, identity);

  // Rebase onto main after main advances: identity still preserved.
  repo.switchTo("main", new Date(5));
  commitFile(repo, "b.txt", "b", "main advance", new Date(6));
  repo.switchTo("feature", new Date(7));
  repo.rebase("feature", "main", committer, new Date(8));
  assert.equal(repo.log("HEAD")[0].changeId, identity);
  assert.notEqual(repo.log("HEAD")[0].id, original, "the commit id moved");
});

test("record-merging helpers and the shared tree merge are reused by both merge and rebase", () => {
  // A record that conflicts under a real merge names the same field a rebase
  // would name, because both route through the same tree merge. This is the
  // "do not duplicate the records-merge logic" requirement made executable.
  const { root } = freshDir();
  const repo = Repository.init(root, "main", recordConfig);
  const now = new Date(0);
  writeRecord(root, { id: "x", status: "open", priority: 1 });
  repo.stage(["item.toon"]);
  repo.commit({ message: "base\n", author }, now);
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  writeRecord(root, { id: "x", status: "closed", priority: 1 });
  repo.stage(["item.toon"]);
  repo.commit({ message: "feature\n", author }, new Date(3));
  repo.switchTo("main", new Date(4));
  writeRecord(root, { id: "x", status: "blocked", priority: 1 });
  repo.stage(["item.toon"]);
  repo.commit({ message: "main\n", author }, new Date(5));

  // merge: the conflict is reported on `status` (and left in the worktree).
  const report = repo.merge("feature", { message: "m\n", author }, new Date(6));
  assert.equal(report.clean, false);
  assert.deepEqual(report.conflicts[0].fields, ["status"]);
});
