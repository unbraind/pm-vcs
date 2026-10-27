import "./helpers/isolate-session.ts";
/** Exhausted proof budgets never become certificates or deletion authority on real non-git stores. */
import assert from "node:assert/strict";
import { afterEach, test, mock } from "node:test";
import fs, { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { syncBuiltinESMExports } from "node:module";
import { inspectClosure, requireClosure } from "../engine/closure.ts";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { collectGarbage } from "../engine/gc.ts";
import { prepareDestruction, inspectDestructions } from "../engine/destruction.ts";
import { accountErasureStorage, accountabilityBoundary } from "../engine/erasure-accountability.ts";
import { inspectErasureRepresentation, erasureScanLimits, fingerprint } from "../engine/erasure-scan.ts";
import { inspectRepresentations } from "../engine/representations.ts";
import { VerificationRefusal, verificationLimits } from "../engine/object-error.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const owned: ReturnType<typeof makeTempDir>[] = [];
const limits = { ...verificationLimits }; const scans = { ...erasureScanLimits };
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); Object.assign(verificationLimits, limits); Object.assign(erasureScanLimits, scans); accountabilityBoundary.visit = () => {}; for (const dir of owned.splice(0)) dir.cleanup(); });
/** Real SDK initialization and native committed history expose every verification path without Git discovery. */
async function fixture() {
 const dir=makeTempDir();owned.push(dir);await new PmClient({cwd:dir.root,pmRoot:join(dir.root,".agents/pm"),noExtensions:true}).init("bounds",{defaults:true,author:"fixture"});
 const repo=Repository.init(dir.root);writeFileSync(join(dir.root,"asset"),"a complete verification fixture");repo.stage(["asset"]);repo.commit({message:"fixture",author:{name:"Fixture",email:"fixture@example.invalid",timestamp:1,timezoneOffsetMinutes:0}},new Date(1));
 return {dir,repo};
}
/** Typed negative outcomes carry both the verifier and exact exhausted bound through JSON serialization. */
function refused(action:()=>unknown, verifier:string, bound:string):void {
 assert.throws(action,error=>{assert.ok(error instanceof VerificationRefusal);assert.equal(error.status,"unverified");assert.equal(error.verifier,verifier);assert.equal(error.bound,bound);assert.match(JSON.stringify(error),/unverified/u);return true;});
}

for(const [key,bound] of [["integrityObjects","reference_count"],["integrityMs","time_ms"]] as const)test(`integrity ${bound} exhaustion cannot retain a positive verified count`,async()=>{
 const {repo}=await fixture();assert.ok(repo.verify().verified>0);verificationLimits[key]=0;const result=repo.verify();assert.equal(result.verified,0);assert.deepEqual(result.verification,{status:"unverified",verifier:"integrity",bound});Object.assign(verificationLimits,limits);assert.ok(repo.verify().verified>0);
});

for(const [key,bound] of [["reachabilityObjects","object_count"],["reachabilityMs","time_ms"]] as const)test(`reachability ${bound} exhaustion refuses both GC modes before deletion`,async()=>{
 const {repo}=await fixture();const garbage=repo.objects.write("blob",Buffer.from("unreachable candidate"));const before=repo.objects.read(garbage).payload;verificationLimits[key]=0;
 for(const apply of [false,true])refused(()=>collectGarbage(repo,apply),"reachability",bound);assert.deepEqual(repo.objects.read(garbage).payload,before);Object.assign(verificationLimits,limits);assert.equal(collectGarbage(repo,true).removed,1);
});

for(const [key,bound] of [["receiptRecords","record_count"],["receiptMs","time_ms"],["receiptBytes","record_bytes"]] as const)test(`receipt ${bound} exhaustion is unverified even with a complete matching receipt`,async()=>{
 const {repo}=await fixture();const path=join(repo.root,"candidate");writeFileSync(path,"planned");const plan=prepareDestruction(repo.controlDirectory,"bounds",[{path}]);plan.remove(path);plan.finish();assert.equal(inspectDestructions(repo.controlDirectory).verification.status,"verified");verificationLimits[key]=0;
 assert.deepEqual(inspectDestructions(repo.controlDirectory,1).verification,{status:"unverified",verifier:"receipts",bound});Object.assign(verificationLimits,limits);assert.equal(inspectDestructions(repo.controlDirectory).verification.status,"verified");
});

