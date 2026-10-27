import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Accountable storage, exact purge receipts and namespace replacement regressions on real non-git trackers. */
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import fs, { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import crypto, { createHash } from "node:crypto";
import { deflateSync, inflateSync, inflateRawSync, constants as zlibConstants } from "node:zlib";
import { afterEach, test, mock } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { ObjectStore, ObjectStoreError, frameObject, hashObject } from "../engine/objects.ts";
import { accountErasureStorage, accountabilityBoundary, erasurePurge, planErasureStorage, ACCOUNTABILITY_ATTEMPTS } from "../engine/erasure-accountability.ts";
import { erasureScanBoundary, erasureScanLimits, createErasureInspection, inspectErasureFile, fingerprint } from "../engine/erasure-scan.ts";
import { VerificationRefusal, verificationLimits } from "../engine/object-error.ts";
import { objectFiles } from "../engine/object-files.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
const temps: ReturnType<typeof makeTempDir>[]=[];
afterEach(()=>{mock.restoreAll();syncBuiltinESMExports();accountabilityBoundary.visit=()=>{};erasureScanBoundary.visit=()=>{};for(const dir of temps.splice(0))dir.cleanup();assert.equal(objectFiles.active.size,0);});
/** Initialize through the real host SDK outside any Git repository. */
async function fixture(bytes=Buffer.from("ordinary retained live data")){
 const dir=makeTempDir();temps.push(dir);await new PmClient({cwd:dir.root,pmRoot:join(dir.root,".agents/pm"),noExtensions:true}).init("accountable",{defaults:true,author:"fixture"});
 const repo=Repository.init(dir.root);repo.setAuthority("fixture","read-fixture","erase-fixture");writeFileSync(join(dir.root,"asset"),bytes);repo.stage(["asset"]);return{dir,repo,entry:repo.readIndex()[0]!,bytes};
}
/** Only the explicitly chosen disposable leaf is created or replaced. */
function place(root:string,name:string,bytes:Buffer):string{const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);return path;}
/** Independent raw namespace writer leaves the package generation and lock untouched. */
function replace(path:string,bytes:Buffer,scratch:string):void{const temp=join(scratch,"replacement");writeFileSync(temp,bytes);renameSync(temp,path);}
const empty={forbiddenIds:new Set<string>(),forbiddenPayloads:new Set<string>()};

test("verification bounds never certify a native object containing eight recoverable base64 layers",async()=>{
 for(const packed of [false,true]){
  const f=await fixture();let encoded=f.bytes;for(let layer=0;layer<8;layer++)encoded=Buffer.from(encoded.toString("base64"));
  const copy=f.repo.objects.write("blob",encoded);if(packed)f.repo.objects.compact();
  assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)),error=>{assert.ok(error instanceof Error);assert.match(error.message,/unverified.*(?:decode_depth|decode_error|incomplete_stream)/u);return true;});
  assert.equal(f.repo.objects.denials().length,0);assert.deepEqual(f.repo.objects.read(copy).payload,encoded);assert.deepEqual(readFileSync(join(f.repo.root,"asset")),f.bytes);
 }
});

test("fully recoverable one-byte-truncated headerless DEFLATE is unverifiable, with an explicit receipted purge",async()=>{
 let bytes=Buffer.alloc(0);let body=Buffer.alloc(0);
 for(const size of [32,128,1024,4096,65536]){bytes=Buffer.alloc(size,97);const frame=frameObject("blob",bytes);body=deflateSync(frame,{level:9}).subarray(2,-5);if(inflateRawSync(body,{finishFlush:zlibConstants.Z_SYNC_FLUSH}).equals(frame))break;}
 assert.deepEqual(inflateRawSync(body,{finishFlush:zlibConstants.Z_SYNC_FLUSH}),frameObject("blob",bytes));
 const f=await fixture(bytes);const foreign=place(f.repo.objects.storageRoot(),"packs/backup.pack",body);
 assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});assert.ok(existsSync(foreign));assert.equal(f.repo.objects.denials().length,0);
 const receipt=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true});
 assert.equal(receipt.storage.accountable,true);assert.equal(receipt.purge.deleted,1);assert.equal(receipt.purge.files[0].sha256,createHash("sha256").update(body).digest("hex"));assert.equal(existsSync(foreign),false);
 const again=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1));assert.deepEqual(again.purge,receipt.purge);assert.equal(f.repo.operations.read().filter(x=>x.command==="obliterate").length,1);
});

test("property: success iff every file is fully accountable and no accounted identity/payload is erased",async(t)=>{
 const f=await fixture();const root=f.repo.objects.storageRoot();const secret=Buffer.from("selected repetitive private payload 873591".repeat(33));let seed=173;let cases=0;
 const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(let trial=0;trial<8;trial++)for(let mode=0;mode<10;mode++)for(const retained of [false,true]){
  const payload=retained?secret:Buffer.from(`unrelated-${trial}-${next()}`);const id=hashObject("blob",payload);const compressed=deflateSync(frameObject("blob",payload),{level:1+next()%9});let data:Buffer=compressed;let name=`foreign-${cases}`;
  const native=mode===3||mode===4;
  if(mode===0)data=payload;
  if(mode===1)name="aa/renamed.data";
  if([2,4,9].includes(mode)){
   const source=new ObjectStore(join(f.dir.root,`source-${cases}`));source.write("blob",payload);source.compact();const item=source.inventory()[0];data=readFileSync(item.path);name=[4,9].includes(mode)?`packs/${item.path.split(/[\\/]/).at(-1)}`:"packs/backup.pack";
  }
  if([3,5,7,8].includes(mode))name=`${id.slice(0,2)}/${id.slice(2)}`;
  if(mode===5)data=data.subarray(0,data.length-(1+next()%Math.min(8,data.length-1)));
  if(mode===6)data=compressed.subarray(2,-4).subarray(0,-(1+next()%3));
  if(mode===7){data=Buffer.from(data);data[2+next()%(data.length-2)]^=0x80;}
  if(mode===8)data=Buffer.concat([data,Buffer.from([next()%255,17])]);
  if(mode===9){data=Buffer.from(data.subarray(0,data.length-(1+next()%8)));}
  if([0,1,2,6].includes(mode))data=Buffer.concat([Buffer.alloc(1+next()%97,next()%256),data,Buffer.alloc(1+next()%41,next()%256)]);
  const path=place(root,name,data);const forbidden={forbiddenIds:new Set([hashObject("blob",secret)]),forbiddenPayloads:new Set([createHash("sha256").update(secret).digest("hex")])};
  if(native&&!retained)assert.equal(accountErasureStorage(root,forbidden).accountable,true);
  else assert.throws(()=>accountErasureStorage(root,forbidden),{code:native?"erasure_retained_copy":"unverifiable"});
  if(!native){
   const result=f.repo.objects.withWriteLock(()=>{const purge=erasurePurge(f.repo.controlDirectory,cases.toString(16).padStart(32,"0"),[root],true);const report=accountErasureStorage(root,{...forbidden,purge:(file,remove)=>purge.purge(file,()=>{f.repo.objects.markStorageGeneration();remove();})});return{report,receipt:purge.receipt()};});
   assert.equal(result.report.accountable,true);assert.equal(result.receipt.deleted,1);assert.equal(existsSync(path),false);
  }else rmSync(path);
  cases++;
 }
 assert.equal(cases,160);t.diagnostic("160 store states: 10 native/foreign/copied/renamed/truncated/overwritten/trailing-byte forms x 8 seeded trials x payload present/absent; random offsets; explicit purge re-verifies every unaccounted case");
});

