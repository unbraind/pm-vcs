import "./helpers/isolate-session.ts";
/** Native regressions for the remaining actionable pack/provenance review findings. */
import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import crypto, { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, mock, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { ObjectStore, hashObject } from "../engine/objects.ts";
import { derivations, provenanceLimits } from "../engine/derivations.ts";
import { objectFiles } from "../engine/object-files.ts";
import { VerificationRefusal } from "../engine/object-error.ts";
import { recordPayloadOwner } from "../engine/payload-owners.ts";
import { durability } from "../engine/durability.ts";
import { assertDestructionStorage, destructionBoundary, DestructionRefusal, prepareDestruction, prepareNamespaceDestruction } from "../engine/destruction.ts";
import { WorktreeMutation } from "../engine/worktree-mutation.ts";
import { recordNativeOutput, nativeOutputs } from "../engine/native-outputs.ts";
import { erasurePurge, planErasureStorage } from "../engine/erasure-accountability.ts";
import { erasureScanBoundary, fingerprintJournal } from "../engine/erasure-scan.ts";
import { validateErasureRequest } from "../engine/erasure.ts";
import { PublicationLeases } from "../engine/publication-leases.ts";
import { writeBundleFile } from "../engine/managed-exports.ts";
import { exportBundle } from "../engine/bundle.ts";
import { reachableObjects } from "../engine/reachability.ts";
import { encodeTree, encodeManifest } from "../engine/model.ts";
import { DEFAULT_CDC_PARAMS, cdcFragmentedFileContentId, readFragmented, readFragmentedToFile, writeFragmented, writeCdcFragmented, writeFragmentsFromFd, writeCdcFragmentsFromFd } from "../engine/fragments.ts";
import { benchmarkPhase6 } from "../scripts/phase6-benchmark.ts";
import { prepareControlPublication } from "./helpers/prepared-publication.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const dirs: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); destructionBoundary.visit = () => {}; erasureScanBoundary.visit = () => {}; for (const dir of dirs.splice(0)) dir.cleanup(); assert.equal(objectFiles.active.size, 0); });
/** Every SDK fixture is an independent non-git tracker. */
async function fixture() {
 const dir = makeTempDir(); dirs.push(dir);
 await new PmClient({ cwd: dir.root, pmRoot: join(dir.root, ".agents/pm"), noExtensions: true }).init("review-repair", { defaults: true, author: "fixture" });
 const repo = Repository.init(dir.root); writeFileSync(join(dir.root, "asset"), "selected review payload"); repo.stage(["asset"]);
 return { dir, repo, entry: repo.readIndex()[0]! };
}

test("closed raw, loose and packed owners cannot expose a descriptor reused by another file", async () => {
 const f = await fixture();
 for (const kind of ["raw", "loose", "packed"] as const) {
  if (kind === "packed") f.repo.objects.compact();
  const owner = kind === "raw" ? objectFiles.open(join(f.dir.root, "asset"), "r") : f.repo.objects.resolveLocation(f.entry.id)!;
  const retired = owner.fd; owner.close();
  const next = objectFiles.open(join(f.dir.root, "asset"), "r");
  try { assert.throws(() => owner.fd, { code: "object_handle_closed" }); assert.equal(fstatSync(next.fd).isFile(), true); if (next.fd === retired) assert.ok(true); }
  finally { next.close(); }
 }
});

test("an existing empty payload-owner edge is flushed along with its directory before reuse", async () => {
 const f = await fixture(); const id = "a".repeat(64); const fileId = "b".repeat(32); const directory = join(f.repo.controlDirectory, "payload-owners");
 mkdirSync(directory, { recursive: true }); const path = join(directory, `${id}.${fileId}`); writeFileSync(path, "");
 const file = durability.file; const directoryFlush = durability.directory; let flushed = false; let named = false;
 mock.method(durability, "file", (fd: number) => { if (fstatSync(fd).ino === fs.statSync(path).ino) flushed = true; file(fd); });
 mock.method(durability, "directory", (target: string) => { if (target === directory) named = true; directoryFlush(target); });
 recordPayloadOwner(f.repo.controlDirectory, id, fileId); assert.equal(flushed, true); assert.equal(named, true);
});

test("invalid direct payload ownership refuses before publishing provenance storage", () => {
 const dir = makeTempDir(); dirs.push(dir); const control = join(dir.root, "control"); mkdirSync(control);
 for (const fileId of ["", "wrong", "F".repeat(32)]) {
  assert.throws(() => recordPayloadOwner(control, "a".repeat(64), fileId), { code: "invalid_file_id" });
  assert.deepEqual(readdirSync(control), []);
 }
});

test("pending erasure refuses both fragment buffer and descriptor producers before any publication", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture");
 erasureScanBoundary.visit = step => { if (step === "pending") throw new Error("pending fragment preflight"); };
 assert.throws(() => f.repo.obliterate(f.entry.fileId!, "erase-fixture", "fragment-preflight", new Date(1)), /pending fragment preflight/);
 erasureScanBoundary.visit = () => {}; assert.equal(f.repo.objects.denials()[0].pending, true);
 const directory = join(f.repo.controlDirectory, "derivations"); const before = readdirSync(directory).sort();
 const source = objectFiles.open(join(f.dir.root, "asset"), "r");
 try {
  assert.throws(() => writeFragmented(f.repo.objects, Buffer.from("fresh independent bytes"), 8, "c".repeat(32)), { code: "erasure_incomplete" });
  assert.throws(() => writeFragmentsFromFd(f.repo.objects, source.fd, fstatSync(source.fd).size, 8, join(f.dir.root, "asset"), "c".repeat(32)), { code: "erasure_incomplete" });
 } finally { source.close(); }
 assert.deepEqual(readdirSync(directory).sort(), before);
});

test("fragment restore writes every byte across native short writes", async () => {
 const f = await fixture(); const bytes = Buffer.alloc(70_000, 97); const result = writeFragmented(f.repo.objects, bytes, 40_000, "d".repeat(32));
 const destination = join(f.dir.root, "short-write-restore"); const original = fs.writeSync; let short = 0;
 mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
  if (existsSync(destination) && fstatSync(args[0]).ino === fs.statSync(destination).ino && typeof args[1] !== "string") {
   short++; return original(args[0], args[1], args[2] as number, Math.min(args[3] as unknown as number, 7_000));
  }
  return Reflect.apply(original, fs, args);
 }); syncBuiltinESMExports();
 readFragmentedToFile(f.repo.objects, result.manifestId, destination);
 assert.ok(short > 2); assert.deepEqual(readFileSync(destination), bytes);
});

for (const method of ["plan", "prune", "remove"] as const) test(`working-tree ${method} preserves typed intent ownership refusals`, async () => {
 const f = await fixture(); mkdirSync(join(f.dir.root, "empty")); const mutation = new WorktreeMutation(f.dir.root, ".pmvcs", f.repo.objects);
 const refusal = new DestructionRefusal("destructive_intent_locked", "competing native owner"); let injected = false;
 destructionBoundary.visit = step => { if (step === "owner-published") { injected = true; throw refusal; } };
 try { assert.throws(() => method === "plan" ? mutation.planErasure(f.entry.fileId!, new Map([["asset", fs.lstatSync(join(f.dir.root, "asset"), { bigint: true })]])) : method === "prune" ? mutation.prune("empty") : mutation.remove("asset"), error => error === refusal); assert.equal(injected, true); assert.ok(existsSync(join(f.dir.root, "asset"))); }
 finally { mutation.close(); }
});

