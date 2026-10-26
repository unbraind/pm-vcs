import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Byte-authoritative erasure proof over arbitrary object-store names, representations and interruptions. */
import assert from "node:assert/strict";
import fs, { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, mock, test } from "node:test";
import { deflateSync } from "node:zlib";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { frameObject, OBJECT_TYPES } from "../engine/objects.ts";
import { ErasureStorageRefusal, erasureScanLimits, erasureScanBoundary, fingerprint, fingerprintJournal, matchesFingerprints, type ErasureFingerprint, readFingerprints, scanErasureStorage } from "../engine/erasure-scan.ts";
import { objectFiles } from "../engine/object-files.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); erasureScanBoundary.visit = () => {}; erasureScanLimits.minimum=16*1024*1024; erasureScanLimits.ratio=1032*6; erasureScanLimits.depth=6; erasureScanLimits.streams=32; erasureScanLimits.contexts=512; erasureScanLimits.wordBytes=16*1024*1024; objectFiles.opened=()=>{}; for (const dir of temporary.splice(0)) dir.cleanup(); });
let random = 314159;
/** Deterministic randomized corpus is reproducible in Node and Bun release gates. */
function number(): number { random = (Math.imul(random,1664525)+1013904223) >>> 0; return random; }
/** Make real SDK tracker state outside Git, without importing any user or fleet data. */
async function fixture(chosen?: Buffer) {
  const dir = makeTempDir(); temporary.push(dir);
  await new PmClient({cwd:dir.root,pmRoot:join(dir.root,".agents/pm"),noExtensions:true}).init("erasure-storage",{defaults:true,author:"fixture"});
  const repo = Repository.init(dir.root); repo.setAuthority("fixture","read-fixture","erase-fixture");
  let bytes: Buffer = Buffer.alloc(48+number()%96); for (let i=0;i<bytes.length;i++) bytes[i] = number() >>> 24;
  if(number()%3===0) bytes=Buffer.from(`compressible-selected-${number()}-`.repeat(23));
  if(chosen!==undefined) bytes=chosen;
  writeFileSync(join(dir.root,"asset"),bytes); repo.stage(["asset"]);
  const item = repo.readIndex()[0]; return {dir,repo,bytes,id:item.id,fileId:item.fileId!};
}
/** Place arbitrary storage without changing generation markers or acquiring an engine lease. */
function place(root: string, path: string, bytes: Buffer): string { const file=join(root,path); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,bytes); return file; }

test("copied foreign backup.pack blocks erasure without deleting the foreign copy or publishing success", async () => {
  const f=await fixture(); f.repo.objects.compact(); const pack=f.repo.objects.inventory().find((entry)=>entry.id===f.id)!;
  const backup=join(dirname(pack.path),"backup.pack"); copyFileSync(pack.path,backup); const original=readFileSync(backup);
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),(error:unknown)=>error instanceof ErasureStorageRefusal && error.code==="unverifiable" && error.fileClass==="pack-storage" && !error.message.includes(f.bytes.toString()));
  assert.deepEqual(readFileSync(backup),original); assert.equal(f.repo.objects.denials().length,0);
  rmSync(backup); const receipt=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)); assert.equal(receipt.fileId,f.fileId);
});

