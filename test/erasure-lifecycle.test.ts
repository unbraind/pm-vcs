import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Durable purge authority follows owned file/root lifetimes on real non-git repositories. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import fs, { cpSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, mock, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { accountabilityBoundary, accountErasureStorage, erasurePurge, type ErasurePurgeEntry } from "../engine/erasure-accountability.ts";
import { erasureScanBoundary, ErasureStorageRefusal } from "../engine/erasure-scan.ts";
import { objectFiles } from "../engine/object-files.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";

const dirs: ReturnType<typeof makeTempDir>[] = [];
const empty = { forbiddenIds: new Set<string>(), forbiddenPayloads: new Set<string>() };
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); accountabilityBoundary.visit = () => {}; erasureScanBoundary.visit = () => {}; for (const dir of dirs.splice(0)) dir.cleanup(); assert.equal(objectFiles.active.size, 0); });
/** One SDK tracker and native hub outside Git, shared by an entire model run. */
async function fixture() {
  const dir = makeTempDir(); dirs.push(dir); const root = join(dir.root, "hub"); mkdirSync(root);
  await new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true }).init("lifecycle", { defaults: true, author: "fixture" });
  const repo = Repository.init(root); repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  for (const name of ["first", "second"]) writeFileSync(join(root, name), `selected ${name} lifecycle payload 783629`);
  repo.stage(["first", "second"]); repo.commit({ message: "fixture", author: { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 } }, new Date(1));
  return { dir, repo, id: repo.readIndex().find(entry => entry.path === "first")!.fileId! };
}
/** Foreign files always remain explicit reference-model state, independently of production classification. */
function foreign(root: string, name = "foreign"): string { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "foreign lifecycle bytes"); return path; }
/** Persist actual pending authority, then retire its root using the public lifecycle operations. */
async function retiredPending() {
  const f = await fixture(); const path = join(f.dir.root, "secondary"); f.repo.linkInstance("secondary", path); foreign(join(path, ".pmvcs/objects"));
  const cut = new ErasureStorageRefusal("unverifiable", "temporary-storage"); accountabilityBoundary.visit = step => { if (step === "purge-set-persisted") throw cut; };
  assert.throws(() => f.repo.obliterate(f.id, "erase-fixture", "incident", new Date(1), { purgeUnaccounted: true }), failure => failure === cut); accountabilityBoundary.visit = () => {};
  f.repo.unlinkInstance("secondary"); rmSync(path, { recursive: true, force: true }); f.repo.pruneRetiredInstance(relative(f.repo.root, path), "erase-fixture", "removed", new Date(1));
  return { ...f, second: f.repo.readIndex().find(entry => entry.path === "second")!.fileId! };
}

test("review: a purged dormant instance can be unlinked, removed and pruned before another obliteration", async () => {
  const f = await fixture(); const path = join(f.dir.root, "secondary"); f.repo.linkInstance("secondary", path);
  foreign(join(path, ".pmvcs/objects")); const first = f.repo.obliterate(f.id, "erase-fixture", "incident", new Date(1), { purgeUnaccounted: true }); assert.equal(first.purge.deleted, 1);
  const journal = join(f.repo.controlDirectory, "erasure-purge.json"); const before = JSON.parse(readFileSync(journal, "utf8")) as { operations: Record<string, ErasurePurgeEntry[]> };
  f.repo.unlinkInstance("secondary"); rmSync(path, { recursive: true, force: true }); f.repo.pruneRetiredInstance(relative(f.repo.root, path), "erase-fixture", "removed", new Date(1));
  const result = f.repo.obliterate("second", "erase-fixture", "incident", new Date(1)); assert.equal(result.storage.accountable, true);
  assert.deepEqual((JSON.parse(readFileSync(journal, "utf8")) as typeof before).operations[f.id], before.operations[f.id], "completed receipts remain unchanged historical audit facts");
  assert.equal(f.repo.obliterate(f.id, "erase-fixture", "incident", new Date(1)).purge.deleted, 1);
});

