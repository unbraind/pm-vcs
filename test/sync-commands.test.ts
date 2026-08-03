import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { after, test } from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";
import type { Remote } from "../engine/remotes.ts";
import { trackingRef } from "../engine/remotes.ts";
import { BRANCH_PREFIX } from "../engine/refs.ts";
import { Repository } from "../engine/repo.ts";
import type { CloneReport, FetchReport, PushReport } from "../engine/sync.ts";
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
 * Creates a fresh directory the commands treat as a repository root.
 *
 * @returns Its absolute path.
 */
function freshRoot(): string {
  const handle = makeTempDir();
  sandboxes.push(handle);
  return handle.root;
}

/**
 * Stands up a repository with one commit, through the command surface.
 *
 * @param harness - The activated harness.
 * @returns The repository root.
 */
async function seededRepo(harness: Awaited<ReturnType<typeof activate>>): Promise<string> {
  const root = freshRoot();
  await harness.runCommand({ command: "vcs init", pmRoot: root });
  writeFileSync(join(root, "a.txt"), "one");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({
    command: "vcs commit",
    options: { message: "first" },
    global: { author: "A <a@b>" },
    pmRoot: root,
  });
  return root;
}

test("remote lists, adds and removes through the command surface", async () => {
  const harness = await activate();
  const root = await seededRepo(harness);

  const empty = await harness.runCommand({ command: "vcs remote", pmRoot: root });
  assert.deepEqual((empty.result as { remotes: Remote[] }).remotes, []);

  const added = await harness.runCommand({ command: "vcs remote", args: ["origin", "/srv/one"], pmRoot: root });
  assert.deepEqual((added.result as { added: Remote }).added, { name: "origin", url: "/srv/one" });

  const listed = await harness.runCommand({ command: "vcs remote", pmRoot: root });
  assert.deepEqual((listed.result as { remotes: Remote[] }).remotes, [{ name: "origin", url: "/srv/one" }]);

  const removed = await harness.runCommand({
    command: "vcs remote", args: ["origin"], options: { remove: true }, pmRoot: root,
  });
  assert.equal((removed.result as { removed: string }).removed, "origin");
  assert.deepEqual((await harness.runCommand({ command: "vcs remote", pmRoot: root })).result, { ok: true, remotes: [] });
});

test("adding a remote without a location is refused with a remediation", async () => {
  const harness = await activate();
  const root = await seededRepo(harness);
  const failed = await harness.runCommand({ command: "vcs remote", args: ["origin"], pmRoot: root });
  assert.equal(failed.handled, false);
  assert.match(String(failed.errorMessage), /needs a location/);
  // A blank second argument is the same mistake as omitting it, and must not be
  // stored as a remote whose URL is the empty string.
  const blank = await harness.runCommand({ command: "vcs remote", args: ["origin", "  "], pmRoot: root });
  assert.equal(blank.handled, false);
});

test("clone, fetch and push work end to end through the command surface", async () => {
  const harness = await activate();
  const source = await seededRepo(harness);
  const workspace = freshRoot();

  const cloned = await harness.runCommand({ command: "vcs clone", args: [source], pmRoot: workspace });
  assert.equal(cloned.errorMessage, undefined, String(cloned.errorMessage));
  const report = (cloned.result as { clone: CloneReport }).clone;
  // No destination given, so the clone is named after the source directory.
  assert.equal(basename(report.root), basename(source));
  assert.equal(report.branch, "main");
  assert.equal(readFileSync(join(report.root, "a.txt"), "utf8"), "one");

  // Commit in the clone and push it back.
  writeFileSync(join(report.root, "b.txt"), "two");
  await harness.runCommand({ command: "vcs add", pmRoot: report.root });
  await harness.runCommand({
    command: "vcs commit", options: { message: "second" }, global: { author: "B <b@c>" }, pmRoot: report.root,
  });
  const pushed = await harness.runCommand({ command: "vcs push", pmRoot: report.root });
  assert.equal(pushed.errorMessage, undefined, String(pushed.errorMessage));
  assert.equal((pushed.result as { push: PushReport }).push.upToDate, false);
  const sourceTip = Repository.open(source).refs.read(`${BRANCH_PREFIX}main`);
  assert.equal(Repository.open(report.root).refs.read(`${BRANCH_PREFIX}main`), sourceTip);

  // A third participant fetches the pushed commit onto its tracking ref.
  const third = freshRoot();
  await harness.runCommand({ command: "vcs init", pmRoot: third });
  await harness.runCommand({ command: "vcs remote", args: ["upstream", source], pmRoot: third });
  const fetched = await harness.runCommand({ command: "vcs fetch", args: ["upstream"], pmRoot: third });
  assert.equal(fetched.errorMessage, undefined, String(fetched.errorMessage));
  assert.equal((fetched.result as { fetch: FetchReport }).fetch.upToDate, false);
  assert.equal(Repository.open(third).refs.read(trackingRef("upstream", "main")), sourceTip);
});

