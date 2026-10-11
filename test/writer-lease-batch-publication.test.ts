/** Real writer transactions, batch arrivals and native failure receipts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { deflateSync } from "node:zlib";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { cdcFragmentedContentId, fragmentedContentId, readFragmented, writeCdcFragmented, writeCdcFragmentedFile, writeCdcFragmentsFromFd, writeFragmented, writeFragmentedFile, writeFragmentsFromFd } from "../engine/fragments.ts";
import { encodeCommit, manifestId, type FragmentManifest, type Signature, writeManifest } from "../engine/model.ts";
import { frameObject, hashObject, ObjectStore } from "../engine/objects.ts";
import { Repository } from "../engine/repo.ts";
import { FileTransport, type TransferObject } from "../engine/transport.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const temporary: ReturnType<typeof makeTempDir>[] = [];
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
const params = { minChunkSize: 64, maxChunkSize: 64, mask: 1 };
const bytes = Buffer.from("independent fragmented survivor 78349162\n".repeat(8));
const writers = ["fixed-buffer", "fixed-file", "fixed-fd", "cdc-buffer", "cdc-file", "cdc-fd", "manifest"] as const;
type Writer = typeof writers[number];
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); for (const directory of temporary.splice(0)) directory.cleanup(); });

/** Initialize a real SDK tracker and commit two distinct attributed native files. */
async function fixture() {
  const directory = makeTempDir(); temporary.push(directory);
  const client = new PmClient({ cwd: directory.root, pmRoot: join(directory.root, ".agents", "pm"), noExtensions: true });
  await client.init("writer", { defaults: true, author: "fixture" });
  const repo = Repository.init(directory.root);
  repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  writeFileSync(join(repo.root, "selected.bin"), "unrelated terminal marker 52791384");
  writeFileSync(join(repo.root, "owner.bin"), "initial surviving owner");
  repo.stage(["selected.bin", "owner.bin"]); const tip = repo.commit({ message: "base", author }, new Date(1000));
  return { repo, directory, tip, owner: repo.readIndex().find(entry => entry.path === "owner.bin")!, selected: repo.readIndex().find(entry => entry.path === "selected.bin")! };
}

/** Map a public writer call to a manifest without extending descriptor ownership. */
function runWriter(store: ObjectStore, kind: Writer, source: string, fileId: string, standalone: FragmentManifest): FragmentManifest {
  if (kind === "fixed-buffer") return writeFragmented(store, bytes, 64, fileId).manifest;
  if (kind === "cdc-buffer") return writeCdcFragmented(store, bytes, params, fileId).manifest;
  if (kind === "fixed-file") return writeFragmentedFile(store, source, 64, fileId).manifest;
  if (kind === "cdc-file") return writeCdcFragmentedFile(store, source, params, fileId).manifest;
  if (kind === "manifest") { assert.equal(writeManifest(store, standalone, fileId), manifestId(standalone)); return standalone; }
  const fd = openSync(source, "r");
  try {
    const fragments = kind === "fixed-fd" ? writeFragmentsFromFd(store, fd, bytes.length, 64, source, fileId)
      : writeCdcFragmentsFromFd(store, fd, bytes.length, params, source, fileId);
    assert.equal(fstatSync(fd).size, bytes.length, "the descriptor API closed its caller's descriptor");
    return { totalLength: bytes.length, fragments, ...(kind === "cdc-fd" ? { mode: "cdc" as const } : {}) };
  } finally { closeSync(fd); }
}

