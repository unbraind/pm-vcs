import { createServer } from "node:http";
import { HttpTransport } from "../engine/http-transport.ts";
import { FileTransport } from "../engine/transport.ts";
import { inspectClosure } from "../engine/closure.ts";
import { parseTokenText, startRepositoryServer } from "../engine/serve.ts";
import { syncBuiltinESMExports } from "node:module";
import { assertWireSuccess } from "../engine/http-protocol.ts";
/** Real filesystem validation at manifest, frame and lease trust boundaries. */
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, test, mock } from "node:test";
import { parseFileLease, parseLeaseRequest, parseLeaseProofs, PublicationLeases, filesystemPrincipal, PublicationLeaseError, type FileLease } from "../engine/publication-leases.ts";
import { SharedObjectStore } from "../engine/instances.ts";
import { configureAuthority } from "../engine/composition.ts";
import { ObjectStore as BuiltObjectStore } from "../dist/engine/objects.js";
import { readFragmentedToFile, readFragmentRange, writeFragmentedFile } from "../engine/fragments.ts";
import { ObjectStore, hashObject } from "../engine/objects.ts";
import { objectPayloadChunks, objectPayloadLines } from "../engine/object-stream.ts";
import { ManifestWriter, assertManifestChild, assertManifestRoot, materializeManifest, manifestHeader, manifestFragments } from "../engine/manifest-pages.ts";
import { encodeManifest, decodeManifest, writeTree, writeCommit, type FragmentManifest } from "../engine/model.ts";
import { remoteLeaseProofs, changeRemoteLease } from "../engine/lease-workflows.ts";
import { Repository } from "../engine/repo.ts";
import { makeTempDir } from "./helpers/tmp.ts";
const dirs: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) dir.cleanup(); });
/** Stand up a real receiver state directory. */
function fixture() { const dir = makeTempDir(); dirs.push(dir); const repo = Repository.init(dir.root); return { dir, repo, leases: new PublicationLeases(repo.objects, repo.controlDirectory) }; }
const fileId = "1".repeat(32);
const lease: FileLease = { fileId, token: "1:" + "2".repeat(32), holder: "principal", expiry: 1, generation: 1, refs: ["refs/heads/main"], active: true };

test("lease JSON boundaries reject malformed states, requests and fencing proofs", () => {
  for (const value of [null, 0, [], {}, ...Object.entries({ fileId: "bad", holder: 1, active: null, expiry: 1.5, generation: 0, token: "bad", refs: [] }).map(([key, value]) => ({ ...lease, [key]: value })),
    { ...lease, fileId: 1 }, { ...lease, generation: 1.5 }, { ...lease, token: 1 }, { ...lease, token: "2:" + "2".repeat(32) },
    { ...lease, refs: null }, { ...lease, refs: [1] }, { ...lease, refs: ["refs/../main"] }, { ...lease, refs: Array.from({ length: 129 }, () => "refs/heads/main") }]) assert.equal(parseFileLease(value), null);
  assert.deepEqual(parseFileLease(lease), lease);
  assert.deepEqual(parseLeaseRequest({ action: "inspect", fileId }), { action: "inspect", fileId, token: undefined, ttlMs: undefined, refs: undefined });
  for (const value of [{ action: "bad", fileId }, { action: "inspect", fileId: 0 }, { action: "release", fileId, token: 1 },
    { action: "acquire", fileId, ttlMs: "10" }, { action: "acquire", fileId, refs: false }, { action: "acquire", fileId, refs: [1] }]) assert.throws(() => parseLeaseRequest(value), { code: "bad_request" });
  assert.deepEqual(parseLeaseProofs(undefined), []); assert.deepEqual(parseLeaseProofs([lease]), [{ fileId, token: lease.token }]);
  for (const value of [null, 1, Array.from({ length: 100001 }, () => null), [null], [1], [{}], [{ fileId, token: 1 }]]) assert.throws(() => parseLeaseProofs(value), { code: "bad_request" });
  assert.throws(() => parseLeaseProofs([{ fileId: "bad", token: "proof" }]), { code: "invalid_file_id" });
});

