import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { auditGitIdentities, collectGitIdentities } from "../scripts/audit-git-identities.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

/** Runs Git in a disposable real repository and returns trimmed output. */
function git(root: string, arguments_: readonly string[], input?: string): string {
  const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8", input });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Creates a repository with one public commit and its matching allowlist. */
function repository(): { root: string; allowlist: string; first: string } {
  dir = makeTempDir();
  const root = dir.root;
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Public"]);
  git(root, ["config", "user.email", "public@example.test"]);
  writeFileSync(join(root, "file"), "first");
  git(root, ["add", "file"]);
  git(root, ["commit", "-qm", "first"]);
  const allowlist = join(root, "approved.txt");
  writeFileSync(allowlist, "public@example.test\n");
  return { root, allowlist, first: git(root, ["rev-parse", "HEAD"]) };
}

test("identity audit accepts an allowlisted reachable history", async () => {
  const { root, allowlist } = repository();
  await assert.doesNotReject(auditGitIdentities(root, allowlist));
});

test("identity audit accepts an initialized repository with no commits", async () => {
  dir = makeTempDir();
  git(dir.root, ["init", "-q"]);
  const allowlist = join(dir.root, "approved.txt");
  writeFileSync(allowlist, "public@example.test\n");
  await assert.doesNotReject(auditGitIdentities(dir!.root, allowlist));
});

test("identity audit finds unreachable ancestors and ignores replacement refs", async () => {
  const { root, allowlist, first } = repository();
  git(root, ["config", "user.email", "private@example.test"]);
  writeFileSync(join(root, "file"), "private");
  git(root, ["commit", "-qam", "private"]);
  const privateCommit = git(root, ["rev-parse", "HEAD"]);
  git(root, ["config", "user.email", "public@example.test"]);
  writeFileSync(join(root, "file"), "public child");
  git(root, ["commit", "-qam", "public child"]);
  git(root, ["replace", privateCommit, first]);
  git(root, ["reset", "--hard", "-q", first]);
  await assert.rejects(
    auditGitIdentities(root, allowlist),
    /rejected 1 non-public address/,
  );
});

test("identity inventory refuses malformed commits and unusable repositories", async () => {
  const { root } = repository();
  git(root, ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], "malformed\n");
  await assert.rejects(collectGitIdentities(root), /exactly one well-formed author identity/);
  await assert.rejects(collectGitIdentities(join(root, "missing")), /git cat-file.*failed/);
});

test("identity inventory rejects a multi-angle commit identity", async () => {
  const { root } = repository();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const timestamp = "0 +0000";
  git(root, ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], [
    `tree ${tree}`,
    `author Public <private@example.test> <public@example.test> ${timestamp}`,
    `committer Public <public@example.test> ${timestamp}`,
    "",
    "message",
    "",
  ].join("\n"));
  await assert.rejects(collectGitIdentities(root), /exactly one well-formed author identity/);
});

test("identity inventory rejects duplicate commit identity headers", async () => {
  const { root } = repository();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const timestamp = "0 +0000";
  git(root, ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], [
    `tree ${tree}`,
    `author Public <public@example.test> ${timestamp}`,
    `author Duplicate <public@example.test> ${timestamp}`,
    `committer Public <public@example.test> ${timestamp}`,
    "",
    "message",
    "",
  ].join("\n"));
  await assert.rejects(collectGitIdentities(root), /exactly one well-formed author identity/);
});

test("identity inventory ignores identity-shaped commit message lines", async () => {
  const { root } = repository();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const timestamp = "0 +0000";
  git(root, ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], [
    `tree ${tree}`,
    `author Public <public@example.test> ${timestamp}`,
    `committer Public <public@example.test> ${timestamp}`,
    "",
    `author Impostor <message@example.test> ${timestamp}`,
    `committer Impostor <message@example.test> ${timestamp}`,
    "",
  ].join("\n"));
  assert.deepEqual(await collectGitIdentities(root), new Set(["public@example.test"]));
});

test("identity inventory streams a large commit message after parsing its header", async () => {
  const { root } = repository();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const timestamp = "0 +0000";
  git(root, ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], [
    `tree ${tree}`,
    `author Public <public@example.test> ${timestamp}`,
    `committer Public <public@example.test> ${timestamp}`,
    "",
    "x".repeat(2 * 1024 * 1024),
    "",
  ].join("\n"));
  assert.deepEqual(await collectGitIdentities(root), new Set(["public@example.test"]));
});

test("identity inventory rejects an oversized unterminated identity header", async () => {
  const { root } = repository();
  git(
    root,
    ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"],
    `author ${"x".repeat(1024 * 1024)}\n`,
  );
  await assert.rejects(collectGitIdentities(root), /has an oversized identity header/);
});

test("identity inventory includes annotated taggers", async () => {
  const { root, allowlist } = repository();
  git(root, ["config", "user.email", "tagger-private@example.test"]);
  git(root, ["tag", "-am", "release", "v1"]);
  await assert.rejects(auditGitIdentities(root, allowlist), /rejected 1 non-public address/);
});
