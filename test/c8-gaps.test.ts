/** Behavior checks for paths distinguished by the all-files c8 gate. */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { type RepositoryConfig } from "../engine/config.ts";
import {
  decodeCommit,
  encodeRecord,
  type RecordDocument,
  type Signature,
  writeCommit,
} from "../engine/model.ts";
import { ObjectStoreError } from "../engine/objects.ts";
import { parseWorkingRecord, renderWorkingRecord } from "../engine/record-format.ts";
import { mergeRecords } from "../engine/records.ts";
import { BRANCH_PREFIX, RefStore } from "../engine/refs.ts";
import { Repository } from "../engine/repo.ts";
import { mergePath, mergeTrees } from "../engine/rewrite.ts";
import { FileTransport } from "../engine/transport.ts";
import { buildTree, flattenTree } from "../engine/worktree.ts";
import { runGit, VcsError } from "../git.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const objectId = "a".repeat(64);
const signature: Signature = {
  name: "Coverage Agent",
  email: "coverage@example.invalid",
  timestamp: 1,
  timezoneOffsetMinutes: 0,
};

test("the Git boundary distinguishes a timed-out executable from an absent one", () => {
  const directory = makeTempDir();
  const originalPath = process.env.PATH;
  try {
    const git = join(directory.root, "git");
    writeFileSync(git, `#!/usr/bin/env node\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);\n`);
    chmodSync(git, 0o755);
    process.env.PATH = `${directory.root}:${dirname(process.execPath)}`;
    assert.throws(
      () => runGit(["status"], directory.root, 10),
      (error: unknown) => error instanceof VcsError && error.code === "git_timed_out",
    );
  } finally {
    process.env.PATH = originalPath;
    directory.cleanup();
  }
});

test("commit decoding rejects duplicate and malformed stable change identities", () => {
  const common = `tree ${objectId}\nauthor A <a@b> 1 0\ncommitter A <a@b> 1 0\n\nmessage`;
  assert.throws(
    () => decodeCommit(Buffer.from(`tree ${objectId}\nchange ${objectId}\nchange ${objectId}\nauthor A <a@b> 1 0\ncommitter A <a@b> 1 0\n\nmessage`)),
    /more than one change header/,
  );
  assert.throws(
    () => decodeCommit(Buffer.from(common.replace(`tree ${objectId}\n`, `tree ${objectId}\nchange invalid\n`))),
    /change "invalid"/,
  );
});

test("working record codecs preserve actionable parser detail and normalize a non-string body", () => {
  assert.throws(
    () => parseWorkingRecord("broken.json", Buffer.from("not json")),
    /is neither a valid native PM TOON item nor a valid JSON object\.$/,
  );
  assert.throws(
    () => parseWorkingRecord("broken.toon", Buffer.from("not toon or json")),
    /Native TOON parser: Invalid item metadata/,
  );
  const document: RecordDocument = {
    id: "item-1",
    title: "Title",
    description: "Description",
    type: "Task",
    status: "open",
    priority: 2,
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
    body: 42,
  };
  assert.match(renderWorkingRecord("item.toon", document).toString("utf8"), /body: ""/);
});

test("equal timestamp instants use canonical byte order as a deterministic tie-break", () => {
  const result = mergeRecords(
    { updated_at: "2020-01-01T00:00:00.000Z" },
    { updated_at: "2025-12-31T19:00:00-05:00" },
    { updated_at: "2026-01-01T00:00:00.000Z" },
    { fields: { updated_at: "timestamp" } },
  );
  assert.equal(result.document.updated_at, "2026-01-01T00:00:00.000Z");
});

test("a stale ref transaction names both absent and unexpected current values", () => {
  const directory = makeTempDir();
  try {
    const refs = new RefStore(join(directory.root, ".pmvcs"));
    const name = `${BRANCH_PREFIX}main`;
    assert.throws(
      () => refs.transaction([{ name, expected: objectId, next: "b".repeat(64) }]),
      /holds nothing.*expected a+/,
    );
    refs.compareAndSwap(name, null, objectId);
    assert.throws(
      () => refs.transaction([{ name, expected: null, next: "b".repeat(64) }]),
      /expected nothing/,
    );
  } finally {
    directory.cleanup();
  }
});

