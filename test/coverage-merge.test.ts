import "./helpers/isolate-session.ts";
/** Verify the real c8 source-location union against its original unsharded invocation. */
import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runCoverageShard, mergeCoverage } from "../scripts/coverage-gate.ts";
import { testEnvironment } from "./helpers/test-environment.ts";

test("merged shard hits equal unsharded c8 including exclusive branches and functions", t => {
  const root=mkdtempSync(join(tmpdir(),"c8-union-")); t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,"test/helpers"),{recursive:true});
  const manifest=JSON.parse(readFileSync("package.json","utf8")); writeFileSync(join(root,"package.json"),JSON.stringify({type:"module",scripts:{coverage:manifest.scripts.coverage}}));
  writeFileSync(join(root,"test/helpers/release-suite.ts"),readFileSync("test/helpers/release-suite.ts","utf8"));
  writeFileSync(join(root,"test/helpers/test-environment.ts"),readFileSync("test/helpers/test-environment.ts","utf8"));
  writeFileSync(join(root,"value.ts"),`export function classify(value: number) {
  if (value > 0) return positive();
  return negative();
}
export function positive() { return "positive"; }
export function negative() { return "negative"; }
`);
  for (const [name,value,expected] of [["a",1,"positive"],["b",-1,"negative"]] as const) writeFileSync(join(root,`test/${name}.test.ts`), `import test from 'node:test'; import assert from 'node:assert/strict'; import {classify} from '../value.ts'; test('${name}',()=>assert.equal(classify(${value}), '${expected}'));`);
  const args=manifest.scripts.coverage.split(" && ").at(-1).slice(3).replaceAll("'", "").split(" ");
  const whole=spawnSync(process.execPath,[createRequire(import.meta.url).resolve("c8/bin/c8.js"),...args],{cwd:root,env:testEnvironment(),encoding:"utf8"}); assert.equal(whole.status,0,whole.stdout+whole.stderr);
  const originalHits=JSON.parse(readFileSync(join(root,"coverage/coverage-final.json"),"utf8"));
  const original=JSON.parse(readFileSync(join(root,"coverage/coverage-summary.json"),"utf8"));
  for (const [shard,output] of [["1/2","first"],["2/2","second"]]) assert.equal(runCoverageShard(root,shard!,output!),0);
  const paths=["first/hits.json","second/hits.json"];
  for(const path of paths) {const hits=Object.values(JSON.parse(readFileSync(join(root,path),"utf8")).hits) as {f:Record<string,number>;b:Record<string,number[]>}[];assert.ok(hits.some(file=>Object.values(file.f).some(count=>count===0)));assert.ok(hits.some(file=>Object.values(file.b).flat().some(count=>count===0)));}
  assert.equal(mergeCoverage(root,paths,2),0);
  const {createCoverageMap}=createRequire(import.meta.url)("istanbul-lib-coverage");
  const merged=createCoverageMap(JSON.parse(readFileSync(join(root,"coverage/merged.json"),"utf8")));
  assert.deepEqual(merged.getCoverageSummary().toJSON(),original.total);
  const normalize=(data: {s:Record<string,number>;f:Record<string,number>;b:Record<string,number[]>}) => ({...data,s:Object.fromEntries(Object.entries(data.s).map(([id,n])=>[id,Number(Number(n)>0)])),f:Object.fromEntries(Object.entries(data.f).map(([id,n])=>[id,Number(Number(n)>0)])),b:Object.fromEntries(Object.entries(data.b).map(([id,n])=>[id,(n as number[]).map(count=>Number(count>0))]))});
  for(const file of merged.files()) assert.deepEqual(normalize(merged.fileCoverageFor(file).toJSON()),normalize(originalHits[file]));
  const script=resolve("scripts/coverage-gate.ts");
  for(const args of [["--shard","1/2","--output","cli"],["--merge","2",...paths]]) {
    const cli=spawnSync(process.execPath,[script,...args],{cwd:root,env:testEnvironment(),encoding:"utf8"});assert.equal(cli.status,0,cli.stdout+cli.stderr);
  }
  const saved=readFileSync(join(root,paths[0]!),"utf8");
  const change=(mutate:(artifact: {shard:string;node:string;digest:string;raw:{url:string}[]})=>void) => {const artifact=JSON.parse(saved);mutate(artifact);writeFileSync(join(root,paths[0]!),JSON.stringify(artifact));};
  change(artifact=>{artifact.shard="3/2"});assert.throws(()=>mergeCoverage(root,paths,2),/incomplete shard/);
  change(artifact=>{artifact.raw[0].url="../outside.ts"});assert.throws(()=>mergeCoverage(root,paths,2),/non-relative source/);
  change(artifact=>{artifact.raw[0].url=resolve(root,"value.ts")});assert.throws(()=>mergeCoverage(root,paths,2),/non-relative source/);
  change(artifact=>{artifact.node="0.0.0"});assert.throws(()=>mergeCoverage(root,paths,2),/runtime mismatch/);
  change(artifact=>{artifact.digest="wrong"});assert.throws(()=>mergeCoverage(root,paths,2),/source mismatch/);
  writeFileSync(join(root,paths[0]!),saved);
  assert.throws(()=>mergeCoverage(root,[],0),/missing shards/);
  for(const shard of ["0/2","3/2"]) assert.throws(()=>runCoverageShard(root,shard,"bad"),/invalid shard/);
  writeFileSync(join(root,"never.ts"),"export function never() {return 42;}\n");
  // Original --all --100 --per-file must still reject new, wholly untested code.
  for(const [shard,output] of [["1/2","new-first"],["2/2","new-second"]]) assert.equal(runCoverageShard(root,shard!,output!),0);
  assert.equal(mergeCoverage(root,["new-first/hits.json","new-second/hits.json"],2),1);
  rmSync(join(root,"never.ts"));
  for (const result of [{status:null,error:new Error("fixture spawn failed")},{status:null},{status:1}]) {
    const mocked=t.mock.method(childProcess,"spawnSync",()=>result);syncBuiltinESMExports();
    try {
      if(result.error) assert.throws(()=>runCoverageShard(root,"1/2","bad"),/fixture spawn failed/);
      else assert.equal(runCoverageShard(root,"1/2","bad"),1);
    } finally { mocked.mock.restore();syncBuiltinESMExports(); }
  }
  assert.throws(()=>mergeCoverage(root,[paths[0]!],2),/missing shards/);
  assert.throws(()=>mergeCoverage(root,[paths[0]!,paths[0]!],2),/duplicate shard/);
});
