/** Real private-registry and post-erasure native writer regressions. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, mock, test } from "node:test";
import { exportBundle, parseBundle } from "../engine/bundle.ts";
import { readLayers } from "../engine/composition.ts";
import { cdcFragmentedContentId, fragmentedContentId, readFragmented, writeCdcFragmented, writeCdcFragmentedFile, writeCdcFragmentsFromFd, writeFragmented, writeFragmentedFile, writeFragmentsFromFd } from "../engine/fragments.ts";
import { encodeRecord, manifestId, type FragmentWriteResult, type Signature, writeManifest } from "../engine/model.ts";
import { hashObject, readControlJson } from "../engine/objects.ts";
import { Repository } from "../engine/repo.ts";
import { mergeTrees } from "../engine/rewrite.ts";
import { cloneFrom } from "../engine/sync.ts";
import { buildTree, flattenTree } from "../engine/worktree.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const temps: ReturnType<typeof makeTempDir>[] = [];
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1000, timezoneOffsetMinutes: 0 };
const params = { minChunkSize: 64, maxChunkSize: 64, mask: 1 };
const secret = Buffer.from("terminal selected marker 58263941");
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); for (const temp of temps.splice(0)) temp.cleanup(); });

/** Create actual committed identities before exercising any denial. */
function fixture() {
  const temp = makeTempDir(); temps.push(temp);
  const repo = Repository.init(join(temp.root, "repo")); repo.setAuthority("fixture", "read-fixture", "erase-fixture"); repo.identity();
  writeFileSync(join(repo.root, "secret"), secret); writeFileSync(join(repo.root, "survivor"), "initial survivor bytes");
  repo.stage(["secret", "survivor"]); repo.commit({ message: "baseline", author }, new Date(1000));
  return { repo, temp, selected: repo.readIndex().find(entry => entry.path === "secret")!, survivor: repo.readIndex().find(entry => entry.path === "survivor")! };
}

/** Hash actual control bytes to detect partial publication without reading invalid registries. */
function durable(repo: Repository) {
  return readdirSync(repo.controlDirectory, { recursive: true, encoding: "utf8" }).filter(path => lstatSync(join(repo.controlDirectory, path)).isFile())
    .sort().map(path => [path, createHash("sha256").update(readFileSync(join(repo.controlDirectory, path))).digest("hex")]);
}

for (const value of ["null", "{}", "true", "[null]", "{malformed"]) {
  test(`layer registry refuses present ${value} before bulk staging private bytes`, () => {
    const { repo } = fixture(); const bytes = Buffer.from("private overlay marker 63719482");
    repo.addLayer("private", new Map([["survivor", { content: bytes, executable: false }]]));
    writeFileSync(join(repo.controlDirectory, "layers.json"), value); const before = durable(repo);
    assert.throws(() => repo.layers(), { code: "bad_layers" });
    assert.throws(() => repo.stage([]), { code: "bad_layers" });
    assert.deepEqual(durable(repo), before); assert.deepEqual(readFileSync(join(repo.root, "survivor")), bytes);
  });
}

test("layer registry distinguishes actual absence, empty array and valid private snapshots", () => {
  const { repo, survivor } = fixture(); const registry = join(repo.controlDirectory, "layers.json");
  assert.equal(readControlJson(registry, "bad_layers", "layers"), null); assert.deepEqual(repo.layers(), []);
  assert.deepEqual(repo.stage([]), []); writeFileSync(registry, "[]"); assert.deepEqual(repo.layers(), []); assert.deepEqual(repo.stage([]), []);
  repo.addLayer("private", new Map([["survivor", { content: Buffer.from("private bytes"), executable: false }]]));
  assert.equal(repo.layers()[0]!.name, "private"); assert.deepEqual(repo.stage([]), []);
  assert.equal(repo.readIndex().find(entry => entry.path === "survivor")!.id, survivor.id);
});

test("layer registry rejects an actual replacement with JSON null during its original read", () => {
  const { repo } = fixture(); const registry = join(repo.controlDirectory, "layers.json"); writeFileSync(registry, "[]");
  const read = fs.readFileSync; let replaced = false;
  mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === registry && !replaced) { replaced = true; writeFileSync(registry, "null"); }
    return read(...args);
  });
  syncBuiltinESMExports();
  assert.throws(() => repo.layers(), { code: "bad_layers" }); assert.equal(replaced, true);
  mock.restoreAll(); syncBuiltinESMExports(); assert.equal(readFileSync(registry, "utf8"), "null");
});

