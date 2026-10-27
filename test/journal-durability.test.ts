import "./helpers/isolate-session.ts";
/** Durable publication authority and retry reconciliation on one real non-git tracker. */
import assert from "node:assert/strict";
import fs, { cpSync, existsSync, fstatSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, mock, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { ObjectStore, hashObject } from "../engine/objects.ts";
import { writePrivateJson } from "../engine/composition.ts";
import { destructionBoundary, DestructionRefusal, inspectDestructions, prepareDestruction } from "../engine/destruction.ts";
import { objectFiles } from "../engine/object-files.ts";
import { durability, durabilityCapabilities } from "../engine/durability.ts";
import { collectGarbage } from "../engine/gc.ts";
import { verificationLimits, VerificationRefusal } from "../engine/object-error.ts";
import { packBoundary } from "../engine/packs.ts";
import { WorktreeMutation } from "../engine/worktree-mutation.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import { NamespacePowerLoss } from "./helpers/namespace-power-loss.ts";
const temporary: ReturnType<typeof makeTempDir>[] = [];
const capability = durabilityCapabilities.directorySync;
afterEach(() => { mock.reset(); syncBuiltinESMExports(); destructionBoundary.visit = () => {}; packBoundary.visit = () => {}; durabilityCapabilities.directorySync = capability; assert.equal(objectFiles.active.size, 0); for (const dir of temporary.splice(0)) dir.cleanup(); });
/** Keep every native store below a single SDK initialized tracker, independent of Git discovery. */
async function fixture() {
 const dir=makeTempDir();temporary.push(dir);process.env.GIT_CEILING_DIRECTORIES=dirname(dir.root);
 await new PmClient({cwd:dir.root,pmRoot:join(dir.root,".agents/pm"),noExtensions:true}).init("journal-power",{defaults:true,author:"fixture"});return dir.root;
}
/** Derive only the exact private ledger owned by this disposable control root. */
function ledger(control:string):string{return join(tmpdir(),`pm-vcs-namespace-${createHash("sha256").update(fs.realpathSync(control)).digest("hex")}`);}

test("first retirement flushes the complete intent ancestry before unlink, under both platform capabilities",async()=>{
 const root=await fixture();
 for(const enabled of [true,false]){
  const repo=Repository.init(join(root,String(enabled)));const id=repo.objects.write("blob",Buffer.from("retained ref payload"));repo.refs.compareAndSwap("refs/metadata/first",null,id);const directory=join(repo.controlDirectory,"destruction");assert.equal(existsSync(directory),false);
  const descriptors=new Map<number,string>();const flushed=new Set<string>();const open=fs.openSync;const close=fs.closeSync;const sync=fs.fsyncSync;const unlink=fs.unlinkSync;let retired=false;
  mock.method(fs,"openSync",(...args:Parameters<typeof fs.openSync>)=>{const fd=open(...args);descriptors.set(fd,String(args[0]));return fd;});
  mock.method(fs,"closeSync",(fd:number)=>{descriptors.delete(fd);return close(fd);});
  mock.method(fs,"fsyncSync",(fd:number)=>{if(fstatSync(fd).isDirectory())flushed.add(descriptors.get(fd)!);return sync(fd);});
  mock.method(fs,"unlinkSync",(...args:Parameters<typeof fs.unlinkSync>)=>{if(args[0]===join(repo.controlDirectory,"refs/metadata/first")){retired=true;if(enabled){let ancestor=directory;for(;;){assert.ok(flushed.has(ancestor),"deletion needs a durable journal ancestor");const parent=dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}}else assert.equal(flushed.size,0);}return unlink(...args);});syncBuiltinESMExports();durabilityCapabilities.directorySync=enabled;
  repo.refs.compareAndSwap("refs/metadata/first",id,null);assert.ok(retired);mock.restoreAll();syncBuiltinESMExports();assert.deepEqual(repo.objects.readTyped(id,"blob"),Buffer.from("retained ref payload"));
 }
});

test("a same-content retry completes the ORIGINAL rename receipt before replacing its destination with another temporary",async()=>{
 const root=await fixture();const repo=Repository.init(join(root,"rename"));const target=join(repo.controlDirectory,"metadata.json");let original:string|undefined;let crashed=false;
 destructionBoundary.visit=(step)=>{if(step==="deleted"&&existsSync(target)&&!crashed){crashed=true;const directory=join(ledger(repo.controlDirectory),"destruction");original=readdirSync(directory).filter(name=>name.endsWith(".json")).map(name=>join(directory,name)).find(path=>{const value=JSON.parse(readFileSync(path,"utf8")) as {entries:{destination?:string}[]};return value.entries.some(entry=>entry.destination!==undefined&&entry.destination.endsWith("metadata.json"));});throw new Error("interrupted rename acknowledgement");}};
 assert.throws(()=>writePrivateJson(target,{generation:1}),/interrupted|Deletion stopped/);destructionBoundary.visit=()=>{};assert.ok(crashed);assert.ok(original);assert.equal((JSON.parse(readFileSync(original,"utf8")) as {status:string}).status,"pending");
 writePrivateJson(target,{generation:1});assert.equal((JSON.parse(readFileSync(original,"utf8")) as {status:string}).status,"completed");assert.equal(inspectDestructions(repo.controlDirectory).pending,0);
 writePrivateJson(target,{generation:2});assert.equal((JSON.parse(readFileSync(original,"utf8")) as {status:string}).status,"completed");assert.equal(inspectDestructions(repo.controlDirectory).pending,0);
});

test("native namespace power cuts at EVERY metadata publication boundary converge with no pending receipt",async t=>{
 const root=await fixture();let cases=0;const template=Repository.init(join(root,"template"));
 const run=(name:string,cut:number):string[]=>{
  const copied=join(root,name);cpSync(template.root,copied,{recursive:true});const repo=Repository.open(copied);const target=join(repo.controlDirectory,"nested/new/metadata.json");const owned=ledger(repo.controlDirectory);rmSync(owned,{recursive:true,force:true});
  const power=new NamespacePowerLoss([repo.root,owned],cut);
  try{power.install();if(cut>0){assert.throws(()=>writePrivateJson(target,{payload:"retained publication"}));power.crash();}else writePrivateJson(target,{payload:"retained publication"});
   const trace=[...power.trace];power.replay();
   for(let retry=0;retry<2;retry++)writePrivateJson(target,{payload:"retained publication"});assert.deepEqual(JSON.parse(readFileSync(target,"utf8")),{payload:"retained publication"});assert.equal(inspectDestructions(repo.controlDirectory).pending,0);return [...trace];
  }finally{power.close();rmSync(owned,{recursive:true,force:true});}
 };
 const trace=run("probe",0);t.diagnostic(`${trace.length} native metadata step boundaries`);for(let cut=1;cut<=trace.length;cut++){run(`cut-${cut}`,cut);cases++;}t.diagnostic(`${cases} native metadata namespace-loss cuts`);
});


const sequences = ["ref-retirement","ref-replacement","compact","unpack","repack","gc-loose","gc-packed","lease-cleanup","prune","oplog","deep-intent","recovery","obliterate","directory-recovery","publication-recovery","legacy-publication-recovery"] as const;
type Sequence = typeof sequences[number];
/** One prepared native store below the real tracker exercises a complete engine write-then-retire path. */
function sequence(root:string,kind:Sequence,cut:number,template?:string,packStep?:string):{steps:string[];cuts:number[]}{
 if(template!==undefined)cpSync(template,root,{recursive:true,filter:path=>path!==join(template,".pmvcs/destruction")});
 const repo=template===undefined?Repository.init(root):Repository.open(root);const bytes=Buffer.from("retained native power object");const live=hashObject("blob",bytes);const garbage=hashObject("blob",Buffer.from("discardable native power object"));
 if(template===undefined){repo.objects.write("blob",bytes);repo.refs.compareAndSwap("refs/metadata/live",null,live);repo.objects.write("blob",Buffer.from("discardable native power object"));}const ref="refs/metadata/temporary";
 if(template===undefined&&(kind==="ref-retirement"||kind==="ref-replacement"))repo.refs.compareAndSwap(ref,null,live);
 if(template===undefined&&(kind==="unpack"||kind==="repack"||kind==="gc-packed"))repo.objects.compact();
 if(template===undefined&&kind==="repack")repo.objects.write("blob",Buffer.from("new repack member"));
 const lease=join(repo.controlDirectory,"fixture.lock");if(template===undefined&&kind==="lease-cleanup")writeFileSync(lease,"owned lease fixture");
 if(template===undefined&&kind==="prune")mkdirSync(join(root,"empty/a/b"),{recursive:true});if(template===undefined)writeFileSync(join(root,"guard"),"foreign tripwire");
 const paths=[join(root,"candidate-a"),join(root,"candidate-b")];if(template===undefined&&kind==="deep-intent")for(const path of paths)writeFileSync(path,"owned candidate");
 if(template===undefined&&kind==="recovery")writeFileSync(join(repo.controlDirectory,"objects.lock"),"2147483647");
 let fileId="";if(template===undefined&&kind==="obliterate"){writeFileSync(join(root,"asset"),"selected power payload 917364852");repo.stage(["asset"]);fileId=repo.readIndex()[0].fileId!;repo.setAuthority("fixture","read-power","erase-power");}
 if(template!==undefined&&kind==="obliterate")fileId=repo.readIndex()[0].fileId!;
 const owned=ledger(repo.controlDirectory);rmSync(owned,{recursive:true,force:true});if(cut<0)return{steps:[],cuts:[]};
 const recoveringDirectory=join(repo.objects.storageRoot(),"packs",`job-${"d".repeat(24)}`);const recoveringPublication=join(repo.controlDirectory,"recover-publication.json");
 if(kind==="directory-recovery"){mkdirSync(recoveringDirectory,{recursive:true});destructionBoundary.visit=step=>{if(step==="intent-persisted")throw new Error("directory intent interruption");};try{assert.throws(()=>durability.removeDirectory(recoveringDirectory));}finally{destructionBoundary.visit=()=>{};}}
 if(kind==="publication-recovery"||kind==="legacy-publication-recovery"){let crash=true;destructionBoundary.visit=step=>{if(crash&&step==="deleted"&&existsSync(recoveringPublication)){crash=false;throw new Error("publication interruption");}};try{assert.throws(()=>writePrivateJson(recoveringPublication,{value:1}));}finally{destructionBoundary.visit=()=>{};}
  if(kind==="legacy-publication-recovery"){const directory=join(owned,"destruction");const path=readdirSync(directory).filter(name=>name.endsWith(".json")).map(name=>join(directory,name)).find(path=>{const row=JSON.parse(readFileSync(path,"utf8")) as {entries:{destination?:string}[]};return row.entries.some(entry=>entry.destination?.endsWith("recover-publication.json"));})!;const row=JSON.parse(readFileSync(path,"utf8")) as {root:string;entries:{path:string;destination:string;identity:string}[]};const entry=row.entries[0];const key=`rename:${resolve(row.root,entry.path)}:${resolve(row.root,entry.destination)}:${entry.identity}`;fs.renameSync(path,join(directory,createHash("sha256").update(`${row.root}\0${key}`).digest("hex")+".json"));}
 }
 const deep=join(root,"receipts/a/b/c");const control=join(repo.controlDirectory,"fresh/a/b");
 const operation=():void=>{
  if(kind==="ref-retirement")repo.refs.compareAndSwap(ref,repo.refs.read(ref),null);
  else if(kind==="ref-replacement")repo.refs.compareAndSwap(ref,repo.refs.read(ref),garbage);
  else if(kind==="compact")repo.objects.compact();
  else if(kind==="unpack")repo.objects.unpack();
  else if(kind==="repack"){repo.objects.unpack();repo.objects.compact();}
  else if(kind==="gc-loose"||kind==="gc-packed")collectGarbage(repo,true);
  else if(kind==="lease-cleanup"){if(existsSync(lease)){const fd=fs.openSync(lease,"r+");durability.release(lease,fd);}}
  else if(kind==="prune"){const mutation=new WorktreeMutation(root,".pmvcs");try{mutation.prune();}finally{mutation.close();}}
  else if(kind==="oplog"){const recorded=new Error("already recorded under the native lease");try{repo.operations.append("power-case","durable retention evidence",[],new Date(1),undefined,()=>{if(repo.operations.read().some(operation=>operation.command==="power-case"))throw recorded;});}catch(error){if(error!==recorded)throw error;}}
  else if(kind==="deep-intent"){const plan=prepareDestruction(control,"power-set",paths.map(path=>({path})),false,deep);for(const path of plan.paths)plan.remove(path);assert.equal(plan.finish().status,"completed");}
  else if(kind==="recovery")repo.objects.withRecoveryValidation(()=>"validated",()=>collectGarbage(repo,true));
  else if(kind==="directory-recovery"){durability.resumeDirectory(recoveringDirectory);assert.equal(existsSync(recoveringDirectory),false);}
  else if(kind==="publication-recovery"||kind==="legacy-publication-recovery")writePrivateJson(recoveringPublication,{value:2});
  else repo.obliterate(fileId,"erase-power","power-model",new Date(1),{purgeUnaccounted:true,recoverLock:existsSync(join(repo.controlDirectory,"objects.lock"))});
 };
 const power=new NamespacePowerLoss([root,owned],cut,[deep]);let trace:string[]=[];let cuts:number[]=[];
 try{
  power.install();if(packStep!==undefined)packBoundary.visit=step=>{if(step===packStep)power.interrupt();};if(cut>0||packStep!==undefined){assert.throws(operation);power.crash();packBoundary.visit=()=>{};}else operation();trace=[...power.trace];cuts=[...power.recoveryCuts];power.replay();
  if(kind!=="recovery"&&kind!=="obliterate"&&existsSync(join(repo.controlDirectory,"objects.lock")))repo.objects.recoverWriterLock();
  for(let attempt=0;attempt<2;attempt++)operation();
  assert.deepEqual(new ObjectStore(repo.objects.storageRoot()).readTyped(live,"blob"),bytes);assert.equal(readFileSync(join(root,"guard"),"utf8"),"foreign tripwire");const inventory=inspectDestructions(repo.controlDirectory);const pending=new Set(inventory.receipts.filter(row=>row.status==="pending").map(row=>row.id));const evidence:unknown[]=[];if(pending.size)for(const directory of [join(repo.controlDirectory,"destruction"),join(owned,"destruction")])if(existsSync(directory))for(const name of readdirSync(directory).filter(name=>name.endsWith(".json"))){const record=JSON.parse(readFileSync(join(directory,name),"utf8")) as {id:string;entries:unknown[]};if(pending.has(record.id))evidence.push(record.entries);}assert.equal(inventory.pending,0,JSON.stringify(evidence));
  if(kind==="gc-loose"||kind==="gc-packed"||kind==="recovery")assert.equal(repo.objects.has(garbage),false);
  if(kind==="ref-retirement")assert.equal(repo.refs.read(ref),null);if(kind==="ref-replacement")assert.equal(repo.refs.read(ref),garbage);
  if(kind==="lease-cleanup")assert.equal(existsSync(lease),false);if(kind==="prune")assert.equal(existsSync(join(root,"empty")),false);
  if(kind==="oplog")assert.equal(repo.operations.read().filter(operation=>operation.command==="power-case").length,1);
  if(kind==="deep-intent")for(const path of paths)assert.equal(existsSync(path),false);
  if(kind==="obliterate")assert.equal(existsSync(join(root,"asset")),false);
  if(kind==="publication-recovery"||kind==="legacy-publication-recovery")assert.deepEqual(JSON.parse(readFileSync(recoveringPublication,"utf8")),{value:2});
 }catch(error){throw new Error(`${kind} power boundary ${cut}/${trace.length||power.trace.length} (${power.trace[cut-1]??"probe"}) failed`,{cause:error});}
 finally{packBoundary.visit=()=>{};power.close();rmSync(owned,{recursive:true,force:true});}
 return {steps:trace,cuts};
}

test("power-model probes exercise EVERY engine publication and retirement sequence",async()=>{
 const root=await fixture();for(const kind of sequences){const result=sequence(join(root,kind),kind,0);assert.ok(result.steps.length>0);console.log(`power probe ${kind}: ${result.steps.length} native boundaries, ${result.cuts.length} distinct full crash images`);}
});

for(const kind of sequences)test(`EVERY native ${kind} boundary survives directory-entry loss and completes its receipts`,async t=>{
 const root=await fixture();const template=join(root,"template");sequence(template,kind,-1);const result=sequence(join(root,"probe"),kind,0,template);let completed=0;for(const cut of result.cuts){sequence(join(root,`cut-${cut}`),kind,cut,template);if(++completed%25===0){console.log(`power ${kind}: ${completed}/${result.cuts.length} distinct images`);global.gc?.();}}t.diagnostic(`${result.steps.length} ${kind} native boundaries, ${result.cuts.length} distinct full crash images restored with two convergent engine replays each; byte-identical images share the proven verdict; retained object and foreign tripwire preserved`);
});


test("acknowledged operation retention evidence survives power loss before its owner is reused",async()=>{
 const root=await fixture();const repo=Repository.init(join(root,"acknowledged-log"));const owned=ledger(repo.controlDirectory);rmSync(owned,{recursive:true,force:true});const power=new NamespacePowerLoss([repo.root,owned]);
 try{power.install();repo.operations.append("acknowledged","durable retention root",[],new Date(1));power.crashAfterReturn();assert.equal(repo.operations.read().filter(operation=>operation.command==="acknowledged").length,1);assert.equal(inspectDestructions(repo.controlDirectory).pending,0);}finally{power.close();rmSync(owned,{recursive:true,force:true});}
});

test("bootstrap format and index files are flushed before initialization acknowledges success",async()=>{
 const root=await fixture();const parent=join(root,"bootstrap");mkdirSync(parent);const control=join(parent,"native/.pmvcs");const owned=join(tmpdir(),`pm-vcs-namespace-${createHash("sha256").update(control).digest("hex")}`);const power=new NamespacePowerLoss([parent,owned]);
 try{power.install();const repo=Repository.init(join(parent,"native"));power.crashAfterReturn();assert.equal(Repository.open(repo.root).refs.resolveHead(),null);assert.equal(readFileSync(join(repo.controlDirectory,"format"),"utf8"),"pmvcs-1\n");assert.deepEqual(Repository.open(repo.root).readIndex(),[]);}finally{power.close();rmSync(owned,{recursive:true,force:true});}
});


test("native process leases preserve foreign and live owners, recover dead markers, and close before return",async()=>{
 const root=await fixture();const repo=Repository.init(join(root,"leases"));const path=join(repo.controlDirectory,"native.lock");
 for(const text of ["", "peer owner", "{}", "[]", "null", "true", "1", '"peer"']){writeFileSync(path,text);assert.throws(()=>durability.claim(path,"fixture_locked"),{code:"fixture_locked"});assert.equal(readFileSync(path,"utf8"),text);rmSync(path);assert.equal(objectFiles.active.size,0);}
 const first=durability.claim(path,"fixture_locked");assert.throws(()=>durability.claim(path,"fixture_locked"),{code:"fixture_locked"});first.verify();first.release();first.release();assert.equal(existsSync(path),false);assert.equal(objectFiles.active.size,0);
 let hit=false;destructionBoundary.visit=(step)=>{if(step==="process-owner-published"&&!hit){hit=true;throw new Error("interrupted process publication");}};
 assert.throws(()=>durability.claim(path,"fixture_locked"),/interrupted process publication/);destructionBoundary.visit=()=>{};assert.equal(objectFiles.active.size,0);const recovered=durability.claim(path,"fixture_locked");recovered.release();assert.equal(existsSync(path),false);
 const owner=durability.claim(path,"fixture_locked");fs.renameSync(path,`${path}.retired`);writeFileSync(path,"peer replacement");assert.throws(()=>owner.verify(),{code:"fixture_locked"});owner.release();assert.equal(readFileSync(path,"utf8"),"peer replacement");assert.equal(objectFiles.active.size,0);
});

test("different-content publication retries finalize their predecessor rather than stranding a pending receipt",async()=>{
 const root=await fixture();const repo=Repository.init(join(root,"different-content"));const target=join(repo.controlDirectory,"value.json");let crash=true;
 destructionBoundary.visit=(step)=>{if(crash&&step==="deleted"&&existsSync(target)){crash=false;throw new Error("rename crash");}};assert.throws(()=>writePrivateJson(target,{value:1}));destructionBoundary.visit=()=>{};
 writePrivateJson(target,{value:2});assert.deepEqual(JSON.parse(readFileSync(target,"utf8")),{value:2});assert.equal(inspectDestructions(repo.controlDirectory).pending,0);
});


test("released source-keyed publication receipts reconcile under their original identity with fresh randomized retries",async t=>{
 const root=await fixture();let cases=0;
 for(const stamped of [false,true])for(const afterRename of [false,true])for(const replaced of [false,true]){
  const repo=Repository.init(join(root,`legacy-${cases++}`));const target=join(repo.controlDirectory,"legacy.json");const directory=join(ledger(repo.controlDirectory),"destruction");let original="";
  destructionBoundary.visit=(step,path)=>{if(step===(afterRename?"deleted":"intent-persisted")&&(afterRename?existsSync(target):path.startsWith(directory))&&existsSync(directory)){
   const candidate=readdirSync(directory).filter(name=>name.endsWith(".json")).map(name=>join(directory,name)).find(path=>{const value=JSON.parse(readFileSync(path,"utf8")) as {entries:{destination?:string}[]};return value.entries.some(entry=>entry.destination?.endsWith("legacy.json"));});
   if(candidate!==undefined){original=candidate;throw new Error("legacy publication crash");}
  }};
  assert.throws(()=>writePrivateJson(target,{value:1}));destructionBoundary.visit=()=>{};assert.ok(original);
  const record=JSON.parse(readFileSync(original,"utf8")) as {root:string;id:string;entries:{path:string;destination:string;identity:string}[]};const entry=record.entries[0];const source=resolve(record.root,entry.path);
  const key=`rename:${source}:${resolve(record.root,entry.destination)}${stamped?":"+entry.identity:""}`;const legacy=join(directory,createHash("sha256").update(`${record.root}\0${key}`).digest("hex")+".json");fs.renameSync(original,legacy);
  const oldProgress=original.slice(0,-5)+`.`+record.id+".progress";if(existsSync(oldProgress))fs.renameSync(oldProgress,legacy.slice(0,-5)+`.`+record.id+".progress");
  if(replaced){const leaf=afterRename?target:source;if(existsSync(leaf))rmSync(leaf);writeFileSync(leaf,"foreign replacement");}
  writePrivateJson(target,{value:2});assert.equal((JSON.parse(readFileSync(legacy,"utf8")) as {status:string}).status,"completed");assert.deepEqual(JSON.parse(readFileSync(target,"utf8")),{value:2});assert.equal(inspectDestructions(repo.controlDirectory).pending,0);
  if(replaced&&!afterRename)assert.equal(readFileSync(source,"utf8"),"foreign replacement");
 }
 t.diagnostic(`${cases} released-key/owner-stamp/rename/replacement cases`);
});


test("interrupted ref retirement resolves the historical lease even when the ref already disappeared",async()=>{
 const root=await fixture();const template=join(root,"template");sequence(template,"ref-retirement",-1);const probe=sequence(join(root,"probe"),"ref-retirement",0,template);const unlinks=probe.steps.flatMap((step,index)=>step==="file-unlinked"?[index]:[]);assert.ok(unlinks.length>1);sequence(join(root,"fixed-cut"),"ref-retirement",unlinks.at(-2)!,template);
});


test("process-marker schema, dead-owner recovery and failed cleanup preserve exact ownership",async()=>{
 const root=await fixture();const repo=Repository.init(join(root,"marker-corpus"));const path=join(repo.controlDirectory,"native.lock");
 const owner=durability.claim(path,"fixture_locked");const marker=JSON.parse(readFileSync(path,"utf8")) as Record<string,unknown>;owner.release();
 const patches:Record<string,unknown>[]=[{format:"foreign"},{pid:0},{pid:2_147_483_648},{pid:1.5},{pid:"1"},{identity:"foreign"},{parent:"foreign"},{name:"other"},{owner:"foreign"},{owner:null},{extra:true}];
 for(const patch of patches){writeFileSync(path,"");const stat=lstatSync(path,{bigint:true});const parent=lstatSync(dirname(path),{bigint:true});const record={...marker,identity:`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,parent:`${parent.dev}:${parent.ino}:${parent.birthtimeNs}`,...patch};writeFileSync(path,JSON.stringify(record));assert.throws(()=>durability.claim(path,"fixture_locked"),{code:"fixture_locked"});assert.deepEqual(JSON.parse(readFileSync(path,"utf8")),record);rmSync(path);assert.equal(objectFiles.active.size,0);}
 mkdirSync(path);assert.throws(()=>durability.claim(path,"fixture_locked"),{code:"fixture_locked"});rmSync(path,{recursive:true});writeFileSync(path,"x".repeat(4097));assert.throws(()=>durability.claim(path,"fixture_locked"),{code:"fixture_locked"});rmSync(path);
 writeFileSync(path,"");const stat=lstatSync(path,{bigint:true});const parent=lstatSync(dirname(path),{bigint:true});writeFileSync(path,JSON.stringify({...marker,pid:2_147_483_647,identity:`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,parent:`${parent.dev}:${parent.ino}:${parent.birthtimeNs}`}));
 const recovered=durability.claim(path,"fixture_locked");recovered.verify();recovered.release();assert.throws(()=>recovered.verify(),{code:"fixture_locked"});assert.equal(existsSync(path),false);
 const abandoned=durability.claim(path,"fixture_locked");const unlink=fs.unlinkSync;mock.method(fs,"unlinkSync",(...args:Parameters<typeof fs.unlinkSync>)=>{if(args[0]===path)throw Object.assign(new Error("owned cleanup interruption"),{code:"EACCES"});return unlink(...args);});syncBuiltinESMExports();assert.throws(()=>abandoned.release(),{code:"EACCES"});mock.restoreAll();syncBuiltinESMExports();assert.equal(objectFiles.active.size,0);const retry=durability.claim(path,"fixture_locked");retry.release();assert.equal(existsSync(path),false);
});