test("clone into a named directory under a custom remote name", async () => {
  const harness = await activate();
  const source = await seededRepo(harness);
  const workspace = freshRoot();
  const cloned = await harness.runCommand({
    command: "vcs clone", args: [source, "checkout"], options: { remote: "upstream" }, pmRoot: workspace,
  });
  const report = (cloned.result as { clone: CloneReport }).clone;
  assert.equal(report.root, join(workspace, "checkout"));
  assert.equal(Repository.open(report.root).remotes.require("upstream").url, source);
});

test("clone requires a source", async () => {
  const harness = await activate();
  const failed = await harness.runCommand({ command: "vcs clone", pmRoot: freshRoot() });
  assert.equal(failed.handled, false);
  assert.match(String(failed.errorMessage), /url/);
});

test("push refuses a non-fast-forward from the command surface and force overrides it", async () => {
  const harness = await activate();
  const source = await seededRepo(harness);
  const workspace = freshRoot();
  const clone = (await harness.runCommand({
    command: "vcs clone", args: [source, "clone"], pmRoot: workspace,
  })).result as { clone: CloneReport };
  const root = clone.clone.root;

  // Both sides commit, so neither tip descends from the other.
  writeFileSync(join(source, "remote.txt"), "remote");
  await harness.runCommand({ command: "vcs add", pmRoot: source });
  await harness.runCommand({
    command: "vcs commit", options: { message: "remote side" }, global: { author: "A <a@b>" }, pmRoot: source,
  });
  writeFileSync(join(root, "local.txt"), "local");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({
    command: "vcs commit", options: { message: "local side" }, global: { author: "B <b@c>" }, pmRoot: root,
  });

  const refused = await harness.runCommand({ command: "vcs push", args: ["origin"], pmRoot: root });
  assert.equal(refused.handled, false);
  assert.match(String(refused.errorMessage), /would discard commits/);

  const forced = await harness.runCommand({
    command: "vcs push", options: { branch: "main", force: true }, pmRoot: root,
  });
  assert.equal(forced.errorMessage, undefined, String(forced.errorMessage));
  assert.equal(
    Repository.open(source).refs.read(`${BRANCH_PREFIX}main`),
    Repository.open(root).refs.read(`${BRANCH_PREFIX}main`),
  );
});

test("fetch defaults to origin and reports an unconfigured remote", async () => {
  const harness = await activate();
  const root = await seededRepo(harness);
  const failed = await harness.runCommand({ command: "vcs fetch", pmRoot: root });
  assert.equal(failed.handled, false);
  assert.match(String(failed.errorMessage), /No remote named origin/);
  // An explicitly blank remote argument must fall back the same way rather than
  // looking for a remote whose name is the empty string.
  const blank = await harness.runCommand({ command: "vcs fetch", args: ["  "], pmRoot: root });
  assert.match(String(blank.errorMessage), /No remote named origin/);
  const blankPush = await harness.runCommand({ command: "vcs push", args: ["  "], pmRoot: root });
  assert.match(String(blankPush.errorMessage), /No remote named origin/);
});

test("remote refuses an invalid name at the command surface", async () => {
  const harness = await activate();
  const root = await seededRepo(harness);
  // A remote name becomes part of a ref name, so the engine's validation has to
  // reach the agent rather than surfacing later as a malformed ref.
  for (const name of ["a/b", "up stream", "up^stream"]) {
    const failed = await harness.runCommand({ command: "vcs remote", args: [name, "/srv/one"], pmRoot: root });
    assert.equal(failed.handled, false, name);
    assert.match(String(failed.errorMessage), /is invalid/, name);
  }
  assert.deepEqual((await harness.runCommand({ command: "vcs remote", pmRoot: root })).result, { ok: true, remotes: [] });
});

test("remote refuses a duplicate name at the command surface rather than repointing it", async () => {
  const harness = await activate();
  const root = await seededRepo(harness);
  await harness.runCommand({ command: "vcs remote", args: ["origin", "/srv/one"], pmRoot: root });

  const failed = await harness.runCommand({ command: "vcs remote", args: ["origin", "/srv/two"], pmRoot: root });
  assert.equal(failed.handled, false);
  assert.match(String(failed.errorMessage), /already configured/);
  // Silently repointing would send the next push somewhere else while the command
  // that changed it reported nothing.
  assert.equal(Repository.open(root).remotes.require("origin").url, "/srv/one");
});

test("remote stores the resolved location and refuses a scheme this build cannot serve", async () => {
  const harness = await activate();
  const root = await seededRepo(harness);

  // Relative to the working root the agent is in. Stored as typed, `fetch` would
  // later resolve it against the repository root instead.
  const added = await harness.runCommand({
    command: "vcs remote", args: ["origin", "../sibling"], pmRoot: root,
  });
  assert.equal(added.errorMessage, undefined, String(added.errorMessage));
  assert.equal((added.result as { added: Remote }).added.url, resolve(root, "../sibling"));

  // An unsupported scheme is refused here rather than at the first fetch, which
  // would name the fetch as the problem.
  const refused = await harness.runCommand({
    command: "vcs remote", args: ["web", "https://example.com/repo"], pmRoot: root,
  });
  assert.equal(refused.handled, false);
  assert.match(String(refused.errorMessage), /cannot reach a remote over "https"/);
  assert.equal(Repository.open(root).remotes.read("web"), null);
});
