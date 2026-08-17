import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import { VcsError } from "../git.ts";
import extension from "../index.ts";
import {
  commaSeparated,
  findRepositoryRoot,
  linkedFiles,
  openRepository,
  optionalString,
  pmClient,
  positiveInteger,
  signatureFor,
  sourceWorkingRoot,
} from "../vcs-commands.ts";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { CONTROL_DIRECTORY, Repository } from "../engine/repo.ts";
import { flattenTree } from "../engine/worktree.ts";
import type { RepositoryConfig } from "../engine/config.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import { packageRoot } from "./helpers/sandbox.ts";

const sandboxes: Array<{ root: string; cleanup(): void }> = [];

after(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

/** Capability list the harness accepts, derived from its own signature so a new capability surfaces automatically. */
type HarnessCapabilities = NonNullable<
  NonNullable<Parameters<typeof createExtensionTestHarness>[1]>["capabilities"]
>;

/** The shipped manifest's capabilities, read from disk so the harness activates exactly as at runtime. */
const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8")) as {
  capabilities: HarnessCapabilities;
};

/**
 * Activates the extension through the host's real loader.
 *
 * @returns The activated harness.
 */
function activate(): ReturnType<typeof createExtensionTestHarness> {
  return createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
}

/**
 * Creates a fresh directory the commands will treat as a repository root.
 *
 * @returns The directory and a cleanup handle.
 */
function freshRepoDir(): { root: string; cleanup(): void } {
  const handle = makeTempDir();
  sandboxes.push(handle);
  return handle;
}

/** Every command the package registers. A rejected registration drops later siblings, so the count matters. */
const COMMANDS = [
  "vcs init", "vcs status", "vcs add", "vcs commit", "vcs log", "vcs diff",
  "vcs branch", "vcs switch", "vcs merge", "vcs undo", "vcs oplog",
  "vcs export", "vcs import", "vcs tag", "vcs verify",
  "vcs remote", "vcs fetch", "vcs push", "vcs clone",
  "vcs describe", "vcs rebase", "vcs squash", "vcs split",
  "vcs cherry-pick", "vcs revert", "vcs reset", "vcs restore", "vcs show",
  "vcs trace", "vcs items", "vcs files", "vcs changes",
  "vcs instance", "vcs view", "vcs scan",
  "vcs git preflight", "vcs git preview", "vcs git items",
];

test("activation registers all 38 commands with no sibling dropped", async () => {
  const harness = await activate();
  // A registration rejected by the loader aborts at that command and silently
  // drops every later sibling, so asserting each one's contract is the invariant.
  for (const command of COMMANDS) {
    harness.assertCommandContract({ command });
  }
  assert.equal(COMMANDS.length, 38);
});