test("legacy receipt reconciliation fails closed on every record budget before replacing its destination",async()=>{
 const root=await fixture();for(const key of ["receiptRecords","receiptMs","receiptBytes"] as const){const repo=Repository.init(join(root,key));const path=join(repo.controlDirectory,"legacy-value.json");writeFileSync(path,"original destination");const limit=verificationLimits[key];verificationLimits[key]=0;
  try{assert.throws(()=>writePrivateJson(path,{value:"replacement"}),error=>error instanceof VerificationRefusal&&error.verifier==="receipts");assert.equal(readFileSync(path,"utf8"),"original destination");}finally{verificationLimits[key]=limit;}
 }
});


test("process lease acquisition retries changing observations, preserves peers and bounds repeated contention",async()=>{
 const root=await fixture();const repo=Repository.init(join(root,"owner-interleavings"));const path=join(repo.controlDirectory,"owner.lock");const link=fs.linkSync;const stat=fs.lstatSync;
 mock.method(fs,"linkSync",(...args:Parameters<typeof fs.linkSync>)=>{if(args[1]===path)throw Object.assign(new Error("competing link vanished"),{code:"EEXIST"});return link(...args);});syncBuiltinESMExports();assert.throws(()=>durability.claim(path,"fixture_locked"),{code:"fixture_locked"});mock.restoreAll();syncBuiltinESMExports();assert.equal(existsSync(path),false);assert.equal(objectFiles.active.size,0);
 mock.method(fs,"linkSync",(...args:Parameters<typeof fs.linkSync>)=>{if(args[1]===path)throw Object.assign(new Error("native publication failed"),{code:"EIO"});return link(...args);});syncBuiltinESMExports();assert.throws(()=>durability.claim(path,"fixture_locked"),{code:"EIO"});mock.restoreAll();syncBuiltinESMExports();assert.equal(objectFiles.active.size,0);
 const live=durability.claim(path,"fixture_locked");let observations=0;mock.method(fs,"lstatSync",(...args:Parameters<typeof fs.lstatSync>)=>{const value=stat(...args);if(args[0]===path&&typeof args[1]==="object"&&args[1]?.bigint&&++observations===2)return undefined;return value;});syncBuiltinESMExports();assert.throws(()=>durability.claim(path,"fixture_locked"),{code:"fixture_locked"});mock.restoreAll();syncBuiltinESMExports();live.verify();live.release();
 for(const code of ["destructive_target_changed","EIO"]){writeFileSync(path,"");const held=lstatSync(path,{bigint:true});const parent=lstatSync(dirname(path),{bigint:true});writeFileSync(path,JSON.stringify({format:"pm-vcs-process-lease-1",pid:2_147_483_647,identity:`${held.dev}:${held.ino}:${held.birthtimeNs}`,parent:`${parent.dev}:${parent.ino}:${parent.birthtimeNs}`,name:"owner.lock",owner:"a".repeat(32)}));
  const remove=durability.unlinkOwner;let raced=false;mock.method(durability,"unlinkOwner",(...args:Parameters<typeof durability.unlinkOwner>)=>{if(args[0]===path&&!raced){raced=true;if(code==="destructive_target_changed")throw new DestructionRefusal(code,"competing transition");throw Object.assign(new Error("native recovery failure"),{code});}return remove(...args);});
  if(code==="EIO")assert.throws(()=>durability.claim(path,"fixture_locked"),{code});else{const next=durability.claim(path,"fixture_locked");next.release();}mock.restoreAll();syncBuiltinESMExports();if(existsSync(path))rmSync(path);assert.equal(objectFiles.active.size,0);
 }
});