/** Observe a real lock's physical identity, without synthesizing filesystem results. */
function lease(repo: Repository): string | undefined {
  const stat = lstatSync(join(repo.controlDirectory, "objects.lock"), { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? undefined : `${stat.dev}:${stat.ino}`;
}

for (const kind of writers) {
  for (const nested of [false, true]) {
    test(`complete ${kind} writer uses one physical lease with nested=${nested}`, async () => {
      const { repo, directory, owner } = await fixture();
      const source = join(directory.root, "source"); writeFileSync(source, bytes);
      const leaf = repo.objects.write("blob", bytes, owner.fileId);
      const standalone = { totalLength: bytes.length, fragments: [{ id: leaf, length: bytes.length }] };
      const unrelated = join(repo.controlDirectory, "refs.lock"); writeFileSync(unrelated, String(process.pid));
      const unrelatedIdentity = lstatSync(unrelated, { bigint: true });
      const lock = join(repo.controlDirectory, "objects.lock"); const physical: string[] = []; const publication: string[] = []; const owners: (string | undefined)[] = [];
      const link = fs.linkSync; const rename = fs.renameSync;
      mock.method(fs, "linkSync", (...args: Parameters<typeof fs.linkSync>) => {
        const result = link(...args); if (args[1] === lock) physical.push(lease(repo)!); return result;
      });
      mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
        const result = rename(...args); if (String(args[1]).startsWith(join(repo.controlDirectory, "objects") + "/")) publication.push(lease(repo)!); return result;
      });
      const store = nested ? new ObjectStore(join(repo.controlDirectory, "objects")) : repo.objects;
      const write = store.write;
      mock.method(store, "write", function (this: ObjectStore, ...args: Parameters<typeof store.write>) {
        owners.push(args[2]); const result = write.apply(this, args); return result;
      });
      syncBuiltinESMExports();
      const manifest = nested ? repo.objects.withWriteLock(() => runWriter(store, kind, source, owner.fileId!, standalone))
        : runWriter(store, kind, source, owner.fileId!, standalone);
      assert.equal(physical.length, 1, "one complete writer acquired a native lock for each fragment");
      assert.equal(new Set(publication).size, 1);
      assert.ok(publication.every(identity => identity === physical[0]));
      assert.ok(owners.length > 0); assert.ok(owners.every(identity => identity === owner.fileId));
      assert.equal(lease(repo), undefined);
      assert.equal(lstatSync(unrelated, { bigint: true }).ino, unrelatedIdentity.ino);
      assert.equal(readFileSync(unrelated, "utf8"), String(process.pid));
      if (kind.endsWith("fd")) writeManifest(repo.objects, manifest, owner.fileId);
      assert.deepEqual(readFragmented(repo.objects, manifestId(manifest)), bytes);
      if (kind.startsWith("fixed")) assert.equal(manifestId(manifest), fragmentedContentId(bytes, 64));
      if (kind.startsWith("cdc")) assert.equal(manifestId(manifest), cdcFragmentedContentId(bytes, params));
    });
  }

  test(`complete ${kind} writer excludes a real interprocess erasure until its call completes`, async () => {
    const { repo, directory, owner, tip } = await fixture();
    const source = join(directory.root, "source"); writeFileSync(source, bytes);
    const leaf = repo.objects.write("blob", bytes, owner.fileId);
    const standalone = { totalLength: bytes.length, fragments: [{ id: leaf, length: bytes.length }] };
    const signal = join(directory.root, "start"); const attempted = join(directory.root, "attempted"); const result = join(directory.root, "result");
    const child = spawn(process.execPath, [join(packageRoot, "test/helpers/writer-erasure-worker.ts"), repo.root, signal, attempted, result], { env: { ...process.env, ...discardChildCoverage() }, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    let errors = ""; child.stderr.on("data", chunk => { errors += String(chunk); });
    const closed = once(child, "close");
    try {
      const [ready] = await once(child.stdout, "data"); assert.equal(String(ready), "ready\n");
      let observed = false; let completedDuringWrite = false;
      const boundary = () => {
        if (observed) return; observed = true; writeFileSync(signal, "start");
        const sleeper = new Int32Array(new SharedArrayBuffer(4)); const deadline = performance.now() + 1000;
        while (!existsSync(attempted) && performance.now() < deadline) Atomics.wait(sleeper, 0, 0, 5);
        assert.equal(existsSync(attempted), true, "the preloaded child did not start the real erasure");
        const pause = performance.now() + 800;
        while (!existsSync(result) && performance.now() < pause) Atomics.wait(sleeper, 0, 0, 5);
        completedDuringWrite = existsSync(result);
      };
      if (kind === "manifest") {
        const rename = fs.renameSync;
        mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => { const value = rename(...args); if (String(args[1]).includes(manifestId(standalone).slice(2))) boundary(); return value; });
        syncBuiltinESMExports();
      } else {
        const write = repo.objects.write;
        mock.method(repo.objects, "write", function (this: ObjectStore, ...args: Parameters<typeof repo.objects.write>) { const value = write.apply(this, args); boundary(); return value; });
      }
      runWriter(repo.objects, kind, source, owner.fileId!, standalone);
      mock.restoreAll(); syncBuiltinESMExports();
      const [status] = await closed; assert.equal(status, 0, errors);
      assert.equal(JSON.parse(readFileSync(result, "utf8")).erased, true);
      assert.equal(observed, true); assert.equal(completedDuringWrite, false, "physical erasure interleaved between fragments or before manifest publication");
      assert.equal(repo.readFileState(tip, "selected.bin").kind, "obliterated");
      assert.equal(lease(repo), undefined);
    } finally { if (child.exitCode === null) child.kill(); await closed; }
  });
}

for (const cdc of [false, true]) {
  test(`complete descriptor writer cdc=${cdc} releases its lease on actual short read and keeps caller FD open`, async () => {
    const { repo, directory, owner } = await fixture(); const source = join(directory.root, "short"); writeFileSync(source, bytes);
    const fd = openSync(source, "r");
    try {
      assert.throws(() => cdc ? writeCdcFragmentsFromFd(repo.objects, fd, bytes.length + 1, params, source, owner.fileId)
        : writeFragmentsFromFd(repo.objects, fd, bytes.length + 1, 64, source, owner.fileId), { code: "short_read" });
      assert.equal(fstatSync(fd).size, bytes.length); assert.equal(lease(repo), undefined);
      repo.objects.write("blob", Buffer.from("write after failed descriptor"), owner.fileId);
    } finally { closeSync(fd); }
  });

  test(`complete file writer cdc=${cdc} closes its real FD and lease after native publication failure`, async () => {
    const { repo, directory, owner } = await fixture(); const source = join(directory.root, "source"); writeFileSync(source, bytes);
    const first = hashObject("blob", bytes.subarray(0, 64)); const blocked = join(repo.controlDirectory, "objects", first.slice(0, 2), first.slice(2)); mkdirSync(blocked, { recursive: true });
    const open = fs.openSync; let fd: number | undefined;
    mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { const value = open(...args); if (args[0] === source) fd = value; return value; }); syncBuiltinESMExports();
    assert.throws(() => cdc ? writeCdcFragmentedFile(repo.objects, source, params, owner.fileId) : writeFragmentedFile(repo.objects, source, 64, owner.fileId));
    assert.ok(fd !== undefined); assert.throws(() => fstatSync(fd!), { code: "EBADF" }); assert.equal(lease(repo), undefined);
    rmSync(blocked, { recursive: true });
    const fixed = cdc ? writeCdcFragmentedFile(repo.objects, source, params, owner.fileId) : writeFragmentedFile(repo.objects, source, 64, owner.fileId);
    assert.deepEqual(readFragmented(repo.objects, fixed.manifestId), bytes);
  });
}

