import assert from "node:assert/strict";
import { copyFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { resolveFileId, traceFile } from "../engine/attribution.ts";
import { readCommit, type Signature } from "../engine/model.ts";
import { ObjectStoreError } from "../engine/objects.ts";
import { Repository } from "../engine/repo.ts";
import { mergeTrees } from "../engine/rewrite.ts";
import { buildTree, flattenTree } from "../engine/worktree.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let directory: ReturnType<typeof makeTempDir> | null = null;
const author: Signature = { name: "Agent", email: "agent@local", timestamp: 1, timezoneOffsetMinutes: 0 };

afterEach(() => {
  directory?.cleanup();
  directory = null;
});

test("tree merging refuses conflicting and duplicated logical file identities", () => {
  directory = makeTempDir();
  const repository = Repository.init(directory.root);
  const blob = repository.objects.write("blob", Buffer.from("same"));
  const left = buildTree(repository.objects, new Map([
    ["one", { id: blob, mode: "100644" as const, fileId: "a".repeat(32) }],
  ]));
  const right = buildTree(repository.objects, new Map([
    ["one", { id: blob, mode: "100644" as const, fileId: "b".repeat(32) }],
  ]));
  const context = { store: repository.objects, config: repository.config, committer: author };
  assert.throws(() => mergeTrees(context, null, left, right),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "file_identity_conflict");
  const otherBlob = repository.objects.write("blob", Buffer.from("different"));
  const changedRight = buildTree(repository.objects, new Map([
    ["one", { id: otherBlob, mode: "100644" as const, fileId: "b".repeat(32) }],
  ]));
  assert.throws(() => mergeTrees(context, null, left, changedRight),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "file_identity_conflict");

  const duplicated = buildTree(repository.objects, new Map([
    ["one", { id: blob, mode: "100644" as const, fileId: "c".repeat(32) }],
    ["two", { id: blob, mode: "100644" as const, fileId: "c".repeat(32) }],
  ]));
  assert.throws(() => mergeTrees(context, null, duplicated, duplicated),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "file_identity_conflict");

  const legacy = buildTree(repository.objects, new Map([
    ["one", { id: blob, mode: "100644" as const }],
  ]));
  const adopted = mergeTrees(context, null, left, legacy);
  assert.equal(flattenTree(repository.objects, adopted.tree).get("one")?.fileId, "a".repeat(32));
  const migrated = mergeTrees(context, legacy, left, buildTree(repository.objects, new Map([
    ["one", { id: otherBlob, mode: "100644" as const }],
  ])));
  assert.equal(flattenTree(repository.objects, migrated.tree).get("one")?.fileId, "a".repeat(32));
  assert.equal(flattenTree(repository.objects, migrated.tree).get("one")?.id, otherBlob);

  const provenanceLeft = buildTree(repository.objects, new Map([
    ["one", { id: blob, mode: "100644" as const, fileId: "d".repeat(32), copiedFrom: "a".repeat(32) }],
  ]));
  const provenanceRight = buildTree(repository.objects, new Map([
    ["one", { id: blob, mode: "100644" as const, fileId: "d".repeat(32), copiedFrom: "b".repeat(32) }],
  ]));
  const adoptedProvenance = mergeTrees(context, null, provenanceLeft, buildTree(repository.objects, new Map([
    ["one", { id: blob, mode: "100644" as const, fileId: "d".repeat(32) }],
  ])));
  assert.equal(flattenTree(repository.objects, adoptedProvenance.tree).get("one")?.copiedFrom, "a".repeat(32));
  assert.throws(() => mergeTrees(context, null, provenanceLeft, provenanceRight),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "file_identity_conflict");
  const changedProvenanceRight = buildTree(repository.objects, new Map([
    ["one", { id: otherBlob, mode: "100644" as const, fileId: "d".repeat(32), copiedFrom: "b".repeat(32) }],
  ]));
  assert.throws(() => mergeTrees(context, legacy, provenanceLeft, changedProvenanceRight),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "file_identity_conflict");
});

test("stable file identities trace edits, moves, copies, deletion and PM associations", () => {
  directory = makeTempDir();
  const repository = Repository.init(directory.root);
  const path = (name: string): string => join(directory!.root, name);

  writeFileSync(path("source.bin"), Buffer.from([0, 1, 2]));
  repository.stage([]);
  const added = repository.commit({ message: "add\n", author, items: ["task-1"] }, new Date(1));
  const original = flattenTree(repository.objects, readCommit(repository.objects, added).tree).get("source.bin");
  assert.match(original?.fileId ?? "", /^[0-9a-f]{32}$/);

  writeFileSync(path("source.bin"), Buffer.from([0, 1, 3]));
  repository.stage([]);
  const modified = repository.commit({ message: "edit\n", author }, new Date(2));
  assert.equal(flattenTree(repository.objects, readCommit(repository.objects, modified).tree).get("source.bin")?.fileId, original?.fileId);

  renameSync(path("source.bin"), path("moved.bin"));
  repository.stage([]);
  const moved = repository.commit({ message: "move\n", author }, new Date(3));
  assert.equal(flattenTree(repository.objects, readCommit(repository.objects, moved).tree).get("moved.bin")?.fileId, original?.fileId);

  renameSync(path("moved.bin"), path("moved-edited.bin"));
  writeFileSync(path("moved-edited.bin"), Buffer.from([0, 1, 4]));
  repository.stage([]);
  const movedEdited = repository.commit({ message: "move and edit\n", author }, new Date(4));
  assert.equal(flattenTree(repository.objects, readCommit(repository.objects, movedEdited).tree).get("moved-edited.bin")?.fileId, original?.fileId);

  copyFileSync(path("moved-edited.bin"), path("copy.bin"));
  repository.stage([]);
  const copied = repository.commit({ message: "copy\n", author }, new Date(5));
  const copy = flattenTree(repository.objects, readCommit(repository.objects, copied).tree).get("copy.bin");
  assert.notEqual(copy?.fileId, original?.fileId);
  assert.equal(copy?.copiedFrom, original?.fileId);

  rmSync(path("moved-edited.bin"));
  repository.stage([]);
  const deleted = repository.commit({ message: "delete\n", author }, new Date(6));
  const commits = [deleted, copied, movedEdited, moved, modified, added];
  assert.equal(resolveFileId(repository.objects, commits, "moved.bin"), original?.fileId);
  assert.equal(resolveFileId(repository.objects, commits, original!.fileId!), original?.fileId);
  assert.equal(resolveFileId(repository.objects, commits, "unknown.bin"), null);
  assert.deepEqual(traceFile(repository.objects, commits, original!.fileId!).map((entry) => entry.kind), [
    "deleted", "moved", "moved", "modified", "added",
  ]);
  assert.deepEqual(traceFile(repository.objects, commits, original!.fileId!).at(-1)?.items, ["task-1"]);
  assert.equal(traceFile(repository.objects, commits, copy!.fileId!).at(-1)?.copiedFrom, original?.fileId);
  assert.deepEqual(traceFile(repository.objects, commits, "f".repeat(32)), []);
});

test("legacy index migration is deterministic across agents", () => {
  const identities: string[] = [];
  for (let agent = 0; agent < 2; agent += 1) {
    const sandbox = makeTempDir();
    const repository = Repository.init(sandbox.root);
    writeFileSync(join(sandbox.root, "legacy.bin"), "legacy");
    const blob = repository.objects.write("blob", Buffer.from("legacy"));
    repository.writeIndex([{ path: "legacy.bin", id: blob, mode: "100644" }]);
    repository.stage(["legacy.bin"]);
    identities.push(repository.readIndex()[0]!.fileId!);
    sandbox.cleanup();
  }
  assert.match(identities[0] ?? "", /^[0-9a-f]{32}$/);
  assert.equal(identities[0], identities[1]);

  const moved = makeTempDir();
  const repository = Repository.init(moved.root);
  writeFileSync(join(moved.root, "legacy.bin"), "legacy");
  const blob = repository.objects.write("blob", Buffer.from("legacy"));
  repository.writeIndex([{ path: "legacy.bin", id: blob, mode: "100644" }]);
  renameSync(join(moved.root, "legacy.bin"), join(moved.root, "moved.bin"));
  repository.stage([]);
  assert.equal(repository.readIndex()[0]?.fileId, identities[0]);
  moved.cleanup();
});

test("two branches retain distinct linked-file identities and PM associations through merge", () => {
  directory = makeTempDir();
  const repository = Repository.init(directory.root);
  const path = (name: string): string => join(directory!.root, name);
  writeFileSync(path("a.bin"), "a0");
  writeFileSync(path("b.bin"), "b0");
  repository.stage([]);
  repository.commit({ message: "base\n", author }, new Date(1));
  repository.createBranch("agent-b", "HEAD", new Date(2));

  writeFileSync(path("a.bin"), "a1");
  repository.stage(["a.bin"]);
  repository.commit({ message: "agent a\n", author, items: ["task-a"] }, new Date(3));
  repository.switchTo("agent-b", new Date(4));
  writeFileSync(path("b.bin"), "b1");
  repository.stage(["b.bin"]);
  repository.commit({ message: "agent b\n", author, items: ["task-b"] }, new Date(5));

  const report = repository.merge("main", { message: "merge agent a\n", author }, new Date(6));
  assert.equal(report.kind, "merged");
  const commits = repository.allReachable();
  const tree = flattenTree(repository.objects, readCommit(repository.objects, report.head).tree);
  const aId = tree.get("a.bin")?.fileId;
  const bId = tree.get("b.bin")?.fileId;
  assert.match(aId ?? "", /^[0-9a-f]{32}$/);
  assert.match(bId ?? "", /^[0-9a-f]{32}$/);
  assert.notEqual(aId, bId);
  assert.ok(traceFile(repository.objects, commits, aId!).some((trace) => trace.items.includes("task-a")));
  assert.ok(traceFile(repository.objects, commits, bId!).some((trace) => trace.items.includes("task-b")));
});

test("attribution fails closed when required history is missing", () => {
  directory = makeTempDir();
  const repository = Repository.init(directory.root);
  writeFileSync(join(directory.root, "asset.bin"), "payload");
  repository.stage([]);
  const commitId = repository.commit({ message: "asset\n", author }, new Date(1));
  const commit = readCommit(repository.objects, commitId);
  rmSync(join(directory.root, ".pmvcs", "objects", commit.tree.slice(0, 2), commit.tree.slice(2)));
  assert.throws(
    () => resolveFileId(repository.objects, [commitId], "asset.bin"),
    (error: unknown) => error instanceof ObjectStoreError
      && error.code === "object_not_found"
      && error.message.includes(commit.tree),
  );
});