test("publication recovery interleaves a peer at every protocol boundary without adopting its authority",async t=>{
 const root=await fixture();
 const run=(name:string,at?:string):Set<string>=>{const repo=Repository.init(join(root,name));const target=join(repo.controlDirectory,"peer.json");let first=true;
  destructionBoundary.visit=(step)=>{if(first&&step==="deleted"&&existsSync(target)){first=false;throw new Error("predecessor interruption");}};assert.throws(()=>writePrivateJson(target,{value:1}));destructionBoundary.visit=()=>{};
  const steps=new Set<string>();let injected=false;destructionBoundary.visit=(step)=>{steps.add(step);if(step===at&&!injected){injected=true;destructionBoundary.visit=()=>{};try{writePrivateJson(target,{value:2});}catch(error){assert.ok(error instanceof DestructionRefusal);}}};
  try{writePrivateJson(target,{value:3});}catch(error){assert.ok(error instanceof DestructionRefusal);assert.ok(["destructive_intent_changed","destructive_intent_locked","destructive_target_changed"].includes(error.code));}finally{destructionBoundary.visit=()=>{};}
  if(at!==undefined)assert.ok(injected);writePrivateJson(target,{value:3});assert.deepEqual(JSON.parse(readFileSync(target,"utf8")),{value:3});assert.equal(inspectDestructions(repo.controlDirectory).pending,0);assert.equal(objectFiles.active.size,0);return steps;
 };
 const steps=run("probe");let count=0;for(const step of steps)run(`peer-${count++}`,step);t.diagnostic(`${count} competing publication boundary schedules; fresh rerun completes the current receipt`);
});


