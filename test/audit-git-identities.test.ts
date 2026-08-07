import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  auditGitIdentities,
  collectGitIdentities,
  GitObjectInventory,
  IdentityBatchParser,
  isMainInvocation,
  main,
  streamProcess,
  type GitObject,
} from "../scripts/audit-git-identities.ts";
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

/** Encodes one raw object using Git's batch-response protocol. */
function batch(object: GitObject, body: string, separator = "\n"): Buffer {
  return Buffer.from(`${object.id} ${object.type} ${Buffer.byteLength(body)}\n${body}${separator}`);
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
  await assert.rejects(collectGitIdentities(join(root, "missing")), /git .*cat-file.*failed/);
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

test("object inventory incrementally accepts commits and tags and ignores other objects", () => {
  const inventory = new GitObjectInventory();
  inventory.consume(Buffer.from("a".repeat(40)));
  inventory.consume(Buffer.from(` commit\n${"b".repeat(40)} blob\n${"c".repeat(40)} tag\n`));
  assert.deepEqual(inventory.finish(), [
    { id: "a".repeat(40), type: "commit" },
    { id: "c".repeat(40), type: "tag" },
  ]);
});

test("object inventory refuses a truncated final record", () => {
  const inventory = new GitObjectInventory();
  inventory.consume(Buffer.from(`${"a".repeat(40)} commit`));
  assert.throws(() => inventory.finish(), /truncated object inventory/);
});

test("batch parser validates chunked commits and annotated tags", () => {
  const commit = { id: "a".repeat(40), type: "commit" } as const;
  const tag = { id: "b".repeat(40), type: "tag" } as const;
  const bytes = Buffer.concat([
    batch(commit, "author Public <public@example.test> 0 +0000\ncommitter Public <public@example.test> 0 +0000\n\nmessage"),
    batch(tag, "object deadbeef\ntype commit\ntag release\ntagger Tagger <tagger@example.test> 0 +0000\n\nmessage"),
  ]);
  const parser = new IdentityBatchParser([commit, tag]);
  for (const byte of bytes) parser.consume(Buffer.of(byte));
  assert.deepEqual(parser.finish(), new Set(["public@example.test", "tagger@example.test"]));
});

test("batch parser rejects malformed protocol headers", () => {
  const object = { id: "a".repeat(40), type: "commit" } as const;
  for (const header of [
    "not-a-header\n",
    `${"b".repeat(40)} commit 1\n`,
    `${object.id} tag 1\n`,
  ]) {
    const parser = new IdentityBatchParser([object]);
    assert.throws(() => parser.consume(Buffer.from(header)), /invalid header/);
  }
  const unsafe = new IdentityBatchParser([object]);
  assert.throws(
    () => unsafe.consume(Buffer.from(`${object.id} commit 999999999999999999999\n`)),
    /invalid size/,
  );
});

test("batch parser rejects malformed tag identities and oversized tag headers", () => {
  const object = { id: "b".repeat(40), type: "tag" } as const;
  const malformed = new IdentityBatchParser([object]);
  assert.throws(() => malformed.consume(batch(object, "object deadbeef\n")), /well-formed tagger identity/);
  const oversized = new IdentityBatchParser([object]);
  assert.throws(
    () => oversized.consume(batch(object, `tagger ${"x".repeat(1024 * 1024)}`, "")),
    /Tag .* oversized identity header/,
  );
});

test("batch parser refuses missing separators, partial objects, and surplus bytes", () => {
  const object = { id: "a".repeat(40), type: "commit" } as const;
  const body = "author Public <public@example.test> 0 +0000\ncommitter Public <public@example.test> 0 +0000\n\nmessage";
  const missingSeparator = new IdentityBatchParser([object]);
  assert.throws(() => missingSeparator.consume(batch(object, body, "x")), /omitted the separator/);

  const missingObject = new IdentityBatchParser([object]);
  assert.throws(() => missingObject.finish(), /truncated or unrequested/);

  const partialObject = new IdentityBatchParser([object]);
  partialObject.consume(Buffer.from(`${object.id} commit ${Buffer.byteLength(body)}\npartial`));
  assert.throws(() => partialObject.finish(), /truncated or unrequested/);

  const surplus = new IdentityBatchParser([object]);
  surplus.consume(Buffer.concat([batch(object, body), Buffer.from("surplus")]));
  assert.throws(() => surplus.finish(), /truncated or unrequested/);
});

test("stream transport reports real spawn, exit, signal, consumer, and timeout failures", async () => {
  dir = makeTempDir();
  const options = { cwd: dir.root, timeoutMs: 1_000 };
  await assert.rejects(
    streamProcess(join(dir.root, "missing-command"), [], options, () => {}),
    /failed: spawn .* ENOENT/,
  );
  await assert.rejects(
    streamProcess(process.execPath, ["-e", "console.error('detail'); process.exit(2)"], options, () => {}),
    /failed: detail/,
  );
  await assert.rejects(
    streamProcess(process.execPath, ["-e", "process.exit(2)"], options, () => {}),
    /failed\.$/,
  );
  await assert.rejects(
    streamProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], options, () => {}),
    /with SIGTERM/,
  );
  await assert.rejects(
    streamProcess(process.execPath, ["-e", "process.stdout.write('x')"], options, () => { throw "not-an-error"; }),
    /output consumer failed/,
  );
  await assert.rejects(
    streamProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, timeoutMs: 20 }, () => {}),
    /timed out after 20ms/,
  );
});

test("stream transport reports a real broken stdin pipe", async () => {
  dir = makeTempDir();
  await assert.rejects(
    streamProcess(
      process.execPath,
      ["-e", "process.stdin.destroy(); setTimeout(() => {}, 100)"],
      { cwd: dir.root, input: "x".repeat(16 * 1024 * 1024), timeoutMs: 1_000 },
      () => {},
    ),
    /stdin failed/,
  );
});

test("main invocation detection resolves matching, different, and absent scripts", () => {
  const script = resolve("/tmp/audit-git-identities.ts");
  const url = pathToFileURL(script).href;
  assert.equal(isMainInvocation(["node", script], url), true);
  assert.equal(isMainInvocation(["node", "/tmp/other.ts"], url), false);
  assert.equal(isMainInvocation(["node"], url), false);
});

test("command main succeeds for a public repository and marks a refusal", async () => {
  const { root, allowlist } = repository();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  await main(root, allowlist);
  assert.equal(process.exitCode, undefined);
  await main(root, join(root, "missing-allowlist"));
  assert.equal(process.exitCode, 1);
  process.exitCode = previousExitCode;
});
