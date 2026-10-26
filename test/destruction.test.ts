import "./helpers/isolate-session.ts";
/** Exact-set intents on real filesystems survive every publication/deletion cut and preserve peer data. */
import { testEnvironment } from "./helpers/test-environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { cpSync, existsSync, fstatSync, openSync, symlinkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, mock, test } from "node:test";
import { durability } from "../engine/durability.ts";
import { destructionBoundary, prepareDestruction, prepareNamespaceDestruction, inspectDestructions, retireNamespace, measureDestructionRevision, DestructionRefusal } from "../engine/destruction.ts";
import { syncBuiltinESMExports } from "node:module";
import { objectFiles } from "../engine/object-files.ts";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const dirs: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { objectFiles.opened = () => {}; mock.restoreAll(); syncBuiltinESMExports(); destructionBoundary.visit = () => {}; for (const dir of dirs.splice(0)) dir.cleanup(); assert.equal(objectFiles.active.size, 0); });
/** A journal is outside both the deletion tree and an unrelated tripwire directory. */
function fixture() {
  const dir = makeTempDir(); dirs.push(dir); const control = join(dir.root, "control"); const data = join(dir.root, "data"); const tripwire = join(dir.root, "tripwire");
  mkdirSync(control); mkdirSync(data); mkdirSync(tripwire); writeFileSync(join(tripwire, "guard"), "untouched sentinel");
  for (const name of ["a", "b", "c"]) writeFileSync(join(data, name), `owned-${name}`);
  return { dir, control, data, tripwire, paths: ["a", "b", "c"].map(name => join(data, name)) };
}
/** Execute only the paths captured by the durable handle, including when the new request contains extra files. */
function drain(control: string, key: string, paths: readonly string[]) {
  const plan = prepareDestruction(control, key, paths.map(path => ({ path })));
  for (const path of plan.paths) plan.remove(path);
  return plan.finish();
}

test("whole-set validation refuses an invalid final member before deleting the first valid member", () => {
  const f = fixture(); mkdirSync(join(f.data, "not-empty")); writeFileSync(join(f.data, "not-empty/guard"), "foreign");
  assert.throws(() => prepareDestruction(f.control, "invalid", [{ path: f.paths[0] }, { path: join(f.data, "not-empty"), directory: true }]), { code: "ENOTEMPTY" });
  for (const path of f.paths) assert.ok(existsSync(path)); assert.equal(readFileSync(join(f.tripwire, "guard"), "utf8"), "untouched sentinel");
});

test("every intent, deletion, progress and receipt boundary recovers the same set without duplicate removal", t => {
  let cases = 0;
  for (const step of ["intent-persisted", "before-delete", "deleted", "progress-persisted", "receipt-persisted", "lock-release"]) for (let cut = 1; cut <= (step === "intent-persisted" || step === "receipt-persisted" ? 1 : step === "lock-release" ? 5 : 3); cut++) {
    const f = fixture(); let seen = 0; const failure = new Error("injected crash");
    destructionBoundary.visit = current => { if (current === step && ++seen === cut) throw failure; };
    assert.throws(() => drain(f.control, "operation", f.paths)); destructionBoundary.visit = () => {};
    const receipt = drain(f.control, "operation", f.paths); assert.equal(receipt.status, "completed"); assert.equal(receipt.planned, 3); assert.equal(receipt.deleted + receipt.observedAbsent, 3); assert.equal(receipt.skipped, 0);
    for (const path of f.paths) assert.equal(existsSync(path), false); assert.equal(readFileSync(join(f.tripwire, "guard"), "utf8"), "untouched sentinel"); cases++;
  }
  t.diagnostic(`${cases} crash positions recover the identical three-member plan`);
});

test("recovery never expands a frozen set to newly arrived files and preserves replaced members", () => {
  const f = fixture(); const first = prepareDestruction(f.control, "set", f.paths.map(path => ({ path }))); first.remove(f.paths[0]);
  const extra = join(f.data, "new-arrival"); writeFileSync(extra, "must not join recovery");
  renameSync(f.paths[1], `${f.paths[1]}-old`); writeFileSync(f.paths[1], "foreign replacement");
  const recovered = prepareDestruction(f.control, "set", [...f.paths, extra].map(path => ({ path }))); assert.equal(recovered.resumed, true); assert.deepEqual(recovered.paths, f.paths);
  for (const path of recovered.paths) recovered.remove(path);
  assert.throws(() => recovered.finish(), error => error instanceof Error && "receipt" in error);
  assert.equal(readFileSync(extra, "utf8"), "must not join recovery"); assert.equal(readFileSync(f.paths[1], "utf8"), "foreign replacement"); assert.equal(existsSync(f.paths[2]), false);
});

test("recursive removal snapshots leaves first and cannot remove a peer directory child introduced after planning", () => {
  const f = fixture(); let injected = false;
  destructionBoundary.visit = step => { if (step === "intent-persisted" && !injected) { injected = true; writeFileSync(join(f.data, "peer"), "owned by peer"); } };
  assert.throws(() => durability.scoped(f.control, () => durability.remove(f.data, { recursive: true })), { code: "destructive_target_changed" });
  destructionBoundary.visit = () => {}; assert.equal(readFileSync(join(f.data, "peer"), "utf8"), "owned by peer"); for (const path of f.paths) assert.equal(existsSync(path), false);
});

test("property: seeded valid request sets, partial deletes and extra-arrival recovery match an independent set model", t => {
  const dir = makeTempDir(); dirs.push(dir); let random = 7139; let operations = 0;
  const next = (): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  for (let seed = 1; seed <= 512; seed++) {
    const root = join(dir.root, String(seed)); const control = join(root, "control"); const data = join(root, "data"); mkdirSync(control, { recursive: true }); mkdirSync(data);
    const paths = Array.from({ length: 1 + next() % 5 }, (_, i) => join(data, `owned-${i}`)); for (const path of paths) writeFileSync(path, `seed-${seed}-${next()}`);
    const original = new Set(paths); const plan = prepareDestruction(control, "random", paths.map(path => ({ path })));
    const prefix = next() % (paths.length + 1); for (const path of paths.slice(0, prefix)) { plan.remove(path); operations++; }
    const extra = join(data, "tripwire"); writeFileSync(extra, "not planned"); const hash = createHash("sha256").update(readFileSync(extra)).digest("hex");
    const receipt = drain(control, "random", [...paths, extra]); assert.equal(receipt.planned, original.size); assert.equal(receipt.deleted + receipt.observedAbsent, original.size); assert.equal(receipt.skipped, 0);
    for (const path of original) assert.equal(existsSync(path), false); assert.equal(createHash("sha256").update(readFileSync(extra)).digest("hex"), hash); assert.deepEqual(readdirSync(data), ["tripwire"]); operations++;
  }
  t.diagnostic(`512 seeded valid stores; ${operations} deletion/recovery operations; every extra-arrival tripwire retained`);
});