test("replacement at EVERY verification boundary retries clean peers and never certifies an erased replacement",async(t)=>{
 let cells=0;
 for(const packed of [false,true])for(const bad of [false,true]){
  const probe=await fixture();if(packed)probe.repo.objects.compact();const path=probe.repo.objects.inventory()[0].path;const original=readFileSync(path);const steps:string[]=[];
  accountabilityBoundary.visit=(step)=>steps.push(step);accountErasureStorage(probe.repo.objects.storageRoot(),empty);accountabilityBoundary.visit=()=>{};
  for(let ordinal=0;ordinal<steps.length;ordinal++){
   writeFileSync(path,original);let visited=0;
   accountabilityBoundary.visit=()=>{if(visited++===ordinal)replace(path,bad?Buffer.from("selected replacement bytes"):original,probe.dir.root);};
   if(bad)assert.throws(()=>accountErasureStorage(probe.repo.objects.storageRoot(),empty),{code:"unverifiable"},`${packed}/${steps[ordinal]}`);
   else assert.equal(accountErasureStorage(probe.repo.objects.storageRoot(),empty).accountable,true);
   accountabilityBoundary.visit=()=>{};cells++;
  }
 }
 assert.equal(cells,32);t.diagnostic("32 boundary cells: 8 verification boundaries x loose/pack x clean/erased replacement");
});

test("final operation rechecks a clean descriptor's replaced pathname before completion",async()=>{
 const f=await fixture(Buffer.from("selected operation payload 517639"));const live=f.repo.objects.write("blob",Buffer.from("retained clean object"));const path=join(f.repo.objects.storageRoot(),live.slice(0,2),live.slice(2));let passes=0;let changed=false;
 accountabilityBoundary.visit=(step,name)=>{if(step==="pass-start")passes++;if(passes===3&&step==="file-opened"&&name===path&&!changed){changed=true;replace(path,f.bytes,f.dir.root);}};
 assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});assert.ok(changed);assert.ok(f.repo.objects.denials()[0].pending);assert.equal(f.repo.operations.read().filter(x=>x.command==="obliterate").length,0);
});

test("perpetual replacement is bounded and every pinned descriptor closes",async()=>{
 const f=await fixture();const path=f.repo.objects.inventory()[0].path;const bytes=readFileSync(path);let opens=0;
 accountabilityBoundary.visit=(step)=>{if(step==="file-opened"){opens++;replace(path,bytes,f.dir.root);}};
 assert.throws(()=>accountErasureStorage(f.repo.objects.storageRoot(),empty),{code:"unverifiable"});assert.equal(opens,ACCOUNTABILITY_ATTEMPTS**2);assert.equal(objectFiles.active.size,0);
});

test("purge plans resume after unlink, preserve peer replacements and bound receipts",async()=>{
 const f=await fixture();const root=f.repo.objects.storageRoot();for(let i=0;i<23;i++)place(root,`foreign-${i}`,Buffer.from(`foreign data ${i}`));let stopped=false;
 accountabilityBoundary.visit=(step)=>{if(step==="purge-deleted"&&!stopped){stopped=true;throw new Error("simulated death after unlink");}};
 assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true}));accountabilityBoundary.visit=()=>{};
 const receipt=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true});assert.equal(receipt.purge.deleted,22);assert.equal(receipt.purge.observedAbsent,1);assert.equal(receipt.purge.files.length,20);assert.equal(receipt.purge.omitted,3);assert.equal(receipt.storage.foreign,0);
 const peer=await fixture();const foreign=place(peer.repo.objects.storageRoot(),"foreign",Buffer.from("unknown"));let once=false;
 accountabilityBoundary.visit=(step)=>{if(step==="purge-planned"&&!once){once=true;rmSync(foreign);}};
 const result=peer.repo.obliterate(peer.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true});assert.equal(result.purge.observedAbsent,1);assert.equal(result.purge.deleted,0);
});