test("permission-denied PID liveness stays a typed locked refusal and never adopts the live owner's intent", async () => {
 const f = await fixture(); let checked = false;
 destructionBoundary.visit = step => {
  if (step !== "owner-published" || checked) return; checked = true;
  mock.method(process, "kill", () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
  assert.throws(() => prepareDestruction(f.repo.controlDirectory, "live-owner", [{ path: join(f.dir.root, "asset") }]), { code: "destructive_intent_locked" });
 };
 const plan = prepareDestruction(f.repo.controlDirectory, "live-owner", [{ path: join(f.dir.root, "asset") }]); assert.equal(checked, true); assert.ok(existsSync(join(f.dir.root, "asset"))); assert.equal(plan.paths.length, 1);
});

test("a shared-writable external namespace ledger never grants native deletion authority", () => {
 if (typeof process.getuid !== "function") return;
 const dir = makeTempDir(); dirs.push(dir); const path = join(dir.root, "victim"); writeFileSync(path, "foreign bytes preserved");
 const ledger = join(tmpdir(), `pm-vcs-namespace-${createHash("sha256").update(dir.root).digest("hex")}`); mkdirSync(ledger, { mode: 0o700 }); chmodSync(ledger, 0o777);
 try { assert.throws(() => prepareNamespaceDestruction(path, "unowned", [{ path }]), { code: "foreign_destructive_intent" }); assert.equal(readFileSync(path, "utf8"), "foreign bytes preserved"); }
 finally { chmodSync(ledger, 0o700); rmSync(ledger, { recursive: true }); }
});

test("observational purge receipts account for vanished files without modifying their journal", async () => {
 const f = await fixture(); const root = f.repo.objects.storageRoot(); const foreign = join(root, "foreign"); writeFileSync(foreign, "unaccounted");
 const id = "c".repeat(32); const plan = erasurePurge(f.repo.controlDirectory, id, [root], true); plan.plan(planErasureStorage([root]));
 const path = join(f.repo.controlDirectory, "erasure-purge.json"); const before = readFileSync(path); rmSync(foreign);
 const result = erasurePurge(f.repo.controlDirectory, id, [root], false, true).receipt(); assert.equal(result.observedAbsent, 1); assert.deepEqual(readFileSync(path), before);
});

test("native output paths are validated before provenance or output metadata is written", async () => {
 const f = await fixture(); const path = join(f.repo.controlDirectory, "outputs.json"); assert.equal(existsSync(path), false);
 assert.throws(() => recordNativeOutput(f.repo.controlDirectory, f.repo.objects, "bad\\leaf", Buffer.from("new output"), { objects: [f.entry.id] }, fs.lstatSync(join(f.dir.root, "asset"), { bigint: true })), { code: "unsafe_composition_path" });
 assert.equal(existsSync(path), false); assert.deepEqual(nativeOutputs(f.repo.controlDirectory), []);
});

test("managed archive retries an interrupted owned write but preserves unrelated replacements", async () => {
 const f = await fixture(); const path = join(f.dir.root, "archive.bundle"); const produce = () => exportBundle(f.repo.objects, f.repo.refs, []); const original = fs.writeFileSync; let injected = false;
 mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
  if (typeof args[0] === "number" && existsSync(path) && fstatSync(args[0]).ino === fs.statSync(path).ino && !injected) { injected = true; original(args[0], "partial native archive"); throw Object.assign(new Error("partial export"), { code: "EIO" }); }
  return Reflect.apply(original, fs, args);
 }); syncBuiltinESMExports();
 assert.throws(() => writeBundleFile(f.repo, path, produce), { code: "EIO" }); assert.equal(injected, true); mock.restoreAll(); syncBuiltinESMExports();
 let written = 0; assert.doesNotThrow(() => { written = writeBundleFile(f.repo, path, produce); }); assert.equal(written, produce().length); assert.deepEqual(readFileSync(path), produce());
 writeFileSync(path, "user replacement"); assert.throws(() => writeBundleFile(f.repo, path, produce), { code: "worktree_path_changed" }); assert.equal(readFileSync(path, "utf8"), "user replacement");
});

test("a valid wide tree queues native references without an argument-spread overflow", () => {
 const dir = makeTempDir(); dirs.push(dir); const store = new ObjectStore(join(dir.root, "objects")); const id = store.write("blob", Buffer.from("shared"));
 const tree = store.write("tree", encodeTree(Array.from({ length: 150_000 }, (_, index) => ({ name: `leaf-${String(index).padStart(6, "0")}`, mode: "100644" as const, id }))));
 let visits = 0; assert.deepEqual([...reachableObjects(store, [tree], () => { visits++; })].sort(), [tree, id].sort()); assert.ok(visits >= 150_000);
});

test("disposable cleanup leaves no namespace ledger and preserves a primary fragment failure", async () => {
 const f = await fixture(); const scratch = join(f.dir.root, "scratch"); mkdirSync(scratch); writeFileSync(join(scratch, "part"), "scratch");
 const ledger = join(tmpdir(), `pm-vcs-namespace-${createHash("sha256").update(scratch).digest("hex")}`); durability.discardTemporary(scratch); assert.equal(existsSync(scratch), false); assert.equal(existsSync(ledger), false);
 const bad = f.repo.objects.write("manifest", encodeManifest({ totalLength: 4, fragments: [{ id: f.entry.id, length: 4 }] })); const destination = join(f.dir.root, "incomplete"); const original = fs.rmSync; let attempted = false;
 mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => { if (args[0] === destination) { attempted = true; throw Object.assign(new Error("cleanup denied"), { code: "EACCES" }); } return Reflect.apply(original, fs, args); }); syncBuiltinESMExports();
 const unlink = fs.unlinkSync; mock.method(fs, "unlinkSync", (target: fs.PathLike) => { if (target === destination) throw Object.assign(new Error("unlink cleanup denied"), { code: "EACCES" }); return unlink(target); }); syncBuiltinESMExports();
 assert.throws(() => readFragmentedToFile(f.repo.objects, bad, destination), { code: "fragment_length_mismatch" }); assert.equal(attempted, true);
});

test("prepared publications in linked instances remain bound to their private control directory", async () => {
 const f = await fixture(); f.repo.commit({ message: "instance base", author: { name: "Fixture", email: "fixture@local", timestamp: 1, timezoneOffsetMinutes: 0 } }, new Date(1));
 const linkedDir = makeTempDir(); dirs.push(linkedDir); const root = join(linkedDir.root, "linked"); f.repo.linkInstance("view", root, { include: ["asset"] }); const linked = Repository.open(root);
 const target = join(linked.controlDirectory, "config.json"); const source = prepareControlPublication(linked, target, "prepared instance bytes");
 assert.ok(existsSync(source)); assert.ok(source.startsWith(linked.controlDirectory));
});

test("pack helper rejects unknown actions without erasure and ref helper supports null deletion", async () => {
 const f = await fixture(); const run = (helper: string, args: string[]) => spawnSync(process.execPath, [join(packageRoot, "test/helpers", helper), ...args], { env: { ...testEnvironment(), ...discardChildCoverage() }, encoding: "utf8", timeout: 30_000 });
 const bad = run("pack-worker.ts", ["typo", f.dir.root, "0"]); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /Unknown pack worker action/u); assert.equal(f.repo.objects.denials().length, 0); assert.ok(existsSync(join(f.dir.root, "asset")));
 const name = "refs/heads/delete-fixture"; f.repo.refs.compareAndSwap(name, null, f.entry.id);
 const removed = run("ref-publication-worker.ts", [f.dir.root, name, f.entry.id, "null", "normal"]); assert.equal(removed.status, 0, removed.stderr); assert.equal(f.repo.refs.read(name), null);
});

