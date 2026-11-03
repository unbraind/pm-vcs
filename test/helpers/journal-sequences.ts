/** Shared native power scenarios; each entrypoint owns its SDK fixture and filesystem hooks. */
import assert from "node:assert/strict";
import fs, { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../../engine/repo.ts";
import { ObjectStore, hashObject } from "../../engine/objects.ts";
import { writePrivateJson } from "../../engine/composition.ts";
import { destructionBoundary, inspectDestructions, prepareDestruction } from "../../engine/destruction.ts";
import { objectFiles } from "../../engine/object-files.ts";
import { durability, durabilityCapabilities } from "../../engine/durability.ts";
import { collectGarbage } from "../../engine/gc.ts";
import { packBoundary } from "../../engine/packs.ts";
import { WorktreeMutation } from "../../engine/worktree-mutation.ts";
import { makeTempDir } from "./tmp.ts";
import { NamespacePowerLoss } from "./namespace-power-loss.ts";
import { abandonProcessStage } from "./process-stage.ts";
import { prepareControlPublication } from "./prepared-publication.ts";
const temporary: ReturnType<typeof makeTempDir>[] = [];
const capability = durabilityCapabilities.directorySync;
export function registerJournalCleanup(): void { afterEach(() => { mock.reset(); syncBuiltinESMExports(); destructionBoundary.visit = () => {}; packBoundary.visit = () => {}; durabilityCapabilities.directorySync = capability; assert.equal(objectFiles.active.size, 0); for (const dir of temporary.splice(0)) dir.cleanup(); }); }
/** Keep every native store below a single SDK initialized tracker, independent of Git discovery. */
export async function fixture() {
 const dir=makeTempDir();temporary.push(dir);process.env.GIT_CEILING_DIRECTORIES=dirname(dir.root);
 await new PmClient({cwd:dir.root,pmRoot:join(dir.root,".agents/pm"),noExtensions:true}).init("journal-power",{defaults:true,author:"fixture"});return dir.root;
}
/** Derive only the exact private ledger owned by this disposable control root. */
export function ledger(control:string):string{return join(tmpdir(),`pm-vcs-namespace-${createHash("sha256").update(fs.realpathSync(control)).digest("hex")}`);}

export const sequences = ["ref-retirement","ref-replacement","compact","unpack","repack","gc-loose","gc-packed","lease-cleanup","prune","oplog","deep-intent","recovery","obliterate","obliterate-packed","directory-recovery","publication-recovery","legacy-publication-recovery","process-stage-recovery","ref-cas-recovery","ref-cas-cancel"] as const;
export type Sequence = typeof sequences[number];
/** One prepared native store below the real tracker exercises a complete engine write-then-retire path. */
export function sequence(root:string,kind:Sequence,cut:number,template?:string,packStep?:string,recordHookCalls=false):{steps:string[];cuts:number[];interruptedAt:string|undefined}{
 if(template!==undefined)cpSync(template,root,{recursive:true,filter:path=>path!==join(template,".pmvcs/destruction")});
 const repo=template===undefined?Repository.init(root):Repository.open(root);const bytes=Buffer.from("retained native power object");const live=hashObject("blob",bytes);const garbage=hashObject("blob",Buffer.from("discardable native power object"));
 if(template===undefined){repo.objects.write("blob",bytes);repo.refs.compareAndSwap("refs/metadata/live",null,live);repo.objects.write("blob",Buffer.from("discardable native power object"));}const ref="refs/metadata/temporary";
 if(template===undefined&&(kind==="ref-retirement"||kind==="ref-replacement"||kind==="ref-cas-recovery"||kind==="ref-cas-cancel"))repo.refs.compareAndSwap(ref,null,live);
 if(template===undefined&&(kind==="unpack"||kind==="repack"||kind==="gc-packed"))repo.objects.compact();
 if(template===undefined&&kind==="repack")repo.objects.write("blob",Buffer.from("new repack member"));
 const lease=join(repo.controlDirectory,"fixture.lock");if(template===undefined&&kind==="lease-cleanup")writeFileSync(lease,"owned lease fixture");
 if(template===undefined&&kind==="prune")mkdirSync(join(root,"empty/a/b"),{recursive:true});if(template===undefined)writeFileSync(join(root,"guard"),"foreign tripwire");
 const paths=[join(root,"candidate-a"),join(root,"candidate-b")];if(template===undefined&&kind==="deep-intent")for(const path of paths)writeFileSync(path,"owned candidate");
 if(template===undefined&&kind==="recovery")writeFileSync(join(repo.controlDirectory,"objects.lock"),"2147483647");
 const erasing=kind==="obliterate"||kind==="obliterate-packed";
 let fileId="";if(template===undefined&&erasing){writeFileSync(join(root,"asset"),"selected power payload 917364852");repo.stage(["asset"]);fileId=repo.readIndex()[0].fileId!;repo.setAuthority("fixture","read-power","erase-power");if(kind==="obliterate-packed")repo.objects.compact();}
 if(template!==undefined&&erasing)fileId=repo.readIndex()[0].fileId!;
 const selected=erasing?repo.readIndex()[0].id:undefined;
 const owned=ledger(repo.controlDirectory);rmSync(owned,{recursive:true,force:true});if(cut<0)return{steps:[],cuts:[],interruptedAt:undefined};
 const recoveringDirectory=join(repo.objects.storageRoot(),"packs",`job-${"d".repeat(24)}`);const recoveringPublication=join(repo.controlDirectory,"recover-publication.json");
 if(kind==="directory-recovery"){mkdirSync(recoveringDirectory,{recursive:true});destructionBoundary.visit=step=>{if(step==="intent-persisted")throw new Error("directory intent interruption");};try{assert.throws(()=>durability.removeDirectory(recoveringDirectory));}finally{destructionBoundary.visit=()=>{};}}
 if(kind==="publication-recovery"||kind==="legacy-publication-recovery"){let crash=true;destructionBoundary.visit=step=>{if(crash&&step==="deleted"&&existsSync(recoveringPublication)){crash=false;throw new Error("publication interruption");}};try{assert.throws(()=>writePrivateJson(recoveringPublication,{value:1}));}finally{destructionBoundary.visit=()=>{};}
  if(kind==="legacy-publication-recovery"){const directory=join(owned,"destruction");const path=readdirSync(directory).filter(name=>name.endsWith(".json")).map(name=>join(directory,name)).find(path=>{const row=JSON.parse(readFileSync(path,"utf8")) as {entries:{destination?:string}[]};return row.entries.some(entry=>entry.destination?.endsWith("recover-publication.json"));})!;const row=JSON.parse(readFileSync(path,"utf8")) as {root:string;entries:{path:string;destination:string;identity:string}[]};const entry=row.entries[0];const key=`rename:${resolve(row.root,entry.path)}:${resolve(row.root,entry.destination)}:${entry.identity}`;fs.renameSync(path,join(directory,createHash("sha256").update(`${row.root}\0${key}`).digest("hex")+".json"));}
 }
 let preparedRef="";
 if(kind==="ref-cas-recovery"||kind==="ref-cas-cancel"){
  preparedRef=prepareControlPublication(repo,join(repo.controlDirectory,ref),`${garbage}\n`);
  if(kind==="ref-cas-cancel")repo.objects.withWriteLock(()=>{repo.objects.markStorageGeneration();const plan=prepareDestruction(repo.controlDirectory,"old-collector",[{path:join(repo.objects.storageRoot(),garbage.slice(0,2),garbage.slice(2))}]);for(const path of plan.paths)plan.remove(path);plan.finish();});
 }
 const processLock=join(repo.controlDirectory,"oplog.jsonl.lock");if(kind==="process-stage-recovery")abandonProcessStage(processLock);
 const deep=join(root,"receipts/a/b/c");const control=join(repo.controlDirectory,"fresh/a/b");
 const operation=():void=>{
  if(kind==="ref-retirement")repo.refs.compareAndSwap(ref,repo.refs.read(ref),null);
  else if(kind==="ref-replacement"||kind==="ref-cas-recovery")repo.refs.compareAndSwap(ref,repo.refs.read(ref),garbage);
  else if(kind==="ref-cas-cancel")repo.refs.compareAndSwap(ref,repo.refs.read(ref),live);
  else if(kind==="compact")repo.objects.compact();
  else if(kind==="unpack")repo.objects.unpack();
  else if(kind==="repack"){repo.objects.unpack();repo.objects.compact();}
  else if(kind==="gc-loose"||kind==="gc-packed")collectGarbage(repo,true);
  else if(kind==="lease-cleanup"){if(existsSync(lease)){const fd=fs.openSync(lease,"r+");durability.release(lease,fd);}}
  else if(kind==="prune"){const mutation=new WorktreeMutation(root,".pmvcs");try{mutation.prune();}finally{mutation.close();}}
  else if(kind==="oplog"){const recorded=new Error("already recorded under the native lease");try{repo.operations.append("power-case","durable retention evidence",[],new Date(1),undefined,()=>{if(repo.operations.read().some(operation=>operation.command==="power-case"))throw recorded;});}catch(error){if(error!==recorded)throw error;}}
  else if(kind==="deep-intent"){const plan=prepareDestruction(control,"power-set",paths.map(path=>({path})),false,deep);for(const path of plan.paths)plan.remove(path);assert.equal(plan.finish().status,"completed");}
  else if(kind==="recovery")repo.objects.withRecoveryValidation(()=>"validated",()=>collectGarbage(repo,true));
  else if(kind==="process-stage-recovery"){const lease=durability.claim(processLock,"fixture_locked");lease.release();}
  else if(kind==="directory-recovery"){durability.resumeDirectory(recoveringDirectory);assert.equal(existsSync(recoveringDirectory),false);}
  else if(kind==="publication-recovery"||kind==="legacy-publication-recovery")writePrivateJson(recoveringPublication,{value:2});
  else assert.equal(repo.obliterate(fileId,"erase-power","power-model",new Date(1),{purgeUnaccounted:true,recoverLock:existsSync(join(repo.controlDirectory,"objects.lock"))}).storage.accountable,true);
 };
 const power=new NamespacePowerLoss([root,owned],cut,[deep],true,false,recordHookCalls);let trace:string[]=[];let cuts:number[]=[];
 try{
  power.install();if(packStep!==undefined)packBoundary.visit=step=>{if(step===packStep&&(!erasing||existsSync(join(repo.objects.storageRoot(),selected!.slice(0,2),selected!.slice(2)))))power.interrupt();};if(cut>0||packStep!==undefined){assert.throws(operation);power.crash();packBoundary.visit=()=>{};}else operation();trace=[...power.trace];cuts=[...power.recoveryCuts];power.replay();
  if(kind!=="recovery"&&!erasing&&existsSync(join(repo.controlDirectory,"objects.lock")))repo.objects.recoverWriterLock();
  for(let attempt=0;attempt<2;attempt++)operation();
  assert.deepEqual(new ObjectStore(repo.objects.storageRoot()).readTyped(live,"blob"),bytes);assert.equal(readFileSync(join(root,"guard"),"utf8"),"foreign tripwire");const inventory=inspectDestructions(repo.controlDirectory);const pending=new Set(inventory.receipts.filter(row=>row.status==="pending").map(row=>row.id));const evidence:unknown[]=[];if(pending.size)for(const directory of [join(repo.controlDirectory,"destruction"),join(owned,"destruction")])if(existsSync(directory))for(const name of readdirSync(directory).filter(name=>name.endsWith(".json"))){const record=JSON.parse(readFileSync(join(directory,name),"utf8")) as {id:string;root:string;entries:{path:string;identity:string}[]};if(pending.has(record.id))evidence.push({name,operation:["gc-candidates","compact-loose","unpack-packs"].find(key=>createHash("sha256").update(`${record.root}\0${key}`).digest("hex")+".json"===name),entries:record.entries.map(entry=>{const stat=lstatSync(resolve(record.root,entry.path),{bigint:true,throwIfNoEntry:false});return{...entry,current:stat===undefined?null:`${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`};})});}assert.equal(inventory.pending,0,JSON.stringify(evidence));
  if(kind==="gc-loose"||kind==="gc-packed"||kind==="recovery")assert.equal(repo.objects.has(garbage),false);
  if(kind==="ref-retirement")assert.equal(repo.refs.read(ref),null);if(kind==="ref-replacement"||kind==="ref-cas-recovery")assert.equal(repo.refs.read(ref),garbage);if(kind==="ref-cas-cancel"){assert.equal(repo.refs.read(ref),live);assert.equal(repo.objects.has(garbage),false);assert.equal(existsSync(preparedRef),false);}
  if(kind==="lease-cleanup")assert.equal(existsSync(lease),false);if(kind==="prune")assert.equal(existsSync(join(root,"empty")),false);
  if(kind==="oplog")assert.equal(repo.operations.read().filter(operation=>operation.command==="power-case").length,1);
  if(kind==="deep-intent")for(const path of paths)assert.equal(existsSync(path),false);
  if(erasing){assert.equal(existsSync(join(root,"asset")),false);repo.objects.withWriteLock(()=>assert.equal([...repo.objects.walkErasureInventory()].some(entry=>entry.id===selected),false));assert.equal(repo.objects.denials().find(entry=>entry.tombstone.fileId===fileId)!.pending,false);}
  if(kind==="publication-recovery"||kind==="legacy-publication-recovery")assert.deepEqual(JSON.parse(readFileSync(recoveringPublication,"utf8")),{value:2});
 }catch(error){throw new Error(`${kind} power boundary ${cut}/${trace.length||power.trace.length} (${power.trace[cut-1]??"probe"}) failed`,{cause:error});}
 finally{packBoundary.visit=()=>{};power.close();rmSync(owned,{recursive:true,force:true});}
 return {steps:trace,cuts,interruptedAt:cut>0?trace[cut-1]:undefined};
}

/** Register exactly the scenario named by this isolated entrypoint. */
export function registerJournalSequence(entrypoint: string): void {
  const name = basename(fileURLToPath(entrypoint));
  const match = /^journal-power-(.+)\.test\.ts$/.exec(name);
  assert.ok(match !== null && sequences.includes(match[1] as Sequence), "entrypoint must name one declared power scenario");
  const kind = match[1] as Sequence;
  registerJournalCleanup();
test(`EVERY native ${kind} boundary survives directory-entry loss and completes its receipts`,async t=>{
 const root=await fixture();const template=join(root,"template");sequence(template,kind,-1);const result=sequence(join(root,"probe"),kind,0,template);const recorded=sequence(join(root,"other"),kind,0,template,undefined,true);assert.deepEqual(result.steps,recorded.steps,"fast hooks must preserve every recorded native boundary");assert.deepEqual(result.cuts,recorded.cuts,"fast hooks must preserve every full crash-image ordinal");let completed=0;for(const cut of result.cuts){sequence(join(root,`cut-${cut}`),kind,cut,template);if(++completed%25===0){console.log(`power ${kind}: ${completed}/${result.cuts.length} distinct images`);global.gc?.();}}assert.equal(completed,recorded.cuts.length,"every recorded full crash image must be recovered");t.diagnostic(`${result.steps.length} ${kind} native boundaries, ${result.cuts.length} distinct full crash images restored with two convergent engine replays each; byte-identical images share the proven verdict; retained object and foreign tripwire preserved`);
});
}