test("pending authority is cancelled for retired, missing or replaced roots without following their pathnames", async () => {
  const f = await fixture(); const control = f.repo.controlDirectory; const roots = [join(f.dir.root, "dormant/objects")]; const cut = new ErasureStorageRefusal("unverifiable", "temporary-storage");
  for (const mode of ["root_retired", "root_missing", "root_replaced", "legacy_authorization"] as const) {
    mkdirSync(roots[0], { recursive: true }); const file = foreign(roots[0]); const id = createHash("sha256").update(mode).digest("hex").slice(0, 32);
    accountabilityBoundary.visit = step => { if (step === "purge-planned") throw cut; };
    assert.throws(() => f.repo.objects.withWriteLock(() => { const purge = erasurePurge(control, id, roots, true); accountErasureStorage(roots, { ...empty, purge: purge.purge }); }), error => error === cut); accountabilityBoundary.visit = () => {};
    const journal = join(control, "erasure-purge.json");
    if (mode === "legacy_authorization") { const data = JSON.parse(readFileSync(journal, "utf8")) as { operations: Record<string, ErasurePurgeEntry[]> }; delete (data.operations[id][0] as { root?: string }).root; delete (data.operations[id][0] as { rootIdentity?: string }).rootIdentity; writeFileSync(journal, JSON.stringify(data)); }
    if (mode === "root_missing") rmSync(roots[0], { recursive: true, force: true });
    if (mode === "root_replaced") { renameSync(roots[0], `${roots[0]}-old`); mkdirSync(roots[0]); foreign(roots[0]); }
    const scope = mode === "root_retired" ? [] : roots;
    const receipt = f.repo.objects.withWriteLock(() => erasurePurge(control, id, scope, false).receipt());
    assert.equal(receipt.cancelled, 1); assert.equal(receipt.files[0].reason, mode); assert.equal(receipt.deleted, 0);
    if (mode !== "root_missing") assert.ok(existsSync(file));
    rmSync(roots[0], { recursive: true, force: true });
  }
});

test("a pending file cannot transfer deletion authority to a replacement root even when its inode is retained", async () => {
  const f = await fixture(); const root = join(f.dir.root, "replace-root/objects"); const file = foreign(root); const cut = new ErasureStorageRefusal("unverifiable", "temporary-storage");
  accountabilityBoundary.visit = step => { if (step === "purge-planned") throw cut; };
  assert.throws(() => f.repo.objects.withWriteLock(() => { const purge = erasurePurge(f.repo.controlDirectory, f.id, [root], true); accountErasureStorage(root, { ...empty, purge: purge.purge }); }), failure => failure === cut);
  let moved = false;
  accountabilityBoundary.visit = step => { if (step === "purge-planned" && !moved) { moved = true; renameSync(root, `${root}-retired`); mkdirSync(root); linkSync(join(`${root}-retired`, "foreign"), file); } };
  assert.throws(() => f.repo.objects.withWriteLock(() => { const purge = erasurePurge(f.repo.controlDirectory, f.id, [root], false); accountErasureStorage(root, { ...empty, purge: purge.purge }); }), { code: "unverifiable" });
  accountabilityBoundary.visit = () => {}; assert.ok(moved); assert.ok(existsSync(file));
  const receipt = f.repo.objects.withWriteLock(() => erasurePurge(f.repo.controlDirectory, f.id, [root], false).receipt()); assert.equal(receipt.cancelled, 1); assert.equal(receipt.files[0].reason, "root_replaced");
  rmSync(file); assert.equal(accountErasureStorage(root, empty).accountable, true);
});