test("unopened public chunk iterators acquire no descriptor and return without consuming ownership", async () => {
 const f = await fixture();
 for (const packed of [false, true]) { if (packed) f.repo.objects.compact(); const before = objectFiles.active.size; const chunks = f.repo.objects.readChunks(f.entry.id, "blob"); assert.equal(objectFiles.active.size, before); chunks.return(undefined); assert.equal(objectFiles.active.size, before); }
});


test("cross-drive and absolute external export projections bypass repository-local ownership metadata", async () => {
 const f = await fixture(); const external = makeTempDir(); dirs.push(external); const relative = path.relative;
 for (const projected of ["Z:/external.bundle", "/external.bundle"]) {
  const destination = join(external.root, "archive.bundle");
  mock.method(path, "relative", (from: string, to: string) => from === f.repo.root && to === destination ? projected : relative(from, to)); syncBuiltinESMExports();
  const bytes = Buffer.from("native external archive fixture"); let written = 0; assert.doesNotThrow(() => { written = writeBundleFile(f.repo, destination, () => bytes); }); assert.equal(written, bytes.length); assert.deepEqual(readFileSync(destination), bytes); assert.equal(existsSync(join(f.repo.controlDirectory, "exports.json")), false);
  mock.restoreAll(); syncBuiltinESMExports(); rmSync(destination);
 }
});


test("legacy four-part purge identities remain readable but cannot acquire a new deletion lifetime", async () => {
 const f = await fixture(); const root = f.repo.objects.storageRoot(); const foreign = join(root, "legacy-foreign"); writeFileSync(foreign, "retained legacy bytes"); const id = "d".repeat(32);
 erasurePurge(f.repo.controlDirectory, id, [root], true).plan(planErasureStorage([root]));
 const path = join(f.repo.controlDirectory, "erasure-purge.json"); const journal = JSON.parse(readFileSync(path, "utf8")) as { operations: Record<string, { identity: string }[]> };
 for (const entries of Object.values(journal.operations)) for (const entry of entries) entry.identity = entry.identity.split(":").slice(0, 4).join(":");
 writeFileSync(path, JSON.stringify(journal)); const before = readFileSync(path); const receipt = erasurePurge(f.repo.controlDirectory, id, [root], false, true).receipt(); assert.equal(receipt.replaced, 1); assert.deepEqual(readFileSync(path), before); assert.equal(readFileSync(foreign, "utf8"), "retained legacy bytes");
});


test("native buffer fragments hash whole identity without a redundant raw denial digest on a clean store", async () => {
 const f = await fixture(); const bytes = Buffer.from("unrelated hash accounting fixture"); const create = crypto.createHash; let redundant = 0;
 mock.method(crypto, "createHash", (...args: Parameters<typeof crypto.createHash>) => {
  const hash = Reflect.apply(create, crypto, args); const update = hash.update; let started = false;
  mock.method(hash, "update", (...parts: Parameters<typeof hash.update>) => { if (parts[0] === bytes && !started) redundant++; started = true; return Reflect.apply(update, hash, parts); }); return hash;
 }); syncBuiltinESMExports();
 writeFragmented(f.repo.objects, bytes, 7); writeCdcFragmented(f.repo.objects, bytes, { minChunkSize: 3, maxChunkSize: 7, mask: 3 }); assert.equal(redundant, 0);
});

test("benchmark scratch cleanup removes its disposable tree without an external recovery ledger", async () => {
 const f = await fixture(); const scope = makeTempDir(); dirs.push(scope); const create = fs.mkdtempSync; const scratch: string[] = [];
 const prior = ["TMPDIR", "TMP", "TEMP"].map(key => [key, process.env[key]] as const); for (const [key] of prior) process.env[key] = scope.root;
 mock.method(fs, "mkdtempSync", (...args: Parameters<typeof fs.mkdtempSync>) => { const result = Reflect.apply(create, fs, args); if (String(args[0]).endsWith("pm-vcs-scale-")) scratch.push(String(result)); return result; }); syncBuiltinESMExports();
 try { const result = benchmarkPhase6(join(f.dir.root, ".agents/pm"), 1_048_577); assert.ok(result.gcReclaimedBytes > 0); assert.equal(scratch.length, 1); for (const path of scratch) assert.equal(existsSync(path), false); assert.equal(existsSync(join(scope.root, `pm-vcs-namespace-${createHash("sha256").update(scope.root).digest("hex")}`)), false, "Disposable cleanup must not leave a parent namespace ledger"); }
 finally { for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});


test("disposable cleanup reports its own native failure when no primary failure is active", () => {
 const dir = makeTempDir(); dirs.push(dir); const original = fs.rmSync; const failure = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
 mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => { if (args[0] === dir.root) throw failure; return Reflect.apply(original, fs, args); });
 assert.throws(() => durability.discardTemporary(dir.root), error => error === failure); assert.ok(existsSync(dir.root));
});


for (const mode of ["fixed", "cdc"] as const) test(`${mode} descriptor production refuses a real truncation after its identity preflight`, async () => {
 const f = await fixture(); const source = join(f.dir.root, "changing-source"); const bytes = Buffer.alloc(128, 97); writeFileSync(source, bytes); const fd = fs.openSync(source, "r"); let identified = false;
 const truncate = (): void => { identified = true; fs.truncateSync(source, 0); };
 try {
  assert.throws(() => mode === "fixed" ? writeFragmentsFromFd(f.repo.objects, fd, bytes.length, 16, source, f.entry.fileId, undefined, truncate) : writeCdcFragmentsFromFd(f.repo.objects, fd, bytes.length, { minChunkSize: 3, maxChunkSize: 16, mask: 3 }, source, f.entry.fileId, undefined, truncate), { code: "short_read" }); assert.equal(identified, true);
 } finally { fs.closeSync(fd); }
});


test("nested whole-content producers restore their outer equivalence scope on success and failure", async () => {
 const f = await fixture(); const outer = hashObject("blob", Buffer.from("outer content")); const inner = Buffer.from("inner content"); let after = "";
 f.repo.objects.withWholeContent(outer, () => {
  writeFragmented(f.repo.objects, inner, 4, "e".repeat(32));
  assert.throws(() => f.repo.objects.withWholeContent(hashObject("blob", Buffer.from("failed inner")), () => { throw new Error("nested producer failure"); }), /nested producer failure/);
  after = f.repo.objects.write("blob", Buffer.from("outer remaining member"), "e".repeat(32));
 });
 const records = derivations(f.repo.controlDirectory, () => {});
 assert.ok(records.get(outer)!.members!.includes(after)); assert.ok(records.get(after)!.sources.includes(outer));
 const outside = f.repo.objects.write("blob", Buffer.from("outside all producers"), "e".repeat(32));
 assert.equal(derivations(f.repo.controlDirectory, () => {}).get(outside)!.sources.includes(outer), false);
});