/** Native subprocesses use only deliberate operational environment keys and a bounded completion window. */
function worker(root: string, mode: string, cut = 0) { return spawnSync(process.execPath, [join(packageRoot, "test/helpers/destruction-worker.ts"), root, mode, String(cut)], { env: testEnvironment(), encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }); }
/** Reset data without changing the shared SDK tracker or relying on Git discovery. */
function nativeFixture(root: string, trial: string): string { const path = join(root, trial); mkdirSync(join(path, ".pmvcs"), { recursive: true }); mkdirSync(join(path, "data")); for (const name of ["a", "b", "c"]) writeFileSync(join(path, "data", name), `native ${name}`); return path; }

test("native SIGKILL at every intent/owner write and deletion boundary converges, including a crash during dead-owner recovery", async t => {
  if (process.platform === "win32") return;
  const dir = makeTempDir(); dirs.push(dir); await new PmClient({ cwd: dir.root, pmRoot: join(dir.root, ".agents/pm"), noExtensions: true }).init("native-intent", { defaults: true, author: "fixture" });
  const baseline = nativeFixture(dir.root, "trace"); const observed = worker(baseline, "trace"); assert.equal(observed.status, 0, observed.stderr);
  const trace = (JSON.parse(observed.stdout) as { trace: string[] }).trace; assert.ok(trace.length > 50);
  for (let cut = 1; cut <= trace.length; cut++) {
    const root = nativeFixture(dir.root, `cut-${cut}`); const result = worker(root, "crash", cut); assert.equal(result.signal, "SIGKILL", `${cut}: ${result.stderr}`);
    const recovery = worker(root, "drain"); assert.equal(recovery.status, 0, `${cut} ${trace[cut - 1]}: ${recovery.stderr}`);
    const value = JSON.parse(recovery.stdout) as { receipt: { status: string; planned: number; deleted: number; observedAbsent: number; skipped: number } };
    assert.equal(value.receipt.status, "completed"); assert.equal(value.receipt.planned, 3); assert.equal(value.receipt.deleted + value.receipt.observedAbsent, 3); assert.equal(value.receipt.skipped, 0); assert.deepEqual(readdirSync(join(root, "data")), []);
  }
  const root = nativeFixture(dir.root, "dead-recovery"); const published = trace.findIndex(step => step.startsWith("owner-published:")) + 1; assert.ok(published > 0); assert.equal(worker(root, "crash", published).signal, "SIGKILL"); assert.equal(worker(root, "dead-crash").signal, "SIGKILL"); const recovered = worker(root, "drain"); assert.equal(recovered.status, 0, recovered.stderr); assert.deepEqual(readdirSync(join(root, "data")), []);
  t.diagnostic(`${trace.length + 2} actual SIGKILL positions across owner publication, intent publication, member deletion, progress, receipt and dead-owner recovery`);
});

test("a competing process is refused at every intent boundary and truthfully observes the same completed receipt afterward", async t => {
  const dir = makeTempDir(); dirs.push(dir); await new PmClient({ cwd: dir.root, pmRoot: join(dir.root, ".agents/pm"), noExtensions: true }).init("peer-intent", { defaults: true, author: "fixture" });
  const steps = ["intent-persisted", "before-delete", "deleted", "progress-persisted", "receipt-persisted", "lock-release"];
  for (const step of steps) {
    const root = nativeFixture(dir.root, step); let attempted = false;
    destructionBoundary.visit = current => { if (current !== step || attempted) return; attempted = true; const peer = worker(root, "blocked"); assert.equal(peer.status, 0, peer.stderr); assert.equal((JSON.parse(peer.stdout) as { code: string }).code, "destructive_intent_locked"); };
    const receipt = durability.scoped(join(root, ".pmvcs"), () => drain(join(root, ".pmvcs"), "shared-drain", ["a", "b", "c"].map(name => join(root, "data", name)))); destructionBoundary.visit = () => {}; assert.equal(attempted, true);
    const peer = worker(root, "drain"); assert.equal(peer.status, 0, peer.stderr); const observed = JSON.parse(peer.stdout) as { resumed: boolean; receipt: { id: string; planned: number; deleted: number } }; assert.equal(observed.resumed, true); assert.equal(observed.receipt.id, receipt.id); assert.equal(observed.receipt.planned, 3); assert.equal(observed.receipt.deleted, 3);
  }
  t.diagnostic(`${steps.length} native competing process boundaries; each peer later reports the original completed receipt`);
});

/** Read a captured package record for independent schema-corruption tests. */
function recordPath(control: string): string { return join(control, "destruction", readdirSync(join(control, "destruction")).find(name => name.endsWith(".json"))!); }

test("invalid flags, paths, destination types and expected identities refuse the entire set before the tripwire changes", () => {
  const f = fixture(); const link = join(f.dir.root, "parent-link"); symlinkSync(f.data, link, "dir");
  const invalid = [
    null, {}, { path: "" }, { path: "/" }, { path: "bad\0path" }, { path: f.paths[0], force: true }, { path: f.paths[0], recursive: "yes" }, { path: f.paths[0], directory: 1 },
    { path: f.paths[0], expected: {} }, { path: f.paths[0], address: 1 }, { path: f.paths[0], destinationAddress: 1 }, { path: join(link, "a") },
    { path: f.paths[0], destination: f.paths[0] }, { path: f.paths[0], destination: "" }, { path: f.paths[0], destination: f.paths[1], recursive: true },
    { path: f.data, destination: f.paths[1] }, { path: f.paths[0], destination: f.data }, { path: f.paths[0], destination: join(f.dir.root, "missing", "dest") },
    { path: f.paths[0], expected: lstatSync(f.paths[1], { bigint: true }) },
  ];
  for (const request of invalid) { assert.throws(() => prepareDestruction(f.control, "invalid-member", [{ path: f.paths[2] }, request as never])); for (const path of f.paths) assert.ok(existsSync(path)); }
  assert.throws(() => prepareDestruction(f.control, "duplicates", [{ path: f.paths[0] }, { path: f.paths[0], destination: f.paths[1] }]), { code: "conflicting_destructive_requests" });
  for (const key of ["", "bad\0key", undefined]) assert.throws(() => prepareDestruction(f.control, key as never, []), { code: "conflicting_destructive_requests" });
  for (const options of [null, [], { force: 1 }, { recursive: "yes" }, { extra: true }]) assert.throws(() => durability.remove(f.paths[0], options as never), { code: "conflicting_destructive_requests" });
  assert.throws(() => retireNamespace({ path: f.paths[0], expected: null as never }), { code: "conflicting_destructive_requests" });
  assert.equal(readFileSync(join(f.tripwire, "guard"), "utf8"), "untouched sentinel");
});