test("a fresh control root and a separate deep journal both survive their first owner publication",async()=>{
 const root=await fixture();const template=join(root,"template");sequence(template,"deep-intent",-1);const probe=sequence(join(root,"probe"),"deep-intent",0,template);const cut=probe.steps.indexOf("file-unlinked")+1;assert.ok(cut>0);sequence(join(root,"fixed-cut"),"deep-intent",cut,template);
});


test("exclusive publication rechecks its pinned source and the destination for every mutable identity field",async()=>{
 const root=await fixture();const repo=Repository.init(join(root,"link-identities"));const source=join(repo.controlDirectory,"source");const target=join(repo.controlDirectory,"linked");const stat=fs.lstatSync;
 for(const field of ["ino","size","mtimeNs"] as const){writeFileSync(source,"owned source");let changed=false;mock.method(fs,"lstatSync",(...args:Parameters<typeof fs.lstatSync>)=>{const value=stat(...args);if(args[0]===target&&typeof args[1]==="object"&&args[1]?.bigint&&!changed){changed=true;return {...value,[field]:(value as fs.BigIntStats)[field]+1n};}return value;});syncBuiltinESMExports();
  assert.throws(()=>durability.link(source,target),{code:"worktree_path_changed"});assert.ok(changed);assert.equal(readFileSync(target,"utf8"),"owned source");mock.restoreAll();syncBuiltinESMExports();rmSync(target);rmSync(source);assert.equal(objectFiles.active.size,0);
 }
});

