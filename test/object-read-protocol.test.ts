import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Every logical reader shares generation retries, pinned handles and terminal denial enforcement. */
import assert from "node:assert/strict";
import fs, { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { afterEach, mock, test } from "node:test";
import ts from "typescript5";
import { deflateSync } from "node:zlib";
import { syncBuiltinESMExports } from "node:module";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { ObjectStore, frameObject, OBJECT_READ_RETRIES, objectReadBoundary, type InventoryEntry } from "../engine/objects.ts";
import { PackStorage, packBoundary } from "../engine/packs.ts";
import { objectPayloadChunks } from "../engine/object-stream.ts";
import { SharedObjectStore } from "../engine/instances.ts";
import { collectGarbage } from "../engine/gc.ts";
import { Repository } from "../engine/repo.ts";
import { objectFiles, type ObjectFile } from "../engine/object-files.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { lifetimeReaders } from "./helpers/object-lifetime.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); objectFiles.opened = () => {}; packBoundary.visit = () => {}; objectReadBoundary.visit = () => {}; for (const dir of temporary.splice(0)) dir.cleanup(); });
const payload = Buffer.from("line-a\nline-b\n");
/** One real SDK tracker retains one object and permanently erases a second before all schedules. */
async function fixture() {
  const dir = makeTempDir(); temporary.push(dir);
  await new PmClient({ cwd: dir.root, pmRoot: join(dir.root, ".agents/pm"), noExtensions: true }).init("read-protocol", { defaults: true, author: "fixture" });
  const repo = Repository.init(dir.root);
  const live = repo.objects.write("blob", payload); repo.refs.compareAndSwap("refs/metadata/live", null, live);
  writeFileSync(join(dir.root, "asset"), "selected-read-protocol-erasure-936492125-long-enough"); repo.stage(["asset"]);
  const erased = repo.readIndex()[0].id; repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  repo.obliterate("asset", "erase-fixture", "fixture-cleanup", new Date(1));
  return { repo, live, erased };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Transition = "compact" | "unpack" | "repack" | "gc";
const transitions: readonly Transition[] = ["compact", "unpack", "repack", "gc"];
/** Establish each transition's source representation on the same tracker. */
function prepare(f: Fixture, transition: Transition): void {
  f.repo.objects.unpack();
  f.repo.objects.write("blob", Buffer.from("unreachable interleaving fixture"),"f".repeat(32));
  if (transition !== "compact") f.repo.objects.compact();
}
/** Invoke the complete production transaction rather than a simulated namespace mutation. */
function transition(f: Fixture, kind: Transition): void {
  if (kind === "compact") f.repo.objects.compact();
  else if (kind === "unpack") f.repo.objects.unpack();
  else if (kind === "repack") { f.repo.objects.unpack(); f.repo.objects.compact(); }
  else collectGarbage(f.repo, true);
}
/** Filtered physical inventories may be empty after retirement, but must never contain denied or incorrect bytes. */
function inventory(entries: Iterable<InventoryEntry>, id: string, denied: boolean, required = false): void {
  let found = false;
  for (const entry of entries) if (entry.id === id) {
    found = true; assert.equal(denied, false, "denied payload was emitted by an inventory"); assert.deepEqual(entry.object.payload, payload);
  }
  if (required) assert.equal(found,!denied);
}
interface Reader { readonly name: string; readonly invoke: (f: Fixture, id: string, denied: boolean) => void }
/** Explicit adapter table covers the complete exported reader surface, checked against the syntax tree below. */
const readers: readonly Reader[] = [
  { name: "has", invoke: (f,id,d) => assert.equal(f.repo.objects.has(id), !d) },
  { name: "read", invoke: (f,id) => assert.deepEqual(f.repo.objects.read(id).payload, payload) },
  { name: "readIfType", invoke: (f,id,d) => assert.deepEqual(f.repo.objects.readIfType(id,"blob")?.payload, d ? undefined : payload) },
  { name: "hasType", invoke: (f,id,d) => assert.equal(f.repo.objects.hasType(id,"blob"), !d) },
  { name: "readBoundedTyped", invoke: (f,id) => assert.deepEqual(f.repo.objects.readBoundedTyped(id,"blob"), payload) },
  { name: "readLines", invoke: (f,id) => assert.deepEqual([...f.repo.objects.readLines(id,"blob")], ["line-a","line-b"]) },
  { name: "readChunks", invoke: (f,id) => assert.deepEqual(Buffer.concat([...f.repo.objects.readChunks(id,"blob")]), payload) },
  { name: "readTyped", invoke: (f,id) => assert.deepEqual(f.repo.objects.readTyped(id,"blob"), payload) },
  { name: "state", invoke: (f,id,d) => { const state = f.repo.objects.state(id); assert.equal(state.kind,d ? "obliterated" : "present"); if (state.kind === "present") assert.deepEqual(state.object.payload,payload); } },
  { name: "hydrate", invoke: (f,id,d) => { f.repo.objects.hydrate(id); assert.equal(f.repo.objects.has(id),!d); } },
  { name: "inventory", invoke: (f,id,d) => inventory(f.repo.objects.inventory(),id,d,true) },
  { name: "walkInventory", invoke: (f,id,d) => inventory(f.repo.objects.walkInventory(),id,d,true) },
  { name: "walkLooseInventory", invoke: (f,id,d) => inventory(f.repo.objects.walkLooseInventory(),id,d) },
  { name: "walkPackedInventory", invoke: (f,id,d) => inventory(f.repo.objects.walkPackedInventory(),id,d) },
  { name: "readInventoryObject", invoke: (f,id) => assert.deepEqual(f.repo.objects.readInventoryObject(id,join(f.repo.objects.storageRoot(),id.slice(0,2),id.slice(2))).payload,payload) },
  { name: "PackStorage.has", invoke: (f,id,d) => assert.equal(new PackStorage(f.repo.objects.storageRoot()).has(id),!d) },
  { name: "PackStorage.type", invoke: (f,id,d) => assert.equal(new PackStorage(f.repo.objects.storageRoot()).type(id),d ? undefined : "blob") },
  { name: "PackStorage.read", invoke: (f,id) => assert.deepEqual(new PackStorage(f.repo.objects.storageRoot()).read(id)?.payload,payload) },
  { name: "PackStorage.readAt", invoke: (f,id) => assert.deepEqual(new PackStorage(f.repo.objects.storageRoot()).readAt(id,join(f.repo.objects.storageRoot(),id.slice(0,2),id.slice(2))).payload,payload) },
  { name: "PackStorage.inventory", invoke: (f,id,d) => inventory(new PackStorage(f.repo.objects.storageRoot()).inventory(),id,d) },
  { name: "SharedObjectStore.read", invoke: (f,id) => assert.deepEqual(new SharedObjectStore(f.repo.objects.storageRoot()).read(id).payload,payload) },
  { name: "SharedObjectStore.readBoundedTyped", invoke: (f,id) => assert.deepEqual(new SharedObjectStore(f.repo.objects.storageRoot()).readBoundedTyped(id,"blob"),payload) },
  { name: "SharedObjectStore.readLines", invoke: (f,id) => assert.deepEqual([...new SharedObjectStore(f.repo.objects.storageRoot()).readLines(id,"blob")],["line-a","line-b"]) },
  { name: "SharedObjectStore.readChunks", invoke: (f,id) => assert.deepEqual(Buffer.concat([...new SharedObjectStore(f.repo.objects.storageRoot()).readChunks(id,"blob")]),payload) },
  { name: "objectPayloadChunks", invoke: (f,id) => assert.deepEqual(Buffer.concat([...objectPayloadChunks(join(f.repo.objects.storageRoot(),id.slice(0,2),id.slice(2)),id,"blob")]),payload) },
];
/** Denial may be represented by the API's typed absence or its documented false/undefined state. */
function verify(reader: Reader, f: Fixture, id: string, denied: boolean): void {
  try { reader.invoke(f,id,denied); assert.ok(!denied || !["read","readBoundedTyped","readLines","readChunks","readTyped","readInventoryObject","PackStorage.read","PackStorage.readAt","SharedObjectStore.read","SharedObjectStore.readBoundedTyped","SharedObjectStore.readLines","SharedObjectStore.readChunks","objectPayloadChunks"].includes(reader.name), `${reader.name} returned denied bytes`); }
  catch (error) { if (!denied || !(error instanceof Error) || !("code" in error) || error.code !== "object_obliterated") throw error; }
}

test("reader surface enumeration classifies every exported operation and prevents omission of a new reader", () => {
  const excluded: Record<string,string> = {
    constructor:"construction", markStorageGeneration:"owning mutation", resolveLocation:"the common internal resolver", storageRoot:"metadata", compact:"writer", unpack:"writer", write:"writer", identity:"metadata", recordedIdentity:"metadata", adoptIdentity:"metadata", denials:"authorization metadata", denial:"authorization metadata", preflight:"writer preflight", accept:"writer", recordDenials:"writer", partialState:"metadata", uploadRoots:"root metadata", releaseUploadRoots:"writer", pinUploads:"writer", walkErasureInventory:"explicit physical inspection requires owning lease", readErasureObject:"explicit physical inspection requires owning lease", withWriteLock:"lease", withRecoveryValidation:"read-only destructive request validation under a revision CAS, not a payload reader", recoverWriterLock:"lease recovery",
  };
  const source = ts.createSourceFile("objects.ts",readFileSync(join(packageRoot,"engine/objects.ts"),"utf8"),ts.ScriptTarget.Latest,true);
  const definition = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ObjectStore")!;
  const publicMethods = definition.members.filter((member) => (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)).map((member) => ts.isConstructorDeclaration(member) ? "constructor" : member.name!.getText(source));
  assert.deepEqual(publicMethods.filter((name) => !(name in excluded)).sort(),readers.filter((reader) => !reader.name.includes(".") && reader.name !== "objectPayloadChunks").map((reader) => reader.name).sort());
  assert.deepEqual(source.statements.filter((node) => ts.isFunctionDeclaration(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).map((node) => (node as ts.FunctionDeclaration).name!.text).sort(),["assertRegistryName","frameObject","hashObject","isObjectId","parseFramedObject","readControlJson"].sort());
  // Exported free functions above are validators, frame codecs and control metadata, not object-location readers.
  const packSource = ts.createSourceFile("packs.ts",readFileSync(join(packageRoot,"engine/packs.ts"),"utf8"),ts.ScriptTarget.Latest,true);
  const packDefinition = packSource.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "PackStorage")!;
  const packExcluded = new Set(["constructor","files","locate","locations","compact","recover","unpack","verifyFile"]); // metadata, raw providers, lease-owning writers, or caller-pinned physical certification (verifyFile)
  const packReaders = packDefinition.members.filter((member) => (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)).map((member) => ts.isConstructorDeclaration(member) ? "constructor" : member.name!.getText(packSource)).filter((name) => !packExcluded.has(name));
  assert.deepEqual(packReaders.sort(),readers.filter((reader) => reader.name.startsWith("PackStorage.")).map((reader) => reader.name.slice(12)).sort());
  const streamSource = ts.createSourceFile("object-stream.ts",readFileSync(join(packageRoot,"engine/object-stream.ts"),"utf8"),ts.ScriptTarget.Latest,true);
  assert.deepEqual(streamSource.statements.filter(ts.isFunctionDeclaration).map((node) => node.name!.text),["objectPayloadChunks","verifiedPayloadChunks","objectPayloadLines"]);
  const exportedStreams=streamSource.statements.filter((node) => ts.isFunctionDeclaration(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)).map(node => (node as ts.FunctionDeclaration).name!.text);
  assert.deepEqual(exportedStreams,["objectPayloadChunks","objectPayloadLines"]); // verifiedPayloadChunks is the private lifetime wrapper; lines decodes caller-supplied chunks.
  const sharedSource = ts.createSourceFile("instances.ts",readFileSync(join(packageRoot,"engine/instances.ts"),"utf8"),ts.ScriptTarget.Latest,true);
  const sharedDefinition = sharedSource.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "SharedObjectStore")!;
  const sharedReaders = sharedDefinition.members.filter((member) => ts.isMethodDeclaration(member) && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)).map((member) => member.name!.getText(sharedSource));
  assert.deepEqual(sharedReaders.sort(),readers.filter((reader) => reader.name.startsWith("SharedObjectStore.")).map((reader) => reader.name.slice(18)).sort());
  assert.equal(readers.length,25);
  assert.deepEqual(Object.keys(lifetimeReaders).sort(),readers.map((reader) => reader.name).sort());
});