test("root-bound journals retain strict validation and do not read historical paths or authorize outside roots", async () => {
  const f = await fixture(); const root = join(f.dir.root, "scope/objects"); foreign(root);
  const original = f.repo.objects.withWriteLock(() => { const purge = erasurePurge(f.repo.controlDirectory, f.id, [root], true); accountErasureStorage(root, { ...empty, purge: purge.purge }); return purge.receipt(); }); assert.equal(original.deleted, 1);
  const path = join(f.repo.controlDirectory, "erasure-purge.json"); const journal = JSON.parse(readFileSync(path, "utf8")) as { operations: Record<string, Record<string, unknown>[]> }; const base = journal.operations[f.id][0];
  for (const patch of [{ file: "" }, { file: "a/../b" }, { file: "bad\0name" }, { root: "" }, { root: null }, { rootIdentity: null }, { rootIdentity: "invalid" }, { root: "other-root" }, { status: "cancelled" }, { reason: "root_missing" }, { status: "cancelled", reason: "foreign" }]) {
    journal.operations[f.id] = [{ ...base, ...patch }]; writeFileSync(path, JSON.stringify(journal)); assert.throws(() => erasurePurge(f.repo.controlDirectory, f.id, [root], true), { code: "unverifiable" });
  }
  journal.operations[f.id] = [base]; writeFileSync(path, JSON.stringify(journal));
  const stat = fs.lstatSync; mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => { if (String(args[0]).startsWith(root)) throw new Error("a historical path was inspected"); return stat(...args); }); syncBuiltinESMExports();
  const audit = erasurePurge(f.repo.controlDirectory, f.id, [], false); assert.equal(audit.receipt().deleted, 1); mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(audit.purge({ path: join(f.dir.root, "outside"), fileClass: "foreign-directory", identity: "1:2:3:4", sha256: "a".repeat(64), bytes: 3 }, () => assert.fail("outside removal")), false);
  const missing = erasurePurge(f.repo.controlDirectory, f.id, [root], true); let once = false; let checks = 0;
  mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => { if (String(args[0]) === root && ++checks === 3) { once = true; return undefined; } return stat(...args); }); syncBuiltinESMExports();
  foreign(root); f.repo.objects.withWriteLock(() => accountErasureStorage(root, { ...empty, purge: missing.purge })); assert.ok(once); mock.restoreAll(); syncBuiltinESMExports();
  foreign(root); const cut = new ErasureStorageRefusal("unverifiable", "temporary-storage"); accountabilityBoundary.visit = step => { if (step === "purge-planned") throw cut; };
  assert.throws(() => f.repo.objects.withWriteLock(() => { const purge = erasurePurge(f.repo.controlDirectory, f.id, [root], true); accountErasureStorage(root, { ...empty, purge: purge.purge }); }), failure => failure === cut); accountabilityBoundary.visit = () => {};
  rmSync(root, { recursive: true, force: true }); writeFileSync(root, "foreign regular root"); assert.throws(() => f.repo.objects.withWriteLock(() => erasurePurge(f.repo.controlDirectory, f.id, [root], false)), { code: "unverifiable" });
  rmSync(root); mkdirSync(root); const repaired = f.repo.objects.withWriteLock(() => erasurePurge(f.repo.controlDirectory, f.id, [root], false).receipt()); assert.equal(repaired.cancelled, 1); assert.equal(repaired.files.at(-1)!.reason, "root_replaced");
});

test("SIGKILL at every native lifecycle-journal publication step resumes after retiring the referenced instance", async t => {
  const prepare = retiredPending;
  /** Kill at real before/after filesystem operations, not a simulated successful write. */
  const run = (f: Awaited<ReturnType<typeof prepare>>, ordinal: number) => spawnSync(process.execPath, ["--import", new URL("./helpers/forbid-git.ts", import.meta.url).href, join(packageRoot, "test/helpers/erasure-purge-worker.ts"), f.repo.root, f.second, String(ordinal)], { env: { ...testEnvironment(), ...discardChildCoverage() }, encoding: "utf8", timeout: 30_000 });
  const probe = await prepare(); const listed = run(probe, 0); assert.equal(listed.status, 0, listed.stderr); const steps = JSON.parse(listed.stdout) as string[]; assert.ok(steps.length >= 20);
  for (let ordinal = 1; ordinal <= steps.length; ordinal++) {
    const f = await prepare(); const child = run(f, ordinal); assert.equal(child.signal, "SIGKILL", `${ordinal}/${steps[ordinal - 1]} ${child.stderr}`);
    let receipt: ReturnType<Repository["obliterate"]>;
    try { f.repo.objects.recoverWriterLock(); receipt = f.repo.obliterate(f.second, "erase-fixture", "incident", new Date(1)); }
    catch (error) { throw new Error(`native lifecycle cut ${ordinal}/${steps[ordinal - 1]}`, { cause: error }); }
    assert.equal(receipt.storage.accountable, true);
    const journal = JSON.parse(readFileSync(join(f.repo.controlDirectory, "erasure-purge.json"), "utf8")) as { operations: Record<string, ErasurePurgeEntry[]> };
    assert.equal(journal.operations[f.id][0].status, "cancelled"); assert.equal(journal.operations[f.id][0].reason, "root_retired"); assert.equal(f.repo.operations.read().filter(entry => entry.command === "obliterate").length, 1);
  }
  t.diagnostic(`${steps.length} actual native lifecycle-journal SIGKILL cuts, including durable temporary publication and directory barriers`);
});

