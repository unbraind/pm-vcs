import { spawnSync } from "node:child_process";
import { testEnvironment } from "./helpers/test-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { generateKeyPairSync } from "node:crypto";
import { exportChangeBundle } from "../engine/change-bundles.ts";
import { nativeOutputs, recordNativeOutput } from "../engine/native-outputs.ts";
import { WorktreeMutation } from "../engine/worktree-mutation.ts";
import { renderWorkingRecord } from "../engine/record-format.ts";
import { fingerprintJournal, erasureScanBoundary } from "../engine/erasure-scan.ts";
import { validateErasureRequest } from "../engine/erasure.ts";
import { syncBuiltinESMExports } from "node:module";
import { payloadOwners } from "../engine/payload-owners.ts";
import { objectFiles } from "../engine/object-files.ts";
import { encodePagedManifest } from "../engine/manifest-pages.ts";
import { PublicationLeases } from "../engine/publication-leases.ts";
import "./helpers/isolate-session.ts";
/** Provenance receipts deliberately distinguish native derivation from user-authored transforms. */
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { deflateSync } from "node:zlib";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { readFragmented, readFragmentRange, readFragmentedToFile, writeFragmented, writeFragmentedFile } from "../engine/fragments.ts";
import { encodeManifest, encodeRecord, encodeTree, type Signature } from "../engine/model.ts";
import { hashObject } from "../engine/objects.ts";
import { serializeBundle, exportBundle, parseBundle } from "../engine/bundle.ts";
import { managedExports, writeBundleFile } from "../engine/managed-exports.ts";
import { writePrivateJson } from "../engine/composition.ts";
import { makeTempDir } from "./helpers/tmp.ts";
const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => {
  // Bun has no node:test mocking API; its portable selection never installs Node fault mocks.
  if (typeof mock.restoreAll === "function") mock.restoreAll();
  syncBuiltinESMExports(); objectFiles.opened = () => {}; erasureScanBoundary.visit = () => {};
  for (const temp of temporary.splice(0)) temp.cleanup();
});
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
/** Create a native history and authority without inherited credentials. */
async function fixture(seed = 0) {
  const temp = makeTempDir(); temporary.push(temp);
  process.env.GIT_CEILING_DIRECTORIES = temp.root;
  const root = join(temp.root, "repository"); mkdirSync(root);
  await new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true }).init("provenance", { defaults: true, author: "fixture" });
  const repo = Repository.init(root); repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  const bytes = Buffer.from(`selected secret "quoted bytes" 937184 seed ${seed}`);
  writeFileSync(join(repo.root, "asset"), bytes); repo.stage(["asset"]);
  const entry = repo.readIndex().find(entry => entry.path === "asset")!;
  const tip = repo.commit({ message: "selected", author }, new Date(0));
  return { repo, bytes, entry, tip, scratch: temp.root };
}

for (const kind of ["double-percent", "native-normalized-url"] as const) test(`user-authored ${kind} is explicitly outside the provenance guarantee`, async () => {
  const { repo, bytes, entry } = await fixture();
  const encoded = kind === "double-percent" ? encodeURIComponent(encodeURIComponent(bytes.toString())) : " \tfi\nle:" + pathToFileURL(join(repo.root, bytes.toString())).pathname.replaceAll("/", "\\");
  if (kind === "native-normalized-url") assert.equal(fileURLToPath(encoded), join(repo.root, bytes.toString()));
  else assert.equal(decodeURIComponent(decodeURIComponent(encoded)), bytes.toString());
  repo.remotes.add("user-data", encoded);
  const loose = repo.objects.write("blob", Buffer.from(encoded)); repo.objects.compact();
  const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.equal(receipt.guarantee.kind, "native-provenance");
  assert.ok(receipt.guarantee.excluded.includes("user-authored alternate encodings"));
  assert.ok(readFileSync(join(repo.controlDirectory, "remotes.json"), "utf8").includes(kind === "double-percent" ? "%25" : "fi"));
  assert.equal(repo.objects.read(loose).payload.toString(), encoded);
  assert.equal(repo.objects.state(entry.id).kind, "obliterated");
});

test("native operation summaries are erased structurally even with concatenated compressed streams inside hex", async () => {
  const { repo, bytes, entry } = await fixture();
  const summary = Buffer.concat([deflateSync(Buffer.from("unrelated")), deflateSync(bytes)]).toString("hex");
  repo.operations.append("fixture", summary, [], new Date(0));
  const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.equal(receipt.guarantee.kind, "native-provenance");
  assert.equal(readFileSync(join(repo.controlDirectory, "oplog.jsonl"), "utf8").includes(summary), false);
  assert.equal(repo.operations.read().find(operation => operation.command === "fixture")!.summary, "Summary removed by authorized erasure.");
});

