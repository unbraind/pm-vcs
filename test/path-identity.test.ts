import "./helpers/isolate-session.ts";
/** Physical path identity is captured before cwd changes, publication and durable replay. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { ObjectStore, frameObject, hashObject, objectReadBoundary } from "../engine/objects.ts";
import { Repository } from "../engine/repo.ts";
import { PackStorage, packBoundary } from "../engine/packs.ts";
import { SharedObjectStore } from "../engine/instances.ts";
import { RefStore } from "../engine/refs.ts";
import { OperationLog } from "../engine/oplog.ts";
import { RemoteStore } from "../engine/remotes.ts";
import { PublicationLeases } from "../engine/publication-leases.ts";
import { WorktreeMutation, worktreeMutationCapabilities } from "../engine/worktree-mutation.ts";
import { FileTransport } from "../engine/transport.ts";
import { ServedRepositoryDirectories } from "../engine/served-repositories.ts";
import { objectPayloadChunks } from "../engine/object-stream.ts";
import { collectGarbage } from "../engine/gc.ts";
import { destructionBoundary, prepareDestruction } from "../engine/destruction.ts";
import { objectFiles } from "../engine/object-files.ts";
import { accountErasureStorage, accountabilityBoundary, erasurePurge, planErasureStorage } from "../engine/erasure-accountability.ts";
import { erasureScanBoundary, fingerprint, scanErasureStorage } from "../engine/erasure-scan.ts";
import { durability } from "../engine/durability.ts";
import { deflateSync } from "node:zlib";
import ts from "typescript5";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { accountabilityBoundary.visit = () => {}; erasureScanBoundary.visit = () => {}; packBoundary.visit = () => {}; destructionBoundary.visit = () => {}; assert.equal(objectFiles.active.size, 0); for (const dir of temporary.splice(0)) dir.cleanup(); });
/** Initialize a real SDK tracker independently of Git discovery. */
async function fixture() {
  const dir = makeTempDir(); temporary.push(dir); process.env.GIT_CEILING_DIRECTORIES = dirname(dir.root);
  await new PmClient({ cwd: dir.root, pmRoot: join(dir.root, ".agents/pm"), noExtensions: true }).init("path-identity", { defaults: true, author: "fixture" });
  return Repository.init(dir.root);
}

test("documented relative ObjectStore compaction publishes a pack and completes its exact deletion receipt", async () => {
  const repo = await fixture(); const original = process.cwd();
  try {
    process.chdir(repo.root);
    const store = new ObjectStore(".pmvcs/objects"); const payload = Buffer.from("relative indexed pack identity"); const id = store.write("blob", payload);
    const result = store.compact();
    assert.equal(result.objects, 1); assert.equal(result.packs, 1); assert.equal(result.destruction.status, "completed");
    assert.equal(isAbsolute(store.storageRoot()), true); assert.deepEqual(store.read(id).payload, payload); assert.ok(store.inventory()[0].packed);
  } finally { process.chdir(original); }
});