test("EVERY reader x EVERY compact/unpack/repack/GC boundary retains live bytes and never resurrects an erased object", async (t) => {
  const f = await fixture(); let boundaries = 0; let cells = 0;
  for (const kind of transitions) {
    prepare(f,kind); let steps = 0;
    packBoundary.visit = () => { steps++; for (const reader of readers) { verify(reader,f,f.live,false); verify(reader,f,f.erased,true); cells += 2; } };
    transition(f,kind); packBoundary.visit = () => {}; assert.ok(steps > 0); boundaries += steps; t.diagnostic(`${kind}: ${steps} write boundaries`);
  }
  assert.ok(boundaries >= 20); assert.equal(cells,boundaries * readers.length * 2);
  t.diagnostic(`writer matrix: ${readers.length} readers x ${boundaries} boundaries x live/erased = ${cells} cells on one non-git tracker`);
});

test("EVERY reader retries from the top or pins its opened handle when each storage transition interrupts resolution", async (t) => {
  const f = await fixture(); let cells = 0;
  for (const reader of readers) for (const kind of transitions) for (const boundary of ["generation-marker","generation","loose","pack-catalog","resolved","pinned","inventory"]) {
    prepare(f,kind); let injected = false;
    objectReadBoundary.visit = (step) => { if (step !== boundary || injected) return; injected = true; objectReadBoundary.visit = () => {}; transition(f,kind); };
    verify(reader,f,f.live,false); objectReadBoundary.visit = () => {};
    verify(reader,f,f.erased,true); cells++;
  }
  assert.equal(cells,700); t.diagnostic(`resolution matrix: ${readers.length} readers x 4 transitions x 7 resolver boundaries = ${cells} schedules, plus erased checks`);
});