test("destructive snapshots retain read-only source compatibility and preserve unrelated native open failures",async()=>{
 const root=await fixture();const repo=Repository.init(join(root,"readonly"));const path=join(repo.controlDirectory,"candidate");const open=fs.openSync;
 for(const code of ["EACCES","EROFS","EIO"]){writeFileSync(path,"owned candidate");mock.method(fs,"openSync",(...args:Parameters<typeof fs.openSync>)=>{if(args[0]===path&&typeof args[1]==="number"&&(args[1]&fs.constants.O_RDWR)!==0)throw Object.assign(new Error("source open denied"),{code});return open(...args);});syncBuiltinESMExports();
  if(code==="EIO"){assert.throws(()=>prepareDestruction(repo.controlDirectory,code,[{path}]),{code});assert.equal(readFileSync(path,"utf8"),"owned candidate");}
  else{const plan=prepareDestruction(repo.controlDirectory,code,[{path}]);for(const member of plan.paths)plan.remove(member);assert.equal(plan.finish().status,"completed");assert.equal(existsSync(path),false);}
  mock.restoreAll();syncBuiltinESMExports();assert.equal(objectFiles.active.size,0);
 }
});


test("copied receipt capabilities cannot certify a different publication action",async()=>{
 const root=await fixture();for(const mode of ["kind","destination","members"]){const repo=Repository.init(join(root,mode));const target=join(repo.controlDirectory,"value.json");const peer=join(repo.controlDirectory,"peer");writeFileSync(peer,"foreign tripwire");let path="";let crash=true;
  destructionBoundary.visit=(step)=>{if(crash&&step==="deleted"&&existsSync(target)){crash=false;const directory=join(ledger(repo.controlDirectory),"destruction");path=readdirSync(directory).filter(name=>name.endsWith(".json")).map(name=>join(directory,name)).find(path=>{const row=JSON.parse(readFileSync(path,"utf8")) as {entries:{destination?:string}[]};return row.entries.some(entry=>entry.destination?.endsWith("value.json"));})!;throw new Error("interrupted publication");}};
  assert.throws(()=>writePrivateJson(target,{value:1}));destructionBoundary.visit=()=>{};assert.ok(path);const record=JSON.parse(readFileSync(path,"utf8")) as {entries:Record<string,unknown>[]};const entry=record.entries[0];
  if(mode==="kind"){entry.kind="file";delete entry.destination;delete entry.target;delete entry.destinationParentIdentity;}else if(mode==="destination")entry.destination="peer";else record.entries.push({...entry,path:"unrelated.tmp"});
  const copied=JSON.stringify(record);writeFileSync(path,copied);assert.throws(()=>writePrivateJson(target,{value:2}),{code:"foreign_destructive_intent"});assert.equal(readFileSync(path,"utf8"),copied);assert.deepEqual(JSON.parse(readFileSync(target,"utf8")),{value:1});assert.equal(readFileSync(peer,"utf8"),"foreign tripwire");assert.equal(objectFiles.active.size,0);
 }
});


