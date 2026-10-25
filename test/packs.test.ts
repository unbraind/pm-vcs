/** Differential mixed-storage, crash recovery and multi-process interleaving on real non-git trackers. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import fs, { symlinkSync, mkdirSync, readdirSync, readFileSync, writeFileSync, lstatSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { installPackedExtension, withoutPmContext } from "../scripts/pm-environment.ts";
import extension from "../index.ts";
import { collectGarbage } from "../engine/gc.ts";
import { ObjectStore, frameObject, hashObject } from "../engine/objects.ts";
import { PackStorage, PackRefusal, packBoundary } from "../engine/packs.ts";
import { Repository } from "../engine/repo.ts";
import { readFragmentRange, writeFragmented } from "../engine/fragments.ts";
import { benchmarkIndexedPacks } from "../scripts/pack-benchmark.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";

const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); packBoundary.visit = () => {}; for (const dir of temporary.splice(0)) dir.cleanup(); });
/** Initialize a real tracker outside Git, using the pinned SDK rather than manufacturing PM records. */
async function fresh() {
  const dir = makeTempDir(); temporary.push(dir);
  await new PmClient({ cwd: dir.root, pmRoot: join(dir.root, ".agents/pm"), noExtensions: true }).init("packs", { defaults: true, author: "fixture" });
  return Repository.init(dir.root);
}
/** Deterministic pseudo-random corpus includes empty, repetitive and incompressible binary payloads. */
function corpus(repo: Repository, count = 24) {
  let seed = 1729;
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.alloc(i * 79);
    for (let j = 0; j < bytes.length; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bytes[j] = seed >>> 24; }
    const payload = i % 3 === 0 ? Buffer.from("stable repeated payload".repeat(i)) : bytes;
    const id = repo.objects.write("blob", payload); entries.set(id, payload);
    repo.refs.compareAndSwap(`refs/metadata/fixture-${i}`, null, id);
  }
  return entries;
}
/** Assert logical identities and every read through a separately opened store, never cached test buffers. */
function equalReads(repo: Repository, entries: ReadonlyMap<string, Buffer>) {
  const reopened = new ObjectStore(join(repo.controlDirectory, "objects"));
  for (const [id, bytes] of entries) {
    assert.ok(reopened.has(id)); assert.deepEqual(reopened.readTyped(id, "blob"), bytes);
    assert.equal(hashObject("blob", reopened.read(id).payload), id);
  }
}
/** Run the installed engine in an independent process with Git discovery explicitly disabled. */
function worker(action: string, repo: Repository, boundary = 0) {
  return spawnSync(process.execPath, [join(packageRoot, "test/helpers/pack-worker.ts"), action, repo.root, String(boundary)], {
    env: { ...process.env, ...discardChildCoverage(), GIT_CEILING_DIRECTORIES: dirname(repo.root) }, encoding: "utf8", timeout: 30_000,
  });
}
/** Small fixture makes exhaustive boundary schedules fast while retaining both live and unreachable objects. */
function seed(repo: Repository) {
  const entries = corpus(repo, 2);
  const garbage = repo.objects.write("blob", Buffer.from("unreachable-garbage-payload"));
  return { entries, garbage };
}

