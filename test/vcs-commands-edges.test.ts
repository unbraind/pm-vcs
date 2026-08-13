// Command-surface behaviour at the edges of each handler.
//
// The main command test drives the happy path end to end. These cover the
// branches that only a less usual invocation reaches — a detached HEAD, an
// explicit revision where the handler has a default, a message that already ends
// in a newline, a malformed option. Each is a state a real caller can produce,
// and each one is a branch that would otherwise never execute in the suite.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";
import { CONTROL_DIRECTORY, Repository } from "../engine/repo.ts";
import { BRANCH_PREFIX, TAG_PREFIX } from "../engine/refs.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import { packageRoot } from "./helpers/sandbox.ts";

const sandboxes: Array<{ root: string; cleanup(): void }> = [];

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

/** Author the host would supply through its invocation-wide `--author`. */
const AUTHOR = "Edge Tester <edge@pm-vcs.invalid>";

/**
 * Creates a repository with one commit and returns a bound command runner.
 *
 * @returns The repository root and a `run` bound to the activated harness.
 */
async function repoWithCommit(): Promise<{
  root: string;
  run: (command: string, args?: string[], options?: Record<string, unknown>) => Promise<{
    handled: boolean;
    result: unknown;
    errorMessage?: string;
  }>;
}> {
  const handle = makeTempDir();
  sandboxes.push(handle);
  const root = handle.root;
  Repository.init(root);
  const harness = await createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
  const run = async (
    command: string,
    args: string[] = [],
    options: Record<string, unknown> = {},
  ): Promise<{ handled: boolean; result: unknown; errorMessage?: string }> => (
    await harness.runCommand({ command, args, options, global: { author: AUTHOR }, pmRoot: root })
  ) as { handled: boolean; result: unknown; errorMessage?: string };

  writeFileSync(join(root, "a.txt"), "one\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "first" });
  return { root, run };
}

test("a non-numeric --limit is refused, with the flag named as the caller typed it", async () => {
  // The handler receives the option camel-cased, so the error has to convert it
  // back: telling someone their `failOn` is invalid when they typed `--fail-on`
  // sends them looking for a flag that does not exist.
  const { run } = await repoWithCommit();
  const result = await run("vcs log", [], { limit: "not-a-number" });
  assert.equal(result.handled, false);
  assert.match(String(result.errorMessage), /--limit must be a positive integer, not "not-a-number"/);
});

test("a --set-field entry with no strategy separator is refused", async () => {
  const handle = makeTempDir();
  sandboxes.push(handle);
  const harness = await createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
  const result = await harness.runCommand({
    command: "vcs init",
    args: [],
    options: { setField: "tags" },
    global: {},
    pmRoot: handle.root,
  }) as { handled: boolean; errorMessage?: string };
  assert.equal(result.handled, false);
  assert.match(String(result.errorMessage), /does not name a strategy/);
});

test("status and branch report a null branch when HEAD is detached", async () => {
  // Detached HEAD is a real state — `vcs switch <commit>` produces it — and both
  // commands have to say so rather than inventing a branch name.
  const { root, run } = await repoWithCommit();
  const head = Repository.open(root).refs.resolveHead() as string;
  await run("vcs switch", [head]);

  const status = await run("vcs status");
  assert.equal((status.result as { branch: string | null }).branch, null);
  assert.equal((status.result as { head: string }).head, head);

  const branches = await run("vcs branch");
  const listed = (branches.result as { branches: Array<{ name: string; current: boolean }> }).branches;
  // No branch is current while HEAD is detached, though main still exists.
  assert.ok(listed.some((entry) => entry.name === "main"));
  assert.ok(listed.every((entry) => entry.current === false));
});

test("a message that already ends in a newline is not given a second one", async () => {
  // The handler appends a terminator so a commit body is well-formed. Appending
  // unconditionally would add a blank line to every message written by a tool
  // that already terminates its output.
  const { root, run } = await repoWithCommit();
  writeFileSync(join(root, "a.txt"), "two\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "already terminated\n" });
  const log = await run("vcs log", [], { limit: "1" });
  const [entry] = (log.result as { commits: Array<{ message: string }> }).commits;
  assert.equal(entry.message, "already terminated");
  assert.equal(Repository.open(root).log("HEAD", 1)[0].commit.message, "already terminated\n");
});

test("log accepts an explicit revision instead of defaulting to HEAD", async () => {
  const { root, run } = await repoWithCommit();
  const first = Repository.open(root).refs.resolveHead() as string;
  writeFileSync(join(root, "a.txt"), "two\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "second" });

  const fromFirst = await run("vcs log", [first]);
  const commits = (fromFirst.result as { commits: Array<{ id: string }> }).commits;
  // Walking from the first commit sees only it, not the newer tip.
  assert.equal(commits.length, 1);
  assert.equal(commits[0].id, first);
});

test("diff defaults to HEAD against its parent, and takes two explicit revisions", async () => {
  const { root, run } = await repoWithCommit();

  // Only one commit exists, so HEAD has no first parent. The from-revision falls
  // back to HEAD itself and the diff is empty, rather than throwing on a parent
  // that is not there.
  assert.equal(((await run("vcs diff")).result as { diff: string }).diff, "");

  writeFileSync(join(root, "a.txt"), "two\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "second" });

  // Default: HEAD's first parent against HEAD.
  assert.match(((await run("vcs diff")).result as { diff: string }).diff, /-one\n\+two/);

  // One explicit revision is the LEFT side, matching the declared `[from] [to]`,
  // so it means "that revision against HEAD".
  const first = Repository.open(root).log("HEAD", 2)[1].id;
  assert.match(((await run("vcs diff", [first])).result as { diff: string }).diff, /-one\n\+two/);

  // Two explicit revisions, reversed, invert the diff.
  const reversed = await run("vcs diff", ["HEAD", first]);
  assert.match((reversed.result as { diff: string }).diff, /-two\n\+one/);
});

test("merge reports a content conflict by path when there are no field names to name", async () => {
  // A record conflict names the fields that disagreed; a plain text conflict has
  // none, so the gate message has to fall back to the path alone.
  const { root, run } = await repoWithCommit();
  await run("vcs branch", ["other"]);
  await run("vcs switch", ["other"]);
  writeFileSync(join(root, "a.txt"), "theirs\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "theirs" });
  await run("vcs switch", ["main"]);
  writeFileSync(join(root, "a.txt"), "ours\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "ours" });

  const conflicted = await run("vcs merge", ["other"], { message: "merge\n", failOnConflict: true });
  assert.equal(conflicted.handled, false);
  // The path appears without a parenthesised field list.
  assert.match(String(conflicted.errorMessage), /a\.txt/);
  assert.doesNotMatch(String(conflicted.errorMessage), /a\.txt \(/);
});

test("export --since resolves each boundary revision and records it as a prerequisite", async () => {
  const { root, run } = await repoWithCommit();
  const first = Repository.open(root).refs.resolveHead() as string;
  writeFileSync(join(root, "a.txt"), "two\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "second" });

  // A boundary that names nothing is rejected by resolve rather than silently
  // dropped, because a bundle that quietly omits its prerequisites imports as
  // history whose parents are missing.
  const bogus = await run("vcs export", [join(root, "x.bundle")], { since: "no-such-revision" });
  assert.equal(bogus.handled, false);
  assert.match(String(bogus.errorMessage), /not a known commit, branch, tag or remote-tracking branch/);

  const file = join(root, "incremental.bundle");
  const ok = await run("vcs export", [file], { since: first });
  assert.equal(ok.handled, true);
  const bundle = readFileSync(file, "utf8");
  assert.ok(bundle.startsWith("pmvcs-bundle-1"));
  // The boundary is named as a prerequisite, so an importer lacking it fails loudly.
  assert.match(bundle.split("\n")[1], new RegExp(first));
});

test("verify names the failure code for every object that will not read back", async () => {
  const { root, run } = await repoWithCommit();
  const blobId = Repository.open(root).readIndex()[0].id;
  // Overwrite the stored object with bytes that are not a valid zlib stream. The
  // store catches this on read because it inflates and re-hashes rather than
  // trusting the filename — which is the one guarantee a content-addressed store
  // must not quietly lose.
  writeFileSync(join(root, CONTROL_DIRECTORY, "objects", blobId.slice(0, 2), blobId.slice(2)), "not zlib at all");

  const result = await run("vcs verify");
  assert.equal(result.handled, false);
  assert.match(String(result.errorMessage), /did not verify/);
  assert.match(String(result.errorMessage), new RegExp(`${blobId}: corrupt_object`));
});

test("verify re-raises an I/O failure instead of reporting the repository corrupt", async () => {
  const { root, run } = await repoWithCommit();
  const blobId = Repository.open(root).readIndex()[0].id;
  // Replace the blob's file with a directory. Reading it fails with EISDIR, which
  // says the *store* is unreadable, not that history lost content — the two call
  // for opposite responses (fix the machine vs. re-fetch the objects), so verify
  // must not fold this into its corruption tally. A blob is the right object to
  // break: the ref walk reads commits and trees itself, so breaking one of those
  // would fail before reaching the handler's own read.
  const objectPath = join(root, CONTROL_DIRECTORY, "objects", blobId.slice(0, 2), blobId.slice(2));
  rmSync(objectPath);
  mkdirSync(objectPath);

  const result = await run("vcs verify");
  assert.equal(result.handled, false);
  // An errno, not a VcsError: the failure is surfaced as what it is.
  assert.doesNotMatch(String(result.errorMessage), /did not verify/);
  assert.match(String(result.errorMessage), /EISDIR/);
});

test("switching to a tag still works when a corrupt branch file shares its name", async () => {
  // `switchTo` asks whether a branch of that name exists so it can decide between
  // attaching HEAD and detaching it. That lookup can throw — a ref file holding
  // something that is not an object id is a corrupt_ref — and a corrupt branch
  // must not prevent switching to the tag the caller actually named.
  const { root, run } = await repoWithCommit();
  const repository = Repository.open(root);
  const head = repository.refs.resolveHead() as string;
  repository.refs.compareAndSwap(`${TAG_PREFIX}v1`, null, head);
  writeFileSync(join(root, CONTROL_DIRECTORY, ...`${BRANCH_PREFIX}v1`.split("/")), "not-an-object-id\n");

  const switched = await run("vcs switch", ["v1"]);
  assert.equal(switched.handled, true);
  assert.equal((switched.result as { head: string }).head, head);
  // HEAD detached rather than attaching to the corrupt branch.
  assert.equal(Repository.open(root).refs.readHead().kind, "detached");
});

test("a record conflict names the fields that disagreed, not just the path", async () => {
  // The gate message has two shapes. A text conflict can only name a path; a
  // record conflict knows exactly which fields disagreed, and saying so is the
  // difference between "resolve this file" and "these two values disagree".
  const handle = makeTempDir();
  sandboxes.push(handle);
  const root = handle.root;
  Repository.init(root, "main", { recordPaths: ["*.rec"], recordPolicy: { fields: {} } });
  const harness = await createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
  const run = async (command: string, args: string[] = [], options: Record<string, unknown> = {}) => (
    await harness.runCommand({ command, args, options, global: { author: AUTHOR }, pmRoot: root })
  ) as { handled: boolean; result: unknown; errorMessage?: string };

  writeFileSync(join(root, "item.rec"), JSON.stringify({ id: "x", status: "open", owner: "nobody" }));
  await run("vcs add");
  await run("vcs commit", [], { message: "base" });

  await run("vcs branch", ["side"]);
  await run("vcs switch", ["side"]);
  writeFileSync(join(root, "item.rec"), JSON.stringify({ id: "x", status: "closed", owner: "nobody" }));
  await run("vcs add");
  await run("vcs commit", [], { message: "side closes it" });

  await run("vcs switch", ["main"]);
  writeFileSync(join(root, "item.rec"), JSON.stringify({ id: "x", status: "blocked", owner: "someone" }));
  await run("vcs add");
  await run("vcs commit", [], { message: "main blocks it" });

  // No trailing newline on the merge message: the handler supplies one.
  const merged = await run("vcs merge", ["side"], { message: "merge side", failOnConflict: true });
  assert.equal(merged.handled, false);
  // `status` disagreed; `owner` did not and merged silently.
  assert.match(String(merged.errorMessage), /item\.rec \(status\)/);

  const resolved = JSON.parse(readFileSync(join(root, "item.rec"), "utf8")) as Record<string, string>;
  assert.equal(resolved.owner, "someone", "the field that did not conflict still merged");
});

/**
 * Stands up a repository with a content conflict in a.txt and returns a bound
 * command runner. Used by the `--continue` / `--abort` command-surface tests.
 *
 * @returns The repository root and a `run` bound to the activated harness.
 */
async function conflictedHarness(): Promise<{
  root: string;
  run: (command: string, args?: string[], options?: Record<string, unknown>) => Promise<{
    handled: boolean;
    result: unknown;
    errorMessage?: string;
  }>;
}> {
  const handle = makeTempDir();
  sandboxes.push(handle);
  const root = handle.root;
  Repository.init(root);
  const harness = await createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
  const run = async (command: string, args: string[] = [], options: Record<string, unknown> = {}) => (
    await harness.runCommand({ command, args, options, global: { author: AUTHOR }, pmRoot: root })
  ) as { handled: boolean; result: unknown; errorMessage?: string };
  writeFileSync(join(root, "a.txt"), "base\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "base" });
  await run("vcs branch", ["side"]);
  await run("vcs switch", ["side"]);
  writeFileSync(join(root, "a.txt"), "side\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "side" });
  await run("vcs switch", ["main"]);
  writeFileSync(join(root, "a.txt"), "main\n");
  await run("vcs add");
  await run("vcs commit", [], { message: "main" });
  return { root, run };
}

test("vcs merge --continue completes a stopped merge through the command surface", async () => {
  const { root, run } = await conflictedHarness();
  const stopped = await run("vcs merge", ["side"], { message: "merge side" });
  assert.equal((stopped.result as { merge: { kind: string } }).merge.kind, "conflicted");
  assert.match(readFileSync(join(root, "a.txt"), "utf8"), /<<<<<<< ours/);

  // Resolve and stage, then complete the merge through --continue.
  writeFileSync(join(root, "a.txt"), "resolved\n");
  await run("vcs add");
  const completed = await run("vcs merge", [], { continue: true });
  assert.equal(completed.handled, true);
  assert.equal((completed.result as { merge: { kind: string; clean: boolean } }).merge.kind, "merged");
  assert.equal((completed.result as { merge: { clean: boolean } }).merge.clean, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "resolved\n");
  // No merge state remains.
  assert.equal(Repository.open(root).readMergeState(), null);
});

test("vcs merge --continue refuses through the command surface while markers remain", async () => {
  const { run } = await conflictedHarness();
  await run("vcs merge", ["side"], { message: "merge side" });
  // Resolve nothing.
  const refused = await run("vcs merge", [], { continue: true });
  assert.equal(refused.handled, false);
  assert.match(String(refused.errorMessage), /still contain conflict markers/);
});

test("vcs merge --abort abandons a stopped merge through the command surface", async () => {
  const { root, run } = await conflictedHarness();
  const before = Repository.open(root).refs.resolveHead() as string;
  await run("vcs merge", ["side"], { message: "merge side" });
  assert.match(readFileSync(join(root, "a.txt"), "utf8"), /<<<<<<< ours/);

  const aborted = await run("vcs merge", [], { abort: true });
  assert.equal(aborted.handled, true);
  assert.equal((aborted.result as { aborted: { revision: string } }).aborted.revision, "side");
  // Working tree restored to the pre-merge main commit; no merge state remains.
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "main\n");
  assert.equal(Repository.open(root).refs.resolveHead(), before);
  assert.equal(Repository.open(root).readMergeState(), null);
});

test("vcs merge --continue and --abort refuse when no merge is in progress", async () => {
  const { run } = await conflictedHarness();
  const cont = await run("vcs merge", [], { continue: true });
  assert.equal(cont.handled, false);
  assert.match(String(cont.errorMessage), /no merge in progress/);
  const ab = await run("vcs merge", [], { abort: true });
  assert.equal(ab.handled, false);
  assert.match(String(ab.errorMessage), /no merge in progress/);
});

test("vcs merge refuses --continue and --abort passed together", async () => {
  // Finding 3: --abort is checked before --continue, so passing both used to
  // silently abort — restoring the pre-merge working tree and discarding the
  // resolutions the caller staged for the continue. That is data loss from a
  // flag combination plausibly typed by mistake, so the combination is rejected
  // before either branch runs, with an error naming both flags.
  const { root, run } = await conflictedHarness();
  // Start a merge and stage a resolution, so a silent abort would lose it.
  await run("vcs merge", ["side"], { message: "merge side" });
  writeFileSync(join(root, "a.txt"), "resolved\n");
  await run("vcs add");

  const refused = await run("vcs merge", [], { continue: true, abort: true });
  assert.equal(refused.handled, false);
  assert.match(String(refused.errorMessage), /cannot combine --continue and --abort/);
  // The merge is still in progress and the staged resolution is intact, proving
  // neither branch ran.
  assert.ok(Repository.open(root).readMergeState() !== null);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "resolved\n");
});