test("receipt inspection accounts interrupted renames without adopting absent or replaced destinations",async()=>{
 const root=await fixture();for(const mode of ["moved","absent","foreign","directory"]){const repo=Repository.init(join(root,mode));const source=join(repo.controlDirectory,"source.tmp");const target=join(repo.controlDirectory,"destination");writeFileSync(source,"owned publication");let once=true;
  destructionBoundary.visit=(step)=>{if(once&&step==="deleted"&&existsSync(target)){once=false;throw new Error("unacknowledged rename");}};assert.throws(()=>durability.rename(source,target));destructionBoundary.visit=()=>{};
  if(mode!=="moved"){rmSync(target);if(mode==="foreign")writeFileSync(target,"peer copy");if(mode==="directory")mkdirSync(target);}
  const inventory=inspectDestructions(repo.controlDirectory);assert.equal(inventory.pending,0);const receipt=inventory.receipts.find(row=>row.planned===1&&row.moved===(mode==="moved"?1:0)&&row.skipped===(mode==="moved"?0:1));assert.ok(receipt);assert.equal(receipt.status,"completed");
  if(mode==="foreign")assert.equal(readFileSync(target,"utf8"),"peer copy");if(mode==="directory")assert.ok(lstatSync(target).isDirectory());
 }
});