test("erasure native control classifiers refuse malformed JSON, identities and text before payload deletion", async () => {
 for (const [name, bytes] of [["dirty.json", "null"], ["dirty.json", "42"], ["identity", JSON.stringify("invalid")], ["format", "foreign-format"], ["HEAD", "foreign-head"], ["HEAD", "ref: ../foreign"]]) {
  const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  writeFileSync(join(f.repo.controlDirectory, name), bytes);
  assert.throws(() => f.repo.objects.withWriteLock(() => validateErasureRequest(f.repo, [f.repo], f.entry.fileId!, "erase-fixture", "control-proof", new Date(1), {})), { code: "unsupported_erasure_storage" });
  assert.equal(f.repo.objects.denials().length, 0); assert.ok(existsSync(join(f.dir.root, "asset")));
 }
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture"); writeFileSync(join(f.repo.controlDirectory, "view.json"), "null");
 assert.doesNotThrow(() => f.repo.objects.withWriteLock(() => validateErasureRequest(f.repo, [f.repo], f.entry.fileId!, "erase-fixture", "control-proof", new Date(1), {})));
 assert.equal(f.repo.objects.denials().length, 0);
});

test("erasure lease audit classification pins native bytes and directory kinds", async () => {
 for (const mode of ["directory-kind", "read-size", "read-lifetime"] as const) {
  const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  const leases = join(f.repo.controlDirectory, "leases"); let audit = "";
  if (mode === "directory-kind") writeFileSync(leases, "foreign ledger bytes");
  else {
   new PublicationLeases(f.repo.objects, f.repo.controlDirectory).change({ action: "acquire", fileId: f.entry.fileId!, refs: ["refs/heads/main"], ttlMs: 1000 });
   audit = join(leases, `${f.entry.fileId!}.jsonl`);
   const original = fs.readFileSync;
   mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const result = Reflect.apply(original, fs, args);
    if (typeof args[0] === "number" && fstatSync(args[0]).ino === fs.statSync(audit).ino && Buffer.isBuffer(result)) {
     if (mode === "read-size") return Buffer.concat([Buffer.from(" "), result]);
     fs.utimesSync(audit, new Date(0), new Date(0));
    }
    return result;
   }); syncBuiltinESMExports();
  }
  assert.throws(() => f.repo.objects.withWriteLock(() => validateErasureRequest(f.repo, [f.repo], f.entry.fileId!, "erase-fixture", "lease-proof", new Date(1), {})), { code: "unsupported_erasure_storage" });
  assert.equal(f.repo.objects.denials().length, 0); assert.ok(existsSync(join(f.dir.root, "asset")));
  mock.restoreAll(); syncBuiltinESMExports();
 }
});

test("erasure audit reports bounded raw storage and opaque record diagnostics without gating completion", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture");
 const opaque = f.repo.objects.write("record", Buffer.from("legacy non-JSON record content"), "c".repeat(32));
 const bytes = crypto.randomBytes(17 * 1024 * 1024); const large = f.repo.objects.write("blob", bytes, "d".repeat(32));
 let chunks = 0; erasureScanBoundary.visit = step => { if (step === "file-chunk") chunks++; };
 let receipt: ReturnType<Repository["obliterate"]> | undefined;
 assert.doesNotThrow(() => { receipt = f.repo.obliterate(f.entry.fileId!, "erase-fixture", "bounded-audit", new Date(1)); }); assert.ok(receipt);
 assert.ok(chunks > 0 && chunks <= 258, `bounded audit processed ${chunks} chunks`);
 assert.equal(receipt.audit.limited, true); assert.equal(receipt.storage.accountable, true);
 assert.deepEqual(f.repo.objects.read(large).payload, bytes); assert.equal(f.repo.objects.read(opaque).payload.toString(), "legacy non-JSON record content");
});

test("erasure raw diagnostic I/O faults refuse rather than certifying an incomplete pass", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture"); let injected = false;
 f.repo.objects.write("blob", Buffer.from("unrelated native copy"), "c".repeat(32));
 erasureScanBoundary.visit = step => { if (step === "file-opened") { injected = true; throw Object.assign(new Error("diagnostic read unavailable"), { code: "EIO" }); } };
 assert.throws(() => f.repo.obliterate(f.entry.fileId!, "erase-fixture", "diagnostic-fault", new Date(1)), { code: "EIO" });
 assert.equal(injected, true); assert.equal(f.repo.objects.denials().length, 0); assert.ok(existsSync(join(f.dir.root, "asset")));
});

test("legacy managed export ownership refuses replaced files and converges after absence", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture");
 const bytes = Buffer.from("legacy managed export bytes"); const file = join(f.dir.root, "old.bundle");
 const unrelated = Buffer.from("independent native output"); const unrelatedId = f.repo.objects.write("blob", unrelated); writeFileSync(file, unrelated);
 recordNativeOutput(f.repo.controlDirectory, f.repo.objects, "old.bundle", unrelated, { objects: [unrelatedId] }, fs.lstatSync(file, { bigint: true }));
 fs.renameSync(file, `${file}.retired`); writeFileSync(file, "foreign replacement");
 writeFileSync(join(f.repo.controlDirectory, "exports.json"), JSON.stringify([{ path: "old.bundle", id: hashObject("blob", bytes), sha256: createHash("sha256").update(bytes).digest("hex"), objects: [f.entry.id] }]));
 assert.throws(() => f.repo.obliterate(f.entry.fileId!, "erase-fixture", "legacy-export", new Date(1)), { code: "worktree_path_changed" });
 assert.equal(readFileSync(file, "utf8"), "foreign replacement"); assert.equal(f.repo.objects.denials().length, 0);
 rmSync(file); const receipt = f.repo.obliterate(f.entry.fileId!, "erase-fixture", "legacy-export", new Date(1)); assert.equal(receipt.storage.accountable, true);
});

test("native destruction classification accepts only empty stages with exact bounded writer names", () => {
 const dir = makeTempDir(); dirs.push(dir); const ledger = join(dir.root, "destruction"); mkdirSync(ledger);
 const key = "a".repeat(64); const token = "b".repeat(32); const suffix = ".cccccccccccc.tmp";
 for (const name of [`${key}.json${suffix}`, `${key}.${token}.progress${suffix}`, `${key}.json.lock.123${suffix}`]) writeFileSync(join(ledger, name), "");
 assert.doesNotThrow(() => assertDestructionStorage(dir.root));
 const bad = join(ledger, `${key}.json.lock.2147483648${suffix}`); writeFileSync(bad, "");
 assert.throws(() => assertDestructionStorage(dir.root), { code: "unsupported_erasure_storage" }); assert.ok(existsSync(bad));
});

test("native retirement hashes a read-only captured leaf through its supported fallback", () => {
 const dir = makeTempDir(); dirs.push(dir); const victim = join(dir.root, "victim"); writeFileSync(victim, "captured read-only bytes");
 const original = objectFiles.open; let rejected = false; let fallback = false;
 mock.method(objectFiles, "open", (...args: Parameters<typeof objectFiles.open>) => {
  if (args[0] === victim && typeof args[1] === "number") {
   if ((args[1] & fs.constants.O_RDWR) !== 0) { rejected = true; throw Object.assign(new Error("read-only captured leaf"), { code: "EACCES" }); }
   fallback = true;
  }
  return Reflect.apply(original, objectFiles, args);
 });
 const plan = prepareDestruction(dir.root, "read-only-capture", [{ path: victim }]);
 assert.equal(rejected, true); assert.equal(fallback, true); for (const name of plan.paths) plan.remove(name); assert.equal(plan.finish().deleted, 1);
});