test("complete native framing rejects malformed, trailing, truncated and oversized pack members",async()=>{
 const f=await fixture();const root=f.repo.objects.storageRoot();
 const malformed=[Buffer.from("blob 1\0aa"),Buffer.from("blob 2\0a"),Buffer.from("unknown 1\0a"),Buffer.alloc(80,97),Buffer.from("blob 9007199254740992\0"),Buffer.from("blob 01\0a")];
 for(const frame of malformed){const id=createHash("sha256").update(frame).digest("hex");const path=place(root,`${id.slice(0,2)}/${id.slice(2)}`,deflateSync(frame));assert.throws(()=>accountErasureStorage(root,empty),{code:"unverifiable"});rmSync(path);}
 const payload=Buffer.alloc(16*1024*1024+1,97);const id=hashObject("blob",payload);const compressed=deflateSync(frameObject("blob",payload));
 const index=Buffer.from(JSON.stringify([[id,0,compressed.length,"blob"]]));const header=Buffer.alloc(12);header.write("PMVCSP1\n");header.writeUInt32BE(index.length,8);const pack=Buffer.concat([header,index,compressed]);
 const native=new ObjectStore(join(f.dir.root,"checksum-source"));native.write("blob",Buffer.from("complete checksum fixture"));native.compact();const valid=readFileSync(native.inventory()[0].path);
 const renamed=place(root,`packs/${"0".repeat(64)}.pack`,valid);assert.throws(()=>accountErasureStorage(root,empty),{code:"unverifiable"});rmSync(renamed);
 const path=place(root,`packs/${createHash("sha256").update(pack).digest("hex")}.pack`,pack);assert.throws(()=>accountErasureStorage(root,empty),{code:"unverifiable"});rmSync(path);
});

test("missing, corrupt or bounded fingerprint evidence never issues an erasure certificate",async()=>{
 const f=await fixture();f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1));const journal=join(f.repo.controlDirectory,"erasure-verification.json");const original=readFileSync(journal);rmSync(journal);
 assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)),/unverified.*missing_evidence/u);
 writeFileSync(journal,"foreign diagnostic format");assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)),/unverified.*decode_error/u);assert.equal(readFileSync(journal,"utf8"),"foreign diagnostic format");
 writeFileSync(journal,original);assert.equal(f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)).storage.accountable,true);
 const limited=await fixture();limited.repo.objects.write("blob",Buffer.alloc(100_000,122));const budget={...erasureScanLimits};
 try { erasureScanLimits.minimum=1;erasureScanLimits.ratio=0;assert.throws(()=>limited.repo.obliterate(limited.entry.fileId!,"erase-fixture","incident",new Date(1)),/unverified.*decoded_bytes/u);assert.equal(limited.repo.objects.denials().length,0);assert.deepEqual(readFileSync(join(limited.repo.root,"asset")),limited.bytes); } finally { Object.assign(erasureScanLimits,budget); }
 place(f.repo.objects.storageRoot(),"cache",Buffer.from("unrelated foreign bytes"));assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});
});

test("SIGKILL at EVERY purge journal and unlink boundary converges with one bounded receipt",async(t)=>{
 /** Every case uses an independently initialized SDK tracker and the actual SDK/engine command path. */
 const fresh=async()=>{const f=await fixture();place(f.repo.objects.storageRoot(),"unaccounted-purge",Buffer.from("foreign bytes to purge"));return f;};
 const run=(f:Awaited<ReturnType<typeof fixture>>,ordinal:number)=>spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/erasure-purge-worker.ts"),f.repo.root,f.entry.fileId!,String(ordinal)],{env:{...testEnvironment(),...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.dir.root)},encoding:"utf8",timeout:30_000});
 const probe=await fresh();const listed=run(probe,0);assert.equal(listed.status,0,listed.stderr);const steps=JSON.parse(listed.stdout) as string[];assert.ok(steps.length>=40);
 for(let index=1;index<=steps.length;index++){
  const f=await fresh();const child=run(f,index);assert.equal(child.signal,"SIGKILL",`${index}/${steps[index-1]} ${child.stderr}`);f.repo.objects.recoverWriterLock();
  const result=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true});assert.equal(result.storage.accountable,true);assert.equal(result.purge.deleted+result.purge.observedAbsent,1);assert.equal(result.purge.files.length,1);
  const again=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1));assert.deepEqual(again.purge,result.purge);assert.equal(f.repo.operations.read().filter(x=>x.command==="obliterate").length,1);
 }
 t.diagnostic(`${steps.length} native before/after purge publication, directory barrier and unlink crash cuts`);
});

test("one tracker serializes a competing purger at EVERY accountability boundary and reports peer success",async(t)=>{
 const f=await fixture();place(f.repo.objects.storageRoot(),"unaccounted-purge",Buffer.from("unknown peer fixture"));let attempts=0;
 const run=(mode:string)=>spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/erasure-peer.ts"),f.repo.root,f.entry.fileId!,mode],{env:{...testEnvironment(),...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.dir.root)},encoding:"utf8",timeout:30_000});
 accountabilityBoundary.visit=()=>{const child=run("blocked");assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),"store_locked");attempts++;};
 const receipt=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true});accountabilityBoundary.visit=()=>{};
 const peer=run("complete");assert.equal(peer.status,0,peer.stderr);const result=JSON.parse(peer.stdout) as {tombstone:string;purge:{deleted:number}};assert.equal(result.tombstone,receipt.tombstone);assert.equal(result.purge.deleted,1);assert.equal(f.repo.operations.read().filter(x=>x.command==="obliterate").length,1);assert.ok(attempts>=30);t.diagnostic(`${attempts} real-process competing transitions on one non-git tracker`);
});

