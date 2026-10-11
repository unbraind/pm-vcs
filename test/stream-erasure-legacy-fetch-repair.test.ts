/** Real arrival, streaming loose-storage and legacy no-op fetch regressions. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { exportBundle, importBundleObjects, serializeBundle } from "../engine/bundle.ts";
import { encodeTombstone, type ObjectArrival } from "../engine/lifecycle.ts";
import { frameObject, hashObject, ObjectStore } from "../engine/objects.ts";
import { type Signature } from "../engine/model.ts";
import { Repository } from "../engine/repo.ts";
import { fetchFrom } from "../engine/sync.ts";
import { FileTransport, type Transport } from "../engine/transport.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const temps: ReturnType<typeof makeTempDir>[] = [];
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1000, timezoneOffsetMinutes: 0 };
const selectedBytes = Buffer.from("selected unique streaming fixture 762981354");
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); for (const temp of temps.splice(0)) temp.cleanup(); });

/** Ordinary repository storage and committed identities, without transport doubles. */
function fixture() {
  const temp = makeTempDir(); temps.push(temp);
  const repo = Repository.init(join(temp.root, "repo")); repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  const tip = commit(repo, "selected", selectedBytes);
  return { repo, temp, tip, selected: repo.readIndex()[0]! };
}

/** Commit real bytes and retain the engine's actual stable FileId attribution. */
function commit(repo: Repository, path: string, bytes: Buffer): string {
  writeFileSync(join(repo.root, path), bytes); repo.stage([path]);
  return repo.commit({ message: "fixture", author }, new Date(1000));
}

/** Exact physical object path for disposable corruption/copy fixtures. */
function objectPath(repo: Repository, id: string): string { return join(repo.controlDirectory, "objects", id.slice(0, 2), id.slice(2)); }

/** Compare all durable bytes, including refs, index, log and loose copies. */
function durable(repo: Repository) {
  return readdirSync(repo.controlDirectory, { recursive: true, encoding: "utf8" }).filter(path => lstatSync(join(repo.controlDirectory, path)).isFile())
    .sort().map(path => [path, createHash("sha256").update(readFileSync(join(repo.controlDirectory, path))).digest("hex")]);
}

test("arrival import performs only locked accept's local preflight after the combined denial check", () => {
  const { repo } = fixture(); repo.obliterate("selected", "erase-fixture", "incident", new Date(2000));
  const source = Repository.init(join(temps[0]!.root, "source")); const payload = Buffer.from("independent incoming ordinary bytes");
  const id = source.objects.write("blob", payload); const bundle = serializeBundle(source.objects, { refs: {}, prerequisites: [], objects: [id] });
  const preflight = ObjectStore.prototype.preflight;
  const observed: { objects: readonly ObjectArrival[]; attributed: boolean }[] = [];
  mock.method(repo.objects, "preflight", (objects: readonly ObjectArrival[], attributed: boolean) => {
    observed.push({ objects, attributed }); return preflight.call(repo.objects, objects, attributed);
  });
  assert.deepEqual(importBundleObjects(repo.objects, bundle).added, [id]);
  assert.equal(observed.length, 1, "one genuine local inspection remains inside locked accept");
  assert.equal(observed[0]!.attributed, true); assert.deepEqual(observed[0]!.objects.map(object => object.id), [id]);
  assert.deepEqual(repo.objects.read(id).payload, payload);
  observed.length = 0; const before = durable(repo);
  assert.deepEqual(importBundleObjects(repo.objects, bundle).added, []); assert.equal(observed.length, 1); assert.deepEqual(durable(repo), before);
});