test("durable lease authority refuses invalid scopes, lifetimes, state corruption and stale ownership", () => {
  const { repo, leases } = fixture();
  assert.equal(leases.change({ action: "inspect", fileId }), null);
  assert.throws(() => leases.change({ action: "invalid" as "inspect", fileId }), { code: "bad_request" });
  assert.throws(() => leases.inspect("bad"), { code: "invalid_file_id" });
  for (const refs of [undefined, [], Array.from({ length: 129 }, () => "refs/heads/main")]) assert.throws(() => leases.change({ action: "acquire", fileId, refs, ttlMs: 10 }), { code: "invalid_lease_scope" });
  assert.throws(() => leases.change({ action: "acquire", fileId, refs: ["../bad"], ttlMs: 10 }), { code: "invalid_ref_name" });
  for (const ttlMs of [undefined, 0, 1.5, 86400001]) assert.throws(() => leases.change({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs }), { code: "invalid_lease_duration" });
  const active = leases.change({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 60000 })!;
  assert.throws(() => leases.change({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 10 }), { code: "lease_held" });
  assert.throws(() => leases.change({ action: "renew", fileId, ttlMs: 10 }), { code: "lease_missing" });
  assert.throws(() => leases.change({ action: "renew", fileId, token: "stale", ttlMs: 10 }), { code: "lease_fenced" });
  const other = new PublicationLeases(repo.objects, repo.controlDirectory, { principal: "another", breakLeases: false });
  assert.throws(() => other.change({ action: "release", fileId, token: active.token }), { code: "lease_wrong_principal" });
  leases.change({ action: "break", fileId }); assert.throws(() => leases.change({ action: "release", fileId, token: active.token }), { code: "lease_missing" });
  const audit = join(repo.controlDirectory, "leases", `${fileId}.jsonl`); const original = readFileSync(audit, "utf8");
  for (const text of ["", "{bad}\n", original.trimEnd(), '{"lease":{}}\n', original + JSON.stringify({ action: "renew", actor: "actor", at: 1, lease: { ...active, generation: 4, token: "4:" + "2".repeat(32) } }) + "\n"]) {
    writeFileSync(audit, text); assert.throws(() => leases.inspect(fileId), { code: "corrupt_lease_audit" });
  }
  rmSync(audit); mkdirSync(audit); assert.throws(() => leases.inspect(fileId));
});

test("private proof registry corruption fails closed without changing remote state", async () => {
  const { repo } = fixture();
  assert.deepEqual(remoteLeaseProofs(repo, "constructor"), []);
  const path = join(repo.controlDirectory, "lease-proofs.json");
  for (const value of [null, [], "bad"]) { writeFileSync(path, JSON.stringify(value)); assert.throws(() => remoteLeaseProofs(repo, "origin"), { code: "corrupt_lease_proofs" }); }
  writeFileSync(path, "{}"); await assert.rejects(changeRemoteLease(repo, "missing", { action: "inspect", fileId }), { code: "unknown_remote" });
});

test("bounded object reads reject wrong type, corruption and missing addresses", () => {
  const { repo } = fixture(); const id = repo.objects.write("blob", Buffer.from("bytes"));
  assert.deepEqual(repo.objects.readBoundedTyped(id, "blob"), Buffer.from("bytes"));
  assert.throws(() => repo.objects.readBoundedTyped(id, "manifest"), { code: "object_type_mismatch" });
  assert.throws(() => repo.objects.readBoundedTyped("0".repeat(64), "blob"), { code: "object_not_found" });
  assert.throws(() => repo.objects.readBoundedTyped("bad", "blob"), { code: "invalid_object_id" });
  const path = join(repo.controlDirectory, "objects", id.slice(0, 2), id.slice(2));
  writeFileSync(path, deflateSync(Buffer.from("blob 5\0other"))); assert.throws(() => repo.objects.readBoundedTyped(id, "blob"), { code: "corrupt_object" });
  writeFileSync(path, "broken"); assert.throws(() => repo.objects.readBoundedTyped(id, "blob"), { code: "corrupt_object" });
});