test("foreign schema records and mutex owners never grant deletion authority", () => {
  const f = fixture(); prepareDestruction(f.control, "schema", f.paths.map(path => ({ path }))); const path = recordPath(f.control); const original = readFileSync(path); const parsed = JSON.parse(original.toString()) as Record<string, unknown>;
  const corruptions: Record<string, unknown>[] = [null as never, {}, { ...parsed, extra: true }, { ...parsed, format: "foreign" }, { ...parsed, id: "x" }, { ...parsed, root: "relative" }, { ...parsed, revision: 1 }, { ...parsed, revision: "foreign" }, { ...parsed, rootIdentity: "x" }, { ...parsed, status: "foreign" }, { ...parsed, entries: {} }];
  const entry = (parsed.entries as Record<string, unknown>[])[0];
  for (const patch of [null, { extra: true }, { path: "/absolute" }, { path: "a\0b" }, { path: "" }, { path: "x/../a" }, { parent: "/" }, { destination: "/" }, { kind: "foreign" }, { identity: "x" }, { digest: "x" }, { parentIdentity: "x" }, { status: "unknown" }, { kind: "rename" }, { target: "absent" }, { reason: "UPPERCASE" }, { reason: "unknown_reason" }]) corruptions.push({ ...parsed, entries: [patch === null ? null : { ...entry, ...patch }] });
  corruptions.push({ ...parsed, status: "completed" });
  for (const value of ["truncated", ...corruptions.map(value => JSON.stringify(value))]) { writeFileSync(path, value); assert.throws(() => prepareDestruction(f.control, "schema", f.paths.map(path => ({ path }))), { code: "foreign_destructive_intent" }); assert.ok(existsSync(f.paths[0])); }
  writeFileSync(path, original);
  for (const owner of ["", "{", "null", JSON.stringify({ format: "foreign" }), JSON.stringify({ format: "pm-vcs-destruction-lock-1", cleanup: "unlink-only-this-inode", root: f.control, rootIdentity: "0:0:0", pid: -1 })]) { writeFileSync(`${path}.lock`, owner); assert.throws(() => prepareDestruction(f.control, "schema", []), { code: "destructive_intent_locked" }); assert.equal(readFileSync(`${path}.lock`, "utf8"), owner); rmSync(`${path}.lock`); }
  rmSync(path); mkdirSync(path); assert.throws(() => prepareDestruction(f.control, "schema", []), { code: "foreign_destructive_intent" }); rmSync(path, { recursive: true }); writeFileSync(path, original);
  const other = fixture(); writeFileSync(recordPath(f.control), JSON.stringify({ ...parsed, root: other.control })); assert.throws(() => prepareDestruction(f.control, "schema", []), { code: "foreign_destructive_intent" });
});

test("recovery rejects a different set, superseded intent or missing checkpoint and never deletes a replacement", () => {
  const f = fixture(); const first = prepareDestruction(f.control, "same", f.paths.map(path => ({ path })));
  assert.throws(() => prepareDestruction(f.control, "same", [{ path: f.paths[0] }]), { code: "destructive_plan_conflict" });
  assert.throws(() => first.remove(join(f.tripwire, "guard")), { code: "unplanned_deletion" });
  assert.equal(first.finish().status, "pending"); for (const path of first.paths) first.remove(path); const completed = first.finish(); assert.equal(completed.status, "completed");
  writeFileSync(f.paths[0], "new owner"); const second = prepareDestruction(f.control, "same", [{ path: f.paths[0] }]); assert.throws(() => first.remove(f.paths[1]), { code: "destructive_intent_changed" });
  const path = recordPath(f.control); const checkpoint = readFileSync(path); rmSync(path); assert.throws(() => second.finish(), { code: "destructive_intent_changed" }); writeFileSync(path, checkpoint); second.remove(f.paths[0]); second.finish();
  const resumed = prepareDestruction(f.control, "same", [], true); assert.equal(resumed.resumed, true); writeFileSync(f.paths[0], "retained after retirement"); assert.throws(() => resumed.finish(), error => error instanceof DestructionRefusal && error.receipt?.planned === 1 && error.receipt.deleted === 1); assert.equal(readFileSync(f.paths[0], "utf8"), "retained after retirement");
});

test("root and parent retirement cancel pending authority while terminal receipts remain historical", () => {
  for (const moved of ["root", "parent"]) {
    const f = fixture(); const plan = prepareDestruction(f.control, "lifecycle", f.paths.map(path => ({ path })));
    const target = moved === "root" ? f.control : f.data; renameSync(target, `${target}-retired`); mkdirSync(target); writeFileSync(join(target, "a"), "new lifetime");
    if (moved === "root") assert.throws(() => plan.remove(f.paths[0]), { code: "destructive_target_changed" }); else plan.remove(f.paths[0]); assert.throws(() => plan.finish(), error => error instanceof Error && "receipt" in error);
    assert.equal(readFileSync(join(target, "a"), "utf8"), "new lifetime");
  }
  const f = fixture(); prepareDestruction(f.control, "lifecycle", f.paths.map(path => ({ path }))); const original = recordPath(f.control); const record = JSON.parse(readFileSync(original, "utf8")) as Record<string, unknown>; writeFileSync(original, JSON.stringify({ ...record, rootIdentity: "0:0:0" })); const next = prepareDestruction(f.control, "lifecycle", f.paths.map(path => ({ path }))); for (const path of next.paths) next.remove(path); assert.equal(next.finish().status, "completed"); assert.ok(readdirSync(join(f.control, "destruction")).some(name => name.endsWith(".receipt")));
});

test("rename crash recovery accounts the moved inode, refuses a replaced destination and supports literal links", () => {
  for (const crash of [false, true]) {
    const f = fixture(); const destination = join(f.tripwire, "publication"); const plan = prepareDestruction(f.control, "rename", [{ path: f.paths[0], destination }]);
    let cut = false; destructionBoundary.visit = step => { if (crash && step === "deleted" && !cut) { cut = true; throw new Error("crash after rename"); } };
    if (crash) assert.throws(() => plan.remove(f.paths[0]), { code: "destructive_operation_pending" }); else plan.remove(f.paths[0]); destructionBoundary.visit = () => {};
    const recovered = prepareDestruction(f.control, "rename", [{ path: f.paths[0], destination }]); for (const path of recovered.paths) recovered.remove(path); assert.equal(recovered.finish().moved, 1); assert.equal(readFileSync(destination, "utf8"), "owned-a");
  }
  const f = fixture(); const destination = join(f.tripwire, "publication"); const plan = prepareDestruction(f.control, "replace-destination", [{ path: f.paths[0], destination }]); writeFileSync(destination, "peer"); plan.remove(f.paths[0]); assert.throws(() => plan.finish(), { code: "destructive_target_changed" }); assert.equal(readFileSync(destination, "utf8"), "peer");
  const link = join(f.data, "link"); symlinkSync(join(f.tripwire, "guard"), link); const receipt = durability.scoped(f.control, () => durability.unlink(link)); assert.equal(receipt.deleted, 1); assert.equal(readFileSync(join(f.tripwire, "guard"), "utf8"), "untouched sentinel");
});