test("a retained object retries a retired pack catalog after concurrent GC repacks its survivors", async () => {
  const f = await fixture(); prepare(f,"gc"); let injected = false;
  objectReadBoundary.visit = (step,id) => {
    if (step !== "pack-catalog" || id !== f.live || injected) return;
    injected = true; objectReadBoundary.visit = () => {}; collectGarbage(f.repo,true);
  };
  assert.equal(f.repo.objects.has(f.live),true); assert.equal(injected,true);
  assert.deepEqual(f.repo.objects.readTyped(f.live,"blob"),payload);
});

test("streams retain an opened representation across repack and stop between buffered lines after terminal denial", async () => {
  const f = await fixture(); f.repo.objects.compact();
  const lines = f.repo.objects.readLines(f.live,"blob"); assert.equal(lines.next().value,"line-a");
  transition(f,"repack"); assert.deepEqual([...lines],["line-b"]);
  const pinned = f.repo.objects.resolveLocation(f.live)!;
  const deniedLines = f.repo.objects.readLines(f.live,"blob"); assert.equal(deniedLines.next().value,"line-a");
  writeFileSync(join(f.repo.root,"stream-live"),payload); f.repo.stage(["stream-live"]);
  const record = f.repo.objects.recordDenials.bind(f.repo.objects); let pendingChecks = 0;
  f.repo.objects.recordDenials = (denials) => {
    record(denials);
    if (denials.some((denial) => denial.pending)) for (const reader of readers) { verify(reader,f,f.live,true); pendingChecks++; }
  };
  f.repo.obliterate("stream-live","erase-fixture","fixture-stream-cleanup",new Date(2));
  assert.equal(pendingChecks,readers.length);
  assert.throws(() => [...objectPayloadChunks(pinned,f.live,"blob")],{code:"object_obliterated"});
  assert.throws(() => deniedLines.next(),{code:"object_obliterated"});
  for (const reader of readers) verify(reader,f,f.live,true);
});

