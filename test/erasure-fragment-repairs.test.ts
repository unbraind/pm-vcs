/** Bounded real leaf-link erasure and fragmented conflict regressions. */
import assert from "node:assert/strict";
import fs, { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { eraseFile } from "../engine/erasure.ts";
import { readFragmented, writeFragmented } from "../engine/fragments.ts";
import { encodeManifest, readCommit, writeManifest, type Signature } from "../engine/model.ts";
import { ObjectStore, ObjectStoreError, type ObjectId } from "../engine/objects.ts";
import { Repository } from "../engine/repo.ts";
import { mergePath, mergeTrees } from "../engine/rewrite.ts";
import { buildTree, flattenTree } from "../engine/worktree.ts";
import { WorktreeMutation } from "../engine/worktree-mutation.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { mock.restoreAll(); for (const fixture of temporary.splice(0)) fixture.cleanup(); });

/** Initialize actual SDK and native storage inside one disposable fixture. */
async function fixture(): Promise<{ repo: Repository; scratch: string }> {
  const temp = makeTempDir(); temporary.push(temp);
  const root = join(temp.root, "repository"); mkdirSync(root);
  await new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true }).init("repair", { defaults: true, author: "fixture" });
  const repo = Repository.init(root); repo.setAuthority("fixture", "read-fixture", "erase-fixture"); repo.identity();
  repo.stage([]); repo.commit({ message: "tracker", author }, new Date(0));
  return { repo, scratch: temp.root };
}

/** Snapshot durable repository state around an expected pre-publication refusal. */
function state(repo: Repository): object {
  return { refs: repo.refs.list("refs/"), index: repo.readIndex(), operations: repo.operations.read(), denials: repo.objects.denials(),
    head: readFileSync(join(repo.controlDirectory, "HEAD")), merge: existsSync(join(repo.controlDirectory, "MERGE_STATE")), objects: readdirSync(join(repo.controlDirectory, "objects"), { recursive: true }) };
}

for (const dangling of [false, true]) {
  test(`erasure permits an unrelated ${dangling ? "dangling" : "ordinary"} leaf link without reading its target`, async () => {
    const { repo, scratch } = await fixture(); const selected = Buffer.from("leaf-erasure-selected-marker-892463");
    writeFileSync(join(repo.root, "secret"), selected); repo.stage(["secret"]); const tip = repo.commit({ message: "selected", author }, new Date());
    const destination = join(scratch, "outside"); writeFileSync(destination, selected);
    if (!dangling) writeFileSync(join(repo.root, "ordinary"), "unrelated target bytes");
    symlinkSync(dangling ? "missing" : "ordinary", join(repo.root, "unrelated.link"));
    symlinkSync(destination, join(repo.root, "external.link"));
    assert.doesNotThrow(() => repo.obliterate("secret", "erase-fixture", "incident", new Date()));
    assert.equal(lstatSync(join(repo.root, "unrelated.link")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(repo.root, "external.link")), destination); assert.deepEqual(readFileSync(destination), selected);
    assert.equal(repo.readFileState(tip, "secret").kind, "obliterated"); assert.deepEqual(repo.verify().corrupt, []);
  });
}

for (const stagedLink of [false, true]) for (const ignored of [false, true]) {
  test(`erasure removes ${ignored ? "ignored " : ""}owned ${stagedLink ? "staged link text" : "file replaced by a dangling link"} without following it`, async () => {
    const { repo, scratch } = await fixture(); const path = join(repo.root, "owned.link");
    const targetText = "selected-link-target-marker-741963"; const selected = Buffer.from(targetText);
    if (stagedLink) symlinkSync(targetText, path); else writeFileSync(path, selected);
    repo.stage(["owned.link"]); const entry = repo.readIndex().find(entry => entry.path === "owned.link")!;
    assert.deepEqual(repo.objects.read(entry.id).payload, selected);
    const tip = repo.commit({ message: "owned", author }, new Date());
    const external = join(scratch, "external"); writeFileSync(external, "external bytes remain untouched");
    rmSync(path); symlinkSync(stagedLink ? external : "absent-target", path);
    if (ignored) writeFileSync(join(repo.root, ".pmvcsignore"), "*.link\n");
    assert.doesNotThrow(() => repo.obliterate("owned.link", "erase-fixture", "incident", new Date()));
    assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined);
    assert.equal(readFileSync(external, "utf8"), "external bytes remain untouched");
    assert.equal(repo.readFileState(tip, "owned.link").kind, "obliterated");
    assert.equal(repo.objects.denials()[0]!.pending, false); assert.deepEqual(repo.verify().corrupt, []);
  });
}