test("progress corruption preserves remaining members, while absence can complete a damaged historical acknowledgment", () => {
  for (const mutation of ["truncated", "header", "state"]) {
    const f = fixture(); const plan = prepareDestruction(f.control, "bitmap", f.paths.map(path => ({ path }))); plan.remove(f.paths[0]); const progress = join(f.control, "destruction", readdirSync(join(f.control, "destruction")).find(name => name.endsWith(".progress"))!); const original = readFileSync(progress); const damaged = Buffer.from(original); if (mutation === "header") damaged[0] ^= 1; else if (mutation === "state") damaged[77] = 255; writeFileSync(progress, mutation === "truncated" ? damaged.subarray(0, 10) : damaged);
    const recovered = prepareDestruction(f.control, "bitmap", f.paths.map(path => ({ path }))); assert.throws(() => recovered.remove(f.paths[1]), { code: "foreign_destructive_intent" }); assert.ok(existsSync(f.paths[1]));
    rmSync(f.paths[1]); rmSync(f.paths[2]); assert.equal(recovered.finish().status, "completed");
  }
});

test("bounded receipt inspection preserves foreign, auxiliary, unreadable and other-root entries", () => {
  const f = fixture(); assert.deepEqual(inspectDestructions(f.control).receipts, []); const directory = join(f.control, "destruction"); writeFileSync(directory, "foreign"); assert.equal(inspectDestructions(f.control).skippedCount, 1); rmSync(directory);
  const paths = Array.from({ length: 24 }, (_, i) => join(f.data, `bounded-${i}`)); for (const path of paths) writeFileSync(path, "owned"); const plan = prepareDestruction(f.control, "bounded", paths.map(path => ({ path }))); assert.equal(plan.finish().omitted, 4); plan.remove(paths[0]); assert.equal(inspectDestructions(f.control).pending, 1);
  const path = recordPath(f.control); const original = readFileSync(path, "utf8"); const record = JSON.parse(original) as Record<string, unknown>; const foreignName = join(directory, `${"a".repeat(64)}.json`); writeFileSync(foreignName, JSON.stringify({ ...record, root: f.dir.root })); writeFileSync(join(directory, `${"b".repeat(64)}.json`), "not json"); mkdirSync(join(directory, "foreign-directory"));
  assert.ok(inspectDestructions(f.control, 1).skippedCount >= 4); for (const limit of [0, 21, 1.5, NaN]) assert.throws(() => inspectDestructions(f.control, limit), { code: "invalid_receipt_limit" });
  for (const member of plan.paths) plan.remove(member); plan.finish(); assert.ok(inspectDestructions(f.control).completed > 0);
});

test("owned raw descriptor cleanup closes last and reports absent or peer owners without deleting them", () => {
  const f = fixture();
  for (const mode of ["owned", "absent", "peer", "changed-bytes"]) {
    const path = join(f.data, `lease-${mode}`); const fd = openSync(path, "wx"); const original = fstatSync(fd, { bigint: true });
    if (mode === "absent") rmSync(path); if (mode === "peer") { renameSync(path, `${path}.old`); writeFileSync(path, "peer"); } if (mode === "changed-bytes") writeFileSync(path, "new bytes");
    const result = durability.scoped(f.control, () => durability.release(path, fd, mode === "owned" ? undefined : original)); assert.throws(() => fstatSync(fd), { code: "EBADF" });
    if (mode === "owned") assert.equal("deleted" in result && result.deleted, 1); else { assert.equal("released" in result && result.released, false); if (mode !== "absent") assert.ok(existsSync(path)); }
  }
});

test("pinned hash and checkpoint races refuse before deletion and close every opened descriptor", () => {
  for (const phase of ["hash-open", "hash-read", "intent-replaced", "intent-removed", "intent-unreadable", "progress-unreadable"]) {
    const f = fixture(); let record: string | undefined; if (phase.startsWith("intent") || phase.startsWith("progress")) { const initial = prepareDestruction(f.control, "pinned", f.paths.map(path => ({ path }))); record = recordPath(f.control); if (phase.startsWith("progress")) initial.remove(f.paths[0]); }
    let injected = false; const read = fs.readSync;
    objectFiles.opened = (_file, path) => {
      if (injected) return;
      if ((phase === "hash-open" && path === f.paths[1]) || (phase.startsWith("intent") && path === record)) { injected = true; if (phase === "intent-removed") rmSync(path); else if (phase === "intent-unreadable") throw Object.assign(new Error("unreadable"), { code: "EIO" }); else { renameSync(path, `${path}.old`); writeFileSync(path, "replacement"); } }
      if (phase === "progress-unreadable" && path.endsWith(".progress")) { injected = true; throw Object.assign(new Error("unreadable progress"), { code: "EIO" }); }
    };
    if (phase === "hash-read") { const inode = lstatSync(f.paths[1]).ino; mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => { const result = Reflect.apply(read, fs, args) as number; if (!injected && fstatSync(args[0]).ino === inode) { injected = true; writeFileSync(f.paths[1], "rewritten while hashing"); } return result; }); syncBuiltinESMExports(); }
    if (phase === "progress-unreadable") { const p = prepareDestruction(f.control, "pinned", f.paths.map(path => ({ path }))); assert.throws(() => p.remove(f.paths[1])); }
    else assert.throws(() => prepareDestruction(f.control, "pinned", f.paths.map(path => ({ path }))));
    objectFiles.opened = () => {}; mock.restoreAll(); syncBuiltinESMExports(); assert.equal(injected, true); assert.ok(existsSync(f.paths[2])); assert.equal(objectFiles.active.size, 0);
  }
});

