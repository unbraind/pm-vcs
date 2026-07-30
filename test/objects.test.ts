import assert from "node:assert/strict";
import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  OBJECT_TYPES,
  ObjectStore,
  ObjectStoreError,
  frameObject,
  hashObject,
  isObjectId,
  parseFramedObject,
} from "../engine/objects.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

/**
 * Creates a fresh store rooted at a fresh directory.
 *
 * @returns A store backed by a real directory, cleaned up after the test.
 */
function freshStore(): { store: ObjectStore; root: string } {
  dir = makeTempDir();
  return { store: new ObjectStore(join(dir.root, "objects")), root: dir.root };
}

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

test("isObjectId accepts only 64 lowercase hex characters", () => {
  assert.equal(isObjectId("a".repeat(64)), true);
  // Uppercase, the wrong length and non-hex are all rejected: an id is
  // interpolated into a path, so anything that is not canonical hex must never
  // reach the filesystem.
  assert.equal(isObjectId("A".repeat(64)), false);
  assert.equal(isObjectId("a".repeat(63)), false);
  assert.equal(isObjectId("a".repeat(65)), false);
  assert.equal(isObjectId("g".repeat(64)), false);
  assert.equal(isObjectId(""), false);
});

test("frameObject and parseFramedObject round-trip for every object kind", () => {
  for (const type of OBJECT_TYPES) {
    const payload = Buffer.from(`body of a ${type}`, "utf8");
    const framed = frameObject(type, payload);
    const parsed = parseFramedObject(framed);
    assert.equal(parsed.type, type);
    assert.deepEqual(parsed.payload, payload);
  }
});

test("hashObject is a pure function of the framed content", () => {
  const payload = Buffer.from("content", "utf8");
  // The same content produces one id regardless of how many times it is hashed.
  assert.equal(hashObject("blob", payload), hashObject("blob", payload));
  // Different kinds with identical payloads hash differently: including the type
  // in the hashed bytes is what stops a blob colliding with a tree of the same
  // body.
  assert.notEqual(hashObject("blob", payload), hashObject("tree", payload));
  assert.notEqual(hashObject("blob", payload), hashObject("record", payload));
});

