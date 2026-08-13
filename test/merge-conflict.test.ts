// Regression tests for issue #26: a conflicted merge used to be committed into
// history with conflict markers in its tree, `--fail-on-conflict` left that
// commit behind, and `status` reported the repository clean afterwards.
//
// Each of the three defects has a test that fails against the pre-fix code: the
// first asserts no reachable commit carries markers (the old merge commit did),
// the second asserts `--fail-on-conflict` both exits non-zero and moves no ref
// (the old code exited non-zero only after committing), and the third asserts
// `status` reports the in-progress merge (the old code reported clean).
//
// Every fixture drives the real engine against a real temporary working tree;
// nothing is mocked.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { ObjectStoreError } from "../engine/objects.ts";
import { readCommit } from "../engine/model.ts";
import { CONTROL_DIRECTORY, type MergeState, Repository } from "../engine/repo.ts";
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

/** Author signature shared by every commit in these fixtures. */
const author = { name: "Repo", email: "repo@local", timestamp: 1_000, timezoneOffsetMinutes: 0 };

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
function commitFile(repo: Repository, path: string, content: string, message: string, now: Date): string {
  writeFileSync(join(repo.root, path), content);
  repo.stage([path]);
  return repo.commit({ message: `${message}\n`, author }, now);
}

/**
 * Builds the issue's reproduction: a base commit, a branch that edits f.txt, and
 * main that edits the same line differently, so merging the branch yields a
 * genuine diff3 content conflict with markers in f.txt.
 *
 * @param root - A fresh repository root.
 * @returns The initialized repository and the main and branch tip ids.
 */
function conflictedRepo(root: string): { repo: Repository; mainTip: string; branchTip: string } {
  const repo = Repository.init(root);
  commitFile(repo, "f.txt", "base\n", "base", new Date(0));
  repo.createBranch("b", "HEAD", new Date(1));
  repo.switchTo("b", new Date(2));
  const branchTip = commitFile(repo, "f.txt", "from-b\n", "b edit", new Date(3));
  repo.switchTo("main", new Date(4));
  const mainTip = commitFile(repo, "f.txt", "from-main\n", "main edit", new Date(5));
  return { repo, mainTip, branchTip };
}

test("a conflicted merge reports kind conflicted and surfaces the in-progress merge on status", () => {
  // New-behaviour detail for issue #26: the merge stops with a `conflicted`
  // report (no commit), and `status` carries the in-progress merge with its
  // conflicted paths — the durable signal defect #3 said was missing.
  const { root } = freshDir();
  const { repo } = conflictedRepo(root);

  const report = repo.merge("b", { message: "flagged merge\n", author }, new Date(6));

  assert.equal(report.kind, "conflicted");
  assert.equal(report.clean, false);
  assert.deepEqual(report.conflicts.map((c) => c.path), ["f.txt"]);

  const status = repo.status();
  assert.equal(status.clean, false);
  assert.ok(status.merge !== undefined, "status must report an in-progress merge");
  assert.deepEqual(status.merge?.conflicts, ["f.txt"]);
  assert.equal(status.merge?.revision, "b");

  // The state is durable on disk, readable by a fresh Repository instance.
  const reopened = Repository.open(root);
  assert.notEqual(reopened.readMergeState(), null);
  assert.equal(reopened.status().clean, false);
});

test("merge --continue completes the merge after the conflicts are resolved and staged", () => {
  const { root } = freshDir();
  const { repo, mainTip, branchTip } = conflictedRepo(root);

  const stopped = repo.merge("b", { message: "flagged merge\n", author }, new Date(6));
  assert.equal(stopped.kind, "conflicted");
  // The working tree carries the markers until the user resolves them.
  assert.match(readFileSync(join(root, "f.txt"), "utf8"), /<<<<<<< ours/);

  // Resolve the conflict and stage the resolution.
  writeFileSync(join(root, "f.txt"), "resolved\n");
  repo.stage(["f.txt"]);

  const completed = repo.mergeContinue(new Date(7));
  assert.equal(completed.kind, "merged");
  assert.equal(completed.clean, true);
  assert.equal(completed.conflicts.length, 0);

  // A merge commit now exists with both parents, and HEAD points at it.
  const head = repo.refs.resolveHead() as string;
  assert.notEqual(head, mainTip);
  const commit = readCommit(repo.objects, head);
  assert.deepEqual([...commit.parents].sort(), [mainTip, branchTip].sort());
  assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "resolved\n");
  // The merge state is cleared, so status is clean and no merge is in progress.
  assert.equal(repo.readMergeState(), null);
  assert.equal(repo.status().clean, true);
});

