import "./helpers/isolate-session.ts";
/** Invalid destructive requests cannot retire unrelated physical bytes. */
import { testEnvironment } from "./helpers/test-environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { destructionBoundary, inspectDestructions } from "../engine/destruction.ts";
import { collectGarbage } from "../engine/gc.ts";
import { erasurePurge, planErasureStorage } from "../engine/erasure-accountability.ts";
import { erasureScanBoundary } from "../engine/erasure-scan.ts";
import { packBoundary, PackStorage } from "../engine/packs.ts";
import { objectFiles } from "../engine/object-files.ts";
import { ObjectStore } from "../engine/objects.ts";
import { Repository } from "../engine/repo.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const owned: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { objectFiles.opened = () => {}; mock.restoreAll(); syncBuiltinESMExports(); destructionBoundary.visit = () => {}; packBoundary.visit = () => {}; for (const dir of owned.splice(0)) dir.cleanup(); });
/** Hash the complete ordinary namespace and file bytes without following leaf links. */
function treeHash(root: string): string {
  const hash = createHash("sha256");
  const walk = (path: string): void => { for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { hash.update(entry.name); if (entry.isDirectory()) walk(join(path, entry.name)); else hash.update(readFileSync(join(path, entry.name))); } };
  walk(root); return hash.digest("hex");
}
/** Initialize a real SDK tracker outside Git, with an unrelated unaccounted storage leaf and a tripwire. */
async function fixture() {
  const dir = makeTempDir(); owned.push(dir); const root = join(dir.root, "hub"); mkdirSync(root);
  await new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true }).init("destructive", { defaults: true, author: "fixture" });
  const repo = Repository.init(root); repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  writeFileSync(join(root, "asset"), "selected payload for validated destructive planning 298173"); repo.stage(["asset"]);
  const packs = join(repo.objects.storageRoot(), "packs"); mkdirSync(packs); writeFileSync(join(packs, "backup.pack"), "unrelated bytes must survive refusals");
  const tripwire = join(dir.root, "tripwire"); mkdirSync(tripwire); writeFileSync(join(tripwire, "protected"), "never delete this directory");
  return { dir, root, repo, tripwire, foreign: join(packs, "backup.pack") };
}

test("review: an absent well-formed FileId cannot purge unrelated storage before unknown_file", async () => {
  const f = await fixture(); const before = treeHash(f.repo.objects.storageRoot()); const tripwire = treeHash(f.tripwire);
  assert.throws(() => f.repo.obliterate("a".repeat(32), "erase-fixture", "incident", new Date(1), { purgeUnaccounted: true }), { code: "unknown_file" });
  assert.equal(treeHash(f.repo.objects.storageRoot()), before); assert.equal(treeHash(f.tripwire), tripwire); assert.ok(existsSync(f.foreign)); assert.deepEqual(f.repo.objects.denials(), []);
});

test("property: all invalid selector credential reason and option combinations preserve storage and tripwire", async t => {
  const base = await fixture(); const guard = treeHash(base.tripwire); let seed = 62391; let cases = 0;
  const next = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let corpus = 0; corpus < 16; corpus++) {
    const root = join(base.dir.root, `invalid-${corpus}`); cpSync(base.root, root, { recursive: true }); const repo = Repository.open(root);
    for (let object = 0; object < 1 + corpus % 5; object++) repo.objects.write("blob", Buffer.from(`random-${next()}-${next()}`));
    if ((corpus & 1) !== 0) repo.objects.compact();
    writeFileSync(join(repo.objects.storageRoot(), "packs", `unaccounted-${corpus}`), Buffer.from(`foreign ${next()}`));
    const initial = treeHash(repo.objects.storageRoot());
    for (let i = 0; i < 32; i++) {
      const mode = i % 4; const selector = mode === 0 ? next().toString(16).padStart(32, "0") : mode === 1 ? `invalid/${next()}` : "asset";
      const credential = mode === 2 ? "foreign-owner" : "erase-fixture"; const reason = mode === 3 ? "invalid reason" : "incident";
      const options = { purgeUnaccounted: (i & 4) !== 0, recoverLock: (i & 8) !== 0 };
      assert.throws(() => repo.obliterate(selector, credential, reason, new Date(1), options), error => error instanceof Error && "code" in error);
      assert.equal(treeHash(repo.objects.storageRoot()), initial, `seed ${seed}`); assert.equal(treeHash(base.tripwire), guard); cases++;
    }
  }
  const initial = treeHash(base.repo.objects.storageRoot());
  for (const options of [{ purgeUnaccounted: "yes" }, { purgeUnaccounted: true, apply: true }, null]) {
    assert.throws(() => base.repo.obliterate("asset", "erase-fixture", "incident", new Date(1), options as never), { code: "invalid_erasure_options" });
    assert.equal(treeHash(base.repo.objects.storageRoot()), initial); assert.equal(treeHash(base.tripwire), guard); cases++;
  }
  t.diagnostic(`${cases} MUST-REFUSE requests across 16 seeded packed/loose corpora and all four purge/recovery flag combinations; every storage and tripwire tree hash is unchanged`);
});