test("erasure refuses selected bytes retained in unrelated external leaf target text before denial", async () => {
  const { repo, scratch } = await fixture(); const selected = "retained-link-text-marker-635284";
  writeFileSync(join(repo.root, "secret"), selected); repo.stage(["secret"]); repo.commit({ message: "selected", author }, new Date());
  const destination = join(scratch, selected); writeFileSync(destination, "independent outside bytes");
  symlinkSync(destination, join(repo.root, "retained.link")); const before = state(repo);
  assert.throws(() => repo.obliterate("secret", "erase-fixture", "incident", new Date()), { code: "erasure_worktree_conflict" });
  assert.deepEqual(state(repo), before); assert.equal(readlinkSync(join(repo.root, "retained.link")), destination);
  assert.equal(readFileSync(destination, "utf8"), "independent outside bytes");
});

test("erasure scrubs an already absent owned file while retaining refusal for observed disappearance", async () => {
  const { repo } = await fixture(); const leaf = join(repo.root, "secret"); writeFileSync(leaf, "absent-owned-marker-614729");
  repo.stage(["secret"]); const tip = repo.commit({ message: "selected", author }, new Date()); rmSync(leaf);
  repo.obliterate("secret", "erase-fixture", "incident", new Date()); assert.equal(existsSync(leaf), false);
  assert.equal(repo.readFileState(tip, "secret").kind, "obliterated"); assert.equal(repo.objects.denials()[0]!.pending, false);
});