test("native split manifests and their fragments cannot reconstruct an erased whole blob", async () => {
  const { repo, bytes, entry } = await fixture();
  const halves = [bytes.subarray(0, 19), bytes.subarray(19)];
  const fragments = halves.map(payload => ({ id: repo.objects.write("blob", payload), length: payload.length }));
  const manifest = repo.objects.write("manifest", encodeManifest({ totalLength: bytes.length, fragments }));
  assert.deepEqual(readFragmented(repo.objects, manifest), bytes);
  const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  for (const id of [entry.id, manifest, ...fragments.map(fragment => fragment.id)]) {
    assert.ok(receipt.removed.includes(id)); assert.equal(repo.objects.state(id).kind, "obliterated");
    assert.throws(() => repo.objects.read(id), { code: "object_obliterated" });
  }
  assert.throws(() => readFragmented(repo.objects, manifest), { code: "object_obliterated" });
  assert.throws(() => readFragmentRange(repo.objects, manifest, 0, bytes.length), { code: "object_obliterated" });
  assert.throws(() => readFragmentedToFile(repo.objects, manifest, join(repo.root, "restored")), { code: "object_obliterated" });
  const before = repo.objects.inventory().map(object => object.id).sort();
  assert.throws(() => writeFragmented(repo.objects, bytes, 7, "f".repeat(32)), { code: "object_obliterated" });
  assert.deepEqual(repo.objects.inventory().map(object => object.id).sort(), before);
  writeFileSync(join(repo.root, "source"), bytes);
  assert.throws(() => writeFragmentedFile(repo.objects, join(repo.root, "source"), 7, "f".repeat(32)), { code: "object_obliterated" });
  assert.deepEqual(repo.objects.inventory().map(object => object.id).sort(), before);
  const altered = [bytes.subarray(0, 7), bytes.subarray(7)].map(payload => ({ id: repo.objects.write("blob", payload, "f".repeat(32)), length: payload.length }));
  assert.throws(() => repo.objects.write("manifest", encodeManifest({ totalLength: bytes.length, fragments: altered }), "f".repeat(32)), { code: "object_obliterated" });
});

test("benign repeated digits never gate erasure or later attributed staging", async () => {
  const { repo, entry } = await fixture();
  const benign = Buffer.from("3".repeat(1024)); const id = repo.objects.write("blob", benign);
  const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.equal(receipt.storage.accountable, true); assert.deepEqual(repo.objects.read(id).payload, benign);
  writeFileSync(join(repo.root, "benign"), benign); repo.stage(["benign"]);
  assert.equal(repo.readIndex().find(entry => entry.path === "benign")!.id, hashObject("blob", benign));
});

test("property: generated native history closes objects, packs, manifests, logs and registered bundles by provenance", async t => {
  for (let seed = 0; seed < 5; seed++) await t.test(`history ${seed}`, async () => {
    const { repo, bytes, entry, tip, scratch } = await fixture(seed);
    repo.restore(["asset"], tip);
    assert.ok(nativeOutputs(repo.controlDirectory).some(output => output.objects.includes(entry.id)));
    const cut = 1 + seed * 3;
    const fragments = [bytes.subarray(0, cut), bytes.subarray(cut)].map(payload => ({ id: repo.objects.write("blob", payload), length: payload.length }));
    const manifest = repo.objects.write("manifest", encodeManifest({ totalLength: bytes.length, fragments }));
    const ids = [entry.id, manifest, ...fragments.map(fragment => fragment.id)];
    repo.operations.append("native-summary", bytes.toString("base64"), [], new Date(0));
    if (seed === 4) repo.linkInstance("secondary", join(scratch, "secondary"));
    const output = seed === 4 ? Repository.open(join(scratch, "secondary")) : repo;
    const file = join(output.root, "managed.bundle");
    writeBundleFile(output, file, () => serializeBundle(repo.objects, { refs: {}, prerequisites: [], objects: ids }));
    assert.ok(managedExports(output.controlDirectory).some(artifact => artifact.objects.includes(manifest)));
    if (seed % 2 === 0) repo.objects.compact();
    const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
    assert.equal(receipt.storage.accountable, true); assert.equal(existsSync(file), false); assert.deepEqual(managedExports(output.controlDirectory), []);
    assert.equal(nativeOutputs(repo.controlDirectory).some(output => output.objects.some(id => ids.includes(id))), false);
    assert.equal(existsSync(join(output.root, "asset")), false);
    for (const id of ids) { assert.ok(receipt.removed.includes(id)); assert.throws(() => repo.objects.read(id), { code: "object_obliterated" }); }
    assert.equal(repo.readFileState(tip, "asset").kind, "obliterated");
    assert.throws(() => readFragmented(repo.objects, manifest), { code: "object_obliterated" });
    const exported = parseBundle(exportBundle(repo.objects, repo.refs, [], []));
    for (const id of ids) assert.equal(exported.header.objects.includes(id), false);
    assert.equal(repo.operations.read().some(operation => operation.summary === bytes.toString("base64")), false);
    assert.deepEqual(repo.verify().corrupt, []);
    assert.equal(repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(2)).tombstone, receipt.tombstone);
  });
});