test("recover-lock plus purge validates unknown, foreign-owned, malformed and conflicting requests before retiring the dead writer", async () => {
  const f = await fixture(); const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { env: testEnvironment(), encoding: "utf8" }); assert.equal(dead.status, 0, dead.stderr);
  const lock = join(f.repo.controlDirectory, "objects.lock"); writeFileSync(lock, dead.stdout); const initial = treeHash(f.repo.objects.storageRoot());
  for (const purgeUnaccounted of [false, true]) for (const request of [
    { selector: "b".repeat(32), credential: "erase-fixture", reason: "incident" },
    { selector: "../tripwire", credential: "erase-fixture", reason: "incident" },
    { selector: "asset", credential: "foreign-owner", reason: "incident" },
    { selector: "asset", credential: "erase-fixture", reason: "invalid reason" },
  ]) {
    assert.throws(() => f.repo.obliterate(request.selector, request.credential, request.reason, new Date(1), { purgeUnaccounted, recoverLock: true }), error => error instanceof Error && "code" in error);
    assert.equal(treeHash(f.repo.objects.storageRoot()), initial); assert.equal(readFileSync(lock, "utf8"), dead.stdout); assert.ok(existsSync(f.foreign));
  }
  assert.throws(() => f.repo.obliterate("asset", "erase-fixture", "incident", new Date(1), { recoverLock: true }), { code: "unverifiable" }); assert.equal(readFileSync(lock, "utf8"), dead.stdout);
  const receipt = f.repo.obliterate("asset", "erase-fixture", "incident", new Date(1), { purgeUnaccounted: true, recoverLock: true }); assert.equal(receipt.storage.accountable, true); assert.equal(receipt.purge.deleted, 1); assert.equal(existsSync(lock), false); assert.equal(existsSync(join(f.root, "asset")), false);
});

test("property: valid identities across every purge/recovery flag combination delete the planned bytes and return recoverable receipts", async t => {
  const base = await fixture(); rmSync(base.foreign); const tripwire = treeHash(base.tripwire); let cases = 0;
  for (let seed = 0; seed < 32; seed++) {
    const root = join(base.dir.root, `valid-${seed}`); cpSync(base.root, root, { recursive: true }); const repo = Repository.open(root);
    const purgeUnaccounted = (seed & 1) !== 0; const recoverLock = (seed & 2) !== 0;
    const unknown = join(repo.objects.storageRoot(), "packs", `foreign-${seed}`);
    if (purgeUnaccounted) writeFileSync(unknown, `unrelated foreign ${seed}`);
    if ((seed & 4) !== 0) repo.objects.compact();
    let injected = false;
    const boundary = ["pending", "object-deleted", "storage-verified", "receipt"][seed >>> 3];
    // Crash only after the request's complete immutable audit metadata exists.
    erasureScanBoundary.visit = step => { if (step === boundary && !injected) { injected = true; throw new Error("injected operation crash"); } };
    try { assert.throws(() => repo.obliterate("asset", "erase-fixture", "incident", new Date(1), { purgeUnaccounted, recoverLock })); }
    finally { erasureScanBoundary.visit = () => {}; }
    const id = repo.objects.denials()[0]?.tombstone.fileId ?? repo.readIndex().find(entry => entry.path === "asset")!.fileId;
    const receipt = repo.obliterate(id, "erase-fixture", "incident", new Date(1), { purgeUnaccounted, recoverLock });
    assert.equal(receipt.storage.accountable, true); assert.equal(receipt.destruction.objects.status, "completed"); assert.equal(existsSync(join(root, "asset")), false); assert.equal(existsSync(unknown), false); assert.equal(treeHash(base.tripwire), tripwire); cases++;
  }
  t.diagnostic(`${cases} valid stores: 4 purge/recovery flag combinations x packed/loose x 4 parent-operation crash boundaries`);
});

