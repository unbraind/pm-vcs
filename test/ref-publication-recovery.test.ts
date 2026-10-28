import "./helpers/isolate-session.ts";
/** Pending publication is a mutation and a retention root, including after real process death. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, mock, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { collectGarbage } from "../engine/gc.ts";
import { objectFiles } from "../engine/object-files.ts";
import { durability } from "../engine/durability.ts";
import { destructionBoundary, inspectDestructions, inspectNamespacePublications, prepareDestruction } from "../engine/destruction.ts";
import { writePrivateJson } from "../engine/composition.ts";
import { writeCommit, writeTree, encodeRecord, type Signature } from "../engine/model.ts";
import { encodeIndex, readWorkingFile } from "../engine/worktree.ts";
import { encodeTombstone } from "../engine/lifecycle.ts";
import { encodeConflict } from "../engine/conflicts.ts";
import { hashObject } from "../engine/objects.ts";
import { withPublicationLock, validatePublication, publicationRootIds, publicationRootsFromFd, validatePublicationIds } from "../engine/publication.ts";
import { verificationLimits } from "../engine/object-error.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); destructionBoundary.visit = () => {}; objectFiles.opened = () => {}; assert.equal(objectFiles.active.size, 0); assert.equal(objectFiles.storageOwners.size, 0); for (const entry of temporary.splice(0)) entry.cleanup(); });
/** Each case uses an actual SDK tracker outside Git and independent immutable payloads. */
async function fixture(): Promise<Repository> { const temp = makeTempDir(); temporary.push(temp); await new PmClient({ cwd: temp.root, pmRoot: join(temp.root, ".agents/pm"), noExtensions: true }).init("publication", { defaults: true, author: "fixture" }); return Repository.init(temp.root); }
/** Kill only after the requested native boundary, then retire the provably dead object-store owner. */
function killed(repo: Repository, name: string, expected: string, next: string, mode: string): void {
 const child = spawnSync(process.execPath, ["--import", new URL("./helpers/forbid-git.ts", import.meta.url).href, join(packageRoot, "test/helpers/ref-publication-worker.ts"), repo.root, name, expected, next, mode], { env: { ...testEnvironment(), ...discardChildCoverage(), GIT_CEILING_DIRECTORIES: dirname(repo.root) }, encoding: "utf8", timeout: 60000 });
 assert.equal(child.signal, "SIGKILL", child.stderr); repo.objects.recoverWriterLock();
}
test("ref recovery precedes the fresh CAS predicate and cannot silently replace its recovered peer value", async () => {
 const repo = await fixture(); const name = "refs/metadata/live";
 const a = repo.objects.write("blob", Buffer.from("original A")); const b = repo.objects.write("blob", Buffer.from("prepared B")); const c = repo.objects.write("blob", Buffer.from("fresh C"));
 repo.refs.compareAndSwap(name, null, a); killed(repo, name, a, b, "prepared"); assert.equal(repo.refs.read(name), a);
 assert.throws(() => repo.refs.compareAndSwap(name, a, c), { code: "ref_changed" }); assert.equal(repo.refs.read(name), b); repo.refs.compareAndSwap(name, b, c); assert.equal(repo.refs.read(name), c);
});
test("GC retains a prepared publication closure until recovery cannot replay it, including a second SIGKILL", async () => {
 const repo = await fixture(); const name = "refs/metadata/live"; const a = repo.objects.write("blob", Buffer.from("root A")); const b = repo.objects.write("blob", Buffer.from("pending root B"));
 repo.refs.compareAndSwap(name, null, a); killed(repo, name, a, b, "prepared");
 assert.ok(!collectGarbage(repo).candidates.includes(b)); collectGarbage(repo, true); assert.equal(repo.objects.has(b), true);
 killed(repo, name, a, b, "replayed"); assert.equal(repo.refs.read(name), b); assert.deepEqual(repo.objects.readTyped(b, "blob"), Buffer.from("pending root B"));
 const c = repo.objects.write("blob", Buffer.from("post-GC C")); assert.throws(() => repo.refs.compareAndSwap(name, a, c), { code: "ref_changed" }); repo.refs.compareAndSwap(name, b, c); collectGarbage(repo, true); assert.equal(repo.objects.has(b), false); assert.equal(repo.objects.has(c), true);
});