test("exclusive native publication refuses an in-place change between held and named stamps", () => {
 const dir = makeTempDir(); dirs.push(dir); const source = join(dir.root, "source"); const destination = join(dir.root, "destination"); writeFileSync(source, "first");
 const original = fs.lstatSync; let changed = false;
 mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
  if (args[0] === destination && existsSync(destination) && !changed) { changed = true; writeFileSync(source, "changed native source"); }
  return Reflect.apply(original, fs, args);
 }); syncBuiltinESMExports();
 assert.throws(() => durability.link(source, destination), { code: "worktree_path_changed" }); assert.equal(changed, true); assert.equal(readFileSync(destination, "utf8"), "changed native source");
});

test("native process leases bound disappearing-name contention and preserve oversized foreign locks", () => {
 const dir = makeTempDir(); dirs.push(dir); const target = join(dir.root, "native.lock"); let attempts = 0;
 const original = durability.link;
 mock.method(durability, "link", (source: string, destination: string) => { if (destination === target) { attempts++; throw Object.assign(new Error("name raced away"), { code: "EEXIST" }); } return original(source, destination); });
 assert.throws(() => durability.claim(target, "fixture_locked"), { code: "fixture_locked", message: /eight attempts/ }); assert.equal(attempts, 8); assert.deepEqual(readdirSync(dir.root), []);
 mock.restoreAll(); writeFileSync(target, Buffer.alloc(4097, 97));
 assert.throws(() => durability.claim(target, "fixture_locked"), { code: "fixture_locked" }); assert.equal(fs.statSync(target).size, 4097);
});

test("native process lease bootstrap metadata failure closes and discards only its owned stage", () => {
 const dir = makeTempDir(); dirs.push(dir); const target = join(dir.root, "native.lock"); const stat = fs.fstatSync; let descriptor = -1; let injected = false;
 mock.method(objectFiles, "opened", (file: Parameters<typeof objectFiles.opened>[0], name: string) => { if (name.startsWith(join(dir.root, "owner-"))) descriptor = file.fd; });
 mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => { if (args[0] === descriptor && !injected) { injected = true; throw Object.assign(new Error("bootstrap metadata unavailable"), { code: "EIO" }); } return Reflect.apply(stat, fs, args); }); syncBuiltinESMExports();
 assert.throws(() => durability.claim(target, "fixture_locked"), { code: "EIO" }); assert.equal(injected, true); assert.deepEqual(readdirSync(dir.root), []); assert.equal(objectFiles.active.size, 0);
});

test("native process leases recover an owner retired after observation and release idempotently", () => {
 const dir = makeTempDir(); dirs.push(dir); const target = join(dir.root, "native.lock"); const first = durability.claim(target, "fixture_locked"); let next: ReturnType<typeof durability.claim> | undefined;
 const unlink = durability.unlinkOwner; let injected = false;
 mock.method(process, "kill", () => { throw Object.assign(new Error("observed owner exited"), { code: "ESRCH" }); });
 mock.method(durability, "unlinkOwner", (...args: Parameters<typeof durability.unlinkOwner>) => { const result = Reflect.apply(unlink, durability, args); if (args[0] === target && !injected) { injected = true; throw new DestructionRefusal("destructive_target_changed", "The observed owner was already retired."); } return result; });
 try {
  next = durability.claim(target, "fixture_locked"); assert.equal(injected, true); mock.restoreAll(); first.release(); next.verify(); next.release(); next.release(); assert.equal(existsSync(target), false);
 } finally { mock.restoreAll(); first.release(); next?.release(); }
});

test("opaque imported manifest frames stay readable and explicitly unknown rather than claiming known provenance", async () => {
 const f = await fixture(); const payload = Buffer.from("legacy opaque manifest bytes"); const id = hashObject("manifest", payload);
 assert.doesNotThrow(() => f.repo.objects.accept([{ id, type: "manifest", payload }], false));
 assert.deepEqual(f.repo.objects.read(id).payload, payload); const record = derivations(f.repo.controlDirectory, () => {}).get(id)!;
 assert.equal(record.whole, false); assert.ok(record.unknown!.includes(id));
});

test("native dead-owner retirement propagates an operational error while preserving the current lease", () => {
 const dir = makeTempDir(); dirs.push(dir); const target = join(dir.root, "native.lock"); const first = durability.claim(target, "fixture_locked"); let injected = false;
 const unlink = durability.unlinkOwner;
 mock.method(process, "kill", () => { throw Object.assign(new Error("observed owner exited"), { code: "ESRCH" }); });
 mock.method(durability, "unlinkOwner", (...args: Parameters<typeof durability.unlinkOwner>) => { if (args[0] === target) { injected = true; throw Object.assign(new Error("owner retirement unavailable"), { code: "EIO" }); } return Reflect.apply(unlink, durability, args); });
 try { assert.throws(() => durability.claim(target, "fixture_locked"), { code: "EIO" }); assert.equal(injected, true); first.verify(); }
 finally { mock.restoreAll(); first.release(); }
});

test("bounded reads reject a compressed body larger than the caller's complete input budget", async () => {
 const f = await fixture(); const bytes = crypto.randomBytes(2048); const id = f.repo.objects.write("blob", bytes);
 const original = fs.readSync; let exceeded = false;
 mock.method(fs, "readSync", (...args: unknown[]) => { if (typeof args[3] === "number" && args[3] > 1025) exceeded = true; return Reflect.apply(original, fs, args); }); syncBuiltinESMExports();
 assert.throws(() => f.repo.objects.readBoundedTyped(id, "blob", 1), { code: "object_payload_limit" });
 assert.equal(exceeded, false); mock.restoreAll(); syncBuiltinESMExports();
 assert.deepEqual(f.repo.objects.readTyped(id, "blob"), bytes);
});

test("semantic compaction inventory retains a live canonical loose temporary without reading its incomplete frame", async () => {
 const f = await fixture(); const path = join(f.repo.objects.storageRoot(), f.entry.id.slice(0, 2), `${f.entry.id.slice(2)}.123.aaaaaaaaaaaa.tmp`); writeFileSync(path, "partial native write");
 const skipped: { name: string; reason: string }[] = [];
 assert.ok([...f.repo.objects.walkLooseInventory(skipped)].some(object => object.id === f.entry.id));
 assert.ok(skipped.some(entry => entry.name === f.entry.id && entry.reason === "loose write temporary; retained for its writer"));
 assert.equal(readFileSync(path, "utf8"), "partial native write"); assert.deepEqual(f.repo.objects.read(f.entry.id).payload, readFileSync(join(f.dir.root, "asset")));
});

test("native operation-log stages accept canonical redacted obliteration facts and refuse arbitrary summaries", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture"); const stage = join(f.repo.controlDirectory, "oplog.jsonl.aaaaaaaaaaaa.tmp");
 const row = { sequence: 1, command: "obliterate", at: new Date(0).toISOString(), refs: [], summary: `Obliterated FileId ${f.entry.fileId!}; tombstone ${"a".repeat(64)}.` };
 writeFileSync(stage, JSON.stringify(row) + "\n");
 assert.doesNotThrow(() => f.repo.objects.withWriteLock(() => validateErasureRequest(f.repo, [f.repo], f.entry.fileId!, "erase-fixture", "stage-proof", new Date(1), {})));
 writeFileSync(stage, JSON.stringify({ ...row, summary: "foreign recoverable summary" }) + "\n");
 assert.throws(() => f.repo.objects.withWriteLock(() => validateErasureRequest(f.repo, [f.repo], f.entry.fileId!, "erase-fixture", "stage-proof", new Date(1), {})), { code: "unsupported_erasure_storage" }); assert.equal(f.repo.objects.denials().length, 0);
});