test("random foreign stores refuse regardless of diagnostic payload hits", async (t) => {
  let cases=0;
  const paths=["backup.pack","packs/copy.bin","aa/renamed.data","temporary/job/partial.tmp","packs/foreign/deep/member","other/cache/record"];
  for (let encoding=0;encoding<14;encoding++) for (const path of paths) for (const retained of [false,true]) {
    const f=await fixture(); const frame=frameObject("blob",f.bytes); const root=f.repo.objects.storageRoot();
    let encoded:Buffer;
    if (encoding===0) encoded=f.bytes;
    else if (encoding===1) encoded=Buffer.from(f.bytes.toString("base64"));
    else if (encoding<5) encoded=deflateSync(frame,{level:[1,6,9][encoding-2]});
    else {
      f.repo.objects.compact(); const entry=f.repo.objects.inventory().find((entry)=>entry.id===f.id)!; const pack=readFileSync(entry.path);
      const slice=pack.subarray(entry.packed!.offset,entry.packed!.offset+entry.packed!.length);
      encoded=encoding===5?pack:encoding===6?pack.subarray(0,pack.length-1):encoding===7?slice:encoding===8?slice.subarray(0,slice.length-3):Buffer.from(slice);
      if(encoding===9) encoded[encoded.length-1]^=1;
      if(encoding===10) encoded=slice.subarray(2,-4);
      if(encoding===11) encoded=deflateSync(frame,{level:1}).subarray(2,-4);
      if(encoding>=12) encoded=deflateSync(frameObject(encoding===12?"record":"link",f.bytes),{level:9}).subarray(2,-4);
    }
    if(!retained) encoded=Buffer.from(`unrelated-${number()}-clean-storage`);
    const offset=cases%3===0?65_520:number()%129;
    const stored=Buffer.concat([Buffer.alloc(offset,0xa7),encoded,Buffer.alloc(number()%37,0x98)]);
    const foreign=place(root,path,stored);
    assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"},`${encoding}/${path}/${retained}`);
    assert.equal(f.repo.objects.denials().length,0);assert.deepEqual(readFileSync(foreign),stored);
    rmSync(foreign);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
    cases++;
  }
  assert.equal(cases,168); t.diagnostic("168 randomized non-git stores: 14 encodings x 6 locations x retained/clean; random offsets include scanner chunk crossings");
});

test("a post-deletion foreign copy leaves denial pending and native accountability rejects every retry", async () => {
  const f=await fixture(); const ghost=join(f.repo.objects.storageRoot(),"packs/backup.pack"); let injected=false;
  erasureScanBoundary.visit=(step)=>{if(step==="object-deleted"&&!injected){injected=true;place(f.repo.objects.storageRoot(),"packs/backup.pack",Buffer.concat([Buffer.alloc(19,7),f.bytes]));}};
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"}); erasureScanBoundary.visit=()=>{};
  const denial=f.repo.objects.denials()[0]; assert.ok(denial.pending); assert.equal(existsSync(join(f.repo.objects.storageRoot(),f.id.slice(0,2),f.id.slice(2))),false);
  const proof=readFileSync(join(f.repo.controlDirectory,"erasure-verification.json")); assert.equal(proof.includes(f.bytes),false); assert.equal(proof.includes(Buffer.from(f.bytes.toString("base64"))),false);
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});
  rmSync(ghost); const receipt=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)); assert.equal(receipt.tombstone,denial.id); assert.equal(f.repo.objects.denials()[0].pending,false);
  const again=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)); assert.equal(again.tombstone,receipt.tombstone);
  assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);
});

test("SIGKILL at EVERY erasure proof, scan and publication boundary converges without duplicate receipts", async(t)=>{
  const probe=await fixture(); const steps:string[]=[]; erasureScanBoundary.visit=(step)=>steps.push(step);
  probe.repo.obliterate(probe.fileId,"erase-fixture","incident",new Date(1)); erasureScanBoundary.visit=()=>{};
  for(let ordinal=1;ordinal<=steps.length;ordinal++) {
    const f=await fixture();
    const child=spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/erasure-scan-worker.ts"),f.repo.root,f.fileId,String(ordinal)],{env:{...testEnvironment(),...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.dir.root)},encoding:"utf8",timeout:30_000});
    assert.equal(child.signal,"SIGKILL",`${ordinal}/${steps[ordinal-1]}: ${child.stderr}`);
    f.repo.objects.recoverWriterLock(); const receipt=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
    assert.equal(f.repo.objects.denials()[0].pending,false); assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(f.repo.controlDirectory,"erasure-verification.json"),"utf8")).records).length,1);
    assert.equal(receipt.fileId,f.fileId);
  }
  t.diagnostic(`${steps.length} SIGKILL boundaries: ${[...new Set(steps)].join(", ")}`);
});

