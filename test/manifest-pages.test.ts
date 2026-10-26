import "./helpers/isolate-session.ts";
/** Measured real-filesystem metadata bounds, canonical nodes and closure compatibility. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { exportBundle, importBundleObjects } from "../engine/bundle.ts";
import { inspectClosure, requireClosure } from "../engine/closure.ts";
import { readFragmented, readFragmentedToFile, readFragmentRange, writeFragmentedFile, writeCdcFragmentedFile, fragmentedContentId } from "../engine/fragments.ts";
import { MANIFEST_FANOUT, ManifestWriter, materializeManifest, manifestFragments } from "../engine/manifest-pages.ts";
import { decodeManifest, encodeManifest, writeTree, writeCommit, type FragmentManifest } from "../engine/model.ts";
import { ObjectStore, type ObjectType, type ObjectId } from "../engine/objects.ts";
import { Repository } from "../engine/repo.ts";
import { makeTempDir } from "./helpers/tmp.ts";
const dirs: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) dir.cleanup(); });
/** Allocate an isolated real store. */
function fixture() {
  const dir = makeTempDir(); dirs.push(dir); return { dir, store: new ObjectStore(join(dir.root, "objects")) };
}
/** Measure actual serialized and decoded entry counts while native operations are in flight. */
class MeasuredStore extends ObjectStore {
  maximumEntries = 0;
  samples = 0;
  reads = 0;
  /** Observe each real metadata encoding immediately before physical publication. */
  write(type: ObjectType, payload: Buffer, fileId?: string): ObjectId {
    if (type === "manifest") this.sample(payload);
    return super.write(type, payload, fileId);
  }
  /** Observe bounded reads delivered to production decoders. */
  readBoundedTyped(id: ObjectId, type: ObjectType, limit?: number): Buffer {
    const payload = super.readBoundedTyped(id, type, limit); this.reads++;
    if (type === "manifest") this.sample(payload);
    return payload;
  }
  /** Observe explicit full-buffer convenience reads. */
  readTyped(id: ObjectId, type: ObjectType): Buffer {
    const payload = super.readTyped(id, type); this.reads++;
    if (type === "manifest") this.sample(payload);
    return payload;
  }
  /** Count resident references at the exact write/read boundary. */
  private sample(payload: Buffer): void {
    const node = decodeManifest(payload); this.samples++;
    this.maximumEntries = Math.max(this.maximumEntries, (node.pages ?? node.fragments).length);
    assert.ok(this.maximumEntries <= MANIFEST_FANOUT, `live materialized metadata reached ${this.maximumEntries} entries`);
  }
}

test("real streaming write/read/range operations keep live metadata bounded across 32769 fragments", () => {
  const { dir } = fixture(); const store = new MeasuredStore(join(dir.root, "measured"));
  const bytes = Buffer.alloc(32769, 65); bytes[bytes.length - 1] = 66;
  const source = join(dir.root, "source"); writeFileSync(source, bytes);
  const result = writeFragmentedFile(store, source, 1);
  assert.equal(result.manifest.height, 2); assert.ok(store.samples > 256);
  assert.equal(result.manifestId, fragmentedContentId(bytes, 1));
  const before = store.reads;
  assert.deepEqual(readFragmentRange(store, result.manifestId, 32768, 32769), Buffer.from("B"));
  assert.ok(store.reads - before <= 4, "range seek traversed metadata outside the selected hierarchy");
  const destination = join(dir.root, "restored"); readFragmentedToFile(store, result.manifestId, destination);
  assert.deepEqual(readFileSync(destination), bytes); assert.equal(store.maximumEntries, 128);
  assert.equal(materializeManifest(store, result.manifestId).fragments.length, bytes.length);
});

test("CDC disk writer shares bounded nodes and explicit full-list convenience reads", () => {
  const { dir } = fixture(); const store = new MeasuredStore(join(dir.root, "cdc"));
  const source = join(dir.root, "source"); const bytes = Buffer.alloc(500, 65); writeFileSync(source, bytes);
  const result = writeCdcFragmentedFile(store, source, { minChunkSize: 1, maxChunkSize: 1, mask: 0 });
  assert.equal(result.manifest.mode, "cdc"); assert.deepEqual(readFragmented(store, result.manifestId), bytes);
  assert.equal([...manifestFragments(store, result.manifestId)].length, bytes.length);
});

