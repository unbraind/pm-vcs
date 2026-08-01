import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { type ObjectId, ObjectStoreError } from "../engine/objects.ts";
import { CONTROL_DIRECTORY, type MergeReport, REPOSITORY_FORMAT, Repository } from "../engine/repo.ts";
import { type RepositoryConfig } from "../engine/config.ts";
import { type Commit, type Signature, writeCommit } from "../engine/model.ts";
import { buildTree } from "../engine/worktree.ts";
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

const author: Signature = { name: "Repo", email: "repo@local", timestamp: 1_000, timezoneOffsetMinutes: 0 };

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

test("init creates a repository and refuses to initialise twice", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  assert.equal(repo.refs.readHead().kind, "branch");
  assert.equal(readFileSync(join(root, CONTROL_DIRECTORY, "format"), "utf8").trim(), REPOSITORY_FORMAT);

  assert.throws(
    () => Repository.init(root),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "already_initialised",
  );
});

test("open refuses a missing or wrong-format repository", () => {
  const { root } = freshDir();
  assert.throws(
    () => Repository.open(root),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "not_a_repository",
  );

  Repository.init(root);
  // Corrupt the format marker to something this build does not write.
  writeFileSync(join(root, CONTROL_DIRECTORY, "format"), "pmvcs-99\n");
  assert.throws(
    () => Repository.open(root),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unsupported_format",
  );
});

test("commit refuses an empty commit unless allowed, and records the first commit on an unborn branch", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);

  // First commit on an unborn branch has no parent and always succeeds.
  const first = commitFile(repo, "a.txt", "a", "first", now);
  assert.equal(repo.refs.resolveHead(), first);

  // A second commit with nothing staged is refused.
  assert.throws(
    () => repo.commit({ message: "empty\n", author }, new Date(1)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "empty_commit",
  );
  // allowEmpty records one anyway.
  const empty = repo.commit({ message: "empty\n", author, allowEmpty: true }, new Date(2));
  assert.notEqual(empty, first);
});

test("switch refuses to overwrite an uncommitted change and leaves the file alone", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "shared.txt", "base", "base", now);

  repo.createBranch("other", "HEAD", new Date(1));
  // On `other`, change the file and commit.
  repo.switchTo("other", new Date(2));
  commitFile(repo, "shared.txt", "other-side", "other change", new Date(3));

  // Back on main, make an uncommitted change to the same file.
  repo.switchTo("main", new Date(4));
  writeFileSync(join(root, "shared.txt"), "uncommitted");
  repo.stage(["shared.txt"]);

  // Switching to `other` would overwrite the uncommitted edit; it must refuse
  // before writing, and the working file must be untouched.
  assert.throws(
    () => repo.switchTo("other", new Date(5)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "switch_would_overwrite",
  );
  assert.equal(readFileSync(join(root, "shared.txt"), "utf8"), "uncommitted");
});

test("a clean switch materialises the target tree and removes the absent file", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  // Start from an empty-tree commit, then branch feature from it BEFORE main adds
  // only-on-main.txt, so feature's tree genuinely lacks that file.
  repo.stage([]);
  const base = repo.commit({ message: "empty base\n", author, allowEmpty: true }, now);
  repo.createBranch("feature", base, new Date(1));
  commitFile(repo, "only-on-main.txt", "x", "main only", new Date(2));

  repo.switchTo("feature", new Date(3));
  // On feature, the only-on-main file is gone (the target tree lacks it).
  assert.throws(() => readFileSync(join(root, "only-on-main.txt"), "utf8"));
  // And creating a feature-only file then switching back removes it.
  commitFile(repo, "only-on-feature.txt", "y", "feature only", new Date(4));
  repo.switchTo("main", new Date(5));
  assert.throws(() => readFileSync(join(root, "only-on-feature.txt"), "utf8"));
  assert.equal(readFileSync(join(root, "only-on-main.txt"), "utf8"), "x");
});

