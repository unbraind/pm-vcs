import "./helpers/isolate-session.ts";
/** Faults at real publication boundaries preserve native errors and peer authority. */
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { Repository } from "../engine/repo.ts";
import { RefStore } from "../engine/refs.ts";
import { DestructionRefusal, destructionBoundary, inspectNamespacePublications, prepareDestruction, retireNamespace } from "../engine/destruction.ts";
import { durability } from "../engine/durability.ts";
import { encodeIndex, readWorkingFile } from "../engine/worktree.ts";
import { readPublicationRoots } from "../engine/publication.ts";
import { objectFiles } from "../engine/object-files.ts";
import { prepareControlPublication } from "./helpers/prepared-publication.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => {
  mock.restoreAll(); syncBuiltinESMExports(); destructionBoundary.visit = () => {};
  assert.equal(objectFiles.active.size, 0);
  for (const fixture of temporary.splice(0)) fixture.cleanup();
});
/** The native repository is deliberately outside Git and contains only synthetic bytes. */
function fixture(): Repository {
  const dir = makeTempDir(); temporary.push(dir); process.env.GIT_CEILING_DIRECTORIES = dirname(dir.root);
  return Repository.init(dir.root);
}
/** Address the ledger derived by the engine from this one owned namespace. */
function ledger(control: string): string {
  return join(tmpdir(), `pm-vcs-namespace-${createHash("sha256").update(fs.realpathSync(control)).digest("hex")}`, "destruction");
}

test("publication cancellation refuses a changed destination before ending replay authority", () => {
  const repo = fixture(); const source = join(repo.controlDirectory, "source"); const target = join(repo.controlDirectory, "target");
  writeFileSync(source, "prepared"); writeFileSync(target, "original");
  const plan = prepareDestruction(repo.controlDirectory, "cancel-peer", [{ path: source, destination: target }]);
  writeFileSync(target, "peer value");
  assert.throws(() => plan.cancelPublication(), { code: "destructive_target_changed" });
  assert.equal(readFileSync(source, "utf8"), "prepared"); assert.equal(readFileSync(target, "utf8"), "peer value");
  assert.equal(plan.finish().status, "pending");
  rmSync(target); assert.throws(() => plan.cancelPublication(), { code: "destructive_target_changed" });
});

test("missing publication sources cannot adopt an unrelated recorded rename", () => {
  const repo = fixture(); const target = join(repo.controlDirectory, "metadata"); const source = join(repo.controlDirectory, "original");
  writeFileSync(source, "prepared original"); writeFileSync(target, "old value");
  destructionBoundary.visit = step => { if (step === "before-delete") throw new Error("interrupted original"); };
  assert.throws(() => durability.rename(source, target)); destructionBoundary.visit = () => {};
  assert.throws(() => retireNamespace({ path: join(repo.controlDirectory, "missing"), destination: target }), { code: "destructive_target_changed" });
  assert.equal(readFileSync(target, "utf8"), "old value"); assert.equal(readFileSync(source, "utf8"), "prepared original");
  const directory = ledger(repo.controlDirectory);
  const name = readdirSync(directory).find(name => name.endsWith(".json") && JSON.parse(readFileSync(join(directory, name), "utf8")).status === "pending")!;
  const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as { entries: { destination: string }[] };
  record.entries[0]!.destination = "another-target"; writeFileSync(join(directory, name), JSON.stringify(record)); rmSync(source);
  assert.throws(() => retireNamespace({ path: source, destination: target }), { code: "destructive_target_changed" });
  assert.equal(readFileSync(target, "utf8"), "old value");
});