test("intent ownership changes, missing owners and repeated acquisition contention preserve all selected files", () => {
  for (const mode of ["missing", "replacement", "error", "disappearing-contention", "exhausted"]) {
    const f = fixture(); let injected = false; const link = fs.linkSync;
    if (["missing", "replacement", "error"].includes(mode)) destructionBoundary.visit = (step, path) => { if (step !== "owner-published" || injected) return; injected = true; if (mode === "error") throw new Error("owner boundary error"); rmSync(path); if (mode === "replacement") writeFileSync(path, "foreign owner"); };
    else { mock.method(fs, "linkSync", (source: fs.PathLike, destination: fs.PathLike) => { if (String(destination).endsWith(".json.lock")) { injected = true; throw Object.assign(new Error("lost contender"), { code: mode === "exhausted" ? "EEXIST" : "EIO" }); } return link(source, destination); }); syncBuiltinESMExports(); }
    assert.throws(() => prepareDestruction(f.control, "owner-race", f.paths.map(path => ({ path })))); assert.equal(injected, true); for (const path of f.paths) assert.ok(existsSync(path)); destructionBoundary.visit = () => {}; mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("dead intent-owner recovery rechecks the exact receipt, including vanished and replaced owner interleavings", () => {
  if (process.platform === "win32") return;
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { env: testEnvironment(), encoding: "utf8" }); assert.equal(exited.status, 0, exited.stderr);
  for (const mode of ["live", "dead", "vanished", "replaced"]) {
    const f = fixture(); prepareDestruction(f.control, "dead", f.paths.map(path => ({ path }))); const path = `${recordPath(f.control)}.lock`; writeFileSync(path, ""); const owner = lstatSync(path, { bigint: true }); const root = lstatSync(f.control, { bigint: true });
    writeFileSync(path, JSON.stringify({ format: "pm-vcs-destruction-lock-1", pid: mode === "live" ? process.pid : Number(exited.stdout), identity: `${owner.dev}:${owner.ino}:${owner.birthtimeNs}`, root: f.control, rootIdentity: `${root.dev}:${root.ino}:${root.birthtimeNs}`, key: path.split(/[\\/]/).at(-1)!.slice(0, 64), cleanup: "unlink-only-this-inode" }));
    let changed = false; destructionBoundary.visit = (step, target) => { if (step !== "dead-lock-checked" || changed) return; changed = true; if (mode === "vanished") rmSync(target); if (mode === "replaced") writeFileSync(target, "foreign replacement"); };
    if (mode === "live" || mode === "replaced") assert.throws(() => prepareDestruction(f.control, "dead", f.paths.map(path => ({ path }))), { code: "destructive_intent_locked" }); else assert.equal(drain(f.control, "dead", f.paths).status, "completed"); destructionBoundary.visit = () => {};
  }
});

test("namespace inference, recursive empty-directory sets and descriptor addresses retain exact receipts", () => {
  const f = fixture(); const marker = join(f.control, "format"); writeFileSync(marker, "pmvcs-1\n"); const payload = join(f.control, "payload"); writeFileSync(payload, "owned"); assert.equal(retireNamespace({ path: payload }).deleted, 1);
  const local = join(f.data, ".pmvcs"); mkdirSync(local); writeFileSync(join(local, "format"), "pmvcs-1\n"); assert.equal(retireNamespace({ path: f.paths[0] }).deleted, 1);
  const nested = join(f.data, "parent"); mkdirSync(join(nested, "child"), { recursive: true }); const plan = prepareDestruction(f.control, "dirs", [{ path: join(nested, "child"), directory: true }, { path: nested, directory: true }]); for (const path of plan.paths) plan.remove(path); assert.equal(plan.finish().deleted, 2);
  const removed = durability.remove(f.paths[1], { force: true }); assert.equal(removed.status, "completed"); assert.equal(durability.remove(f.paths[1], { force: true }).status, "completed");
  const standalone = join(f.tripwire, "temporary"); writeFileSync(standalone, "standalone"); assert.equal(durability.remove(standalone).deleted, 1);
  if (process.platform === "linux") { const directory = objectFiles.open(f.data, "r"); try { assert.equal(durability.scoped(f.control, () => durability.unlink(`/proc/self/fd/${directory.fd}/c`)).deleted, 1); } finally { directory.close(); } }
  const revision = measureDestructionRevision(f.control); mkdirSync(join(f.control, "metadata")); writeFileSync(join(f.control, "metadata", "state"), "generation"); symlinkSync(join(f.tripwire, "guard"), join(f.control, "metadata", "alias")); assert.notEqual(measureDestructionRevision(f.control), revision);
});

test("progress publication IO failures retain exact receipts and a rerun converges without expanding the set", () => {
  for (const step of ["progress-byte-written", "progress-byte-flushed", "intent-temp-opened", "intent-temp-written", "intent-temp-flushed", "intent-renamed", "intent-directory-flushed"]) {
    const f = fixture(); const plan = prepareDestruction(f.control, "io", f.paths.map(path => ({ path }))); let injected = false;
    destructionBoundary.visit = current => { if (current === step && !injected) { injected = true; throw Object.assign(new Error("injected IO crash"), { code: "EIO" }); } };
    assert.throws(() => plan.remove(f.paths[0]), error => error instanceof Error && "receipt" in error); destructionBoundary.visit = () => {};
    const receipt = drain(f.control, "io", f.paths); assert.equal(receipt.status, "completed"); assert.equal(receipt.deleted + receipt.observedAbsent, 3); assert.equal(injected, true);
  }
});

test("journal publication verifies both source and destination ownership and preserves replaced temporary leaves", () => {
  for (const mode of ["source", "destination", "source-missing", "archive-directory"]) {
    const f = fixture(); let injected = false;
    if (mode === "archive-directory") { const plan = prepareDestruction(f.control, "publication", [{ path: f.paths[0] }]); plan.remove(f.paths[0]); plan.finish(); const path = recordPath(f.control); const record = JSON.parse(readFileSync(path, "utf8")) as { id: string }; mkdirSync(join(f.control, "destruction", `${path.split(/[\\/]/).at(-1)!.slice(0, 64)}.${record.id}.receipt`)); writeFileSync(f.paths[0], "new lifetime"); }
    destructionBoundary.visit = (step, path) => { if (step !== "intent-temp-flushed" || injected || mode === "archive-directory") return; injected = true; if (mode === "source" || mode === "source-missing") { renameSync(path, `${path}.owned`); if (mode === "source") writeFileSync(path, "foreign temporary"); } else { const target = path.slice(0, path.lastIndexOf(".") - 12 - 1); writeFileSync(target, "foreign destination"); } };
    assert.throws(() => prepareDestruction(f.control, "publication", [{ path: f.paths[0] }]), error => error instanceof Error && "code" in error); destructionBoundary.visit = () => {}; assert.ok(existsSync(f.paths[0]));
    if (mode === "source") assert.ok(readdirSync(join(f.control, "destruction")).some(name => name.endsWith(".tmp") && readFileSync(join(f.control, "destruction", name), "utf8") === "foreign temporary"));
  }
});

test("native deletion and progress-storage faults preserve the durable plan and close handles before returning", () => {
  for (const mode of ["unlink", "progress-directory", "progress-replaced-before-open", "progress-replaced-after-open"]) {
    const f = fixture(); const plan = prepareDestruction(f.control, "native-error", f.paths.map(path => ({ path }))); const path = recordPath(f.control); const record = JSON.parse(readFileSync(path, "utf8")) as { id: string }; const progress = join(f.control, "destruction", `${path.split(/[\\/]/).at(-1)!.slice(0, 64)}.${record.id}.progress`);
    const unlink = fs.unlinkSync; const open = fs.openSync; let injected = false;
    if (mode === "unlink") { mock.method(fs, "unlinkSync", (target: fs.PathLike) => { if (target === f.paths[0]) { injected = true; throw Object.assign(new Error("blocked"), { code: "EACCES" }); } return unlink(target); }); syncBuiltinESMExports(); }
    else if (mode === "progress-directory") { mkdirSync(progress); injected = true; }
    else { plan.remove(f.paths[0]); if (mode === "progress-replaced-before-open") { mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { if (args[0] === progress && args[1] === (fs.constants.O_RDWR | fs.constants.O_NOFOLLOW) && !injected) { injected = true; const bytes = readFileSync(progress); renameSync(progress, `${progress}.old`); writeFileSync(progress, bytes); } return Reflect.apply(open, fs, args) as number; }); syncBuiltinESMExports(); } else destructionBoundary.visit = (step, target) => { if (step === "progress-byte-written" && target === progress && !injected) { injected = true; const bytes = readFileSync(progress); renameSync(progress, `${progress}.old`); writeFileSync(progress, bytes); } }; }
    assert.throws(() => plan.remove(f.paths[mode.startsWith("progress-replaced") ? 1 : 0]), error => error instanceof Error && "receipt" in error); mock.restoreAll(); syncBuiltinESMExports(); destructionBoundary.visit = () => {}; assert.equal(injected, true); assert.equal(objectFiles.active.size, 0);
    if (mode === "progress-directory") rmSync(progress, { recursive: true }); const receipt = drain(f.control, "native-error", f.paths); assert.equal(receipt.status, "completed"); assert.equal(receipt.deleted + receipt.observedAbsent, 3);
  }
});

test("schema validation rejects non-array requests and foreign receipt directories without granting authority", () => {
  const f = fixture(); assert.throws(() => prepareDestruction(f.control, "shape", null as never), { code: "conflicting_destructive_requests" });
  assert.throws(() => retireNamespace({ path: undefined as never }), { code: "destructive_target_unsupported" });
  const directory = join(f.control, "destruction"); rmSync(directory, { recursive: true }); writeFileSync(directory, "foreign directory replacement"); assert.throws(() => prepareDestruction(f.control, "shape", []), { code: "foreign_destructive_intent" });
  rmSync(directory); assert.throws(() => prepareDestruction(f.control, "incompatible", [{ path: f.paths[0], destination: f.paths[1] }, { path: f.paths[0] }]), { code: "conflicting_destructive_requests" });
});

test("unrecognized format bytes and unreadable markers never authorize inferred repository control writes", () => {
  for (const mode of ["foreign", "unreadable"]) {
    const f = fixture(); const marker = join(f.control, "format"); writeFileSync(marker, mode === "foreign" ? "foreign\n" : "pmvcs-1\n"); const probe = join(f.control, "probe"); writeFileSync(probe, "owned"); const read = fs.readFileSync;
    if (mode === "unreadable") { mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => { if (args[0] === marker) throw Object.assign(new Error("marker unreadable"), { code: "EACCES" }); return Reflect.apply(read, fs, args); }); syncBuiltinESMExports(); }
    assert.equal(retireNamespace({ path: probe }).deleted, 1); assert.equal(existsSync(join(f.control, "destruction")), false); mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("special files are inventoried without opening them and can never enter a destructive set", () => {
  if (process.platform !== "linux") return;
  const f = fixture(); const special = join(f.control, "special"); const create = spawnSync("mkfifo", [special], { env: testEnvironment(), encoding: "utf8" }); assert.equal(create.status, 0, create.stderr);
  assert.match(measureDestructionRevision(f.control), /^[0-9a-f]{64}$/); assert.throws(() => prepareDestruction(f.control, "special", [{ path: f.paths[0] }, { path: special }]), { code: "destructive_target_unsupported" }); assert.ok(existsSync(f.paths[0]));
});

test("parent and initial root replacement races are typed refusals before intent publication or payload deletion", () => {
  for (const mode of ["parent", "initial-root"]) {
    const f = fixture(); const stat = fs.lstatSync; let roots = 0; let injected = false;
    mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => { const options = args[1] as { bigint?: boolean } | undefined; const target = String(args[0]); if (target === f.control && options?.bigint) roots++; if (!injected && options?.bigint && (mode === "parent" ? target === f.data : target === f.control && roots === 2)) { injected = true; renameSync(target, `${target}.old`); if (mode === "parent") writeFileSync(target, "foreign parent"); else mkdirSync(target); } return Reflect.apply(stat, fs, args); }); syncBuiltinESMExports();
    assert.throws(() => prepareDestruction(f.control, "root-race", [{ path: f.paths[0] }]), { code: "destructive_target_changed" }); mock.restoreAll(); syncBuiltinESMExports(); assert.equal(injected, true);
  }
});

test("a vanished checkpoint between observe and open is refused and read-only inventory tolerates vanished or unreadable records", () => {
  const f = fixture(); prepareDestruction(f.control, "vanishing", f.paths.map(path => ({ path }))); const path = recordPath(f.control); const bytes = readFileSync(path); const open = fs.openSync; let injected = false;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { if (args[0] === path && !injected) { injected = true; rmSync(path); } return Reflect.apply(open, fs, args) as number; }); syncBuiltinESMExports(); assert.throws(() => prepareDestruction(f.control, "vanishing", []), { code: "destructive_intent_changed" }); mock.restoreAll(); syncBuiltinESMExports(); writeFileSync(path, bytes);
  const directory = join(f.control, "destruction"); const vanished = join(directory, `${"f".repeat(64)}.json`); writeFileSync(vanished, bytes); objectFiles.opened = (_file, current) => { if (current === path && existsSync(vanished)) rmSync(vanished); }; assert.equal(inspectDestructions(f.control).pending, 1); objectFiles.opened = (_file, current) => { if (current === path) throw Object.assign(new Error("unreadable"), { code: "EIO" }); }; assert.ok(inspectDestructions(f.control).skipped.some(entry => entry.reason.startsWith("unreadable"))); objectFiles.opened = () => {};
});

test("nested receipt inspection preserves an already typed partial refusal and recursive control cleanup journals outside its own set", () => {
  const f = fixture(); const plan = prepareDestruction(f.control, "nested", [{ path: f.paths[0] }]); let injected = false;
  destructionBoundary.visit = step => { if (step !== "before-delete" || injected) return; injected = true; const receipt = plan.finish(); throw new DestructionRefusal("destructive_target_changed", "nested refusal", receipt); };
  assert.throws(() => plan.remove(f.paths[0]), error => error instanceof DestructionRefusal && error.receipt?.status === "pending"); destructionBoundary.visit = () => {}; assert.equal(drain(f.control, "nested", [f.paths[0]]).status, "completed");
  const control = join(f.dir.root, "disposable-control"); mkdirSync(control); writeFileSync(join(control, "leaf"), "owned"); assert.equal(durability.scoped(control, () => durability.remove(control, { recursive: true })).status, "completed"); assert.equal(existsSync(control), false);
});

test("a progress pathname changed to a directory after observation returns its original recoverable receipt", () => {
  const f = fixture(); const plan = prepareDestruction(f.control, "late-progress", [{ path: f.paths[0] }]); const path = recordPath(f.control); const record = JSON.parse(readFileSync(path, "utf8")) as { id: string }; const progress = join(f.control, "destruction", `${path.split(/[\\/]/).at(-1)!.slice(0, 64)}.${record.id}.progress`); let injected = false;
  destructionBoundary.visit = step => { if (step === "before-delete" && !injected) { injected = true; mkdirSync(progress); } }; assert.throws(() => plan.remove(f.paths[0]), error => error instanceof DestructionRefusal && error.receipt?.planned === 1); destructionBoundary.visit = () => {}; rmSync(progress, { recursive: true }); assert.equal(drain(f.control, "late-progress", [f.paths[0]]).status, "completed");
});

test("publication refuses destination-parent recreation and malformed destination identities before retiring sources", () => {
  const f = fixture(); const directory = join(f.dir.root, "destination"); mkdirSync(directory); const destination = join(directory, "published");
  const plan = prepareDestruction(f.control, "destination-parent", [{ path: f.paths[0], destination }]); const path = recordPath(f.control); const original = readFileSync(path); const record = JSON.parse(original.toString()) as { entries: Record<string, unknown>[] };
  for (const patch of [{ target: "foreign" }, { destinationParentIdentity: "foreign" }, { destinationParentIdentity: undefined }]) { writeFileSync(path, JSON.stringify({ ...record, entries: [{ ...record.entries[0], ...patch }] })); assert.throws(() => prepareDestruction(f.control, "destination-parent", [{ path: f.paths[0], destination }]), { code: "foreign_destructive_intent" }); }
  writeFileSync(path, original); renameSync(directory, `${directory}.retired`); mkdirSync(directory); plan.remove(f.paths[0]); assert.throws(() => plan.finish(), { code: "destructive_target_changed" }); assert.ok(existsSync(f.paths[0])); assert.equal(existsSync(destination), false);
});

test("terminal skipped receipts become historical when peer leaves disappear and never make a clean store permanently fail", () => {
  for (const mode of ["replacement", "parent", "parent-file", "acknowledged"]) {
    const f = fixture(); const plan = prepareDestruction(f.control, "history", f.paths.map(path => ({ path }))); if (mode === "acknowledged") plan.remove(f.paths[0]);
    if (mode === "parent" || mode === "parent-file") { renameSync(f.data, `${f.data}.retired`); mkdirSync(f.data); } else if (mode !== "acknowledged") renameSync(f.paths[0], `${f.paths[0]}.retired`);
    writeFileSync(f.paths[0], "foreign replacement"); if (mode === "acknowledged") assert.throws(() => plan.remove(f.paths[0]), { code: "destructive_target_changed" });
    else { for (const path of plan.paths) plan.remove(path); assert.throws(() => plan.finish(), { code: "destructive_target_changed" }); }
    rmSync(f.paths[0]); if (mode === "parent-file") { rmSync(f.data, { recursive: true }); writeFileSync(f.data, "new unrelated parent leaf"); }
    const resumed = prepareDestruction(f.control, "history", mode === "parent-file" ? [] : f.paths.filter(path => existsSync(path)).map(path => ({ path })), true); for (const path of resumed.paths) resumed.remove(path); const receipt = resumed.finish(); assert.equal(receipt.status, "completed"); assert.equal(receipt.planned, 3);
    assert.equal(readFileSync(join(f.tripwire, "guard"), "utf8"), "untouched sentinel");
  }
});

test("an IO failure while checking an active skipped leaf preserves the finalized receipt for a later clean retry", () => {
  const f = fixture(); const plan = prepareDestruction(f.control, "skip-io", [{ path: f.paths[0] }]); renameSync(f.paths[0], `${f.paths[0]}.old`); writeFileSync(f.paths[0], "foreign"); plan.remove(f.paths[0]); const stat = fs.lstatSync;
  mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => { if (args[0] === f.paths[0]) throw Object.assign(new Error("leaf unreadable"), { code: "EIO" }); return Reflect.apply(stat, fs, args); }); syncBuiltinESMExports(); assert.throws(() => plan.finish(), { code: "EIO" }); mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.paths[0]); assert.equal(plan.finish().status, "completed");
});