test("provenance preserves ownership refusals for replaced exports and unknown destruction bytes", async () => {
  const { repo, entry } = await fixture(); const file = join(repo.root, "managed.bundle");
  writeBundleFile(repo, file, () => exportBundle(repo.objects, repo.refs, [], [])); writeFileSync(file, "foreign replacement");
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "worktree_path_changed" });
  assert.equal(repo.objects.denials().length, 0); assert.equal(readFileSync(file, "utf8"), "foreign replacement");
  writePrivateJson(join(repo.controlDirectory, "exports.json"), [{ path: "../foreign", id: "b".repeat(64), sha256: "a".repeat(64), objects: [entry.id] }]);
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "unsupported_erasure_storage" });
});


test("native unpublished FileId payloads retain provenance before index or tree publication", async () => {
  const { repo, entry } = await fixture();
  const bytes = Buffer.from("unpublished native derivation with another complete body");
  const orphan = repo.objects.write("blob", bytes, entry.fileId);
  assert.equal(repo.readIndex().some(entry => entry.id === orphan), false);
  const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.ok(receipt.removed.includes(orphan)); assert.throws(() => repo.objects.read(orphan), { code: "object_obliterated" });
});

test("unpublished shared ownership refuses rather than deleting another FileId's native payload", async () => {
  const { repo, bytes, entry } = await fixture();
  repo.objects.write("blob", bytes, "f".repeat(32));
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "erasure_dedup_conflict" });
  assert.equal(repo.objects.denials().length, 0); assert.deepEqual(repo.objects.read(entry.id).payload, bytes);
});

test("an orphan-only native FileId can be erased without inventing a worktree owner", async () => {
  const { repo } = await fixture(); const fileId = "f".repeat(32);
  const id = repo.objects.write("blob", Buffer.from("native unpublished source"), fileId);
  const receipt = repo.obliterate(fileId, "erase-fixture", "provenance", new Date(1));
  assert.ok(receipt.removed.includes(id)); assert.throws(() => repo.objects.read(id), { code: "object_obliterated" });
  assert.equal(existsSync(join(repo.root, "asset")), true);
});


test("native ownership classification rejects unknown provenance bytes, kinds and names before deletion", async t => {
  for (const kind of ["name", "bytes", "directory", "symlink", "invalid-file-id"] as const) await t.test(kind, async () => {
    const { repo, bytes, entry } = await fixture();
    if (kind === "invalid-file-id") assert.throws(() => repo.objects.write("blob", Buffer.from("unpublished"), "invalid"), { code: "invalid_file_id" });
    else {
      const path = join(repo.controlDirectory, "payload-owners", kind === "name" ? "foreign-backup" : `${"a".repeat(64)}.${"f".repeat(32)}`);
      if (kind === "directory") mkdirSync(path);
      else if (kind === "symlink") symlinkSync(join(repo.root, "asset"), path);
      else writeFileSync(path, "foreign provenance bytes");
      assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "unsupported_erasure_storage" });
    }
    assert.equal(repo.objects.denials().length, 0); assert.deepEqual(repo.objects.read(entry.id).payload, bytes);
  });
});


test("bounded native JSON diagnostics report suspected residues and depth limits without denying erasure", async () => {
  const { repo, bytes, entry } = await fixture();
  let nested: unknown = "benign"; for (let depth = 0; depth < 10; depth++) nested = { child: nested };
  writePrivateJson(join(repo.controlDirectory, "remotes.json"), { [bytes.toString()]: [bytes.toString(), nested] });
  const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.equal(receipt.audit.suspected_residue, true); assert.equal(receipt.audit.limited, true);
  assert.deepEqual(receipt.audit.limits, { bytes: 16 * 1024 * 1024, depth: 8 });
  assert.equal(repo.objects.state(entry.id).kind, "obliterated");
});


test("native lease records and valid empty control stages preserve erasure while opaque stages refuse ownership", async t => {
  for (const name of ["denials.json", "erasure-verification.json", "erasure-purge.json", "exports.json", "outputs.json", "objects.generation", "objects.lock.123", "oplog.jsonl"] as const) await t.test(name, async () => {
    const { repo, bytes, entry } = await fixture();
    new PublicationLeases(repo.objects, repo.controlDirectory).change({ action: "acquire", fileId: entry.fileId!, refs: ["refs/heads/main"], ttlMs: 1000 });
    const path = join(repo.controlDirectory, `${name}.${"a".repeat(12)}.tmp`);
    writeFileSync(path, bytes);
    assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "unsupported_erasure_storage" });
    assert.deepEqual(repo.objects.read(entry.id).payload, bytes); assert.equal(repo.objects.denials().length, 0);
    if (name === "oplog.jsonl") { writeFileSync(path, JSON.stringify({ sequence: 1, command: "fixture", at: new Date(0).toISOString(), summary: bytes.toString("base64"), refs: [] }) + "\n"); assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "unsupported_erasure_storage" }); }
    writeFileSync(path, JSON.stringify({ backup: bytes.toString("base64") }));
    assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "unsupported_erasure_storage" });
    const native = name === "oplog.jsonl" ? JSON.stringify({ sequence: 1, command: "fixture", at: new Date(0).toISOString(), summary: "Summary removed by authorized erasure.", refs: [] }) + "\n" : name === "objects.lock.123" ? "123" : JSON.stringify(name === "objects.generation" ? "a".repeat(32) : name === "erasure-verification.json" ? fingerprintJournal({}) : name === "erasure-purge.json" ? { format: "pm-vcs-erasure-purge-1", operations: {} } : []);
    writeFileSync(path, native);
    repo.objects.withWriteLock(() => validateErasureRequest(repo, [repo], entry.fileId!, "erase-fixture", "provenance", new Date(1), {}));
    assert.equal(repo.objects.denials().length, 0);
    writeFileSync(path, "");
    const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
    assert.equal(receipt.guarantee.kind, "native-provenance");
  });
});