test("fingerprint windows, proof validation, foreign classes and native scanner faults fail safely", async()=>{
  const f=await fixture(); const a=Buffer.from("matching-window"), b=Buffer.from("window"); const patterns=[fingerprint(a),fingerprint(b),fingerprint(a)];
  assert.ok(matchesFingerprints(Buffer.from("padding-matching-window-suffix"),patterns)); assert.equal(matchesFingerprints(Buffer.from("clean"),patterns),false); assert.equal(matchesFingerprints(Buffer.from("clean"),[]),false);
  for(const value of [null,[],{bad:[]},{[f.id]:[null]},{[f.id]:[{length:0,rolling:0,digest:f.id}]},{[f.id]:[{length:2,rolling:-1,digest:f.id}]},{[f.id]:[{length:2,rolling:0,digest:"bad"}]}]) {
    const journal = value===null||Array.isArray(value)?value:fingerprintJournal(value as Record<string,ErasureFingerprint[]>);
    assert.throws(()=>readFingerprints(journal),{code:"unsupported_erasure_storage"});
  }
  assert.deepEqual(readFingerprints(fingerprintJournal({})),{});
  for(const value of [Buffer.from([255]),Buffer.from("four")]) {const proof=fingerprint(value);assert.equal(proof.rolling,0);assert.ok(matchesFingerprints(Buffer.concat([Buffer.from("prefix"),value,Buffer.from("suffix")]),[proof]));}
  const root=join(f.dir.root,"scan"); place(root,"temporary/clean.tmp",Buffer.from("clean"));
  const report=scanErasureStorage(root,patterns); assert.equal(report.foreign,1); assert.equal(report.classes["temporary-storage"],1);
  const before=objectFiles.active.size; const read=fs.readSync;
  mock.method(fs,"readSync",()=>0);syncBuiltinESMExports();assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"});mock.restoreAll();syncBuiltinESMExports();assert.equal(objectFiles.active.size,before);
  let changed=false;erasureScanBoundary.visit=(step)=>{if(step==="file-chunk"&&!changed){changed=true;writeFileSync(join(root,"temporary/clean.tmp"),"changed-and-longer");}};
  assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"}); erasureScanBoundary.visit=()=>{};
  assert.equal(typeof read,"function");assert.equal(readdirSync(root).length,1);
});


test("scanner covers every regular class and refuses unreadable, aliased, changing or unbounded proof inputs",async()=>{
  const f=await fixture(); const root=join(f.dir.root,"physical");const patterns=[fingerprint(Buffer.from("absent-selected-value"))];
  place(root,"aa/"+"a".repeat(62),Buffer.from("ordinary"));
  place(root,"packs/"+"b".repeat(64)+".pack",Buffer.alloc(0));
  place(root,"packs/foreign/clean",Buffer.from("unrelated"));
  place(root,"other/deep/clean",Buffer.from("unrelated"));
  place(root,"root-copy",Buffer.from("unrelated"));
  const report=scanErasureStorage(root,patterns); assert.equal(report.files,5);assert.equal(Object.keys(report.classes).length,4);
  const plain=place(root,"other/zlib",Buffer.from([0x78,0x9c]));assert.equal(scanErasureStorage(root,patterns).files,6);
  writeFileSync(plain,deflateSync(Buffer.alloc(60_000,105)));assert.equal(scanErasureStorage(root,patterns).files,6);
  erasureScanLimits.minimum=0; erasureScanLimits.ratio=0;
  assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"});erasureScanLimits.minimum=16*1024*1024;erasureScanLimits.ratio=1032*6;
  const target=place(f.dir.root,"not-a-directory",Buffer.from("outside"));assert.throws(()=>scanErasureStorage(target,patterns),{code:"unsupported_erasure_storage"});
  fs.symlinkSync(target,join(root,"alias"));assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"});rmSync(join(root,"alias"));
  const stat=fs.fstatSync;
  for(const field of ["dev","ino","size","mtimeNs","not-file","oversized"]) {
    let calls=0;
    mock.method(fs,"fstatSync",(...args:Parameters<typeof fs.fstatSync>)=>{
      const value=stat(...args) as fs.BigIntStats;calls++;
      if(field==="not-file")return Object.assign(Object.create(value) as fs.BigIntStats,{isFile:()=>false});
      if(field==="oversized")return Object.assign(Object.create(value) as fs.BigIntStats,{size:BigInt(Number.MAX_SAFE_INTEGER)+1n});
      return calls===2?Object.assign(Object.create(value) as fs.BigIntStats,{[field]:value[field as "dev"|"ino"|"size"|"mtimeNs"]+1n}):value;
    });syncBuiltinESMExports();assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"});mock.restoreAll();syncBuiltinESMExports();
  }
  const wrong={...fingerprint(Buffer.from("candidate")),digest:f.id};assert.equal(matchesFingerprints(Buffer.from("candidate"),[wrong]),false);
  assert.equal(objectFiles.active.size,0);
});