test("bounded line decoder retains one partial line and rejects overlong or unterminated metadata", () => {
  assert.deepEqual([...objectPayloadLines([Buffer.from("ab"), Buffer.from("c\ndef\n")])], ["abc", "def"]);
  assert.deepEqual([...objectPayloadLines([])], []);
  for (const content of ["x".repeat(129), "x".repeat(129) + "\n", "unterminated"]) assert.throws(() => [...objectPayloadLines([Buffer.from(content)])], { code: "malformed_object" });
});

test("real decompression verifies framing, payload length, type and hash and preserves filesystem errors", () => {
  const { dir } = fixture(); const path = join(dir.root, "frame"); const id = hashObject("blob", Buffer.from("x"));
  const collect = () => Buffer.concat([...objectPayloadChunks(path, id, "blob")]);
  writeFileSync(path, deflateSync(Buffer.from("blob 1\0x"))); assert.deepEqual(collect(), Buffer.from("x"));
  for (const frame of ["bad", "invalid 1\0x", "blob 01\0x", "blob 2\0x", "blob 0\0x", "x".repeat(33) + "\0x", "blob 9007199254740992\0x"]) {
    writeFileSync(path, deflateSync(Buffer.from(frame))); assert.throws(collect);
  }
  writeFileSync(path, deflateSync(Buffer.from("blob 1\0y"))); assert.throws(collect, { code: "corrupt_object" });
  writeFileSync(path, "corrupt zlib"); assert.throws(collect, { code: "corrupt_object" });
  rmSync(path); assert.throws(collect, { code: "object_not_found" });
  mkdirSync(path); assert.throws(collect, { code: "EISDIR" });
});

test("manifest nodes reject unsafe counts, shape ambiguity, height and mode mismatches", () => {
  const { repo } = fixture(); const blob = repo.objects.write("blob", Buffer.from("x"));
  const valid: FragmentManifest = { totalLength: 129, fragments: [], height: 1, pages: [{ id: blob, length: 128, count: 128 }, { id: blob, length: 1, count: 1 }] };
  const badNodes: FragmentManifest[] = [
    { ...valid, height: undefined }, { ...valid, height: 0 }, { ...valid, height: 1.5 }, { ...valid, height: 8 },
    { ...valid, fragments: [{ id: blob, length: 1 }] }, { ...valid, totalLength: 0 }, { ...valid, totalLength: 1.5 },
    { ...valid, mode: "bad" as "fixed" }, { ...valid, height: 1, pages: Array.from({ length: 129 }, () => valid.pages![0]) },
    { ...valid, totalLength: 128 }, { ...valid, pages: [{ id: "bad", length: 129, count: 129 }] },
    { ...valid, pages: [{ id: blob, length: 1.5, count: 1 }] }, { ...valid, pages: [{ id: blob, length: 0, count: 1 }] },
    { ...valid, pages: [{ id: blob, length: 129, count: 0 }] }, { ...valid, pages: [{ id: blob, length: 129, count: 1.5 }] },
    { ...valid, pages: [{ id: blob, length: 129, count: 129 }] },
    { ...valid, pages: [{ id: blob, length: 128, count: 1 }, valid.pages![1]] },
    { ...valid, height: 7, totalLength: Number.MAX_SAFE_INTEGER, pages: [{ id: blob, length: Number.MAX_SAFE_INTEGER, count: Number.MAX_SAFE_INTEGER }, { id: blob, length: 1, count: 1 }] },
  ];
  for (const node of badNodes) assert.throws(() => encodeManifest(node), { code: "invalid_manifest" });
  const leaf = { totalLength: 128, fragments: Array.from({ length: 128 }, () => ({ id: blob, length: 1 })) };
  assertManifestChild(valid, valid.pages![0], leaf);
  for (const child of [{ ...leaf, height: 2 }, { ...leaf, totalLength: 129 }, { ...leaf, fragments: [] }, { ...leaf, mode: "cdc" as const }, { ...leaf, fragments: [...leaf.fragments, leaf.fragments[0]] }]) {
    assert.throws(() => assertManifestChild(valid, valid.pages![0], child), { code: "invalid_manifest" });
  }
  const writer = new ManifestWriter(); assert.throws(() => writer.add({ id: blob, length: Number.MAX_SAFE_INTEGER + 1 }), { code: "invalid_manifest" });
});