test("a same-id foreign checkpoint cannot replace the immutable deletion set during handle refresh", () => {
  const f = fixture(); const plan = prepareDestruction(f.control, "original-authority", f.paths.map(path => ({ path }))); const originalName = join(f.control, "destruction", `${createHash("sha256").update(`${f.control}\0original-authority`).digest("hex")}.json`); const original = JSON.parse(readFileSync(originalName, "utf8")) as { entries: unknown[] };
  prepareDestruction(f.control, "other-authority", [{ path: join(f.tripwire, "guard") }]); const otherName = join(f.control, "destruction", `${createHash("sha256").update(`${f.control}\0other-authority`).digest("hex")}.json`); const other = JSON.parse(readFileSync(otherName, "utf8")) as { entries: unknown[] };
  writeFileSync(originalName, JSON.stringify({ ...original, entries: other.entries }));
  let failure: unknown; try { plan.remove(f.paths[0]); } catch (error) { failure = error; }
  assert.equal(readFileSync(join(f.tripwire, "guard"), "utf8"), "untouched sentinel"); assert.ok(failure instanceof DestructionRefusal && failure.code === "destructive_intent_changed"); for (const path of f.paths) assert.ok(existsSync(path));
});

test("descriptor aliases cannot name foreign leaves at validation or after a request object is reused", () => {
  const f = fixture(); const guard = join(f.tripwire, "guard");
  assert.throws(() => prepareDestruction(f.control, "foreign-address", [{ path: f.paths[0], address: guard }]), { code: "conflicting_destructive_requests" });
  assert.throws(() => prepareDestruction(f.control, "missing-destination", [{ path: f.paths[0], destinationAddress: guard }]), { code: "conflicting_destructive_requests" });
  assert.throws(() => prepareDestruction(f.control, "foreign-destination", [{ path: f.paths[0], destination: f.paths[1], destinationAddress: guard }]), { code: "conflicting_destructive_requests" });
  const request = { path: f.paths[0], address: f.paths[0] }; const plan = prepareDestruction(f.control, "mutated-address", [request]); request.address = guard; let failure: unknown; try { plan.remove(f.paths[0]); } catch (error) { failure = error; } assert.equal(readFileSync(guard, "utf8"), "untouched sentinel"); assert.ok(failure instanceof DestructionRefusal && failure.code === "conflicting_destructive_requests"); assert.ok(existsSync(f.paths[0]));
});