/** Construct a hash-valid anonymous arrival without using a fake store. */
function arrival(text: string): TransferObject { const payload = Buffer.from(text); return { type: "blob", payload, id: hashObject("blob", payload) }; }

test("upload accepts one genuine duplicate batch under its lease and receipts only new unique delivered IDs", async () => {
  const { repo, tip } = await fixture(); const transport = new FileTransport(repo.root, repo.root);
  const held = arrival("held upload bytes"); repo.objects.write(held.type, held.payload);
  const first = arrival("first new upload bytes"); const second = arrival("second new upload bytes"); const objects = [held, first, first, second, held];
  const accept = ObjectStore.prototype.accept; const preflight = ObjectStore.prototype.preflight;
  const accepts: TransferObject[][] = []; const preflights: boolean[] = []; const leases: string[] = [];
  mock.method(ObjectStore.prototype, "accept", function (this: ObjectStore, ...args: Parameters<typeof accept>) { accepts.push([...args[0]]); leases.push(lease(repo)!); return accept.apply(this, args); });
  mock.method(ObjectStore.prototype, "preflight", function (this: ObjectStore, ...args: Parameters<typeof preflight>) { preflights.push(args[1]); leases.push(lease(repo)!); return preflight.apply(this, args); });
  await transport.uploadObjects(objects);
  assert.equal(accepts.length, 1, "upload never used one batch accept"); assert.deepEqual(accepts[0], objects); assert.deepEqual(preflights, [false], "upload repeated denial inspection per object");
  assert.equal(new Set(leases).size, 1); assert.ok(leases.every(identity => identity !== undefined));
  mock.restoreAll();
  await transport.uploadObjects(objects);
  const receipt = await transport.publish([{ ref: "refs/heads/upload", expected: null, next: tip }], false, new Date(2000));
  assert.deepEqual(receipt.added, [first.id, second.id]); assert.equal(repo.refs.read("refs/heads/upload"), tip);
  assert.deepEqual((await transport.publish([], false, new Date())).added, []);
});

