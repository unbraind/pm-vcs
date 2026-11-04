import "./helpers/isolate-session.ts";
import { prepareControlPublication } from "./helpers/prepared-publication.ts";
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
import { destructionBoundary, DestructionRefusal, inspectDestructions, prepareDestruction, retireNamespace } from "../engine/destruction.ts";
import { objectFiles } from "../engine/object-files.ts";
import { durability, durabilityCapabilities } from "../engine/durability.ts";
import { collectGarbage } from "../engine/gc.ts";
import { verificationLimits, VerificationRefusal } from "../engine/object-error.ts";
import { packBoundary } from "../engine/packs.ts";
import { WorktreeMutation } from "../engine/worktree-mutation.ts";
import { packageRoot } from "./helpers/tmp.ts";
import { fixture, ledger, sequence, sequences, registerJournalCleanup } from "./helpers/journal-sequences.ts";
import { NamespacePowerLoss } from "./helpers/namespace-power-loss.ts";
import { abandonProcessStage } from "./helpers/process-stage.ts";
registerJournalCleanup();
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


test("every native power scenario has one isolated test entrypoint",()=>{
 const actual=readdirSync(join(packageRoot,"test")).filter(name=>name.startsWith("journal-power-")&&name.endsWith(".test.ts")).sort();
 assert.deepEqual(actual,sequences.map(kind=>`journal-power-${kind}.test.ts`).sort(),"every recorded power scenario must run exactly once");
});