test("a competing process at both retirement boundaries is excluded until the owning erasure releases last", async t => {
  const f = await retiredPending(); let attempts = 0;
  /** The child reports either the actual held lease or the real idempotent completion receipt. */
  const run = (mode: string) => spawnSync(process.execPath, ["--import", new URL("./helpers/forbid-git.ts", import.meta.url).href, join(packageRoot, "test/helpers/erasure-peer.ts"), f.repo.root, f.second, mode], { env: { ...testEnvironment(), ...discardChildCoverage() }, encoding: "utf8", timeout: 30_000 });
  accountabilityBoundary.visit = step => { if (step.startsWith("purge-lifecycle-")) { const peer = run("blocked"); assert.equal(peer.status, 0, peer.stderr); assert.equal(peer.stdout.trim(), "store_locked"); attempts++; } };
  const receipt = f.repo.obliterate(f.second, "erase-fixture", "incident", new Date(1)); accountabilityBoundary.visit = () => {}; assert.equal(attempts, 2);
  const peer = run("complete"); assert.equal(peer.status, 0, peer.stderr); assert.equal((JSON.parse(peer.stdout) as { tombstone: string }).tombstone, receipt.tombstone); assert.equal(f.repo.operations.read().filter(entry => entry.command === "obliterate").length, 1);
  t.diagnostic("2 real-process lifecycle interleavings on one non-git tracker; peer success is the same durable receipt");
});