for (const outcome of ["denied", "pending", "conflicting", "malformed"] as const) test(`arrival ${outcome} refuses before any accept or durable mutation`, () => {
  const { repo, selected } = fixture(); repo.obliterate("selected", "erase-fixture", "incident", new Date(2000));
  const denial = repo.objects.denials()[0]!; const survivor = Buffer.from("ordinary earlier valid arrival"); const survivorId = hashObject("blob", survivor);
  const header: Record<string, unknown> = { refs: {}, prerequisites: [], objects: [survivorId], denials: [denial] };
  const lines = [`blob ${survivorId} ${survivor.toString("base64")}`];
  if (outcome === "denied") { header.objects = [survivorId, selected.id]; lines.push(`blob ${selected.id} ${selectedBytes.toString("base64")}`); }
  if (outcome === "pending") repo.objects.recordDenials([{ ...denial, pending: true }]);
  if (outcome === "conflicting") {
    const tombstone = { ...denial.tombstone, reason: "different" };
    header.denials = [{ id: hashObject("tombstone", encodeTombstone(tombstone)), tombstone, pending: false }];
  }
  if (outcome === "malformed") lines.push(`blob ${"f".repeat(64)} ${Buffer.from("mismatch").toString("base64")}`);
  const before = durable(repo); const accept = ObjectStore.prototype.accept; let accepted = 0;
  mock.method(repo.objects, "accept", (objects: readonly ObjectArrival[], attributed: boolean) => { accepted++; return accept.call(repo.objects, objects, attributed); });
  const bundle = Buffer.from(["pmvcs-bundle-1", JSON.stringify(header), ...lines, ""].join("\n"));
  const code = { denied: "object_obliterated", pending: "erasure_incomplete", conflicting: "tombstone_conflict", malformed: "bad_bundle" }[outcome];
  assert.throws(() => importBundleObjects(repo.objects, bundle), { code }); assert.equal(accepted, 0); assert.deepEqual(durable(repo), before);
});

test("streaming erasure does not retain a bounded 32 MiB unrelated loose-leaf corpus", () => {
  const { repo, selected } = fixture();
  for (let i = 0; i < 32; i++) { const bytes = Buffer.alloc(1024 * 1024, 255); bytes.writeUInt32LE(i, 0); repo.objects.write("blob", bytes); }
  const program = `import { Repository } from ${JSON.stringify(pathToFileURL(join(packageRoot, "engine/repo.ts")).href)};
const repo=Repository.open(process.argv[1]); globalThis.gc(); const baseline=process.memoryUsage();
const original=Repository.prototype.readIndex; let reads=0; let measured;
Repository.prototype.readIndex=function(...args){const result=original.apply(this,args); if(++reads===2){globalThis.gc(); measured=process.memoryUsage();} return result;};
const receipt=repo.obliterate("selected","erase-fixture","incident",new Date(2000));
console.log(JSON.stringify({reads, retained:measured.arrayBuffers-baseline.arrayBuffers, external:measured.external-baseline.external, rss:measured.rss-baseline.rss, maxRSS:process.resourceUsage().maxRSS, removed:receipt.removed}));`;
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", program, repo.root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  const measured = JSON.parse(child.stdout) as { reads: number; retained: number; external: number; rss: number; maxRSS: number; removed: string[] };
  assert.ok(measured.reads >= 2); assert.deepEqual(measured.removed, [selected.id]);
  console.log(`streaming erasure ordinary 32 MiB corpus: ${JSON.stringify(measured)}`);
  assert.ok(measured.retained < 8 * 1024 * 1024, `unrelated payloads retained ${measured.retained} bytes at completed inventory boundary`);
  assert.equal(existsSync(objectPath(repo, selected.id)), false); assert.equal(repo.objects.inventory().filter(entry => entry.object.type === "blob").length, 32);
});

/** Legacy adapter delegates all actual advertisements and archives, omitting only its unsupported object-fetch operation. */
function legacyTransport(repo: Repository, requests: string[][]): Transport {
  const wire = new FileTransport(repo.root, repo.root);
  return {
    url: wire.url,
    advertise: async () => { const advertisement = await wire.advertise(); return { ...advertisement, capabilities: advertisement.capabilities.filter(capability => capability !== "object-fetch") }; },
    fetch: async (refs, haves) => { requests.push([...refs]); return wire.fetch(refs, haves); },
    push: (...args) => wire.push(...args), missingObjects: (...args) => wire.missingObjects(...args),
    uploadObjects: (...args) => wire.uploadObjects(...args), publish: (...args) => wire.publish(...args),
  };
}

