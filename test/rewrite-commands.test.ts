// The history-rewriting commands, driven through the host's real loader.
//
// `rewrite.test.ts` covers the engine. This covers the surface an agent actually
// reaches: nine verbs, their option parsing, their refusals, and the envelopes they
// return. Registration matters as much as behaviour here — a command whose flag
// object carries a misnamed field type-checks cleanly and then aborts activation,
// silently dropping every sibling registered after it, so the count assertion in
// `vcs-commands.test.ts` is load-bearing and these tests are what prove each of the
// nine actually runs.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";
import { Repository } from "../engine/repo.ts";
import { BRANCH_PREFIX } from "../engine/refs.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import { packageRoot } from "./helpers/sandbox.ts";

const sandboxes: Array<{ cleanup(): void }> = [];

after(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

/** Capability list the harness accepts, derived from its own signature. */
type HarnessCapabilities = NonNullable<
  NonNullable<Parameters<typeof createExtensionTestHarness>[1]>["capabilities"]
>;

/** The shipped manifest's capabilities, so the harness activates exactly as at runtime. */
const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8")) as {
  capabilities: HarnessCapabilities;
};

/** Author the host supplies through its invocation-wide `--author`. */
const AUTHOR = "Rewriter <rewriter@pm-vcs.invalid>";

/** One command invocation's outcome, as the harness reports it. */
interface Ran {
  readonly handled: boolean;
  readonly result?: unknown;
  readonly errorMessage?: string;
}

/**
 * Creates a repository with three commits on `main` and a bound runner.
 *
 * `a.txt` gains a line per commit, so a rewrite that replays descendants has real
 * content to merge rather than an empty tree that would succeed vacuously.
 *
 * @returns The repository root and a `run` bound to the activated harness.
 */
async function repoWithHistory(): Promise<{
  root: string;
  run: (command: string, args?: string[], options?: Record<string, unknown>) => Promise<Ran>;
}> {
  const handle = makeTempDir();
  sandboxes.push(handle);
  const root = handle.root;
  const harness = await createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
  const run = async (
    command: string,
    args: string[] = [],
    options: Record<string, unknown> = {},
  ): Promise<Ran> => harness.runCommand({ command, args, options, global: { author: AUTHOR }, pmRoot: root }) as Promise<Ran>;

  await run("vcs init");
  for (const [index, line] of ["one", "two", "three"].entries()) {
    writeFileSync(join(root, "a.txt"), `${["one", "two", "three"].slice(0, index + 1).join("\n")}\n`);
    await run("vcs add");
    await run("vcs commit", [], { message: `add ${line}` });
  }
  return { root, run };
}

/**
 * First-parent log ids, newest first.
 *
 * @param root - Repository root.
 * @returns Commit ids.
 */
function logIds(root: string): string[] {
  return Repository.open(root).log("HEAD", 50).map((entry) => entry.id);
}

test("describe rewords a commit, keeps its change id, and replays its descendants", async () => {
  const { root, run } = await repoWithHistory();
  const before = logIds(root);
  const target = before[2]!;
  const targetChange = (await run("vcs show", [target])).result as { commit: { changeId: string } };

  const described = await run("vcs describe", [target], { message: "add one, reworded" });
  assert.equal(described.handled, true);

  const after = logIds(root);
  // Three commits still, and every id changed from the rewritten one onward — a
  // reworded commit is a different commit, and its descendants name it as a parent.
  assert.equal(after.length, 3);
  assert.notEqual(after[2], before[2]);
  assert.notEqual(after[0], before[0], "descendants are replayed, not orphaned");
  // The change identity survives the rewrite. That is the whole point of having one.
  const rewritten = (await run("vcs show", [after[2]!])).result as { commit: { changeId: string; message: string } };
  assert.equal(rewritten.commit.changeId, targetChange.commit.changeId);
  assert.equal(rewritten.commit.message, "add one, reworded");
  // The branch moved with it rather than being left at a commit nothing reaches.
  assert.equal(Repository.open(root).refs.read(`${BRANCH_PREFIX}main`), after[0]);
});