test("512 seeded lifecycle sequences always match an independent accountability model and converge when clean", async t => {
  const f = await fixture(); let repo = f.repo; repo.obliterate(f.id, "erase-fixture", "model_cleanup", new Date(1));
  type Slot = { path: string; state: "active" | "retired" | "absent"; present: boolean; epoch: number };
  const slots: Slot[] = [0, 1].map(index => ({ path: join(f.dir.root, `instance-${index}`), state: "absent", present: false, epoch: 0 }));
  const files = new Map<string, { root: number; epoch: number; revision: number }>(); const plans = new Map<string, { root: number; epoch: number; revision: number }>();
  let serial = 0; let cuts = 0; let verdicts = 0; let operations = 0; const cutSteps = new Set<string>();
  const crashSteps = ["purge-planned", "purge-check", "purge-deleted", "purge-recorded", "pending", "storage-verified", "completed", "receipt"];
  /** The model knows instance lifecycle and file generations, without reading the production purge journal. */
  const scoped = (root: number): boolean => root < 0 || slots[root].state !== "absent";
  /** Explicit root removal destroys exactly this model root's bytes. */
  const remove = (index: number): void => {
    const slot = slots[index]; if (slot.state === "active") repo.unlinkInstance(`slot-${index}`);
    if (slot.state !== "absent") slot.state = "retired";
    rmSync(slot.path, { recursive: true, force: true }); slot.present = false;
    for (const [path, file] of files) if (file.root === index) files.delete(path);
  };
  /** Scope reduction is an explicit native administrative operation; historical receipt entries are not edited. */
  const prune = (index: number): void => { const slot = slots[index]; if (slot.state === "retired") { remove(index); repo.pruneRetiredInstance(relative(repo.root, slot.path), "erase-fixture", "model_prune", new Date(1)); slot.state = "absent"; slot.epoch++; } };
  /** Reusing the same instance name creates a new root generation. */
  const add = (index: number): void => { remove(index); prune(index); const slot = slots[index]; repo.linkInstance(`slot-${index}`, slot.path, { branch: "main" }); slot.state = "active"; slot.present = true; slot.epoch++; };
  /** Inject arbitrary raw or truncated encoded foreign bytes, with and without the selected payload. */
  const inject = (index: number, seed: number): void => {
    const root = index < 0 ? repo.objects.storageRoot() : join(slots[index].path, ".pmvcs/objects"); const path = foreign(root, `foreign-${serial++}`);
    writeFileSync(path, Buffer.concat([Buffer.alloc(seed % 23, seed % 255), Buffer.from(seed % 2 ? "selected first lifecycle payload 783629" : "unrelated foreign bytes")]));
    files.set(path, { root: index, epoch: index < 0 ? 0 : slots[index].epoch, revision: serial });
  };
  /** Reference verdict: complete instance scope and every unaccounted file either absent or exactly authorized. */
  const expected = (purge: boolean): boolean => !slots.some(slot => slot.state !== "absent" && !slot.present) && [...files].every(([path, file]) => !scoped(file.root) || purge || JSON.stringify(plans.get(path)) === JSON.stringify(file));
  /** Observe actual completed unlink boundaries to update the independent physical model, including interrupted writes. */
  const observe = (step: string, path: string): void => { if (["purge-planned", "purge-set-persisted"].includes(step) && files.has(path)) plans.set(path, { ...files.get(path)! }); if (step === "purge-deleted") files.delete(path); };
  /** Execute the real public SDK operation; a model crash reconstructs the repository before the next operation. */
  const obliterate = (purge: boolean, crash?: string): void => {
    const verdict = expected(purge); const error = new ErasureStorageRefusal("unverifiable", "temporary-storage"); let actual = true;
    accountabilityBoundary.visit = (step, path) => { observe(step, path); if (step === crash) { cutSteps.add(step); throw error; } };
    erasureScanBoundary.visit = step => { if (step === crash) { cutSteps.add(step); throw error; } };
    try { repo.obliterate(f.id, "erase-fixture", "model_cleanup", new Date(1), { purgeUnaccounted: purge }); }
    catch (failure) { if (failure === error) { cuts++; repo = Repository.open(repo.root); return; } assert.ok(failure instanceof Error && "code" in failure && ["unverifiable", "unbound_instance"].includes(String(failure.code)), String(failure)); actual = false; }
    finally { accountabilityBoundary.visit = () => {}; erasureScanBoundary.visit = () => {}; }
    assert.equal(actual, verdict, `model verdict at operation ${operations}: ${JSON.stringify({ purge, slots: slots.map(({state,present,epoch})=>({state,present,epoch})), files: [...files].map(([path,file])=>({name:relative(repo.root,path), ...file, planned:plans.get(path)})) })}`); verdicts++;
  };
  for (let seed = 1; seed <= 512; seed++) {
    if ((seed - 1) % 16 === 0) {
      const root = join(f.dir.root, `model-${(seed - 1) / 16}`); mkdirSync(root); cpSync(join(f.repo.root, ".pmvcs"), join(root, ".pmvcs"), { recursive: true }); cpSync(join(f.repo.root, "second"), join(root, "second")); repo = Repository.open(root);
    }
    let state = seed; const next = (): number => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const choices = [0, 1, 2, 3, 4, 5, 6, 7, ...Array.from({ length: 4 }, () => next() % 8)];
    for (let end = choices.length - 1; end > 0; end--) { const other = next() % (end + 1); [choices[end], choices[other]] = [choices[other], choices[end]]; }
    for (const op of choices) {
      operations++; const index = next() % 2;
      if (op === 0 || op === 3) add(index);
      if (op === 1) remove(index);
      if (op === 2) prune(index);
      if (op === 4) obliterate(true);
      if (op === 5) obliterate(false);
      if (op === 6) inject(slots[index].present ? index : -1, next());
      if (op === 7) { for (let slot = 0; slot < slots.length; slot++) if (!slots[slot].present) prune(slot); inject(-1, next()); obliterate(true, crashSteps[(seed - 1) % crashSteps.length]); }
    }
    for (let index = 0; index < slots.length; index++) { remove(index); prune(index); }
    for (const [path] of files) { rmSync(path, { force: true }); files.delete(path); }
    assert.equal(expected(false), true); obliterate(false);
    assert.equal(repo.objects.denials().find(entry => entry.tombstone.fileId === f.id)!.pending, false);
  }
  assert.equal(cutSteps.size, crashSteps.length); assert.ok(cuts >= 512); assert.equal(repo.operations.read().filter(entry => entry.command === "obliterate").length, 1);
  t.diagnostic(`512 seeds (1..512), ${operations} model operations, ${verdicts} checked verdicts, ${cuts} crashes across all ${cutSteps.size} publication boundaries; every sequence ends with a successful clean-store retry`);
});