test("every truncated prefix and overwritten byte is classified by complete parsing rather than encoding fingerprints",async(t)=>{
 const f=await fixture();const root=f.repo.objects.storageRoot();let cases=0;
 for(const retained of [false,true]){
  const bytes=Buffer.from((retained?"selected-run-195734":"unrelated-run-517934").repeat(64));const id=hashObject("blob",bytes);const frame=frameObject("blob",bytes);const compressed=deflateSync(frame,{level:9});const path=join(root,id.slice(0,2),id.slice(2));
  const options={forbiddenIds:retained?new Set([id]):new Set<string>(),forbiddenPayloads:new Set<string>()};
  for(let cut=1;cut<=compressed.length;cut++){
   place(root,`${id.slice(0,2)}/${id.slice(2)}`,compressed.subarray(0,compressed.length-cut));assert.throws(()=>accountErasureStorage(root,options),{code:"unverifiable"});rmSync(path);cases++;
  }
  for(let index=0;index<compressed.length;index++){
   const mutated=Buffer.from(compressed);mutated[index]^=0x80;let valid=false;
   try {const result=inflateSync(mutated,{info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};valid=result.buffer.equals(frame)&&result.engine.bytesWritten===mutated.length;}catch{}
   place(root,`${id.slice(0,2)}/${id.slice(2)}`,mutated);
   if(valid&&!retained)assert.equal(accountErasureStorage(root,options).accountable,true);
   else assert.throws(()=>accountErasureStorage(root,options),{code:valid?"erasure_retained_copy":"unverifiable"});
   rmSync(path);cases++;
  }
 }
 t.diagnostic(`${cases} exhaustive truncation/overwrite cases, with independent native DEFLATE parsing`);
});

test("purge authorization resumes exactly its planned identity and preserves a repaired native peer",async()=>{
 const f=await fixture();const root=f.repo.objects.storageRoot();const path=place(root,"planned",Buffer.from("unaccounted planned bytes"));const stat=fs.lstatSync(path,{bigint:true});
 f.repo.objects.withWriteLock(()=>{
  const candidate={path,fileClass:"object-root" as const,sha256:createHash("sha256").update(readFileSync(path)).digest("hex"),bytes:Number(stat.size),identity:`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`};
  const unauthorized=erasurePurge(f.repo.controlDirectory,f.entry.fileId!,[root],false);assert.equal(unauthorized.canPurge,false);assert.equal(unauthorized.purge(candidate,()=>{throw new Error("must not remove");}),false);
  const purge=erasurePurge(f.repo.controlDirectory,f.entry.fileId!,[root],true);
  assert.throws(()=>purge.purge(candidate,()=>{throw new Error("interrupted before unlink");}));
  assert.throws(()=>purge.receipt(),{code:"unverifiable"});
 });
 const receipt=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1));assert.equal(receipt.purge.deleted,1);assert.equal(existsSync(path),false);
 const peer=await fixture();const clean=Buffer.from("legitimate repaired peer object");const id=peer.repo.objects.write("blob",clean);const target=join(peer.repo.objects.storageRoot(),id.slice(0,2),id.slice(2));const original=readFileSync(target);writeFileSync(target,"corrupt unaccounted source");let once=false;
 accountabilityBoundary.visit=(step)=>{if(step==="purge-planned"&&!once){once=true;replace(target,original,peer.dir.root);}};
 const result=peer.repo.obliterate(peer.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true});assert.equal(result.purge.deleted,0);assert.equal(result.purge.replaced,1);assert.deepEqual(peer.repo.objects.read(id).payload,clean);
});

test("empty roots, missing roots and namespace arrivals are revalidated as one scope",async()=>{
 const f=await fixture();const root=f.repo.objects.storageRoot();const extra=join(f.dir.root,"missing-objects");assert.equal(accountErasureStorage([],empty).files,0);let once=false;
 accountabilityBoundary.visit=(step)=>{if(step==="pass-check"&&!once){once=true;place(extra,"unknown",Buffer.from("late foreign namespace"));}};
 assert.throws(()=>accountErasureStorage([root,extra],empty),{code:"unverifiable"});accountabilityBoundary.visit=()=>{};rmSync(extra,{recursive:true});
 const path=f.repo.objects.inventory()[0].path;const original=readFileSync(path);let changed=false;
 accountabilityBoundary.visit=(step,name)=>{if(step==="file-verified"&&name===path&&!changed){changed=true;place(root,"new-entry",Buffer.from("foreign arrival"));}};
 assert.throws(()=>accountErasureStorage(root,empty),{code:"unverifiable"});accountabilityBoundary.visit=()=>{};rmSync(join(root,"new-entry"));
 const id=f.repo.objects.write("tree",Buffer.alloc(0));assert.equal(accountErasureStorage(root,{forbiddenIds:new Set(),forbiddenPayloads:new Set([createHash("sha256").update(Buffer.alloc(0)).digest("hex")])}).accountable,true);assert.ok(id);assert.deepEqual(readFileSync(path),original);
 const secret=Buffer.from("typed payload independent of object kind");const other=f.repo.objects.write("record",secret);
 assert.throws(()=>accountErasureStorage(root,{forbiddenIds:new Set([hashObject("blob",secret)]),forbiddenPayloads:new Set([createHash("sha256").update(secret).digest("hex")])}),{code:"erasure_retained_copy"});assert.ok(other);
});

test("I/O errors and unknown purge journals refuse without deleting native files or leaking descriptors",async()=>{
 const f=await fixture();const root=f.repo.objects.storageRoot();const before=f.repo.objects.inventory().map(x=>x.id);const read=fs.readSync;
 const inodes=new Set(f.repo.objects.inventory().map(item=>{const stat=fs.statSync(item.path,{bigint:true});return `${stat.dev}:${stat.ino}`;}));
 mock.method(fs,"readSync",(...args:Parameters<typeof fs.readSync>)=>{const stat=fs.fstatSync(args[0],{bigint:true});if(inodes.has(`${stat.dev}:${stat.ino}`))throw Object.assign(new Error("private contents"),{code:"EIO"});return Reflect.apply(read,fs,args);});syncBuiltinESMExports();
 assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true}),(error:unknown)=>error instanceof Error&&!error.message.includes("private contents"));mock.restoreAll();syncBuiltinESMExports();assert.deepEqual(f.repo.objects.inventory().map(x=>x.id),before);assert.equal(typeof read,"function");assert.equal(objectFiles.active.size,0);
 const path=join(f.repo.controlDirectory,"erasure-purge.json");
 const base={format:"pm-vcs-erasure-purge-1",operations:{}};
 for(const value of [null,[],{}, {...base,foreign:true},{...base,format:"foreign"},{...base,operations:null},{...base,operations:[]},{...base,operations:{bad:[]}}, {...base,operations:{[f.entry.fileId!]:[null]}}]){
  writeFileSync(path,JSON.stringify(value));assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true}),{code:"unverifiable"});assert.equal(readFileSync(path,"utf8"),JSON.stringify(value));
 }
 writeFileSync(path,"not JSON");assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});
});