test("a publication source lost before intent validation cannot report empty success or replace an unrelated destination", () => {
 const f=fixture();const destination=join(f.tripwire,"guard");rmSync(f.paths[0]);
 assert.throws(()=>durability.scoped(f.control,()=>retireNamespace({path:f.paths[0],destination})),{code:"destructive_target_changed"});assert.equal(readFileSync(destination,"utf8"),"untouched sentinel");
});


test("verified repository aliases resolve to the owned root while descendant links never gain authority", () => {
 for(const ancestor of [false,true]){const f=fixture();const alias=join(f.dir.root,"alias");symlinkSync(ancestor?f.dir.root:f.control,alias,"dir");const control=ancestor?join(alias,"control"):alias;const leaf=join(f.control,"leaf");writeFileSync(leaf,"owned");assert.equal(durability.scoped(control,()=>durability.unlink(join(control,"leaf"))).deleted,1);assert.ok(!existsSync(leaf));}
 const f=fixture();const alias=join(f.dir.root,"file-alias");symlinkSync(join(f.tripwire,"guard"),alias);assert.throws(()=>durability.scoped(alias,()=>retireNamespace({path:join(alias,"leaf")})),{code:"destructive_target_changed"});
});

test("whole namespace plans use repository or standalone scope and never retire their own private ledger", () => {
 for(const repository of [false,true]){const f=fixture();if(repository)writeFileSync(join(f.control,"format"),"pmvcs-1\n");const leaf=join(f.control,"leaf");writeFileSync(leaf,"owned");const plan=prepareNamespaceDestruction(join(f.control,"anchor"),"scope",[{path:leaf}]);plan.remove(leaf);assert.equal(plan.finish().deleted,1);}
 const f=fixture();const untrusted=join(f.dir.root,"untrusted");symlinkSync(f.data,untrusted,"dir");assert.throws(()=>prepareNamespaceDestruction(join(untrusted,"anchor"),"untrusted",[{path:join(untrusted,"a")}]),{code:"destructive_target_changed"});
 const privateLedger=join(tmpdir(),`pm-vcs-namespace-${createHash("sha256").update(f.control).digest("hex")}`,"destruction");
 assert.throws(()=>durability.scoped(f.control,()=>retireNamespace({path:privateLedger,recursive:true})),{code:"destructive_target_unsupported"});
 assert.equal(inspectDestructions(join(f.control,"missing")).pending,0);
});