test("interrupted compact cleanup retires every original namespace receipt",async()=>{
 const root=await fixture();const repo=Repository.init(join(root,"compact"));const bytes=Buffer.from("retained staged cleanup object");const id=repo.objects.write("blob",bytes);repo.refs.compareAndSwap("refs/metadata/live",null,id);repo.objects.compact();const path=join(repo.objects.storageRoot(),"packs",`job-${"a".repeat(24)}`);const record=pendingDirectory(repo,path);const result=repo.objects.compact();assert.equal(result.destruction.status,"completed");assert.equal(existsSync(path),false);assert.equal((JSON.parse(readFileSync(record,"utf8")) as {status:string}).status,"completed");assert.deepEqual(repo.objects.readTyped(id,"blob"),bytes);
});


test("durable-image caching preserves every uncached power boundary and crash image",async t=>{
 const root=await fixture();const results:{trace:string[];cuts:number[]}[]=[];
 for(const cache of [true,false]){const repo=Repository.init(join(root,cache?"cached":"oracle"));const owned=ledger(repo.controlDirectory);rmSync(owned,{recursive:true,force:true});const power=new NamespacePowerLoss([repo.root,owned],0,[],cache,cache);
  try{power.install();writePrivateJson(join(repo.controlDirectory,"nested/new/value.json"),{value:"cache equivalence"});const empty=join(repo.controlDirectory,"empty");mkdirSync(empty);durability.removeDirectory(empty);results.push({trace:[...power.trace],cuts:[...power.recoveryCuts]});power.replay();writePrivateJson(join(repo.controlDirectory,"nested/new/value.json"),{value:"cache equivalence"});assert.equal(inspectDestructions(repo.controlDirectory).pending,0);}finally{power.close();rmSync(owned,{recursive:true,force:true});}
 }
 assert.deepEqual(results[0].trace,results[1].trace);assert.deepEqual(results[0].cuts,results[1].cuts);t.diagnostic(`${results[0].trace.length} native boundaries and ${results[0].cuts.length} full crash images agree with the uncached oracle`);
});