import { prepareControlPublication as prepared } from "./helpers/prepared-publication.ts";
const signature: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
/** Independent real commit graphs make a retained root's descendants observable independently of all current refs. */
function graph(repo: Repository, text: string): { leaf: string; tree: string; root: string } {
 const leaf=repo.objects.write("blob",Buffer.from(text));const tree=writeTree(repo.objects,[{name:"asset",id:leaf,mode:"100644"}]);const root=writeCommit(repo.objects,{tree,parents:[],author:signature,committer:signature,message:text});return{leaf,tree,root};
}
test("seeded pending-root model preserves every native root format through loose and packed GC and releases ended authority", async t => {
 const base=await fixture();let cases=0;
 for(let seed=1;seed<=8;seed++) for(const format of ["ref","HEAD","index","MERGE_STATE","pins","denials"] as const) for(const packed of [false,true]) {
  const repo=Repository.init(join(base.root,`model-${cases++}`));const a=graph(repo,`original ${seed}`);const b=graph(repo,createHash("sha256").update(`payload ${seed}`).digest("hex"));repo.refs.compareAndSwap("refs/metadata/anchor",null,a.root);
  let destination:string;let bytes:string;let selected=b.root;let restore:()=>void;
  if(format==="ref"){const name=["refs/heads/main","refs/tags/fixture","refs/remotes/demo/main","refs/metadata/fixture"][seed%4]!;repo.refs.compareAndSwap(name,null,a.root);destination=join(repo.controlDirectory,name);bytes=`${b.root}\n`;restore=()=>repo.refs.compareAndSwap(name,b.root,a.root);}
  else if(format==="HEAD"){repo.refs.setHeadDetached(a.root);destination=join(repo.controlDirectory,"HEAD");bytes=`${b.root}\n`;restore=()=>repo.refs.setHeadDetached(a.root);}
  else if(format==="index"){repo.writeIndex([{path:"asset",id:a.leaf,mode:"100644"}]);destination=join(repo.controlDirectory,"index");bytes=encodeIndex([{path:"asset",id:b.leaf,mode:"100644"}]);selected=b.leaf;restore=()=>repo.writeIndex([{path:"asset",id:a.leaf,mode:"100644"}]);}
  else if(format==="MERGE_STATE"){const state={ours:a.root,theirs:a.root,bases:[],revision:"fixture",merged:[],conflicts:[],message:"fixture",author:signature,committer:signature};destination=join(repo.controlDirectory,"MERGE_STATE");writePrivateJson(destination,state);bytes=JSON.stringify({...state,theirs:b.root});restore=()=>writePrivateJson(destination,state);}
  else if(format==="pins"){destination=join(repo.controlDirectory,"upload-roots.json");writePrivateJson(destination,[]);bytes=JSON.stringify([b.root,b.tree,b.leaf]);restore=()=>writePrivateJson(destination,[]);}
  else{const gone=hashObject("blob",Buffer.from(`already absent ${seed}`));const tombstone={version:1 as const,fileId:seed.toString(16).padStart(32,"0"),roots:[gone],objects:[gone],payloads:[createHash("sha256").update(`absent ${seed}`).digest("hex")],principal:"fixture",timestamp:new Date(1).toISOString(),reason:"fixture"};selected=repo.objects.write("tombstone",encodeTombstone(tombstone));destination=join(repo.controlDirectory,"denials.json");writePrivateJson(destination,[]);bytes=JSON.stringify([{id:selected,tombstone,pending:false}]);restore=()=>{};}
  const source=prepared(repo,destination,bytes);if(packed)repo.objects.compact();const before=readFileSync(destination,"utf8");const preview=collectGarbage(repo);assert.ok(!preview.candidates.includes(selected));assert.ok(preview.publications!.pending>=1);assert.equal(readFileSync(destination,"utf8"),before);collectGarbage(repo,true);assert.ok(repo.objects.has(selected));
  durability.recoverPublication(destination);assert.equal(readFileSync(destination,"utf8"),bytes);assert.equal(existsSync(source),false);assert.ok(repo.objects.has(selected));restore();collectGarbage(repo,true);assert.equal(repo.objects.has(selected),format==="denials");assert.equal(inspectDestructions(repo.controlDirectory).pending,0);if(cases%12===0)process.stderr.write(`pending-root model: ${cases}/96 stores verified\n`);
 }
 t.diagnostic(`${cases} seeded format/representation stores, complete pending roots and descendants, read-only preview and ended-authority collection`);
});

test("a collected legacy target is cancelled rather than resurrected and its original cleanup always finishes",async()=>{
 const repo=await fixture();const name="refs/metadata/live";const a=repo.objects.write("blob",Buffer.from("retained original"));const bBytes=Buffer.from("legacy target already collected");const b=repo.objects.write("blob",bBytes);const c=repo.objects.write("blob",Buffer.from("valid replacement"));repo.refs.compareAndSwap(name,null,a);
 const source=prepared(repo,join(repo.controlDirectory,name),`${b}\n`);repo.objects.withWriteLock(()=>{repo.objects.markStorageGeneration();const plan=prepareDestruction(repo.controlDirectory,"legacy-collector",[{path:join(repo.objects.storageRoot(),b.slice(0,2),b.slice(2))}]);for(const path of plan.paths)plan.remove(path);plan.finish();});let exposed=false;destructionBoundary.visit=step=>{if(step==="deleted"&&repo.refs.read(name)===b)exposed=true;};
 let failure:unknown;try{repo.refs.compareAndSwap(name,a,c);}catch(error){failure=error;}destructionBoundary.visit=()=>{};assert.equal(exposed,false);assert.equal(failure,undefined);assert.equal(repo.refs.read(name),c);assert.equal(repo.objects.has(b),false);assert.equal(existsSync(source),false);assert.equal(inspectDestructions(repo.controlDirectory).pending,0);assert.match(JSON.stringify(inspectDestructions(repo.controlDirectory)),/publication_target_unavailable/);
});

test("the original prepared transition reports recovered peer success without publishing a duplicate",async()=>{
 const repo=await fixture();const name="refs/metadata/live";const a=repo.objects.write("blob",Buffer.from("same request A"));const b=repo.objects.write("blob",Buffer.from("same request B"));repo.refs.compareAndSwap(name,null,a);const destination=join(repo.controlDirectory,name);prepared(repo,destination,`${b}\n`);
 const rename=fs.renameSync;let publications=0;mock.method(fs,"renameSync",(...args:Parameters<typeof fs.renameSync>)=>{if(args[1]===destination)publications++;return rename(...args);});syncBuiltinESMExports();repo.refs.compareAndSwap(name,a,b);assert.equal(repo.refs.read(name),b);assert.equal(publications,1);assert.equal(inspectDestructions(repo.controlDirectory).pending,0);
 assert.throws(()=>repo.refs.compareAndSwap(name,a,b),{code:"ref_changed"});assert.equal(publications,1);
});

test("all ref and HEAD destinations recover before any fresh member of a batch is written",async()=>{
 const repo=await fixture();const a=graph(repo,"batch A");const b=graph(repo,"batch B");const c=graph(repo,"batch C");const early="refs/metadata/first";const late="refs/metadata/last";repo.refs.compareAndSwap(early,null,a.root);repo.refs.compareAndSwap(late,null,a.root);
 prepared(repo,join(repo.controlDirectory,late),`${b.root}\n`);assert.throws(()=>repo.refs.transaction([{name:early,expected:a.root,next:c.root},{name:late,expected:a.root,next:c.root}]),{code:"ref_changed"});assert.equal(repo.refs.read(early),a.root);assert.equal(repo.refs.read(late),b.root);
 repo.refs.setHeadDetached(a.root);prepared(repo,join(repo.controlDirectory,"HEAD"),`${b.root}\n`);assert.throws(()=>repo.refs.transaction([{name:early,expected:a.root,next:c.root}],undefined,{expected:a.root,next:c.root}),{code:"head_changed"});assert.equal(repo.refs.rawHead(),b.root);assert.equal(repo.refs.read(early),a.root);
 repo.refs.transaction([{name:early,expected:a.root,next:c.root}],undefined,{expected:b.root});assert.equal(repo.refs.read(early),c.root);assert.equal(repo.refs.rawHead(),b.root);
 const operation=repo.operations.append("checkout","guarded undo",[{ref:early,before:a.root,after:c.root}],new Date(1),{before:a.root,after:b.root});prepared(repo,join(repo.controlDirectory,"HEAD"),`${c.root}\n`);assert.throws(()=>repo.operations.undo(repo.refs,operation.sequence,new Date(2)),{code:"head_changed"});assert.equal(repo.refs.rawHead(),c.root);assert.equal(repo.refs.read(early),c.root);
});