test("native commands validate PM associations and resolve linked file changes", async () => {
  const harness = await activate();
  const { root } = freshRepoDir();
  const client = new PmClient({ pmRoot: root, cwd: root, noExtensions: true });
  await client.init("test", { defaults: true, author: "test" });
  const created = await client.create({ type: "Task", title: "Track arbitrary asset", author: "test" });
  const item = created.item.id;
  await client.files(item, { add: ["asset.bin"], author: "test" });
  const emptyItem = (await client.create({ type: "Task", title: "No linked files", author: "test" })).item.id;
  const missingItem = (await client.create({ type: "Task", title: "Future asset", author: "test" })).item.id;
  await client.files(missingItem, { add: ["future.bin"], author: "test" });

  await harness.runCommand({ command: "vcs init", pmRoot: root });
  writeFileSync(join(root, "asset.bin"), "binary-ish\0content");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  const committed = await harness.runCommand({ command: "vcs commit", options: { message: "asset", item }, global: { author: "A <a@b>" }, pmRoot: root });
  assert.equal(committed.errorMessage, undefined, String(committed.errorMessage));
  assert.deepEqual((committed.result as { items: string[] }).items, [item]);
  writeFileSync(join(root, "asset.bin"), "binary-ish\0content-v2");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  const edited = await harness.runCommand({ command: "vcs commit", options: { message: "asset edit" }, global: { author: "A <a@b>" }, pmRoot: root });

  const files = await harness.runCommand({ command: "vcs files", args: [item], pmRoot: root });
  const linked = (files.result as { files: Array<{ fileId: string; changes: unknown[] }> }).files[0];
  assert.match(linked?.fileId ?? "", /^[0-9a-f]{32}$/);
  assert.equal(linked?.changes.length, 2);
  const changes = await harness.runCommand({ command: "vcs changes", args: [item], pmRoot: root });
  assert.equal((changes.result as { changes: string[] }).changes.length, 2);
  const emptyFiles = await harness.runCommand({ command: "vcs files", args: [emptyItem], pmRoot: root });
  assert.deepEqual((emptyFiles.result as { files: unknown[] }).files, []);
  const emptyChanges = await harness.runCommand({ command: "vcs changes", args: [emptyItem], pmRoot: root });
  assert.deepEqual((emptyChanges.result as { changes: unknown[] }).changes, []);
  const missingFiles = await harness.runCommand({ command: "vcs files", args: [missingItem], pmRoot: root });
  assert.deepEqual((missingFiles.result as { files: unknown[] }).files, [{ path: "future.bin", fileId: null, changes: [] }]);
  const traced = await harness.runCommand({ command: "vcs trace", args: [linked!.fileId], pmRoot: root });
  assert.equal((traced.result as { changes: unknown[] }).changes.length, 2);
  const allItems = await harness.runCommand({ command: "vcs items", pmRoot: root });
  assert.deepEqual((allItems.result as { items: string[] }).items, [item]);
  const rangeItems = await harness.runCommand({
    command: "vcs items",
    args: [`${(committed.result as { commit: string }).commit}..${(edited.result as { commit: string }).commit}`],
    pmRoot: root,
  });
  assert.deepEqual((rangeItems.result as { items: string[] }).items, [item]);
  assert.equal((rangeItems.result as { commits: string[] }).commits.length, 1);
  const invalidRange = await harness.runCommand({ command: "vcs items", args: ["HEAD"], pmRoot: root });
  assert.equal(invalidRange.handled, false);
  assert.match(String(invalidRange.errorMessage), /invalid/);

  const missing = await harness.runCommand({ command: "vcs trace", args: ["missing.bin"], pmRoot: root });
  assert.equal(missing.handled, false);
  assert.match(String(missing.errorMessage), /No identity is recorded/);

  rmSync(join(root, "asset.bin"));
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "remove old occupant" }, global: { author: "A <a@b>" }, pmRoot: root });
  writeFileSync(join(root, "asset.bin"), "unrelated replacement");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "reuse path" }, global: { author: "A <a@b>" }, pmRoot: root });
  const reusedFiles = await harness.runCommand({ command: "vcs files", args: [item], pmRoot: root });
  const currentOccupant = (reusedFiles.result as { files: Array<{ fileId: string; changes: unknown[] }> }).files[0];
  assert.notEqual(currentOccupant?.fileId, linked?.fileId);
  assert.equal(currentOccupant?.changes.length, 1);
  const reusedChanges = await harness.runCommand({ command: "vcs changes", args: [item], pmRoot: root });
  assert.equal((reusedChanges.result as { changes: string[] }).changes.length, 2);
});

test("pmClient prefers the invocation's host-bound SDK client", () => {
  const { root } = freshRepoDir();
  const client = new PmClient({ pmRoot: root, cwd: root, noExtensions: true });
  const context = {
    command: "vcs files",
    args: [],
    options: {},
    global: {},
    pm_root: root,
    sdk: { client } as CommandHandlerContext["sdk"],
  };
  assert.equal(pmClient(context), client);
});

test("pmClient builds a tracker-bound fallback for legacy host contexts", async () => {
  const { root } = freshRepoDir();
  const tracker = join(root, ".agents", "pm");
  const client = pmClient({
    command: "vcs files",
    args: [],
    options: {},
    global: {},
    pm_root: tracker,
    repo_root: root,
  });

  await client.init("fallback");
  const listed = await client.list({ limit: "1" });
  assert.ok("items" in listed);
  assert.deepEqual(listed.items, []);
});