test("resolve accepts HEAD, a branch, a tag and a commit id, and rejects the unknown", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  const tip = commitFile(repo, "a.txt", "a", "first", now);
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.refs.compareAndSwap("refs/tags/v1", null, tip);

  assert.equal(repo.resolve("HEAD"), tip);
  assert.equal(repo.resolve("main"), tip);
  assert.equal(repo.resolve("feature"), tip);
  assert.equal(repo.resolve("v1"), tip);
  assert.equal(repo.resolve(tip), tip);

  // An unknown revision is refused.
  assert.throws(
    () => repo.resolve("nope"),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unknown_revision",
  );
  // A name with an invalid ref character exercises the per-candidate catch and
  // still resolves to unknown_revision.
  assert.throws(
    () => repo.resolve("bad:name"),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unknown_revision",
  );
  // Resolving HEAD before any commit reports an unborn head.
  const { root: emptyRoot } = freshDir();
  Repository.init(emptyRoot);
  assert.throws(
    () => Repository.open(emptyRoot).resolve("HEAD"),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unborn_head",
  );
});

test("createBranch refuses a duplicate and deleteBranch refuses the unknown and the current", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "first", now);
  repo.createBranch("feature", "HEAD", new Date(1));

  // A duplicate branch fails the compare-and-swap (expected null, found set).
  assert.throws(
    () => repo.createBranch("feature", "HEAD", new Date(2)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "ref_changed",
  );
  // Deleting an unknown branch is refused.
  assert.throws(
    () => repo.deleteBranch("ghost", new Date(3)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unknown_branch",
  );
  // Deleting the branch HEAD is on is refused.
  assert.throws(
    () => repo.deleteBranch("main", new Date(4)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "branch_checked_out",
  );
  // Switching away first lets the delete succeed.
  repo.switchTo("feature", new Date(5));
  repo.deleteBranch("main", new Date(6));
  assert.equal(repo.refs.read("refs/heads/main"), null);
});

test("log walks first-parent history and diff shows changed lines", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  const first = commitFile(repo, "a.txt", "line1\n", "first", now);
  commitFile(repo, "a.txt", "line1\nline2\n", "second", new Date(1));

  const log = repo.log("HEAD");
  assert.equal(log.length, 2);
  assert.equal(log[1].id, first);
  assert.equal(log[1].commit.parents.length, 0);

  // The diff between the first and second commits includes the inserted line.
  const diff = repo.diff(first, "HEAD");
  assert.match(diff, /\+line2/);
});

test("diff reports mode-only and combined content-and-mode changes", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  writeFileSync(join(root, "tool.sh"), "echo one\n");
  repo.stage(["tool.sh"]);
  const regular = repo.commit({ message: "regular\n", author }, new Date(0));

  chmodSync(join(root, "tool.sh"), 0o755);
  repo.stage(["tool.sh"]);
  const executable = repo.commit({ message: "executable\n", author }, new Date(1));
  assert.equal(repo.diff(regular, executable), "old mode 100644\nnew mode 100755\n");

  writeFileSync(join(root, "tool.sh"), "echo two\n");
  chmodSync(join(root, "tool.sh"), 0o644);
  repo.stage(["tool.sh"]);
  const changed = repo.commit({ message: "changed\n", author }, new Date(2));
  const combined = repo.diff(executable, changed);
  assert.match(combined, /^old mode 100755\nnew mode 100644\n/);
  assert.match(combined, /-echo one/);
  assert.match(combined, /\+echo two/);
});

test("stage stages all, stages a deletion, and refuses an explicitly-named ignored path", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  writeFileSync(join(root, "a.txt"), "a");
  repo.stage([]); // stage everything
  assert.deepEqual(repo.stage([]), []); // nothing new to stage

  // An explicitly named ignored path is refused, not silently skipped.
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "x");
  assert.throws(
    () => repo.stage([".git/config"]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "path_ignored",
  );

  // Staging a deleted file records the deletion.
  commitFile(repo, "b.txt", "b", "add b", now);
  repo.stage(["b.txt"]);
  // Now delete it and stage the deletion.
  removeFile(join(root, "b.txt"));
  assert.deepEqual(repo.stage(["b.txt"]), ["b.txt"]);
});

test("stage skips content work for a stable cached index entry", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  writeFileSync(join(root, "stable.txt"), "stable\n");
  assert.deepEqual(repo.stage(["stable.txt"]), ["stable.txt"]);
  const cached = repo.readIndex()[0];
  assert.ok(cached?.stat);
  const newest = cached.stat.ctimeNs > cached.stat.mtimeNs ? cached.stat.ctimeNs : cached.stat.mtimeNs;
  repo.writeIndex([{ ...cached, stat: { ...cached.stat, observedAtNs: newest + 2_000_000_000n } }]);
  const actualNow = Date.now;
  Date.now = () => actualNow() + 5_000;
  try {
    assert.deepEqual(repo.stage(["stable.txt"], () => {
      throw new Error("content reader must not run for a stable cache hit");
    }), []);
  } finally {
    Date.now = actualNow;
  }

  writeFileSync(join(root, "changing.txt"), "changing");
  assert.deepEqual(repo.stage(["changing.txt"], () => ({
    content: Buffer.from("changing"),
    executable: false,
  })), ["changing.txt"]);
  assert.equal(repo.readIndex().find((entry) => entry.path === "changing.txt")?.stat, undefined);
});