test("index cache CAS preserves a recovered staging generation",async()=>{
 const repo=await fixture();const a=repo.objects.write("blob",Buffer.from("working cache A"));const b=repo.objects.write("blob",Buffer.from("recovered index B"));writeFileSync(join(repo.root,"asset"),"working cache A");repo.writeIndex([{path:"asset",id:a,mode:"100644"}]);prepared(repo,join(repo.controlDirectory,"index"),encodeIndex([{path:"asset",id:b,mode:"100644"}]));repo.status((root,path)=>readWorkingFile(root,path,()=>BigInt(Date.now())*1_000_000n+3_000_000_000n));assert.equal(repo.readIndex()[0]!.id,b);
});

test("ref request fields remain immutable across callbacks and operational read errors never mean absence",async()=>{
 const repo=await fixture();const a=repo.objects.write("blob",Buffer.from("fenced request A"));const b=repo.objects.write("blob",Buffer.from("fenced request B"));const name="refs/metadata/live";repo.refs.compareAndSwap(name,null,a);
 for(const field of ["name","expected","next","length","entry","head"]){const updates=[{name,expected:a,next:b}];const head={expected:repo.refs.rawHead(),next:repo.refs.rawHead()};assert.throws(()=>repo.refs.transaction(updates,()=>{if(field==="length")updates.length=0;else if(field==="entry")updates[0]=null as never;else if(field==="head")head.expected=b;else updates[0]![field as "name"|"expected"|"next"]="foreign";},head),{code:"invalid_ref_update"});assert.equal(repo.refs.read(name),a);}
 const read=fs.readFileSync;for(const code of ["EACCES","EIO"]){mock.method(fs,"readFileSync",(...args:Parameters<typeof fs.readFileSync>)=>{if(args[0]===join(repo.controlDirectory,name))throw Object.assign(new Error("native reference read failed"),{code});return Reflect.apply(read,fs,args);});syncBuiltinESMExports();try{assert.throws(()=>repo.refs.compareAndSwap(name,null,b),{code});}finally{mock.restoreAll();syncBuiltinESMExports();}assert.equal(repo.refs.read(name),a);}
 for(const updates of [null,[null],[{}],[{name,expected:null,next:"a".repeat(32)}]])assert.throws(()=>repo.refs.transaction(updates as never),error=>error instanceof Error&&"code"in error);assert.equal(repo.refs.read(name),a);
});

test("publication reentrancy requires the live descriptor and root lifetime, not an ambient journal scope",async()=>{
 const repo=await fixture();const control=fs.realpathSync(repo.controlDirectory);const lock=join(repo.controlDirectory,"objects.lock");const lstat=fs.lstatSync;const fstat=fs.fstatSync;
 repo.objects.withWriteLock(()=>{const owner=objectFiles.storageOwners.get(control)!;assert.ok(owner());for(const [where,key] of [["lock","absent"],["root","absent"],...["dev","ino","birthtimeNs"].map(key=>["root",key]),...["dev","ino","size","mtimeNs","ctimeNs"].flatMap(key=>[["lock",key],["descriptor",key]])] as const){
  mock.method(fs,"lstatSync",(...args:Parameters<typeof fs.lstatSync>)=>{const value=Reflect.apply(lstat,fs,args);if(value===undefined||(args[1] as {bigint?:boolean}|undefined)?.bigint!==true||String(args[0])!==(where==="root"?control:lock)||where==="descriptor")return value;if(key==="absent")return undefined;return new Proxy(value,{get(target,property,receiver){return property===key?Reflect.get(target,property,receiver)+1n:Reflect.get(target,property,receiver);}});});
  mock.method(fs,"fstatSync",(...args:Parameters<typeof fs.fstatSync>)=>{const value=Reflect.apply(fstat,fs,args);if(where!=="descriptor")return value;return new Proxy(value,{get(target,property,receiver){return property===key?Reflect.get(target,property,receiver)+1n:Reflect.get(target,property,receiver);}});});syncBuiltinESMExports();let wrote=false;try{assert.throws(()=>withPublicationLock(join(control,"config.json"),()=>{wrote=true;}),{code:"worktree_path_changed"});assert.equal(wrote,false);}finally{mock.restoreAll();syncBuiltinESMExports();}assert.ok(owner());
 }});assert.equal(objectFiles.storageOwners.size,0);
});


test("publication verification fails closed at every independent receipt and reachability bound", async () => {
 const repo=await fixture();const name="refs/metadata/live";const a=repo.objects.write("blob",Buffer.from("bounded A"));const b=repo.objects.write("blob",Buffer.from("bounded B"));repo.refs.compareAndSwap(name,null,a);prepared(repo,join(repo.controlDirectory,name),`${b}\n`);
 for(const key of ["receiptRecords","receiptBytes","receiptMs","reachabilityObjects","reachabilityMs"] as const){const original=verificationLimits[key];verificationLimits[key]=0;try{assert.throws(()=>collectGarbage(repo,true),error=>error instanceof Error&&"status"in error&&error.status==="unverified");assert.equal(repo.refs.read(name),a);assert.ok(repo.objects.has(b));if(key.startsWith("reachability"))assert.throws(()=>validatePublicationIds(join(repo.controlDirectory,name),[b]),error=>error instanceof Error&&"status"in error&&error.status==="unverified");}finally{verificationLimits[key]=original;}}
 durability.recoverPublication(join(repo.controlDirectory,name));assert.equal(repo.refs.read(name),b);
});