test("verification faults, aliases and post-hash replacements remain unverifiable without purging peers",async()=>{
 const f=await fixture();const root=f.repo.objects.storageRoot();const native=f.repo.objects.inventory()[0].path;const fstat=fs.fstatSync;const read=fs.readSync;
 for(const fault of ["not-file","oversized","missing"]){
  mock.method(fs,"fstatSync",(...args:Parameters<typeof fs.fstatSync>)=>{if(fault==="missing")throw Object.assign(new Error("gone"),{code:"ENOENT"});const value=fstat(...args) as fs.BigIntStats;return fault==="not-file"?Object.assign(Object.create(value) as fs.BigIntStats,{isFile:()=>false}):Object.assign(Object.create(value) as fs.BigIntStats,{size:BigInt(Number.MAX_SAFE_INTEGER)+1n});});syncBuiltinESMExports();
  assert.throws(()=>accountErasureStorage(root,empty),fault==="oversized"?{code:"unverified",status:"unverified",verifier:"accountability",bound:"file_bytes"}:{code:"unverifiable"});mock.restoreAll();syncBuiltinESMExports();assert.equal(objectFiles.active.size,0);
 }
 let zero=false;mock.method(fs,"readSync",(...args:Parameters<typeof fs.readSync>)=>{if(!zero){zero=true;return 0;}return read(...args);});syncBuiltinESMExports();assert.equal(accountErasureStorage(root,empty).accountable,true);mock.restoreAll();syncBuiltinESMExports();
 const foreign=place(root,"foreign-race",Buffer.from("unknown bytes"));let changed=false;
 mock.method(fs,"readSync",(...args:Parameters<typeof fs.readSync>)=>{const count=read(...args);if(!changed&&fs.fstatSync(args[0]).size===13){changed=true;replace(foreign,Buffer.from("replacement must survive"),f.dir.root);}return count;});syncBuiltinESMExports();
 assert.throws(()=>accountErasureStorage(root,{...empty,purge:()=>false}),{code:"unverifiable"});mock.restoreAll();syncBuiltinESMExports();assert.ok(changed);assert.equal(readFileSync(foreign,"utf8"),"replacement must survive");rmSync(foreign);
 const regular=place(f.dir.root,"regular-root",Buffer.from("ordinary"));assert.throws(()=>accountErasureStorage(regular,empty),{code:"unverifiable"});
 fs.symlinkSync(native,join(root,"alias"));assert.throws(()=>accountErasureStorage(root,empty),{code:"unverifiable"});rmSync(join(root,"alias"));
 mock.method(fs,"readdirSync",()=>{throw Object.assign(new Error("unreadable"),{code:"EACCES"});});syncBuiltinESMExports();assert.throws(()=>accountErasureStorage(root,empty),{code:"unverifiable"});mock.restoreAll();syncBuiltinESMExports();
});

test("invalid audit arguments refuse before an explicitly authorized purge",async()=>{
 const f=await fixture();const path=place(f.repo.objects.storageRoot(),"unaccounted-purge",Buffer.from("preserve invalid request"));
 assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","INVALID",new Date(1),{purgeUnaccounted:true}),{code:"bad_tombstone"});
 assert.equal(readFileSync(path,"utf8"),"preserve invalid request");assert.equal(existsSync(join(f.repo.controlDirectory,"erasure-purge.json")),false);
});

test("late unplanned files refuse the frozen purge and a fresh explicit request records a separate immutable batch",async()=>{
 const f=await fixture();let starts=0;let additions=0;let late="";
 accountabilityBoundary.visit=(step,path,attempt)=>{if(step==="pass-start"&&attempt===0&&++starts===3){late=place(path,`unaccounted-final-${additions++}`,Buffer.from("late unaccounted bytes"));}};
 assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true}),{code:"unverifiable"});
 assert.equal(additions,1);assert.ok(existsSync(late));assert.ok(f.repo.objects.denials()[0].pending);assert.equal(f.repo.operations.read().filter(x=>x.command==="obliterate").length,0);
 accountabilityBoundary.visit=()=>{};assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});assert.ok(existsSync(late));
 const receipt=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true});assert.equal(receipt.purge.deleted,1);assert.equal(receipt.purge.intents.length,2);assert.deepEqual(receipt.purge.intents.map(plan=>plan.planned),[0,1]);assert.equal(receipt.storage.accountable,true);
});

test("accountability namespace churn remains bounded without extending any purge batch",async()=>{
 const f=await fixture();let additions=0;
 accountabilityBoundary.visit=(step,path)=>{if(step==="pass-check"){const body=Buffer.from(`unrelated accounted object ${additions++}`);const id=hashObject("blob",body);place(path,`${id.slice(0,2)}/${id.slice(2)}`,deflateSync(frameObject("blob",body)));}};
 assert.throws(()=>accountErasureStorage(f.repo.objects.storageRoot(),empty),{code:"unverifiable"});assert.equal(additions,ACCOUNTABILITY_ATTEMPTS);
 accountabilityBoundary.visit=()=>{};assert.equal(accountErasureStorage(f.repo.objects.storageRoot(),empty).accountable,true);
});


