import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { type ObjectId, ObjectStore, ObjectStoreError } from "../engine/objects.ts";
import { type Commit, type Signature, writeCommit, writeTree } from "../engine/model.ts";
import { BRANCH_PREFIX, RefStore, TAG_PREFIX } from "../engine/refs.ts";
import {
  BUNDLE_FORMAT,
  exportBundle,
  importBundle,
  parseBundle,
  readBundle,
} from "../engine/bundle.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

/**
 * Creates a fresh store and ref store sharing a directory.
 *
 * @returns The store, refs and root.
 */
function fresh(): { store: ObjectStore; refs: RefStore; root: string } {
  dir = makeTempDir();
  const root = join(dir.root, ".pmvcs");
  return { store: new ObjectStore(join(root, "objects")), refs: new RefStore(root), root };
}

const signature: Signature = { name: "A", email: "a@b", timestamp: 1, timezoneOffsetMinutes: 0 };

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

/**
 * Builds one commit on `parents` over a tree holding a single file.
 *
 * @param store - Destination store.
 * @param parents - Parent commit ids.
 * @param blobText - Content of the single tracked file.
 * @param message - Commit message.
 * @returns The commit id.
 */
function makeCommit(store: ObjectStore, parents: readonly ObjectId[], blobText: string, message: string): ObjectId {
  const blobId = store.write("blob", Buffer.from(blobText));
  const treeId = writeTree(store, [{ name: "file.txt", mode: "100644", id: blobId }]);
  const commit: Commit = { tree: treeId, parents, author: signature, committer: signature, message: `${message}\n` };
  return writeCommit(store, commit);
}

test("export then import reproduces identical commit ids", () => {
  const source = fresh();
  const root = makeCommit(source.store, [], "root", "root");
  const tip = makeCommit(source.store, [root], "tip", "tip");
  source.refs.compareAndSwap(`${BRANCH_PREFIX}main`, null, tip);

  const bytes = exportBundle(source.store, source.refs, [`${BRANCH_PREFIX}main`]);
  // The bundle is a text file carrying the format marker, a JSON header and one
  // base64 object line per object.
  assert.ok(bytes.toString("utf8").startsWith(BUNDLE_FORMAT));

  const target = fresh();
  const report = importBundle(target.store, target.refs, bytes);
  // Every object is new to the target store.
  assert.equal(report.skipped.length, 0);
  assert.equal(report.added.length > 0, true);
  // The imported ref points at the same commit id, computed from the same bytes.
  assert.equal(target.refs.read(`${BRANCH_PREFIX}main`), tip);
  assert.equal(target.store.has(tip), true);
  assert.equal(target.store.has(root), true);
});

test("re-importing a bundle is a no-op that keeps the refs", () => {
  const source = fresh();
  const tip = makeCommit(source.store, [], "only", "only");
  source.refs.compareAndSwap(`${BRANCH_PREFIX}main`, null, tip);
  const bytes = exportBundle(source.store, source.refs, [`${BRANCH_PREFIX}main`]);

  const target = fresh();
  importBundle(target.store, target.refs, bytes);
  const again = importBundle(target.store, target.refs, bytes);
  // Second import adds nothing and skips everything.
  assert.equal(again.added.length, 0);
  assert.equal(again.skipped.length > 0, true);
  assert.equal(target.refs.read(`${BRANCH_PREFIX}main`), tip);
});

test("an incremental bundle records prerequisites and excludes their history", () => {
  const source = fresh();
  const root = makeCommit(source.store, [], "root", "root");
  const tip = makeCommit(source.store, [root], "tip", "tip");
  source.refs.compareAndSwap(`${BRANCH_PREFIX}main`, null, tip);

  // Export with `root` as a prerequisite the receiver already has.
  const bytes = exportBundle(source.store, source.refs, [`${BRANCH_PREFIX}main`], [root]);
  const { header } = parseBundle(bytes);
  assert.deepEqual(header.prerequisites, [root]);
  // The root commit's objects are excluded from the bundle body.
  assert.ok(!header.objects.includes(root));
});

test("import refuses a bundle whose prerequisites are missing", () => {
  const source = fresh();
  const root = makeCommit(source.store, [], "root", "root");
  const tip = makeCommit(source.store, [root], "tip", "tip");
  source.refs.compareAndSwap(`${BRANCH_PREFIX}main`, null, tip);
  const bytes = exportBundle(source.store, source.refs, [`${BRANCH_PREFIX}main`], [root]);

  // A target that does NOT have root must fail before anything is written.
  const target = fresh();
  assert.throws(
    () => importBundle(target.store, target.refs, bytes),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "missing_prerequisites",
  );
  // Nothing was stored: the failure is whole, not partial.
  assert.equal(target.store.has(tip), false);
});