test("native paged composition identities erase every ordered page without materializing whole content", async () => {
  const { repo, entry } = await fixture();
  const bytes = Buffer.from(Array.from({ length: 129 }, (_, index) => index));
  const result = writeFragmented(repo.objects, bytes, 1, entry.fileId);
  assert.deepEqual(readFragmented(repo.objects, result.manifestId), bytes);
  const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.ok(receipt.removed.includes(result.manifestId)); assert.ok(receipt.removed.includes(hashObject("blob", bytes)));
  assert.throws(() => readFragmented(repo.objects, result.manifestId), { code: "object_obliterated" });
});

test("native composition refuses wrong fragment kinds, lengths and page kinds before deletion", async t => {
  for (const kind of ["fragment-kind", "fragment-length", "page-kind", "root-reader-kind"] as const) await t.test(kind, async () => {
    const { repo, bytes, entry } = await fixture();
    const child = repo.objects.write(kind === "fragment-length" || kind === "root-reader-kind" ? "blob" : "record", Buffer.from("{}"));
    const payload = kind === "page-kind" ? encodePagedManifest({ totalLength: 129, height: 1, fragments: [], pages: [{ id: child, length: 128, count: 128 }, { id: child, length: 1, count: 1 }] }) : encodeManifest({ totalLength: kind === "fragment-length" ? 3 : 2, fragments: [{ id: child, length: kind === "fragment-length" ? 3 : 2 }] });
    const manifest = repo.objects.write("manifest", payload);
    if (kind === "root-reader-kind") {
      const read = repo.objects.readErasureObject;
      mock.method(repo.objects, "readErasureObject", (id: string, path: string) => id === manifest ? { type: "blob" as const, payload } : Reflect.apply(read, repo.objects, [id, path]));
    }
    assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "invalid_manifest" });
    assert.deepEqual(readFileSync(join(repo.root, "asset")), bytes); assert.equal(repo.objects.denials().length, 0);
  });
});

test("managed export publication preserves existing user files, replacement fences and caller-owned external outputs", async () => {
  const { repo, bytes, entry, scratch } = await fixture(); const produce = () => exportBundle(repo.objects, repo.refs, [], []);
  assert.throws(() => writeBundleFile(repo, join(repo.root, "asset"), produce), { code: "export_path_owned" }); assert.deepEqual(readFileSync(join(repo.root, "asset")), bytes);
  const external = join(scratch, "external.bundle"); writeBundleFile(repo, external, produce); assert.deepEqual(managedExports(repo.controlDirectory), []);
  const local = join(repo.root, "managed.bundle"); writeBundleFile(repo, local, produce); const archive = readFileSync(local);
  writeBundleFile(repo, local, produce); assert.deepEqual(readFileSync(local), archive);
  rmSync(local); writeBundleFile(repo, local, produce); assert.deepEqual(readFileSync(local), archive);
  writeFileSync(local, "foreign replacement"); assert.throws(() => writeBundleFile(repo, local, produce), { code: "worktree_path_changed" }); assert.equal(readFileSync(local, "utf8"), "foreign replacement");
  writeFileSync(local, archive);
  if (process.platform !== "win32") assert.throws(() => writeBundleFile(repo, join(repo.root, "out:bundle"), produce), { code: "export_path_owned" });
  const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.equal(existsSync(local), false); assert.ok(existsSync(external));
  assert.throws(() => repo.objects.write("blob", archive, "f".repeat(32)), { code: "object_obliterated" });
  assert.ok(receipt.guarantee.excluded.includes("caller-owned exports and external copies"));
});

test("managed export registries reject malformed roots, identifiers, inventories and duplicate authority", async () => {
  const { repo, entry } = await fixture(); const path = join(repo.controlDirectory, "exports.json");
  const valid = { path: "managed.bundle", id: "a".repeat(64), sha256: "b".repeat(64), objects: [entry.id] };
  for (const value of [null, {}, [null], [{ ...valid, id: "bad" }], [{ ...valid, sha256: null }], [{ ...valid, objects: null }], [{ ...valid, objects: ["bad"] }], [{ ...valid, path: "" }], [valid, valid]]) {
    writePrivateJson(path, value); assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "unsupported_erasure_storage" });
    assert.equal(repo.objects.denials().length, 0);
  }
});