test("native root codecs refuse incomplete evidence and validate new targets before replaying a prior transition", async () => {
 const repo=await fixture();const name="refs/metadata/live";const a=repo.objects.write("blob",Buffer.from("validated A"));const b=repo.objects.write("blob",Buffer.from("validated B"));repo.refs.compareAndSwap(name,null,a);prepared(repo,join(repo.controlDirectory,name),`${b}\n`);
 for(const next of ["not-an-id","f".repeat(64)]){assert.throws(()=>repo.refs.compareAndSwap(name,a,next));assert.equal(repo.refs.read(name),a);}
 for(const [file,bytes] of [["refs/metadata/root","not-an-id"],["index","bad index"],["MERGE_STATE","{"],["MERGE_STATE","null"],["MERGE_STATE","[]"],["MERGE_STATE","{}"],["upload-roots.json","[null]"],["denials.json","{}"]])assert.throws(()=>publicationRootIds(join(repo.controlDirectory,file!),bytes!));
 assert.deepEqual(publicationRootIds(join(repo.root,"HEAD"),"ordinary worktree bytes"),[]);assert.deepEqual(publicationRootIds(join(repo.controlDirectory,"HEAD"),"ref: refs/heads/main\n"),[]);assert.deepEqual(publicationRootIds(join(repo.controlDirectory,"upload-roots.json"),JSON.stringify(["e".repeat(64)])),["e".repeat(64)]);
 validatePublicationIds(join(repo.controlDirectory,"upload-roots.json"),["e".repeat(64)]);assert.equal(repo.objects.has("e".repeat(64)),false);durability.recoverPublication(join(repo.controlDirectory,name));assert.equal(repo.refs.read(name),b);
});

test("a late preflight transition is rechecked before any ref or HEAD publication", async()=>{
 const repo=await fixture();const name="refs/metadata/live";const a=repo.objects.write("blob",Buffer.from("late A"));const b=repo.objects.write("blob",Buffer.from("late B"));const c=repo.objects.write("blob",Buffer.from("late C"));repo.refs.compareAndSwap(name,null,a);repo.refs.setHeadDetached(a);
 assert.throws(()=>repo.refs.compareAndSwap(name,a,"f".repeat(64)),{code:"publication_unverified"});
 assert.throws(()=>repo.refs.transaction([{name,expected:a,next:c}],()=>writeFileSync(join(repo.controlDirectory,name),`${b}\n`)),{code:"ref_changed"});assert.equal(repo.refs.read(name),b);
 assert.throws(()=>repo.refs.transaction([{name,expected:b,next:c}],()=>writeFileSync(join(repo.controlDirectory,"HEAD"),`${b}\n`),{expected:a,next:c}),{code:"head_changed"});assert.equal(repo.refs.read(name),b);assert.equal(repo.refs.rawHead(),b);
});


test("foreign namespace records are reported without adopting their authority or losing prepared roots", async()=>{
 const repo=await fixture();const name="refs/metadata/live";const a=repo.objects.write("blob",Buffer.from("foreign inventory A"));const b=repo.objects.write("blob",Buffer.from("foreign inventory B"));repo.refs.compareAndSwap(name,null,a);prepared(repo,join(repo.controlDirectory,name),`${b}\n`);
 const ledger=join(tmpdir(),`pm-vcs-namespace-${createHash("sha256").update(fs.realpathSync(repo.controlDirectory)).digest("hex")}`,"destruction");const records=readdirSync(ledger).filter(name=>/^[0-9a-f]{64}\.json$/.test(name));const original=records.find(name=>JSON.parse(readFileSync(join(ledger,name),"utf8")).status==="pending")!;const bytes=readFileSync(join(ledger,original));writeFileSync(join(ledger,"f".repeat(64)+".json"),bytes);writeFileSync(join(ledger,"e".repeat(64)+".json"),"{");writeFileSync(join(ledger,"foreign.bin"),"foreign audit bytes");mkdirSync(join(ledger,"foreign-directory"));
 const row=JSON.parse(bytes.toString()) as {id:string;rootIdentity:string;status:string;entries:Record<string,unknown>[]};
 for(const [tag,changed] of [["d",{...row,rootIdentity:"0:0:0"}],["c",{...row,entries:[{...row.entries[0],kind:"file",destination:undefined,target:undefined,destinationParentIdentity:undefined}]}],["b",{...row,entries:[{...row.entries[0],status:"moved"}]}],["a",{...row,status:"completed",entries:[{...row.entries[0],status:"moved"}]}],["9",{...row,entries:[]}] ] as const)writeFileSync(join(ledger,tag.repeat(64)+".json"),JSON.stringify(changed));
 for(let i=0;i<24;i++)writeFileSync(join(ledger,`foreign-${i}.bin`),"foreign preserved");
 const progress=join(ledger,original.slice(0,-5)+"."+row.id+".progress");const originalProgress=existsSync(progress)?readFileSync(progress):undefined;writeFileSync(progress,Buffer.from([255]));const conservative=inspectNamespacePublications(repo.controlDirectory,()=>true,()=>{});assert.equal(conservative.pending,1);assert.equal(conservative.verification.status,"unverified");fs.renameSync(progress,progress+".foreign");try{assert.equal(inspectNamespacePublications(repo.controlDirectory,()=>true,()=>{}).pending,1);}finally{fs.renameSync(progress+".foreign",progress);if(originalProgress===undefined)fs.unlinkSync(progress);else writeFileSync(progress,originalProgress);}
 const inventory=inspectNamespacePublications(repo.controlDirectory,()=>true,(fd,path)=>{if(path===join(repo.controlDirectory,name))assert.deepEqual(publicationRootsFromFd(fd,path),[b]);});assert.equal(inventory.pending,1);assert.ok(inventory.skippedCount>=28);assert.equal(inventory.skipped.length,20);assert.equal(inventory.verification.status,"unverified");const preview=collectGarbage(repo);assert.ok(!preview.candidates.includes(b));assert.ok(preview.publications!.skippedCount>=4);assert.equal(readFileSync(join(ledger,"foreign.bin"),"utf8"),"foreign audit bytes");
});

