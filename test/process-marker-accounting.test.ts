import "./helpers/isolate-session.ts";
/** Native process-marker accounting, interrupted erasure and exact-set recovery without Git. */
import assert from "node:assert/strict";
import fs, { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, mock, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { durability } from "../engine/durability.ts";
import { destructionBoundary, inspectDestructions } from "../engine/destruction.ts";
import { objectFiles } from "../engine/object-files.ts";
import { verificationLimits } from "../engine/object-error.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { nativeStagePrefix as prefix, abandonProcessStage as abandon } from "./helpers/process-stage.ts";
import { recoverBisectWorker } from "../engine/bisect.ts";

const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { mock.reset(); syncBuiltinESMExports(); destructionBoundary.visit = () => {}; assert.equal(objectFiles.active.size, 0); for (const dir of temporary.splice(0)) dir.cleanup(); });
/** Create a real SDK tracker outside Git; native repositories remain inside that explicit fixture. */
async function fixture(): Promise<string> { const dir = makeTempDir(); temporary.push(dir); process.env.GIT_CEILING_DIRECTORIES = dirname(dir.root); await new PmClient({ cwd: dir.root, pmRoot: join(dir.root, ".agents/pm"), noExtensions: true }).init("native-owner", { defaults: true, author: "fixture" }); return dir.root; }
test("native marker accounting rejects every foreign schema and filename without acquiring deletion authority", async t => {
 const root = await fixture(); const repo = Repository.init(join(root, "schema")); const path = join(repo.controlDirectory, "oplog.jsonl.lock"); let cases = 0;
 destructionBoundary.visit = (step, target) => {
  if (step !== "process-owner-published" || target !== path) return;
  const staged = join(dirname(path), readdirSync(dirname(path)).find(name => name.startsWith(prefix(path)))!); const original = readFileSync(staged); const record = JSON.parse(original.toString("utf8")) as Record<string, unknown>; const baseline = objectFiles.active.size;
  assert.equal(durability.processMarker(staged, path), true); assert.equal(durability.processMarker(path, path), true);
  for (const value of [null, [], false, 1, "foreign", ...[{ format: "foreign" }, { pid: 0 }, { pid: 1.5 }, { pid: "1" }, { pid: 2_147_483_648 }, { identity: "foreign" }, { parent: "foreign" }, { name: "another.lock" }, { owner: null }, { owner: "foreign" }, { extra: true }].map(patch => ({ ...record, ...patch }))]) { writeFileSync(staged, JSON.stringify(value)); assert.equal(durability.processMarker(staged, path), false); assert.equal(objectFiles.active.size, baseline); cases++; }
  for (const bytes of [Buffer.alloc(0), Buffer.from("truncated{"), Buffer.alloc(4097, 120)]) { writeFileSync(staged, bytes); assert.equal(durability.processMarker(staged, path), false); assert.equal(objectFiles.active.size, baseline); cases++; }
  writeFileSync(staged, original);
  const renamed = join(dirname(path), prefix(path) + `${Number(record.pid) + 1}-aaaaaaaaaaaa.lock`); fs.linkSync(staged, renamed); assert.equal(durability.processMarker(renamed, path), false); rmSync(renamed);
  const copied = staged.replace(/\.[^.]+$/, ".copy"); fs.copyFileSync(staged, copied); assert.equal(durability.processMarker(copied, path), false); rmSync(copied);
  assert.equal(durability.processMarker(staged, join(root, "another", "oplog.jsonl.lock")), false);
  assert.equal(durability.processMarker(join(dirname(path), prefix(path) + "1-ffffffffffff.lock"), path), false);
  const link = join(dirname(path), prefix(path) + "1-eeeeeeeeeeee.lock"); fs.symlinkSync(staged, link); assert.equal(durability.processMarker(link, path), false); rmSync(link); mkdirSync(link); assert.equal(durability.processMarker(link, path), false); rmSync(link, { recursive: true });
  writeFileSync(staged, original);
 };
 const lease = durability.claim(path, "fixture_locked"); lease.release(); t.diagnostic(`${cases} foreign schema/partial/oversized cases plus native, renamed, copied, missing, cross-root and nonregular names`);
});

