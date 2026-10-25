/** Every logical reader shares generation retries, pinned handles and terminal denial enforcement. */
import assert from "node:assert/strict";
import fs, { closeSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); packBoundary.visit = () => {}; objectReadBoundary.visit = () => {}; for (const dir of temporary.splice(0)) dir.cleanup(); });
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
    constructor:"construction", markStorageGeneration:"owning mutation", resolveLocation:"the common internal resolver", storageRoot:"metadata", compact:"writer", unpack:"writer", write:"writer", identity:"metadata", recordedIdentity:"metadata", adoptIdentity:"metadata", denials:"authorization metadata", denial:"authorization metadata", preflight:"writer preflight", accept:"writer", recordDenials:"writer", partialState:"metadata", uploadRoots:"root metadata", releaseUploadRoots:"writer", pinUploads:"writer", walkErasureInventory:"explicit physical inspection requires owning lease", readErasureObject:"explicit physical inspection requires owning lease", withWriteLock:"lease", recoverWriterLock:"lease recovery",
  };
  const source = ts.createSourceFile("objects.ts",readFileSync(join(packageRoot,"engine/objects.ts"),"utf8"),ts.ScriptTarget.Latest,true);
  const definition = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ObjectStore")!;
  const publicMethods = definition.members.filter((member) => (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)).map((member) => ts.isConstructorDeclaration(member) ? "constructor" : member.name!.getText(source));
  assert.deepEqual(publicMethods.filter((name) => !(name in excluded)).sort(),readers.filter((reader) => !reader.name.includes(".") && reader.name !== "objectPayloadChunks").map((reader) => reader.name).sort());
  assert.deepEqual(source.statements.filter((node) => ts.isFunctionDeclaration(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).map((node) => (node as ts.FunctionDeclaration).name!.text).sort(),["assertRegistryName","frameObject","hashObject","isObjectId","parseFramedObject","readControlJson"].sort());
  // Exported free functions above are validators, frame codecs and control metadata, not object-location readers.
  const packSource = ts.createSourceFile("packs.ts",readFileSync(join(packageRoot,"engine/packs.ts"),"utf8"),ts.ScriptTarget.Latest,true);
  const packDefinition = packSource.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "PackStorage")!;
  const packExcluded = new Set(["constructor","files","locate","locations","compact","recover","unpack"]); // metadata, raw providers, or lease-owning writers
  const packReaders = packDefinition.members.filter((member) => (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)).map((member) => ts.isConstructorDeclaration(member) ? "constructor" : member.name!.getText(packSource)).filter((name) => !packExcluded.has(name));
  assert.deepEqual(packReaders.sort(),readers.filter((reader) => reader.name.startsWith("PackStorage.")).map((reader) => reader.name.slice(12)).sort());
  const streamSource = ts.createSourceFile("object-stream.ts",readFileSync(join(packageRoot,"engine/object-stream.ts"),"utf8"),ts.ScriptTarget.Latest,true);
  assert.deepEqual(streamSource.statements.filter(ts.isFunctionDeclaration).map((node) => node.name!.text),["objectPayloadChunks","objectPayloadLines"]); // lines is a pure decoder of caller-supplied chunks
  const sharedSource = ts.createSourceFile("instances.ts",readFileSync(join(packageRoot,"engine/instances.ts"),"utf8"),ts.ScriptTarget.Latest,true);
  const sharedDefinition = sharedSource.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "SharedObjectStore")!;
  const sharedReaders = sharedDefinition.members.filter((member) => ts.isMethodDeclaration(member) && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)).map((member) => member.name!.getText(sharedSource));
  assert.deepEqual(sharedReaders.sort(),readers.filter((reader) => reader.name.startsWith("SharedObjectStore.")).map((reader) => reader.name.slice(18)).sort());
  assert.equal(readers.length,25);
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
  const deniedLines = f.repo.objects.readLines(f.live,"blob"); assert.equal(deniedLines.next().value,"line-a");
  writeFileSync(join(f.repo.root,"stream-live"),payload); f.repo.stage(["stream-live"]);
  const record = f.repo.objects.recordDenials.bind(f.repo.objects); let pendingChecks = 0;
  f.repo.objects.recordDenials = (denials) => {
    record(denials);
    if (denials.some((denial) => denial.pending)) for (const reader of readers) { verify(reader,f,f.live,true); pendingChecks++; }
  };
  f.repo.obliterate("stream-live","erase-fixture","fixture-stream-cleanup",new Date(2));
  assert.equal(pendingChecks,readers.length);
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
  assert.throws(() => store.readInventoryObject(f.live,loose),{code:"unsupported_erasure_storage"});
});

test("a pinned packed member refuses truncation without returning neighboring or unverified bytes", async () => {
  const f = await fixture(); const store = f.repo.objects; store.compact();
  const location = store.resolveLocation(f.live)!; const length = location.length; closeSync(location.fd);
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