test("pinned publication sources fence replacements and corrupt dependencies never become absence", async()=>{
 const repo=await fixture();const name="refs/metadata/live";const a=repo.objects.write("blob",Buffer.from("pinned A"));const b=repo.objects.write("blob",Buffer.from("pinned B"));repo.refs.compareAndSwap(name,null,a);const source=join(repo.controlDirectory,"refs/metadata/ref-"+process.pid+"-123456abcdef.lock");writeFileSync(source,`${b}\n`);
 objectFiles.opened=(_file,path)=>{if(path===source){objectFiles.opened=()=>{};fs.renameSync(source,source+".retired");writeFileSync(source,`${a}\n`);}};assert.throws(()=>durability.rename(source,join(repo.controlDirectory,name)),error=>error instanceof Error&&"bound"in error&&error.bound==="namespace_changed");objectFiles.opened=()=>{};assert.equal(repo.refs.read(name),a);assert.equal(readFileSync(source,"utf8"),`${a}\n`);assert.equal(readFileSync(source+".retired","utf8"),`${b}\n`);
 const corrupt=repo.objects.write("commit",Buffer.from("not a complete commit"));assert.throws(()=>validatePublicationIds(join(repo.controlDirectory,name),[corrupt]),error=>error instanceof Error&&"bound"in error&&error.bound==="decode_error");
});

test("interrupted upload pins retain existing arrivals without pretending future arrivals are complete roots",async()=>{
 const repo=await fixture();const id=repo.objects.write("blob",Buffer.from("accepted upload arrival"));const absent="d".repeat(64);const path=join(repo.controlDirectory,"upload-roots.json");writePrivateJson(path,[]);prepared(repo,path,JSON.stringify([id,absent]));const preview=collectGarbage(repo);assert.ok(!preview.candidates.includes(id));collectGarbage(repo,true);assert.ok(repo.objects.has(id));durability.recoverPublication(path);assert.deepEqual(repo.objects.uploadRoots(),[id,absent]);assert.equal(repo.objects.has(absent),false);
});

test("permanent denial cancels prepared replay authority without reviving its physically retained target",async()=>{
 const repo=await fixture();const name="refs/metadata/live";const a=repo.objects.write("blob",Buffer.from("denial original A"));const bytes=Buffer.from("denial prepared B");const b=repo.objects.write("blob",bytes);const c=repo.objects.write("blob",Buffer.from("denial valid C"));repo.refs.compareAndSwap(name,null,a);const source=prepared(repo,join(repo.controlDirectory,name),`${b}\n`);
 const tombstone={version:1 as const,fileId:"9".repeat(32),roots:[b],objects:[b],payloads:[createHash("sha256").update(bytes).digest("hex")],principal:"fixture",timestamp:new Date(1).toISOString(),reason:"fixture"};const audit=hashObject("tombstone",encodeTombstone(tombstone));repo.objects.recordDenials([{id:audit,tombstone,pending:false}]);repo.writeIndex([{path:"terminal",id:b,mode:"100644"}]);assert.equal(repo.readIndex()[0]!.id,b);assert.throws(()=>repo.objects.read(b),{code:"object_obliterated"});assert.throws(()=>validatePublicationIds(join(repo.controlDirectory,name),[b]),{code:"object_obliterated"});let exposed=false;destructionBoundary.visit=step=>{if(step==="deleted"&&repo.refs.read(name)===b)exposed=true;};repo.refs.compareAndSwap(name,a,c);destructionBoundary.visit=()=>{};assert.equal(exposed,false);assert.equal(repo.refs.read(name),c);assert.equal(existsSync(source),false);assert.equal(inspectDestructions(repo.controlDirectory).pending,0);
});

test("pending-root inventory fences every pinned source and namespace identity at verification end",async t=>{
 const repo=await fixture();const name="refs/metadata/live";const a=repo.objects.write("blob",Buffer.from("inventory pinned A"));const b=repo.objects.write("blob",Buffer.from("inventory pinned B"));repo.refs.compareAndSwap(name,null,a);const destination=join(repo.controlDirectory,name);const source=prepared(repo,destination,`${b}\n`);const lstat=fs.lstatSync;const fstat=fs.fstatSync;let cases=0;
 for(const where of ["source-absent","source-changed","descriptor","root-absent","root-changed","parent-absent","parent-changed","destination-parent-absent","destination-parent-changed"]){let phase=false;let parentReads=0;let pinned=-1;
  mock.method(fs,"lstatSync",(...args:Parameters<typeof fs.lstatSync>)=>{const value=Reflect.apply(lstat,fs,args);if(!phase||value===undefined||(args[1]as{bigint?:boolean}|undefined)?.bigint!==true)return value;const path=String(args[0]);let selected=where.startsWith("source")&&path===source||where.startsWith("root")&&path===repo.controlDirectory;if(path===dirname(source)){parentReads++;selected=selected||(where.startsWith("parent")&&parentReads===1)||(where.startsWith("destination-parent")&&parentReads===2);}if(!selected)return value;if(where.endsWith("absent"))return undefined;const key=where.startsWith("source")?"ctimeNs":"birthtimeNs";return new Proxy(value,{get(target,property,receiver){return property===key?Reflect.get(target,property,receiver)+1n:Reflect.get(target,property,receiver);}});});
  mock.method(fs,"fstatSync",(...args:Parameters<typeof fs.fstatSync>)=>{const value=Reflect.apply(fstat,fs,args);if(!phase||where!=="descriptor"||args[0]!==pinned)return value;return new Proxy(value,{get(target,property,receiver){return property==="ctimeNs"?Reflect.get(target,property,receiver)+1n:Reflect.get(target,property,receiver);}});});syncBuiltinESMExports();try{assert.throws(()=>inspectNamespacePublications(repo.controlDirectory,path=>path===destination,(fd)=>{pinned=fd;phase=true;}),error=>error instanceof Error&&"bound"in error&&error.bound==="namespace_changed",where);}finally{mock.restoreAll();syncBuiltinESMExports();}assert.equal(objectFiles.active.size,0);cases++;
 }
 assert.equal(inspectNamespacePublications(repo.controlDirectory,path=>path===destination,()=>{}).pending,1);assert.equal(repo.refs.read(name),a);assert.ok(repo.objects.has(b));t.diagnostic(`${cases} independent final descriptor/pathname/root/parent identity refusals, descriptor baseline checked after every operation`);
});