test("native process lock control entries remain recognized without acquiring opaque control ownership", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture"); const owner = durability.claim(join(f.repo.controlDirectory, "oplog.jsonl.lock"), "fixture_locked");
 try { assert.doesNotThrow(() => f.repo.objects.withWriteLock(() => validateErasureRequest(f.repo, [f.repo], f.entry.fileId!, "erase-fixture", "owner-proof", new Date(1), {}))); owner.verify(); assert.equal(f.repo.objects.denials().length, 0); }
 finally { owner.release(); }
});

test("erasure refuses a lease directory changed after its native control entry was captured", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture"); const leases = join(f.repo.controlDirectory, "leases"); mkdirSync(leases);
 const authority = join(f.repo.controlDirectory, "authority.json"); const read = fs.readFileSync; let reads = 0; let injected = false;
 mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
  const value = Reflect.apply(read, fs, args);
  if (args[0] === authority && ++reads === 2) { injected = true; fs.renameSync(leases, join(f.dir.root, "original-leases")); writeFileSync(leases, "foreign changed namespace"); }
  return value;
 }); syncBuiltinESMExports();
 assert.throws(() => f.repo.objects.withWriteLock(() => validateErasureRequest(f.repo, [f.repo], f.entry.fileId!, "erase-fixture", "lease-directory", new Date(1), {})), { code: "unsupported_erasure_storage" });
 assert.equal(injected, true); assert.equal(readFileSync(leases, "utf8"), "foreign changed namespace"); assert.equal(f.repo.objects.denials().length, 0); assert.ok(existsSync(join(f.dir.root, "asset")));
});

test("unknown control backup bytes refuse before denial or any selected deletion", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture"); const bytes = readFileSync(join(f.dir.root, "asset")); const backup = join(f.repo.controlDirectory, "foreign-backup"); writeFileSync(backup, bytes);
 assert.throws(() => f.repo.obliterate(f.entry.fileId!, "erase-fixture", "unknown-control", new Date(1)), { code: "unsupported_erasure_storage" });
 assert.deepEqual(readFileSync(backup), bytes); assert.deepEqual(readFileSync(join(f.dir.root, "asset")), bytes); assert.equal(f.repo.objects.denials().length, 0);
});

test("corrupt native fingerprint metadata refuses with the named decode bound before deletion", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture"); const proof = join(f.repo.controlDirectory, "erasure-verification.json"); writeFileSync(proof, "{invalid JSON");
 assert.throws(() => f.repo.obliterate(f.entry.fileId!, "erase-fixture", "invalid-proof", new Date(1)), { code: "unverified", verifier: "erasure", bound: "decode_error" });
 assert.equal(f.repo.objects.denials().length, 0); assert.ok(existsSync(join(f.dir.root, "asset"))); assert.equal(readFileSync(proof, "utf8"), "{invalid JSON");
});

test("missing diagnostic fingerprints on a pending retry report limits while complete native provenance erases", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture");
 erasureScanBoundary.visit = step => { if (step === "pending") throw new Error("pending proof evidence"); };
 assert.throws(() => f.repo.obliterate(f.entry.fileId!, "erase-fixture", "missing-audit", new Date(1)), /pending proof evidence/); erasureScanBoundary.visit = () => {};
 assert.equal(f.repo.objects.denials()[0].pending, true); writeFileSync(join(f.repo.controlDirectory, "erasure-verification.json"), JSON.stringify(fingerprintJournal({})));
 const receipt = f.repo.obliterate(f.entry.fileId!, "erase-fixture", "missing-audit", new Date(1));
 assert.equal(receipt.audit.limited, true); assert.equal(receipt.storage.accountable, true); assert.equal(existsSync(join(f.dir.root, "asset")), false); assert.throws(() => f.repo.objects.read(f.entry.id), { code: "object_obliterated" });
});

test("an operation receipt append I/O failure remains visible after physical completion and retries once", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture"); const log = join(f.repo.controlDirectory, "oplog.jsonl"); const append = fs.appendFileSync; let injected = false;
 mock.method(fs, "appendFileSync", (...args: Parameters<typeof fs.appendFileSync>) => { if (args[0] === log && String(args[1]).includes('"command":"obliterate"')) { injected = true; throw Object.assign(new Error("operation receipt append unavailable"), { code: "EIO" }); } return Reflect.apply(append, fs, args); }); syncBuiltinESMExports();
 assert.throws(() => f.repo.obliterate(f.entry.fileId!, "erase-fixture", "receipt-io", new Date(1)), { code: "EIO" }); assert.equal(injected, true); assert.equal(f.repo.objects.denials()[0].pending, false); assert.equal(existsSync(join(f.dir.root, "asset")), false);
 mock.restoreAll(); syncBuiltinESMExports(); const receipt = f.repo.obliterate(f.entry.fileId!, "erase-fixture", "receipt-io", new Date(1));
 assert.equal(receipt.storage.accountable, true); assert.equal(f.repo.operations.read().filter(operation => operation.command === "obliterate").length, 1);
});


test("unrecognized empty lease audit names refuse before deletion", async () => {
 const f = await fixture(); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture"); const leases = join(f.repo.controlDirectory, "leases"); mkdirSync(leases);
 const foreign = join(leases, "foreign-backup"); writeFileSync(foreign, ""); const selected = readFileSync(join(f.dir.root, "asset"));
 assert.throws(() => f.repo.obliterate(f.entry.fileId!, "erase-fixture", "lease-name", new Date(1)), { code: "unsupported_erasure_storage" });
 assert.equal(f.repo.objects.denials().length, 0); assert.deepEqual(readFileSync(join(f.dir.root, "asset")), selected); assert.equal(existsSync(foreign), true);
});