test("erasure refuses an owned ancestor link and ordinary mutations still refuse leaf links", async () => {
  const { repo, scratch } = await fixture(); mkdirSync(join(repo.root, "branch"));
  writeFileSync(join(repo.root, "branch/secret"), "ancestor-selected-marker-395186"); repo.stage(["branch/secret"]); repo.commit({ message: "selected", author }, new Date());
  const outside = join(scratch, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret"), "outside sentinel");
  renameSync(join(repo.root, "branch"), join(scratch, "parked")); symlinkSync(outside, join(repo.root, "branch"), "dir");
  const before = state(repo);
  assert.throws(() => repo.obliterate("branch/secret", "erase-fixture", "incident", new Date()), (error: unknown) => error instanceof ObjectStoreError && ["unsafe_composition_path", "worktree_path_changed"].includes(error.code));
  assert.deepEqual(state(repo), before); assert.equal(readFileSync(join(outside, "secret"), "utf8"), "outside sentinel");
  symlinkSync(join(outside, "secret"), join(repo.root, "leaf")); const mutation = new WorktreeMutation(repo.root, ".pmvcs");
  try { assert.throws(() => mutation.remove("leaf"), { code: "worktree_path_changed" }); assert.throws(() => mutation.write("leaf", Buffer.from("new"), 0o600), { code: "worktree_path_changed" }); }
  finally { mutation.close(); }
  assert.equal(readFileSync(join(outside, "secret"), "utf8"), "outside sentinel");
});

test("fragmented merge verifies every real fragment under one lease without whole-file concatenation", async () => {
  const { repo } = await fixture();
  const inputs = [12345, 12346, 12347].map((length, index) => writeFragmented(repo.objects, Buffer.alloc(length, 131 + index), 512));
  const reads: string[] = []; const leases = new Set<bigint>(); const concats: number[] = [];
  const read = ObjectStore.prototype.read; const concat = Buffer.concat;
  mock.method(ObjectStore.prototype, "read", function (this: ObjectStore, id: ObjectId) {
    reads.push(id); leases.add(lstatSync(join(repo.controlDirectory, "objects.lock"), { bigint: true }).ino); return read.call(this, id);
  });
  mock.method(Buffer, "concat", (parts: readonly Uint8Array[], length?: number) => { if (length !== undefined) concats.push(length); return concat(parts, length); });
  const result = mergePath({ store: repo.objects, config: repo.config, committer: author }, "large.bin", inputs[0]!.manifestId, inputs[1]!.manifestId, inputs[2]!.manifestId);
  mock.restoreAll();
  assert.deepEqual(result, { id: inputs[1]!.manifestId, conflict: { path: "large.bin", reason: "content" } });
  assert.equal(leases.size, 1); assert.equal(existsSync(join(repo.controlDirectory, "objects.lock")), false);
  for (const input of inputs) for (const fragment of input.manifest.fragments) assert.ok(reads.includes(fragment.id));
  assert.deepEqual(concats.filter(length => inputs.some(input => input.manifest.totalLength === length)), [], "conflict validation requested full-file concatenation");
  for (let index = 0; index < inputs.length; index += 1) assert.deepEqual(readFragmented(repo.objects, inputs[index]!.manifestId), Buffer.alloc(12345 + index, 131 + index));
  const base = buildTree(repo.objects, new Map([["large.bin", { id: inputs[0]!.manifestId, mode: "100644", fileId: "b".repeat(32) }]]));
  const ours = buildTree(repo.objects, new Map([["large.bin", { id: inputs[1]!.manifestId, mode: "100755", fileId: "b".repeat(32), copiedFrom: "c".repeat(32) }]]));
  const theirs = buildTree(repo.objects, new Map([["large.bin", { id: inputs[2]!.manifestId, mode: "100755", fileId: "b".repeat(32) }]]));
  const merged = mergeTrees({ store: repo.objects, config: repo.config, committer: author }, base, ours, theirs);
  assert.ok(merged.conflicts.some(conflict => conflict.reason === "content")); assert.deepEqual(flattenTree(repo.objects, merged.tree).get("large.bin"), flattenTree(repo.objects, ours).get("large.bin"));
});

for (const damage of ["missing", "corrupt", "length", "type", "manifest-total"] as const) {
  test(`fragmented merge refuses real ${damage} damage before changing durable state`, async () => {
    const { repo } = await fixture(); const input = writeFragmented(repo.objects, Buffer.alloc(2049, 173), 512);
    const ours = repo.objects.write("blob", Buffer.from("our unchanged complete bytes")); const base = repo.refs.resolveHead()!;
    let theirs = input.manifestId; const fragment = input.manifest.fragments.at(-1)!;
    const object = join(repo.controlDirectory, "objects", fragment.id.slice(0, 2), fragment.id.slice(2));
    let code: string;
    if (damage === "missing") { rmSync(object); code = "object_not_found"; }
    else if (damage === "corrupt") { writeFileSync(object, "damaged physical frame"); code = "corrupt_object"; }
    else if (damage === "length") { theirs = writeManifest(repo.objects, { totalLength: 2, fragments: [{ id: fragment.id, length: 2 }] }); code = "fragment_length_mismatch"; }
    else if (damage === "type") { const tree = readCommit(repo.objects, base).tree; const length = repo.objects.read(tree).payload.length; theirs = writeManifest(repo.objects, { totalLength: length, fragments: [{ id: tree, length }] }); code = "object_type_mismatch"; }
    else { theirs = repo.objects.write("manifest", Buffer.from(encodeManifest(input.manifest).toString("utf8").replace("total 2049", "total 2050"))); code = "malformed_object"; }
    const before = state(repo);
    assert.throws(() => mergePath({ store: repo.objects, config: repo.config, committer: author }, "large.bin", null, ours, theirs), { code });
    assert.deepEqual(state(repo), before); assert.equal(existsSync(join(repo.controlDirectory, "objects.lock")), false);
  });
}

test("erasure mutation retains missing paths and refuses directories and replaced preflight identities", async () => {
  const { repo, scratch } = await fixture(); const mutation = new WorktreeMutation(repo.root, ".pmvcs");
  const external = join(scratch, "target"); writeFileSync(external, "outside sentinel");
  try {
    assert.equal(mutation.inspectForErasure("absent/leaf"), undefined); assert.equal(mutation.inspectForErasure("absent"), undefined);
    assert.throws(() => mutation.inspectForErasure(".agents"), { code: "worktree_path_changed" });
    assert.throws(() => mutation.removeForErasure("absent/leaf", lstatSync(external, { bigint: true })), { code: "worktree_path_changed" });
    assert.throws(() => mutation.removeForErasure(".agents", lstatSync(join(repo.root, ".agents"), { bigint: true })), { code: "worktree_path_changed" });
    const leaf = join(repo.root, "owned"); symlinkSync(external, leaf); const inspected = mutation.inspectForErasure("owned")!;
    assert.deepEqual(inspected.content, Buffer.from(external)); renameSync(leaf, join(scratch, "old-link")); symlinkSync(external, leaf);
    assert.throws(() => mutation.removeForErasure("owned", inspected.stat), { code: "worktree_path_changed" });
    assert.equal(readlinkSync(leaf), external); assert.equal(readFileSync(external, "utf8"), "outside sentinel");
  } finally { mutation.close(); }
});

for (const boundary of ["open-link", "open-file", "open-missing", "readlink", "read-file"] as const) {
  test(`erasure no-follow inspection refuses real leaf replacement at ${boundary}`, async () => {
    const { repo, scratch } = await fixture(); const leaf = join(repo.root, "leaf"); const external = join(scratch, "target");
    writeFileSync(external, "outside sentinel");
    if (boundary === "readlink") symlinkSync(external, leaf); else writeFileSync(leaf, "original ordinary bytes");
    const mutation = new WorktreeMutation(repo.root, ".pmvcs"); let swapped = false;
    const swap = (): void => { swapped = true; renameSync(leaf, join(scratch, "original")); if (boundary === "open-file") writeFileSync(leaf, "replacement ordinary bytes"); else if (boundary !== "open-missing") symlinkSync(external, leaf); };
    if (boundary.startsWith("open-")) {
      const open = fs.openSync;
      mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { if (String(args[0]).endsWith("/leaf")) swap(); return open(...args); });
    } else if (boundary === "readlink") {
      const readlink = fs.readlinkSync;
      mock.method(fs, "readlinkSync", (...args: Parameters<typeof fs.readlinkSync>) => { swap(); return readlink(...args); });
    } else {
      const read = fs.readFileSync;
      mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => { if (typeof args[0] === "number") swap(); return read(...args); });
    }
    try { assert.throws(() => mutation.inspectForErasure("leaf"), { code: "worktree_path_changed" }); assert.equal(swapped, true); }
    finally { mock.restoreAll(); mutation.close(); }
    assert.equal(readFileSync(external, "utf8"), "outside sentinel");
  });
}