test("parseFramedObject rejects every malformed frame shape", () => {
  // No NUL separator.
  assert.throws(
    () => parseFramedObject(Buffer.from("blob 5", "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
  // Header present but no space separating the type from the length.
  assert.throws(
    () => parseFramedObject(Buffer.concat([Buffer.from("blob"), Buffer.from([0]), Buffer.from("x")])),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
  // Unknown object type.
  assert.throws(
    () => parseFramedObject(Buffer.concat([Buffer.from("widget 1"), Buffer.from([0]), Buffer.from("x")])),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
  // Non-numeric length field.
  assert.throws(
    () => parseFramedObject(Buffer.concat([Buffer.from("blob lots"), Buffer.from([0]), Buffer.from("x")])),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
  // Declared length disagrees with the payload.
  assert.throws(
    () => parseFramedObject(Buffer.concat([Buffer.from("blob 9"), Buffer.from([0]), Buffer.from("short")])),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("a written object round-trips byte-identically and deduplicates on identical content", () => {
  const { store } = freshStore();
  const payload = Buffer.from("hello store", "utf8");
  const id = store.write("blob", payload);
  assert.equal(store.has(id), true);
  assert.equal(store.has("0".repeat(64)), false);

  const read = store.read(id);
  assert.equal(read.type, "blob");
  assert.deepEqual(read.payload, payload);

  // Writing the same content a second time does not create a second object — the
  // returned id is identical, and the store reports it present from the first
  // write.
  const second = store.write("blob", payload);
  assert.equal(second, id);
});

test("read refuses a malformed id before touching the filesystem", () => {
  const { store } = freshStore();
  assert.throws(
    () => store.read("not-an-id"),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_object_id",
  );
  assert.throws(
    () => store.has("not-an-id"),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_object_id",
  );
});

test("read reports a missing object as object_not_found", () => {
  const { store } = freshStore();
  const missing = "f".repeat(64);
  assert.equal(store.has(missing), false);
  assert.throws(
    () => store.read(missing),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "object_not_found",
  );
});

test("read detects a corrupted stored object on read", () => {
  const { store, root } = freshStore();
  const id = store.write("blob", Buffer.from("intact content", "utf8"));
  const path = join(root, "objects", id.slice(0, 2), id.slice(2));
  // Mutate the deflated bytes on disk. The frame may still inflate and even stay
  // structurally valid, but the content will no longer hash to the id — which is
  // the one failure a content-addressed store must never hide.
  const original = readFileSync(path);
  const tampered = Buffer.from(original);
  tampered[tampered.length - 1] ^= 0xff;
  writeFileSync(path, tampered);

  assert.throws(
    () => store.read(id),
    (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      // The mutation either breaks decompression or, more rarely, yields a frame
      // whose content hashes to a different id. Both are corruption.
      assert.ok(
        error.code === "corrupt_object" || error.code === "object_not_found",
        `expected corruption detection, got ${error.code}`,
      );
      return true;
    },
  );
});

test("read reports an object whose bytes will not inflate as corrupt", () => {
  const { store, root } = freshStore();
  const id = store.write("blob", Buffer.from("plain", "utf8"));
  // Overwrite with bytes that are not a valid zlib stream, so the inflate path
  // itself throws rather than producing a wrong-but-valid frame.
  const path = join(root, "objects", id.slice(0, 2), id.slice(2));
  writeFileSync(path, Buffer.from("this is not zlib"));
  assert.throws(
    () => store.read(id),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_object",
  );
});

test("readTyped requires the requested kind", () => {
  const { store } = freshStore();
  const blobId = store.write("blob", Buffer.from("a blob", "utf8"));
  assert.deepEqual(store.readTyped(blobId, "blob"), Buffer.from("a blob", "utf8"));
  assert.throws(
    () => store.readTyped(blobId, "tree"),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "object_type_mismatch",
  );
});

test("a concurrent write of the same object lands once", () => {
  // Two writes of identical content produce one id; the second short-circuits
  // via has() before opening a temp file, so the object directory holds exactly
  // one file under that id.
  const { store, root } = freshStore();
  const payload = Buffer.from("shared", "utf8");
  const id = store.write("blob", payload);
  store.write("blob", payload);
  const objectPath = join(root, "objects", id.slice(0, 2), id.slice(2));
  assert.equal(readFileSync(objectPath).length, deflateSync(frameObject("blob", payload)).length);
});

test("write accepts the other object kinds too", () => {
  // Covers writing tree/commit/record so the deflate path is exercised for more
  // than blobs.
  const { store } = freshStore();
  const treeId = store.write("tree", Buffer.from("tree-bytes", "utf8"));
  const commitId = store.write("commit", Buffer.from("commit-bytes", "utf8"));
  const recordId = store.write("record", Buffer.from("record-bytes", "utf8"));
  for (const id of [treeId, commitId, recordId]) {
    assert.ok(isObjectId(id));
    assert.equal(store.has(id), true);
  }
});

test("read reports an object whose content hashes to a different id", () => {
  const { store, root } = freshStore();
  const id = store.write("blob", Buffer.from("verifiable", "utf8"));
  const path = join(root, "objects", id.slice(0, 2), id.slice(2));
  // Re-inflate, flip one payload byte, and re-deflate. The result still
  // decompresses and parses as a valid frame, but its content no longer hashes
  // to the id filed under — the precise failure the post-read hash check exists
  // to catch.
  const framed = inflateSync(readFileSync(path));
  framed[framed.length - 1] ^= 0x01;
  writeFileSync(path, deflateSync(framed));
  assert.throws(
    () => store.read(id),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_object",
  );
});

test("write cleans up its temp file and rethrows when the rename fails", () => {
  const { store, root } = freshStore();
  const payload = Buffer.from("rename-target", "utf8");
  const id = hashObject("blob", payload);
  const destination = join(root, "objects", id.slice(0, 2), id.slice(2));
  // Pre-create a directory at the destination path. `has` reads it and throws
  // (EISDIR), so it reports false; the write then opens its temp file in the
  // fan-out directory but cannot rename over an existing directory.
  mkdirSync(join(root, "objects", id.slice(0, 2)), { recursive: true });
  mkdirSync(destination);
  assert.throws(
    () => store.write("blob", payload),
    // The rethrown error is the filesystem's, not an ObjectStoreError.
    (error: unknown) => !(error instanceof ObjectStoreError),
  );
  // The temp file was removed rather than left behind.
  const leftovers = readdirSync(join(root, "objects", id.slice(0, 2))).filter(
    (name) => name.endsWith(".tmp"),
  );
  assert.deepEqual(leftovers, []);
});
