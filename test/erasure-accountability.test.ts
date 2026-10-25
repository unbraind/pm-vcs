/** Accountable storage, exact purge receipts and namespace replacement regressions on real non-git trackers. */
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import fs, { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync, inflateRawSync, constants as zlibConstants } from "node:zlib";
import { afterEach, test, mock } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { ObjectStore, frameObject, hashObject } from "../engine/objects.ts";
import { accountErasureStorage, accountabilityBoundary, erasurePurge, ACCOUNTABILITY_ATTEMPTS } from "../engine/erasure-accountability.ts";
import { erasureScanBoundary, erasureScanLimits } from "../engine/erasure-scan.ts";
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
 const path=place(root,`packs/${createHash("sha256").update(pack).digest("hex")}.pack`,pack);assert.throws(()=>accountErasureStorage(root,empty),{code:"unverifiable"});rmSync(path);
});

test("fingerprint evidence is optional diagnostics and cannot certify unknown files",async()=>{
 const f=await fixture();f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1));const journal=join(f.repo.controlDirectory,"erasure-verification.json");rmSync(journal);
 assert.equal(f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)).storage.accountable,true);
 writeFileSync(journal,"foreign diagnostic format");const receipt=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1));assert.equal(receipt.storage.accountable,true);assert.ok(receipt.storage.diagnostic);assert.equal(readFileSync(journal,"utf8"),"foreign diagnostic format");
 const limited=await fixture();limited.repo.objects.write("blob",Buffer.alloc(100_000,122));const budget={...erasureScanLimits};
 try { erasureScanLimits.minimum=1;erasureScanLimits.ratio=0;const report=limited.repo.obliterate(limited.entry.fileId!,"erase-fixture","incident",new Date(1));assert.equal(report.storage.accountable,true);assert.match(report.storage.diagnostic!,/diagnostics incomplete/); } finally { Object.assign(erasureScanLimits,budget); }
 place(f.repo.objects.storageRoot(),"cache",Buffer.from("unrelated foreign bytes"));assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});
});

test("SIGKILL at EVERY purge journal and unlink boundary converges with one bounded receipt",async(t)=>{
 /** Every case uses an independently initialized SDK tracker and the actual SDK/engine command path. */
 const fresh=async()=>{const f=await fixture();place(f.repo.objects.storageRoot(),"unaccounted-purge",Buffer.from("foreign bytes to purge"));return f;};
 const run=(f:Awaited<ReturnType<typeof fixture>>,ordinal:number)=>spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/erasure-purge-worker.ts"),f.repo.root,f.entry.fileId!,String(ordinal)],{env:{...process.env,...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.dir.root)},encoding:"utf8",timeout:30_000});
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
 const run=(mode:string)=>spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/erasure-peer.ts"),f.repo.root,f.entry.fileId!,mode],{env:{...process.env,...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.dir.root)},encoding:"utf8",timeout:30_000});
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
 mock.method(fs,"readSync",()=>{throw Object.assign(new Error("private contents"),{code:"EIO"});});syncBuiltinESMExports();
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
  assert.throws(()=>accountErasureStorage(root,empty),{code:"unverifiable"});mock.restoreAll();syncBuiltinESMExports();assert.equal(objectFiles.active.size,0);
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

test("receipt changes restart final verification and bounded churn never publishes completion",async()=>{
 const f=await fixture();let starts=0;let additions=0;
 accountabilityBoundary.visit=(step,path,attempt)=>{if(step==="pass-start"&&attempt===0&&++starts>=3){place(path,`unaccounted-final-${additions++}`,Buffer.from("late unaccounted bytes"));}};
 assert.throws(()=>f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true}),{code:"unverifiable"});
 assert.equal(additions,ACCOUNTABILITY_ATTEMPTS);assert.ok(f.repo.objects.denials()[0].pending);assert.equal(f.repo.operations.read().filter(x=>x.command==="obliterate").length,0);
 accountabilityBoundary.visit=()=>{};const receipt=f.repo.obliterate(f.entry.fileId!,"erase-fixture","incident",new Date(1));assert.equal(receipt.purge.deleted,ACCOUNTABILITY_ATTEMPTS);assert.equal(receipt.storage.accountable,true);
});