test("late logical and working-tree preconditions refuse before purging or retiring a packed source", async () => {
  for (const mode of ["deduplicated", "untracked-copy"]) {
    const f = await fixture();
    if (mode === "deduplicated") { writeFileSync(join(f.root, "other"), readFileSync(join(f.root, "asset"))); f.repo.stage(["other"]); }
    else writeFileSync(join(f.root, "untracked"), readFileSync(join(f.root, "asset")));
    f.repo.objects.compact(); const original = treeHash(f.repo.objects.storageRoot());
    assert.throws(() => f.repo.obliterate("asset", "erase-fixture", "incident", new Date(1), { purgeUnaccounted: true }), { code: mode === "deduplicated" ? "erasure_dedup_conflict" : "erasure_worktree_conflict" });
    assert.equal(treeHash(f.repo.objects.storageRoot()), original); assert.ok(existsSync(f.foreign));
  }
});

test("compaction validates a corrupt later loose source before deleting an earlier packed duplicate or staging job", () => {
  const dir = makeTempDir(); owned.push(dir); const store = new ObjectStore(join(dir.root, ".pmvcs/objects"));
  const live = store.write("blob", Buffer.from("duplicate original")); const loose = readFileSync(join(store.storageRoot(), live.slice(0, 2), live.slice(2))); store.compact(); mkdirSync(join(store.storageRoot(), live.slice(0, 2)), { recursive: true }); writeFileSync(join(store.storageRoot(), live.slice(0, 2), live.slice(2)), loose);
  const broken = store.write("blob", Buffer.from("invalid late source")); writeFileSync(join(store.storageRoot(), broken.slice(0, 2), broken.slice(2)), "truncated");
  const before = treeHash(store.storageRoot()); assert.throws(() => store.compact(), { code: "corrupt_object" }); assert.equal(treeHash(store.storageRoot()), before); assert.deepEqual(store.read(live).payload, Buffer.from("duplicate original"));
});

test("unpack validates every published pack before recovering owned staging jobs", () => {
  const dir = makeTempDir(); owned.push(dir); const store = new ObjectStore(join(dir.root, ".pmvcs/objects")); store.write("blob", Buffer.from("retained")); store.compact();
  const packs = join(store.storageRoot(), "packs"); const job = join(packs, `job-${"a".repeat(24)}`); mkdirSync(job); writeFileSync(join(job, "owner"), `pm-vcs-pack-1 job-${"a".repeat(24)}\n`); writeFileSync(join(job, "payload"), "interrupted");
  const pack = new PackStorage(store.storageRoot()).files()[0]; writeFileSync(pack, "corrupt"); const before = treeHash(store.storageRoot()); assert.throws(() => store.unpack(), { code: "corrupt_pack" }); assert.equal(treeHash(store.storageRoot()), before);
});