test("retry exhaustion is typed after exactly eight generations; stable absence is the only not-found result", async () => {
  const f = await fixture(); let attempts = 0;
  objectReadBoundary.visit = (step) => { if (step === "generation") { attempts++; f.repo.objects.withWriteLock(() => f.repo.objects.markStorageGeneration()); } };
  assert.throws(() => f.repo.objects.has(f.live),{code:"object_store_changing"}); assert.equal(attempts,OBJECT_READ_RETRIES);
  attempts = 0; assert.throws(() => f.repo.objects.state(f.live),{code:"object_store_changing"}); assert.equal(attempts,OBJECT_READ_RETRIES);
  objectReadBoundary.visit = () => {};
  assert.equal(f.repo.objects.hasType("f".repeat(64),"blob"),false);
  assert.throws(() => f.repo.objects.hasType("invalid","blob"),{code:"invalid_object_id"});
  assert.equal(f.repo.objects.has("f".repeat(64)),false); assert.throws(() => f.repo.objects.read("f".repeat(64)),{code:"object_not_found"});
  assert.throws(() => [...f.repo.objects.walkErasureInventory()],{code:"physical_read_requires_lease"});
  assert.throws(() => f.repo.objects.resolveLocation(f.live,{physical:true}),{code:"physical_read_requires_lease"});
  assert.throws(() => [...new SharedObjectStore(f.repo.objects.storageRoot()).readChunks("f".repeat(64),"blob")],{code:"missing_fragment"});
  assert.throws(() => [...new SharedObjectStore(f.repo.objects.storageRoot()).readChunks(f.live,"tree")],{code:"object_type_mismatch"});
});