test("merge --continue refuses while a staged file still contains conflict markers", () => {
  const { root } = freshDir();
  const { repo, mainTip } = conflictedRepo(root);

  repo.merge("b", { message: "flagged merge\n", author }, new Date(6));
  // Resolve nothing — f.txt still holds the markers the stopped merge wrote.
  assert.throws(
    () => repo.mergeContinue(new Date(7)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "merge_conflicts_not_resolved",
  );
  // HEAD did not move and the merge is still in progress.
  assert.equal(repo.refs.resolveHead(), mainTip);
  assert.ok(repo.readMergeState() !== null);
});

test("merge --continue refuses when a resolution is staged but another file still has markers", () => {
  // Two conflicted paths: the user resolves and stages one but forgets the other.
  // `--continue` must still refuse, because the index still carries markers on
  // the unresolved path and would commit them.
  const { root } = freshDir();
  const repo = Repository.init(root);
  commitFile(repo, "a.txt", "base\n", "base", new Date(0));
  commitFile(repo, "b.txt", "base\n", "base", new Date(0));
  repo.createBranch("b", "HEAD", new Date(1));
  repo.switchTo("b", new Date(2));
  commitFile(repo, "a.txt", "from-b-a\n", "b a", new Date(3));
  commitFile(repo, "b.txt", "from-b-b\n", "b b", new Date(4));
  repo.switchTo("main", new Date(5));
  commitFile(repo, "a.txt", "from-main-a\n", "main a", new Date(6));
  commitFile(repo, "b.txt", "from-main-b\n", "main b", new Date(7));

  const stopped = repo.merge("b", { message: "merge\n", author }, new Date(8));
  assert.equal(stopped.conflicts.length, 2);

  // Resolve only a.txt and stage it; leave b.txt with markers.
  writeFileSync(join(root, "a.txt"), "resolved-a\n");
  repo.stage(["a.txt"]);
  assert.throws(
    () => repo.mergeContinue(new Date(9)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "merge_conflicts_not_resolved",
  );
});

test("merge --abort restores the working tree and clears the in-progress state", () => {
  const { root } = freshDir();
  const { repo, mainTip } = conflictedRepo(root);

  repo.merge("b", { message: "flagged merge\n", author }, new Date(6));
  assert.ok(repo.readMergeState() !== null);
  assert.match(readFileSync(join(root, "f.txt"), "utf8"), /<<<<<<< ours/);

  const aborted = repo.mergeAbort(new Date(7));
  assert.equal(aborted.revision, "b");
  assert.equal(repo.refs.resolveHead(), mainTip);
  // The working tree is back to the pre-merge main commit's content.
  assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "from-main\n");
  assert.equal(repo.readMergeState(), null);
  assert.equal(repo.status().clean, true);
});

test("commit is refused while a merge is in progress", () => {
  // The issue's suggested direction #3: a plain commit must not sneak the
  // markers (or a single-parent version of the merge) into history while a
  // merge is unresolved. `--continue` is the only way to complete the merge.
  const { root } = freshDir();
  const { repo, mainTip } = conflictedRepo(root);

  repo.merge("b", { message: "flagged merge\n", author }, new Date(6));
  // Stage an unrelated change and try to commit it: still refused, because the
  // merge state is the authority on whether a resolution is owed.
  writeFileSync(join(root, "other.txt"), "unrelated\n");
  repo.stage(["other.txt"]);
  assert.throws(
    () => repo.commit({ message: "sneak\n", author }, new Date(7)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "merge_in_progress",
  );
  assert.equal(repo.refs.resolveHead(), mainTip);
});

test("a second merge is refused while one is already in progress", () => {
  const { root } = freshDir();
  const { repo } = conflictedRepo(root);

  repo.merge("b", { message: "first\n", author }, new Date(6));
  assert.throws(
    () => repo.merge("b", { message: "second\n", author }, new Date(7)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "merge_in_progress",
  );
});

test("switch, reset and undo are refused while a merge is in progress", () => {
  // These commands would either move HEAD out from under the recorded merge
  // parents or rewrite the working tree, desyncing it from the merge state. They
  // are refused until the merge is completed or aborted.
  const { root } = freshDir();
  const { repo, mainTip } = conflictedRepo(root);
  repo.merge("b", { message: "merge\n", author }, new Date(6));

  assert.throws(
    () => repo.switchTo("b", new Date(7)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "merge_in_progress",
  );
  assert.throws(
    () => repo.reset("HEAD", "mixed", new Date(7)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "merge_in_progress",
  );
  assert.throws(
    () => repo.undo(null, new Date(7)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "merge_in_progress",
  );
  assert.equal(repo.refs.resolveHead(), mainTip);
});

test("merge --continue and --abort refuse when no merge is in progress", () => {
  const { root } = freshDir();
  const { repo } = conflictedRepo(root);
  // No merge started yet.
  assert.throws(
    () => repo.mergeContinue(new Date(7)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "no_merge_in_progress",
  );
  assert.throws(
    () => repo.mergeAbort(new Date(7)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "no_merge_in_progress",
  );
});

test("a merge state file is durable and round-trips through the control directory", () => {
  // The state holds every field --continue needs, so completing the merge after
  // reopening the repository works without the caller re-supplying anything.
  const { root } = freshDir();
  const { repo, mainTip, branchTip } = conflictedRepo(root);

  repo.merge("b", { message: "flagged merge\n", author }, new Date(6));
  const statePath = join(root, CONTROL_DIRECTORY, "MERGE_STATE");
  const raw = JSON.parse(readFileSync(statePath, "utf8")) as MergeState;
  assert.equal(raw.revision, "b");
  assert.equal(raw.ours, mainTip);
  assert.equal(raw.theirs, branchTip);
  assert.deepEqual(raw.conflicts.map((c) => c.path), ["f.txt"]);

  // Resolve, reopen, and complete in a separate process-equivalent session.
  writeFileSync(join(root, "f.txt"), "resolved\n");
  const reopened = Repository.open(root);
  reopened.stage(["f.txt"]);
  const completed = reopened.mergeContinue(new Date(7));
  assert.equal(completed.kind, "merged");
  assert.equal(completed.clean, true);
  assert.equal(reopened.readMergeState(), null);
});

test("a clean merge still commits and reports no in-progress state", () => {
  // Guard against the fix over-reaching: a merge with no conflict markers must
  // still record a merge commit and leave no merge state behind.
  const { root } = freshDir();
  const repo = Repository.init(root);
  commitFile(repo, "a.txt", "line1\nline2\n", "base", new Date(0));
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  commitFile(repo, "a.txt", "line1\nFEATURE\n", "feature edits line two", new Date(3));
  repo.switchTo("main", new Date(4));
  commitFile(repo, "b.txt", "added on main\n", "main adds a file", new Date(5));

  const report = repo.merge("feature", { message: "clean merge\n", author }, new Date(6));
  assert.equal(report.kind, "merged");
  assert.equal(report.clean, true);
  assert.equal(repo.readMergeState(), null);
  assert.equal(repo.status().clean, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "line1\nFEATURE\n");
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "added on main\n");
});
test("readMergeState throws a corrupt_merge_state error when the state file is not valid JSON", () => {
  // The state file is only ever written by this engine, so a malformed one means
  // the control directory was damaged mid-merge. readMergeState refuses to
  // pretend nothing is owed rather than letting a broken merge commit slip in.
  const { root } = freshDir();
  const repo = Repository.init(root);
  mkdirSync(join(root, CONTROL_DIRECTORY), { recursive: true });
  writeFileSync(join(root, CONTROL_DIRECTORY, "MERGE_STATE"), "{not valid json");
  assert.throws(
    () => repo.readMergeState(),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_merge_state",
  );
});

test("readMergeState rethrows a non-ENOENT read error", () => {
  // A read failure that is not "the file does not exist" (here: the path is a
  // directory, so readFileSync raises EISDIR) is rethrown rather than swallowed
  // into a false "no merge in progress", so a damaged control directory surfaces
  // instead of silently allowing a commit.
  const { root } = freshDir();
  const repo = Repository.init(root);
  mkdirSync(join(root, CONTROL_DIRECTORY, "MERGE_STATE"), { recursive: true });
  assert.throws(
    () => repo.readMergeState(),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EISDIR",
  );
});

test("a conflicted merge persists custom conflict-marker labels for consistent re-rendering", () => {
  // The merge state stores the labels the original merge used, so a later
  // `--continue` does not re-render with different marker text. This also
  // exercises the `labels !== undefined` branch of the state writer.
  const { root } = freshDir();
  const { repo } = conflictedRepo(root);

  const labels = { ours: "head", base: "ancestor", theirs: "incoming" };
  repo.merge("b", { message: "flagged merge\n", author }, new Date(6), labels);

  // The working-tree markers use the caller-supplied labels.
  assert.match(readFileSync(join(root, "f.txt"), "utf8"), /<<<<<<< head/);
  assert.match(readFileSync(join(root, "f.txt"), "utf8"), />>>>>>> incoming/);
  // The labels are persisted in the merge state.
  const state = repo.readMergeState();
  assert.deepEqual(state?.labels, labels);
});

/**
 * Builds a repository whose merged tree is deep (seven nested directories) and
 * whose merge of `b` into `main` produces exactly `n` genuine diff3 content
 * conflicts, one per file at the bottom of that tree. The depth makes each
 * `flattenTree` walk read eight tree objects, so walking the tree once per
 * conflict is measurably more expensive than walking it once.
 *
 * @param root - A fresh repository root.
 * @param n - Number of conflicting files to create.
 * @returns The initialized repository, ready to merge `b` into `main`.
 */
function deepConflictedRepo(root: string, n: number): Repository {
  const repo = Repository.init(root);
  const dir = "a/b/c/d/e/f/g";
  const paths: string[] = [];
  for (let k = 1; k <= n; k += 1) paths.push(`${dir}/f${k}.txt`);
  const writeAll = (content: string): void => {
    for (const p of paths) {
      mkdirSync(join(root, ...p.split("/").slice(0, -1)), { recursive: true });
      const k = p.match(/f(\d)/)?.[1] ?? "1";
      writeFileSync(join(root, p), content.replace("K", k));
    }
  };
  const commitAll = (content: string, message: string, now: Date): string => {
    writeAll(content);
    repo.stage(paths);
    return repo.commit({ message: `${message}\n`, author }, now);
  };
  commitAll("base\n", "base", new Date(0));
  repo.createBranch("b", "HEAD", new Date(1));
  repo.switchTo("b", new Date(2));
  commitAll("from-b-K\n", "b edit", new Date(3));
  repo.switchTo("main", new Date(4));
  commitAll("from-main-K\n", "main edit", new Date(5));
  return repo;
}

test("merge --abort recovers from a corrupt merge-state file rather than throwing", () => {
  // Finding 1: readMergeState throws corrupt_merge_state for a malformed file,
  // and mergeAbort used to call readMergeState first, so the same corrupt state
  // that prompted the user to run `pm vcs merge --abort` made abort itself throw
  // — the documented recovery path was broken by the condition it reported,
  // leaving the repository permanently stuck. abort must instead clear the
  // corrupt state and restore the pre-merge tree (the stopped merge never moved
  // HEAD, so HEAD still names it), which is the whole point of abort.
  const { root } = freshDir();
  const { repo, mainTip } = conflictedRepo(root);
  repo.merge("b", { message: "flagged merge\n", author }, new Date(6));
  assert.ok(repo.readMergeState() !== null);
  // Corrupt the state exactly as a truncated write would.
  writeFileSync(join(root, CONTROL_DIRECTORY, "MERGE_STATE"), "{not valid json");

  // abort must recover rather than throw corrupt_merge_state.
  const aborted = repo.mergeAbort(new Date(7));
  assert.equal(aborted.ours, mainTip);
  // theirs and revision lived only in the unreadable state, so they are omitted.
  assert.equal(aborted.theirs, undefined);
  assert.equal(aborted.revision, undefined);
  // The corrupt state is cleared and the working tree is restored to main.
  assert.equal(repo.readMergeState(), null);
  assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "from-main\n");
  assert.equal(repo.status().clean, true);
});

test("merge --abort clears a corrupt merge state even when HEAD is unborn", () => {
  // The corrupt-state recovery falls back to HEAD for the pre-merge tree. When
  // HEAD is unborn there is no tree to restore, but abort must still clear the
  // corrupt state so the repository is not permanently stuck, then report —
  // rather than throwing corrupt_merge_state (the pre-fix behaviour that left
  // the repo unrecoverable through the documented path).
  const { root } = freshDir();
  const repo = Repository.init(root);
  // HEAD is unborn (no commits), and the merge state is corrupt.
  mkdirSync(join(root, CONTROL_DIRECTORY), { recursive: true });
  writeFileSync(join(root, CONTROL_DIRECTORY, "MERGE_STATE"), "{not valid json");
  assert.throws(
    () => repo.mergeAbort(new Date(7)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unborn_head",
  );
  // The corrupt state was cleared despite HEAD being unborn.
  assert.equal(repo.readMergeState(), null);
});

test("a conflicted merge walks the merged tree once for the marker scan, not once per conflict", () => {
  // Finding 2: flattenTree used to be called inside the per-conflict marker
  // filter, so the whole merged tree was walked once per conflict. With a deep
  // merged tree (eight tree objects) and five conflicts that is four extra full
  // tree walks — 4 * 8 = 32 extra object-store reads — versus walking it once.
  // The flattened tree cannot change between iterations (`tree` is one fixed
  // content-addressed id and the object store is not mutated during the scan),
  // so hoisting is behaviour-preserving; this test pins the perf invariant by
  // measuring the marginal object-store read cost of adding four conflicts.
  const one = makeTempDir();
  const repoOne = deepConflictedRepo(one.root, 1);
  const originalOne = repoOne.objects.read.bind(repoOne.objects);
  let readsOne = 0;
  repoOne.objects.read = (id): ReturnType<typeof originalOne> => {
    readsOne += 1;
    return originalOne(id);
  };
  const reportOne = repoOne.merge("b", { message: "m\n", author }, new Date(6));
  assert.equal(reportOne.conflicts.length, 1);
  one.cleanup();

  // Keep the second handle in the module-level `dir` so afterEach cleans it up.
  dir = makeTempDir();
  const repoFive = deepConflictedRepo(dir.root, 5);
  const originalFive = repoFive.objects.read.bind(repoFive.objects);
  let readsFive = 0;
  repoFive.objects.read = (id): ReturnType<typeof originalFive> => {
    readsFive += 1;
    return originalFive(id);
  };
  const reportFive = repoFive.merge("b", { message: "m\n", author }, new Date(6));
  assert.equal(reportFive.conflicts.length, 5);

  // Adding four conflicts must add only the per-file blob processing, not four
  // full merged-tree walks. Without the hoist the delta is ~52 (20 per-file plus
  // 4*8 tree-walk reads); with the hoist it is ~20. The threshold sits between.
  const marginalReads = readsFive - readsOne;
  assert.ok(
    marginalReads < 36,
    `adding four conflicts added ${marginalReads} object-store reads; the merged tree must be walked once, not once per conflict`,
  );
});