test("marker reads close their descriptor on short reads, native failures and every mutable identity race", async () => {
 const root = await fixture(); const repo = Repository.init(join(root, "reads")); const path = join(repo.controlDirectory, "oplog.jsonl.lock");
 destructionBoundary.visit = (step, target) => {
  if (step !== "process-owner-published" || target !== path) return;
  const staged = join(dirname(path), readdirSync(dirname(path)).find(name => name.startsWith(prefix(path)))!); const original = readFileSync(staged); const baseline = objectFiles.active.size; const open = fs.openSync; const read = fs.readSync; const stat = fs.lstatSync;
  for (const code of ["ENOENT", "ELOOP", "EIO", undefined]) { mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { if (args[0] === staged) throw Object.assign(new Error("native open fault"), { code }); return open(...args); }); syncBuiltinESMExports(); try { if (code === undefined) assert.throws(() => durability.processMarker(staged, path), /native open fault/); else if (code === "EIO") assert.throws(() => durability.processMarker(staged, path), { code }); else assert.equal(durability.processMarker(staged, path), false); } finally { mock.restoreAll(); syncBuiltinESMExports(); } assert.equal(objectFiles.active.size, baseline); }
  for (const mode of ["short", "error", "partial", "before-open", "during-read", "missing-after-read", "after-path-check"]) {
   let changed = false; let pathChecks = 0;
   if (mode === "before-open") mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { const fd = open(...args); if (args[0] === staged) fs.utimesSync(staged, new Date(2000), new Date(2000)); return fd; });
   else mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => { if (mode === "short") return 0; if (mode === "error") throw Object.assign(new Error("native read fault"), { code: "EIO" }); const options = args[2] as fs.ReadOptions; const count = mode === "partial" ? read(args[0], args[1], { ...options, length: 1 }) : read(...args); if (mode === "during-read" && !changed) { changed = true; fs.utimesSync(staged, new Date(3000), new Date(3000)); } return count; });
   if (mode === "missing-after-read" || mode === "after-path-check") mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => { const value = stat(...args); if (args[0] === staged && ++pathChecks === 2) { if (mode === "missing-after-read") return undefined; fs.utimesSync(staged, new Date(4000), new Date(4000)); } return value; });
   syncBuiltinESMExports(); try { if (mode === "error") assert.throws(() => durability.processMarker(staged, path), { code: "EIO" }); else assert.equal(durability.processMarker(staged, path), mode === "partial"); } finally { mock.restoreAll(); syncBuiltinESMExports(); writeFileSync(staged, original); } assert.equal(objectFiles.active.size, baseline);
  }
 };
 const lease = durability.claim(path, "fixture_locked"); lease.release();
});

test("orphan process-stage cleanup preserves live and foreign records, refuses exhausted budgets and resumes exact ownership", async () => {
 const root = await fixture(); const repo = Repository.init(join(root, "orphans")); const path = join(repo.controlDirectory, "oplog.jsonl.lock"); const staged = abandon(path); const foreign = join(dirname(path), prefix(path) + "1-ffffffffffff.lock"); writeFileSync(foreign, "foreign tripwire");
 for (const key of ["receiptRecords", "receiptMs"] as const) { const limit = verificationLimits[key]; verificationLimits[key] = 0; try { assert.throws(() => durability.claim(path, "fixture_locked")); assert.ok(existsSync(staged)); assert.equal(readFileSync(foreign, "utf8"), "foreign tripwire"); } finally { verificationLimits[key] = limit; } }
 const lease = durability.claim(path, "fixture_locked"); lease.release(); assert.equal(existsSync(staged), false); assert.equal(readFileSync(foreign, "utf8"), "foreign tripwire"); assert.equal(inspectDestructions(repo.controlDirectory).pending, 0);
});

for (const mode of ["stage-flushed", "owner-published", "log-flushed"]) test(`erasure reconciles a real SIGKILL at ${mode} and records its operation exactly once`, async () => {
 const root = await fixture(); const repo = Repository.init(root); repo.setAuthority("fixture", "read-fixture", "erase-fixture"); writeFileSync(join(root, "asset"), "selected native owner payload 839517264"); repo.stage(["asset"]); const entry = repo.readIndex()[0];
 const child = spawnSync(process.execPath, ["--import", new URL("./helpers/forbid-git.ts", import.meta.url).href, join(packageRoot, "test/helpers/erasure-purge-worker.ts"), root, entry.fileId!, mode], { env: { ...testEnvironment(), ...discardChildCoverage(), GIT_CEILING_DIRECTORIES: dirname(root) }, encoding: "utf8", timeout: 60_000 }); assert.equal(child.signal, "SIGKILL", child.stderr);
 repo.objects.recoverWriterLock(); const result = repo.obliterate(entry.fileId!, "erase-fixture", "incident", new Date(1), { purgeUnaccounted: true }); assert.equal(result.storage.accountable, true); assert.equal(repo.obliterate(entry.fileId!, "erase-fixture", "incident", new Date(1)).tombstone, result.tombstone); assert.equal(repo.operations.read().filter(operation => operation.command === "obliterate").length, 1); assert.deepEqual(readdirSync(repo.controlDirectory).filter(name => name.startsWith(prefix(join(repo.controlDirectory, "oplog.jsonl.lock")))), []); assert.equal(existsSync(join(repo.controlDirectory, "oplog.jsonl.lock")), false); assert.equal(inspectDestructions(repo.controlDirectory).pending, 0);
});