for (const operation of ["fixed", "cdc", "write", "arrival", "worktree", "export"] as const) test(`native ${operation} publication snapshots caller-owned bytes before certification`, async () => {
 const f = await fixture(); const input = Buffer.from("private snapshot input 739115"); const expected = Buffer.from(input); let injected = false;
 if (operation === "fixed" || operation === "cdc") {
  const write = f.repo.objects.write; mock.method(f.repo.objects, "write", (...args: Parameters<typeof write>) => { if (!injected) { injected = true; input.fill(88); } return Reflect.apply(write, f.repo.objects, args); });
  const result = operation === "fixed" ? writeFragmented(f.repo.objects, input, 5) : writeCdcFragmented(f.repo.objects, input, { minChunkSize: 3, maxChunkSize: 7, mask: 3 }); assert.deepEqual(readFragmented(f.repo.objects, result.manifestId), expected);
 } else if (operation === "write" || operation === "arrival") {
  const arrival = { id: hashObject("blob", input), type: "blob" as const, payload: input }; const preflight = f.repo.objects.preflight;
  mock.method(f.repo.objects, "preflight", (...args: Parameters<typeof preflight>) => { injected = true; input.fill(88); arrival.id = hashObject("blob", input); return Reflect.apply(preflight, f.repo.objects, args); });
  if (operation === "write") { const id = f.repo.objects.write("blob", input); assert.equal(id, hashObject("blob", expected)); }
  else f.repo.objects.accept([arrival], true);
  assert.equal(f.repo.objects.has(hashObject("blob", expected)), true); assert.deepEqual(f.repo.objects.read(hashObject("blob", expected)).payload, expected);
 } else if (operation === "worktree") {
  const open = fs.openSync; mock.method(fs, "openSync", (...args: Parameters<typeof open>) => { if (String(args[0]).endsWith("snapshot-output")) { injected = true; input.fill(88); } return Reflect.apply(open, fs, args); }); syncBuiltinESMExports();
  f.repo.objects.withWriteLock(() => { const mutation = new WorktreeMutation(f.repo.root, ".pmvcs", f.repo.objects); try { mutation.write("snapshot-output", input, 0o600, { objects: [f.entry.id] }); } finally { mutation.close(); } }); assert.deepEqual(readFileSync(join(f.repo.root, "snapshot-output")), expected);
 } else {
  const write = fs.writeFileSync; mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => { if (typeof args[0] === "string" && args[0].includes("exports.json.") && args[0].endsWith(".tmp")) { injected = true; input.fill(88); } return Reflect.apply(write, fs, args); }); syncBuiltinESMExports();
  writeBundleFile(f.repo, join(f.repo.root, "snapshot-export"), () => input, () => [f.entry.id]); assert.deepEqual(readFileSync(join(f.repo.root, "snapshot-export")), expected);
 }
 assert.equal(injected, true); assert.notDeepEqual(input, expected);
});

test("arrival publication rejects bytes that differ from their supplied identity before storing any", async () => {
 const f = await fixture(); const before = f.repo.objects.inventory().map(row => row.id).sort(); const bytes = Buffer.from("actual arrival bytes");
 assert.throws(() => f.repo.objects.accept([{ type: "blob", id: hashObject("blob", Buffer.from("other bytes")), payload: bytes }], true), { code: "corrupt_object" }); assert.deepEqual(f.repo.objects.inventory().map(row => row.id).sort(), before);
});

for (const mode of ["fixed", "cdc"] as const) test(`verified ${mode} source blocks reject an in-place change before publishing changed bytes`, async () => {
 const f = await fixture(); const path = join(f.dir.root, "source"); const bytes = Buffer.alloc(131072, 65); writeFileSync(path, bytes); const fd = fs.openSync(path, "r");
 const changed = Buffer.from(bytes); changed.fill(88, 65536); const identify = (): void => { writeFileSync(path, changed); fs.utimesSync(path, new Date(0), new Date(0)); };
 try { assert.throws(() => mode === "fixed" ? writeFragmentsFromFd(f.repo.objects, fd, bytes.length, 65536, path, undefined, undefined, identify) : writeCdcFragmentsFromFd(f.repo.objects, fd, bytes.length, { minChunkSize: 65536, maxChunkSize: 65536, mask: 0 }, path, undefined, undefined, identify), { code: "source_changed" }); }
 finally { fs.closeSync(fd); }
 assert.equal(f.repo.objects.has(hashObject("blob", changed.subarray(65536))), false); assert.deepEqual(f.repo.objects.read(hashObject("blob", bytes.subarray(0, 65536))).payload, bytes.subarray(0, 65536));
});

for (const offset of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER]) test(`descriptor publication refuses invalid explicit source offset ${offset}`, async () => {
 const f = await fixture(); const path = join(f.dir.root, "asset"); const fd = fs.openSync(path, "r"); const before = f.repo.objects.inventory().map(row => row.id).sort();
 try { assert.throws(() => writeFragmentsFromFd(f.repo.objects, fd, 3, 3, path, undefined, undefined, undefined, offset), { code: "invalid_source_offset" }); }
 finally { fs.closeSync(fd); } assert.deepEqual(f.repo.objects.inventory().map(row => row.id).sort(), before);
});


for (const mode of ["partial-write", "zero-write", "proof-short", "open-error", "close-error", "cleanup-error", "source-plus-close", "source-plus-cleanup", "close-plus-cleanup"] as const) test(`source commitment lifecycle preserves evidence and the primary failure (${mode})`, async () => {
 const f = await fixture(); const source = join(f.dir.root, "asset"); const expected = readFileSync(source); const fd = fs.openSync(source, "r"); let proofFd = -1; let proofRoot = ""; let short = false; let zeroWrites = 0; let emptyReads = 0;
 const open = objectFiles.open; const remove = durability.discardTemporary;
 mock.method(objectFiles, "open", (...args: Parameters<typeof open>) => {
  const proof = String(args[0]).endsWith("checksums");
  if (proof) { proofRoot = dirname(String(args[0])); if (mode === "open-error") throw Object.assign(new Error("proof open fault"), { code: "EACCES" }); }
  const file = Reflect.apply(open, objectFiles, args);
  if (proof) {
   proofFd = file.fd;
   if (mode === "close-error" || mode === "source-plus-close" || mode === "close-plus-cleanup") { const close = file.close; mock.method(file, "close", () => { close(); throw Object.assign(new Error("proof close fault"), { code: "EIO" }); }); }
  }
  return file;
 });
 const write = fs.writeSync; mock.method(fs, "writeSync", (...args: unknown[]) => {
  if (args[0] === proofFd) {
   if (mode === "zero-write") { if (++zeroWrites === 1) return 0; throw Object.assign(new Error("repeated zero write"), { code: "EIO" }); }
   if (mode === "partial-write" && !short) { short = true; return Reflect.apply(write, fs, [args[0], args[1], args[2], 16]); }
  }
  return Reflect.apply(write, fs, args);
 });
 const read = fs.readSync; mock.method(fs, "readSync", (...args: unknown[]) => { if (mode === "proof-short" && args[0] === proofFd && ++emptyReads > 1) throw Object.assign(new Error("repeated empty proof read"), { code: "EIO" }); return Reflect.apply(read, fs, args); }); syncBuiltinESMExports();
 if (mode === "cleanup-error" || mode === "source-plus-cleanup" || mode === "close-plus-cleanup") mock.method(durability, "discardTemporary", (path: string, recursive?: boolean) => { if (path === proofRoot) throw Object.assign(new Error("proof cleanup fault"), { code: "ENOTEMPTY" }); return remove(path, recursive); });
 const identify = (): void => { if (mode === "proof-short") fs.ftruncateSync(proofFd, 0); if (mode === "source-plus-close" || mode === "source-plus-cleanup") writeFileSync(source, Buffer.alloc(expected.length, 88)); };
 try {
  const action = () => writeFragmentsFromFd(f.repo.objects, fd, expected.length, 5, source, undefined, undefined, identify);
  if (mode === "partial-write") { const fragments = action(); assert.equal(short, true); assert.deepEqual(Buffer.concat(fragments.map(row => f.repo.objects.read(row.id).payload)), expected); }
  else assert.throws(action, { code: mode === "zero-write" ? "source_proof_failed" : mode === "proof-short" ? "short_read" : mode === "open-error" ? "EACCES" : mode === "source-plus-close" || mode === "source-plus-cleanup" ? "source_changed" : mode === "cleanup-error" ? "ENOTEMPTY" : "EIO" });
  assert.notEqual(proofRoot, ""); assert.equal(objectFiles.active.size, 0);
  if (mode !== "cleanup-error" && mode !== "source-plus-cleanup" && mode !== "close-plus-cleanup") assert.equal(existsSync(proofRoot), false);
 } finally { fs.closeSync(fd); mock.restoreAll(); syncBuiltinESMExports(); if (proofRoot !== "") remove(proofRoot, true); }
});