test("legacy flat v1 manifests remain byte-identical and readable", () => {
  const { store } = fixture(); const id = store.write("blob", Buffer.from("legacy"));
  const node = { totalLength: 6, fragments: [{ id, length: 6 }] };
  const payload = encodeManifest(node); assert.deepEqual(decodeManifest(payload), node);
  const root = store.write("manifest", payload); assert.deepEqual(readFragmentRange(store, root, 2, 5), Buffer.from("gac"));
});

test("very large synthetic byte lengths seek through bounded authenticated descriptors", () => {
  const { store } = fixture();
  const blob = store.write("blob", Buffer.alloc(1 << 20, 65));
  const writer = new ManifestWriter(store);
  for (let i = 0; i < 32769; i++) writer.add({ id: blob, length: 1 << 20 });
  const root = writer.finish(); assert.ok(root.manifest.totalLength > 32 * 1024 ** 3);
  assert.deepEqual(readFragmentRange(store, root.manifestId, root.manifest.totalLength - 3, root.manifest.totalLength), Buffer.from("AAA"));
  assert.throws(() => writer.finish(), { code: "invalid_manifest" });
});

test("paged manifests survive bundled closure and reject child mismatch without partial destination", () => {
  const { dir, store } = fixture(); const writer = new ManifestWriter(store);
  const blob = store.write("blob", Buffer.from("x"));
  for (let i = 0; i < 129; i++) writer.add({ id: blob, length: 1 });
  const root = writer.finish(); const node = decodeManifest(store.readTyped(root.manifestId, "manifest"));
  const repo = Repository.init(join(dir.root, "repo"));
  const source = join(dir.root, "source"); writeFileSync(source, Buffer.alloc(129, 120));
  const transferred = writeFragmentedFile(repo.objects, source, 1);
  const tree = writeTree(repo.objects, [{ name: "asset", mode: "100644", id: transferred.manifestId, fileId: "1".repeat(32) }]);
  const author = { name: "Author", email: "author@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
  const commit = writeCommit(repo.objects, { tree, parents: [], author, committer: author, message: "paged" });
  repo.refs.compareAndSwap("refs/heads/main", null, commit);
  const receiver = new ObjectStore(join(dir.root, "received"));
  importBundleObjects(receiver, exportBundle(repo.objects, repo.refs, [])); requireClosure(receiver, [commit]);
  assert.deepEqual(readFragmented(receiver, transferred.manifestId), Buffer.alloc(129, 120));
  const malformed: FragmentManifest = { ...node, pages: node.pages!.map((page, index) => index === 1 ? { ...page, length: 2 } : page), totalLength: 130 };
  const bad = store.write("manifest", encodeManifest(malformed));
  const destination = join(dir.root, "bad-output");
  assert.throws(() => readFragmentedToFile(store, bad, destination), { code: "invalid_manifest" }); assert.equal(existsSync(destination), false);
  const badTree = writeTree(repo.objects, [{ name: "bad", mode: "100644", id: bad }]);
  const arrivals = [bad, ...node.pages!.map(page => page.id), blob].map(id => ({ id, ...store.read(id) }));
  assert.ok(inspectClosure(repo.objects, [], arrivals, [], false, [badTree]).corrupt.length > 0);
});

test("v2 encode/decode rejects malformed node shapes and noncanonical bytes", () => {
  const { store } = fixture(); const blob = store.write("blob", Buffer.from("x"));
  const valid: FragmentManifest = { totalLength: 129, fragments: [], height: 1,
    pages: [{ id: blob, length: 128, count: 128 }, { id: blob, length: 1, count: 1 }] };
  const canonical = encodeManifest(valid); assert.deepEqual(decodeManifest(canonical), valid);
  for (const replacement of ["height 0", "height 8", "height 01", "height 1\nunknown yes"]) {
    assert.throws(() => decodeManifest(Buffer.from(canonical.toString().replace("height 1", replacement))), { code: "malformed_object" });
  }
  assert.throws(() => decodeManifest(canonical.subarray(0, -1)), { code: "malformed_object" });
  assert.throws(() => decodeManifest(Buffer.from(canonical.toString().replace("page ", "frag "))), { code: "malformed_object" });
  assert.throws(() => encodeManifest({ ...valid, pages: [] }), { code: "invalid_manifest" });
  assert.throws(() => decodeManifest(Buffer.from("pm-vcs-manifest 2" + " ".repeat(17000))), { code: "malformed_object" });
});