test("legacy streaming validates all canonical lines including unused metadata after a requested range", () => {
  const { repo } = fixture(); const blob = repo.objects.write("blob", Buffer.from("x"));
  const prefix = `pm-vcs-manifest 1\ntotal 300\n`;
  const lines = `frag ${blob} 1\n`.repeat(300);
  const id = repo.objects.write("manifest", Buffer.from(prefix + lines));
  assert.equal(manifestHeader(repo.objects, id).legacyStream, true);
  assert.equal([...manifestFragments(repo.objects, id, 0, 1)].length, 1);
  for (const payload of [prefix + "mode cdc\n" + lines, prefix + lines]) {
    const root = repo.objects.write("manifest", Buffer.from(payload)); assert.equal([...manifestFragments(repo.objects, root, 300, 300)].length, 0);
  }
  for (const payload of [prefix + lines + "unknown bad\n", prefix + lines.slice(0, -1), prefix + lines.replace(" 1\n", " 0\n"), prefix.replace("300", "0300") + lines, prefix.replace("300", "301") + lines,
    "pm-vcs-manifest 2\ntotal 300\n" + lines, "pm-vcs-manifest 1\n" + "frag " + blob + " 1\n".repeat(400),
    "pm-vcs-manifest 1\ntotal 9007199254740992\n" + lines]) {
    const root = repo.objects.write("manifest", Buffer.from(payload)); assert.throws(() => [...manifestFragments(repo.objects, root)], { code: "malformed_object" });
  }
});

test("object stream deadline refuses an expired synchronous decode step and cleans it up", () => {
  const { dir } = fixture(); const path = join(dir.root, "stream");
  writeFileSync(path, deflateSync(Buffer.from("blob 1\0x")));
  assert.throws(() => [...objectPayloadChunks(path, hashObject("blob", Buffer.from("x")), "blob", 0)], { code: "object_stream_timeout" });
});


test("compiled compatibility decoder and shared instances retain stream verification and actionable absence", () => {
  const { dir } = fixture(); const store = new BuiltObjectStore(join(dir.root, "compiled"));
  const blob = store.write("blob", Buffer.from("x"));
  const manifest = store.write("manifest", Buffer.from(`pm-vcs-manifest 1\ntotal 300\n` + `frag ${blob} 1\n`.repeat(300)));
  assert.equal([...store.readLines(manifest, "manifest")].length, 302);
  const shared = new SharedObjectStore(join(dir.root, "shared"));
  assert.throws(() => shared.readBoundedTyped("0".repeat(64), "manifest"), { code: "missing_fragment" });
  assert.throws(() => [...shared.readLines("0".repeat(64), "manifest")], { code: "missing_fragment" });
  assert.throws(() => shared.readBoundedTyped("bad", "manifest"), { code: "invalid_object_id" });
  assert.throws(() => [...shared.readLines("bad", "manifest")], { code: "invalid_object_id" });
  const id = shared.write("blob", Buffer.from("x"));
  assert.deepEqual(shared.readBoundedTyped(id, "blob"), Buffer.from("x"));
  assert.deepEqual([...shared.readLines(shared.write("blob", Buffer.from("x\n")), "blob")], ["x"]);
});