test("describe refuses without a message rather than recording an empty one", async () => {
  const { run } = await repoWithHistory();
  const result = await run("vcs describe", ["HEAD"]);
  assert.equal(result.handled, false);
  assert.match(String(result.errorMessage), /requires a message/);
});

test("rebase replays a divergent branch and preserves each change id", async () => {
  const { root, run } = await repoWithHistory();
  const base = logIds(root)[0]!;
  await run("vcs branch", ["feature"], { at: base });
  await run("vcs switch", ["feature"]);
  writeFileSync(join(root, "b.txt"), "feature work\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "feature commit" });
  const featureTip = logIds(root)[0]!;
  const featureChange = (await run("vcs show", [featureTip])).result as { commit: { changeId: string } };

  // main moves on, touching a different file, so the replay has something to rebase
  // over and nothing to conflict with.
  await run("vcs switch", ["main"]);
  writeFileSync(join(root, "c.txt"), "main work\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "main commit" });
  const mainTip = logIds(root)[0]!;

  const rebased = await run("vcs rebase", ["feature"], { onto: "main" });
  assert.equal(rebased.handled, true);
  const repository = Repository.open(root);
  const newTip = repository.refs.read(`${BRANCH_PREFIX}feature`) as string;
  assert.notEqual(newTip, featureTip);
  // The replayed commit sits on main's tip and carries both files.
  assert.deepEqual(repository.log(newTip, 1)[0]!.commit.parents, [mainTip]);
  const shown = (await run("vcs show", [newTip])).result as { commit: { changeId: string } };
  assert.equal(shown.commit.changeId, featureChange.commit.changeId, "a replayed commit is the same change");
});

test("a rebase that genuinely conflicts refuses and changes nothing", async () => {
  const { root, run } = await repoWithHistory();
  const base = logIds(root)[0]!;
  await run("vcs branch", ["feature"], { at: base });
  await run("vcs switch", ["feature"]);
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nfeature line\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "feature edits the tail" });
  const featureTip = logIds(root)[0]!;

  await run("vcs switch", ["main"]);
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nmain line\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "main edits the same tail" });
  const mainTip = logIds(root)[0]!;

  const rebased = await run("vcs rebase", ["feature"], { onto: "main" });
  assert.equal(rebased.handled, false);
  assert.match(String(rebased.errorMessage), /conflict/);
  assert.match(String(rebased.errorMessage), /a\.txt/);
  // Transactional: both refs are exactly where they were, and the working tree still
  // holds main's content rather than a half-applied replay.
  const repository = Repository.open(root);
  assert.equal(repository.refs.read(`${BRANCH_PREFIX}feature`), featureTip);
  assert.equal(repository.refs.read(`${BRANCH_PREFIX}main`), mainTip);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\ntwo\nthree\nmain line\n");
  assert.equal(repository.status().clean, true);
});

test("squash folds a commit into its parent and keeps the parent's change id", async () => {
  const { root, run } = await repoWithHistory();
  const before = logIds(root);
  const parentChange = (await run("vcs show", [before[1]!])).result as { commit: { changeId: string } };

  const squashed = await run("vcs squash", [before[0]!]);
  assert.equal(squashed.handled, true);
  const after = logIds(root);
  assert.equal(after.length, 2, "three commits became two");
  const survivor = (await run("vcs show", [after[0]!])).result as { commit: { changeId: string; message: string } };
  assert.equal(survivor.commit.changeId, parentChange.commit.changeId);
  // Both messages survive, joined, rather than one being discarded silently.
  assert.match(survivor.commit.message, /add two/);
  assert.match(survivor.commit.message, /add three/);
  // The tree is the child's, so no content was lost by folding.
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\ntwo\nthree\n");
});