test("receipt decode failure beyond the rendered page cannot be hidden by a valid first receipt",async()=>{
 const {repo}=await fixture();for(let i=0;i<22;i++)prepareDestruction(repo.controlDirectory,`receipt-${i}`,[]).finish();const ledger=join(repo.controlDirectory,"destruction");const file=readdirSync(ledger).filter(name=>name.endsWith(".json")).sort().at(-1)!;const path=join(ledger,file);const original=readFileSync(path);writeFileSync(path,"{broken");
 const report=inspectDestructions(repo.controlDirectory,1);assert.equal(report.verification.status,"unverified");assert.equal(report.verification.bound,"decode_error");assert.ok(report.omitted>0);assert.ok(report.skippedCount>0);assert.equal(readFileSync(path,"utf8"),"{broken");writeFileSync(path,original);assert.equal(inspectDestructions(repo.controlDirectory).verification.status,"verified");
});

for(const [key,bound] of [["accountabilityFiles","file_count"],["accountabilityFileBytes","file_bytes"],["accountabilityDecodedBytes","decoded_bytes"],["accountabilityMs","time_ms"]] as const)test(`accountability ${bound} exhaustion cannot authorize purge or a native certificate`,async()=>{
 const {repo}=await fixture();const options={forbiddenIds:new Set<string>(),forbiddenPayloads:new Set<string>(),purge:()=>{assert.fail("budget exhaustion granted purge authority");}};verificationLimits[key]=0;refused(()=>accountErasureStorage(repo.objects.storageRoot(),options),"accountability",bound);Object.assign(verificationLimits,limits);assert.equal(accountErasureStorage(repo.objects.storageRoot(),options).accountable,true);
});

test("accountability retry exhaustion names the unstable namespace and issues no certificate",async()=>{
 const {repo}=await fixture();const path=repo.objects.inventory()[0].path;const original=readFileSync(path);let offset=0;
 accountabilityBoundary.visit=step=>{if(step==="file-check") {writeFileSync(path,Buffer.concat([original,Buffer.alloc(++offset)]));}};
 refused(()=>accountErasureStorage(repo.objects.storageRoot(),{forbiddenIds:new Set(),forbiddenPayloads:new Set()}),"accountability","storage_attempts");accountabilityBoundary.visit=()=>{};writeFileSync(path,original);assert.equal(accountErasureStorage(repo.objects.storageRoot(),{forbiddenIds:new Set(),forbiddenPayloads:new Set()}).accountable,true);
});

test("erasure wall-clock exhaustion preserves selected data and creates no terminal denial",async()=>{
 const {repo}=await fixture();repo.setAuthority("fixture","read-fixture","erase-fixture");const entry=repo.readIndex()[0];verificationLimits.erasureMs=0;refused(()=>repo.obliterate(entry.fileId!,"erase-fixture","incident",new Date(1)),"erasure","time_ms");assert.equal(repo.objects.denials().length,0);assert.ok(existsSync(join(repo.root,"asset")));assert.ok(repo.objects.has(entry.id));
});

for(const [key,bound] of [["depth","decode_depth"],["contexts","decode_contexts"],["streams","decode_streams"],["wordBytes","base64_word_bytes"]] as const)test(`representation scanner ${bound} exhaustion never returns a no-copy certificate`,()=>{
 const patterns=[fingerprint(Buffer.from("selected payload signature"))];erasureScanLimits[key]=0;refused(()=>inspectErasureRepresentation(deflateSync(Buffer.from("ordinary text")),patterns),"erasure",bound);
});

test("representation decoders refuse depth, byte, malformed frame, checksum and incomplete-stream boundaries",()=>{
 const noMatch=()=>false;
 refused(()=>inspectRepresentations(Buffer.from("YWJjZA=="),noMatch,0),"representations","decode_depth");
 refused(()=>inspectRepresentations(deflateSync(Buffer.alloc(100_000,0)),noMatch,1,1),"representations","decoded_bytes");
 refused(()=>inspectRepresentations(Buffer.from("blob 3\0x"),noMatch),"representations","decode_error");
 refused(()=>inspectErasureRepresentation(Buffer.from([0x78,0x9c,0x07]),[fingerprint(Buffer.from("absent-selected"))]),"erasure","decode_error");
 const encoded=deflateSync(Buffer.from("ordinary representation"));const invalid=Buffer.from(encoded);invalid[invalid.length-1]^=1;
 refused(()=>inspectRepresentations(invalid,noMatch),"representations","decode_error");
 refused(()=>inspectErasureRepresentation(invalid,[fingerprint(Buffer.from("absent-selected"))]),"erasure","decode_error");
 refused(()=>inspectErasureRepresentation(encoded.subarray(0,-1),[fingerprint(Buffer.from("absent-selected"))]),"erasure","incomplete_stream");
 erasureScanLimits.minimum=0;erasureScanLimits.ratio=0;refused(()=>inspectErasureRepresentation(Buffer.from("ordinary"),[fingerprint(Buffer.from("absent-selected"))]),"erasure","decoded_bytes");
});