test("SDK and agent CLI expose bounded read-only destructive receipts and typed invalid limits", async () => {
  const f = await fixture(); const before = treeHash(f.repo.controlDirectory); const inventory = inspectDestructions(f.repo.controlDirectory, 1); assert.ok(inventory.receipts.length <= 1); assert.equal(treeHash(f.repo.controlDirectory), before);
  assert.throws(() => inspectDestructions(f.repo.controlDirectory, 0), { code: "invalid_receipt_limit" });
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const result = await harness.runCommand({ command: "vcs destructive-receipts", pmRoot: f.root, options: {} }); assert.equal(result.errorMessage, undefined); assert.ok(result.result); assert.equal(treeHash(f.repo.controlDirectory), before);
  f.repo.commit({ message: "receipt setup", author: { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 } }, new Date(1));
  const linked = join(f.dir.root, "linked-receipts"); f.repo.linkInstance("receipts", linked);
  const sharedBefore = treeHash(f.repo.controlDirectory); const linkedResult = await harness.runCommand({ command: "vcs destructive-receipts", pmRoot: linked, options: {} }); assert.equal(linkedResult.errorMessage, undefined); assert.ok(linkedResult.result); assert.equal(treeHash(f.repo.controlDirectory), sharedBefore);
});

test("native recovery preflight crashes at every boundary before and after retiring a stale writer converge on the same FileId", async t => {
  if (process.platform === "win32") return;
  const base = await fixture(); const id = base.repo.readIndex().find(entry => entry.path === "asset")!.fileId!; const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { env: testEnvironment(), encoding: "utf8" }); assert.equal(dead.status, 0, dead.stderr); writeFileSync(join(base.repo.controlDirectory, "objects.lock"), dead.stdout);
  /** Each child receives only allowlisted runner inputs and fixture-owned arguments. */
  const run = (root: string, cut: number) => spawnSync(process.execPath, [join(packageRoot, "test/helpers/destruction-recovery-worker.ts"), root, id, String(cut)], { env: testEnvironment(), encoding: "utf8", timeout: 60_000 });
  const traceRoot = join(base.dir.root, "trace"); cpSync(base.root, traceRoot, { recursive: true }); const traceResult = run(traceRoot, 0); assert.equal(traceResult.status, 0, traceResult.stderr); const trace = (JSON.parse(traceResult.stdout) as { trace: string[] }).trace; assert.equal(trace.length, 9);
  for (let cut = 1; cut <= trace.length; cut++) { const root = join(base.dir.root, `recovery-cut-${cut}`); cpSync(base.root, root, { recursive: true }); const crash = run(root, cut); assert.equal(crash.signal, "SIGKILL", `${cut}: ${crash.stderr}`); const recovery = run(root, 0); assert.equal(recovery.status, 0, `${trace[cut - 1]}: ${recovery.stderr}`); const receipt = JSON.parse(recovery.stdout) as { accountable: boolean; destruction: { objects: { status: string } } }; assert.equal(receipt.accountable, true); assert.equal(receipt.destruction.objects.status, "completed"); assert.equal(existsSync(join(root, "asset")), false); }
  t.diagnostic(`${trace.length} actual SIGKILL cuts across read-only preflight, recovery ownership, stale-owner retirement and completed action`);
});

test("recovery validation CAS refuses mutation, unstable generations and unreadable revisions before deleting a lease", async () => {
  const f = await fixture(); const old = treeHash(f.repo.objects.storageRoot()); let runs = 0;
  assert.throws(() => f.repo.objects.withRecoveryValidation(() => { throw Object.assign(new Error("invalid input"), { code: "fixture_invalid" }); }, () => { runs++; }), { code: "fixture_invalid" }); assert.equal(runs, 0);
  assert.throws(() => f.repo.objects.withRecoveryValidation(() => f.repo.objects.write("blob", Buffer.from("forbidden preflight write")), () => {}), { code: "destructive_preflight_write" }); assert.equal(treeHash(f.repo.objects.storageRoot()), old);
  const generation = join(f.repo.controlDirectory, "cas-generation"); let attempts = 0;
  assert.throws(() => f.repo.objects.withRecoveryValidation(() => writeFileSync(generation, String(++attempts)), () => {}), { code: "object_store_changing" }); assert.equal(attempts, 8);
  attempts = 0; const payloadGeneration = join(f.repo.objects.storageRoot(), "foreign-generation"); f.repo.objects.withRecoveryValidation(() => { attempts++; if (attempts === 1) writeFileSync(payloadGeneration, "external generation"); }, () => { runs++; }); assert.equal(attempts, 2); assert.equal(runs, 1); rmSync(payloadGeneration);
  const list = fs.readdirSync; for (const code of ["ENOENT", "ESTALE", "EIO"]) { mock.method(fs, "readdirSync", (...args: unknown[]) => { if (String(args[0]) === f.repo.controlDirectory) throw Object.assign(new Error("catalogue error"), { code }); return Reflect.apply(list, fs, args); }); syncBuiltinESMExports(); assert.throws(() => f.repo.objects.withRecoveryValidation(() => {}, () => {}), { code: code === "EIO" ? "EIO" : "object_store_changing" }); mock.restoreAll(); syncBuiltinESMExports(); }
});