test("live native staging owners and permission failures never grant orphan cleanup authority",async()=>{
 const root=await fixture();const repo=Repository.init(join(root,"live"));const path=join(repo.controlDirectory,"oplog.jsonl.lock");let alias="";
 destructionBoundary.visit=(step,target)=>{if(step!=="process-owner-published"||target!==path||alias!=="")return;const stage=join(dirname(path),readdirSync(dirname(path)).find(name=>name.startsWith(prefix(path)))!);alias=join(dirname(path),prefix(path)+`${process.pid}-ffffffffffff.lock`);fs.linkSync(stage,alias);};
 const lease=durability.claim(path,"fixture_locked");destructionBoundary.visit=()=>{};lease.release();assert.ok(existsSync(alias));const original=readFileSync(alias);const kill=process.kill;mock.method(process,"kill",(...args:Parameters<typeof process.kill>)=>{if(args[0]===process.pid)throw Object.assign(new Error("process inspection denied"),{code:"EPERM"});return kill(...args);});
 try{assert.throws(()=>durability.claim(path,"fixture_locked"),{code:"EPERM"});assert.deepEqual(readFileSync(alias),original);}finally{mock.restoreAll();syncBuiltinESMExports();}rmSync(alias);
 const worker=join(repo.controlDirectory,"BISECT_WORKER");mkdirSync(worker);assert.throws(()=>recoverBisectWorker(repo),{code:"bisect_locked"});assert.ok(lstatSync(worker).isDirectory());
});

test("orphan recovery fences a competing owner at every exact-set protocol boundary",async t=>{
 const root=await fixture();const prepare=(name:string)=>{const repo=Repository.init(join(root,name));const path=join(repo.controlDirectory,"oplog.jsonl.lock");const staged=abandon(path);writeFileSync(join(repo.root,"guard"),"unrelated tripwire");return{repo,path,staged};};
 const probe=prepare("probe");const steps:string[]=[];let active=false;
 destructionBoundary.visit=(step)=>{if(step==="process-stages-captured")active=true;if(active)steps.push(step);if(step==="process-stages-completed")active=false;};const owner=durability.claim(probe.path,"fixture_locked");owner.release();destructionBoundary.visit=()=>{};assert.ok(steps.length>15);
 for(let cut=1;cut<=steps.length;cut++){const f=prepare(`cut-${cut}`);let ordinal=0;let injected=false;active=false;
  destructionBoundary.visit=(step)=>{if(step==="process-stages-captured")active=true;if(active&&++ordinal===cut){injected=true;destructionBoundary.visit=()=>{};renameSync(f.path,f.path+".retired");writeFileSync(f.path,"peer-owned marker");}if(step==="process-stages-completed")active=false;};
  assert.throws(()=>durability.claim(f.path,"fixture_locked"),`${cut}/${steps[cut-1]}`);destructionBoundary.visit=()=>{};assert.ok(injected);assert.equal(readFileSync(f.path,"utf8"),"peer-owned marker");assert.equal(readFileSync(join(f.repo.root,"guard"),"utf8"),"unrelated tripwire");assert.equal(objectFiles.active.size,0);rmSync(f.path);rmSync(f.path+".retired");
  for(let retry=0;retry<2;retry++){const next=durability.claim(f.path,"fixture_locked");next.release();}assert.equal(existsSync(f.staged),false);assert.equal(inspectDestructions(f.repo.controlDirectory).pending,0);
 }
 t.diagnostic(`${steps.length} competing-owner transitions across every orphan retirement boundary on one non-git tracker`);
});

test("lease acquisition restarts when a peer removes, mutates or replaces its observed owner",async()=>{
 const root=await fixture();
 for(const mode of ["absent","changed","replacement"]){const repo=Repository.init(join(root,mode));const path=join(repo.controlDirectory,"oplog.jsonl.lock");const owner=durability.claim(path,"fixture_locked");const read=fs.readSync;const stat=fs.lstatSync;let injected=false;let observations=0;let replacement:ReturnType<typeof durability.claim>|undefined;
  if(mode==="replacement")mock.method(fs,"lstatSync",(...args:Parameters<typeof fs.lstatSync>)=>{if(args[0]===path&&typeof args[1]==="object"&&args[1]?.bigint&&++observations===2&&!injected){injected=true;renameSync(path,path+".retired");replacement=durability.claim(path,"fixture_locked");}return stat(...args);});
  else mock.method(fs,"readSync",(...args:Parameters<typeof fs.readSync>)=>{const count=read(...args);if(!injected){injected=true;if(mode==="absent")renameSync(path,path+".retired");else fs.utimesSync(path,new Date(5000),new Date(5000));}return count;});
  syncBuiltinESMExports();try{if(mode==="absent"){const next=durability.claim(path,"fixture_locked");next.verify();next.release();}else assert.throws(()=>durability.claim(path,"fixture_locked"),{code:"fixture_locked"});assert.ok(injected);}finally{mock.restoreAll();syncBuiltinESMExports();}
  assert.throws(()=>owner.verify(),{code:"fixture_locked"});replacement?.verify();owner.release();replacement?.release();if(existsSync(path))rmSync(path);if(existsSync(path+".retired"))rmSync(path+".retired");assert.equal(objectFiles.active.size,0);
 }
});