test("scanner refuses native open/read failures and namespace arrivals without leaking owners or content",async()=>{
  const f=await fixture(); const root=join(f.dir.root,"io");place(root,"data",Buffer.from("ordinary"));const patterns=[fingerprint(f.bytes)];
  for(const method of ["openSync","readSync"] as const) {
    mock.method(fs,method,()=>{throw Object.assign(new Error("private file contents must not escape"),{code:"EACCES"});});syncBuiltinESMExports();
    assert.throws(()=>scanErasureStorage(root,patterns),(error:unknown)=>error instanceof ErasureStorageRefusal && error.fileClass==="object-root" && !error.message.includes("private file contents"));
    mock.restoreAll();syncBuiltinESMExports();assert.equal(objectFiles.active.size,0);
  }
  let once=false;erasureScanBoundary.visit=(step)=>{if(step==="file-verified"&&!once){once=true;place(root,"new-copy",f.bytes);}};
  assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"});erasureScanBoundary.visit=()=>{};
  assert.throws(()=>scanErasureStorage(root,patterns),{code:"erasure_retained_copy"});
});


test("embedded compressed payloads are detected without a literal raw hit and full decoded slots drain after input exhaustion",async()=>{
  const selected=Buffer.from("selected-compressed-unique-marker-736294".repeat(64)); const f=await fixture(selected);
  const encoded=deflateSync(frameObject("blob",selected),{level:9});assert.equal(encoded.includes(selected),false);
  const generic=join(f.dir.root,"generic-zlib");place(generic,"arbitrary.data",Buffer.concat([Buffer.alloc(65_535,7),encoded.subarray(0,encoded.length-2)]));
  assert.throws(()=>scanErasureStorage(generic,[fingerprint(selected)]),{code:"erasure_retained_copy"});
  rmSync(join(generic,"arbitrary.data"));
  const path=place(f.repo.objects.storageRoot(),"packs/renamed.data",Buffer.concat([Buffer.alloc(65_535,7),encoded.subarray(0,encoded.length-2)]));
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});
  rmSync(path);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
  const unrelated=Buffer.alloc(52_854);for(let i=0;i<unrelated.length;i++)unrelated[i]=97+i%9;
  const root=join(f.dir.root,"compressed-slots");place(root,"unrelated",deflateSync(unrelated,{level:8}));
  assert.equal(scanErasureStorage(root,[fingerprint(selected)]).files,1);
});