test("recovery owners are identity-bound: foreign/live guards, publication competitors and lost cleanup ownership are preserved", async () => {
  const f = await fixture(); const guard = join(f.repo.controlDirectory, "objects.recovery.lock"); const old = treeHash(f.repo.objects.storageRoot());
  for (const owner of ["foreign", "0", "2147483648", String(process.pid)]) { writeFileSync(guard, owner); assert.throws(() => f.repo.objects.withRecoveryValidation(() => {}, () => {}), { code: "store_locked" }); assert.equal(readFileSync(guard, "utf8"), owner); assert.throws(() => f.repo.objects.withWriteLock(() => {}), { code: "store_locked" }); rmSync(guard); }
  mkdirSync(guard); assert.throws(() => f.repo.objects.withRecoveryValidation(() => {}, () => {}), { code: "store_locked" }); rmSync(guard, { recursive: true });
  for (const mode of ["peer", "revision", "cleanup", "replacement"]) {
    let injected = false; let completed = false;
    destructionBoundary.visit = (step, path) => {
      if (mode === "cleanup" && step === "recovery-action-completed") completed = true;
      if (injected) return;
      if (mode === "peer" && step === "recovery-owner-flushed") { injected = true; writeFileSync(guard, String(process.pid)); }
      if (mode === "revision" && step === "recovery-owner-published") { injected = true; writeFileSync(join(f.repo.controlDirectory, "new-revision"), "changed"); }
      if (mode === "cleanup" && completed && step === "before-delete" && path.endsWith("objects.recovery.lock")) { injected = true; throw new Error("cleanup crash"); }
      if (mode === "replacement" && step === "recovery-action-completed") { injected = true; fs.renameSync(guard, `${guard}.retired`); writeFileSync(guard, "foreign replacement"); }
    };
    if (mode === "replacement") f.repo.objects.withRecoveryValidation(() => {}, () => {}); else assert.throws(() => f.repo.objects.withRecoveryValidation(() => {}, () => {})); destructionBoundary.visit = () => {}; assert.equal(injected, true);
    if (mode === "cleanup") { f.repo.objects.withRecoveryValidation(() => {}, () => {}); assert.equal(existsSync(guard), false); }
    else if (existsSync(guard)) { assert.equal(readFileSync(guard, "utf8"), mode === "replacement" ? "foreign replacement" : String(process.pid)); rmSync(guard); }
  }
  assert.equal(treeHash(f.repo.objects.storageRoot()), old);
});

test("every recovery boundary also releases descriptors after synchronous errors and a retry preserves the same store", async () => {
  const f = await fixture(); const before = treeHash(f.repo.objects.storageRoot());
  for (const boundary of ["recovery-view-start", "recovery-view-validated", "recovery-owner-opened", "recovery-owner-written", "recovery-owner-flushed", "recovery-owner-published", "recovery-old-lock-retired", "recovery-action-completed", "recovery-owner-retired"]) {
    let injected = false; destructionBoundary.visit = step => { if (step === boundary && !injected) { injected = true; throw new Error("synchronous recovery interruption"); } };
    assert.throws(() => f.repo.objects.withRecoveryValidation(() => {}, () => {})); destructionBoundary.visit = () => {}; assert.equal(injected, true); assert.equal(objectFiles.active.size, 0); f.repo.objects.withRecoveryValidation(() => {}, () => {}); assert.equal(treeHash(f.repo.objects.storageRoot()), before);
  }
});