test("linkedFiles normalizes omitted SDK linked projections", () => {
  // The SDK projection contract retains the canonical item `id` on every
  // depth and field projection, so a fabricated result carries it even when
  // the linked-artifact group is the part under test.
  const item = { id: "linked-files-item" };
  assert.deepEqual(linkedFiles({ item }), []);
  assert.deepEqual(linkedFiles({ item, linked: { files: [], tests: [], docs: [] } }), []);
});

test("findRepositoryRoot walks up to a control directory and returns null past the root", () => {
  const { root } = freshRepoDir();
  // No repository yet: nothing found.
  assert.equal(findRepositoryRoot(root), null);
  Repository.init(root);
  // Found at the root, and from a nested subdirectory by walking up.
  assert.equal(findRepositoryRoot(root), root);
  assert.equal(findRepositoryRoot(join(root, "deep", "nested")), root);
});

test("openRepository throws a remediation when no repository contains the directory", async () => {
  const { root } = freshRepoDir();
  assert.throws(
    () => openRepository({ command: "vcs status", args: [], options: {}, global: {}, pm_root: root }),
    (error: unknown) => error instanceof VcsError && error.code === "no_repository",
  );
});

test("source working roots prefer a repository, then the portable workspace, then the tracker", () => {
  const base = { command: "vcs init", args: [], options: {}, global: {}, pm_root: "/tracker" };
  assert.equal(sourceWorkingRoot(base), "/tracker");
  assert.equal(sourceWorkingRoot({ ...base, source_workspace_root: "/workspace" }), "/workspace");
  assert.equal(
    sourceWorkingRoot({ ...base, source_workspace_root: "/workspace", repo_root: "/repository" }),
    "/repository",
  );
});

test("option helpers treat blank and non-string values as absent", () => {
  assert.equal(optionalString({ x: "v" }, "x"), "v");
  assert.equal(optionalString({ x: "  " }, "x"), undefined);
  assert.equal(optionalString({ x: 1 }, "x"), undefined);
  assert.equal(optionalString(undefined, "x"), undefined);

  assert.equal(positiveInteger({ limit: "5" }, "limit", 20), 5);
  assert.equal(positiveInteger(undefined, "limit", 20), 20);
  assert.throws(
    () => positiveInteger({ limit: "0" }, "limit", 20),
    (error: unknown) => error instanceof VcsError && error.code === "invalid_option",
  );

  assert.deepEqual(commaSeparated({ ref: "a, b ,c" }, "ref"), ["a", "b", "c"]);
  assert.deepEqual(commaSeparated(undefined, "ref"), []);
});

test("signatureFor parses a Name <email> author and synthesises one when absent", () => {
  const now = new Date("2024-06-01T12:00:00Z");
  const withEmail = signatureFor({ command: "vcs commit", args: [], options: {}, global: { author: "Ada Lovelace <ada@analytical.invalid>" }, pm_root: "" }, now);
  assert.equal(withEmail.name, "Ada Lovelace");
  assert.equal(withEmail.email, "ada@analytical.invalid");

  const bare = signatureFor({ command: "vcs commit", args: [], options: {}, global: { author: "just-a-name" }, pm_root: "" }, now);
  assert.equal(bare.name, "just-a-name");
  assert.match(bare.email, /@pm-vcs\.local$/);

  const none = signatureFor({ command: "vcs commit", args: [], options: {}, global: {}, pm_root: "" }, now);
  assert.equal(none.name, "pm-vcs");
});