test("status reports a clean tree after committing everything", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "first", now);
  repo.stage([]);
  assert.equal(repo.status().clean, true);
});

test("merge reports up_to_date when the target is already an ancestor", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "first", now);
  repo.createBranch("behind", "HEAD", new Date(1));
  // main advances; merging behind into main is up-to-date.
  commitFile(repo, "a.txt", "a2", "advance main", new Date(2));
  const report = repo.merge("behind", { message: "merge\n", author }, new Date(3));
  assert.equal(report.kind, "up_to_date");
});

test("merge fast-forwards when HEAD is an ancestor of the target", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "a", "first", now);
  repo.createBranch("ahead", "HEAD", new Date(1));
  repo.switchTo("ahead", new Date(2));
  const tip = commitFile(repo, "a.txt", "a2", "advance", new Date(3));
  repo.switchTo("main", new Date(4));
  const report = repo.merge("ahead", { message: "merge\n", author }, new Date(5));
  assert.equal(report.kind, "fast_forward");
  assert.equal(report.head, tip);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a2");
});

test("merge combines disjoint line edits cleanly", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "line1\nline2\nline3\nline4\n", "base", now);

  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  commitFile(repo, "a.txt", "LINE1\nline2\nline3\nline4\n", "edit top", new Date(3));

  repo.switchTo("main", new Date(4));
  commitFile(repo, "a.txt", "line1\nline2\nline3\nLINE4\n", "edit bottom", new Date(5));

  const report = repo.merge("feature", { message: "merge\n", author }, new Date(6));
  assert.equal(report.kind, "merged");
  assert.equal(report.clean, true);
  assert.deepEqual(
    readFileSync(join(root, "a.txt"), "utf8"),
    "LINE1\nline2\nline3\nLINE4\n",
  );
});

test("merge records a content conflict with both sides preserved in the file", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "line1\nline2\n", "base", now);

  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  commitFile(repo, "a.txt", "OURS\nline2\n", "ours edit", new Date(3));

  repo.switchTo("main", new Date(4));
  commitFile(repo, "a.txt", "THEIRS\nline2\n", "theirs edit", new Date(5));

  const report = repo.merge("feature", { message: "merge\n", author }, new Date(6));
  assert.equal(report.clean, false);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].reason, "content");
  const merged = readFileSync(join(root, "a.txt"), "utf8");
  assert.ok(merged.includes("<<<<<<<"));
  assert.ok(merged.includes("OURS"));
  assert.ok(merged.includes("======="));
  assert.ok(merged.includes("THEIRS"));
});

test("merge records a mode conflict and a delete/modify conflict", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  commitFile(repo, "a.txt", "base", "base", now);

  // Mode conflict: one side makes it executable, the other edits the content.
  repo.createBranch("exec", "HEAD", new Date(1));
  repo.switchTo("exec", new Date(2));
  // chmod is required: writeFileSync applies its mode only on creation, not on
  // an existing file, so an in-place rewrite would leave the executable bit clear.
  chmodSync(join(root, "a.txt"), 0o755);
  repo.stage(["a.txt"]);
  repo.commit({ message: "make executable\n", author }, new Date(3));

  repo.switchTo("main", new Date(4));
  commitFile(repo, "a.txt", "edited", "edit content", new Date(5));

  const modeReport = repo.merge("exec", { message: "merge\n", author }, new Date(6));
  assert.equal(modeReport.clean, false);
  assert.ok(modeReport.conflicts.some((c) => c.reason === "mode"));

  // Reset and set up a delete/modify: one side deletes, the other edits.
  const { root: root2 } = freshDir();
  const repo2 = Repository.init(root2);
  commitFile(repo2, "a.txt", "base", "base", now);
  repo2.createBranch("del", "HEAD", new Date(1));
  repo2.switchTo("del", new Date(2));
  removeFile(join(root2, "a.txt"));
  repo2.stage(["a.txt"]);
  repo2.commit({ message: "delete\n", author }, new Date(3));
  repo2.switchTo("main", new Date(4));
  commitFile(repo2, "a.txt", "edited", "edit", new Date(5));
  const dmReport = repo2.merge("del", { message: "merge\n", author }, new Date(6));
  assert.equal(dmReport.clean, false);
  assert.ok(dmReport.conflicts.some((c) => c.reason === "content"));
});