test("power-model probes exercise EVERY engine publication and retirement sequence",async()=>{
 const root=await fixture();for(const kind of sequences){const result=sequence(join(root,kind),kind,0);assert.ok(result.steps.length>0);console.log(`power probe ${kind}: ${result.steps.length} native boundaries, ${result.cuts.length} distinct full crash images`);}
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
 const root=await fixture();const template=join(root,"template");sequence(template,"ref-retirement",-1);const probe=sequence(join(root,"probe"),"ref-retirement",0,template);const unlinks=probe.steps.flatMap((step,index)=>step==="file-unlinked"?[index]:[]);assert.ok(unlinks.length>1);const result=sequence(join(root,"fixed-cut"),"ref-retirement",unlinks.at(-2)!+1,template);assert.equal(result.interruptedAt,"file-unlinked");
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


test("power-model hooks restore function identities across nested fault-injection scopes",async()=>{
 const root=await fixture();const open=fs.openSync;const kill=process.kill;
 const methods=["openSync","closeSync","lstatSync","fstatSync","mkdirSync","writeSync","writeFileSync","appendFileSync","fsyncSync","linkSync","renameSync","unlinkSync","rmdirSync"] as const;
 const original=methods.map(name=>[name,fs[name]] as const);
 for(const recorded of [false,true])for(const outer of [false,true]){
  const directory=join(root,`${recorded}-${outer}`);mkdirSync(directory);
  if(outer)mock.method(fs,"openSync",(...args:Parameters<typeof fs.openSync>)=>open(...args));
  const power=new NamespacePowerLoss([directory],0,[],true,false,recorded);let nested=0;
  try{power.install();const active=fs.openSync;assert.equal(active.name,open.name);assert.equal(active.length,open.length);mock.method(fs,"openSync",(...args:Parameters<typeof fs.openSync>)=>{nested++;return active(...args);});syncBuiltinESMExports();const path=join(directory,"kept");writeFileSync(path,"retained");const fd=fs.openSync(path,"r");fs.closeSync(fd);assert.ok(nested>0);assert.ok(power.trace.length>0);}
  finally{power.close();}
  for(const [name,value]of original)assert.equal(fs[name],value,`closed model restores ${name}`);
  assert.equal(process.kill,kill);assert.equal(readFileSync(join(directory,"kept"),"utf8"),"retained");
 }
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


/** Leave the original publication source and durable exact-set receipt for recovery fault injection. */
function pendingPublication(repo:Repository):{source:string;target:string;record:string}{
 const source=join(repo.controlDirectory,"older.tmp");const target=join(repo.controlDirectory,"next.json");writeFileSync(source,"original source");writeFileSync(target,"original destination");destructionBoundary.visit=step=>{if(step==="intent-persisted")throw new Error("publication intent interruption");};try{assert.throws(()=>durability.rename(source,target));}finally{destructionBoundary.visit=()=>{};}
 const directory=join(ledger(repo.controlDirectory),"destruction");const record=readdirSync(directory).filter(name=>name.endsWith(".json")).map(name=>join(directory,name)).find(path=>{const row=JSON.parse(readFileSync(path,"utf8")) as {entries:{destination?:string}[]};return row.entries.some(entry=>entry.destination?.endsWith("next.json"));})!;return{source,target,record};
}

test("publication recovery refuses vanished sources, missing authority and native failures before replacing data",async()=>{
 const root=await fixture();for(const mode of ["missing-source","missing-intent","native-error","root-retired"]){const repo=Repository.init(join(root,mode));const f=pendingPublication(repo);
  if(mode==="root-retired"){const row=JSON.parse(readFileSync(f.record,"utf8")) as {rootIdentity:string};row.rootIdentity="0:0:0";writeFileSync(f.record,JSON.stringify(row));writePrivateJson(f.target,{value:2});assert.deepEqual(JSON.parse(readFileSync(f.target,"utf8")),{value:2});assert.ok(existsSync(f.source));continue;}
  if(mode==="native-error"){const rename=fs.renameSync;mock.method(fs,"renameSync",(...args:Parameters<typeof fs.renameSync>)=>{if(args[0]===f.source)throw Object.assign(new Error("original rename I/O failure"),{code:"EIO"});return rename(...args);});syncBuiltinESMExports();}
  else{let injected=false;destructionBoundary.visit=step=>{if(step==="owner-opened"&&!injected){injected=true;destructionBoundary.visit=()=>{};if(mode==="missing-intent")rmSync(f.record);else{const temporary=readdirSync(repo.controlDirectory).find(name=>/^next\.json\.[0-9a-f]{12}\.tmp$/.test(name))!;rmSync(join(repo.controlDirectory,temporary));}}};}
  assert.throws(()=>writePrivateJson(f.target,{value:2}));destructionBoundary.visit=()=>{};mock.restoreAll();syncBuiltinESMExports();assert.equal(readFileSync(f.target,"utf8"),"original destination");assert.equal(readFileSync(f.source,"utf8"),"original source");
 }
 for(const afterScan of [false,true]){const repo=Repository.init(join(root,String(afterScan)));const source=join(repo.controlDirectory,"incoming.tmp");const target=join(repo.controlDirectory,"target");writeFileSync(source,"incoming");writeFileSync(target,"tripwire");let injected=false;
  if(afterScan){const scan=fs.readdirSync;mock.method(fs,"readdirSync",(...args:Parameters<typeof fs.readdirSync>)=>{const result=scan(...args);if(args[0]===join(ledger(repo.controlDirectory),"destruction")&&!injected){injected=true;rmSync(source);}return result;});syncBuiltinESMExports();}
  else destructionBoundary.visit=step=>{if(step==="owner-opened"&&!injected){injected=true;destructionBoundary.visit=()=>{};rmSync(source);}};
  assert.throws(()=>retireNamespace({path:source,destination:target}),{code:"destructive_target_changed"});destructionBoundary.visit=()=>{};mock.restoreAll();syncBuiltinESMExports();assert.ok(injected);assert.equal(readFileSync(target,"utf8"),"tripwire");
 }
});

test("same-source legacy receipts and foreign names preserve compatible publication recovery",async()=>{
 const root=await fixture();for(const mode of ["plain","stamped","foreign"]){const repo=Repository.init(join(root,mode));const f=pendingPublication(repo);const row=JSON.parse(readFileSync(f.record,"utf8")) as {root:string;entries:{identity:string}[]};const key=`rename:${f.source}:${f.target}${mode==="stamped"?":"+row.entries[0].identity:""}`;const legacy=join(ledger(repo.controlDirectory),"destruction",(mode==="foreign"?"f".repeat(64):createHash("sha256").update(`${row.root}\0${key}`).digest("hex"))+".json");fs.renameSync(f.record,legacy);
  if(mode==="foreign"){const bytes=readFileSync(legacy,"utf8");writePrivateJson(f.target,{value:2});assert.equal(readFileSync(legacy,"utf8"),bytes);assert.equal(readFileSync(f.source,"utf8"),"original source");}
  else{durability.rename(f.source,f.target);assert.equal((JSON.parse(readFileSync(legacy,"utf8")) as {status:string}).status,"completed");assert.equal(readFileSync(f.target,"utf8"),"original source");}
 }
 const repo=Repository.init(join(root,"missing"));const f=pendingPublication(repo);assert.throws(()=>retireNamespace({path:join(repo.controlDirectory,"missing-source"),destination:f.target}),{code:"destructive_target_changed"});
 const source=join(repo.controlDirectory,"fresh-source");writeFileSync(source,"owned");const original=prepareDestruction(repo.controlDirectory,"missing-native",[{path:source,destination:f.target}]);assert.throws(()=>prepareDestruction(repo.controlDirectory,"missing-native",[{path:join(repo.controlDirectory,"absent"),destination:f.target}]),{code:"destructive_target_changed"});for(const path of original.paths)original.remove(path);original.finish();
 const dir=join(repo.controlDirectory,"directory");pendingDirectory(repo,dir);const bound=verificationLimits.receiptBytes;verificationLimits.receiptBytes=0;try{assert.throws(()=>durability.resumeDirectory(dir),error=>error instanceof VerificationRefusal&&error.bound==="record_bytes");assert.ok(existsSync(dir));}finally{verificationLimits.receiptBytes=bound;}
});

/** Namespace operations may alter ctime, but restoration must never fabricate a content-write mtime. */
test("restored native mtime changes only after content writes, across every alias mutation",async()=>{
 const root=await fixture();for(const cache of [true,false]){const repo=Repository.init(join(root,String(cache)));const source=join(repo.controlDirectory,"source");const alias=source+".alias";writeFileSync(source,"durable source");fs.utimesSync(source,new Date(1000),new Date(1000));fs.linkSync(source,alias);const before=lstatSync(source,{bigint:true});const power=new NamespacePowerLoss([repo.root,ledger(repo.controlDirectory)],0,[],cache,cache);
  try{power.install();power.crashAfterReturn();power.replay();durability.link(source,source+".second");assert.equal(lstatSync(source,{bigint:true}).mtimeNs,before.mtimeNs);durability.rename(alias,alias+".moved");assert.equal(lstatSync(source,{bigint:true}).mtimeNs,before.mtimeNs);durability.unlink(alias+".moved");assert.equal(lstatSync(source,{bigint:true}).mtimeNs,before.mtimeNs);assert.equal(readFileSync(source,"utf8"),"durable source");writeFileSync(source,"new content");assert.notEqual(lstatSync(source,{bigint:true}).mtimeNs,before.mtimeNs);assert.equal(readFileSync(source,"utf8"),"new content");assert.equal(inspectDestructions(repo.controlDirectory).pending,0);}finally{power.close();}
 }
});

/** Replay the exact acknowledged boundary cheaply in addition to each sequence's complete crash-image matrix. */
test("acknowledged packed transactions recover twice without inheriting restoration metadata",async()=>{
 const root=await fixture();for(const kind of ["repack","gc-packed","obliterate","obliterate-packed"] as const){const template=join(root,kind+"-seed");sequence(template,kind,-1);const probe=sequence(join(root,kind+"-probe"),kind,0,template);sequence(join(root,kind+"-terminal"),kind,probe.steps.length,template);if(kind==="obliterate-packed")sequence(join(root,kind+"-unpacked"),kind,0,template,"unpacked");}
});

/** Changing/foreign legacy observations cannot certify unrelated failures or adopt another receipt's authority. */
test("legacy scans skip a retired observation and propagate unrelated typed and native failures",async()=>{
 const root=await fixture();for(const mode of ["retired","typed","native"]){const repo=Repository.init(join(root,mode));const old=pendingPublication(repo);const target=join(repo.controlDirectory,"new-value.json");writeFileSync(target,"retained destination");let injected=false;const fault=mode==="typed"?new DestructionRefusal("destructive_plan_conflict","nested ownership refusal"):Object.assign(new Error("native read failed"),{code:"EIO"});
  objectFiles.opened=(_file,path)=>{if(path!==old.record||injected)return;injected=true;if(mode==="retired")rmSync(old.record);else throw fault;};
  try{if(mode==="retired"){writePrivateJson(target,{value:2});assert.deepEqual(JSON.parse(readFileSync(target,"utf8")),{value:2});}else{assert.throws(()=>writePrivateJson(target,{value:2}),error=>error===fault);assert.equal(readFileSync(target,"utf8"),"retained destination");}}finally{objectFiles.opened=()=>{};}
  assert.ok(injected);assert.equal(readFileSync(old.source,"utf8"),"original source");assert.equal(readFileSync(old.target,"utf8"),"original destination");assert.equal(objectFiles.active.size,0);
 }
});


test("released inline terminal publication checkpoints finalize before a fresh value and never report the old value as success",async()=>{
 const root=await fixture();for(const legacy of [false,true]){const repo=Repository.init(join(root,legacy?"legacy-inline":"inline"));const target=join(repo.controlDirectory,"metadata.json");writePrivateJson(target,{value:1});let interrupted=false;const cut=Object.assign(new Error("inline acknowledgment interruption"),{code:"EINJECTED"});destructionBoundary.visit=step=>{if(!interrupted&&step==="progress-persisted"&&JSON.parse(readFileSync(target,"utf8")).value===2){interrupted=true;throw cut;}};try{assert.throws(()=>writePrivateJson(target,{value:2}));}finally{destructionBoundary.visit=()=>{};}assert.ok(interrupted);const directory=join(ledger(repo.controlDirectory),"destruction");let record=readdirSync(directory).filter(name=>name.endsWith(".json")).map(name=>join(directory,name)).find(path=>{const row=JSON.parse(readFileSync(path,"utf8"))as{status:string;entries:{destination?:string}[]};return row.status==="pending"&&row.entries.some(entry=>entry.destination==="metadata.json");})!;const row=JSON.parse(readFileSync(record,"utf8"))as{root:string;id:string;status:string;entries:{path:string;destination:string;identity:string;status:string}[]};row.entries[0]!.status="moved";writeFileSync(record,JSON.stringify(row));if(legacy){const entry=row.entries[0]!;const key=`rename:${resolve(row.root,entry.path)}:${resolve(row.root,entry.destination)}:${entry.identity}`;const old=join(directory,createHash("sha256").update(`${row.root}\0${key}`).digest("hex")+".json");fs.renameSync(record,old);record=old;}
  writePrivateJson(target,{value:3});assert.deepEqual(JSON.parse(readFileSync(target,"utf8")),{value:3});assert.equal((JSON.parse(readFileSync(record,"utf8"))as{status:string}).status,"completed");assert.equal(inspectDestructions(repo.controlDirectory).pending,0);
 }
});