test("a full repository workflow runs end to end through the host", async () => {
  const harness = await activate();
  const { root } = freshRepoDir();

  // init
  const init = await harness.runCommand({ command: "vcs init", options: { branch: "main", recordPath: "items/*.toon" }, pmRoot: root });
  assert.equal(init.handled, true);
  assert.equal(Object.hasOwn(init.result as object, "exit_code"), false, "successful payloads omit the host-reserved non-zero exit code");
  assert.equal((init.result as { repository: { branch: string } }).repository.branch, "main");

  // add + commit
  writeFileSync(join(root, "readme.md"), "hello\n");
  await harness.runCommand({ command: "vcs add", args: ["readme.md"], pmRoot: root });
  const commit = await harness.runCommand({ command: "vcs commit", options: { message: "first" }, global: { author: "A <a@b>" }, pmRoot: root });
  assert.equal(commit.handled, true);
  const commitId = (commit.result as { commit: string }).commit;
  assert.ok(commitId.length === 64);

  // status reports clean after committing everything
  const status = await harness.runCommand({ command: "vcs status", pmRoot: root });
  assert.equal((status.result as { status: { clean: boolean } }).status.clean, true);

  // log reports the commit
  const log = await harness.runCommand({ command: "vcs log", pmRoot: root });
  assert.equal((log.result as { commits: unknown[] }).commits.length, 1);

  // diff between an explicit from and HEAD
  const diff = await harness.runCommand({ command: "vcs diff", args: [commitId, "HEAD"], pmRoot: root });
  assert.equal((diff.result as { diff: string }).diff, "");

  // branch create + switch + merge (fast-forward back)
  await harness.runCommand({ command: "vcs branch", args: ["feature"], pmRoot: root });
  writeFileSync(join(root, "readme.md"), "hello again\n");
  await harness.runCommand({ command: "vcs add", args: ["readme.md"], pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "second" }, global: { author: "A <a@b>" }, pmRoot: root });
  await harness.runCommand({ command: "vcs switch", args: ["feature"], pmRoot: root });
  const merge = await harness.runCommand({ command: "vcs merge", args: ["main"], options: { message: "ff" }, global: { author: "A <a@b>" }, pmRoot: root });
  assert.equal((merge.result as { merge: { kind: string } }).merge.kind, "fast_forward");

  // undo restores the ref
  await harness.runCommand({ command: "vcs undo", pmRoot: root });

  // oplog lists the recorded operations
  const oplog = await harness.runCommand({ command: "vcs oplog", pmRoot: root });
  assert.ok((oplog.result as { operations: unknown[] }).operations.length > 0);

  // tag create + list
  await harness.runCommand({ command: "vcs tag", args: ["v1"], pmRoot: root });
  const tags = await harness.runCommand({ command: "vcs tag", pmRoot: root });
  assert.equal((tags.result as { tags: { name: string }[] }).tags.length, 1);

  // verify reports every reachable object intact
  const verify = await harness.runCommand({ command: "vcs verify", pmRoot: root });
  assert.ok((verify.result as { verified: number }).verified > 0);

  // branch list
  const branches = await harness.runCommand({ command: "vcs branch", pmRoot: root });
  assert.ok((branches.result as { branches: { name: string }[] }).branches.length >= 1);
});

test("vcs diff reads a single argument as the left side, matching its declared arguments", async () => {
  const harness = await activate();
  const { root } = freshRepoDir();
  await harness.runCommand({ command: "vcs init", pmRoot: root });
  writeFileSync(join(root, "a.txt"), "one\n");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  const first = await harness.runCommand({ command: "vcs commit", options: { message: "first" }, global: { author: "A <a@b>" }, pmRoot: root });
  const firstId = (first.result as { commit: string }).commit;
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "second" }, global: { author: "A <a@b>" }, pmRoot: root });

  // The command declares `[from] [to]`, so one argument is the LEFT side and the
  // right defaults to HEAD. `vcs diff HEAD` therefore compares HEAD with itself
  // and is empty; `vcs diff <first>` is the form that shows the change.
  const headWithItself = await harness.runCommand({ command: "vcs diff", args: ["HEAD"], pmRoot: root });
  assert.equal((headWithItself.result as { diff: string }).diff, "");
  const fromFirst = await harness.runCommand({ command: "vcs diff", args: [firstId], pmRoot: root });
  assert.match((fromFirst.result as { diff: string }).diff, /\+two/);
  // With no arguments at all the left side falls back to HEAD's first parent.
  const implicit = await harness.runCommand({ command: "vcs diff", pmRoot: root });
  assert.match((implicit.result as { diff: string }).diff, /\+two/);
  // Two-arg form with the same revision on both sides is empty.
  const same = await harness.runCommand({ command: "vcs diff", args: [firstId, firstId], pmRoot: root });
  assert.equal((same.result as { diff: string }).diff, "");
});