test("previously accepted symbolic HEAD spacing uses the writer's normalization on both sides of its guard",async()=>{
 const repo=await fixture();writeFileSync(join(repo.controlDirectory,"HEAD"),"ref:   refs/heads/main  \n");repo.refs.transaction([],undefined,{expected:"ref: refs/heads/main"});repo.refs.setHeadToRef("refs/heads/next","ref: refs/heads/main");assert.equal(repo.refs.rawHead(),"ref: refs/heads/next");repo.refs.transaction([],undefined,{expected:"ref:   refs/heads/next",next:"ref:   refs/heads/last  "});assert.equal(repo.refs.rawHead(),"ref: refs/heads/last");
});


test("partial-history promises allow omitted descendants and staged blobs but never a missing advertised root",async()=>{
 const repo=await fixture();const leaf=hashObject("blob",Buffer.from("promised future leaf"));writePrivateJson(join(repo.controlDirectory,"partial.json"),{remote:"fixture",shallow:[],promised:[leaf]});const tree=writeTree(repo.objects,[{name:"asset",id:leaf,mode:"100644"}]);const root=writeCommit(repo.objects,{tree,parents:[],author:signature,committer:signature,message:"declared omitted descendant"});repo.refs.compareAndSwap("refs/metadata/partial",null,root);repo.writeIndex([{path:"asset",id:leaf,mode:"100644"}]);assert.equal(repo.readIndex()[0]!.id,leaf);assert.throws(()=>repo.refs.compareAndSwap("refs/metadata/missing",null,leaf),error=>error instanceof Error&&"bound"in error&&error.bound==="missing_object");assert.equal(repo.refs.read("refs/metadata/missing"),null);assert.equal(repo.refs.read("refs/metadata/partial"),root);
});

test("retention inspection refuses every pre-pin identity and native-read fault without adopting foreign bytes",async t=>{
 const repo=await fixture();const a=repo.objects.write("blob",Buffer.from("pre-pin A"));const b=repo.objects.write("blob",Buffer.from("pre-pin B"));const name="refs/metadata/live";repo.refs.compareAndSwap(name,null,a);const destination=join(repo.controlDirectory,name);const source=prepared(repo,destination,`${b}\n`);const lstat=fs.lstatSync;const fstat=fs.fstatSync;const read=fs.readSync;let cases=0;
 for(const mode of ["source-type","source-identity","source-digest","parent","destination-parent","descriptor","native-io"]){let opens=0;let pinned=-1;let parentReads=0;objectFiles.opened=(file,path)=>{if(path===source){opens++;pinned=file.fd;if(mode==="native-io"&&opens===2)throw Object.assign(new Error("injected pinned native read failure"),{code:"EIO"});}};
  mock.method(fs,"lstatSync",(...args:Parameters<typeof fs.lstatSync>)=>{const value=Reflect.apply(lstat,fs,args);if(value===undefined||(args[1]as{bigint?:boolean}|undefined)?.bigint!==true)return value;const path=String(args[0]);if(path===source&&opens===0&&(mode==="source-type"||mode==="source-identity"))return new Proxy(value,{get(target,property,receiver){if(property==="isFile"&&mode==="source-type")return()=>false;return property==="ctimeNs"&&mode==="source-identity"?Reflect.get(target,property,receiver)+1n:Reflect.get(target,property,receiver);}});if(opens===1&&path===dirname(source)){parentReads++;if(mode==="parent"&&parentReads===1||mode==="destination-parent"&&parentReads===2)return new Proxy(value,{get(target,property,receiver){return property==="isDirectory"?()=>false:Reflect.get(target,property,receiver);}});}return value;});
  mock.method(fs,"fstatSync",(...args:Parameters<typeof fs.fstatSync>)=>{const value=Reflect.apply(fstat,fs,args);if(mode!=="descriptor"||opens!==2||args[0]!==pinned)return value;return new Proxy(value,{get(target,property,receiver){return property==="ctimeNs"?Reflect.get(target,property,receiver)+1n:Reflect.get(target,property,receiver);}});});
  mock.method(fs,"readSync",(...args:Parameters<typeof fs.readSync>)=>{const count=Reflect.apply(read,fs,args);if(mode==="source-digest"&&args[0]===pinned&&count>0)(args[1]as Uint8Array)[0]^=255;return count;});syncBuiltinESMExports();try{const inspect=()=>inspectNamespacePublications(repo.controlDirectory,path=>path===destination,()=>{});if(mode.startsWith("source")){const result=inspect();assert.equal(result.pending,0);assert.equal(result.verification.status,"unverified");assert.equal(result.verification.bound,"namespace_changed");}else if(mode==="native-io")assert.throws(inspect,{code:"EIO"});else assert.throws(inspect,error=>error instanceof Error&&"bound"in error&&error.bound==="namespace_changed");}finally{objectFiles.opened=()=>{};mock.restoreAll();syncBuiltinESMExports();}assert.equal(objectFiles.active.size,0);cases++;
 }
 assert.equal(inspectNamespacePublications(repo.controlDirectory,path=>path===destination,()=>{}).pending,1);assert.equal(repo.refs.read(name),a);t.diagnostic(`${cases} pre-pin source/type/checksum/parent/descriptor/native I/O failure modes, no leaked handles`);
});

test("conditional HEAD recovery reports its own completed transition and missing HEAD never matches a guard",async()=>{
 const repo=await fixture();const a=repo.objects.write("blob",Buffer.from("HEAD original A"));const b=repo.objects.write("blob",Buffer.from("HEAD prepared B"));repo.refs.setHeadDetached(a);const path=join(repo.controlDirectory,"HEAD");prepared(repo,path,`${b}\n`);repo.refs.setHeadDetached(b,a);assert.equal(repo.refs.rawHead(),b);assert.throws(()=>repo.refs.setHeadDetached(b,a),{code:"head_changed"});assert.equal(inspectDestructions(repo.controlDirectory).pending,0);
 fs.renameSync(path,path+".retired");try{assert.throws(()=>repo.refs.transaction([],undefined,{expected:b}),{code:"head_changed"});}finally{fs.renameSync(path+".retired",path);}assert.equal(repo.refs.rawHead(),b);
});