test("generation metadata refuses corruption and retries inconsistent snapshots and failed opens without masking stable I/O errors", async () => {
  const f = await fixture(); const store = f.repo.objects; const marker = join(f.repo.controlDirectory,"objects.generation");
  const original = readFileSync(marker); assert.throws(() => store.markStorageGeneration(),{code:"store_locked"});
  for (const invalid of [7,"bad"]) { writeFileSync(marker,JSON.stringify(invalid)); assert.throws(() => store.has(f.live),{code:"bad_storage_generation"}); }
  writeFileSync(marker,original);
  let changed = false;
  objectReadBoundary.visit = (step) => {
    if (step !== "generation-marker" || changed) return; changed = true; objectReadBoundary.visit = () => {}; store.withWriteLock(() => store.markStorageGeneration());
  };
  assert.ok(store.has(f.live)); assert.ok(changed);
  objectReadBoundary.visit = (step) => { if (step === "generation-marker") store.withWriteLock(() => store.markStorageGeneration()); };
  assert.throws(() => store.inventory(),{code:"object_store_changing"}); objectReadBoundary.visit = () => {};
  for (const boundary of ["resolved","pinned"]) {
    let once = false; objectReadBoundary.visit = (step) => { if (step !== boundary || once) return; once = true; objectReadBoundary.visit = () => {}; store.compact(); throw Object.assign(new Error("retired during open"),{code:"ENOENT"}); };
    assert.deepEqual(store.readTyped(f.live,"blob"),payload); assert.ok(once); store.unpack();
  }
  objectReadBoundary.visit = (step) => { if (step === "pinned") throw Object.assign(new Error("stable disk failure"),{code:"EIO"}); };
  assert.throws(() => store.has(f.live),{code:"EIO"}); objectReadBoundary.visit = () => {};
  const open = fs.openSync;
  mock.method(fs,"openSync",(...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).endsWith(f.live.slice(2))) throw Object.assign(new Error("stable inventory permission failure"),{code:"EACCES"});
    return open(...args);
  }); syncBuiltinESMExports();
  assert.throws(() => store.inventory(),{code:"EACCES"});
  mock.restoreAll(); syncBuiltinESMExports();
  const stat = fs.fstatSync;
  mock.method(fs,"fstatSync",() => { throw Object.assign(new Error("descriptor unavailable"),{code:"EIO"}); }); syncBuiltinESMExports();
  assert.throws(() => store.resolveLocation(f.live),{code:"EIO"});
  assert.throws(() => store.resolveLocation(f.live,{path:join(store.storageRoot(),f.live.slice(0,2),f.live.slice(2)),standalone:true}),{code:"EIO"});
  mock.restoreAll(); syncBuiltinESMExports(); assert.equal(typeof stat,"function");
});