test("every filesystem-owning constructor binds physical inputs instead of retaining caller-relative expressions", () => {
 const owners: string[] = [];
 for (const file of readdirSync(join(packageRoot,"engine")).filter(name=>name.endsWith(".ts"))) {
  const source=ts.createSourceFile(file,readFileSync(join(packageRoot,"engine",file),"utf8"),ts.ScriptTarget.Latest,true);
  for(const item of source.statements)if(ts.isClassDeclaration(item)&&item.name){
   const constructor=item.members.find(ts.isConstructorDeclaration);if(constructor===undefined)continue;
   const inputs=new Set(constructor.parameters.filter(parameter=>parameter.type?.kind===ts.SyntaxKind.StringKeyword&&/^(?:root|path|headRoot|controlDirectory)$/.test(parameter.name.getText(source))).map(parameter=>parameter.name.getText(source)));
   if(inputs.size===0)continue;owners.push(item.name.text);
   const visit=(node:ts.Node):void=>{
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(node.left)&&node.left.expression.kind===ts.SyntaxKind.ThisKeyword){
     if(item.name!.text==="WorktreeMutation"&&node.left.name.text==="controlDirectory")return; // A protected entry name beneath the captured working root.
     const inspect=(expression:ts.Node,absolute=false):void=>{
      if(ts.isCallExpression(expression)&&["resolve","realpathSync"].includes(ts.isIdentifier(expression.expression)?expression.expression.text:ts.isPropertyAccessExpression(expression.expression)?expression.expression.name.text:""))absolute=true;
      if(ts.isIdentifier(expression)&&inputs.has(expression.text)&&!(ts.isPropertyAccessExpression(expression.parent)&&expression.parent.name===expression))assert.equal(absolute,true,`${file}:${item.name!.text}.${node.left.getText(source)} retains a relative physical input`);
      ts.forEachChild(expression,child=>inspect(child,absolute));
     };inspect(node.right);
    }
    ts.forEachChild(node,visit);
   };if(constructor.body!==undefined)visit(constructor.body);
  }
 }
 assert.deepEqual(owners.sort(),["FileTransport","ObjectStore","OperationLog","PackStorage","PublicationLeases","RefStore","RemoteStore","Repository","ServedRepository","ServedRepositoryDirectories","WorktreeMutation"].sort());
});

test("seeded root spellings keep indexed reads, exclusions, GC and peer receipts in one namespace after cwd changes",async t=>{
 const outer=await fixture();const original=process.cwd();let seed=86217;let cells=0;let boundaries=0;
 const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 try{for(let trial=0;trial<32;trial++){
  const repo=Repository.init(join(outer.root,`native-${trial}`));const shadow=join(outer.root,`shadow-${trial}`);mkdirSync(shadow);writeFileSync(join(shadow,"guard"),"foreign namespace sentinel");
  process.chdir(outer.root);const coordinate=relative(outer.root,repo.objects.storageRoot());const spellings=[coordinate,`./${coordinate}`,`${coordinate}/../objects`,repo.objects.storageRoot()];const input=spellings[trial%spellings.length];
  const store=new ObjectStore(input);const packs=new PackStorage(input);const shared=new SharedObjectStore(input);const entries=new Map<string,Buffer>();
  for(let index=0;index<3;index++){const bytes=Buffer.alloc(17+next()%256);for(let i=0;i<bytes.length;i++)bytes[i]=next()>>>24;const id=store.write("blob",bytes);entries.set(id,bytes);repo.refs.compareAndSwap(`refs/metadata/live-${index}`,null,id);}
  const garbage=store.write("blob",Buffer.from(`unreachable-${trial}`));
  packBoundary.visit=()=>{process.chdir(++boundaries%2?shadow:outer.root);};process.chdir(shadow);
  const compact=packs.compact(store);assert.equal(compact.objects,4);assert.equal(compact.packs,1);assert.equal(compact.destruction.status,"completed");
  const id=entries.keys().next().value!;const payload=entries.get(id)!;
  process.chdir(outer.root);const chunks=objectPayloadChunks(relative(outer.root,join(store.storageRoot(),id.slice(0,2),id.slice(2))),id,"blob");process.chdir(shadow);assert.deepEqual(Buffer.concat([...chunks]),payload);
  const pack=packs.files()[0];assert.equal(isAbsolute(pack),true);const hint=relative(shadow,pack);assert.deepEqual(store.readInventoryObject(id,hint).payload,payload);assert.deepEqual(packs.readAt(id,hint).payload,payload);assert.deepEqual(packs.locations(new Set([hint])),[]);
  const handle=packs.locate(id,hint)!;try{assert.equal(handle.path,pack);}finally{handle.close();}
  store.withWriteLock(()=>{process.chdir(outer.root);const inventory=store.walkErasureInventory("all",new Set([relative(outer.root,pack)]));process.chdir(shadow);assert.deepEqual([...inventory],[]);});
  packs.unpack(store);assert.deepEqual(packs.files(),[]);assert.equal(store.compact().destruction.status,"completed");const collected=collectGarbage(repo,true);assert.equal(collected.destruction!.status,"completed");assert.equal(store.has(garbage),false);
  for(const [address,bytes]of entries){assert.deepEqual(store.read(address).payload,bytes);assert.deepEqual(shared.readTyped(address,"blob"),bytes);assert.deepEqual(packs.read(address)!.payload,bytes);assert.ok(store.inventory().every(entry=>isAbsolute(entry.path)));cells++;}
  assert.deepEqual(readdirSync(shadow),["guard"]);assert.equal(readFileSync(join(shadow,"guard"),"utf8"),"foreign namespace sentinel");assert.equal(objectFiles.active.size,0);packBoundary.visit=()=>{};
 }}finally{packBoundary.visit=()=>{};process.chdir(original);}
 assert.equal(cells,96);t.diagnostic(`32 seeded stores x four root spellings; ${cells} retained identities through compact/unpack/repack/GC, ${boundaries} cwd-changing publication boundaries; shadow trees unchanged`);
});