test("purge drafts freeze one complete scoped set, refuse vanished roots and never extend authority on recovery", async () => {
  const f = await fixture(); const storage = f.repo.objects.storageRoot(); const id = "c".repeat(32); const files = planErasureStorage([storage]); assert.equal(files.length, 1); const file = files[0];
  const journal = erasurePurge(f.repo.controlDirectory, id, [storage], true); journal.plan(files); journal.plan(files); assert.equal(journal.purge(file, () => rmSync(file.path)), true); assert.equal(journal.receipt().deleted, 1);
  const fresh = join(storage, "packs", "fresh-foreign"); writeFileSync(fresh, "new authority is required"); const arrived = planErasureStorage([storage]); const resumed = erasurePurge(f.repo.controlDirectory, id, [storage], true); resumed.plan(arrived, true); assert.equal(resumed.purge(arrived[0], () => { throw new Error("new file must not be deleted"); }), false); assert.ok(existsSync(fresh));
  assert.throws(() => erasurePurge(f.repo.controlDirectory, "d".repeat(32), [storage], true).plan([{ ...file, path: join(f.tripwire, "protected") }]), { code: "unverifiable" });
  fs.renameSync(storage, `${storage}.retired`); try { assert.throws(() => erasurePurge(f.repo.controlDirectory, "e".repeat(32), [storage], true).plan(files)); } finally { fs.renameSync(`${storage}.retired`, storage); }
  const unauthorized = erasurePurge(f.repo.controlDirectory, "f".repeat(32), [storage], false); unauthorized.plan(arrived); assert.equal(unauthorized.purge(arrived[0], () => { throw new Error("unauthorized purge"); }), false);
});

test("GC invalid apply flags and pending erasure refuse before any candidate retirement", async () => {
  const f = await fixture(); const initial = treeHash(f.repo.objects.storageRoot()); assert.throws(() => collectGarbage(f.repo, "yes" as never), { code: "invalid_gc_options" }); assert.equal(treeHash(f.repo.objects.storageRoot()), initial);
  erasureScanBoundary.visit = step => { if (step === "pending") throw new Error("authorized cleanup interrupted"); }; try { assert.throws(() => f.repo.obliterate("asset", "erase-fixture", "incident", new Date(1), { purgeUnaccounted: true })); } finally { erasureScanBoundary.visit = () => {}; }
  const pending = treeHash(f.repo.objects.storageRoot()); assert.throws(() => collectGarbage(f.repo, true), { code: "pack_erasure_pending" }); assert.equal(treeHash(f.repo.objects.storageRoot()), pending);
});

test("ordinary store lease cleanup preserves owners replaced or rewritten at publication and release boundaries", async () => {
  for (const mode of ["in-place", "replacement", "vanished", "publication", "temporary-retirement"]) {
    const f = await fixture(); const lock = join(f.repo.controlDirectory, "objects.lock"); let injected = false;
    objectFiles.opened = (_file, path) => { if (mode === "publication" && !injected && path === f.repo.controlDirectory && existsSync(lock)) { injected = true; writeFileSync(lock, "foreign publication owner"); } };
    destructionBoundary.visit = (step, path) => { if (injected || !path.startsWith("objects.lock.") || !path.endsWith(".tmp")) return; if (mode === "temporary-retirement" && step === "progress-persisted") { injected = true; writeFileSync(lock, "foreign retirement owner"); } };
    assert.throws(() => f.repo.objects.withWriteLock(() => { if (mode === "publication" || mode === "temporary-retirement") return; injected = true; if (mode === "replacement") fs.renameSync(lock, `${lock}.retired`); if (mode === "vanished") rmSync(lock); else writeFileSync(lock, "foreign release owner"); })); destructionBoundary.visit = () => {}; objectFiles.opened = () => {}; assert.equal(injected, true); if (mode !== "vanished") assert.match(readFileSync(lock, "utf8"), /^foreign /); assert.equal(objectFiles.active.size, 0);
  }
});