test("integrity cannot certify an empty result after a corrupt ref was omitted by a display listing",async()=>{
 const {repo}=await fixture();const path=join(repo.controlDirectory,"refs/heads/main");const original=readFileSync(path);writeFileSync(path,"truncated ref");assert.deepEqual(repo.refs.list("refs/heads/"),[]);refused(()=>repo.verify(),"integrity","ref_decode");writeFileSync(path,original);assert.ok(repo.verify().verified>0);
});


test("integrity reference I/O, special leaves and disappearing observed directories cannot look like empty history",async()=>{
 const {repo}=await fixture();const refs=join(repo.controlDirectory,"refs/heads");const head=join(refs,"main");const saved=`${head}.saved`;renameSync(head,saved);symlinkSync(saved,head);refused(()=>repo.verify(),"integrity","ref_type");rmSync(head);renameSync(saved,head);
 renameSync(refs,`${refs}.saved`);writeFileSync(refs,"not a directory");refused(()=>repo.verify(),"integrity","ref_io");rmSync(refs);renameSync(`${refs}.saved`,refs);
 const read=fs.readFileSync;mock.method(fs,"readFileSync",(...args:Parameters<typeof fs.readFileSync>)=>{if(args[0]===head)throw Object.assign(new Error("injected reference I/O"),{code:"EACCES"});return Reflect.apply(read,fs,args);});syncBuiltinESMExports();refused(()=>repo.verify(),"integrity","ref_io");mock.restoreAll();syncBuiltinESMExports();
 const nested=join(refs,"nested");mkdirSync(nested);const readdir=fs.readdirSync;mock.method(fs,"readdirSync",(...args:Parameters<typeof fs.readdirSync>)=>{if(args[0]===nested)rmSync(nested,{recursive:true});return Reflect.apply(readdir,fs,args);});syncBuiltinESMExports();refused(()=>repo.verify(),"integrity","ref_io");mock.restoreAll();syncBuiltinESMExports();assert.ok(repo.verify().verified>0);
});

test("partial history grants scoped publication metadata but never a complete integrity certificate",async()=>{
 const {repo}=await fixture();const entry=repo.readIndex()[0];const partial={shallow:[],promised:[entry.id]};const path=repo.objects.inventory().find(item=>item.id===entry.id)!.path;rmSync(path);const head=repo.refs.resolveHead()!;
 const report=inspectClosure(repo.objects,[head],[],[],false,[],undefined,partial);assert.equal(report.verified,0);assert.equal(report.verification.status,"unverified");assert.equal(report.verification.bound,"partial_history");assert.deepEqual(report.missing,[]);assert.ok(requireClosure(repo.objects,[head],[],[],[],partial).commits.has(head));
 verificationLimits.integrityObjects=0;refused(()=>requireClosure(repo.objects,[head],[],[],[],partial),"integrity","reference_count");
});

test("integrity checks its deadline after the final read and never hides an operational clock fault",async()=>{
 const {repo}=await fixture();let calls=0;mock.method(performance,"now",()=>++calls===1?0:10_000);verificationLimits.integrityMs=1;
 const report=inspectClosure(repo.objects,[]);assert.equal(report.verification.status,"unverified");assert.equal(report.verification.bound,"time_ms");assert.equal(report.verified,0);mock.restoreAll();Object.assign(verificationLimits,limits);
 calls=0;mock.method(performance,"now",()=>{if(++calls===2)throw new Error("clock unavailable");return 0;});assert.throws(()=>inspectClosure(repo.objects,[repo.refs.resolveHead()!]),/clock unavailable/u);
});

test("reachability checks its final deadline before a dry-run candidate result or deletion intent",async()=>{
 const {repo}=await fixture();const garbage=repo.objects.write("blob",Buffer.from("unrelated collectible"));const read=repo.objects.read;
 mock.method(repo.objects,"read",(...args:Parameters<typeof read>)=>{const value=Reflect.apply(read,repo.objects,args);if(value.type==="blob")verificationLimits.reachabilityMs=0;return value;});
 refused(()=>collectGarbage(repo,false),"reachability","time_ms");assert.ok(repo.objects.has(garbage));assert.equal(inspectDestructions(repo.controlDirectory).pending,0);
});

test("receipt inspection checks its deadline after the last record before returning an overall verdict",async()=>{
 const {repo}=await fixture();prepareDestruction(repo.controlDirectory,"final-clock",[]).finish();let calls=0;mock.method(performance,"now",()=>++calls<3?0:10_000);verificationLimits.receiptMs=1;const report=inspectDestructions(repo.controlDirectory);assert.equal(report.verification.status,"unverified");assert.equal(report.verification.bound,"time_ms");
});


test("native representation verification rejects a directly retained selected payload",()=>{
 const selected=Buffer.from("retained selected byte signature");assert.throws(()=>inspectErasureRepresentation(selected,[fingerprint(selected)]),{code:"erasure_retained_copy",status:"unverified"});
});