/** Persist a real empty-directory intent and interrupt before its first native retirement. */
function pendingDirectory(repo:Repository,path:string):string {
 mkdirSync(path,{recursive:true});destructionBoundary.visit=step=>{if(step==="intent-persisted")throw new Error("directory interruption");};try{assert.throws(()=>durability.removeDirectory(path));}finally{destructionBoundary.visit=()=>{};}
 const directory=join(ledger(repo.controlDirectory),"destruction");return readdirSync(directory).filter(name=>name.endsWith(".json")).map(name=>join(directory,name)).find(path=>{const row=JSON.parse(readFileSync(path,"utf8")) as {entries:{kind:string}[]};return row.entries.some(entry=>entry.kind==="directory");})!;
}

test("directory receipt recovery preserves every foreign class and truthfully completes a peer retirement",async t=>{
 const root=await fixture();let count=0;for(const mode of ["none","foreign-json","nonregular","root-retired","kind","path","replaced","file","child","io","peer"]){const repo=Repository.init(join(root,mode));const path=join(repo.objects.storageRoot(),"packs",`job-${"e".repeat(24)}`);let record="";
  if(mode==="none")mkdirSync(path,{recursive:true});else record=pendingDirectory(repo,path);
  if(mode==="foreign-json")writeFileSync(record,"{foreign");if(mode==="nonregular"){rmSync(record);mkdirSync(record);}
  if(["root-retired","kind","path"].includes(mode)){const row=JSON.parse(readFileSync(record,"utf8")) as {rootIdentity:string;entries:{kind:string;path:string}[]};if(mode==="root-retired")row.rootIdentity="0:0:0";if(mode==="kind")row.entries[0].kind="file";if(mode==="path")row.entries[0].path="another-directory";writeFileSync(record,JSON.stringify(row));}
  if(mode==="replaced"||mode==="file"){rmSync(path,{recursive:true});if(mode==="file")writeFileSync(path,"foreign leaf");else mkdirSync(path);}
  if(mode==="child")writeFileSync(join(path,"foreign"),"peer payload");
  if(mode==="io"){const remove=fs.rmdirSync;mock.method(fs,"rmdirSync",(...args:Parameters<typeof fs.rmdirSync>)=>{if(args[0]===path)throw Object.assign(new Error("directory I/O interruption"),{code:"EIO"});return remove(...args);});syncBuiltinESMExports();assert.throws(()=>durability.resumeDirectory(path));mock.restoreAll();syncBuiltinESMExports();assert.ok(existsSync(path));assert.equal(durability.resumeDirectory(path),true);assert.equal(existsSync(path),false);}
  else if(mode==="peer"){let injected=false;destructionBoundary.visit=step=>{if(step==="owner-opened"&&!injected){injected=true;destructionBoundary.visit=()=>{};assert.equal(durability.resumeDirectory(path),true);}};assert.equal(durability.resumeDirectory(path),true);destructionBoundary.visit=()=>{};assert.ok(injected);assert.equal(existsSync(path),false);}
  else {assert.equal(durability.resumeDirectory(path),false);assert.ok(existsSync(path));if(mode==="child")assert.equal(readFileSync(join(path,"foreign"),"utf8"),"peer payload");}
  assert.equal(objectFiles.active.size,0);count++;
 }t.diagnostic(`${count} foreign, retired, changed, I/O and peer directory recovery cases`);
});


test("power-model identities survive native inode reuse during packed recovery",async()=>{
 const root=await fixture();for(const [kind,step] of [["compact","staged"],["unpack","owner"]] as const){const template=join(root,kind+"-template");sequence(template,kind,-1);sequence(join(root,kind+"-cut"),kind,0,template,step);}
});


test("directory recovery interleaves a competing drainer at every protocol boundary",async t=>{
 const root=await fixture();const run=(name:string,at?:string):Set<string>=>{const repo=Repository.init(join(root,name));const path=join(repo.objects.storageRoot(),"packs",`job-${"f".repeat(24)}`);const record=pendingDirectory(repo,path);const steps=new Set<string>();let injected=false;
  destructionBoundary.visit=step=>{steps.add(step);if(step===at&&!injected){injected=true;destructionBoundary.visit=()=>{};try{durability.resumeDirectory(path);}catch(error){assert.ok(error instanceof DestructionRefusal);assert.equal(error.code,"destructive_intent_locked");}}};
  assert.equal(durability.resumeDirectory(path),true);destructionBoundary.visit=()=>{};if(at!==undefined)assert.ok(injected);assert.equal(durability.resumeDirectory(path),true);assert.equal(existsSync(path),false);assert.equal((JSON.parse(readFileSync(record,"utf8")) as {status:string}).status,"completed");assert.equal(objectFiles.active.size,0);return steps;
 };
 const steps=run("probe");let count=0;for(const step of steps)run(`drainer-${count++}`,step);t.diagnostic(`${count} directory recovery peer schedules preserve original receipt completion and idempotent peer success`);
});