test("stage-all leaves an indexed path alone after it becomes ignored", () => {
  const directory = makeTempDir();
  try {
    const repository = Repository.init(directory.root);
    const tracked = join(directory.root, "tracked.log");
    writeFileSync(tracked, "base\n");
    repository.stage(["tracked.log"]);
    repository.commit({ message: "base\n", author: signature }, new Date(1));
    writeFileSync(join(directory.root, ".pmvcsignore"), "tracked.log\n");
    writeFileSync(tracked, "ignored edit\n");
    const staged = repository.stage([]);
    assert.equal(staged.includes("tracked.log"), false);
    assert.ok(repository.status().unstaged.some((change) => change.path === "tracked.log"));
  } finally {
    directory.cleanup();
  }
});

test("record add-add and reversed identity ordering remain deterministic", () => {
  const directory = makeTempDir();
  try {
    const config: RepositoryConfig = { recordPaths: ["*.toon"], recordPolicy: { fields: { tags: "set" } } };
    const repository = Repository.init(directory.root, "main", config);
    const context = { store: repository.objects, config, committer: signature };
    const ours = repository.objects.write("record", encodeRecord({ tags: ["ours"] }));
    const theirs = repository.objects.write("record", encodeRecord({ tags: ["theirs"] }));
    const record = mergePath(context, "item.toon", null, ours, theirs);
    assert.equal(record.conflict, undefined);

    const blob = repository.objects.write("blob", Buffer.from("same"));
    const ourTree = buildTree(repository.objects, new Map([
      ["file", { id: blob, mode: "100644" as const, fileId: "f".repeat(32) }],
    ]));
    const theirTree = buildTree(repository.objects, new Map([
      ["file", { id: blob, mode: "100644" as const, fileId: "a".repeat(32) }],
    ]));
    const merged = mergeTrees(context, null, ourTree, theirTree);
    assert.equal(flattenTree(repository.objects, merged.tree).get("file")?.fileId, "a".repeat(32));

    const copiedOurTree = buildTree(repository.objects, new Map([
      ["file", {
        id: blob,
        mode: "100644" as const,
        fileId: "a".repeat(32),
        copiedFrom: "c".repeat(32),
      }],
    ]));
    const copiedTheirTree = buildTree(repository.objects, new Map([
      ["file", { id: blob, mode: "100644" as const, fileId: "f".repeat(32) }],
    ]));
    const copied = mergeTrees(context, null, copiedOurTree, copiedTheirTree);
    assert.equal(flattenTree(repository.objects, copied.tree).get("file")?.copiedFrom, "c".repeat(32));
  } finally {
    directory.cleanup();
  }
});

test("a criss-cross with unrelated minimal bases builds its virtual base from an empty ancestor", () => {
  const directory = makeTempDir();
  try {
    const repository = Repository.init(directory.root);
    const tree = buildTree(repository.objects, new Map());
    const rootA = writeCommit(repository.objects, { tree, parents: [], author: signature, committer: signature, message: "A\n" });
    const rootB = writeCommit(repository.objects, { tree, parents: [], author: signature, committer: signature, message: "B\n" });
    const left = writeCommit(repository.objects, { tree, parents: [rootA, rootB], author: signature, committer: signature, message: "left\n" });
    const right = writeCommit(repository.objects, { tree, parents: [rootB, rootA], author: signature, committer: signature, message: "right\n" });
    repository.refs.compareAndSwap(`${BRANCH_PREFIX}main`, null, left);
    repository.refs.compareAndSwap(`${BRANCH_PREFIX}right`, null, right);
    const result = repository.merge("right", { message: "join\n", author: signature }, new Date(2));
    assert.equal(result.kind, "merged");
    assert.deepEqual(new Set(result.bases), new Set([rootA, rootB]));
  } finally {
    directory.cleanup();
  }
});

test("transport preserves a repository format error instead of rewriting it as unreachable", () => {
  const directory = makeTempDir();
  try {
    mkdirSync(join(directory.root, ".pmvcs"), { recursive: true });
    writeFileSync(join(directory.root, ".pmvcs", "format"), "future-format\n");
    assert.throws(
      () => new FileTransport(directory.root, directory.root).advertise(),
      (error: unknown) => error instanceof ObjectStoreError && error.code === "unsupported_format",
    );
  } finally {
    directory.cleanup();
  }
});