test("erasure replacement after durable denial refuses completion and preserves the new leaf and target", async () => {
  const { repo, scratch } = await fixture(); const leaf = join(repo.root, "owned"); const selected = Buffer.from("preflight-identity-selected-793461");
  writeFileSync(leaf, selected); repo.stage(["owned"]); const tip = repo.commit({ message: "selected", author }, new Date());
  const external = join(scratch, "target"); writeFileSync(external, "outside sentinel"); const denials = repo.objects.recordDenials;
  let swapped = false;
  mock.method(repo.objects, "recordDenials", function (this: ObjectStore, ...args: Parameters<ObjectStore["recordDenials"]>) {
    denials.apply(this, args); if (!swapped) { swapped = true; renameSync(leaf, join(scratch, "original")); symlinkSync(external, leaf); }
  });
  assert.throws(() => repo.obliterate("owned", "erase-fixture", "incident", new Date()), { code: "worktree_path_changed" }); mock.restoreAll();
  assert.equal(swapped, true); assert.equal(repo.objects.denials()[0]!.pending, true); assert.equal(readlinkSync(leaf), external);
  assert.equal(readFileSync(external, "utf8"), "outside sentinel"); assert.equal(repo.readFileState(tip, "owned").kind, "obliterated");
  assert.equal(repo.operations.read().at(-1)!.command, "commit");
  repo.obliterate("owned", "erase-fixture", "incident", new Date()); assert.equal(lstatSync(leaf, { throwIfNoEntry: false }), undefined);
  assert.equal(repo.objects.denials()[0]!.pending, false); assert.equal(readFileSync(external, "utf8"), "outside sentinel");
});

test("erasure refuses an actual control-root link and disappearing owned or unowned scan leaves before denial", async () => {
  const { repo, scratch } = await fixture(); const selected = Buffer.from("protected-root-marker-746392");
  writeFileSync(join(repo.root, "secret"), selected); repo.stage(["secret"]); repo.commit({ message: "selected", author }, new Date());
  const control = join(scratch, "control"); renameSync(repo.controlDirectory, control); symlinkSync(control, repo.controlDirectory, "dir");
  assert.throws(() => eraseFile(repo, [repo], "secret", "erase-fixture", "incident", new Date()), { code: "unsafe_composition_path" });
  assert.deepEqual(repo.objects.denials(), []); rmSync(repo.controlDirectory); renameSync(control, repo.controlDirectory);
  const inspect = WorktreeMutation.prototype.inspectForErasure;
  for (const disappearing of ["unowned", "secret"]) {
    writeFileSync(join(repo.root, "unowned"), "unrelated bytes"); let disappeared = false;
    mock.method(WorktreeMutation.prototype, "inspectForErasure", function (this: WorktreeMutation, path: string) {
      if (path === disappearing) { rmSync(join(repo.root, path)); disappeared = true; } return inspect.call(this, path);
    });
    assert.throws(() => repo.obliterate("secret", "erase-fixture", "incident", new Date()), { code: "worktree_path_changed" }); mock.restoreAll();
    assert.equal(disappeared, true); assert.deepEqual(repo.objects.denials(), []);
    if (disappearing === "unowned") assert.deepEqual(readFileSync(join(repo.root, "secret")), selected);
    else { assert.equal(existsSync(join(repo.root, "secret")), false); writeFileSync(join(repo.root, "secret"), selected); }
  }
});