test("inventory retries catalog errors after transitions and deduplicates a retired physical fallback", async () => {
  const f = await fixture(); const store = f.repo.objects; const loose = join(store.storageRoot(),f.live.slice(0,2),f.live.slice(2));
  const backup = join(f.repo.root,"saved-compressed"); copyFileSync(loose,backup); store.compact();
  store.withWriteLock(() => { store.markStorageGeneration(); copyFileSync(backup,loose); });
  const entries = store.walkInventory(); assert.ok(entries.next().value);
  store.unpack(); assert.equal([...entries].filter((entry) => entry.id === f.live).length,0);
  store.compact(); let once = false; const open = fs.openSync;
  mock.method(fs,"openSync",(...args: Parameters<typeof fs.openSync>) => {
    if (!once && String(args[0]).endsWith(".pack")) { once = true; store.unpack(); throw Object.assign(new Error("catalog retired"),{code:"ENOENT"}); }
    return open(...args);
  }); syncBuiltinESMExports();
  assert.ok(store.inventory().some((entry) => entry.id === f.live)); assert.ok(once);
  mock.restoreAll(); syncBuiltinESMExports();
  objectReadBoundary.visit = (step) => { if (step === "pinned") { objectReadBoundary.visit = () => {}; const dir = join(store.storageRoot(),f.live.slice(0,2)); fs.renameSync(dir,dir+"-old"); writeFileSync(dir,"replacement"); } };
  assert.deepEqual(store.readInventoryObject(f.live,loose).payload,payload);
  assert.throws(() => store.readInventoryObject(f.live,loose),{code:"unsupported_erasure_storage"});
});

test("a pinned packed member refuses truncation without returning neighboring or unverified bytes", async () => {
  const f = await fixture(); const store = f.repo.objects; store.compact();
  const pack = store.inventory().find((entry) => entry.id === f.live)!.path;
  assert.deepEqual(Buffer.concat([...objectPayloadChunks(pack,f.live,"blob")]),payload);
  const location = store.resolveLocation(f.live)!; const length = location.length; location.close();
  const read = fs.readSync;
  mock.method(fs,"readSync",(fd: number, buffer: Buffer, offset: number, size: number, position: number) => { if (size === length) return 0; return read(fd,buffer,offset,size,position); }); syncBuiltinESMExports();
  assert.throws(() => store.read(f.live),{code:"corrupt_pack"});
  assert.throws(() => new PackStorage(store.storageRoot()).type(f.live),{code:"corrupt_pack"});
  mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(new PackStorage(store.storageRoot()).type("f".repeat(64)),undefined);
  const loose = join(store.storageRoot(),f.live.slice(0,2),f.live.slice(2)); mkdirSync(loose); assert.equal(store.has(f.live),false);
});


test("recognized loose temporary streams enforce the store's permanent denial before decoding", async () => {
  const f = await fixture(); const temporary = join(f.repo.objects.storageRoot(),f.erased.slice(0,2),`${f.erased.slice(2)}.123.abcdef123456.tmp`);
  writeFileSync(temporary,deflateSync(frameObject("blob",Buffer.from("selected-read-protocol-erasure-936492125-long-enough"))));
  assert.throws(() => [...objectPayloadChunks(temporary,f.erased,"blob")],{code:"object_obliterated"});
  // Raw arbitrary-file decoding remains a codec; native object addresses, packs and recognized temporaries have store authorization.
  assert.ok(f.repo.objects.inventory().every((entry) => entry.id !== f.erased));
});