test("all physical state owners retain their original repository after cwd changes",async()=>{
 const repo=await fixture();const original=process.cwd();writeFileSync(join(repo.root,"tracked"),"captured original bytes");repo.stage(["tracked"]);const tip=repo.commit({message:"capture",author:{name:"Fixture",email:"fixture@example.invalid",timestamp:1,timezoneOffsetMinutes:0}},new Date(1));const id=repo.readIndex()[0].id;const fileId=repo.readIndex()[0].fileId!;repo.refs.compareAndSwap("refs/heads/captured-position",null,tip);repo.refs.setHeadToRef("refs/heads/captured-position");repo.refs.compareAndSwap("refs/heads/main",tip,null);
 const shadow=join(repo.root,"shadow");const decoy=Repository.init(shadow);decoy.identity();writeFileSync(join(shadow,"guard"),"foreign sentinel");
 let mutation:WorktreeMutation|undefined;let fallback:WorktreeMutation|undefined;
 try{
  process.chdir(repo.root);const opened=new Repository(".");const store=new ObjectStore(".pmvcs/objects");const shared=new SharedObjectStore(".pmvcs/objects");const packs=new PackStorage(".pmvcs/objects");const refs=new RefStore(".pmvcs");const log=new OperationLog(".pmvcs/oplog.jsonl");const remotes=new RemoteStore(".pmvcs/remotes.json");const leases=new PublicationLeases(store,".pmvcs");mutation=new WorktreeMutation(".",".pmvcs");const descriptorPaths=worktreeMutationCapabilities.descriptorPaths;try{worktreeMutationCapabilities.descriptorPaths=()=>false;fallback=new WorktreeMutation(".",".pmvcs");}finally{worktreeMutationCapabilities.descriptorPaths=descriptorPaths;}const transport=new FileTransport("fixture",".");const catalogue=new ServedRepositoryDirectories(".");
  process.chdir(shadow);assert.equal(opened.root,repo.root);assert.equal(opened.controlDirectory,repo.controlDirectory);assert.deepEqual(shared.read(id).payload,Buffer.from("captured original bytes"));assert.equal(packs.compact(store).destruction.status,"completed");assert.deepEqual(packs.read(id)!.payload,Buffer.from("captured original bytes"));
  assert.equal(refs.resolveHead(),tip);refs.compareAndSwap("refs/metadata/captured",null,id);assert.equal(repo.refs.read("refs/metadata/captured"),id);log.append("captured-path","native path owner",[],new Date(1));assert.equal(repo.operations.read().at(-1)!.command,"captured-path");remotes.add("captured","https://example.invalid/repository");assert.equal(repo.remotes.require("captured").url,"https://example.invalid/repository");
  const lease=leases.change({action:"acquire",fileId,refs:["refs/heads/main"],ttlMs:60_000})!;assert.equal(new PublicationLeases(repo.objects,repo.controlDirectory).inspect(fileId)!.generation,lease.generation);leases.change({action:"release",fileId,token:lease.token});
  mutation.write("captured-working",Buffer.from("captured root"),0o644);assert.equal(readFileSync(join(repo.root,"captured-working"),"utf8"),"captured root");assert.equal(existsSync(join(shadow,"captured-working")),false);fallback.write("captured-fallback",Buffer.from("captured fallback root"),0o644);assert.equal(readFileSync(join(repo.root,"captured-fallback"),"utf8"),"captured fallback root");assert.equal(existsSync(join(shadow,"captured-fallback")),false);assert.ok((await transport.advertise()).refs.some(ref=>ref.target===tip));assert.equal(catalogue.lookup("shadow"),shadow);
  assert.equal(decoy.refs.read("refs/metadata/captured"),null);assert.equal(decoy.remotes.read("captured"),null);assert.equal(readFileSync(join(shadow,"guard"),"utf8"),"foreign sentinel");
 }finally{fallback?.close();mutation?.close();process.chdir(original);}
});

