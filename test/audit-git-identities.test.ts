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

test("identity audit accepts an allowlisted reachable history", () => {
  const { root, allowlist } = repository();
  assert.doesNotThrow(() => auditGitIdentities(root, allowlist));
});

test("identity audit accepts an initialized repository with no commits", () => {
  dir = makeTempDir();
  git(dir.root, ["init", "-q"]);
  const allowlist = join(dir.root, "approved.txt");
  writeFileSync(allowlist, "public@example.test\n");
  assert.doesNotThrow(() => auditGitIdentities(dir!.root, allowlist));
});

test("identity audit finds unreachable ancestors and ignores replacement refs", () => {
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
  assert.throws(
    () => auditGitIdentities(root, allowlist),
    /rejected 1 non-public address/,
  );
});

test("identity inventory refuses malformed commits and unusable repositories", () => {
  const { root } = repository();
  git(root, ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], "malformed\n");
  assert.throws(() => collectGitIdentities(root), /well-formed author identity/);
  assert.throws(() => collectGitIdentities(join(root, "missing")), /git cat-file.*failed/);
});