test("export refuses a ref that does not exist", () => {
  const { store, refs } = fresh();
  assert.throws(
    () => exportBundle(store, refs, [`${BRANCH_PREFIX}ghost`]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "unknown_ref",
  );
});

test("parseBundle rejects a tampered object whose content no longer hashes to its id", () => {
  const source = fresh();
  const tip = makeCommit(source.store, [], "only", "only");
  source.refs.compareAndSwap(`${BRANCH_PREFIX}main`, null, tip);
  const bytes = Buffer.from(exportBundle(source.store, source.refs, [`${BRANCH_PREFIX}main`]));

  // Flip a byte inside one object line's base64 payload, then repair the line
  // length so the three-field split still holds. The id is unchanged, so the
  // recomputed hash disagrees — exactly the tamper the verifier exists for.
  const lines = bytes.toString("utf8").split("\n");
  const objectLineIndex = lines.findIndex((line) => line.startsWith("blob ") || line.startsWith("commit ") || line.startsWith("tree "));
  assert.ok(objectLineIndex > 1);
  const [type, id, encoded] = lines[objectLineIndex].split(" ");
  const payload = Buffer.from(encoded, "base64");
  payload[0] ^= 0xff;
  lines[objectLineIndex] = `${type} ${id} ${payload.toString("base64")}`;
  const tampered = Buffer.from(lines.join("\n"));

  assert.throws(
    () => parseBundle(tampered),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "bad_bundle",
  );
});

test("parseBundle rejects a malformed bundle", () => {
  const bad = (text: string): void => {
    assert.throws(
      () => parseBundle(Buffer.from(text)),
      (error: unknown) => error instanceof ObjectStoreError && error.code === "bad_bundle",
    );
  };
  // Wrong format marker.
  bad("something-else\n{}\n");
  // Header is not JSON.
  bad(`${BUNDLE_FORMAT}\nnot json\n`);
  // Header does not describe any refs.
  bad(`${BUNDLE_FORMAT}\n{}\n`);
  // Object line not three fields.
  bad(`${BUNDLE_FORMAT}\n${JSON.stringify({ refs: {}, prerequisites: [], objects: [] })}\nblob only-two-fields\n`);
  // Unknown object type.
  bad(`${BUNDLE_FORMAT}\n${JSON.stringify({ refs: {}, prerequisites: [], objects: [] })}\nwidget ${"0".repeat(64)} AA==\n`);
  // Not an object id.
  bad(`${BUNDLE_FORMAT}\n${JSON.stringify({ refs: {}, prerequisites: [], objects: [] })}\nblob not-an-id AA==\n`);
});

test("readBundle reports a missing file", () => {
  // Stands up its own directory rather than reaching for the shared `dir`, which is
  // null until a fixture creates one: the previous form needed a `?? "/nonexistent"`
  // fallback that no run could take.
  const { root } = fresh();
  assert.throws(
    () => readBundle(join(root, "missing.bundle")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "bundle_not_found",
  );
});

test("export without named refs exports every branch and tag", () => {
  const source = fresh();
  const a = makeCommit(source.store, [], "a", "a");
  const b = makeCommit(source.store, [], "b", "b");
  source.refs.compareAndSwap(`${BRANCH_PREFIX}main`, null, a);
  source.refs.compareAndSwap(`${TAG_PREFIX}v1`, null, b);
  // An empty refNames list means "everything".
  const bytes = exportBundle(source.store, source.refs, []);
  const { header } = parseBundle(bytes);
  assert.deepEqual(header.refs, { [`${BRANCH_PREFIX}main`]: a, [`${TAG_PREFIX}v1`]: b });
});

test("importBundle accepts a bundle whose header has no prerequisites field", () => {
  const source = fresh();
  const tip = makeCommit(source.store, [], "only", "only");
  source.refs.compareAndSwap(`${BRANCH_PREFIX}main`, null, tip);

  // Export a full bundle, then delete the prerequisites key from its header so
  // the `?? []` fallback in importBundle is exercised: the field is absent, so
  // the fallback reduces to an empty array rather than the bundle failing.
  const exported = exportBundle(source.store, source.refs, [`${BRANCH_PREFIX}main`]);
  const text = exported.toString("utf8");
  const parts = text.split("\n");
  const header = JSON.parse(parts[1]);
  delete header.prerequisites;
  parts[1] = JSON.stringify(header);
  const modified = Buffer.from(parts.join("\n"));

  const target = fresh();
  const report = importBundle(target.store, target.refs, modified);
  assert.equal(report.skipped.length, 0);
  assert.ok(report.added.length > 0);
  assert.equal(target.refs.read(`${BRANCH_PREFIX}main`), tip);
});