test("every deletion-intent boundary preserves captured relative source, destination, aliases and journal through cwd changes and interruption",async t=>{
 const repo=await fixture();const original=process.cwd();let cases=0;
 const run=(name:string,ordinal:number,crash:boolean):string[]=>{
  const root=join(repo.root,name);const shadow=join(root,"shadow");mkdirSync(join(root,"control"),{recursive:true});mkdirSync(join(root,"data"));mkdirSync(join(shadow,"data"),{recursive:true});writeFileSync(join(root,"data/source"),"original source");writeFileSync(join(shadow,"data/source"),"foreign source");writeFileSync(join(shadow,"data/target"),"foreign target");const trace:string[]=[];let injected=false;
  const execute=()=>{const plan=prepareDestruction("control","relative-plan",[{path:"data/source",address:"data/source",destination:"data/target",destinationAddress:"data/target"}],false,"journal");for(const path of plan.paths)plan.remove(path);return plan.finish();};
  try{process.chdir(root);destructionBoundary.visit=step=>{trace.push(step);if(trace.length===ordinal){injected=true;process.chdir(shadow);if(crash)throw new Error("interrupted relative plan");}};
   if(crash&&ordinal>0)assert.throws(execute);else assert.equal(execute().status,"completed");
   destructionBoundary.visit=()=>{};process.chdir(root);assert.equal(execute().status,"completed");assert.equal(execute().status,"completed");assert.equal(existsSync(join(root,"data/source")),false);assert.equal(readFileSync(join(root,"data/target"),"utf8"),"original source");assert.equal(readFileSync(join(shadow,"data/source"),"utf8"),"foreign source");assert.equal(readFileSync(join(shadow,"data/target"),"utf8"),"foreign target");if(ordinal>0)assert.equal(injected,true);return trace;
  }finally{destructionBoundary.visit=()=>{};process.chdir(original);}
 };
 const steps=run("probe",0,false);for(let ordinal=1;ordinal<=steps.length;ordinal++)for(const crash of [false,true]){run(`case-${ordinal}-${crash}`,ordinal,crash);cases++;}
 assert.ok(steps.length>20);t.diagnostic(`${steps.length} deletion-intent boundaries x cwd change/interruption = ${cases} exact-set recovery cases; both shadow payloads preserved`);
});