test("pending private HEAD and index roots in linked instances retain the shared store closure",async()=>{
 const hub=await fixture();const a=graph(hub,"linked original");hub.refs.compareAndSwap("refs/heads/main",null,a.root);const directory=makeTempDir();temporary.push(directory);const instanceRoot=join(directory.root,"linked");hub.linkInstance("fixture",instanceRoot);const instance=Repository.open(instanceRoot);const b=graph(hub,"linked prepared");const head=join(instance.controlDirectory,"HEAD");instance.refs.setHeadDetached(a.root);prepared(instance,head,`${b.root}\n`);const index=join(instance.controlDirectory,"index");prepared(instance,index,encodeIndex([{path:"asset",id:b.leaf,mode:"100644"}]));
 const preview=collectGarbage(hub);for(const id of [b.root,b.tree,b.leaf])assert.ok(!preview.candidates.includes(id));collectGarbage(hub,true);durability.recoverPublication(head);durability.recoverPublication(index);assert.equal(instance.refs.rawHead(),b.root);assert.equal(instance.readIndex()[0]!.id,b.leaf);assert.deepEqual(instance.objects.readTyped(b.leaf,"blob"),Buffer.from("linked prepared"));assert.equal(hub.refs.rawHead(),"ref: refs/heads/main");assert.equal(inspectDestructions(hub.controlDirectory).pending,0);
});


test("unverifiable publication evidence conservatively retains both representations and collection resumes when resolved",async()=>{
 const base=await fixture();for(const packed of [false,true]){const repo=Repository.init(join(base.root,packed?"packed-uncertain":"loose-uncertain"));const a=repo.objects.write("blob",Buffer.from("uncertain A"));const b=repo.objects.write("blob",Buffer.from("uncertain prepared B"));const garbage=repo.objects.write("blob",Buffer.from("uncertain candidate"));const name="refs/metadata/live";repo.refs.compareAndSwap(name,null,a);prepared(repo,join(repo.controlDirectory,name),`${b}\n`);if(packed)repo.objects.compact();const ledger=join(tmpdir(),`pm-vcs-namespace-${createHash("sha256").update(fs.realpathSync(repo.controlDirectory)).digest("hex")}`,"destruction");const foreign=join(ledger,"8".repeat(64)+".json");writeFileSync(foreign,"{");const preview=collectGarbage(repo);assert.equal(preview.publications!.verification.status,"unverified");assert.deepEqual(preview.candidates,[]);const applied=collectGarbage(repo,true);assert.equal(applied.removed,0);assert.deepEqual(applied.candidates,[]);assert.ok(repo.objects.has(garbage));assert.ok(repo.objects.has(b));fs.unlinkSync(foreign);assert.ok(collectGarbage(repo).candidates.includes(garbage));collectGarbage(repo,true);assert.equal(repo.objects.has(garbage),false);assert.ok(repo.objects.has(b));durability.recoverPublication(join(repo.controlDirectory,name));assert.equal(repo.refs.read(name),b);}
});

test("bare durability workers fail closed for native publication until the real object adapter is initialized",async()=>{
 const repo=await fixture();const id=repo.objects.write("blob",Buffer.from("unconfigured native publication"));const target=join(repo.controlDirectory,"HEAD");const before=readFileSync(target);const source=target+".123456abcdef.tmp";writeFileSync(source,`${id}\n`);const result=spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/publication-gate-worker.ts"),source,target],{env:testEnvironment(),encoding:"utf8",timeout:60000});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{code:"publication_unverified",bound:"store_adapter"});assert.deepEqual(readFileSync(target),before);assert.equal(readFileSync(source,"utf8"),`${id}\n`);
});


test("acknowledged pending ref progress cannot keep replay authority or hide its active root from GC",async()=>{
 const repo=await fixture();const name="refs/metadata/live";const a=repo.objects.write("blob",Buffer.from("acknowledged A"));const b=repo.objects.write("blob",Buffer.from("acknowledged B"));const garbage=repo.objects.write("blob",Buffer.from("acknowledged garbage"));repo.refs.compareAndSwap(name,null,a);killed(repo,name,a,b,"acknowledged");assert.equal(repo.refs.read(name),b);assert.equal(collectGarbage(repo).publications?.pending??0,0);collectGarbage(repo,true);assert.ok(repo.objects.has(b));assert.equal(repo.objects.has(garbage),false);const c=repo.objects.write("blob",Buffer.from("acknowledged C"));repo.refs.compareAndSwap(name,b,c);assert.equal(repo.refs.read(name),c);assert.equal(inspectDestructions(repo.controlDirectory).pending,0);
});


test("native ref writers cannot bypass root retention or overwrite control state through an unregistered destination",async()=>{
 const repo=await fixture();const id=repo.objects.write("blob",Buffer.from("registered root namespace"));const head=readFileSync(join(repo.controlDirectory,"HEAD"));for(const name of ["bookmark","index","objects.generation","denials.json","MERGE_STATE"]){const path=join(repo.controlDirectory,name);const before=existsSync(path)?readFileSync(path):undefined;assert.throws(()=>repo.refs.compareAndSwap(name,null,id),{code:"invalid_ref_name"});assert.deepEqual(existsSync(path)?readFileSync(path):undefined,before);}writeFileSync(join(repo.controlDirectory,"bookmark"),`${id}\n`);assert.equal(repo.refs.read("bookmark"),id);assert.deepEqual(readFileSync(join(repo.controlDirectory,"HEAD")),head);repo.refs.compareAndSwap("refs/metadata/bookmark",null,id);assert.ok(!collectGarbage(repo).candidates.includes(id));
});

test("invalid fresh index targets refuse before replaying an unrelated staged transition",async()=>{
 const repo=await fixture();const a=repo.objects.write("blob",Buffer.from("index preflight A"));const b=repo.objects.write("blob",Buffer.from("index preflight B"));repo.writeIndex([{path:"asset",id:a,mode:"100644"}]);const path=join(repo.controlDirectory,"index");const before=readFileSync(path);const source=prepared(repo,path,encodeIndex([{path:"asset",id:b,mode:"100644"}]));assert.throws(()=>repo.writeIndex([{path:"asset",id:"e".repeat(64),mode:"100644"}]),{code:"publication_unverified"});assert.deepEqual(readFileSync(path),before);assert.ok(existsSync(source));durability.recoverPublication(path);assert.equal(repo.readIndex()[0]!.id,b);
});