test("receipt inspection treats a recreated root as historical without modifying its retained audit bytes", () => {
 const f=fixture();const plan=prepareDestruction(f.control,"historical",f.paths.map(path=>({path})));plan.remove(f.paths[0]);renameSync(f.control,`${f.control}.old`);mkdirSync(f.control);cpSync(join(`${f.control}.old`,"destruction"),join(f.control,"destruction"),{recursive:true});
 const record=recordPath(f.control);const before=readFileSync(record);const report=inspectDestructions(f.control);assert.equal(report.pending,0);assert.equal(report.completed,1);assert.ok(report.skipped.some(entry=>entry.reason.includes("root_retired")));assert.deepEqual(readFileSync(record),before);assert.ok(existsSync(f.paths[1]));
});


test("a special publication destination refuses before retiring either namespace member", () => {
 const f=fixture();const destination=join(f.data,"destination-fifo");const created=spawnSync("mkfifo",[destination],{env:testEnvironment(),encoding:"utf8"});assert.equal(created.status,0,created.stderr);
 assert.throws(()=>prepareDestruction(f.control,"special-destination",[{path:f.paths[0],destination}]),{code:"destructive_target_unsupported"});assert.ok(lstatSync(destination).isFIFO());assert.ok(existsSync(f.paths[0]));assert.equal(readFileSync(join(f.tripwire,"guard"),"utf8"),"untouched sentinel");
});


test("an unlink crash cannot transfer a prior owner's cleanup intent to a new owner at the same pathname", () => {
 const f=fixture();const path=join(f.control,"objects.lock");writeFileSync(path,"old owner");const original=lstatSync(path,{bigint:true});
 destructionBoundary.visit=step=>{if(step==="deleted")throw new Error("crash after owner unlink");};assert.throws(()=>durability.scoped(f.control,()=>durability.unlink(path,original)));destructionBoundary.visit=()=>{};assert.ok(!existsSync(path));
 writeFileSync(path,"new owner");const replacement=lstatSync(path,{bigint:true});const historical=inspectDestructions(f.control);assert.equal(historical.pending,0);assert.ok(historical.skipped.some(entry=>entry.reason.includes("member_lifetime_ended")));assert.equal(readFileSync(path,"utf8"),"new owner");
 const receipt=durability.scoped(f.control,()=>durability.unlink(path,replacement));assert.equal(receipt.deleted,1);assert.equal(inspectDestructions(f.control).pending,0);
});

test("observational receipts distinguish current directory, retired directory and unfinished rename lifetimes", () => {
 const f=fixture();const directory=join(f.data,"directory");mkdirSync(directory);prepareDestruction(f.control,"directory-life",[{path:directory,directory:true}]);assert.equal(inspectDestructions(f.control).pending,1);renameSync(directory,`${directory}.old`);mkdirSync(directory);assert.equal(inspectDestructions(f.control).pending,0);assert.ok(lstatSync(directory).isDirectory());
 prepareDestruction(f.control,"rename-life",[{path:f.paths[0],destination:join(f.data,"renamed")}]);assert.equal(inspectDestructions(f.control).pending,1);assert.ok(existsSync(f.paths[0]));
});


test("a completed owner release truthfully succeeds when a peer acquires the pathname before receipt completion", () => {
 for(const boundary of ["deleted","progress-persisted","receipt-persisted"]){const f=fixture();const path=join(f.control,"owner.lock");const fd=openSync(path,"wx");writeFileSync(fd,"original owner");const original=fstatSync(fd,{bigint:true});let successor=false;
 destructionBoundary.visit=step=>{if(step===boundary&&!successor){successor=true;writeFileSync(path,"peer owner");}};const result=durability.scoped(f.control,()=>durability.release(path,fd,original));destructionBoundary.visit=()=>{};assert.ok(successor);assert.ok("deleted"in result&&result.deleted===1);assert.equal(readFileSync(path,"utf8"),"peer owner");assert.throws(()=>fstatSync(fd),{code:"EBADF"});}
});

test("a fresh empty request cannot replay the nonempty paths of a completed intent", () => {
 const f=fixture();const old=prepareDestruction(f.control,"fresh-empty",[{path:f.paths[0]}]);old.remove(f.paths[0]);const original=old.finish();const replay=prepareDestruction(f.control,"fresh-empty",[{path:f.paths[0]}]);assert.equal(replay.finish().id,original.id);
 const empty=prepareDestruction(f.control,"fresh-empty",[]);assert.deepEqual(empty.paths,[]);const receipt=empty.finish();assert.equal(receipt.planned,0);const repeated=prepareDestruction(f.control,"fresh-empty",[]);assert.deepEqual(repeated.paths,[]);assert.equal(repeated.finish().id,receipt.id);
});


test("owner completion cannot mistake a reattached original inode for a distinct successor lifetime", () => {
 const f=fixture();const path=join(f.control,"owner.lock");const alias=join(f.control,"retained-owner");const fd=openSync(path,"wx");writeFileSync(fd,"original owner");fs.linkSync(path,alias);const original=fstatSync(fd,{bigint:true});
 destructionBoundary.visit=step=>{if(step==="deleted")fs.linkSync(alias,path);};assert.throws(()=>durability.scoped(f.control,()=>durability.release(path,fd,original)),{code:"destructive_target_changed"});destructionBoundary.visit=()=>{};assert.equal(readFileSync(path,"utf8"),"original owner");assert.throws(()=>fstatSync(fd),{code:"EBADF"});
});