test("EVERY pinned reader boundary tolerates an external retirement with unchanged generation and lock", async(t)=>{
  const f=await fixture(); const store=f.repo.objects; let schedules=0; let points=0; let empty=0;
  /** Record every actual descriptor fstat/read boundary and every visibility check after resolution. */
  const observe=(reader:Reader,ordinal:number,plan:string):string[]=>{
    const trace:string[]=[]; const owners=new Map<ObjectFile,string>(); const pinned=new Set<ObjectFile>(); let injected=false;
    const root=store.storageRoot();
    /** Inject one competing process while preserving the exact observed generation/lease state. */
    const boundary=(name:string):void=>{
      trace.push(name);
      if(ordinal===0 || trace.length!==ordinal) return;
      const marker=readFileSync(join(f.repo.controlDirectory,"objects.generation")); const lock=fs.lstatSync(join(f.repo.controlDirectory,"objects.lock"),{bigint:true});
      const child=spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/external-object-retirement.ts"),plan],{env:{...testEnvironment(),...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.repo.root)},encoding:"utf8",timeout:30_000});
      assert.equal(child.status,0,child.stderr); assert.deepEqual(readFileSync(join(f.repo.controlDirectory,"objects.generation")),marker);
      const same=fs.lstatSync(join(f.repo.controlDirectory,"objects.lock"),{bigint:true}); assert.equal(same.ino,lock.ino); assert.equal(same.mtimeNs,lock.mtimeNs); injected=true;
    };
    objectFiles.opened=(file,path)=>{owners.set(file,path);};
    objectReadBoundary.visit=(step)=>{
      if(step==="pinned") { for(const file of objectFiles.active) if(owners.get(file)?.startsWith(root+"/")) pinned.add(file); boundary("pinned"); }
      if(step==="pinned-check") boundary("pinned-check");
    };
    for(const name of ["fstatSync","readSync","readFileSync"] as const) {
      const original=fs[name];
      mock.method(fs,name,(...args:unknown[])=>{
        const active=typeof args[0]==="number" && [...pinned].some((file)=>file.fd===args[0]&&objectFiles.active.has(file));
        if(active) boundary(`${name}:before`);
        const value:unknown=Reflect.apply(original,fs,args);
        if(active) boundary(`${name}:after`);
        return value;
      });
    }
    const stat=fs.lstatSync;
    mock.method(fs,"lstatSync",(...args:Parameters<typeof fs.lstatSync>)=>{
      if([...pinned].some((file)=>objectFiles.active.has(file)) && (String(args[0])===root || String(args[0]).startsWith(root+"/"))) throw new Error("Pinned reader rechecked a retired pathname");
      return stat(...args);
    }); syncBuiltinESMExports();
    try { store.withWriteLock(()=>verify(reader,f,f.live,false)); if(ordinal>0) assert.ok(injected,`${reader.name} missing boundary ${ordinal}`); }
    finally { mock.restoreAll(); syncBuiltinESMExports(); objectFiles.opened=()=>{}; objectReadBoundary.visit=()=>{}; }
    return trace;
  };
  for(const reader of readers) for(const packed of [false,true]) {
    /** Restore the same fixture representation before discovery and each independent injection schedule. */
    const preparePlan=():string=>{
      store.unpack(); if(packed) store.compact();
      const entries=store.inventory(); const plan=join(f.repo.root,"external-retirement-plan.json");
      writeFileSync(plan,JSON.stringify({loose:entries.map((entry)=>({path:join(store.storageRoot(),entry.id.slice(0,2),entry.id.slice(2)),bytes:deflateSync(frameObject(entry.object.type,entry.object.payload)).toString("base64")})),packs:[...new Set(entries.filter((entry)=>entry.packed!==undefined).map((entry)=>entry.path))]}));
      return plan;
    };
    const trace=observe(reader,0,preparePlan()); if(trace.length===0) empty++; points+=trace.length;
    for(let ordinal=1;ordinal<=trace.length;ordinal++) { observe(reader,ordinal,preparePlan()); verify(reader,f,f.erased,true); schedules++; }
  }
  assert.equal(schedules,points); assert.equal(empty,3); t.diagnostic(`${readers.length} readers x loose/packed: ${schedules} actual pinned/native I/O boundary injections; independent process preserves generation and writer-lock inode/mtime; erased reads remain denied`);
});