for (const mixed of [false, true]) test(`legacy no-op ${mixed ? "mixed refs" : "conflicting-only tags"} never fetches conflict history`, async () => {
  const { repo: peer, temp, tip } = fixture(); const local = Repository.init(join(temp.root, "local"));
  const own = commit(local, "own", Buffer.from("independent local tag history"));
  peer.refs.compareAndSwap("refs/tags/conflict", null, tip); local.refs.compareAndSwap("refs/tags/conflict", null, own);
  if (!mixed) peer.refs.transaction([{ name: "refs/heads/main", expected: tip, next: null }]);
  else importBundleObjects(local.objects, exportBundle(peer.objects, peer.refs, ["refs/heads/main"]));
  // A distinct tag-only commit cannot be present through the current branch.
  const conflict = commit(peer, "conflict-only", Buffer.from("remote conflicting tag payload"));
  peer.refs.transaction([{ name: "refs/tags/conflict", expected: tip, next: conflict }, { name: "refs/heads/main", expected: conflict, next: mixed ? tip : null }]);
  local.remotes.add("peer", peer.root);
  if (mixed) local.refs.transaction([{ name: "refs/remotes/peer/main", expected: null, next: tip }]);
  const before = durable(local); const requests: string[][] = []; const read = ObjectStore.prototype.read; let conflictReads = 0;
  mock.method(ObjectStore.prototype, "read", function (this: ObjectStore, id: string) { if (id === conflict) conflictReads++; return read.call(this, id); });
  for (let i = 0; i < 2; i++) {
    const report = await fetchFrom(local, "peer", new Date(3000), legacyTransport(peer, requests));
    assert.deepEqual(report.conflictingTags, ["conflict"]); assert.deepEqual(report.updated, []); assert.deepEqual(report.added, []); assert.equal(report.upToDate, true);
    assert.deepEqual(durable(local), before); assert.equal(local.objects.has(conflict), false);
  }
  assert.deepEqual(requests, mixed ? [["refs/heads/main"], ["refs/heads/main"]] : []); assert.equal(conflictReads, 0);
});

test("legacy first fetch updates eligible refs, keeps tag conflicts, then requests only current refs", async () => {
  const { repo: peer, temp, tip } = fixture(); const local = Repository.init(join(temp.root, "local"));
  const own = commit(local, "own", Buffer.from("local history")); local.refs.compareAndSwap("refs/tags/conflict", null, own); peer.refs.compareAndSwap("refs/tags/conflict", null, tip);
  peer.refs.compareAndSwap("refs/tags/current", null, tip); local.remotes.add("peer", peer.root); const requests: string[][] = []; const wire = legacyTransport(peer, requests);
  const first = await fetchFrom(local, "peer", new Date(3000), wire); assert.equal(first.upToDate, false); assert.ok(first.added.includes(tip));
  assert.deepEqual(first.conflictingTags, ["conflict"]); assert.equal(first.updated.length, 2); assert.equal(local.refs.read("refs/tags/conflict"), own);
  const before = durable(local); const repeat = await fetchFrom(local, "peer", new Date(4000), wire);
  assert.equal(repeat.upToDate, true); assert.deepEqual(repeat.added, []); assert.deepEqual(durable(local), before);
  assert.deepEqual(requests, [["refs/heads/main", "refs/tags/current"], ["refs/heads/main", "refs/tags/current"]]);
});

test("supported metadata-only fetch reports a new denial then a real no-op without moving refs", async () => {
  const { repo: peer, temp, tip } = fixture(); peer.obliterate("selected", "erase-fixture", "incident", new Date(2000));
  const local = Repository.init(join(temp.root, "local")); local.remotes.add("peer", peer.root);
  // Hold genuine structural history before the new denial arrives, with no selected physical bytes.
  const denial = peer.objects.denials()[0]!;
  // Importing structure without its denied leaf is correctly impossible; copy the real held structural objects directly instead.
  for (const entry of peer.objects.inventory()) if (entry.id !== denial.id) local.objects.write(entry.object.type, entry.object.payload);
  local.refs.transaction([{ name: "refs/remotes/peer/main", expected: null, next: tip }]);
  const refs = local.refs.list("refs/"); const log = local.operations.read(); const index = local.readIndex();
  const report = await fetchFrom(local, "peer", new Date(3000));
  assert.equal(report.upToDate, false, "new security metadata means the receiver was not up to date");
  assert.deepEqual(report.added, []); assert.deepEqual(local.objects.denials(), [denial]);
  assert.deepEqual(local.refs.list("refs/"), refs); assert.deepEqual(local.operations.read(), log); assert.deepEqual(local.readIndex(), index);
  const before = durable(local); assert.equal((await fetchFrom(local, "peer", new Date(4000))).upToDate, true); assert.deepEqual(durable(local), before);
});