test("SIGKILL at every native proof/denial write step resumes with retained foreign temporaries and one receipt",async(t)=>{
  const probe=await fixture();
  /** Use a real child so a crash cannot run JavaScript cleanup or release its writer lease. */
  const run=(f:Awaited<ReturnType<typeof fixture>>,ordinal:number)=>spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/erasure-proof-crash.ts"),f.repo.root,f.fileId,String(ordinal)],{env:{...testEnvironment(),...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.dir.root)},encoding:"utf8",timeout:30_000});
  const listing=run(probe,0);assert.equal(listing.status,0,listing.stderr);const steps=JSON.parse(listing.stdout) as string[];assert.ok(steps.length>=30);
  for(let ordinal=1;ordinal<=steps.length;ordinal++){
    const f=await fixture();const child=run(f,ordinal);assert.equal(child.signal,"SIGKILL",`${ordinal}/${steps[ordinal-1]}: ${child.stderr}`);
    f.repo.objects.recoverWriterLock();const receipt=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
    assert.equal(receipt.fileId,f.fileId);assert.equal(f.repo.objects.denials()[0].pending,false);
    assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);
  }
  t.diagnostic(`${steps.length} native before/after crash cuts across proof and both denial publications`);
});

test("one non-git tracker serializes a competing erasure at EVERY proof/scan/publication boundary and reports peer success truthfully",async(t)=>{
  const f=await fixture();let attempts=0;
  /** Spawn the same real SDK/engine path, never a mocked lease or manufactured tracker. */
  const run=(mode:string)=>spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/erasure-peer.ts"),f.repo.root,f.fileId,mode],{env:{...testEnvironment(),...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.dir.root)},encoding:"utf8",timeout:30_000});
  erasureScanBoundary.visit=()=>{const peer=run("blocked");assert.equal(peer.status,0,peer.stderr);assert.equal(peer.stdout.trim(),"store_locked");attempts++;};
  const own=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));erasureScanBoundary.visit=()=>{};
  assert.equal(attempts,6);const peer=run("complete");assert.equal(peer.status,0,peer.stderr);const receipt=JSON.parse(peer.stdout) as {tombstone:string};assert.equal(receipt.tombstone,own.tombstone);
  assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);assert.equal(objectFiles.active.size,0);
  t.diagnostic(`${attempts} competing transitions on the same non-git tracker, followed by truthful idempotent peer success`);
});


test("missing historic/imported diagnostics never bypass native accountability",async()=>{
  const f=await fixture();f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
  const proofPath=join(f.repo.controlDirectory,"erasure-verification.json");const proof=readFileSync(proofPath);rmSync(proofPath);
  const ghost=place(f.repo.objects.storageRoot(),"packs/foreign-copy",Buffer.concat([Buffer.alloc(31,5),f.bytes]));
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});assert.ok(readFileSync(ghost).includes(f.bytes));
  writeFileSync(proofPath,proof);assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});
  rmSync(ghost);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);
});


test("headerless native compressed member copies block erasure",async()=>{
  const selected=Buffer.from("headerless-compressed-marker-739168".repeat(64));const f=await fixture(selected);f.repo.objects.compact();
  const entry=f.repo.objects.inventory().find((entry)=>entry.id===f.id)!;const pack=readFileSync(entry.path);
  const body=pack.subarray(entry.packed!.offset+2,entry.packed!.offset+entry.packed!.length-4);assert.equal(body.includes(selected),false);
  place(f.repo.objects.storageRoot(),"temporary/copied-body",Buffer.concat([Buffer.alloc(17,7),body]));
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});assert.equal(f.repo.objects.denials().length,0);
});


test("physical proof includes dormant object directories in every registered instance",async()=>{
  const f=await fixture();f.repo.commit({message:"selected",author:{name:"Fixture",email:"fixture@example.invalid",timestamp:1,timezoneOffsetMinutes:0}},new Date(1));
  const instance=makeTempDir();temporary.push(instance);f.repo.linkInstance("secondary",instance.root);
  const local=join(Repository.open(instance.root).controlDirectory,"objects");
  const ghost=place(local,"packs/backup.pack",deflateSync(frameObject("blob",f.bytes)));
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(2)),{code:"unverifiable"});assert.equal(f.repo.objects.denials().length,0);
  place(f.repo.objects.storageRoot(),"packs/active-cache",Buffer.from("harmless active class overlap"));
  writeFileSync(ghost,"harmless foreign instance cache");place(local,"packs/"+"f".repeat(64)+".pack",Buffer.from("harmless inactive native-looking record"));assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(2)),{code:"unverifiable"});const receipt=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(2),{purgeUnaccounted:true});
  assert.equal(receipt.purge.deleted,3);assert.equal(receipt.storage.foreign,0);assert.equal(existsSync(ghost),false);assert.equal(existsSync(join(instance.root,"asset")),false);
});