test("pending erasure resumes after a skipped replacement disappears instead of remaining permanently unverifiable", async () => {
  const f = await fixture(); const asset = join(f.root, "asset"); const id = f.repo.readIndex().find(entry => entry.path === "asset")!.fileId!; let injected = false;
  destructionBoundary.visit = (step, path) => { if (step === "before-delete" && path.replaceAll("\\", "/") === "../asset" && !injected) { injected = true; rmSync(asset); writeFileSync(asset, "foreign replacement with no selected bytes"); } };
  assert.throws(() => f.repo.obliterate(id, "erase-fixture", "incident", new Date(1), { purgeUnaccounted: true })); destructionBoundary.visit = () => {}; assert.equal(injected, true); assert.ok(f.repo.objects.denials().some(entry => entry.pending)); rmSync(asset);
  const receipt = f.repo.obliterate(id, "erase-fixture", "incident", new Date(1), { purgeUnaccounted: true }); assert.equal(receipt.storage.accountable, true); assert.ok(f.repo.objects.denials().every(entry => !entry.pending)); assert.ok(receipt.destruction.worktrees.some(entry => entry.skipped > 0));
});


test("malformed timestamps and conflicting proposed recovery metadata refuse before any purge or owner retirement", async () => {
 const f=await fixture();const before=treeHash(f.repo.objects.storageRoot());
 for(const now of [null,{},"invalid",new Date(NaN)]){assert.throws(()=>f.repo.obliterate("asset","erase-fixture","incident",now as never,{purgeUnaccounted:true}),{code:"bad_tombstone"});assert.equal(treeHash(f.repo.objects.storageRoot()),before);}
 const fakePid=1357913579;writeFileSync(join(f.root,"asset"),String(fakePid));f.repo.stage(["asset"]);const selected=treeHash(f.repo.objects.storageRoot());const descriptor=Object.getOwnPropertyDescriptor(process,"pid")!;Object.defineProperty(process,"pid",{configurable:true,value:fakePid});
 try{assert.throws(()=>f.repo.obliterate("asset","erase-fixture","incident",new Date(1),{purgeUnaccounted:true,recoverLock:true}),{code:"erasure_audit_conflict"});}finally{Object.defineProperty(process,"pid",descriptor);}
 assert.equal(treeHash(f.repo.objects.storageRoot()),selected);assert.equal(readFileSync(join(f.root,"asset"),"utf8"),String(fakePid));assert.ok(existsSync(f.foreign));assert.equal(existsSync(join(f.repo.controlDirectory,"objects.lock")),false);
});


test("revoking a pending purge between preflight and authorization reread preserves all storage bytes", async () => {
 const f=await fixture();const root=f.repo.objects.storageRoot();const id=f.repo.readIndex()[0].fileId!;f.repo.objects.withWriteLock(()=>erasurePurge(f.repo.controlDirectory,id,[root],true).begin(planErasureStorage([root])));const before=treeHash(root);const path=join(f.repo.controlDirectory,"erasure-purge.json");const read=fs.readFileSync;let reads=0;
 mock.method(fs,"readFileSync",(...args:Parameters<typeof fs.readFileSync>)=>{if(args[0]===path&&(args[1] as unknown)==="utf8"&&++reads===2)writeFileSync(path,JSON.stringify({format:"pm-vcs-erasure-purge-2",operations:{},plans:{}}));return Reflect.apply(read,fs,args);});syncBuiltinESMExports();
 assert.throws(()=>f.repo.obliterate("asset","erase-fixture","incident",new Date(1)),{code:"unverifiable"});mock.restoreAll();syncBuiltinESMExports();assert.equal(reads,2);assert.equal(treeHash(root),before);assert.ok(existsSync(f.foreign));assert.deepEqual(f.repo.objects.denials(),[]);
});