test("paged erasure includes child nodes and inspects durable lease audit storage", () => {
  const { dir, repo, leases } = fixture();
  configureAuthority(repo.controlDirectory, "fixture", "read-fixture", "erase-fixture");
  const source = join(dir.root, "asset"); writeFileSync(source, Buffer.alloc(516, 90));
  repo.stage(["asset"]); const stable = repo.readIndex()[0].fileId!;
  const result = writeFragmentedFile(repo.objects, source, 4, stable);
  const tree = writeTree(repo.objects, [{ name: "asset", mode: "100644", id: result.manifestId, fileId: stable }]);
  const author = { name: "Author", email: "author@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
  const commit = writeCommit(repo.objects, { tree, parents: [], author, committer: author, message: "paged" });
  repo.refs.compareAndSwap("refs/heads/main", null, commit);
  leases.change({ action: "acquire", fileId: stable, refs: ["refs/heads/main"], ttlMs: 60000 });
  const auditDir = join(repo.controlDirectory, "leases"); const audit = join(auditDir, `${stable}.jsonl`); const text = readFileSync(audit, "utf8");
  const erase = () => repo.obliterate(stable, "erase-fixture", "incident", new Date());
  writeFileSync(audit, text + '"ZZZZ"\n'); assert.throws(erase, { code: "unsupported_erasure_storage" }); writeFileSync(audit, text);
  const extra = join(auditDir, "unknown"); writeFileSync(extra, "unknown"); assert.throws(erase, { code: "unsupported_erasure_storage" }); rmSync(extra);
  symlinkSync(audit, extra); assert.throws(erase, { code: "unsupported_erasure_storage" }); rmSync(extra);
  rmSync(auditDir, { recursive: true }); writeFileSync(auditDir, "invalid directory"); assert.throws(erase, { code: "unsupported_erasure_storage" }); rmSync(auditDir);
  mkdirSync(auditDir); writeFileSync(audit, text);
  const receipt = erase(); assert.ok(receipt.removed.includes(result.manifestId));
  for (const page of result.manifest.pages!) assert.ok(receipt.removed.includes(page.id));
  assert.throws(() => repo.objects.readBoundedTyped(result.manifestId, "manifest"), { code: "object_obliterated" });
  assert.throws(() => [...repo.objects.readLines(result.manifestId, "manifest")], { code: "object_obliterated" });
});

test("native restore coalesces small fragments, handles larger payloads and ranges avoid per-fragment buffer lists", () => {
  const { dir, repo } = fixture(); const source = join(dir.root, "source");
  const bytes = Buffer.alloc(200000, 65); bytes[199999] = 66; writeFileSync(source, bytes);
  for (const size of [32769, 100000]) {
    const result = writeFragmentedFile(repo.objects, source, size);
    const destination = join(dir.root, String(size)); readFragmentedToFile(repo.objects, result.manifestId, destination);
    assert.deepEqual(readFileSync(destination), bytes); assert.deepEqual(readFragmentRange(repo.objects, result.manifestId, 0, bytes.length), bytes);
  }
});


test("minimal root heights, large CDC convenience materialization and exhausted generations fail explicitly", () => {
  const { repo, leases } = fixture(); const blob = repo.objects.write("blob", Buffer.from("x"));
  const leaf = { totalLength: 128, fragments: Array.from({ length: 128 }, () => ({ id: blob, length: 1 })) };
  const leafId = repo.objects.write("manifest", encodeManifest(leaf));
  const redundant: FragmentManifest = { totalLength: 128, fragments: [], height: 1, pages: [{ id: leafId, length: 128, count: 128 }] };
  const id = repo.objects.write("manifest", encodeManifest(redundant));
  assert.throws(() => manifestHeader(repo.objects, id), { code: "invalid_manifest" });
  assert.throws(() => assertManifestRoot(redundant), { code: "invalid_manifest" });
  const writer = new ManifestWriter(repo.objects, undefined, "cdc");
  for (let i = 0; i < 129; i++) writer.add({ id: blob, length: 1 });
  const root = writer.finish(); assert.equal(materializeManifest(repo.objects, root.manifestId).mode, "cdc");
  assert.throws(() => writer.finish(), { code: "invalid_manifest" });
  leases.change({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 1 });
  const audit = join(repo.controlDirectory, "leases", `${fileId}.jsonl`);
  const maximum = { ...lease, generation: Number.MAX_SAFE_INTEGER, token: `${Number.MAX_SAFE_INTEGER}:` + "2".repeat(32), active: false };
  writeFileSync(audit, JSON.stringify({ action: "acquire", actor: "fixture", at: 1, lease: maximum }) + "\n");
  assert.throws(() => leases.change({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 1 }), { code: "lease_generation_exhausted" });
});


test("explicit full legacy encode/decode handles lists larger than the call-argument limit", () => {
  const { repo } = fixture(); const blob = repo.objects.write("blob", Buffer.from("x"));
  const node = { totalLength: 200000, fragments: Array.from({ length: 200000 }, () => ({ id: blob, length: 1 })) };
  const payload = encodeManifest(node); const decoded = decodeManifest(payload);
  assert.equal(decoded.fragments.length, 200000); assert.deepEqual(encodeManifest(decoded), payload);
  for (const invalid of [{ totalLength: Number.MAX_SAFE_INTEGER + 1, fragments: [] }, { totalLength: Number.MAX_SAFE_INTEGER + 1, fragments: [{ id: blob, length: Number.MAX_SAFE_INTEGER + 1 }] }]) {
    assert.throws(() => encodeManifest(invalid), { code: "invalid_manifest" });
  }
});


test("wire refusals preserve absence and reject malformed diagnostic shapes", () => {
  const typed = { code: "lease_missing", message: "missing", reason: "missing", fileId, holder: null, expiry: null };
  assert.throws(() => assertWireSuccess(409, Buffer.from(JSON.stringify({ error: typed })), "http://example.invalid"), error => error instanceof PublicationLeaseError && error.holder === null && error.expiry === null);
  for (const overrides of [{ fileId: 1 }, { holder: 1 }, { expiry: "bad" }, { holder: "holder", expiry: 1 }]) {
    assert.throws(() => assertWireSuccess(409, Buffer.from(JSON.stringify({ error: { ...typed, ...overrides } })), "http://example.invalid"), { code: "lease_missing" });
  }
});

test("bounded readers retain actual filesystem errors and refuse descriptor truncation", () => {
  const { repo } = fixture(); const id = repo.objects.write("blob", Buffer.from("bytes"));
  const path = join(repo.controlDirectory, "objects", id.slice(0, 2), id.slice(2));
  rmSync(path); mkdirSync(path); assert.throws(() => repo.objects.readBoundedTyped(id, "blob")); rmSync(path, { recursive: true });
  repo.objects.write("blob", Buffer.from("bytes"));
  const original = fs.fstatSync;
  mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
    const stat = original(...args); fs.truncateSync(path); return stat;
  }); syncBuiltinESMExports();
  try { assert.throws(() => repo.objects.readBoundedTyped(id, "blob"), { code: "corrupt_object" }); } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
  Reflect.deleteProperty(process, "getuid");
  try { assert.equal(filesystemPrincipal().principal, "filesystem:local"); } finally { Object.defineProperty(process, "getuid", descriptor); }
});