test("type-independent erasure catches retyped native bodies with stripped wrappers",async()=>{
  const selected=Buffer.from("selected-type-independent-private-marker-389162".repeat(64));const f=await fixture(selected);
  const encoded=deflateSync(frameObject("record",selected),{level:9}).subarray(2,-4);assert.equal(encoded.includes(selected),false);
  const path=place(f.repo.objects.storageRoot(),"packs/foreign-copy",encoded);
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});assert.equal(f.repo.objects.denials().length,0);assert.deepEqual(readFileSync(path),encoded);
});


test("every native object kind and compression level remains denied after wrapper stripping",async(t)=>{
  const selected=Buffer.from("all-kind-native-compressed-marker-681429".repeat(64));const f=await fixture(selected);let cases=0;
  const path=join(f.repo.objects.storageRoot(),"packs/all-kind-copy");mkdirSync(dirname(path),{recursive:true});
  for(const kind of OBJECT_TYPES)for(const level of [1,6,9]){
    const body=deflateSync(frameObject(kind,selected),{level}).subarray(2,-4);writeFileSync(path,body);
    assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"},`${kind}/${level}`);
    assert.deepEqual(readFileSync(path),body);assert.equal(f.repo.objects.denials().length,0);cases++;
  }
  rmSync(path);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));assert.equal(cases,27);t.diagnostic(`${OBJECT_TYPES.length} frame kinds x three native compression levels = ${cases} wrapper-stripped cases`);
});


test("corrupt fingerprint journal cannot hide a retained raw copy after original bytes disappear",async()=>{
  const selected=Buffer.from("selected-proof-corruption-private-marker-348719".repeat(64));const f=await fixture(selected);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
  const path=join(f.repo.controlDirectory,"erasure-verification.json");const saved=readFileSync(path);const journal=JSON.parse(saved.toString()) as {records:Record<string,ErasureFingerprint[]>};
  const id=f.repo.objects.denials()[0].id;const patterns=journal.records[id];const original=fingerprint(selected);const index=patterns.findIndex((item)=>item.length===original.length&&item.digest===original.digest);assert.ok(index>=0);
  patterns[index]={...patterns[index],rolling:(patterns[index].rolling^1)>>>0};writeFileSync(path,JSON.stringify(journal));
  const foreign=place(f.repo.objects.storageRoot(),"packs/foreign-copy",Buffer.concat([Buffer.alloc(19,7),selected]));
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),(error:unknown)=>error instanceof ErasureStorageRefusal&&error.code==="unverifiable");assert.ok(readFileSync(foreign).includes(selected));
  writeFileSync(path,saved);assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});rmSync(foreign);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
  assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);
});

test("journal rejects unknown versions, checksum changes and malformed signature records",async()=>{
  const f=await fixture();const base=fingerprintJournal({[f.id]:[fingerprint(f.bytes)]});
  for(const patch of [{format:"foreign"},{records:null},{records:[]},{records:7},{checksum:7},{checksum:"bad"},{checksum:"0".repeat(64)}]) assert.throws(()=>readFingerprints({...base,...patch}),{code:"unsupported_erasure_storage"});
  for(const entry of [[],7,{length:null,rolling:0,digest:f.id},{length:2,rolling:1.5,digest:f.id},{length:2,rolling:0x1_0000_0000,digest:f.id},{length:2,rolling:0,digest:7},{...fingerprint(f.bytes),foreign:true}]) {
    const records={[f.id]:[entry]} as unknown as Record<string,ErasureFingerprint[]>;
    assert.throws(()=>readFingerprints(fingerprintJournal(records)),{code:"unsupported_erasure_storage"});
  }
  assert.throws(()=>readFingerprints(7),{code:"unsupported_erasure_storage"});
});