test("publication recovery propagates native faults and pending target changes", () => {
  for (const mode of ["native", "refusal", "pending", "finish"] as const) {
    const repo = fixture(); const a = repo.objects.write("blob", Buffer.from("original")); const b = repo.objects.write("blob", Buffer.from("prepared"));
    const target = join(repo.controlDirectory, "refs/metadata/live"); repo.refs.compareAndSwap("refs/metadata/live", null, a);
    const source = prepareControlPublication(repo, target, `${b}\n`);
    const error = mode === "native" ? Object.assign(new Error("recovery I/O"), { code: "EIO" }) : undefined;
    if (mode === "native") { const rename = fs.renameSync; mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => { if (args[0] === source) throw error; return rename(...args); }); syncBuiltinESMExports(); }
    else if (mode === "finish") destructionBoundary.visit = step => { if (step === "receipt-persisted" && !existsSync(source)) throw new DestructionRefusal("destructive_target_changed", "checkpoint interruption"); };
    else { const rename = fs.renameSync; mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => { if (args[0] === source) throw new DestructionRefusal(mode === "pending" ? "destructive_target_changed" : "unplanned_deletion", "typed recovery refusal"); return rename(...args); }); syncBuiltinESMExports(); }
    assert.throws(() => durability.recoverPublication(target), mode === "native" ? failure => failure === error : { code: mode === "refusal" ? "unplanned_deletion" : "destructive_target_changed" });
    assert.equal(repo.refs.read("refs/metadata/live"), mode === "finish" ? b : a); assert.equal(existsSync(source), mode !== "finish");
    destructionBoundary.visit = () => {}; mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("cancelled publication cleanup retains native failure and converges on retry", () => {
 for (const mode of ["native", "typed", "checkpoint"] as const) {
  const repo = fixture(); const a = repo.objects.write("blob", Buffer.from("original")); const b = repo.objects.write("blob", Buffer.from("collected target"));
  const target = join(repo.controlDirectory, "refs/metadata/live"); repo.refs.compareAndSwap("refs/metadata/live", null, a);
  const source = prepareControlPublication(repo, target, `${b}\n`);
  rmSync(join(repo.objects.storageRoot(), b.slice(0, 2), b.slice(2)));
  const unlink = fs.unlinkSync; const error = mode === "native" ? Object.assign(new Error("cleanup I/O"), { code: "EIO" }) : new DestructionRefusal("destructive_target_changed", "cleanup interrupted");
  mock.method(fs, "unlinkSync", (...args: Parameters<typeof fs.unlinkSync>) => { if (args[0] === source && mode !== "checkpoint") throw error; return unlink(...args); }); syncBuiltinESMExports();
  if (mode === "checkpoint") destructionBoundary.visit = step => { if (step === "receipt-persisted" && !existsSync(source)) throw error; };
  assert.throws(() => durability.recoverPublication(target), failure => mode === "native" ? failure === error : failure instanceof DestructionRefusal && failure.code === error.code);
  assert.equal(repo.refs.read("refs/metadata/live"), a); assert.equal(existsSync(source), mode !== "checkpoint");
  destructionBoundary.visit = () => {}; mock.restoreAll(); syncBuiltinESMExports(); durability.recoverPublication(target);
  assert.equal(existsSync(source), false); assert.equal(repo.refs.read("refs/metadata/live"), a);
 }
});

test("publication recovery without a ledger leaves an ordinary destination unchanged", () => {
  const dir = makeTempDir(); temporary.push(dir); const target = join(dir.root, "ordinary"); writeFileSync(target, "retained");
  durability.recoverPublication(target); assert.equal(readFileSync(target, "utf8"), "retained"); assert.equal(existsSync(ledger(dir.root)), false);
});

for (const mode of ["intent-error", "progress-error", "source-absent"] as const) test(`publication inventory preserves ${mode} without inventing roots`, () => {
  const repo = fixture(); const a = repo.objects.write("blob", Buffer.from("original")); const b = repo.objects.write("blob", Buffer.from("prepared"));
  const target = join(repo.controlDirectory, "refs/metadata/live"); repo.refs.compareAndSwap("refs/metadata/live", null, a);
  const source = prepareControlPublication(repo, target, `${b}\n`); const directory = ledger(repo.controlDirectory);
  const name = readdirSync(directory).find(name => name.endsWith(".json") && JSON.parse(readFileSync(join(directory, name), "utf8")).status === "pending")!;
  const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as { id: string };
  const selected = mode === "intent-error" ? join(directory, name) : join(directory, `${name.slice(0, -5)}.${record.id}.progress`);
  if (mode === "source-absent") rmSync(source);
  else {
    const read = fs.readFileSync; const error = Object.assign(new Error("inventory I/O"), { code: "EIO" });
    mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => { if (args[0] === selected) throw error; return Reflect.apply(read, fs, args); });
    { const open = fs.openSync; mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { if (args[0] === selected) throw error; return open(...args); }); }
    syncBuiltinESMExports();
    assert.throws(() => inspectNamespacePublications(repo.controlDirectory, () => true, () => assert.fail("faulted inventory must not inspect roots")), failure => failure === error);
    return;
  }
  const inventory = inspectNamespacePublications(repo.controlDirectory, () => true, () => assert.fail("missing source must not invent roots"));
  assert.equal(inventory.pending, 0); assert.equal(repo.refs.read("refs/metadata/live"), a);
});

test("ordinary publication root reads do not open source bytes", () => {
  const dir = makeTempDir(); temporary.push(dir);
  assert.deepEqual(readPublicationRoots(join(dir.root, "missing-source"), join(dir.root, "ordinary")), []);
  assert.equal(objectFiles.active.size, 0);
});