test("upload preserves whole-batch hash and denial refusals before native writes and receipts", async () => {
  const { repo, selected } = await fixture(); const transport = new FileTransport(repo.root, repo.root);
  const fresh = arrival("must not publish before corrupt last object"); const bad = { ...arrival("bad claimed hash"), id: "f".repeat(64) };
  await assert.rejects(transport.uploadObjects([fresh, bad]), { code: "corrupt_object" }); assert.equal(repo.objects.has(fresh.id), false);
  repo.obliterate("selected.bin", "erase-fixture", "incident", new Date(2000));
  const structuralPayload = encodeCommit({ tree: repo.headTree()!, parents: [], author, committer: author, message: "fresh structural arrival" });
  const structural: TransferObject = { type: "commit", payload: structuralPayload, id: hashObject("commit", structuralPayload) };
  const denied = arrival("unrelated terminal marker 52791384"); assert.equal(denied.id, selected.id);
  for (const [last, code] of [[denied, "object_obliterated"], [fresh, "unattributed_arrival"]] as const) {
    await assert.rejects(transport.uploadObjects([structural, last]), { code }); assert.equal(repo.objects.has(structural.id), false);
    assert.deepEqual((await transport.publish([], false, new Date())).added, []);
  }
  const path = join(repo.controlDirectory, "denials.json"); const denials = JSON.parse(readFileSync(path, "utf8")); denials[0].pending = true; writeFileSync(path, JSON.stringify(denials));
  await assert.rejects(transport.uploadObjects([structural]), { code: "erasure_incomplete" }); assert.equal(repo.objects.has(structural.id), false);
  assert.equal(lease(repo), undefined);
});

test("upload leaves held corrupt duplicates untrusted through actual complete closure and stale CAS refusal", async () => {
  const { repo, tip, owner } = await fixture(); const transport = new FileTransport(repo.root, repo.root);
  const original = repo.objects.read(owner.id); const duplicate = { ...original, id: owner.id };
  const path = join(repo.controlDirectory, "objects", owner.id.slice(0, 2), owner.id.slice(2)); const saved = readFileSync(path);
  const damaged = deflateSync(frameObject("blob", Buffer.from("different held bytes"))); writeFileSync(path, damaged);
  await transport.uploadObjects([duplicate, duplicate]); assert.deepEqual(readFileSync(path), damaged, "upload treated present bytes as a verified replacement");
  await assert.rejects(transport.publish([{ ref: "refs/heads/duplicate", expected: null, next: tip }], false, new Date()), { code: "incomplete_bundle" });
  assert.equal(repo.refs.read("refs/heads/duplicate"), null);
  writeFileSync(path, saved); rmSync(path); await transport.uploadObjects([duplicate, duplicate]); assert.deepEqual(repo.objects.read(owner.id), original);
  repo.refs.compareAndSwap("refs/heads/duplicate", null, tip);
  await assert.rejects(transport.publish([{ ref: "refs/heads/duplicate", expected: null, next: tip }, { ref: "refs/tags/new", expected: tip, next: tip }], true, new Date()), { code: "publication_race" });
  assert.equal(repo.refs.read("refs/tags/new"), null); assert.deepEqual((await transport.publish([], false, new Date())).added, []);
});

test("upload partial native failure records no failed-batch acceptance and retry counts only remaining arrivals", async () => {
  const { repo } = await fixture(); const transport = new FileTransport(repo.root, repo.root);
  const earlier = arrival("earlier successful call"); await transport.uploadObjects([earlier]);
  const first = arrival("partially stored first arrival"); const second = arrival("native failed second arrival"); assert.notEqual(first.id.slice(0, 2), second.id.slice(0, 2));
  const blocked = join(repo.controlDirectory, "objects", second.id.slice(0, 2), second.id.slice(2)); mkdirSync(blocked, { recursive: true });
  const rename = fs.renameSync; let native: unknown;
  mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => { try { return rename(...args); } catch (error) { native = error; throw error; } }); syncBuiltinESMExports();
  await assert.rejects(transport.uploadObjects([first, second]), error => error === native && error instanceof Error);
  assert.equal(repo.objects.has(first.id), true); assert.equal(repo.objects.has(second.id), false); assert.equal(lease(repo), undefined);
  assert.deepEqual((await transport.publish([], false, new Date())).added, [earlier.id], "a failed native batch leaked optimistic arrival IDs into a publication receipt");
  mock.restoreAll(); syncBuiltinESMExports(); rmSync(blocked, { recursive: true });
  await transport.uploadObjects([first, first, second, second]);
  assert.deepEqual((await transport.publish([], false, new Date())).added, [second.id]);
  assert.deepEqual(repo.objects.read(first.id).payload, first.payload); assert.deepEqual(repo.objects.read(second.id).payload, second.payload);
});
