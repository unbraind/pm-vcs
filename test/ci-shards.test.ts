import "./helpers/isolate-session.ts";
/** Required aggregates must fail closed and every shard must retain the complete suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDocument } from "yaml";
import { testEnvironment } from "./helpers/test-environment.ts";

const document=parseDocument(readFileSync(".github/workflows/ci.yml","utf8"),{strict:true,uniqueKeys:true});
assert.deepEqual(document.errors,[]);
const jobs=document.toJS().jobs;
test("quick and coverage matrices retain all files and unchanged deep gates",()=>{
  assert.deepEqual(jobs["quick-shard"].strategy.matrix,{"node-version":[22],shard:Array.from({length:14},(_,i)=>i+1)});
  assert.deepEqual(jobs["coverage-shard"].strategy.matrix,{"node-version":[26],shard:Array.from({length:14},(_,i)=>i+1)});
  assert.match(jobs["quick-shard"].steps.at(-1).run,/--test-shard=.*test\/\*\.test\.ts/);
  assert.match(jobs["coverage-shard"].steps.find((s:{name:string})=>s.name==="Collect coverage shard").run,/scripts\/coverage-gate.ts --shard/);
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

test("required aggregates reject failures, cancellations and skipped prerequisites",{skip:process.platform==="win32"},()=>{
  const run=jobs.test.steps.at(-1).run;
  for(const node of ["22","26"]) for(const result of ["success","failure","cancelled","skipped"]){
    const env={...testEnvironment(),NODE_VERSION:node,CHANGES:"success",CODE:"true",QUICK:"success",RELEASE:"success",COVERAGE:"success",[node==="22"?"QUICK":"COVERAGE"]:result};
    const child=spawnSync("bash",["-c",run],{env,encoding:"utf8"});assert.equal(child.status===0,result==="success",node+result);
  }
});