test("legacy traversal independently validates marker, total and unsafe fragment arithmetic", () => {
  const { repo } = fixture(); const blob = repo.objects.write("blob", Buffer.from("x"));
  const header = { totalLength: 300, fragments: [], legacyStream: true };
  for (const text of ["bad\ntotal 0\n", "pm-vcs-manifest 1\nbad\n", "pm-vcs-manifest 1\ntotal 9007199254740992\n", "pm-vcs-manifest 1\ntotal 300\nfrag " + blob + " 9007199254740992\n",
    "pm-vcs-manifest 1\ntotal 300\nfrag " + blob + " 9007199254740991\nfrag " + blob + " 1\n", "pm-vcs-manifest 1\n"]) {
    const id = repo.objects.write("manifest", Buffer.from(text));
    assert.throws(() => [...manifestFragments(repo.objects, id, 0, 300, header)], { code: "malformed_object" });
  }
});


test("verified decompression accepts a valid frame header split across actual filesystem input chunks", () => {
  const { dir } = fixture(); const path = join(dir.root, "blocks"); const frame = Buffer.from("blob 1\0x");
  /** Encode one aligned RFC 1951 stored block for a real zlib stream. */
  const block = (bytes: Buffer, final = false): Buffer => {
    const header = Buffer.alloc(5); header[0] = final ? 1 : 0; header.writeUInt16LE(bytes.length, 1); header.writeUInt16LE(65535 - bytes.length, 3);
    return Buffer.concat([header, bytes]);
  };
  let a = 1, b = 0; for (const byte of frame) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(b * 65536 + a);
  const bytes = Buffer.concat([Buffer.from([0x78, 1]), block(frame.subarray(0, 1)), ...Array.from({ length: 4000 }, () => block(Buffer.alloc(0))), block(frame.subarray(1), true), checksum]);
  writeFileSync(path, bytes);
  assert.deepEqual(Buffer.concat([...objectPayloadChunks(path, hashObject("blob", Buffer.from("x")), "blob")]), Buffer.from("x"));
  for (const frame of ["", "x".repeat(60)]) {
    writeFileSync(path, deflateSync(Buffer.from(frame))); assert.throws(() => [...objectPayloadChunks(path, "0".repeat(64), "blob")], { code: "malformed_object" });
  }
});

