import "./helpers/isolate-session.ts";
/** Required aggregates must fail closed and every shard must retain the complete suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import { testEnvironment } from "./helpers/test-environment.ts";
import { shardTestFiles, testFileWeight } from "./helpers/ci-shards.ts";

const document=parseDocument(readFileSync(".github/workflows/ci.yml","utf8"),{strict:true,uniqueKeys:true});
assert.deepEqual(document.errors,[]);
const jobs=document.toJS().jobs;
test("quick and coverage matrices retain all files and unchanged deep gates",()=>{
  assert.deepEqual(jobs["quick-shard"].strategy.matrix,{"node-version":[22],shard:Array.from({length:8},(_,i)=>i+1)});
  assert.deepEqual(jobs["coverage-shard"].strategy.matrix,{"node-version":[26],shard:Array.from({length:8},(_,i)=>i+1)});
  assert.match(jobs["quick-shard"].steps.at(-1).run,/test\/helpers\/ci-shards\.ts .*\/8/);
  assert.match(jobs["coverage-shard"].steps.find((s:{name:string})=>s.name==="Collect coverage shard").run,/scripts\/coverage-gate.ts --shard/);
  assert.match(jobs["coverage-shard"].steps.find((s:{name:string})=>s.name==="Collect coverage shard").run,/matrix.shard.*\/8/);
  assert.match(jobs["coverage-merge"].steps.find((s:{name:string})=>s.name==="Merge exact hits and enforce thresholds").run,/--merge 8 /);
  assert.deepEqual(jobs["coverage-merge"].needs,["changes","coverage-shard"]);
  assert.deepEqual(jobs.test.needs,["changes","quick-shard","release-gate","coverage-merge"]);
  assert.equal(jobs.test.if,"${{ always() }}");
  for(const job of Object.values(jobs) as {"timeout-minutes":number}[]) assert.ok(job["timeout-minutes"]<=22);
  for(const name of ["quick-shard","coverage-shard"]) assert.equal(jobs[name].steps.find((step:{name:string})=>step.name==="Expose local test commands").run,'echo "$PWD/node_modules/.bin" >> "$GITHUB_PATH"');
  const manifest=JSON.parse(readFileSync("package.json","utf8"));
  assert.ok(manifest.scripts["release:check"].includes("npm run coverage"));
  const release=jobs["release-gate"].steps.find((s:{name:string})=>s.name==="Non-coverage release gates").run;
  for(const command of manifest.scripts["release:check"].split(" && ").filter((s:string)=>s!=="npm run coverage")) assert.ok(release.includes(command),command);
  assert.ok(!release.includes("npm run coverage"));
});

test("balanced shards discover every test once and fit the measured twelve-minute budget", () => {
  const weights: Record<string, number> = JSON.parse(readFileSync("test/ci-shard-times.json", "utf8"));
  assert.ok(Object.values(weights).every(cost => Number.isFinite(cost) && cost > 0));
  const groups = Array.from({ length: 8 }, (_, index) => shardTestFiles(process.cwd(), `${index + 1}/8`));
  assert.deepEqual(groups.flat().sort(), globSync("test/*.test.ts").sort());
  assert.deepEqual(groups[0], shardTestFiles(process.cwd(), "1/8"));
  const costs = groups.map(files => files.reduce((sum, file) => sum + testFileWeight(file, weights), 0));
  assert.ok(Math.max(...costs) + 120 <= 720, "eight shards fit with two minutes of setup reserve");
});

test("Windows native paths use POSIX timing keys and retain the unknown-file reserve", () => {
  const weights = { "test/known.test.ts": 137 };
  assert.equal(testFileWeight("test\\known.test.ts", weights), 137);
  assert.equal(testFileWeight("test/known.test.ts", weights), 137);
  assert.equal(testFileWeight("test\\new.test.ts", weights), 60);
});

test("new files participate without timing entries and invalid or empty shards refuse", t => {
  const root = mkdtempSync(join(tmpdir(), "ci-shards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "test"));
  for (const name of ["new-a", "new-b", "new-c"]) writeFileSync(join(root, `test/${name}.test.ts`), "");
  assert.deepEqual([1, 2].flatMap(index => shardTestFiles(root, `${index}/2`)).sort(), globSync("test/*.test.ts", { cwd: root }).sort());
  for (const shard of ["0/2", "3/2", "1/4", "1/0", "1/9007199254740992", "bad"]) assert.throws(() => shardTestFiles(root, shard), /invalid shard/);
});

test("required aggregates reject failures, cancellations and skipped prerequisites",{skip:process.platform==="win32"},()=>{
  const run=jobs.test.steps.at(-1).run;
  for(const node of ["22","26"]) for(const prerequisite of ["CHANGES","QUICK","RELEASE","COVERAGE"]) for(const result of ["success","failure","cancelled","skipped"]){
    const env=testEnvironment({NODE_VERSION:node,CHANGES:"success",CODE:"true",QUICK:"success",RELEASE:"success",COVERAGE:"success",[prerequisite]:result});
    const required=prerequisite==="CHANGES"||(node==="22"?prerequisite==="QUICK":prerequisite!=="QUICK");
    const child=spawnSync("bash",["-c",run],{env,encoding:"utf8"});assert.equal(child.status===0,!required||result==="success",`${node} ${prerequisite}=${result}`);
  }
  for(const node of ["22","26"]) for(const changes of ["success","failure","cancelled","skipped"]){
    const env=testEnvironment({NODE_VERSION:node,CHANGES:changes,CODE:"false",QUICK:"skipped",RELEASE:"skipped",COVERAGE:"skipped"});
    const child=spawnSync("bash",["-c",run],{env,encoding:"utf8"});assert.equal(child.status===0,changes==="success",`${node} CODE=false CHANGES=${changes}`);
  }
});