test("HEAD transaction validation rejects malformed and duplicate destinations before recovery", () => {
  const repo = fixture(); const before = repo.refs.rawHead(); const id = repo.objects.write("blob", Buffer.from("HEAD target"));
  assert.throws(() => repo.refs.transaction([], undefined, { expected: "bad HEAD" }), { code: "invalid_object_id" });
  assert.throws(() => repo.refs.transaction([{ name: "HEAD", expected: null, next: id }], undefined, { expected: before }), { code: "duplicate_ref_update" });
  assert.equal(repo.refs.rawHead(), before);
});

test("HEAD recovery handles an absent predecessor and a peer value without adopting success", () => {
  const repo = fixture(); const a = repo.objects.write("blob", Buffer.from("HEAD A")); const b = repo.objects.write("blob", Buffer.from("HEAD B")); const target = join(repo.controlDirectory, "HEAD");
  rmSync(target); prepareControlPublication(repo, target, `${b}\n`);
  assert.throws(() => repo.refs.transaction([], undefined, { expected: a, next: b }), { code: "head_changed" }); assert.equal(repo.refs.rawHead(), b);
  prepareControlPublication(repo, target, `${a}\n`);
  assert.throws(() => repo.refs.transaction([], undefined, { expected: b, next: "ref: refs/heads/main" }), { code: "head_changed" }); assert.equal(repo.refs.rawHead(), a);
});

test("permissive ref enumeration skips unreadable leaves while retaining readable peers", () => {
  const dir = makeTempDir(); temporary.push(dir); const refs = new RefStore(dir.root); const prefix = join(dir.root, "refs/heads"); mkdirSync(prefix, { recursive: true });
  const id = "a".repeat(64); writeFileSync(join(prefix, "readable"), id); writeFileSync(join(prefix, "unreadable"), id);
  const read = fs.readFileSync; mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => { if (args[0] === join(prefix, "unreadable")) throw Object.assign(new Error("ref I/O"), { code: "EIO" }); return Reflect.apply(read, fs, args); }); syncBuiltinESMExports();
  assert.deepEqual(refs.list("refs/heads/"), [{ name: "refs/heads/readable", target: id }]);
  assert.throws(() => refs.list("refs/heads/", true), error => error instanceof Error && "bound" in error && error.bound === "ref_io");
});

test("index owner inspection failure releases its lock before a temporary exists", () => {
  const repo = fixture(); const id = repo.objects.write("blob", Buffer.from("index payload")); const index = join(repo.controlDirectory, "index"); const before = readFileSync(index);
  const open = fs.openSync; const stat = fs.fstatSync; let descriptor = -1; let injected = false;
  const failure = Object.assign(new Error("index owner inspection I/O"), { code: "EIO" });
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { const fd = open(...args); if (args[0] === index + ".lock") descriptor = fd; return fd; });
  mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => { if (args[0] === descriptor && !injected) { injected = true; throw failure; } return Reflect.apply(stat, fs, args); }); syncBuiltinESMExports();
  assert.throws(() => repo.writeIndex([{ path: "asset", id, mode: "100644" }]), error => error === failure);
  assert.deepEqual(readFileSync(index), before); assert.equal(existsSync(index + ".lock"), false);
  assert.deepEqual(readdirSync(repo.controlDirectory).filter(name => /^index\..*\.tmp$/.test(name)), []);
  mock.restoreAll(); syncBuiltinESMExports(); repo.writeIndex([{ path: "asset", id, mode: "100644" }]); assert.equal(repo.readIndex()[0]!.id, id);
});

test("status cache recovery loses its CAS to a newer index and releases its owner", () => {
  const repo = fixture(); writeFileSync(join(repo.root, "asset"), "working payload"); repo.stage(["asset"]);
  const entry = repo.readIndex()[0]!; repo.writeIndex([{ ...entry, stat: undefined }]);
  const index = join(repo.controlDirectory, "index"); const next = encodeIndex([]); let changed = false;
  const recover = durability.recoverPublication;
  mock.method(durability, "recoverPublication", (path: string) => { recover(path); if (path === index) { changed = true; writeFileSync(index, next); } });
  const read: typeof readWorkingFile = (root, path) => readWorkingFile(root, path, () => BigInt(Date.now()) * 1_000_000n + 3_000_000_000n);
  repo.status(read); assert.ok(changed); assert.equal(readFileSync(index, "utf8"), next); assert.equal(existsSync(index + ".lock"), false);
});