test("layer registry preserves actual no-follow and native filesystem refusals", () => {
  const { repo, temp } = fixture(); const registry = join(repo.controlDirectory, "layers.json"); const outside = join(temp.root, "outside");
  writeFileSync(outside, "null"); symlinkSync(outside, registry); assert.throws(() => repo.layers(), { code: "bad_layers" });
  assert.equal(readFileSync(outside, "utf8"), "null"); rmSync(registry); symlinkSync(join(temp.root, "missing"), registry);
  assert.throws(() => repo.stage([]), { code: "bad_layers" }); rmSync(registry); mkdirSync(registry);
  assert.throws(() => repo.layers(), { code: "EISDIR" }); rmSync(registry, { recursive: true });
  const parent = join(temp.root, "regular-file"); writeFileSync(parent, "sentinel");
  assert.throws(() => readLayers(parent), { code: "ENOTDIR" }); assert.equal(readFileSync(parent, "utf8"), "sentinel");
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    writeFileSync(registry, "[]"); chmodSync(registry, 0);
    try { assert.throws(() => repo.layers(), { code: "EACCES" }); }
    finally { chmodSync(registry, 0o600); }
  }
});

const writers = ["fixed-buffer", "fixed-file", "fixed-fd", "cdc-buffer", "cdc-file", "cdc-fd", "manifest"] as const;
type Writer = typeof writers[number];

/** Exercise real public buffer/file/descriptor APIs with identical owning provenance. */
function write(repo: Repository, source: string, bytes: Buffer, kind: Writer, fileId?: string): FragmentWriteResult {
  if (kind === "fixed-buffer") return writeFragmented(repo.objects, bytes, 64, fileId);
  if (kind === "cdc-buffer") return writeCdcFragmented(repo.objects, bytes, params, fileId);
  if (kind === "manifest") {
    const id = repo.objects.write("blob", bytes, fileId); const manifest = { totalLength: bytes.length, fragments: [{ id, length: bytes.length }] };
    return { manifestId: writeManifest(repo.objects, manifest, fileId), manifest };
  }
  writeFileSync(source, bytes);
  if (kind === "fixed-file") return writeFragmentedFile(repo.objects, source, 64, fileId);
  if (kind === "cdc-file") return writeCdcFragmentedFile(repo.objects, source, params, fileId);
  const fd = openSync(source, "r");
  try {
    const fragments = kind === "fixed-fd" ? writeFragmentsFromFd(repo.objects, fd, bytes.length, 64, source, fileId)
      : writeCdcFragmentsFromFd(repo.objects, fd, bytes.length, params, source, fileId);
    const manifest = { totalLength: bytes.length, fragments, ...(kind === "cdc-fd" ? { mode: "cdc" as const } : {}) };
    return { manifestId: writeManifest(repo.objects, manifest, fileId), manifest };
  } finally { closeSync(fd); }
}

for (const kind of writers) {
  test(`post-erasure ${kind} preserves owner checks, reads, hashes and real clone/export`, async () => {
    const { repo, temp, selected, survivor } = fixture(); repo.obliterate("secret", "erase-fixture", "incident", new Date(2000));
    const source = join(temp.root, "source"); const bytes = Buffer.from("independent surviving bytes 69428153\n".repeat(9));
    const result = write(repo, source, bytes, kind, survivor.fileId);
    assert.deepEqual(readFragmented(repo.objects, result.manifestId), bytes); assert.equal(result.manifestId, manifestId(result.manifest));
    if (kind.startsWith("fixed")) assert.equal(result.manifestId, fragmentedContentId(bytes, 64));
    if (kind.startsWith("cdc")) assert.equal(result.manifestId, cdcFragmentedContentId(bytes, params));
    for (const fragment of result.manifest.fragments) assert.equal(hashObject("blob", repo.objects.readTyped(fragment.id, "blob")), fragment.id);
    repo.writeIndex(repo.readIndex().map(entry => entry.path === "survivor" ? { ...entry, id: result.manifestId } : entry));
    writeFileSync(join(repo.root, "survivor"), bytes); const tip = repo.commit({ message: "fragmented survivor", author }, new Date(3000));
    const archive = parseBundle(exportBundle(repo.objects, repo.refs, [])); assert.ok(archive.lines.some(object => object.id === result.manifestId));
    const cloneRoot = join(temp.root, "clone"); await cloneFrom(repo.root, cloneRoot, new Date(4000)); const clone = Repository.open(cloneRoot);
    assert.deepEqual(readFileSync(join(clone.root, "survivor")), bytes); assert.deepEqual(readFragmented(clone.objects, result.manifestId), bytes);
    assert.equal(clone.readFileState(tip, "secret").kind, "obliterated"); assert.deepEqual(clone.verify().corrupt, []);
    const before = durable(repo);
    assert.throws(() => write(repo, source, bytes, kind, selected.fileId), { code: "file_obliterated" }); assert.deepEqual(durable(repo), before);
    assert.throws(() => write(repo, source, secret, kind, survivor.fileId), { code: "object_obliterated" }); assert.deepEqual(durable(repo), before);
    assert.throws(() => write(repo, source, Buffer.from(secret.toString("base64")), kind, survivor.fileId), { code: "object_obliterated" }); assert.deepEqual(durable(repo), before);
    assert.throws(() => write(repo, source, Buffer.from([0x78, 0x9c, 1]), kind, survivor.fileId), { code: "uninspectable_payload" }); assert.deepEqual(durable(repo), before);
    assert.throws(() => write(repo, source, bytes, kind), { code: "unattributed_arrival" }); assert.deepEqual(durable(repo), before);
  });
}