test("payload provenance refuses directory aliases, changed catalogues and native publication faults", async t => {
  for (const mode of ["read-root-link", "write-root-link", "catalogue-arrival", "changed-leaf", "existing-foreign", "io", "publication-replacement", "duplicate"] as const) await t.test(mode, async () => {
    const { repo, bytes, entry, scratch } = await fixture(); const directory = join(repo.controlDirectory, "payload-owners");
    const next = Buffer.from("a new native attributed payload"); const id = hashObject("blob", next); const target = join(directory, `${id}.${entry.fileId}`);
    if (mode.endsWith("root-link")) {
      renameSync(directory, join(scratch, "original-provenance")); const foreign = join(scratch, "foreign-provenance"); mkdirSync(foreign); symlinkSync(foreign, directory);
      if (mode === "read-root-link") assert.throws(() => payloadOwners(repo.controlDirectory), { code: "unsupported_erasure_storage" });
      else assert.throws(() => repo.objects.write("blob", next, entry.fileId), { code: "unsupported_erasure_storage" });
    } else if (mode === "catalogue-arrival" || mode === "changed-leaf") {
      let injected = false;
      objectFiles.opened = (_file, path) => { if (!injected && path.startsWith(directory + "/")) { injected = true; writeFileSync(mode === "catalogue-arrival" ? target : path, mode === "catalogue-arrival" ? "" : "foreign"); } };
      assert.throws(() => payloadOwners(repo.controlDirectory), { code: "unsupported_erasure_storage" }); assert.equal(injected, true);
    } else if (mode === "existing-foreign") {
      writeFileSync(target, "foreign"); assert.throws(() => repo.objects.write("blob", next, entry.fileId), { code: "unsupported_erasure_storage" }); assert.equal(readFileSync(target, "utf8"), "foreign");
    } else if (mode === "io") {
      const open = fs.openSync; mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { if (args[0] === target) throw Object.assign(new Error("injected provenance I/O"), { code: "EIO" }); return Reflect.apply(open, fs, args); }); syncBuiltinESMExports();
      assert.throws(() => repo.objects.write("blob", next, entry.fileId), { code: "EIO" });
    } else if (mode === "publication-replacement") {
      const open = fs.openSync; const stat = fs.fstatSync; let owned = -1; let injected = false;
      mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { const fd = Reflect.apply(open, fs, args); if (args[0] === target) owned = fd; return fd; });
      mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => { const value = Reflect.apply(stat, fs, args); if (args[0] === owned && !injected) { injected = true; renameSync(target, join(scratch, "retired-owner")); writeFileSync(target, ""); } return value; }); syncBuiltinESMExports();
      assert.throws(() => repo.objects.write("blob", next, entry.fileId), { code: "unsupported_erasure_storage" }); assert.equal(injected, true);
    } else assert.equal(repo.objects.write("blob", bytes, entry.fileId), entry.id);
    assert.deepEqual(repo.objects.read(entry.id).payload, bytes); assert.equal(repo.objects.denials().length, 0);
  });
});


test("lease audit ownership rejects opaque fields even inside otherwise valid native records", async () => {
  const { repo, bytes, entry } = await fixture();
  new PublicationLeases(repo.objects, repo.controlDirectory).change({ action: "acquire", fileId: entry.fileId!, refs: ["refs/heads/main"], ttlMs: 1000 });
  const path = join(repo.controlDirectory, "leases", `${entry.fileId}.jsonl`); const original = readFileSync(path, "utf8");
  const record = JSON.parse(original) as { lease: Record<string, unknown> };
  for (const altered of [{ ...record, backup: bytes.toString("base64") }, { ...record, lease: { ...record.lease, backup: bytes.toString("base64") } }]) {
    writeFileSync(path, JSON.stringify(altered) + "\n");
    assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "unsupported_erasure_storage" });
    assert.equal(repo.objects.denials().length, 0); assert.deepEqual(repo.objects.read(entry.id).payload, bytes);
  }
  writeFileSync(path, original); assert.equal(repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)).guarantee.kind, "native-provenance");
});

test("native operation redaction removes erased endpoints and preserves safe transition facts", async () => {
  const { repo, entry, tip } = await fixture();
  repo.operations.append("erased-endpoints", "native source summary", [{ ref: "refs/heads/opaque", before: entry.id, after: entry.id }], new Date(0), { before: entry.id, after: entry.id });
  repo.operations.append("safe-endpoints", "native safe summary", [{ ref: "refs/heads/safe", before: tip, after: null }], new Date(0), { before: `ref: refs/heads/main`, after: tip });
  repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  const erased = repo.operations.read().find(operation => operation.command === "erased-endpoints")!;
  assert.deepEqual(erased.refs, [{ ref: "refs/heads/opaque", before: null, after: null }]); assert.deepEqual(erased.head, { before: "", after: "" });
  const safe = repo.operations.read().find(operation => operation.command === "safe-endpoints")!;
  assert.deepEqual(safe.refs, [{ ref: "refs/heads/safe", before: tip, after: null }]); assert.deepEqual(safe.head, { before: "ref: refs/heads/main", after: tip });
});