test("flat convenience decoding rejects unsafe total and fragment lengths", () => {
  const { repo } = fixture(); const blob = repo.objects.write("blob", Buffer.from("x"));
  for (const payload of [`pm-vcs-manifest 1\ntotal 9007199254740992\n`, `pm-vcs-manifest 1\ntotal 300\nfrag ${blob} 9007199254740992\n`]) {
    assert.throws(() => decodeManifest(Buffer.from(payload)), { code: "malformed_object" });
  }
});


test("explicit HTTP lease workflows save proofs and inspect absent state through a real receiver", async () => {
  const { dir, repo } = fixture(); const receiver = Repository.init(join(dir.root, "remote"));
  const server = await startRepositoryServer({ root: receiver.root, host: "127.0.0.1", port: 0, unauthenticatedWrites: true });
  try {
    repo.remotes.add("http", `http://127.0.0.1:${server.port}`);
    assert.equal(await changeRemoteLease(repo, "http", { action: "inspect", fileId }), null);
    await changeRemoteLease(repo, "http", { action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 60000 });
    assert.equal(remoteLeaseProofs(repo, "http").length, 1);
    await changeRemoteLease(repo, "http", { action: "release", fileId }); assert.deepEqual(remoteLeaseProofs(repo, "http"), []);
  } finally { await server.close(); }
});


test("full promoted nodes collapse to their canonical root and finalized writers reject reuse", () => {
  const { repo } = fixture(); const blob = repo.objects.write("blob", Buffer.from("x"));
  for (const count of [0, 128, 16384]) {
    const writer = new ManifestWriter(repo.objects);
    for (let i = 0; i < count; i++) writer.add({ id: blob, length: 1 });
    const root = writer.finish(); assert.equal(root.manifest.totalLength, count);
    assert.equal(manifestHeader(repo.objects, root.manifestId).height ?? 0, count === 16384 ? 1 : 0);
    assert.throws(() => writer.finish(), { code: "invalid_manifest" });
    assert.throws(() => writer.add({ id: blob, length: 1 }), { code: "invalid_manifest" });
  }
  const writer = new ManifestWriter();
  for (const fragment of [{ id: "bad", length: 1 }, { id: blob, length: 0 }, { id: blob, length: 1.5 }]) assert.throws(() => writer.add(fragment), { code: "invalid_manifest" });
  writer.add({ id: blob, length: Number.MAX_SAFE_INTEGER }); assert.throws(() => writer.add({ id: blob, length: 1 }), { code: "invalid_manifest" });
  assert.equal(writer.finish().manifest.totalLength, Number.MAX_SAFE_INTEGER);
});