test("pinned inventory survives external unpack with identical generation and writer lock",async()=>{
  const f=await fixture(); f.repo.objects.compact(); const store=f.repo.objects;
  const entries=store.inventory(); const pack=entries.find((entry)=>entry.id===f.live)!.path;
  const plan=join(f.repo.root,"external-plan.json");
  writeFileSync(plan,JSON.stringify({loose:entries.map((entry)=>({path:join(store.storageRoot(),entry.id.slice(0,2),entry.id.slice(2)),bytes:deflateSync(frameObject(entry.object.type,entry.object.payload)).toString("base64")})),packs:[...new Set(entries.map((entry)=>entry.path))]}));
  store.withWriteLock(()=>{
    const marker=readFileSync(join(f.repo.controlDirectory,"objects.generation"));const lock=fs.lstatSync(join(f.repo.controlDirectory,"objects.lock"),{bigint:true});let once=false;
    objectReadBoundary.visit=(step)=>{if(step!=="pinned"||once)return;once=true;objectReadBoundary.visit=()=>{};
      const child=spawnSync(process.execPath,[join(packageRoot,"test/helpers/external-object-retirement.ts"),plan],{env:{...testEnvironment(),...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.repo.root)},encoding:"utf8",timeout:30_000});assert.equal(child.status,0,child.stderr);
    };
    assert.deepEqual(store.readInventoryObject(f.live,pack).payload,payload);assert.ok(once);
    assert.deepEqual(readFileSync(join(f.repo.controlDirectory,"objects.generation")),marker);assert.equal(fs.lstatSync(join(f.repo.controlDirectory,"objects.lock"),{bigint:true}).ino,lock.ino);
  });
});


test("pinned inventory rejects in-place same-size mutation and a directory substituted before pinning",async()=>{
  const f=await fixture();const store=f.repo.objects;const path=join(store.storageRoot(),f.live.slice(0,2),f.live.slice(2));
  const read=fs.readFileSync;let once=false;
  mock.method(fs,"readFileSync",(...args:Parameters<typeof fs.readFileSync>)=>{
    const value=read(...args);if(typeof args[0]==="number"&&!once){once=true;const bytes=read(path);bytes[0]^=1;writeFileSync(path,bytes);fs.utimesSync(path,1,2);}return value;
  });syncBuiltinESMExports();assert.throws(()=>store.readInventoryObject(f.live,path),{code:"unsupported_erasure_storage"});mock.restoreAll();syncBuiltinESMExports();
  writeFileSync(path,deflateSync(frameObject("blob",payload)));
  objectReadBoundary.visit=(step)=>{if(step==="generation"){objectReadBoundary.visit=()=>{};fs.unlinkSync(path);mkdirSync(path);}};
  assert.throws(()=>store.readInventoryObject(f.live,path),{code:"unsupported_erasure_storage"});
});


test("EVERY reader retains relative-construction identity at EVERY maintenance boundary after cwd changes",async t=>{
 const original=process.cwd();let cells=0;let boundaries=0;
 try{for(let spelling=0;spelling<4;spelling++){
  const f=await fixture();process.chdir(f.repo.root);const root=[".","./",".pmvcs/..",f.repo.root][spelling];const captured={...f,repo:Repository.open(root)};const shadow=join(f.repo.root,"relative-shadow");mkdirSync(shadow);writeFileSync(join(shadow,"guard"),"foreign namespace sentinel");
  for(const kind of transitions){prepare(captured,kind);let steps=0;packBoundary.visit=()=>{process.chdir(shadow);steps++;for(const reader of readers){verify(reader,captured,f.live,false);verify(reader,captured,f.erased,true);cells+=2;}};transition(captured,kind);packBoundary.visit=()=>{};assert.ok(steps>0);boundaries+=steps;for(const reader of readers){verify(reader,captured,f.live,false);verify(reader,captured,f.erased,true);}}
  assert.deepEqual(fs.readdirSync(shadow),["guard"]);assert.equal(readFileSync(join(shadow,"guard"),"utf8"),"foreign namespace sentinel");process.chdir(original);
 }}finally{packBoundary.visit=()=>{};process.chdir(original);}
 assert.equal(cells,boundaries*readers.length*2);t.diagnostic(`4 root spellings x ${readers.length} readers, ${boundaries} maintenance boundaries, ${cells} live/erased checks after cwd changes`);
});