test("descriptor commitment work observes the primary deadline before any publication", async () => {
 const f = await fixture(); const source = join(f.dir.root, "source"); writeFileSync(source, Buffer.alloc(131072, 65)); const fd = fs.openSync(source, "r"); const before = f.repo.objects.inventory().map(row => row.id).sort(); let clock = 0; let advanced = false;
 mock.method(performance, "now", () => clock); const read = fs.readSync;
 mock.method(fs, "readSync", (...args: unknown[]) => { const result = Reflect.apply(read, fs, args); if (args[0] === fd) { clock = provenanceLimits.timeMs + 1; advanced = true; } return result; }); syncBuiltinESMExports();
 try { assert.throws(() => writeFragmentsFromFd(f.repo.objects, fd, 131072, 65536, source), error => error instanceof VerificationRefusal && error.verifier === "provenance" && error.bound === "time_ms"); }
 finally { fs.closeSync(fd); mock.restoreAll(); syncBuiltinESMExports(); } assert.equal(advanced, true); assert.deepEqual(f.repo.objects.inventory().map(row => row.id).sort(), before);
});


test("descriptor commitment stops reading immediately when its native store lease changes", async () => {
 const f = await fixture(); const source = join(f.dir.root, "source"); writeFileSync(source, Buffer.alloc(131072, 65)); const fd = fs.openSync(source, "r"); const lock = join(f.repo.controlDirectory, "objects.lock"); let reads = 0;
 const read = fs.readSync; mock.method(fs, "readSync", (...args: unknown[]) => { const result = Reflect.apply(read, fs, args); if (args[0] === fd) { if (++reads === 1) writeFileSync(lock, "peer replacement lock"); } return result; }); syncBuiltinESMExports();
 try { assert.throws(() => writeFragmentsFromFd(f.repo.objects, fd, 131072, 65536, source), { code: "store_locked" }); }
 finally { fs.closeSync(fd); mock.restoreAll(); syncBuiltinESMExports(); }
 assert.equal(reads, 1); assert.equal(readFileSync(lock, "utf8"), "peer replacement lock");
});


test("streamed CDC identification refuses source EOF after measuring its descriptor", async () => {
 const f = await fixture(); const source = join(f.dir.root, "source"); writeFileSync(source, "measured CDC input"); let sourceFd = -1; let reads = 0;
 const open = fs.openSync; mock.method(fs, "openSync", (...args: Parameters<typeof open>) => { const fd = Reflect.apply(open, fs, args); if (args[0] === source) sourceFd = fd; return fd; });
 const read = fs.readSync; mock.method(fs, "readSync", (...args: unknown[]) => { if (args[0] === sourceFd) { if (++reads > 1) throw Object.assign(new Error("repeated empty source read"), { code: "EIO" }); writeFileSync(source, ""); } return Reflect.apply(read, fs, args); }); syncBuiltinESMExports();
 assert.throws(() => cdcFragmentedFileContentId(source), { code: "short_read" }); assert.equal(reads, 1); assert.throws(() => fs.fstatSync(sourceFd), { code: "EBADF" });
});


test("completed erasure rejects recertifying its whole bytes through every fragment input mode", async () => {
 const f = await fixture(); const payload = readFileSync(join(f.dir.root, "asset")); f.repo.setAuthority("fixture", "read-fixture", "erase-fixture");
 f.repo.obliterate(f.entry.fileId!, "erase-fixture", "fragment-denied-source", new Date(1));
 const source = join(f.dir.root, "independent-source"); writeFileSync(source, payload); const fd = fs.openSync(source, "r");
 let identified = false; const identify = (): void => { identified = true; }; const before = f.repo.objects.inventory().map(row => row.id).sort(); const certificates = readdirSync(join(f.repo.controlDirectory, "derivations")).sort();
 try {
  for (const action of [() => writeFragmented(f.repo.objects, payload, 8, "c".repeat(32)), () => writeCdcFragmented(f.repo.objects, payload, undefined, "c".repeat(32)), () => writeFragmentsFromFd(f.repo.objects, fd, payload.length, 8, source, "c".repeat(32), undefined, identify), () => writeCdcFragmentsFromFd(f.repo.objects, fd, payload.length, DEFAULT_CDC_PARAMS, source, "c".repeat(32), undefined, identify)]) assert.throws(action, { code: "object_obliterated" });
 } finally { fs.closeSync(fd); }
 assert.deepEqual(f.repo.objects.inventory().map(row => row.id).sort(), before); assert.deepEqual(readFileSync(source), payload); assert.equal(identified, false, "denied content never reaches the producer certification callback"); assert.deepEqual(readdirSync(join(f.repo.controlDirectory, "derivations")).sort(), certificates);
 const independent = Buffer.from("independent content remains stageable after erasure"); const fresh = writeFragmented(f.repo.objects, independent, 8, "d".repeat(32)); assert.deepEqual(readFragmented(f.repo.objects, fresh.manifestId), independent);
});


test("a live store owner outlasting the publication deadline is preserved without running the writer", async () => {
 const f = await fixture(); const lock = join(f.repo.controlDirectory, "objects.lock"); const owner = String(process.pid); writeFileSync(lock, owner); let entered = false; const started = performance.now(); const link = durability.link;
 // Bound a faulty implementation that discards its deadline; retain real native contention until then.
 mock.method(durability, "link", (...args: Parameters<typeof link>) => { if (args[1] === lock && performance.now() - started > 6500) throw Object.assign(new Error("contended publication exceeded its deadline"), { code: "EIO" }); return link(...args); });
 assert.throws(() => f.repo.objects.withWriteLock(() => { entered = true; }), { code: "store_locked" });
 assert.equal(entered, false); assert.equal(readFileSync(lock, "utf8"), owner); assert.ok(performance.now() - started >= 4500);
});

for (const changed of ["size", "mtime", "unchanged"] as const) test(`failed store publication preserves an owner whose ${changed} changes during temporary retirement`, async () => {
 const f = await fixture(); const lock = join(f.repo.controlDirectory, "objects.lock"); const unlink = durability.unlink; let calls = 0; let owner = "";
 mock.method(durability, "unlink", (...args: Parameters<typeof unlink>) => {
  if (path.basename(args[0]).startsWith("objects.lock.") && args[0].endsWith(".tmp")) {
   if (++calls === 1) throw Object.assign(new Error("publication retirement fault"), { code: "EIO" });
   const result = unlink(...args); owner = readFileSync(lock, "utf8");
   if (changed === "size") { owner += "foreign"; writeFileSync(lock, owner); } else if (changed === "mtime") fs.utimesSync(lock, new Date(1000), new Date(1000));
   return result;
  }
  return unlink(...args);
 });
 assert.throws(() => f.repo.objects.withWriteLock(() => assert.fail("a failed publication cannot run its writer")), { code: "EIO" });
 assert.equal(calls, 2); assert.equal(existsSync(lock), changed !== "unchanged", "cleanup retires only the unchanged native owner"); if (changed !== "unchanged") assert.equal(readFileSync(lock, "utf8"), owner); assert.equal(objectFiles.active.size, 0);
});