test("streaming inventory preserves the collecting API and verifies canonical and temporary copies", () => {
  const { repo, selected } = fixture(); const path = objectPath(repo, selected.id); const temporary = `${path}.123.abcdef123456.tmp`; copyFileSync(path, temporary);
  const array = repo.objects.inventory(); const streamed = [...repo.objects.walkInventory()]; assert.deepEqual(streamed, array);
  assert.deepEqual(repo.objects.readInventoryObject(selected.id, temporary).payload, selectedBytes);
  assert.throws(() => repo.objects.readInventoryObject(selected.id, join(temps[0]!.root, "foreign")), { code: "unsupported_erasure_storage" });
  assert.throws(() => repo.objects.readInventoryObject(selected.id, `${path}.invalid`), { code: "unsupported_erasure_storage" });
  assert.throws(() => repo.objects.readInventoryObject("invalid", path), { code: "invalid_object_id" });
  repo.obliterate("selected", "erase-fixture", "incident", new Date(2000)); assert.equal(existsSync(path), false); assert.equal(existsSync(temporary), false);
});

for (const damage of ["corrupt-temp", "missing-history", "unknown-storage"] as const) test(`streaming erasure refuses unrelated ${damage} before durable mutation`, () => {
  const { repo, selected } = fixture();
  if (damage === "corrupt-temp") writeFileSync(`${objectPath(repo, selected.id)}.123.abcdef123456.tmp`, "invalid compressed copy");
  if (damage === "missing-history") {
    const orphan = commit(repo, "other", Buffer.from("unrelated unreachable historical bytes"));
    const entry = repo.readIndex().find(value => value.path === "other")!; rmSync(objectPath(repo, entry.id));
    repo.refs.compareAndSwap("refs/heads/main", orphan, null);
  }
  if (damage === "unknown-storage") mkdirSync(join(repo.controlDirectory, "objects", "pack"));
  const before = durable(repo);
  assert.throws(() => repo.obliterate(selected.fileId!, "erase-fixture", "incident", new Date(2000)),
    { code: { "corrupt-temp": "corrupt_object", "missing-history": "incomplete_erasure_inventory", "unknown-storage": "unsupported_erasure_storage" }[damage] });
  assert.deepEqual(durable(repo), before); assert.deepEqual(readFileSync(join(repo.root, "selected")), selectedBytes);
});

for (const change of ["new-copy", "lost-copy"] as const) test(`streaming second pass refuses a real ${change} before denial`, () => {
  const { repo, selected } = fixture(); const path = objectPath(repo, selected.id); const temporary = `${path}.123.abcdef123456.tmp`;
  if (change === "lost-copy") copyFileSync(path, temporary);
  const original = ObjectStore.prototype.walkInventory; let passes = 0;
  mock.method(repo.objects, "walkInventory", function* () {
    if (++passes === 2) { if (change === "new-copy") copyFileSync(path, temporary); else rmSync(temporary); }
    yield* original.call(repo.objects);
  });
  const index = readFileSync(join(repo.controlDirectory, "index")); const refs = repo.refs.list("refs/"); const log = repo.operations.read();
  assert.throws(() => repo.obliterate("selected", "erase-fixture", "incident", new Date(2000)), { code: "incomplete_erasure_inventory" });
  assert.equal(passes, 2); assert.deepEqual(repo.objects.denials(), []); assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), index);
  assert.deepEqual(repo.refs.list("refs/"), refs); assert.deepEqual(repo.operations.read(), log); assert.deepEqual(readFileSync(join(repo.root, "selected")), selectedBytes);
});

for (const changed of ["leaf", "parent", "root", "in-place"] as const) test(`physical inventory refuses real ${changed} replacement during a verified read`, () => {
  const { repo, selected } = fixture(); const path = objectPath(repo, selected.id); const root = join(repo.controlDirectory, "objects");
  const read = fs.readFileSync; let changedOnce = false;
  mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const result = read(...args);
    if (typeof args[0] === "number" && !changedOnce) {
      changedOnce = true;
      if (changed === "in-place") writeFileSync(path, "changed bytes");
      else {
        const location = changed === "leaf" ? path : changed === "parent" ? join(root, selected.id.slice(0, 2)) : root;
        const retired = `${location}.retired`; renameSync(location, retired);
        if (changed === "leaf") copyFileSync(retired, location);
        else { mkdirSync(location); if (changed === "parent") copyFileSync(join(retired, selected.id.slice(2)), path); else { mkdirSync(join(root, selected.id.slice(0, 2))); copyFileSync(join(retired, selected.id.slice(0, 2), selected.id.slice(2)), path); } }
      }
    }
    return result;
  }); syncBuiltinESMExports();
  assert.throws(() => repo.objects.readInventoryObject(selected.id, path), { code: "unsupported_erasure_storage" }); assert.equal(changedOnce, true);
});

