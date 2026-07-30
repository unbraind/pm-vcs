import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  type Commit,
  type RecordDocument,
  type Signature,
  type TreeEntry,
  writeCommit,
  writeTree,
  decodeCommit,
  decodeRecord,
  decodeTree,
  encodeCommit,
  encodeRecord,
  encodeTree,
  readCommit,
  readTree,
  treeId,
} from "../engine/model.ts";
import { ObjectStore, ObjectStoreError } from "../engine/objects.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

/**
 * Creates a store backed by a fresh directory.
 *
 * @returns The store and its root.
 */
function freshStore(): ObjectStore {
  dir = makeTempDir();
  return new ObjectStore(join(dir.root, "objects"));
}

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

const id = "0123456789abcdef".repeat(4);

/** A reusable signature for commit fixtures. */
const signature: Signature = { name: "Ada", email: "ada@example.invalid", timestamp: 1_700_000_000_000, timezoneOffsetMinutes: -120 };

test("encodeTree and decodeTree round-trip and canonicalise to one id", () => {
  const entries: TreeEntry[] = [
    { name: "zeta.txt", mode: "100644", id },
    { name: "alpha.txt", mode: "100755", id },
    { name: "docs", mode: "40000", id },
  ];
  const encoded = encodeTree(entries);
  const decoded = decodeTree(encoded);

  // The id is independent of the order the entries were supplied in: sorting by
  // byte order is what makes the encoding canonical.
  assert.deepEqual(
    decoded.map((entry) => entry.name),
    ["alpha.txt", "docs", "zeta.txt"],
  );
  assert.deepEqual(
    [...entries].reverse().map((entry) => entry.name),
    ["docs", "alpha.txt", "zeta.txt"],
  );
  assert.equal(treeId(entries), treeId([...entries].reverse()));
});

test("encodeTree rejects every disallowed entry name", () => {
  const at = (name: string): TreeEntry => ({ name, mode: "100644", id });
  // Empty name.
  assert.throws(
    () => encodeTree([at("")]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_tree_entry",
  );
  // A path separator inside a single entry name would be ambiguous.
  assert.throws(
    () => encodeTree([at("a/b")]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_tree_entry",
  );
  // NUL cannot appear in a path segment.
  assert.throws(
    () => encodeTree([at("a\0b")]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_tree_entry",
  );
  // A duplicated name would make the tree unrepresentable as a directory.
  assert.throws(
    () => encodeTree([at("dup"), at("dup")]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_tree_entry",
  );
});

test("decodeTree rejects truncated or misformed bytes", () => {
  // No NUL before an id.
  assert.throws(
    () => decodeTree(Buffer.from("100644 name", "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
  // Header with no mode separator.
  assert.throws(
    () => decodeTree(Buffer.concat([Buffer.from("name"), Buffer.from([0]), Buffer.from(id, "utf8")])),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
  // Unknown mode.
  assert.throws(
    () => decodeTree(Buffer.concat([Buffer.from("12345 name"), Buffer.from([0]), Buffer.from(id, "utf8")])),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
  // Truncated id.
  assert.throws(
    () => decodeTree(Buffer.concat([Buffer.from("100644 name"), Buffer.from([0]), Buffer.from("short", "utf8")])),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("encodeCommit and decodeCommit round-trip ancestry and message", () => {
  const commit: Commit = {
    tree: id,
    parents: [id, id],
    author: signature,
    committer: signature,
    message: "a merge\nwith two lines\n",
  };
  const decoded = decodeCommit(encodeCommit(commit));
  assert.equal(decoded.tree, commit.tree);
  assert.deepEqual(decoded.parents, commit.parents);
  assert.equal(decoded.author.name, signature.name);
  assert.equal(decoded.author.email, signature.email);
  assert.equal(decoded.author.timestamp, signature.timestamp);
  assert.equal(decoded.author.timezoneOffsetMinutes, signature.timezoneOffsetMinutes);
  assert.equal(decoded.message, commit.message);
});

test("decodeCommit rejects missing structure and unknown headers", () => {
  // No blank line separates headers from message.
  assert.throws(
    () => decodeCommit(Buffer.from("tree " + id, "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
  // Unknown header keyword.
  assert.throws(
    () => decodeCommit(Buffer.from(`tree ${id}\nblame nobody\n\nmsg`, "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
  // Missing required header: a commit with no author is not a commit.
  assert.throws(
    () => decodeCommit(Buffer.from(`tree ${id}\ncommitter ${signature.name} <${signature.email}> 1 0\n\nmsg`, "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("decodeCommit rejects a malformed signature", () => {
  // The signature parser reads from the right, so a name missing the timestamp
  // fields is rejected rather than silently misread.
  assert.throws(
    () => decodeCommit(Buffer.from(`tree ${id}\nauthor Ada <a@b>\ncommitter Ada <a@b> 1 0\n\nmsg`, "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("encodeRecord sorts keys so two routes to one document produce one id", () => {
  const oneWay: RecordDocument = { z: 1, a: "two", m: [1, 2, 3] };
  const otherWay: RecordDocument = { a: "two", m: [1, 2, 3], z: 1 };
  // Canonical encoding means identical documents serialise identically.
  assert.deepEqual(encodeRecord(oneWay), encodeRecord(otherWay));

  const decoded = decodeRecord(encodeRecord(oneWay));
  assert.equal(decoded.a, "two");
  assert.deepEqual(decoded.m, [1, 2, 3]);
});

test("decodeRecord rejects non-object payloads", () => {
  // Not JSON at all.
  assert.throws(
    () => decodeRecord(Buffer.from("not json", "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
  // Valid JSON but an array, not an object.
  assert.throws(
    () => decodeRecord(Buffer.from("[1,2,3]", "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
  // Valid JSON but a scalar.
  assert.throws(
    () => decodeRecord(Buffer.from("null", "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("writeTree/readTree and writeCommit/readCommit round-trip through the store", () => {
  const store = freshStore();
  const treeIdWritten = writeTree(store, [{ name: "file", mode: "100644", id }]);
  const readEntries = readTree(store, treeIdWritten);
  assert.equal(readEntries.length, 1);
  assert.equal(readEntries[0].name, "file");

  const commit: Commit = { tree: treeIdWritten, parents: [], author: signature, committer: signature, message: "root\n" };
  const commitId = writeCommit(store, commit);
  const read = readCommit(store, commitId);
  assert.equal(read.tree, treeIdWritten);
  assert.equal(read.message, "root\n");
});

test("readTree rejects an object stored as the wrong kind", () => {
  const store = freshStore();
  // A blob id handed to readTree must surface a type mismatch, not be returned
  // as bogus tree bytes.
  const blobId = store.write("blob", Buffer.from("not a tree", "utf8"));
  assert.throws(
    () => readTree(store, blobId),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "object_type_mismatch",
  );
});