test("relative accounting, byte-scan exclusions and returned purge authority stay bound across cwd changes",async()=>{
 const repo=await fixture();const original=process.cwd();const shadow=join(repo.root,"shadow");mkdirSync(shadow);writeFileSync(join(shadow,"guard"),"foreign namespace sentinel");const id=repo.objects.write("blob",Buffer.from("accounted original bytes"));writeFileSync(join(repo.root,"asset"),"accounted original bytes");repo.stage(["asset"]);const fileId=repo.readIndex()[0].fileId!;const empty={forbiddenIds:new Set<string>(),forbiddenPayloads:new Set<string>()};
 try{
  process.chdir(repo.root);accountabilityBoundary.visit=()=>process.chdir(shadow);const report=accountErasureStorage([".pmvcs/objects","./.pmvcs/objects"],empty);assert.equal(report.objects,1);accountabilityBoundary.visit=()=>{};
  process.chdir(repo.root);const ignored=new Set([join(".pmvcs/objects",id.slice(0,2),id.slice(2))]);assert.equal(scanErasureStorage(".pmvcs/objects",[fingerprint(Buffer.from("absent selected marker"))],ignored).files,0);
  erasureScanBoundary.visit=()=>process.chdir(shadow);assert.equal(scanErasureStorage(".pmvcs/objects",[fingerprint(Buffer.from("absent selected marker"))]).files,1);erasureScanBoundary.visit=()=>{};
  process.chdir(repo.root);const path=join(repo.objects.storageRoot(),"unaccounted");writeFileSync(path,"explicitly owned purge fixture");const selected=planErasureStorage([".pmvcs/objects"]);assert.equal(selected.length,1);
  repo.objects.withWriteLock(()=>{const purge=erasurePurge(".pmvcs",fileId,[".pmvcs/objects"],true);process.chdir(shadow);purge.begin(selected);assert.equal(purge.purge(selected[0],()=>{repo.objects.markStorageGeneration();durability.unlink(path);}),true);assert.equal(purge.receipt().deleted,1);});
  assert.equal(existsSync(path),false);assert.deepEqual(readdirSync(shadow),["guard"]);assert.equal(accountErasureStorage(repo.objects.storageRoot(),empty).objects,1);
 }finally{accountabilityBoundary.visit=()=>{};erasureScanBoundary.visit=()=>{};process.chdir(original);}
});


test("an explicit relative location hint is captured before resolve/read interleavings",async()=>{
 const repo=await fixture();const original=process.cwd();const shadow=join(repo.root,"shadow");mkdirSync(shadow);const bytes=Buffer.from("standalone relative range");const id=hashObject("blob",bytes);writeFileSync(join(repo.root,"standalone"),deflateSync(frameObject("blob",bytes)));const store=new ObjectStore(repo.root);
 try{process.chdir(repo.root);objectReadBoundary.visit=step=>{if(step==="generation")process.chdir(shadow);};const location=store.resolveLocation(id,{path:"standalone",standalone:true});try{assert.ok(location);assert.deepEqual(Buffer.concat([...objectPayloadChunks(location,id,"blob")]),bytes);}finally{location?.close();}}
 finally{objectReadBoundary.visit=()=>{};process.chdir(original);}
});


test("captured deletion aliases accept equivalent spellings and refuse every later namespace change without deleting",async t=>{
 const repo=await fixture();const original=process.cwd();let cells=0;
 try{for(const field of ["equivalent","path","address","destination","destinationAddress"] as const){
  const root=join(repo.root,field);mkdirSync(root);const shadow=join(root,"shadow");mkdirSync(shadow);writeFileSync(join(shadow,"guard"),"foreign namespace sentinel");writeFileSync(join(root,"source"),"captured source");
  process.chdir(repo.root);const request={path:`${field}/source`,address:`${field}/source`,destination:`${field}/target`,destinationAddress:`${field}/target`};const captured={...request};const plan=prepareDestruction(`${field}/control`,"aliases",[request]);
  if(field==="equivalent")for(const key of ["path","address","destination","destinationAddress"] as const)request[key]=`${field}/./${key==="path"||key==="address"?"source":"target"}`;
  else request[field]=`${field}/shadow/guard`;
  process.chdir(shadow);
  if(field!=="equivalent"){assert.throws(()=>plan.remove(plan.paths[0]),{code:"conflicting_destructive_requests"});assert.equal(readFileSync(join(root,"source"),"utf8"),"captured source");assert.equal(existsSync(join(root,"target")),false);Object.assign(request,captured);}
  plan.remove(plan.paths[0]);assert.equal(plan.finish().status,"completed");assert.equal(existsSync(join(root,"source")),false);assert.equal(readFileSync(join(root,"target"),"utf8"),"captured source");assert.deepEqual(readdirSync(shadow),["guard"]);cells++;
 }}finally{process.chdir(original);}
 assert.equal(cells,5);t.diagnostic("four changed namespace fields refuse before deletion; all four equivalent spellings remain valid across cwd changes; each recorded plan recovers");
});