test("split divides one commit in two along a path set", async () => {
  const { root, run } = await repoWithHistory();
  writeFileSync(join(root, "d.txt"), "d\n");
  writeFileSync(join(root, "e.txt"), "e\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "add d and e together" });
  const before = logIds(root);

  const split = await run("vcs split", [before[0]!, "d.txt"]);
  assert.equal(split.handled, true);
  const after = logIds(root);
  assert.equal(after.length, before.length + 1, "one commit became two");
  // The first half carries only d.txt; the second adds e.txt. Reading the diffs is
  // what proves the split was by path rather than arbitrary.
  const firstHalf = (await run("vcs show", [after[1]!])).result as { diff: string };
  assert.match(firstHalf.diff, /d\.txt/);
  assert.doesNotMatch(firstHalf.diff, /e\.txt/);
  const secondHalf = (await run("vcs show", [after[0]!])).result as { diff: string };
  assert.match(secondHalf.diff, /e\.txt/);
  // The final tree is unchanged by splitting: a split moves nothing.
  assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "d\n");
  assert.equal(readFileSync(join(root, "e.txt"), "utf8"), "e\n");
});

test("split refuses when one side would be empty, and says which", async () => {
  const { root, run } = await repoWithHistory();
  const head = logIds(root)[0]!;
  // `a.txt` is the only path the commit touches, so splitting on a path it does not
  // touch leaves the first half with nothing.
  const noMatch = await run("vcs split", [head, "nothing-matches-this"]);
  assert.equal(noMatch.handled, false);
  // The message names the paths the commit does change, because "resolve the listed
  // paths" — what a conflict would have said — is advice nobody can act on for a
  // pattern that matched nothing.
  assert.match(String(noMatch.errorMessage), /would leave the first commit empty/);
  assert.match(String(noMatch.errorMessage), /a\.txt/);

  // And the mirror case: a pattern matching everything leaves the second half empty.
  const matchesAll = await run("vcs split", [head, "a.txt"]);
  assert.equal(matchesAll.handled, false);
  assert.match(String(matchesAll.errorMessage), /would leave the second commit empty/);
});