test("two agents doing identical work converge on one commit, with nothing to merge", () => {
  // Content addressing taken to its conclusion. Both branches make the same edit
  // to the same file from the same parent, with the same message and author — so
  // the two commits are byte-identical and hash to ONE id. The branches are not
  // two commits that need reconciling; they are the same commit, and the merge
  // correctly reports that rather than inventing a merge node.
  //
  // This is the strongest form of the property the whole system is built for: two
  // agents that reach the same conclusion independently produce the same history,
  // not a conflict and not a duplicate.
  const { root } = freshDir();
  const repo = Repository.init(root);
  commitFile(repo, "a.txt", "base", "base", new Date(0));

  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  const onFeature = commitFile(repo, "a.txt", "same change", "identical edit", new Date(3));

  repo.switchTo("main", new Date(4));
  const onMain = commitFile(repo, "a.txt", "same change", "identical edit", new Date(5));

  assert.equal(onFeature, onMain, "identical content, parent, message and author must hash to one commit");
  const report = repo.merge("feature", { message: "merge\n", author }, new Date(6));
  assert.equal(report.kind, "up_to_date");
  assert.equal(report.clean, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "same change");
});

test("merge takes either side when both made the identical change in distinct commits", () => {
  // The same edit, but genuinely divergent commits — different messages, so
  // different ids. At the tree level the blob ids still match, so the merge is
  // agreement rather than a conflict and no content merge runs.
  const { root } = freshDir();
  const repo = Repository.init(root);
  commitFile(repo, "a.txt", "base", "base", new Date(0));

  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  const onFeature = commitFile(repo, "a.txt", "same change", "edit, described one way", new Date(3));

  repo.switchTo("main", new Date(4));
  const onMain = commitFile(repo, "a.txt", "same change", "edit, described another way", new Date(5));

  assert.notEqual(onFeature, onMain);
  const report = repo.merge("feature", { message: "merge\n", author }, new Date(6));
  assert.equal(report.kind, "merged");
  assert.equal(report.clean, true);
  assert.deepEqual(report.conflicts, []);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "same change");
});