test("publication metadata closes its pinned source when its pathname vanishes and standalone names stay ordinary",async()=>{
 const repo=await fixture();const id=repo.objects.write("blob",Buffer.from("vanishing publication source"));const path=join(repo.controlDirectory,"HEAD");const before=readFileSync(path);const source=path+".abcdef123456.tmp";writeFileSync(source,`${id}\n`);objectFiles.opened=(_file,current)=>{if(current===source){objectFiles.opened=()=>{};fs.renameSync(source,source+".retired");}};assert.throws(()=>durability.rename(source,path),error=>error instanceof Error&&"bound"in error&&error.bound==="namespace_changed");objectFiles.opened=()=>{};assert.equal(objectFiles.active.size,0);assert.deepEqual(readFileSync(path),before);const standalone=makeTempDir();temporary.push(standalone);assert.deepEqual(publicationRootIds(join(standalone.root,"HEAD"),"ordinary standalone bytes"),[]);validatePublication(join(standalone.root,"ordinary"),join(standalone.root,"HEAD"));
});

test("dependency read I/O failures propagate without becoming absence or authorizing publication",async()=>{
 const repo=await fixture();const id=repo.objects.write("blob",Buffer.from("dependency I/O"));const path=join(repo.objects.storageRoot(),id.slice(0,2),id.slice(2));let opens=0;objectFiles.opened=(_file,current)=>{if(current===path&&++opens===2)throw Object.assign(new Error("injected dependency I/O"),{code:"EIO"});};assert.throws(()=>validatePublicationIds(join(repo.controlDirectory,"refs/metadata/live"),[id]),{code:"EIO"});objectFiles.opened=()=>{};assert.ok(opens>=2);assert.equal(objectFiles.active.size,0);assert.equal(repo.refs.read("refs/metadata/live"),null);
});


test("cancelled replay retires only its exact native temporary and preserves foreign names parents and replacement owners",async()=>{
 const base=await fixture();for(const mode of ["unrecognized","other-parent","foreign-prefix","legacy","replacement"]){const repo=Repository.init(join(base.root,mode));const a=repo.objects.write("blob",Buffer.from("ownership A"));const b=repo.objects.write("blob",Buffer.from("ownership B"));const c=repo.objects.write("blob",Buffer.from("ownership C"));const name="refs/metadata/live";if(mode==="legacy")repo.refs.setHeadDetached(a);else repo.refs.compareAndSwap(name,null,a);const target=join(repo.controlDirectory,mode==="legacy"?"HEAD":name);const explicit=mode==="unrecognized"?join(repo.root,"foreign-source"):mode==="other-parent"?join(repo.root,`ref-${process.pid}-abcdef123456.lock`):mode==="foreign-prefix"?join(dirname(target),"live.foreign.abcdef123456.tmp"):mode==="legacy"?target+".abcdef123456.tmp":undefined;const source=prepared(repo,target,`${b}\n`,explicit);repo.objects.withWriteLock(()=>{repo.objects.markStorageGeneration();const plan=prepareDestruction(repo.controlDirectory,"legacy-ownership-collector",[{path:join(repo.objects.storageRoot(),b.slice(0,2),b.slice(2))}]);for(const path of plan.paths)plan.remove(path);plan.finish();});let replaced=false;destructionBoundary.visit=(step,path)=>{if(mode==="replacement"&&!replaced&&step==="receipt-persisted"){const row=JSON.parse(readFileSync(path,"utf8")) as {root:string;entries:{path:string;reason?:string}[]};if(row.entries.some(entry=>entry.reason==="publication_target_unavailable"&&resolve(row.root,entry.path)===source)){fs.renameSync(source,source+".retired");writeFileSync(source,"foreign replacement owner");replaced=true;}}};if(mode==="legacy")repo.refs.setHeadDetached(c,a);else repo.refs.compareAndSwap(name,a,c);destructionBoundary.visit=()=>{};assert.equal(mode==="legacy"?repo.refs.rawHead():repo.refs.read(name),c);if(mode==="legacy")assert.equal(existsSync(source),false);else{assert.ok(existsSync(source),"foreign source must remain owned by its creator");assert.equal(readFileSync(source,"utf8"),mode==="replacement"?"foreign replacement owner":`${b}\n`);}assert.equal(replaced,mode==="replacement");assert.equal(inspectDestructions(repo.controlDirectory).pending,0);}
});

test("publication source verification rechecks its descriptor after the final pathname observation",async()=>{
 const repo=await fixture();const id=repo.objects.write("blob",Buffer.from("last descriptor fence"));const target=join(repo.controlDirectory,"HEAD");const before=readFileSync(target);const source=target+".123456abcdef.tmp";writeFileSync(source,`${id}\n`);let fd=-1;let checks=0;objectFiles.opened=(file,path)=>{if(path===source)fd=file.fd;};const fstat=fs.fstatSync;mock.method(fs,"fstatSync",(...args:Parameters<typeof fs.fstatSync>)=>{if(args[0]===fd&&++checks===3)writeFileSync(source,`${id}\n\n`);return Reflect.apply(fstat,fs,args);});syncBuiltinESMExports();try{assert.throws(()=>durability.rename(source,target),error=>error instanceof Error&&"bound"in error&&error.bound==="namespace_changed");}finally{objectFiles.opened=()=>{};mock.restoreAll();syncBuiltinESMExports();}assert.ok(checks>=3);assert.deepEqual(readFileSync(target),before);assert.equal(objectFiles.active.size,0);
});


test("publication and GC share complete conflict-alternative reachability across packed survivors",async()=>{
 const repo=await fixture();const sides=["base","ours","theirs"].map(value=>repo.objects.write("record",encodeRecord({value})));const conflict=repo.objects.write("conflict",encodeConflict({kind:"field",field:"title",base:sides[0]!,ours:sides[1]!,theirs:sides[2]!}));repo.refs.compareAndSwap("refs/metadata/conflict",null,conflict);const garbage=repo.objects.write("blob",Buffer.from("unrelated conflict garbage"));repo.objects.compact();collectGarbage(repo,true);validatePublicationIds(join(repo.controlDirectory,"refs/metadata/conflict"),[conflict]);for(const id of [conflict,...sides])assert.ok(repo.objects.has(id));assert.equal(repo.objects.has(garbage),false);
});