test("random corpus reads, stable addresses and fragment ranges agree before and after compaction and GC", async () => {
  const repo = await fresh(); const entries = corpus(repo);
  const bytes = Buffer.from("binary-range-\u0000".repeat(1000));
  const fragmented = writeFragmented(repo.objects, bytes, 83); repo.refs.compareAndSwap("refs/metadata/fragmented", null, fragmented.manifestId);
  const garbage = repo.objects.write("blob", Buffer.from("collect-me"));
  equalReads(repo, entries); const result = repo.objects.compact();
  assert.ok(result.objects >= entries.size); assert.ok(result.packs > 0); assert.ok(result.packBytes > 0);
  assert.deepEqual([...repo.objects.walkLooseInventory()], []);
  equalReads(repo, entries);
  for (let i = 0; i < bytes.length; i += 379) assert.deepEqual(readFragmentRange(repo.objects, fragmented.manifestId, i, Math.min(i + 101, bytes.length)), bytes.subarray(i, i + 101));
  assert.deepEqual(collectGarbage(repo).candidates, [garbage]); collectGarbage(repo, true);
  assert.ok(!repo.objects.has(garbage)); equalReads(repo, entries);
  assert.deepEqual(readFragmentRange(repo.objects, fragmented.manifestId, 17, 2017), bytes.subarray(17, 2017));
  assert.equal(collectGarbage(repo, true).removed, 0);
  assert.equal(repo.objects.compact().objects, 0);
  const id = [...entries.keys()][1]; assert.equal(repo.objects.write("blob", entries.get(id)!), id);
  assert.deepEqual([...repo.objects.walkLooseInventory()], []);
});