test("purge batch schema preserves legacy audit facts and refuses invalid authority before deletion", async () => {
 const f=await fixture();const control=f.repo.controlDirectory;const roots=[f.repo.objects.storageRoot()];const id=f.entry.fileId!;const path=join(control,"erasure-purge.json");const revision="a".repeat(64);
 const valid={format:"pm-vcs-erasure-purge-2",operations:{[id]:[]},plans:{[id]:[{id,revision}]}};
 for(const plans of [null,[],{bad:[]},{[id]:null},{[id]:[null]},{[id]:[{id,revision,extra:true}]},{[id]:[{id:"bad",revision}]},{[id]:[{id,revision:"bad"}]},{[id]:[{id:"b".repeat(32),revision}]},{[id]:[{id,revision},{id,revision}]},{}]){
  writeFileSync(path,JSON.stringify({...valid,plans}));assert.throws(()=>erasurePurge(control,id,roots,true),{code:"unverifiable"});
 }
 writeFileSync(path,JSON.stringify({format:"pm-vcs-erasure-purge-1",operations:{[id]:[]}}));assert.equal(erasurePurge(control,id,roots,false).receipt().intents.length,1);
 writeFileSync(path,JSON.stringify(valid));const readOnly=erasurePurge(control,"c".repeat(32),roots,true,true);assert.throws(()=>readOnly.begin([]),{code:"unverifiable"});
 const other=place(roots[0],"foreign-batch",Buffer.from("unrelated batch"));const candidates=planErasureStorage(roots);
 const before=readFileSync(path);assert.throws(()=>erasurePurge(control,id,roots,true).begin([{...candidates[0],path:join(f.dir.root,"outside")}]),{code:"unverifiable"});assert.deepEqual(readFileSync(path),before);
 const unauthorized=erasurePurge(control,id,roots,false);unauthorized.begin(candidates);assert.deepEqual(readFileSync(path),before);
 const fresh=erasurePurge(control,id,roots,true);let calls=0;const random=crypto.randomBytes;mock.method(crypto,"randomBytes",(size:number)=>size===16&&++calls===1?Buffer.from(id,"hex"):Reflect.apply(random,crypto,[size]));syncBuiltinESMExports();fresh.begin(candidates);fresh.begin(candidates);fresh.plan(candidates);mock.restoreAll();syncBuiltinESMExports();assert.ok(calls>=2);
 const journal=JSON.parse(readFileSync(path,"utf8")) as typeof valid;assert.equal(Object.keys(journal.operations).length,2);assert.ok(existsSync(other));
 const resumed=erasurePurge(control,id,roots,false);assert.equal(resumed.canPurge,true);assert.equal(resumed.purge(candidates[0],()=>rmSync(other)),true);assert.equal(resumed.receipt().deleted,1);
});


test("a fresh purge batch cannot overwrite an operation id already owned by another FileId", async () => {
 const f=await fixture();const id=f.entry.fileId!;const other="d".repeat(32);const path=join(f.repo.controlDirectory,"erasure-purge.json");const roots=[f.repo.objects.storageRoot()];
 writeFileSync(path,JSON.stringify({format:"pm-vcs-erasure-purge-2",operations:{[id]:[]},plans:{[other]:[{id,revision:"a".repeat(64)}]}}));
 erasurePurge(f.repo.controlDirectory,id,roots,true).begin([]);const journal=JSON.parse(readFileSync(path,"utf8")) as {operations:Record<string,unknown[]>;plans:Record<string,{id:string}[]>};assert.deepEqual(journal.operations[id],[]);assert.notEqual(journal.plans[id][0].id,id);assert.equal(journal.plans[other][0].id,id);
});

test("final verification cannot exclude a native encoded copy recreated at a purged pathname",async()=>{
 const f=await fixture();let encoded=f.bytes;for(let i=0;i<8;i++)encoded=Buffer.from(encoded.toString("base64"));const id=hashObject("blob",encoded);const path=place(f.repo.objects.storageRoot(),`${id.slice(0,2)}/${id.slice(2)}`,Buffer.alloc(0));let replaced=false;
 erasureScanBoundary.visit=step=>{if(step==="completed"&&!replaced){replaced=true;writeFileSync(path,deflateSync(frameObject("blob",encoded)));}};
 assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true}),/unverified/u);assert.equal(replaced,true);assert.equal(f.repo.objects.denials()[0].pending,true);assert.deepEqual(f.repo.objects.read(id).payload,encoded);
 erasureScanBoundary.visit=()=>{};rmSync(path);const receipt=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true});assert.equal(receipt.storage.accountable,true);assert.equal(receipt.purge.deleted,1);assert.equal(f.repo.objects.denials()[0].pending,false);assert.equal(f.repo.operations.read().filter(entry=>entry.command==="obliterate").length,1);
});


test("a valid encoded copy introduced at EVERY erasure boundary cannot receive a completion certificate",async t=>{
 const steps=["proof-persisted","pending","object-deleted","storage-verified","completed","receipt","file-opened","file-chunk","file-verified"];
 for(const step of steps){
  const f=await fixture();let encoded=f.bytes;for(let i=0;i<8;i++)encoded=Buffer.from(encoded.toString("base64"));const id=hashObject("blob",encoded);const path=place(f.repo.objects.storageRoot(),`${id.slice(0,2)}/${id.slice(2)}`,Buffer.alloc(0));let injected=false;
  erasureScanBoundary.visit=current=>{if(current===step&&!injected){injected=true;writeFileSync(path,deflateSync(frameObject("blob",encoded)));}};
  assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true}),error=>error instanceof ObjectStoreError&&error.status==="unverified",step);assert.equal(injected,true,step);assert.equal(f.repo.objects.denials()[0].pending,true);assert.deepEqual(f.repo.objects.read(id).payload,encoded);
  erasureScanBoundary.visit=()=>{};rmSync(path);const receipt=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true});assert.equal(receipt.storage.accountable,true);assert.equal(f.repo.objects.denials()[0].pending,false);assert.equal(f.repo.operations.read().filter(entry=>entry.command==="obliterate").length,1);
 }
 t.diagnostic("9 late-copy cells cover all erasure publication and final physical-scan boundaries; every cleanup retry converges");
});