test("cherry-pick applies one commit's change onto HEAD as a new change", async () => {
  const { root, run } = await repoWithHistory();
  const base = logIds(root)[0]!;
  await run("vcs branch", ["side"], { at: base });
  await run("vcs switch", ["side"]);
  writeFileSync(join(root, "picked.txt"), "content to pick\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "the commit to pick" });
  const source = logIds(root)[0]!;
  const sourceChange = (await run("vcs show", [source])).result as { commit: { changeId: string } };

  await run("vcs switch", ["main"]);
  const picked = await run("vcs cherry-pick", [source]);
  assert.equal(picked.handled, true);
  assert.equal(readFileSync(join(root, "picked.txt"), "utf8"), "content to pick\n");
  // A new change id: a cherry-pick is a second, distinct change that happens to make
  // the same edit. Sharing the id would make two commits claim to be one change.
  const shown = (await run("vcs show", [])).result as { commit: { changeId: string; message: string } };
  assert.notEqual(shown.commit.changeId, sourceChange.commit.changeId);
  assert.match(shown.commit.message, /the commit to pick/);
});

test("revert applies the inverse change and leaves the original in history", async () => {
  const { root, run } = await repoWithHistory();
  const target = logIds(root)[0]!;

  const reverted = await run("vcs revert", [target], { message: "back out add three" });
  assert.equal(reverted.handled, true);
  // The content is as it was before the reverted commit, and the commit itself is
  // still reachable — a revert adds history rather than removing it.
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\ntwo\n");
  assert.equal(logIds(root).length, 4);
  assert.ok(logIds(root).includes(target));
  const shown = (await run("vcs show", [])).result as { commit: { message: string } };
  assert.equal(shown.commit.message, "back out add three");
});

test("revert without a message generates one naming the commit", async () => {
  const { root, run } = await repoWithHistory();
  const target = logIds(root)[0]!;
  assert.equal((await run("vcs revert", [target])).handled, true);
  const shown = (await run("vcs show", [])).result as { commit: { message: string } };
  assert.match(shown.commit.message, new RegExp(target.slice(0, 12)));
});

test("reset moves the branch, and each mode reaches one step further", async () => {
  const { root, run } = await repoWithHistory();
  const before = logIds(root);
  const first = before[2]!;

  // soft: the branch moves, the index and working tree do not.
  assert.equal((await run("vcs reset", [first], { mode: "soft" })).handled, true);
  let repository = Repository.open(root);
  assert.equal(repository.refs.read(`${BRANCH_PREFIX}main`), first);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\ntwo\nthree\n", "soft leaves the tree alone");
  assert.equal(repository.status().clean, false, "so the tree now differs from HEAD");

  // hard: the working tree follows.
  assert.equal((await run("vcs reset", [first], { mode: "hard" })).handled, true);
  repository = Repository.open(root);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
  assert.equal(repository.status().clean, true);
  // Nothing was destroyed: objects are never removed, so undo can put it back.
  assert.equal((await run("vcs undo")).handled, true);
  assert.equal(Repository.open(root).refs.read(`${BRANCH_PREFIX}main`), first);
});

test("reset refuses a mode it does not implement", async () => {
  const { root, run } = await repoWithHistory();
  const result = await run("vcs reset", [logIds(root)[1]!], { mode: "sideways" });
  assert.equal(result.handled, false);
  assert.match(String(result.errorMessage), /soft|mixed|hard/);
});

test("restore brings named paths back from a revision without moving HEAD", async () => {
  const { root, run } = await repoWithHistory();
  const before = logIds(root);
  const head = before[0]!;
  writeFileSync(join(root, "a.txt"), "locally mangled\n");

  const restored = await run("vcs restore", ["HEAD", "a.txt"]);
  assert.equal(restored.handled, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  // HEAD did not move: restore is not a checkout.
  assert.equal(Repository.open(root).refs.read(`${BRANCH_PREFIX}main`), head);
  assert.equal(Repository.open(root).status().clean, true);

  // With no paths it restores everything the revision carries.
  writeFileSync(join(root, "a.txt"), "mangled again\n");
  assert.equal((await run("vcs restore", ["HEAD"])).handled, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\ntwo\nthree\n");
});

test("show reports a commit's identity and its diff, and a root commit has no diff", async () => {
  const { root, run } = await repoWithHistory();
  const ids = logIds(root);

  const head = (await run("vcs show", [])).result as {
    commit: { id: string; changeId: string; parents: readonly string[]; author: string; at: string; message: string };
    diff: string;
  };
  assert.equal(head.commit.id, ids[0]);
  assert.equal(head.commit.author, AUTHOR);
  assert.match(head.commit.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(head.diff, /a\.txt/);
  assert.match(head.diff, /^\+three$/m);

  // A root commit has no first parent, so there is nothing to diff against. Reporting
  // an empty diff is the honest answer rather than diffing against an empty tree and
  // presenting the whole snapshot as an addition.
  const rootCommit = (await run("vcs show", [ids[2]!])).result as { commit: { parents: readonly string[] }; diff: string };
  assert.deepEqual(rootCommit.commit.parents, []);
  assert.equal(rootCommit.diff, "");
});

test("every rewriting command refuses a dirty working tree before touching anything", async () => {
  // A rewrite re-materializes the tree, so uncommitted work would be overwritten by
  // content from a commit. Refusing first is the same invariant `switch` holds.
  const { root, run } = await repoWithHistory();
  const head = logIds(root)[0]!;
  writeFileSync(join(root, "a.txt"), "uncommitted work\n");

  for (const [command, args, options] of [
    ["vcs describe", [head], { message: "x" }],
    ["vcs squash", [head], {}],
    ["vcs split", [head, "a.txt"], {}],
    ["vcs cherry-pick", [head], {}],
    ["vcs revert", [head], {}],
  ] as Array<[string, string[], Record<string, unknown>]>) {
    const result = await run(command, args, options);
    assert.equal(result.handled, false, `${command} must refuse a dirty tree`);
    assert.match(String(result.errorMessage), /commit|stash|clean|uncommitted/i);
  }
  // The uncommitted work is still there.
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "uncommitted work\n");
});

test("a rewrite is one operation-log entry, so undo reverses it whole", async () => {
  const { root, run } = await repoWithHistory();
  const before = logIds(root);

  assert.equal((await run("vcs describe", [before[2]!], { message: "reworded root" })).handled, true);
  const after = logIds(root);
  assert.notDeepEqual(after, before);

  assert.equal((await run("vcs undo")).handled, true);
  // Every ref the rewrite moved is back, in one step, because the rewrite recorded
  // them in a single entry rather than one per replayed commit.
  assert.deepEqual(logIds(root), before);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\ntwo\nthree\n");
});

test("a rewrite spanning a merge commit orders parents before children", async () => {
  // The replay order comes from a depth-first walk over the commits being rewritten.
  // A merge gives a commit two parents inside the range and a diamond gives two paths
  // to one ancestor, which is where an ordering that only tracked one parent, or that
  // re-emitted an already-emitted commit, would go wrong.
  const { root, run } = await repoWithHistory();
  const base = logIds(root)[0]!;
  await run("vcs branch", ["left"], { at: base });
  await run("vcs switch", ["left"]);
  writeFileSync(join(root, "left.txt"), "left\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "left side" });

  await run("vcs switch", ["main"]);
  writeFileSync(join(root, "right.txt"), "right\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "right side" });
  const merged = await run("vcs merge", ["left"], { message: "merge left" });
  assert.equal(merged.handled, true);

  // Rewording the shared base forces every commit above it — both sides and the merge
  // — to be replayed.
  const described = await run("vcs describe", [base], { message: "reworded shared base" });
  assert.equal(described.handled, true);
  const repository = Repository.open(root);
  const tip = repository.refs.read(`${BRANCH_PREFIX}main`) as string;
  const tipCommit = repository.log(tip, 1)[0]!.commit;
  assert.equal(tipCommit.parents.length, 2, "the merge survived as a merge");
  // Both sides' content is still present, so neither parent was dropped in the replay.
  assert.equal(readFileSync(join(root, "left.txt"), "utf8"), "left\n");
  assert.equal(readFileSync(join(root, "right.txt"), "utf8"), "right\n");
  // And the branch that pointed into the rewritten range moved with it.
  assert.notEqual(repository.refs.read(`${BRANCH_PREFIX}left`), base);
});

test("the rewriting commands refuse a missing required option by name", async () => {
  // Each of these is the failure an agent hits first, so the message has to name the
  // flag rather than describing the operation.
  const { root, run } = await repoWithHistory();
  const head = logIds(root)[0]!;

  const rebase = await run("vcs rebase", ["main"]);
  assert.equal(rebase.handled, false);
  assert.match(String(rebase.errorMessage), /--onto/);

  const split = await run("vcs split", [head]);
  assert.equal(split.handled, false);
  assert.match(String(split.errorMessage), /at least one path/);

  // A blank path argument counts as absent rather than as a pattern matching nothing,
  // which is what an interpolated empty variable produces.
  const blank = await run("vcs split", [head, "   "]);
  assert.equal(blank.handled, false);
  assert.match(String(blank.errorMessage), /at least one path/);
});

test("log includes change ids only when asked", async () => {
  // The default output stays focused on what landed and when; a change id is a second
  // identifier per line and is noise until someone is rewriting.
  const { run } = await repoWithHistory();
  const plain = (await run("vcs log", [], { limit: "1" })).result as { commits: Array<Record<string, unknown>> };
  assert.equal("changeId" in plain.commits[0]!, false);
  const withIds = (await run("vcs log", [], { limit: "1", changeIds: true })).result as {
    commits: Array<{ changeId?: string }>;
  };
  assert.match(String(withIds.commits[0]!.changeId), /^[0-9a-f]{64}$/);
});