test("merge refuses unrelated histories and an unborn or dirty tree", () => {
  // Two repositories with no shared history.
  const { root: aRoot } = freshDir();
  const a = Repository.init(aRoot);
  const { root: bRoot } = freshDir();
  const b = Repository.init(bRoot);
  const now = new Date(0);
  const aCommit = commitFile(a, "a.txt", "a", "a", now);
  const bCommit = commitFile(b, "b.txt", "b", "b", now);
  // Bring b's commit into a's store by writing it directly, then point a branch at it.
  a.objects.write("commit", b.objects.readTyped(bCommit, "commit"));
  a.refs.compareAndSwap("refs/heads/foreign", null, bCommit);

  assert.throws(
    () => a.merge("foreign", { message: "merge\n", author }, new Date(1)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unrelated_histories",
  );

  // Unborn head cannot merge.
  const { root: emptyRoot } = freshDir();
  const empty = Repository.init(emptyRoot);
  assert.throws(
    () => empty.merge("anything", { message: "m\n", author }, new Date(1)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unborn_head",
  );

  // A dirty worktree cannot merge.
  const { root: dirtyRoot } = freshDir();
  const dirty = Repository.init(dirtyRoot);
  commitFile(dirty, "a.txt", "a", "a", now);
  dirty.createBranch("other", "HEAD", new Date(1));
  dirty.switchTo("other", new Date(2));
  commitFile(dirty, "a.txt", "b", "b", new Date(3));
  dirty.switchTo("main", new Date(4));
  writeFileSync(join(dirtyRoot, "a.txt"), "uncommitted");
  assert.throws(
    () => dirty.merge("other", { message: "m\n", author }, new Date(5)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "dirty_worktree",
  );
});

test("merge resolves record fields independently when record paths are configured", () => {
  const config: RepositoryConfig = { recordPaths: ["item.toon"], recordPolicy: { fields: { priority: "scalar", tags: "set" } } };
  const { root } = freshDir();
  const repo = Repository.init(root, "main", config);
  const now = new Date(0);
  const write = (doc: object): void => writeFileSync(join(root, "item.toon"), `${JSON.stringify(doc, null, 2)}\n`);

  write({ title: "x", priority: 1, tags: ["a"] });
  repo.stage(["item.toon"]);
  repo.commit({ message: "base\n", author }, now);

  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  write({ title: "x", priority: 1, tags: ["a", "b"] });
  repo.stage(["item.toon"]);
  repo.commit({ message: "add tag b\n", author }, new Date(3));

  repo.switchTo("main", new Date(4));
  write({ title: "renamed", priority: 5, tags: ["a"] });
  repo.stage(["item.toon"]);
  repo.commit({ message: "retile and priority\n", author }, new Date(5));

  // Disjoint field changes (title+priority on main, tags on feature) merge clean.
  const report = repo.merge("feature", { message: "merge\n", author }, new Date(6));
  assert.equal(report.clean, true, JSON.stringify(report.conflicts));
  const merged = JSON.parse(readFileSync(join(root, "item.toon"), "utf8"));
  assert.equal(merged.title, "renamed");
  assert.equal(merged.priority, 5);
  assert.deepEqual(merged.tags, ["a", "b"].sort());
});

test("merge conflicts on a single record field while others still merge", () => {
  const config: RepositoryConfig = { recordPaths: ["item.toon"], recordPolicy: { fields: { priority: "scalar" } } };
  const { root } = freshDir();
  const repo = Repository.init(root, "main", config);
  const now = new Date(0);
  const write = (doc: object): void => writeFileSync(join(root, "item.toon"), `${JSON.stringify(doc, null, 2)}\n`);

  write({ title: "x", priority: 1 });
  repo.stage(["item.toon"]);
  repo.commit({ message: "base\n", author }, now);

  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  // Feature changes only priority, so title can merge clean on the other side.
  write({ title: "x", priority: 9 });
  repo.stage(["item.toon"]);
  repo.commit({ message: "feature\n", author }, new Date(3));

  repo.switchTo("main", new Date(4));
  write({ title: "main-title", priority: 7 });
  repo.stage(["item.toon"]);
  repo.commit({ message: "main\n", author }, new Date(5));

  const report = repo.merge("feature", { message: "merge\n", author }, new Date(6));
  assert.equal(report.clean, false);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].reason, "record");
  assert.deepEqual(report.conflicts[0].fields, ["priority"]);
});

test("staging a non-JSON file at a configured record path is refused", () => {
  const config: RepositoryConfig = { recordPaths: ["item.toon"], recordPolicy: {} };
  const { root } = freshDir();
  const repo = Repository.init(root, "main", config);
  writeFileSync(join(root, "item.toon"), "this is not json");
  assert.throws(
    () => repo.stage(["item.toon"]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("a criss-cross merge builds a virtual base rather than picking one arbitrarily", () => {
  // Build a genuine criss-cross by hand: two merges with swapped parents, so
  // mergeBases returns two minimal bases and repo.merge must recurse to build a
  // virtual base rather than silently picking one.
  const { root } = freshDir();
  const repo = Repository.init(root);
  const store = repo.objects;
  const now = new Date(0);

  const blob = (text: string): ObjectId => store.write("blob", Buffer.from(text));
  const tree = (files: Record<string, string>): ObjectId => {
    const map = new Map<string, { id: ObjectId; mode: "100644" }>();
    for (const [name, content] of Object.entries(files)) map.set(name, { id: blob(content), mode: "100644" });
    return buildTree(store, map);
  };
  const make = (treeId: ObjectId, parents: readonly ObjectId[], message: string): ObjectId => {
    const commit: Commit = { tree: treeId, parents, author, committer: author, message: `${message}\n` };
    return writeCommit(store, commit);
  };

  const rootCommit = make(tree({ "base.txt": "base" }), [], "root");
  const a1 = make(tree({ "base.txt": "base", "a-only.txt": "a" }), [rootCommit], "a1");
  const b1 = make(tree({ "base.txt": "base", "b-only.txt": "b" }), [rootCommit], "b1");
  // Two merges with swapped parents: neither is an ancestor of the other.
  const mA = make(tree({ "base.txt": "base", "a-only.txt": "a", "b-only.txt": "b" }), [a1, b1], "mergeA");
  const mB = make(tree({ "base.txt": "base", "a-only.txt": "a", "b-only.txt": "b", "c-extra.txt": "c" }), [b1, a1], "mergeB");
  // Each side then adds the same file with different content.
  const ours = make(tree({ "base.txt": "base", "a-only.txt": "a", "b-only.txt": "b", "shared.txt": "ours" }), [mA], "ours");
  const theirs = make(tree({ "base.txt": "base", "a-only.txt": "a", "b-only.txt": "b", "c-extra.txt": "c", "shared.txt": "theirs" }), [mB], "theirs");

  // Point HEAD/main at ours, and a feature branch at theirs, then materialise.
  repo.refs.setHeadToRef("refs/heads/main");
  repo.refs.compareAndSwap("refs/heads/main", null, ours);
  repo.refs.compareAndSwap("refs/heads/feature", null, theirs);
  repo.switchTo("main", new Date(1));

  const report: MergeReport = repo.merge("feature", { message: "final merge\n", author }, new Date(2));
  // Two minimal bases were found and combined into a virtual base; the same file
  // added with different content is a genuine conflict.
  assert.ok(report.bases.length >= 2, `expected >=2 bases, got ${report.bases.length}`);
  assert.equal(report.clean, false);
});

test("undo restores the ref and re-materialises the tree", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  const first = commitFile(repo, "a.txt", "a", "first", now);
  const second = commitFile(repo, "a.txt", "ab", "second", new Date(1));

  // Undo the most recent commit: HEAD returns to first and the file reverts.
  repo.undo(null, new Date(2));
  assert.equal(repo.refs.resolveHead(), first);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a");

  // Redo by undoing the undo: the ref moves forward again (objects are never
  // removed, so the second commit is still reachable).
  repo.undo(null, new Date(3));
  assert.equal(repo.refs.resolveHead(), second);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "ab");
});

test("allReachable lists every commit reachable from any branch or tag", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  const a = commitFile(repo, "a.txt", "a", "a", now);
  repo.createBranch("other", "HEAD", new Date(1));
  repo.switchTo("other", new Date(2));
  const b = commitFile(repo, "b.txt", "b", "b", new Date(3));
  repo.refs.compareAndSwap("refs/tags/v1", null, a);
  assert.deepEqual(repo.allReachable(), [a, b].sort());
});

test("readIndex returns [] for a missing index and throws on a corrupt one", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  // Missing index file: readIndex tolerates it and returns an empty list.
  removeFile(join(root, CONTROL_DIRECTORY, "index"));
  assert.deepEqual(repo.readIndex(), []);

  // A corrupt index line surfaces the corrupt_index error rather than being
  // silently treated as empty.
  writeFileSync(join(root, CONTROL_DIRECTORY, "index"), "garbage line\n");
  assert.throws(
    () => repo.readIndex(),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_index",
  );
});

test("a commit made on a detached HEAD advances HEAD itself, not a branch", () => {
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  const tip = commitFile(repo, "a.txt", "a", "first", now);
  // Switch to a bare commit id detaches HEAD.
  repo.switchTo(tip, new Date(1));
  assert.equal(repo.refs.readHead().kind, "detached");
  const detached = commitFile(repo, "a.txt", "ab", "detached commit", new Date(2));
  // HEAD now points at the new commit directly.
  assert.equal(repo.refs.resolveHead(), detached);
  // Undo restores HEAD to the detached commit's previous value.
  repo.undo(null, new Date(3));
  assert.equal(repo.refs.resolveHead(), tip);
});

test("switch refuses when a dirty file exists only in the current tree and not the target", () => {
  // This exercises the `?.id ?? null` fallback in switchTo's overwrite check:
  // a path present in the current tree but absent from the target tree produces
  // `null` on one side of the comparison rather than a valid object id.
  const { root } = freshDir();
  const repo = Repository.init(root);
  const now = new Date(0);
  // First commit: a.txt only.
  commitFile(repo, "a.txt", "a", "first", now);

  // Create feature branch before b.txt exists on main.
  repo.createBranch("feature", "HEAD", new Date(1));
  // Add b.txt on main: it exists in HEAD's tree but not in feature's tree.
  commitFile(repo, "b.txt", "b", "second", new Date(2));

  // Make b.txt dirty without staging it, so the switch is refused.
  writeFileSync(join(repo.root, "b.txt"), "dirty");

  assert.throws(
    () => repo.switchTo("feature", new Date(3)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "switch_would_overwrite",
  );
});

/**
 * Removes a file, swallowing missing-file errors.
 *
 * @param path - The file to remove.
 */
function removeFile(path: string): void {
  rmSync(path, { force: true });
}