test("decoded and physical proofs share the final native descriptor and catalogue at EVERY verification boundary",async t=>{
 const steps=["pass-start","file-resolve","file-opened","object-verified","file-parsed","file-check","file-verified","pass-check"];let cells=0;
 for(const packed of [false,true])for(const copiedPack of [false,true])for(const step of steps){
  const f=await fixture();if(packed)f.repo.objects.compact();const marker=Buffer.from("late independently encoded selected marker 826391");let encoded=marker;for(let i=0;i<8;i++)encoded=Buffer.from(encoded.toString("base64"));
  let name:string;let bytes:Buffer;
  if(copiedPack){const supplier=new ObjectStore(join(f.dir.root,"supplier"));supplier.write("blob",encoded);supplier.compact();const file=supplier.inventory()[0];name=`packs/${file.path.split(/[\\/]/u).at(-1)}`;bytes=readFileSync(file.path);}else{const id=hashObject("blob",encoded);name=`${id.slice(0,2)}/${id.slice(2)}`;bytes=deflateSync(frameObject("blob",encoded));}
  const patterns=[fingerprint(marker)];const root=f.repo.objects.storageRoot();let injected=false;let late="";
  accountabilityBoundary.visit=current=>{if(current===step&&!injected){injected=true;late=place(root,name,bytes);}};
  const options={...empty,inspection:(_id:string,size:number,kind:Parameters<typeof createErasureInspection>[2])=>createErasureInspection(patterns,size,kind),physical:(fd:number,size:number,kind:Parameters<typeof inspectErasureFile>[3])=>inspectErasureFile(fd,size,patterns,kind)};
  assert.throws(()=>accountErasureStorage(root,options),error=>error instanceof ObjectStoreError&&error.status==="unverified",`${packed}/${copiedPack}/${step}`);assert.equal(injected,true);assert.equal(objectFiles.active.size,0);
  accountabilityBoundary.visit=()=>{};rmSync(late);assert.equal(accountErasureStorage(root,options).accountable,true);cells++;
 }
 assert.equal(cells,32);t.diagnostic("32 correlated-proof cells: 8 verification boundaries x loose/packed current store x loose/packed late copy");
});


test("pinned inspection faults and malformed inspector contracts never produce native certificates or leak handles",async()=>{
 const f=await fixture();const root=f.repo.objects.storageRoot();const patterns=[fingerprint(Buffer.from("deliberately absent proof marker"))];
 for(const mode of ["factory","feed","finish","close","physical","undefined","null","missing-feed","missing-finish","missing-close"]){
  const options={...empty,inspection:(_id:string,size:number,kind:Parameters<typeof createErasureInspection>[2])=>{
   if(mode==="factory")throw undefined;
   if(mode==="undefined")return undefined as never;if(mode==="null")return null as never;
   if(mode==="missing-feed")return {finish(){},close(){}} as never;if(mode==="missing-finish")return {feed(){},close(){}} as never;if(mode==="missing-close")return {feed(){},finish(){}} as never;
   const real=createErasureInspection(patterns,size,kind);return{feed:(bytes:Uint8Array)=>{real.feed(bytes);if(mode==="feed")throw undefined;},finish:()=>{real.finish();if(mode==="finish")throw new Error("injected proof failure");},close:()=>{real.close();if(mode==="close")throw new Error("injected close failure");}};
  },physical:(fd:number,size:number,kind:Parameters<typeof inspectErasureFile>[3])=>{inspectErasureFile(fd,size,patterns,kind);if(mode==="physical")throw new Error("injected physical failure");}};
  assert.throws(()=>accountErasureStorage(root,options),error=>error instanceof VerificationRefusal&&error.bound===(mode.startsWith("missing-")||mode==="undefined"||mode==="null"?"inspection_contract":"decode_error"),mode);assert.equal(objectFiles.active.size,0);
 }
});

test("pinned raw inspection keeps its borrowed descriptor and refuses missing bytes and retained copies",async()=>{
 const f=await fixture();const path=place(f.dir.root,"raw-inspection",f.bytes);const file=objectFiles.open(path,"r");
 try{assert.throws(()=>inspectErasureFile(file.fd,f.bytes.length,[fingerprint(f.bytes)],"object-root"),{code:"erasure_retained_copy"});inspectErasureFile(file.fd,f.bytes.length,[fingerprint(Buffer.from("absent marker"))],"object-root");assert.deepEqual(readFileSync(file.fd),f.bytes);
 mock.method(fs,"readSync",()=>0);syncBuiltinESMExports();assert.throws(()=>inspectErasureFile(file.fd,f.bytes.length,[fingerprint(f.bytes)],"object-root"),error=>error instanceof VerificationRefusal&&error.bound==="storage_read");}
 finally{mock.restoreAll();syncBuiltinESMExports();file.close();}
});

test("a deadline reached during a pinned native member stops decoding without certifying or authorizing purge",async()=>{
 const f=await fixture();const large=f.repo.objects.write("blob",Buffer.alloc(1024*1024,255));const prior=verificationLimits.accountabilityMs;let chunks=0;
 try{assert.throws(()=>accountErasureStorage(f.repo.objects.storageRoot(),{...empty,inspection:(id,size,kind)=>{const real=createErasureInspection([fingerprint(Buffer.from("absent marker"))],size,kind);return{...real,feed:(bytes:Uint8Array)=>{real.feed(bytes);if(id===large){chunks++;verificationLimits.accountabilityMs=0;}}};},purge:()=>{assert.fail("a work bound authorized purge");}}),error=>error instanceof VerificationRefusal&&error.bound==="time_ms");assert.equal(chunks,1);assert.equal(objectFiles.active.size,0);}
 finally{verificationLimits.accountabilityMs=prior;}
 assert.equal(f.repo.objects.has(large),true);
});

