import "./helpers/isolate-session.ts";
/** Native SIGKILL suites own the runner's cores; other erasure assertions use ordinary workers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { Repository } from "../engine/repo.ts";
import { accountabilityBoundary } from "../engine/erasure-accountability.ts";
import { erasureScanBoundary } from "../engine/erasure-scan.ts";
import { objectFiles } from "../engine/object-files.ts";
import { lifecycleMatrix } from "./helpers/crash-matrix.ts";
import { retiredPending, interruptedUnpack, cleanupFixtures } from "./helpers/lifecycle-fixtures.ts";
import { erasureFixtureBase } from "./helpers/erasure-fixture-base.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
const temps: ReturnType<typeof makeTempDir>[]=[];
afterEach(()=>{mock.restoreAll();syncBuiltinESMExports();accountabilityBoundary.visit=()=>{};erasureScanBoundary.visit=()=>{};cleanupFixtures();for(const dir of temps.splice(0))dir.cleanup();assert.equal(objectFiles.active.size,0);});
/** Use the unchanged SDK fixture and byte payload for the purge reference probe. */
async function fixture(bytes=Buffer.from("ordinary retained live data")){
 const dir=makeTempDir();temps.push(dir);const base=erasureFixtureBase(dir.root,"accountable");const repo=base instanceof Repository?base:await base;writeFileSync(join(dir.root,"asset"),bytes);repo.stage(["asset"]);return{dir,repo,entry:repo.readIndex()[0]!,bytes};
}
/** Only the explicitly chosen disposable leaf is created or replaced. */
function place(root:string,name:string,bytes:Buffer):string{const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);return path;}
test("SIGKILL at EVERY purge journal and unlink boundary converges with one bounded receipt",async(t)=>{
 /** Every case copies completed SDK initialization, stages its own payload and uses the actual engine command. */
 const fresh=async()=>{const f=await fixture();place(f.repo.objects.storageRoot(),"unaccounted-purge",Buffer.from("foreign bytes to purge"));return f;};
 const run=(f:Awaited<ReturnType<typeof fixture>>,ordinal:number)=>spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/erasure-purge-worker.ts"),f.repo.root,f.entry.fileId!,String(ordinal)],{env:{...testEnvironment(),...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.dir.root)},encoding:"utf8",timeout:30_000});
 const probe=await fresh();const listed=run(probe,0);assert.equal(listed.status,0,listed.stderr);const steps=JSON.parse(listed.stdout) as string[];assert.ok(steps.length>=40);
 const timing=await lifecycleMatrix("purge-journal",(_name,run)=>run(),steps);t.diagnostic(JSON.stringify({scenario:"purge-journal",...timing}));
 t.diagnostic(`${steps.length} native before/after purge publication, directory barrier and unlink crash cuts`);
});

for (const scenario of ["retired-instance", "interrupted-unpack"] as const) test(`SIGKILL at every native lifecycle-journal publication step resumes for ${scenario}`, { concurrency: true }, async t => {
  const reference = await (scenario === "retired-instance" ? retiredPending(true) : interruptedUnpack(true));
  const listed = spawnSync(process.execPath, ["--import", new URL("./helpers/forbid-git.ts", import.meta.url).href, join(packageRoot, "test/helpers/erasure-purge-worker.ts"), reference.repo.root, reference.second, "0"], { env: { ...testEnvironment(), ...discardChildCoverage() }, encoding: "utf8", timeout: scenario === "interrupted-unpack" ? 120_000 : 30_000 });
  assert.equal(listed.status, 0, listed.stderr); const steps = JSON.parse(listed.stdout) as string[]; assert.ok(steps.length >= 20);
  const result = await lifecycleMatrix(scenario, (name, run) => t.test(name, run), steps);
  t.diagnostic(JSON.stringify({ scenario, ...result }));
});