test("standalone manifest refuses denied ownership, erased references and anonymous publication", () => {
  const { repo, selected, survivor } = fixture(); repo.obliterate("secret", "erase-fixture", "incident", new Date(2000));
  const manifest = { totalLength: 0, fragments: [] }; const before = durable(repo);
  assert.throws(() => writeManifest(repo.objects, manifest, selected.fileId), { code: "file_obliterated" }); assert.deepEqual(durable(repo), before);
  assert.throws(() => writeManifest(repo.objects, { totalLength: secret.length, fragments: [{ id: selected.id, length: secret.length }] }, survivor.fileId), { code: "object_obliterated" }); assert.deepEqual(durable(repo), before);
  assert.throws(() => writeManifest(repo.objects, manifest), { code: "unattributed_arrival" }); assert.deepEqual(durable(repo), before);
  const id = writeManifest(repo.objects, manifest, survivor.fileId); assert.deepEqual(readFragmented(repo.objects, id), Buffer.alloc(0));
});

for (const [type, baseKind] of [["blob", "legacy"], ["record", "legacy"], ["blob", "attributed"], ["blob", "absent"]] as const) {
  test(`legacy two-sided ${type} merge after unrelated erasure uses ${baseKind} base provenance`, async () => {
    const { repo, temp } = fixture(); const path = type === "blob" ? "legacy.txt" : "legacy.json";
    const payloads = type === "blob" ? ["a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n"].map(text => Buffer.from(text))
      : [{ left: "a", right: "c" }, { left: "A", right: "c" }, { left: "a", right: "C" }].map(encodeRecord);
    const ids = payloads.map(payload => repo.objects.write(type, payload));
    const trees = ids.map(id => buildTree(repo.objects, new Map([[path, { id, mode: "100644" }]])));
    let expectedOwner = createHash("sha256").update("pm-vcs legacy file identity\0").update(path).update("\0").update(ids[baseKind === "absent" ? 1 : 0]!).digest("hex").slice(0, 32);
    if (baseKind === "attributed") { expectedOwner = repo.readIndex().find(entry => entry.path === "survivor")!.fileId!; trees[0] = buildTree(repo.objects, new Map([[path, { id: ids[0]!, mode: "100644", fileId: expectedOwner }]])); }
    repo.obliterate("secret", "erase-fixture", "incident", new Date(2000));
    const result = mergeTrees({ store: repo.objects, config: repo.config, committer: author }, baseKind === "absent" ? null : trees[0]!, trees[1]!, trees[2]!);
    if (baseKind !== "absent") assert.deepEqual(result.conflicts, []);
    else assert.deepEqual(result.conflicts, [{ path, reason: "content" }]);
    const entry = flattenTree(repo.objects, result.tree).get(path)!;
    assert.equal(entry.fileId, expectedOwner);
    if (baseKind !== "absent") {
      assert.deepEqual(repo.objects.readTyped(entry.id, type), type === "blob" ? Buffer.from("A\nb\nC\n") : encodeRecord({ left: "A", right: "C" }));
    } else { assert.notEqual(entry.id, ids[1]); assert.match(repo.objects.readTyped(entry.id, "blob").toString(), /<<<<<<<[\s\S]*A[\s\S]*=======[\s\S]*C[\s\S]*>>>>>>>/); }
    assert.notEqual(entry.mode, "40000");
    repo.writeIndex([...repo.readIndex().filter(file => baseKind !== "attributed" || file.path !== "survivor"), { path, ...entry, mode: "100644" }]); const tip = repo.commit({ message: "legacy merge", author }, new Date(3000));
    assert.ok(parseBundle(exportBundle(repo.objects, repo.refs, [])).lines.some(object => object.id === entry.id));
    await cloneFrom(repo.root, join(temp.root, "clone"), new Date(4000)); const clone = Repository.open(join(temp.root, "clone"));
    assert.equal(clone.readFileState(tip, path).kind, "present"); assert.equal(clone.readIndex().find(file => file.path === path)!.fileId, expectedOwner);
    assert.deepEqual(clone.verify().corrupt, []);
  });
}