test("asynchronous and value-returning proof callbacks cannot certify or leave an unhandled rejection",async()=>{
 const f=await fixture();const patterns=[fingerprint(Buffer.from("absent marker"))];const root=f.repo.objects.storageRoot();
 for(const mode of ["async-factory","async-physical","async-feed","async-finish","async-close","promise-factory","promise-feed","promise-finish","promise-close","promise-physical","false-feed","false-physical"]){
  let asyncInvoked=false;
  const options={...empty,inspection:(_id:string,size:number,kind:Parameters<typeof createErasureInspection>[2])=>{
   if(mode==="promise-factory")return Promise.reject(new Error("unsupported asynchronous factory")) as never;
   const real=createErasureInspection(patterns,size,kind);return{feed:(bytes:Uint8Array)=>{real.feed(bytes);if(mode==="promise-feed")return Promise.reject(new Error("unsupported asynchronous feed"));if(mode==="false-feed")return false;},finish:()=>{real.finish();if(mode==="promise-finish")return Promise.reject(new Error("unsupported asynchronous finish"));},close:()=>{real.close();if(mode==="promise-close")return Promise.reject(new Error("unsupported asynchronous close"));},...(mode==="async-feed"?{feed:async()=>{asyncInvoked=true;}}:{}),...(mode==="async-finish"?{finish:async()=>{asyncInvoked=true;}}:{}),...(mode==="async-close"?{close:async()=>{asyncInvoked=true;}}:{})};
  },physical:()=>{if(mode==="promise-physical")return Promise.reject(new Error("unsupported asynchronous physical proof"));if(mode==="false-physical")return false;},...(mode==="async-factory"?{inspection:async()=>{asyncInvoked=true;return undefined as never;}}:{}),...(mode==="async-physical"?{physical:async()=>{asyncInvoked=true;}}:{})};
  assert.throws(()=>accountErasureStorage(root,options as never),error=>error instanceof VerificationRefusal&&error.bound==="inspection_contract",mode);assert.equal(asyncInvoked,false);assert.equal(objectFiles.active.size,0);await Promise.resolve();
 }
});

test("streamed representation proofs require the whole range and cannot certify after abort or ignored errors",()=>{
 const patterns=[fingerprint(Buffer.from("absent marker"))];const bytes=Buffer.from("ordinary byte range");
 for(const delta of [-1,1]){const proof=createErasureInspection(patterns,bytes.length+delta);proof.feed(bytes);assert.throws(()=>proof.finish(),error=>error instanceof VerificationRefusal&&error.bound==="representation_bytes");assert.throws(()=>proof.finish(),{status:"unverified"});proof.close();}
 const closed=createErasureInspection(patterns,bytes.length);closed.close();assert.throws(()=>closed.finish(),error=>error instanceof VerificationRefusal&&error.bound==="inspection_incomplete");assert.throws(()=>closed.feed(bytes),{status:"unverified"});
 const complete=createErasureInspection(patterns,bytes.length);complete.feed(bytes);complete.finish();complete.finish();assert.throws(()=>complete.feed(bytes),error=>error instanceof VerificationRefusal&&error.bound==="inspection_contract");assert.throws(()=>complete.finish(),{status:"unverified"});complete.close();
 const fault=createErasureInspection([fingerprint(bytes)],bytes.length);mock.method(crypto,"createHash",()=>{throw undefined;});syncBuiltinESMExports();try{assert.throws(()=>fault.feed(bytes),error=>error instanceof VerificationRefusal&&error.bound==="decode_error");}finally{mock.restoreAll();syncBuiltinESMExports();}assert.throws(()=>fault.finish(),error=>error instanceof VerificationRefusal&&error.bound==="decode_error");fault.close();
 const prior={...erasureScanLimits};try{erasureScanLimits.minimum=0;erasureScanLimits.ratio=0;const bounded=createErasureInspection(patterns,bytes.length);assert.throws(()=>bounded.feed(bytes),error=>error instanceof VerificationRefusal&&error.bound==="decoded_bytes");assert.throws(()=>bounded.finish(),error=>error instanceof VerificationRefusal&&error.bound==="decoded_bytes");bounded.close();}finally{Object.assign(erasureScanLimits,prior);}
});

test("borrowed inspection slots cannot alter native payload-denial accounting",async()=>{
 const f=await fixture();const options={forbiddenIds:new Set<string>(),forbiddenPayloads:new Set([createHash("sha256").update(f.bytes).digest("hex")]),inspection:()=>({feed:(bytes:Uint8Array)=>{bytes.fill(0);},finish(){},close(){}})};
 assert.throws(()=>accountErasureStorage(f.repo.objects.storageRoot(),options),{code:"erasure_retained_copy"});assert.equal(objectFiles.active.size,0);assert.deepEqual(f.repo.objects.read(f.entry.id).payload,f.bytes);
});


test("an operational diagnostic failure refuses before any denial or selected-file deletion",async()=>{
 const f=await fixture();const original=f.repo.objects.walkErasureInventory;let passes=0;
 mock.method(f.repo.objects,"walkErasureInventory",function*(...args:Parameters<typeof original>){if(++passes===3)throw new Error("injected byte-inspection failure");yield* Reflect.apply(original,f.repo.objects,args);});
 assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)),error=>error instanceof VerificationRefusal&&error.bound==="decode_error");assert.equal(passes,3);assert.deepEqual(f.repo.objects.denials(),[]);assert.deepEqual(readFileSync(join(f.repo.root,"asset")),f.bytes);mock.restoreAll();assert.equal(f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)).storage.accountable,true);
});

test("purge authorization revoked after complete preflight refuses before deleting the recorded foreign set",async()=>{
 const f=await fixture();const root=f.repo.objects.storageRoot();const foreign=place(root,"revoked-foreign",Buffer.from("foreign bytes retained"));const journal=join(f.repo.controlDirectory,"erasure-purge.json");
 f.repo.objects.withWriteLock(()=>erasurePurge(f.repo.controlDirectory,f.entry.fileId!,[root],true).begin(planErasureStorage([root])));
 const read=fs.readFileSync;const stat=fs.lstatSync;let checked=false;let reads=0;
 mock.method(fs,"lstatSync",(...args:Parameters<typeof fs.lstatSync>)=>{if(args[0]===journal)checked=true;return Reflect.apply(stat,fs,args);});
 mock.method(fs,"readFileSync",(...args:Parameters<typeof fs.readFileSync>)=>{if(args[0]===journal&&checked){checked=false;if(++reads===3)writeFileSync(journal,JSON.stringify({format:"pm-vcs-erasure-purge-2",operations:{},plans:{}}));}return Reflect.apply(read,fs,args);});syncBuiltinESMExports();
 assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});mock.restoreAll();syncBuiltinESMExports();assert.equal(reads,3);assert.deepEqual(f.repo.objects.denials(),[]);assert.equal(readFileSync(foreign,"utf8"),"foreign bytes retained");assert.deepEqual(readFileSync(join(f.repo.root,"asset")),f.bytes);
});