test("nested native encodings remain detectable across offsets, base64 alignments and truncated checksums",async(t)=>{
  const selected=Buffer.from("recursive-native-private-marker-527193".repeat(32));const f=await fixture(selected);
  f.repo.objects.compact();const entry=f.repo.objects.inventory().find((item)=>item.id===f.id)!;const packed=readFileSync(entry.path);
  const compressed=deflateSync(frameObject("record",selected),{level:9});const body=compressed.subarray(2,-4);
  const base64=(bytes:Buffer)=>Buffer.from(bytes.toString("base64"));
  let six=body;for(let depth=0;depth<6;depth++)six=base64(six);
  const representations=[base64(body),base64(compressed),base64(packed),deflateSync(base64(body)),base64(deflateSync(base64(body))),base64(base64(body)),base64(compressed.subarray(0,-2)),base64(Buffer.concat([compressed.subarray(0,-1),Buffer.from([compressed.at(-1)!^1])])),six];
  f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));let cases=0;
  for(const encoded of representations)for(let prefix=0;prefix<4;prefix++)for(const crossing of [false,true]){
    const path=place(f.repo.objects.storageRoot(),"foreign/nested-copy",Buffer.concat([Buffer.alloc(crossing?65_535:7,0xa7),Buffer.from("A".repeat(prefix)),encoded,Buffer.from("BBB!suffix")]));
    assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"},`${cases}/${prefix}/${crossing}`);
    rmSync(path);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));cases++;
  }
  assert.equal(cases,72);assert.equal(objectFiles.active.size,0);t.diagnostic("72 nested codec cases: 9 representations x 4 alignments x 2 offsets; each followed by a clean successful retry");
});

test("recursive scanner refuses unsupported inspection depth and bounded codec resources without a false success",async()=>{
  const f=await fixture();const root=join(f.dir.root,"bounded-codecs");const path=place(root,"data",Buffer.from("ordinary"));const patterns=[fingerprint(f.bytes)];
  const encoded=Buffer.from(deflateSync(Buffer.from("ordinary bounded representation")).toString("base64"));
  for(const limit of ["depth","contexts","streams","wordBytes"] as const){
    writeFileSync(path,limit==="streams"?deflateSync(Buffer.from("ordinary")):encoded);
    const prior=erasureScanLimits[limit];erasureScanLimits[limit]=0;
    assert.throws(()=>scanErasureStorage(root,patterns),{code:"uninspectable_payload"},limit);erasureScanLimits[limit]=prior;
    assert.equal(objectFiles.active.size,0);
  }
  let deep=Buffer.from("ordinary very deeply wrapped representation");for(let depth=0;depth<8;depth++)deep=Buffer.from(deep.toString("base64"));
  writeFileSync(path,deep);assert.throws(()=>scanErasureStorage(root,patterns),{code:"uninspectable_payload"});
});

test("streaming scanner preserves nested state across compressed input slots and closes active dictionaries on faults",async()=>{
  const f=await fixture();const root=join(f.dir.root,"streaming-codecs");const selected=Buffer.from("compressed-slot-selected-marker-937216".repeat(64));
  const noise=Buffer.alloc(100_000);for(let i=0;i<noise.length;i++)noise[i]=number()>>>24;
  const compressed=deflateSync(Buffer.concat([noise,selected]));assert.ok(compressed.length>65_536);assert.equal(compressed.includes(selected),false);
  const path=place(root,"data",compressed);assert.throws(()=>scanErasureStorage(root,[fingerprint(selected)]),{code:"erasure_retained_copy"});
  writeFileSync(path,Buffer.from(compressed.toString("base64")));assert.throws(()=>scanErasureStorage(root,[fingerprint(selected)]),{code:"erasure_retained_copy"});
  writeFileSync(path,compressed);erasureScanBoundary.visit=(step)=>{if(step==="file-chunk")throw new Error("injected scan interruption");};
  assert.throws(()=>scanErasureStorage(root,[fingerprint(selected)]),{code:"unsupported_erasure_storage"});erasureScanBoundary.visit=()=>{};assert.equal(objectFiles.active.size,0);
  // No terminal byte window exists until the final unpadded base64 word is flushed at EOF.
  writeFileSync(path,Buffer.from(deflateSync(selected).toString("base64").replace(/=+$/,"")));
  assert.throws(()=>scanErasureStorage(root,[fingerprint(selected)]),{code:"erasure_retained_copy"});
});