test("export then import reproduces history through the host", async () => {
  const harness = await activate();
  const source = freshRepoDir();
  const target = freshRepoDir();
  await harness.runCommand({ command: "vcs init", pmRoot: source.root });
  writeFileSync(join(source.root, "a.txt"), "a\n");
  await harness.runCommand({ command: "vcs add", pmRoot: source.root });
  const commit = await harness.runCommand({ command: "vcs commit", options: { message: "first" }, global: { author: "A <a@b>" }, pmRoot: source.root });
  const sourceId = (commit.result as { commit: string }).commit;

  const bundlePath = join(source.root, "out.bundle");
  const exported = await harness.runCommand({ command: "vcs export", args: [bundlePath], pmRoot: source.root });
  assert.ok((exported.result as { bundle: { bytes: number } }).bundle.bytes > 0);

  await harness.runCommand({ command: "vcs init", pmRoot: target.root });
  const imported = await harness.runCommand({ command: "vcs import", args: [bundlePath], pmRoot: target.root });
  assert.equal((imported.result as { import: { refs: Record<string, string> } }).import.refs["refs/heads/main"], sourceId);
});

test("required arguments are refused with a remediation, and invalid options report invalid_option", async () => {
  const harness = await activate();
  const { root } = freshRepoDir();
  await harness.runCommand({ command: "vcs init", pmRoot: root });

  // switch with no argument.
  const noSwitchArg = await harness.runCommand({ command: "vcs switch", pmRoot: root });
  assert.ok(noSwitchArg.errorMessage !== undefined || noSwitchArg.handled === false);

  // merge with no argument.
  const noMergeArg = await harness.runCommand({ command: "vcs merge", pmRoot: root });
  assert.ok(noMergeArg.errorMessage !== undefined || noMergeArg.handled === false);

  // commit with no message.
  const noMessage = await harness.runCommand({ command: "vcs commit", pmRoot: root });
  assert.ok(noMessage.errorMessage !== undefined || noMessage.handled === false);

  // log with a non-positive limit. This one asserts the code as well as the
  // failure: "it failed" would still pass if the limit were rejected for the wrong
  // reason, or if the command failed before ever parsing it.
  const badLimit = await harness.runCommand({ command: "vcs log", options: { limit: "0" }, pmRoot: root });
  assert.equal(badLimit.handled, false);
  assert.match(String(badLimit.errorMessage), /--limit/);

  // export and import with no file argument.
  const noExport = await harness.runCommand({ command: "vcs export", pmRoot: root });
  assert.ok(noExport.errorMessage !== undefined || noExport.handled === false);
  const noImport = await harness.runCommand({ command: "vcs import", pmRoot: root });
  assert.ok(noImport.errorMessage !== undefined || noImport.handled === false);
});

test("vcs init accepts a valid --set-field and --record-path", async () => {
  const harness = await activate();
  const { root } = freshRepoDir();
  const result = await harness.runCommand({
    command: "vcs init",
    options: { recordPath: "items/*.toon", setField: "priority:scalar,tags:set" },
    pmRoot: root,
  });
  assert.equal(result.handled, true);
  const config = (result.result as { repository: { config: RepositoryConfig } }).repository.config;
  assert.equal(config.recordPolicy.fields?.priority, "scalar");
  assert.equal(config.recordPolicy.fields?.tags, "set");
});

test("vcs init refuses an invalid --set-field strategy", async () => {
  const harness = await activate();
  const { root } = freshRepoDir();
  const result = await harness.runCommand({ command: "vcs init", options: { setField: "priority:rocket" }, pmRoot: root });
  assert.ok(result.errorMessage !== undefined || result.handled === false);
});