test("unrecognized native operation records refuse ownership before deletion and preserve ordinary log compatibility", async () => {
  const { repo, bytes, entry } = await fixture(); const path = join(repo.controlDirectory, "oplog.jsonl"); const original = readFileSync(path);
  const valid = { sequence: 1, command: "fixture", at: new Date(0).toISOString(), summary: "native", refs: [] };
  for (const value of [null, {}, { ...valid, refs: null }, { ...valid, refs: [null] }, { ...valid, refs: [{ ref: "refs/heads/opaque", before: "bad", after: null }] }, { ...valid, head: "opaque" }, { ...valid, head: { before: "", after: 1 } }, { ...valid, backup: bytes.toString("base64") }, { ...valid, head: null }, { ...valid, head: { before: 1, after: "ref: refs/heads/main" } }, { ...valid, head: { before: "", after: "", backup: "opaque" } }]) {
    writeFileSync(path, JSON.stringify(value) + "\n"); assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "unsupported_erasure_storage" });
    assert.equal(repo.objects.denials().length, 0);
  }
  writeFileSync(path, "{torn native log\n"); assert.deepEqual(repo.operations.read(), []);
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "unsupported_erasure_storage" });
  writeFileSync(path, original);
});

test("native log I/O faults remain operational refusals without denial or payload deletion", async () => {
  const { repo, bytes, entry } = await fixture(); const path = join(repo.controlDirectory, "oplog.jsonl"); const read = fs.readFileSync;
  mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => { if (args[0] === path) throw Object.assign(new Error("native log I/O"), { code: "EIO" }); return Reflect.apply(read, fs, args); }); syncBuiltinESMExports();
  assert.throws(() => repo.operations.read(), { code: "EIO" });
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "EIO" });
  assert.equal(repo.objects.denials().length, 0); assert.deepEqual(readFileSync(join(repo.root, "asset")), bytes);
});


test("independent user files are explicitly outside the receipt even when their literal bytes match", async () => {
  const { repo, bytes, entry } = await fixture(); const path = join(repo.root, "user-copy"); writeFileSync(path, bytes);
  const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.ok(receipt.guarantee.excluded.includes("independent user files")); assert.deepEqual(readFileSync(path), bytes);
  assert.equal(repo.objects.state(entry.id).kind, "obliterated");
});

test("an absent native operation log does not invent legacy copies or prevent provenance cleanup", async () => {
  const { repo, entry } = await fixture(); rmSync(join(repo.controlDirectory, "oplog.jsonl"));
  const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.equal(receipt.guarantee.kind, "native-provenance"); assert.equal(repo.operations.read().length, 1);
});


test("native content digest denial also closes a record reconstructed with fresh blob fragments", async () => {
  const { repo, entry } = await fixture(); const bytes = encodeRecord({ private: "native typed record content" });
  const record = repo.objects.write("record", bytes, entry.fileId);
  repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.throws(() => repo.objects.read(record), { code: "object_obliterated" });
  const fragments = [bytes.subarray(0, 5), bytes.subarray(5)].map(payload => ({ id: repo.objects.write("blob", payload, "f".repeat(32)), length: payload.length }));
  assert.throws(() => repo.objects.write("manifest", encodeManifest({ totalLength: bytes.length, fragments }), "f".repeat(32)), { code: "object_obliterated" });
});

test("structural writes do not manufacture FileId payload ownership", async () => {
  const { repo } = await fixture(); const fileId = "f".repeat(32); const payload = encodeTree([]);
  const id = repo.objects.write("tree", payload, fileId);
  assert.equal(payloadOwners(repo.controlDirectory).some(owner => owner.id === id), false);
  assert.throws(() => repo.obliterate(fileId, "erase-fixture", "provenance", new Date(1)), { code: "unknown_file" });
  assert.deepEqual(repo.objects.read(id).payload, payload);
});