for (const action of ["compact", "unpack", "gc"] as const) {
  test(`SIGKILL at every ${action} step converges without loss, duplicates or changed live reads`, async () => {
    const baseline = await fresh(); const original = seed(baseline);
    if (action !== "compact") baseline.objects.compact();
    const steps: string[] = []; packBoundary.visit = (step) => steps.push(step);
    if (action === "compact") baseline.objects.compact(); else if (action === "unpack") baseline.objects.unpack(); else collectGarbage(baseline, true);
    packBoundary.visit = () => {}; assert.ok(steps.length > 0);
    for (let boundary = 1; boundary <= steps.length; boundary++) {
      const repo = await fresh(); const { entries, garbage } = seed(repo);
      if (action !== "compact") repo.objects.compact();
      const crashed = worker(action, repo, boundary); assert.equal(crashed.signal, "SIGKILL", `${action} ${boundary}: ${crashed.stderr}`);
      repo.objects.recoverWriterLock();
      // All live reads remain equal even before a recovery run.
      equalReads(repo, entries);
      if (action === "compact") repo.objects.compact(); else if (action === "unpack") repo.objects.unpack(); else collectGarbage(repo, true);
      equalReads(repo, entries);
      if (action === "gc") assert.ok(!repo.objects.has(garbage));
      else assert.deepEqual(repo.objects.readTyped(garbage, "blob"), Buffer.from("unreachable-garbage-payload"));
      const ids = [...repo.objects.walkInventory()].map((item) => item.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate after ${action} ${boundary}`);
      assert.equal(new Set(original.entries.keys()).size, entries.size);
    }
  });

  test(`a competing process cannot transition the same tracker at ANY ${action} boundary; peer reruns report success`, async () => {
    const repo = await fresh(); const { entries } = seed(repo); if (action !== "compact") repo.objects.compact();
    let boundaries = 0;
    packBoundary.visit = () => {
      boundaries++;
      const competitor = worker("contend", repo);
      assert.equal(competitor.status, 0, competitor.stderr);
    };
    if (action === "compact") repo.objects.compact(); else if (action === "unpack") repo.objects.unpack(); else collectGarbage(repo, true);
    packBoundary.visit = () => {}; assert.ok(boundaries > 0); equalReads(repo, entries);
    assert.equal(worker("compact", repo).status, 0);
    assert.equal(worker("gc", repo).status, 0); equalReads(repo, entries);
  });
}

test("pack erasure materializes survivors, permanently denies selected bytes and permits later compaction", async () => {
  const repo = await fresh(); const entries = corpus(repo, 3);
  writeFileSync(join(repo.root, "asset"), "unique-erasure-payload-734982615-long-enough"); repo.stage(["asset"]);
  const erased = repo.readIndex()[0].id;
  repo.setAuthority("fixture", "read-fixture", "erase-fixture"); repo.objects.compact();
  repo.obliterate("asset", "erase-fixture", "fixture-cleanup", new Date(1));
  assert.throws(() => repo.objects.read(erased), { code: "object_obliterated" });
  assert.ok(!repo.objects.has(erased)); equalReads(repo, entries);
  repo.objects.compact(); equalReads(repo, entries);
  const denial = repo.objects.denials()[0]; repo.objects.recordDenials([{ ...denial, pending: true }]);
  assert.throws(() => repo.objects.compact(), (error: unknown) => error instanceof PackRefusal && error.code === "pack_erasure_pending" && error.remedy.includes("obliterate"));
});

test("foreign files, incomplete foreign jobs and loose write temporaries are skipped with reasons", async () => {
  const repo = await fresh(); const entries = corpus(repo, 2);
  const directory = join(repo.controlDirectory, "objects/packs"); mkdirSync(directory);
  writeFileSync(join(directory, "foreign.json"), "{}"); mkdirSync(join(directory, `job-${"a".repeat(24)}`));
  const id = [...entries.keys()][0]; const loose = join(repo.controlDirectory, "objects", id.slice(0, 2), id.slice(2));
  writeFileSync(`${loose}.123.abcdef123456.tmp`, readFileSync(loose));
  writeFileSync(join(repo.controlDirectory, "objects/foreign.json"), "{}");
  writeFileSync(join(dirname(loose), "foreign.json"), "{}");
  const result = repo.objects.compact(); assert.equal(result.skipped.length, 5);
  assert.ok(result.skipped.every((entry) => entry.reason.length > 0));
  assert.equal(readFileSync(join(directory, "foreign.json"), "utf8"), "{}"); equalReads(repo, entries);
});

test("corrupt pack fails before loose retirement or GC deletion; indexed range corruption never returns altered bytes", async () => {
  const repo = await fresh(); const entries = corpus(repo, 3); repo.objects.compact();
  const directory = join(repo.controlDirectory, "objects/packs"); const pack = join(directory, readdirSync(directory).find((name) => name.endsWith(".pack"))!);
  const original = readFileSync(pack); const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 255; writeFileSync(pack, damaged);
  const loose = repo.objects.write("blob", Buffer.from("keep loose on pack failure"));
  assert.throws(() => repo.objects.compact(), { code: "corrupt_pack" });
  assert.throws(() => collectGarbage(repo, true), { code: "corrupt_pack" }); assert.ok(repo.objects.has(loose));
  let refusals = 0; for (const id of entries.keys()) { try { repo.objects.read(id); } catch { refusals++; } } assert.ok(refusals > 0);
  writeFileSync(pack, original); equalReads(repo, entries);
  const brokenIndex = Buffer.from(original); brokenIndex.writeUInt32BE(0xffffffff, 8); writeFileSync(pack, brokenIndex);
  assert.throws(() => repo.objects.read([...entries.keys()][0]), { code: "corrupt_pack" });
});

test("bounded and streamed typed readers consume packs; compact SDK and command work without git", async () => {
  const repo = await fresh(); const id = repo.objects.write("manifest", Buffer.from("line\n"));
  const big = repo.objects.write("blob", Buffer.alloc(20_000));
  const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8"));
  const harness = await createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
  const result = await harness.runCommand({ command: "vcs compact", pmRoot: join(repo.root, ".agents/pm") });
  assert.equal(result.errorMessage, undefined); assert.ok(![...repo.objects.walkLooseInventory()].length);
  assert.deepEqual(repo.objects.readBoundedTyped(id, "manifest"), Buffer.from("line\n"));
  assert.deepEqual([...repo.objects.readLines(id, "manifest")], ["line"]);
  assert.ok(repo.objects.hasType(id, "manifest")); assert.ok(!repo.objects.hasType(id, "blob"));
  assert.throws(() => repo.objects.readBoundedTyped(id, "blob"), { code: "object_type_mismatch" });
  assert.throws(() => [...repo.objects.readLines(id, "blob")], { code: "object_type_mismatch" });
  assert.throws(() => repo.objects.readBoundedTyped(big, "blob"), { code: "object_payload_limit" });
  repo.objects.unpack(); assert.equal(lstatSync(join(repo.controlDirectory, "objects", id.slice(0, 2), id.slice(2))).isFile(), true);
  rmSync(join(repo.controlDirectory, "objects/packs"), { recursive: true });
});


test("shipped compact command reads and collects packs with no Git executable or subprocess", async () => {
  const repo = await fresh(); const entries = corpus(repo, 4); installPackedExtension(repo.root);
  const nodeOnly = join(repo.root, "node-only"); mkdirSync(nodeOnly); symlinkSync(process.execPath, join(nodeOnly, "node"));
  const env = { ...withoutPmContext(process.env), ...discardChildCoverage(), PATH: nodeOnly, GIT_CEILING_DIRECTORIES: dirname(repo.root),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./helpers/forbid-git.ts", import.meta.url).href}` };
  const cli = join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js");
  const json = spawnSync(process.execPath, [cli, "vcs", "compact", "--json"], { cwd: repo.root, env, encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr); assert.equal(JSON.parse(json.stdout).compact.objects, 4);
  const toon = spawnSync(process.execPath, [cli, "vcs", "compact"], { cwd: repo.root, env, encoding: "utf8" });
  assert.equal(toon.status, 0, toon.stderr); assert.match(toon.stdout, /objects: 0/); equalReads(repo, entries);
});


/** Write an independently constructed physical pack, so validation tests do not mirror the writer. */
function forgedPack(repo: Repository, index: string, body: Buffer, magic = "PMVCSP1\n") {
  const directory = join(repo.controlDirectory, "objects/packs"); mkdirSync(directory, { recursive: true });
  const encoded = Buffer.from(index); const header = Buffer.alloc(12); header.write(magic); header.writeUInt32BE(encoded.length, 8);
  const bytes = Buffer.concat([header, encoded, body]); const id = createHash("sha256").update(bytes).digest("hex");
  const path = join(directory, `${id}.pack`); writeFileSync(path, bytes); return path;
}

test("malformed indexes, frames and range boundaries fail closed before modifying loose sources", async () => {
  const repo = await fresh(); const payload = Buffer.from("known member"); const id = hashObject("blob", payload);
  const body = deflateSync(frameObject("blob", payload)); const entry = [id, 0, body.length, "blob"];
  const backend = new PackStorage(join(repo.controlDirectory, "objects"));
  for (const value of ["{", "{{", "null", "[]", '["foreign"]', JSON.stringify([[id]]), JSON.stringify([[1, 0, body.length, "blob"]]),
    JSON.stringify([["invalid", 0, body.length, "blob"]]), JSON.stringify([[id, 1, body.length, "blob"]]),
    JSON.stringify([[id, 0, "length", "blob"]]), JSON.stringify([[id, 0, 0, "blob"]]), JSON.stringify([[id, 0, body.length, "unknown"]]),
    JSON.stringify([[id, 0, body.length - 1, "blob"]]), JSON.stringify([entry, entry])]) {
    const path = forgedPack(repo, value, body); assert.throws(() => backend.read(id), { code: "corrupt_pack" }); rmSync(path);
  }
  const magic = forgedPack(repo, JSON.stringify([entry]), body, "FOREIGN!"); assert.throws(() => backend.read(id), { code: "corrupt_pack" }); rmSync(magic);
  const short = forgedPack(repo, JSON.stringify([entry]), body); writeFileSync(short, Buffer.alloc(3));
  assert.throws(() => backend.read(id), { code: "corrupt_pack" }); rmSync(short);
  for (const data of [deflateSync(frameObject("record", payload)), deflateSync(frameObject("blob", Buffer.from("wrong bytes")))]) {
    const path = forgedPack(repo, JSON.stringify([[id, 0, data.length, "blob"]]), data);
    assert.throws(() => backend.read(id), { code: "corrupt_pack" }); rmSync(path);
  }
  const directory = join(repo.controlDirectory, "objects/packs"); rmSync(directory, { recursive: true }); writeFileSync(directory, "foreign storage root");
  assert.throws(() => backend.files(), { code: "corrupt_pack" }); assert.throws(() => backend.recover(), { code: "corrupt_pack" });
});

test("ownership recovery ignores foreign markers and unknown children, and resumes interrupted owned cleanup", async () => {
  const repo = await fresh(); const entries = corpus(repo, 2); const directory = join(repo.controlDirectory, "objects/packs"); mkdirSync(directory);
  for (let i = 0; i < 3; i++) {
    const name = `job-${String(i).repeat(24)}`; const job = join(directory, name); mkdirSync(job);
    writeFileSync(join(job, "owner"), i === 0 ? "foreign" : `pm-vcs-pack-1 ${name}\n`);
    if (i === 1) writeFileSync(join(job, "unowned"), "preserve");
    if (i === 2) mkdirSync(join(job, "payload"));
  }
  let visited = 0; packBoundary.visit = (step) => { if (step === "staged" && visited++ === 0) throw new Error("interrupted staging"); };
  assert.throws(() => repo.objects.compact(), /interrupted staging/);
  packBoundary.visit = (step) => { if (step === "recovered") throw new Error("interrupted cleanup"); };
  assert.throws(() => repo.objects.compact(), /interrupted cleanup/);
  packBoundary.visit = () => {}; const report = repo.objects.compact(); assert.equal(report.skipped.length, 3); equalReads(repo, entries);
});

test("bounded batches retain oversized objects loose and split larger corpora into independently readable packs", async () => {
  const repo = await fresh();
  const entries = new Map<string, Buffer>();
  for (const size of [9 * 1024 * 1024, 9 * 1024 * 1024 + 1, 16 * 1024 * 1024]) {
    const bytes = Buffer.alloc(size, size % 255); entries.set(repo.objects.write("blob", bytes), bytes);
  }
  const result = repo.objects.compact(); assert.equal(result.packs, 2); assert.equal(result.skipped.length, 1);
  assert.equal([...repo.objects.walkLooseInventory()].length, 1); equalReads(repo, entries);
});

test("publication accepts an identical peer result and refuses conflicting destinations and native link failures", async () => {
  for (const mode of ["same", "conflict", "link"] as const) {
    const repo = await fresh(); const entries = corpus(repo, 2);
    const link = fs.linkSync;
    mock.method(fs, "linkSync", (...args: Parameters<typeof fs.linkSync>) => {
      const [source, destination] = args;
      if (String(source).endsWith("payload") && String(destination).endsWith(".pack")) {
        if (mode === "link") throw Object.assign(new Error("link unavailable"), { code: "EIO" });
        writeFileSync(destination, mode === "same" ? readFileSync(source) : Buffer.from("conflicting peer"));
      }
      return link(...args);
    }); syncBuiltinESMExports();
    if (mode === "same") { assert.equal(repo.objects.compact().objects, 2); equalReads(repo, entries); }
    else {
      assert.throws(() => repo.objects.compact(), { code: mode === "link" ? "EIO" : "corrupt_pack" });
      assert.equal([...repo.objects.walkLooseInventory()].length, 2);
    }
    mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("descriptor lookup tolerates pack retirement and preserves operational open failures", async () => {
  const repo = await fresh(); const entries = corpus(repo, 2); repo.objects.compact();
  const backend = new PackStorage(join(repo.controlDirectory, "objects"));
  const open = fs.openSync;
  for (const code of ["ENOENT", "EACCES"]) {
    mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).endsWith(".pack")) throw Object.assign(new Error("injected open failure"), { code });
      return open(...args);
    }); syncBuiltinESMExports();
    if (code === "ENOENT") assert.equal(backend.read([...entries.keys()][0]), undefined);
    else assert.throws(() => backend.read([...entries.keys()][0]), { code });
    mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("public tracker benchmark measures nonempty loose and packed storage and verifies all reads after GC", () => {
  const result = benchmarkIndexedPacks(join(packageRoot, ".agents/pm"), 9);
  assert.ok(result.trackerFiles > 0); assert.ok(result.objects > 100);
  assert.equal(result.verifiedReads, result.objects * 2); assert.equal(result.gcRemoved, 0);
  assert.ok(result.loose.files > result.packed.files); assert.equal(result.loose.read.samples, 9);
  assert.ok(result.packed.read.medianMs > 0);
});


test("physical inventory names real pack files and verified compressed ranges", async () => {
  const repo = await fresh(); corpus(repo, 3); repo.objects.compact();
  for (const entry of repo.objects.inventory()) {
    assert.ok(lstatSync(entry.path).isFile()); assert.ok(entry.packed);
    assert.deepEqual(repo.objects.readInventoryObject(entry.id, entry.path), entry.object);
    assert.ok(entry.packed.offset + entry.packed.length <= lstatSync(entry.path).size);
    assert.throws(() => repo.objects.readInventoryObject("f".repeat(64), entry.path), { code: "corrupt_pack" });
  }
});

test("mixed duplicate packed and loose garbage is collected once without losing survivors", async () => {
  const repo = await fresh(); const { entries, garbage } = seed(repo); repo.objects.compact();
  const directory = join(repo.controlDirectory, "objects", garbage.slice(0, 2)); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, garbage.slice(2)), deflateSync(frameObject("blob", Buffer.from("unreachable-garbage-payload"))));
  assert.equal(collectGarbage(repo, true).removed, 2); assert.ok(!repo.objects.has(garbage)); equalReads(repo, entries);
});

test("loose presence and retirement retries preserve operational errors and a peer's completed representation", async () => {
  const repo = await fresh(); const id = hashObject("blob", Buffer.from("retry survivor"));
  const directory = join(repo.controlDirectory, "objects", id.slice(0, 2)); mkdirSync(directory, { recursive: true });
  const path = join(directory, id.slice(2)); const stat = fs.statSync;
  for (const failureAt of [1, 2]) {
    let calls = 0;
    mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
      if (args[0] === path) throw Object.assign(new Error("operational stat failure"), { code: ++calls === failureAt ? "EACCES" : "ENOENT" });
      return stat(...args);
    }); syncBuiltinESMExports();
    assert.throws(() => repo.objects.has(id), { code: "EACCES" }); mock.restoreAll(); syncBuiltinESMExports();
  }
  mkdirSync(path); assert.equal(repo.objects.has(id), false); rmSync(path, { recursive: true });
  const read = fs.readFileSync;
  for (const outcome of ["success", "failure"]) {
    let once = false;
    mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === path && !once) {
        once = true;
        if (outcome === "success") writeFileSync(path, deflateSync(frameObject("blob", Buffer.from("retry survivor"))));
        else mkdirSync(path);
        throw Object.assign(new Error("representation retired"), { code: "ENOENT" });
      }
      return read(...args);
    }); syncBuiltinESMExports();
    if (outcome === "success") assert.deepEqual(repo.objects.read(id).payload, Buffer.from("retry survivor"));
    else assert.throws(() => repo.objects.read(id), { code: "EISDIR" });
    mock.restoreAll(); syncBuiltinESMExports(); rmSync(path, { recursive: true });
  }
});


test("agent compaction receipts bound foreign records and report exact omission counts", async () => {
  const repo = await fresh(); const directory = join(repo.controlDirectory, "objects/packs"); mkdirSync(directory);
  for (let i = 0; i < 40; i++) writeFileSync(join(directory, `foreign-${i}.json`), "{}");
  const result = repo.objects.compact(); assert.equal(result.skipped.length, 20);
  assert.equal(result.skippedCount, 40); assert.equal(result.omittedSkipped, 20);
  assert.equal(readdirSync(directory).length, 40);
});