test("vcs init refuses a --set-field entry that names no field", async () => {
  // ":set" parses as a valid strategy with an empty field name, which would install
  // a policy keyed on "" that no record field can ever match — a silently inert
  // configuration is worse than a rejected one, because it looks applied.
  const harness = await activate();
  const { root } = freshRepoDir();
  const result = await harness.runCommand({ command: "vcs init", options: { setField: ":set" }, pmRoot: root });
  assert.equal(result.handled, false);
  assert.match(String(result.errorMessage), /names no field/);
});

test("vcs merge --fail-on-conflict exits non-zero on a conflicted merge", async () => {
  const harness = await activate();
  const { root } = freshRepoDir();
  await harness.runCommand({ command: "vcs init", pmRoot: root });
  writeFileSync(join(root, "a.txt"), "base\n");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "base" }, global: { author: "A <a@b>" }, pmRoot: root });
  await harness.runCommand({ command: "vcs branch", args: ["feature"], pmRoot: root });
  await harness.runCommand({ command: "vcs switch", args: ["feature"], pmRoot: root });
  writeFileSync(join(root, "a.txt"), "feature\n");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "feature" }, global: { author: "A <a@b>" }, pmRoot: root });
  await harness.runCommand({ command: "vcs switch", args: ["main"], pmRoot: root });
  writeFileSync(join(root, "a.txt"), "main\n");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "main" }, global: { author: "A <a@b>" }, pmRoot: root });

  const gated = await harness.runCommand({ command: "vcs merge", args: ["feature"], options: { failOnConflict: true }, pmRoot: root });
  assert.ok(gated.errorMessage !== undefined || gated.handled === false);
});

test("vcs delete branch works and refuses the checked-out branch", async () => {
  const harness = await activate();
  const { root } = freshRepoDir();
  await harness.runCommand({ command: "vcs init", pmRoot: root });
  writeFileSync(join(root, "a.txt"), "a\n");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "first" }, global: { author: "A <a@b>" }, pmRoot: root });
  await harness.runCommand({ command: "vcs branch", args: ["feature"], pmRoot: root });
  const deleted = await harness.runCommand({ command: "vcs branch", args: ["feature"], options: { delete: true }, pmRoot: root });
  assert.equal((deleted.result as { deleted: string }).deleted, "feature");

  // Deleting the branch HEAD is on is refused.
  const refuse = await harness.runCommand({ command: "vcs branch", args: ["main"], options: { delete: true }, pmRoot: root });
  assert.ok(refuse.errorMessage !== undefined || refuse.handled === false);
});

test("vcs undo --operation reverses a specific earlier operation", async () => {
  const harness = await activate();
  const { root } = freshRepoDir();
  await harness.runCommand({ command: "vcs init", pmRoot: root });
  writeFileSync(join(root, "a.txt"), "a\n");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "first" }, global: { author: "A <a@b>" }, pmRoot: root });
  writeFileSync(join(root, "a.txt"), "ab\n");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "second" }, global: { author: "A <a@b>" }, pmRoot: root });

  // Reverse operation 2 (the second commit): the file reverts to "a".
  const undone = await harness.runCommand({ command: "vcs undo", options: { operation: "2" }, pmRoot: root });
  assert.equal(undone.handled, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
});

test("vcs verify reports corruption when an object is tampered with", async () => {
  const harness = await activate();
  const { root } = freshRepoDir();
  await harness.runCommand({ command: "vcs init", pmRoot: root });
  writeFileSync(join(root, "a.txt"), "a\n");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "first" }, global: { author: "A <a@b>" }, pmRoot: root });

  // Tamper with the only reachable blob on disk.
  const repo = Repository.open(root);
  const flat = flattenTree(repo.objects, repo.headTree());
  const target = [...flat.values()][0].id;
  const objectPath = join(root, ".pmvcs", "objects", target.slice(0, 2), target.slice(2));
  const original = readFileSync(objectPath);
  original[original.length - 1] ^= 0xff;
  writeFileSync(objectPath, original);

  const verify = await harness.runCommand({ command: "vcs verify", pmRoot: root });
  assert.ok(verify.errorMessage !== undefined || verify.handled === false);
});