test("native working outputs survive interrupted index publication as identity-bound erasure sources", async t => {
  for (const interrupted of [false, true]) await t.test(String(interrupted), async () => {
    const { repo, bytes, entry } = await fixture();
    const mutation = new WorktreeMutation(repo.root, ".pmvcs", repo.objects);
    const original = fs.writeFileSync;
    if (interrupted) mock.method(fs, "writeFileSync", (file: Parameters<typeof fs.writeFileSync>[0], data: Parameters<typeof fs.writeFileSync>[1], ...args: unknown[]) => {
      if (typeof file === "number" && Buffer.isBuffer(data) && data.equals(bytes)) {
        original(file, data.subarray(0, 7)); throw new Error("simulated interruption before index publication");
      }
      return Reflect.apply(original, fs, [file, data, ...args]);
    });
    syncBuiltinESMExports();
    try {
      const write = () => repo.objects.withWriteLock(() => mutation.write("interrupted-copy", bytes, 0o644, { objects: [entry.id], fileId: entry.fileId }));
      if (interrupted) assert.throws(write, /simulated interruption/); else write();
    } finally { mutation.close(); mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(repo.readIndex().some(entry => entry.path === "interrupted-copy"), false);
    const recorded = nativeOutputs(repo.controlDirectory);
    const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
    assert.equal(receipt.guarantee.kind, "native-provenance");
    assert.equal(existsSync(join(repo.root, "interrupted-copy")), false);
    assert.equal(recorded[0].objects[0], entry.id);
    assert.deepEqual(nativeOutputs(repo.controlDirectory), []);
  });
});

test("native output birth fences preserve unrelated replacements and absent copies converge", async () => {
  const { repo, bytes, entry } = await fixture();
  const mutation = new WorktreeMutation(repo.root, ".pmvcs", repo.objects);
  try { repo.objects.withWriteLock(() => mutation.write("copy", bytes, 0o644, { objects: [entry.id] })); } finally { mutation.close(); }
  renameSync(join(repo.root, "copy"), join(repo.root, "independent")); writeFileSync(join(repo.root, "copy"), "foreign replacement");
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "worktree_path_changed" });
  assert.equal(repo.objects.denials().length, 0); assert.equal(readFileSync(join(repo.root, "copy"), "utf8"), "foreign replacement");
  rmSync(join(repo.root, "copy"));
  repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.deepEqual(readFileSync(join(repo.root, "independent")), bytes);
});

test("native output registry rejects foreign shapes and paths, and denies sources before mutation", async () => {
  const { repo, entry } = await fixture();
  const valid = { path: "copy", id: entry.id, birth: "1:2:3", complete: true, objects: [entry.id] };
  for (const value of [null, {}, [null], ...[{ complete: 1 }, { unknown: "foreign" }, { complete: undefined }, { path: undefined }, { id: "bad" }, { birth: 1 }, { birth: "bad" }, { objects: "bad" }, { objects: [1] }, { objects: ["bad"] }, { fileId: 1 }].map(fields => [{ ...valid, ...fields }]), [valid, valid], [{ path: "../foreign", id: entry.id, birth: "1:2:3", complete: true, objects: [entry.id] }], [{ path: "copy", id: entry.id, birth: "1:2:3", complete: true, objects: [] }], [{ path: "copy", id: entry.id, birth: "1:2:3", complete: true, objects: [entry.id], fileId: "bad" }]]) {
    writePrivateJson(join(repo.controlDirectory, "outputs.json"), value);
    assert.throws(() => nativeOutputs(repo.controlDirectory), { code: "unsupported_erasure_storage" });
  }
  writePrivateJson(join(repo.controlDirectory, "outputs.json"), []);
  assert.throws(() => recordNativeOutput(repo.controlDirectory, repo.objects, "copy", Buffer.from("safe"), { objects: [entry.id], fileId: "bad" }), { code: "invalid_file_id" });
  const safeSource = repo.objects.write("blob", Buffer.from("safe unrelated content"));
  assert.throws(() => recordNativeOutput(repo.controlDirectory, repo.objects, "copy", Buffer.from("safe"), { objects: [] }), { code: "unsupported_erasure_storage" });
  repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  const mutation = new WorktreeMutation(repo.root, ".pmvcs", repo.objects);
  try { assert.throws(() => mutation.write("copy", Buffer.from("safe"), 0o644, { objects: [entry.id] }), { code: "object_obliterated" }); } finally { mutation.close(); }
  const denied = new WorktreeMutation(repo.root, ".pmvcs", repo.objects);
  try { assert.throws(() => denied.write("denied-file", Buffer.from("safe unrelated content"), 0o644, { objects: [safeSource], fileId: entry.fileId }), { code: "file_obliterated" }); } finally { denied.close(); }
  assert.equal(existsSync(join(repo.root, "denied-file")), false);
  const allowed = new WorktreeMutation(repo.root, ".pmvcs", repo.objects);
  try { repo.objects.withWriteLock(() => allowed.write("safe-file", Buffer.from("safe unrelated content"), 0o644, { objects: [safeSource], fileId: "f".repeat(32) })); } finally { allowed.close(); }
  assert.equal(readFileSync(join(repo.root, "safe-file"), "utf8"), "safe unrelated content");
  assert.equal(existsSync(join(repo.root, "copy")), false);
});