test("physical inventory rejects actual directory and leaf aliases and preserves native read errno", () => {
  const { repo, selected, temp } = fixture(); const root = join(repo.controlDirectory, "objects"); const parent = join(root, selected.id.slice(0, 2)); const path = objectPath(repo, selected.id);
  for (const location of [path, parent, root]) {
    const retired = join(temp.root, "retired"); renameSync(location, retired); symlinkSync(retired, location);
    try { assert.throws(() => repo.objects.readInventoryObject(selected.id, path), { code: "unsupported_erasure_storage" }); }
    finally { rmSync(location); renameSync(retired, location); }
  }
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    chmodSync(path, 0); try { assert.throws(() => repo.objects.readInventoryObject(selected.id, path), { code: "EACCES" }); } finally { chmodSync(path, 0o600); }
  }
  rmSync(path); assert.throws(() => repo.objects.readInventoryObject(selected.id, path), { code: "ENOENT" });
});

test("legacy skipped transfer still rejects held corruption, audit damage and pending denial", async () => {
  const { repo, temp, selected } = fixture(); const peer = Repository.init(join(temp.root, "peer")); repo.remotes.add("peer", peer.root);
  const path = objectPath(repo, selected.id); const physical = readFileSync(path); const requests: string[][] = [];
  const before = repo.operations.read(); writeFileSync(path, deflateSync(frameObject("blob", Buffer.from("hash mismatch"))));
  await assert.rejects(fetchFrom(repo, "peer", new Date(3000), legacyTransport(peer, requests)), { code: "incomplete_bundle" }); writeFileSync(path, physical);
  repo.obliterate("selected", "erase-fixture", "incident", new Date(2000)); const denial = repo.objects.denials()[0]!; const audit = objectPath(repo, denial.id);
  const auditBytes = readFileSync(audit); rmSync(audit);
  await assert.rejects(fetchFrom(repo, "peer", new Date(3000), legacyTransport(peer, requests)), { code: "object_not_found" }); writeFileSync(audit, auditBytes);
  repo.objects.recordDenials([{ ...denial, pending: true }]); const pending = durable(repo);
  await assert.rejects(fetchFrom(repo, "peer", new Date(3000), legacyTransport(peer, requests)), { code: "erasure_incomplete" });
  assert.deepEqual(durable(repo), pending); assert.deepEqual(requests, []); assert.equal(before.length + 1, repo.operations.read().length);
});

test("legacy conflicting-only peer cannot exchange newly erased metadata without a supported endpoint", async () => {
  const { repo: peer, temp, tip } = fixture(); peer.refs.compareAndSwap("refs/tags/conflict", null, tip);
  peer.obliterate("selected", "erase-fixture", "incident", new Date(2000)); peer.refs.compareAndSwap("refs/heads/main", tip, null);
  const local = Repository.init(join(temp.root, "local")); const own = commit(local, "own", Buffer.from("ordinary independent local bytes"));
  local.refs.compareAndSwap("refs/tags/conflict", null, own); local.remotes.add("peer", peer.root); const before = durable(local); const requests: string[][] = [];
  const report = await fetchFrom(local, "peer", new Date(3000), legacyTransport(peer, requests));
  assert.deepEqual(report.conflictingTags, ["conflict"]); assert.deepEqual(report.added, []); assert.deepEqual(report.updated, []);
  assert.deepEqual(requests, []); assert.deepEqual(local.objects.denials(), []); assert.deepEqual(durable(local), before);
  // The same real peer's supported endpoint delivers denial without fetching the conflicting history.
  const updated = await fetchFrom(local, "peer", new Date(4000)); assert.equal(updated.upToDate, false); assert.deepEqual(updated.added, []);
  assert.deepEqual(local.objects.denials(), peer.objects.denials()); assert.equal(local.objects.has(tip), false); assert.equal(local.refs.read("refs/tags/conflict"), own);
});
