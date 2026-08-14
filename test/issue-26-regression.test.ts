// Regression tests for issue #26 — the three defects the issue reports.
//
// Each test is written to compile and run against the pre-fix code and to FAIL
// there, then pass after the fix. They use only the engine API that existed
// before the fix, so stashing the source fix leaves them runnable and red.
//
//   Defect #1 — a merge that leaves conflict markers used to be committed, so
//   the merge commit's tree physically carried `<<<<<<<` / `|||||||` / `=======`
//   / `>>>>>>>` markers. The test asserts no commit reachable from HEAD after a
//   conflicted merge carries markers; pre-fix, the merge commit was reachable
//   and its file had markers, so the assertion failed.
//
//   Defect #2 — `--fail-on-conflict` exited non-zero only after the merge was
//   already committed. The test asserts the gate fires AND HEAD did not move;
//   pre-fix, HEAD moved to the merge commit, so the HEAD-unchanged assertion
//   failed.
//
//   Defect #3 — after a conflicted merge, `status` reported `clean: true`
//   because the merge had committed and the three states agreed. The test
//   asserts `status` is not clean; pre-fix, it was clean, so the assertion
//   failed.
//
// Every fixture drives the real engine against a real temporary working tree.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import { reachable } from "../engine/merge.ts";
import { readCommit } from "../engine/model.ts";
import { Repository } from "../engine/repo.ts";
import { flattenTree } from "../engine/worktree.ts";
import extension from "../index.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import { packageRoot } from "./helpers/sandbox.ts";

/** Capability list the harness accepts, derived from its own signature. */
type HarnessCapabilities = NonNullable<
  NonNullable<Parameters<typeof createExtensionTestHarness>[1]>["capabilities"]
>;

/** The shipped manifest's capabilities, so the harness activates exactly as at runtime. */
const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8")) as {
  capabilities: HarnessCapabilities;
};

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

/** Author signature shared by every engine-level commit in these fixtures. */
const author = { name: "Repo", email: "repo@local", timestamp: 1_000, timezoneOffsetMinutes: 0 };

/** Author the host supplies through its invocation-wide `--author`. */
const AUTHOR = "Issue 26 <issue26@pm-vcs.invalid>";

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

/**
 * Whether a blob's bytes contain a diff3 conflict-marker line.
 *
 * Mirrors the engine's own marker detection so the test asserts against the same
 * shape the merge writes.
 *
 * @param repo - The repository whose object store holds the blob.
 * @param id - The blob object id.
 * @returns True when the blob text contains a marker line.
 */
function blobHasMarkers(repo: Repository, id: string): boolean {
  const object = repo.objects.read(id);
  if (object.type !== "blob") return false;
  return /^(?:<{7} |\|{7} |={7}$|>{7} )/m.test(object.payload.toString("utf8"));
}

test("defect #1: a conflicted merge does not commit a tree containing conflict markers", () => {
  // Pre-fix, the merge committed and its f.txt blob carried `<<<<<<<` markers,
  // so a reachable commit had markers in its tree and this assertion failed.
  const { root } = freshDir();
  const { repo, mainTip } = conflictedRepo(root);

  repo.merge("b", { message: "flagged merge\n", author }, new Date(6));

  // HEAD must not have moved to a merge commit.
  assert.equal(repo.refs.resolveHead(), mainTip);
  // And no commit reachable from HEAD may carry markers in its tree.
  for (const commit of reachable(repo.objects, mainTip)) {
    const tree = readCommit(repo.objects, commit).tree;
    for (const [, value] of flattenTree(repo.objects, tree)) {
      assert.equal(
        blobHasMarkers(repo, value.id),
        false,
        `commit ${commit.slice(0, 12)} carries conflict markers in its tree`,
      );
    }
  }
});

test("defect #3: status reports not clean after a conflicted merge", () => {
  // Pre-fix, the merge committed and HEAD, index and working tree agreed, so
  // `status` reported `clean: true` and this assertion failed.
  const { root } = freshDir();
  const { repo } = conflictedRepo(root);

  repo.merge("b", { message: "flagged merge\n", author }, new Date(6));
  assert.equal(repo.status().clean, false);
});

test("defect #2: --fail-on-conflict exits non-zero without having committed the merge", async () => {
  // Pre-fix, the gate threw (so `handled === false`) but only after the merge
  // was committed, so HEAD had moved and the HEAD-unchanged assertion failed.
  const harness = await createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
  const handle = makeTempDir();
  dir = handle;
  const root = handle.root;
  await harness.runCommand({ command: "vcs init", pmRoot: root });
  const write = (path: string, content: string): void => writeFileSync(join(root, path), content);
  const addCommit = async (message: string): Promise<void> => {
    await harness.runCommand({ command: "vcs add", pmRoot: root });
    await harness.runCommand({ command: "vcs commit", options: { message }, global: { author: AUTHOR }, pmRoot: root });
  };
  write("f.txt", "base\n");
  await addCommit("base");
  await harness.runCommand({ command: "vcs branch", args: ["b"], pmRoot: root });
  await harness.runCommand({ command: "vcs switch", args: ["b"], pmRoot: root });
  write("f.txt", "from-b\n");
  await addCommit("b edit");
  await harness.runCommand({ command: "vcs switch", args: ["main"], pmRoot: root });
  write("f.txt", "from-main\n");
  await addCommit("main edit");
  const mainTip = Repository.open(root).refs.resolveHead() as string;

  const gated = await harness.runCommand({
    command: "vcs merge",
    args: ["b"],
    options: { failOnConflict: true },
    global: { author: AUTHOR },
    pmRoot: root,
  }) as { handled: boolean; errorMessage?: string };

  assert.equal(gated.handled, false);
  assert.ok(gated.errorMessage !== undefined);
  assert.equal(Repository.open(root).refs.resolveHead(), mainTip);
});