test("legacy native record renderings and resolved layer sources remain part of erasure provenance", async () => {
  const { repo, entry } = await fixture();
  const document = { id: "fixture-item", title: "Native secret", description: "selected", type: "task", status: "open", priority: "medium", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", body: "selected record body" };
  const record = repo.objects.write("record", encodeRecord(document), entry.fileId);
  const rendered = renderWorkingRecord("record.toon", document);
  const blob = repo.objects.write("blob", rendered);
  repo.addLayer("resolved", new Map([["resolved.toon", { content: rendered, executable: false, source: record }]]));
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "erasure_layer_conflict" });
  repo.removeLayer("resolved");
  // Released snapshots predate output-source records; retain the real legacy renderer fixture.
  writePrivateJson(join(repo.controlDirectory, "outputs.json"), []);
  const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.ok(receipt.removed.includes(blob)); assert.throws(() => repo.objects.read(blob), { code: "object_obliterated" });
});


test("native signed and empty archive outputs use their actual producer inventories", async () => {
  const { repo, entry, tip, scratch } = await fixture();
  const keys = generateKeyPairSync("ed25519"); let objects: readonly string[] = [];
  const signed = join(repo.root, "signed.bundle");
  writeBundleFile(repo, signed, () => exportChangeBundle(repo.objects, { "refs/heads/review": tip }, { paths: ["asset"], refs: ["refs/heads/review"] }, "fixture", keys.privateKey, included => { objects = included; }), () => objects, true);
  const sources = managedExports(repo.controlDirectory)[0].objects;
  assert.throws(() => writeBundleFile(repo, signed, () => Buffer.from("user"), () => [entry.id], true), { code: "export_path_owned" });
  const external = join(scratch, "external.signed");
  writeBundleFile(repo, external, () => Buffer.from("external user transport"), () => [entry.id], true);
  assert.throws(() => writeBundleFile(repo, external, () => Buffer.from("replacement"), () => [entry.id], true), { code: "EEXIST" });
  assert.throws(() => writeBundleFile(repo, join(repo.root, "invalid.bundle"), () => Buffer.from("invalid"), () => ["invalid"]), { code: "unsupported_erasure_storage" });
  const empty = join(repo.root, "empty.bundle"); writeBundleFile(repo, empty, () => serializeBundle(repo.objects, { refs: {}, prerequisites: [], objects: [] }));
  repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.equal(existsSync(signed), false); assert.ok(sources.includes(entry.id)); assert.equal(existsSync(empty), true); assert.equal(existsSync(external), true);
});


test("current selected FileId ownership still erases edits to a natively materialized indexed file", async () => {
  const { repo, entry, tip } = await fixture(); repo.restore(["asset"], tip);
  writeFileSync(join(repo.root, "asset"), "new working edits to the selected identity");
  repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.equal(existsSync(join(repo.root, "asset")), false);
  assert.deepEqual(nativeOutputs(repo.controlDirectory), []);
});


test("resolved layer sources reject invalid or denied identities before snapshot publication", async () => {
  const { repo, entry } = await fixture();
  assert.throws(() => repo.addLayer("invalid", new Map([["private", { content: Buffer.from("safe"), executable: false, source: "bad" }]])), { code: "bad_layers" });
  assert.equal(existsSync(join(repo.controlDirectory, "layers.json")), false);
  for (const source of [1, "bad"]) {
    writePrivateJson(join(repo.controlDirectory, "layers.json"), [{ name: "invalid", files: [{ path: "private", content: Buffer.from("safe").toString("base64"), executable: false, source }] }]);
    assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "bad_layers" });
    assert.equal(repo.objects.denials().length, 0);
  }
  writePrivateJson(join(repo.controlDirectory, "layers.json"), []);
  repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
  assert.throws(() => repo.addLayer("denied", new Map([["private", { content: Buffer.from("safe"), executable: false, source: entry.id }]])), { code: "object_obliterated" });
  assert.equal(existsSync(join(repo.root, "private")), false);
});


test("repository log append cannot race erasure completion through another repository handle", async () => {
  const { repo, entry, bytes } = await fixture(); const summary = bytes.toString("hex");
  const script = `import { Repository } from ${JSON.stringify(new URL("../engine/repo.ts", import.meta.url).href)};
    try { Repository.open(process.argv[1]).operations.append("peer-summary", process.argv[2], [], new Date(1)); }
    catch(error) { process.stderr.write(JSON.stringify({code:error.code})); process.exitCode=1; }`;
  let peer: ReturnType<typeof spawnSync> | undefined;
  erasureScanBoundary.visit = step => {
    if (step === "storage-verified") peer = spawnSync(process.execPath, ["--input-type=module", "-e", script, repo.root, summary], { env: { ...testEnvironment(), ...discardChildCoverage() }, encoding: "utf8", timeout: 15000 });
  };
  try { repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)); }
  finally { erasureScanBoundary.visit = () => {}; }
  assert.equal(repo.operations.read().some(operation => operation.summary === summary), false);
  assert.ok(peer); assert.equal(peer.signal, null); assert.equal(peer.status, 1, String(peer.stderr));
  assert.equal(JSON.parse(String(peer.stderr)).code, "store_locked");
});