test("receiver boundaries preserve empty traversal, malformed grants and lease response refusals", async () => {
  const { dir, repo } = fixture();
  const root = repo.objects.write("manifest", encodeManifest({ totalLength: 0, fragments: [] }));
  assert.deepEqual([...manifestFragments(repo.objects, root, 0, 0)], []);
  const child = repo.objects.write("blob", Buffer.from("x"));
  const wrong = repo.objects.write("manifest", encodeManifest({ totalLength: 2, fragments: [{ id: child, length: 2 }] }));
  const tree = writeTree(repo.objects, [{ name: "asset", mode: "100644", id: wrong, fileId }]);
  const signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
  const tip = writeCommit(repo.objects, { tree, parents: [], author: signature, committer: signature, message: "invalid length" });
  assert.match(inspectClosure(repo.objects, [tip]).corrupt.join(" "), /fragment_length_mismatch/);
  for (const fields of [{ principal: 1 }, { principal: "" }, { breakLeases: "true" }]) {
    assert.equal(parseTokenText(JSON.stringify([{ token: "fixture", repository: "", access: "write", ...fields }])), null);
  }
  assert.deepEqual(parseTokenText(JSON.stringify([{ token: "fixture", repository: "", access: "write", principal: "receiver", breakLeases: true }]))?.[0].principal, "receiver");
  const server = createServer(async (request, response) => {
    request.resume();
    response.end(JSON.stringify(request.url === "/advertise"
      ? await new FileTransport("fixture", repo.root).advertise() : { lease: {} }));
  });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert.ok(address !== null && typeof address === "object");
    await assert.rejects(new HttpTransport(`http://127.0.0.1:${address.port}`).lease({ action: "inspect", fileId }), { code: "unreachable_remote" });
  } finally { await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); }); }
  const loop = join(repo.controlDirectory, "objects", child.slice(0, 2), child.slice(2));
  rmSync(loop); symlinkSync(loop, loop);
  assert.throws(() => repo.objects.readBoundedTyped(child, "blob"), { code: "ELOOP" });
  writeFileSync(join(repo.controlDirectory, "config.json"), "bad");
  await assert.rejects(new FileTransport(repo.root, dir.root).lease({ action: "inspect", fileId }), { code: "bad_config" });
});


test("linked receivers publish under the hub's durable FileId lease authority", async () => {
  const { dir } = fixture();
  const hub = Repository.init(join(dir.root, "hub"));
  writeFileSync(join(hub.root, "asset"), "shared leased content"); hub.stage(["asset"]);
  const signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
  const tip = hub.commit({ message: "shared", author: signature }, new Date());
  const stable = hub.readIndex()[0].fileId!;
  const linkedRoot = join(dir.root, "linked"); hub.linkInstance("linked", linkedRoot);
  const linked = Repository.open(linkedRoot); const wire = new FileTransport(linkedRoot, linkedRoot);
  const scope = "refs/heads/published";
  const acquired = await wire.lease({ action: "acquire", fileId: stable, refs: [scope], ttlMs: 60000 });
  assert.ok(acquired);
  assert.equal(new PublicationLeases(hub.objects, hub.controlDirectory).inspect(stable)?.token, acquired.token);
  await wire.publish([{ ref: scope, expected: null, next: tip }], false, new Date(), [{ fileId: stable, token: acquired.token }]);
  assert.equal(hub.refs.read(scope), tip); assert.equal(linked.refs.read(scope), tip);
  assert.equal(existsSync(join(linked.controlDirectory, "leases")), false);
  await wire.lease({ action: "release", fileId: stable, token: acquired.token });
  assert.equal(new PublicationLeases(hub.objects, hub.controlDirectory).inspect(stable)?.active, false);
});