test("suffix filters share width while full SHA proofs distinguish lengths and content",()=>{
  const long=Buffer.from("long-selected-suffix");const short=Buffer.from("d-suffix");const patterns=[fingerprint(long),fingerprint(short),fingerprint(long)];
  assert.equal(patterns[0].rolling,patterns[1].rolling);
  assert.equal(matchesFingerprints(short,[patterns[0]]),false);
  assert.ok(matchesFingerprints(Buffer.concat([Buffer.from("padding"),long]),patterns));
  assert.ok(matchesFingerprints(short,patterns));
  assert.equal(matchesFingerprints(Buffer.from("long-modified-suffix"),[patterns[0]]),false);
});

test("strict physical inventory refuses unknown names while compaction preserves them with reasons",async()=>{
  const f=await fixture();const root=f.repo.objects.storageRoot();const foreign=place(root,"foreign-record",Buffer.from("clean foreign bytes"));
  assert.throws(()=>f.repo.objects.inventory(),{code:"unsupported_erasure_storage"});
  assert.ok(f.repo.objects.compact().skippedCount>0);assert.ok(existsSync(foreign));rmSync(foreign);
  const leaf=place(root,"aa/foreign-record",Buffer.from("clean foreign bytes"));
  assert.throws(()=>f.repo.objects.inventory(),{code:"unsupported_erasure_storage"});
  assert.ok(f.repo.objects.compact().skippedCount>0);assert.ok(existsSync(leaf));
});

test("scanner filter work stays bounded independently of selected representation lengths",()=>{
  const patterns=Array.from({length:40},(_,index)=>fingerprint(Buffer.alloc(100+index,65+index%10)));const bytes=Buffer.alloc(1024,255);
  const imul=Math.imul;let calls=0;mock.method(Math,"imul",(a:number,b:number)=>{calls++;return imul(a,b);});
  assert.equal(matchesFingerprints(bytes,patterns),false);
  assert.ok(calls<=bytes.length*3+128,`rolling filter performed ${calls} operations for ${bytes.length} bytes and ${patterns.length} lengths`);
});

test("constant byte runs skip only equivalent windows and retain cross-chunk matches",async()=>{
  const patterns=Array.from({length:40},(_,index)=>fingerprint(Buffer.alloc(100+index,65+index%10)));const bytes=Buffer.alloc(4096,255);
  const imul=Math.imul;let calls=0;mock.method(Math,"imul",(a:number,b:number)=>{calls++;return imul(a,b);});
  assert.equal(matchesFingerprints(bytes,patterns),false);assert.ok(calls<700,`${calls} operations over one constant run`);mock.restoreAll();
  assert.ok(matchesFingerprints(bytes,[fingerprint(Buffer.alloc(139,255))]));
  const f=await fixture();const root=join(f.dir.root,"constant-runs");const pattern=Buffer.from([255,255,255,254]);const path=place(root,"data",bytes);
  assert.equal(scanErasureStorage(root,[fingerprint(pattern)]).files,1);
  for(const boundary of [65_536,131_072]){
    writeFileSync(path,Buffer.concat([Buffer.alloc(boundary,255),Buffer.from([254])]));
    assert.throws(()=>scanErasureStorage(root,[fingerprint(pattern)]),{code:"erasure_retained_copy"});
  }
});
