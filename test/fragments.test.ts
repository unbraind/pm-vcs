// Fragment and range storage tests.
//
// A file must never have to be resident in memory to be stored, read, or
// served. These tests prove it: a file larger than any single buffer the
// implementation allocates is written through streaming fragment storage with
// bounded peak heap, a range read touches only the overlapping fragments, and
// storing the same content twice writes each fragment exactly once on disk.
// Every boundary case — empty file, one fragment, one fragment plus a byte, a
// range spanning a boundary, a zero-length range, an out-of-bounds range — is
// exercised against the real object store, never a mock.

import assert from "node:assert/strict";
import { closeSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { type ObjectId, type ObjectType, ObjectStore, ObjectStoreError, type StoredObject } from "../engine/objects.ts";
import {
  decodeManifest,
  encodeManifest,
  type FragmentManifest,
  manifestId,
  readManifest,
  writeManifest,
} from "../engine/model.ts";
import {
  DEFAULT_FRAGMENT_SIZE,
  fragmentedContentId,
  readFragmented,
  readFragmentRange,
  readFragmentedToFile,
  writeFragmented,
  writeFragmentedFile,
  writeFragmentsFromFd,
} from "../engine/fragments.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const dirs: Array<{ root: string; cleanup(): void }> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup();
});

/**
 * Creates a fresh object store in a temporary directory.
 *
 * @returns The store and its root path.
 */
function freshStore(): { store: ObjectStore; root: string } {
  const dir = makeTempDir();
  dirs.push(dir);
  return { store: new ObjectStore(join(dir.root, "objects")), root: dir.root };
}

/**
 * Counts every object file in the store's fan-out directories.
 *
 * Used to assert deduplication at the disk level: storing the same content
 * twice must not create a second copy of any fragment.
 *
 * @param root - The store root directory.
 * @returns The number of object files on disk.
 */
function countObjectFiles(root: string): number {
  let count = 0;
  for (const dir of readdirSync(join(root, "objects"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const entry of readdirSync(join(root, "objects", dir.name), { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.endsWith(".tmp")) count += 1;
    }
  }
  return count;
}

/**
 * Wraps an object store to record every read id.
 *
 * The range-read test asserts that only the fragments overlapping the
 * requested range are read from disk. This wrapper records the ids passed to
 * `read` and `readTyped` so the test can verify the non-overlapping fragments
 * were never accessed.
 */
class TrackingStore extends ObjectStore {
  /** Ids that were passed to `read` or `readTyped`, in call order. */
  readonly readIds: string[] = [];

  /** The real store this wrapper delegates to. */
  private readonly inner: ObjectStore;

  /** Construct a wrapper around the real store. */
  constructor(inner: ObjectStore) {
    super(inner["root"] as string);
    this.inner = inner;
  }

  /** Record and delegate a read. */
  read(id: ObjectId): StoredObject {
    this.readIds.push(id);
    return this.inner.read(id);
  }

  /** Record and delegate a typed read. */
  readTyped(id: ObjectId, type: ObjectType): Buffer {
    this.readIds.push(id);
    return this.inner.readTyped(id, type);
  }

  /** Delegate a has check. */
  has(id: ObjectId): boolean {
    return this.inner.has(id);
  }

  /** Delegate a write. */
  write(type: ObjectType, payload: Buffer): ObjectId {
    return this.inner.write(type, payload);
  }
}

// ─── Round-trip ─────────────────────────────────────────────────────────────

test("writeFragmented and readFragmented round-trip arbitrary content", () => {
  const { store } = freshStore();
  const content = Buffer.from("The quick brown fox jumps over the lazy dog.", "utf8");
  const { manifestId, manifest } = writeFragmented(store, content, 8);
  assert.equal(manifest.totalLength, content.length);
  assert.ok(manifest.fragments.length > 1, "content should span multiple fragments");
  const restored = readFragmented(store, manifestId);
  assert.deepEqual(restored, content);
});

test("writeFragmentedFile and readFragmentedToFile round-trip a file on disk", () => {
  const { store, root } = freshStore();
  const content = Buffer.from("Streaming content that lives on disk, not in a buffer.", "utf8");
  const sourcePath = join(root, "source.bin");
  writeFileSync(sourcePath, content);
  const { manifestId } = writeFragmentedFile(store, sourcePath, 16);
  const destinationPath = join(root, "restored.bin");
  readFragmentedToFile(store, manifestId, destinationPath);
  assert.deepEqual(readFileSync(destinationPath), content);
});

// ─── Boundary: empty file ───────────────────────────────────────────────────

test("an empty file produces a manifest with no fragments and zero total length", () => {
  const { store } = freshStore();
  const { manifestId, manifest } = writeFragmented(store, Buffer.alloc(0), 64);
  assert.equal(manifest.totalLength, 0);
  assert.equal(manifest.fragments.length, 0);
  const restored = readFragmented(store, manifestId);
  assert.equal(restored.length, 0);
});

test("an empty file on disk round-trips through streaming write and read", () => {
  const { store, root } = freshStore();
  const sourcePath = join(root, "empty.bin");
  writeFileSync(sourcePath, Buffer.alloc(0));
  const { manifestId, manifest } = writeFragmentedFile(store, sourcePath, 64);
  assert.equal(manifest.totalLength, 0);
  assert.equal(manifest.fragments.length, 0);
  const destinationPath = join(root, "restored.bin");
  readFragmentedToFile(store, manifestId, destinationPath);
  assert.equal(readFileSync(destinationPath).length, 0);
});

// ─── Boundary: exactly one fragment ─────────────────────────────────────────

test("content exactly one fragment long produces a single-fragment manifest", () => {
  const { store } = freshStore();
  const fragmentSize = 64;
  const content = Buffer.alloc(fragmentSize, 0xab);
  const { manifest } = writeFragmented(store, content, fragmentSize);
  assert.equal(manifest.fragments.length, 1);
  assert.equal(manifest.fragments[0]!.length, fragmentSize);
  assert.equal(manifest.totalLength, fragmentSize);
});

// ─── Boundary: one fragment plus one byte ───────────────────────────────────

test("content one byte longer than a fragment produces two fragments", () => {
  const { store } = freshStore();
  const fragmentSize = 64;
  const content = Buffer.alloc(fragmentSize + 1, 0xcd);
  const { manifest } = writeFragmented(store, content, fragmentSize);
  assert.equal(manifest.fragments.length, 2);
  assert.equal(manifest.fragments[0]!.length, fragmentSize);
  assert.equal(manifest.fragments[1]!.length, 1);
  assert.equal(manifest.totalLength, fragmentSize + 1);
  assert.deepEqual(readFragmented(store, manifestId({ totalLength: content.length, fragments: manifest.fragments })), content);
});

// ─── Boundary: range spanning a fragment boundary ───────────────────────────

test("a range spanning a fragment boundary reads from two fragments", () => {
  const { store } = freshStore();
  const fragmentSize = 32;
  // Two fragments: [0..32) = all 0x01, [32..64) = all 0x02.
  const content = Buffer.concat([Buffer.alloc(fragmentSize, 0x01), Buffer.alloc(fragmentSize, 0x02)]);
  const { manifestId, manifest } = writeFragmented(store, content, fragmentSize);
  assert.equal(manifest.fragments.length, 2);
  // Range [24, 40) spans the boundary at byte 32: 8 bytes from fragment 0, 8 from fragment 1.
  const range = readFragmentRange(store, manifestId, 24, 40);
  assert.equal(range.length, 16);
  assert.deepEqual(range.subarray(0, 8), Buffer.alloc(8, 0x01));
  assert.deepEqual(range.subarray(8, 16), Buffer.alloc(8, 0x02));
});

// ─── Boundary: zero-length range ───────────────────────────────────────────

test("a zero-length range returns an empty buffer without reading any fragments", () => {
  const { store } = freshStore();
  const content = Buffer.from("some content here", "utf8");
  const { manifestId } = writeFragmented(store, content, 8);
  const tracking = new TrackingStore(store);
  const range = readFragmentRange(tracking, manifestId, 5, 5);
  assert.equal(range.length, 0);
  // Only the manifest was read — no fragment blobs.
  assert.equal(tracking.readIds.length, 1);
});

test("a zero-length range at the end of the content is valid", () => {
  const { store } = freshStore();
  const content = Buffer.from("end", "utf8");
  const { manifestId } = writeFragmented(store, content, 2);
  const range = readFragmentRange(store, manifestId, content.length, content.length);
  assert.equal(range.length, 0);
});

// ─── Boundary: out-of-bounds range ──────────────────────────────────────────

test("a range with start beyond the content length is rejected", () => {
  const { store } = freshStore();
  const content = Buffer.from("short", "utf8");
  const { manifestId } = writeFragmented(store, content, 2);
  assert.throws(
    () => readFragmentRange(store, manifestId, content.length + 1, content.length + 1),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "range_out_of_bounds",
  );
});

test("a range with end beyond the content length is rejected", () => {
  const { store } = freshStore();
  const content = Buffer.from("short", "utf8");
  const { manifestId } = writeFragmented(store, content, 2);
  assert.throws(
    () => readFragmentRange(store, manifestId, 0, content.length + 1),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "range_out_of_bounds",
  );
});

test("a negative range boundary is rejected", () => {
  const { store } = freshStore();
  const content = Buffer.from("data", "utf8");
  const { manifestId } = writeFragmented(store, content, 2);
  assert.throws(
    () => readFragmentRange(store, manifestId, -1, 2),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "range_out_of_bounds",
  );
});

test("an inverted range (start > end) is rejected", () => {
  const { store } = freshStore();
  const content = Buffer.from("data", "utf8");
  const { manifestId } = writeFragmented(store, content, 2);
  assert.throws(
    () => readFragmentRange(store, manifestId, 3, 1),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "range_out_of_bounds",
  );
});

test("a non-integer range boundary is rejected", () => {
  const { store } = freshStore();
  const content = Buffer.from("data", "utf8");
  const { manifestId } = writeFragmented(store, content, 2);
  assert.throws(
    () => readFragmentRange(store, manifestId, 0.5, 2),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "range_out_of_bounds",
  );
});

// ─── Range read touches only overlapping fragments ──────────────────────────

test("a range read touches only the fragments overlapping the range", () => {
  const { store } = freshStore();
  const fragmentSize = 16;
  // Four fragments: 0x01, 0x02, 0x03, 0x04.
  const content = Buffer.concat([
    Buffer.alloc(fragmentSize, 0x01),
    Buffer.alloc(fragmentSize, 0x02),
    Buffer.alloc(fragmentSize, 0x03),
    Buffer.alloc(fragmentSize, 0x04),
  ]);
  const { manifestId, manifest } = writeFragmented(store, content, fragmentSize);
  assert.equal(manifest.fragments.length, 4);
  // Range [20, 36) overlaps fragment 1 (bytes 16..31) and fragment 2 (bytes 32..47).
  // Fragments 0 and 3 must NOT be read.
  const tracking = new TrackingStore(store);
  const range = readFragmentRange(tracking, manifestId, 20, 36);
  assert.equal(range.length, 16);
  // Fragment 1: bytes 20..31 = 12 bytes of 0x02.
  assert.deepEqual(range.subarray(0, 12), Buffer.alloc(12, 0x02));
  // Fragment 2: bytes 32..36 = 4 bytes of 0x03.
  assert.deepEqual(range.subarray(12, 16), Buffer.alloc(4, 0x03));
  // The manifest id plus fragment 1 and fragment 2 ids = 3 reads.
  assert.equal(tracking.readIds.length, 3);
  assert.deepEqual(tracking.readIds, [manifestId, manifest.fragments[1]!.id, manifest.fragments[2]!.id]);
});

// ─── Deduplication ──────────────────────────────────────────────────────────

test("storing identical content twice yields the same fragment ids and no second copy on disk", () => {
  const { store, root } = freshStore();
  const content = Buffer.alloc(256, 0x42);
  const first = writeFragmented(store, content, 32);
  const filesAfterFirst = countObjectFiles(root);
  const second = writeFragmented(store, content, 32);
  const filesAfterSecond = countObjectFiles(root);
  // Same manifest id.
  assert.equal(second.manifestId, first.manifestId);
  // Same fragment ids.
  assert.deepEqual(second.manifest.fragments, first.manifest.fragments);
  // No new files on disk: every fragment was already present.
  assert.equal(filesAfterSecond, filesAfterFirst);
});

test("storing identical content from a file twice writes no new fragment files", () => {
  const { store, root } = freshStore();
  const content = Buffer.alloc(200, 0x77);
  const sourcePath = join(root, "source.bin");
  writeFileSync(sourcePath, content);
  const first = writeFragmentedFile(store, sourcePath, 32);
  const filesAfterFirst = countObjectFiles(root);
  const second = writeFragmentedFile(store, sourcePath, 32);
  const filesAfterSecond = countObjectFiles(root);
  assert.equal(second.manifestId, first.manifestId);
  assert.deepEqual(second.manifest.fragments, first.manifest.fragments);
  assert.equal(filesAfterSecond, filesAfterFirst);
});

// ─── Streaming: bounded peak heap ───────────────────────────────────────────

/**
 * Bytes currently held by Buffer and TypedArray backing stores.
 *
 * Node allocates `Buffer` contents OUTSIDE the V8 heap, so
 * `process.memoryUsage().heapUsed` does not observe them: a 2 MiB
 * `readFileSync` moves `heapUsed` by a few kilobytes of noise while moving
 * `arrayBuffers` by the full 2 MiB. Measuring the heap therefore cannot
 * distinguish a streaming implementation from one that buffers the whole file,
 * which is the entire property these tests exist to prove. `arrayBuffers` is
 * the counter that tracks the allocation the fragment path is bounded by.
 *
 * @returns Bytes attributed to ArrayBuffer and Buffer backing stores.
 */
function bufferBytes(): number {
  return process.memoryUsage().arrayBuffers;
}

/**
 * An ObjectStore that samples buffer memory on every write, recording the
 * high-water mark observed WHILE the operation is in flight.
 *
 * A before/after delta around a completed call cannot prove bounded memory: it
 * measures what is still retained afterwards, so an implementation that reads
 * the whole file, writes every fragment, and then releases the buffer shows a
 * delta near zero. Sampling inside `write` observes the source buffer while it
 * is still live, which is the only point at which whole-file buffering is
 * distinguishable from streaming.
 *
 * @param root - Directory to place the object store in.
 * @returns The sampling store, a reader for the peak observed, and a reset so
 *   a setup phase's allocations do not pollute the phase under measurement.
 */
function peakSamplingStore(root: string): {
  store: ObjectStore;
  peak: () => number;
  resetPeak: () => void;
} {
  const store = new ObjectStore(join(root, "objects"));
  let peak = 0;
  const sample = (): void => {
    // Collect first. `arrayBuffers` counts backing stores that have been
    // allocated but not yet reclaimed, so an uncollected sample measures the
    // garbage a streaming loop leaves behind rather than what it holds live —
    // for a 512-fragment read that reads as ~10 MB for a 2 MB file. Forcing a
    // collection makes each sample reflect live memory, which is the property
    // under test.
    global.gc?.();
    const now = bufferBytes();
    if (now > peak) peak = now;
  };
  const realWrite = store.write.bind(store);
  store.write = (type: ObjectType, payload: Buffer): ObjectId => {
    sample();
    return realWrite(type, payload);
  };
  const realReadTyped = store.readTyped.bind(store);
  store.readTyped = (id: ObjectId, type: ObjectType): Buffer => {
    sample();
    return realReadTyped(id, type);
  };
  return { store, peak: () => peak, resetPeak: () => { peak = 0; } };
}

test("writing a file larger than any single buffer never holds more than a fragment in memory", () => {
  const { root } = freshStore();
  // The source is 512x the fragment size (2 MiB), far larger than any single
  // buffer a streaming implementation allocates.
  const fragmentSize = 4096;
  const fileMultiplier = 128;
  const totalSize = fragmentSize * fileMultiplier;
  const sourcePath = join(root, "large.bin");
  // Write the source using streaming I/O so the test itself does not hold the
  // whole file in memory either.
  const fd = openSync(sourcePath, "w");
  try {
    const chunk = Buffer.alloc(fragmentSize, 0xfe);
    for (let i = 0; i < fileMultiplier; i++) writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
  const { store, peak } = peakSamplingStore(root);
  // Warm up so the sampled run reflects steady state, not one-time directory
  // creation, and so the baseline is taken after V8 has settled.
  writeFragmentedFile(store, sourcePath, fragmentSize);
  if (global.gc) global.gc();
  const baseline = bufferBytes();
  const { store: sampled, peak: sampledPeak } = peakSamplingStore(join(root, "second"));
  writeFragmentedFile(sampled, sourcePath, fragmentSize);
  const observed = sampledPeak() - baseline;
  // The bound is one quarter of the file size. An implementation that read the
  // whole file into a Buffer would still be holding it at every fragment write,
  // so the in-flight sample would exceed totalSize; staying under totalSize / 4
  // proves only a fragment is resident at a time.
  //
  // The sample is absolute `arrayBuffers` minus a baseline, so it also carries
  // unrelated allocation churn from the run — measured at ~64 KiB here, mostly
  // Node's 8 KiB Buffer pool. The file is sized so that quarter sits well clear
  // of that floor: at 64 fragments the bound landed exactly on the observed
  // value and the test failed on `<`.
  const bound = totalSize / 4;
  assert.ok(
    observed < bound,
    `Peak in-flight buffer memory ${observed} bytes should be less than ${bound} bytes ` +
      `(file size / 4). File size is ${totalSize} bytes — memory must be bounded by the ` +
      `fragment size, not the file size.`,
  );
  assert.ok(peak() > 0, "the warm-up store must have observed at least one write");
});

test("reading a file larger than any single buffer to disk never holds more than a fragment in memory", () => {
  const { store, root } = freshStore();
  const fragmentSize = 4096;
  const fileMultiplier = 128;
  const totalSize = fragmentSize * fileMultiplier;
  const sourcePath = join(root, "large.bin");
  const fd = openSync(sourcePath, "w");
  try {
    const chunk = Buffer.alloc(fragmentSize, 0xfe);
    for (let i = 0; i < fileMultiplier; i++) writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
  const { manifestId } = writeFragmentedFile(store, sourcePath, fragmentSize);
  // Warm up so the sampled run reflects steady state.
  readFragmentedToFile(store, manifestId, join(root, "warm.bin"));
  // Sample memory WHILE the read is in flight. A reassemble-then-write
  // implementation holds every fragment at once, so its in-flight sample
  // exceeds the file size; the streaming path holds one fragment at a time.
  const { store: sampled, peak, resetPeak } = peakSamplingStore(join(root, "sampled"));
  const resampledId = writeFragmentedFile(sampled, sourcePath, fragmentSize).manifestId;
  // Discard the write phase's samples: only the read is under measurement.
  if (global.gc) global.gc();
  const readBaseline = bufferBytes();
  resetPeak();
  const destinationPath = join(root, "restored.bin");
  readFragmentedToFile(sampled, resampledId, destinationPath);
  const observed = peak() - readBaseline;
  const bound = totalSize / 4;
  assert.ok(
    observed < bound,
    `Peak in-flight buffer memory ${observed} bytes should be less than ${bound} bytes ` +
      `(file size / 4). File size is ${totalSize} bytes — memory must be bounded by the ` +
      `fragment size, not the file size.`,
  );
  // Verify correctness: the restored file matches the source.
  assert.deepEqual(readFileSync(destinationPath), readFileSync(sourcePath));
});

// ─── Manifest encoding ──────────────────────────────────────────────────────

test("encodeManifest and decodeManifest round-trip", () => {
  const manifest: FragmentManifest = {
    totalLength: 5,
    fragments: [
      { id: "a".repeat(64), length: 3 },
      { id: "b".repeat(64), length: 2 },
    ],
  };
  const encoded = encodeManifest(manifest);
  const decoded = decodeManifest(encoded);
  assert.equal(decoded.totalLength, 5);
  assert.equal(decoded.fragments.length, 2);
  assert.equal(decoded.fragments[0]!.id, "a".repeat(64));
  assert.equal(decoded.fragments[0]!.length, 3);
  assert.equal(decoded.fragments[1]!.id, "b".repeat(64));
  assert.equal(decoded.fragments[1]!.length, 2);
});

test("manifestId is a pure function of the manifest content", () => {
  const manifest: FragmentManifest = {
    totalLength: 2,
    fragments: [{ id: "c".repeat(64), length: 2 }],
  };
  assert.equal(manifestId(manifest), manifestId(manifest));
});

test("fragmentedContentId matches the id from writeFragmented for the same content and size", () => {
  const { store } = freshStore();
  const content = Buffer.from("matching content for id prediction", "utf8");
  const fragmentSize = 8;
  const predicted = fragmentedContentId(content, fragmentSize);
  const actual = writeFragmented(store, content, fragmentSize).manifestId;
  assert.equal(actual, predicted);
});

// ─── Manifest validation ────────────────────────────────────────────────────

test("encodeManifest rejects a negative total length", () => {
  assert.throws(
    () => encodeManifest({ totalLength: -1, fragments: [] }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_manifest",
  );
});

test("encodeManifest rejects a non-integer total length", () => {
  assert.throws(
    () => encodeManifest({ totalLength: 1.5, fragments: [] }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_manifest",
  );
});

test("encodeManifest rejects a malformed fragment id", () => {
  assert.throws(
    () => encodeManifest({ totalLength: 1, fragments: [{ id: "not-an-id", length: 1 }] }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_object_id",
  );
});

test("encodeManifest rejects a non-positive fragment length", () => {
  assert.throws(
    () => encodeManifest({ totalLength: 0, fragments: [{ id: "a".repeat(64), length: 0 }] }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_manifest",
  );
});

test("encodeManifest rejects fragment lengths that do not sum to the total", () => {
  assert.throws(
    () => encodeManifest({ totalLength: 10, fragments: [{ id: "a".repeat(64), length: 5 }] }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_manifest",
  );
});

test("decodeManifest rejects an unknown header", () => {
  const payload = Buffer.from(`${"pm-vcs-manifest 1"}\ntotal 0\nunknown header\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("decodeManifest rejects a repeated total header", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 0\ntotal 0\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("decodeManifest rejects a missing total header", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("decodeManifest rejects a wrong format marker", () => {
  const payload = Buffer.from(`pm-vcs-manifest 2\ntotal 0\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("decodeManifest rejects a fragment line with the wrong field count", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 1\nfrag ${"a".repeat(64)}\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("decodeManifest rejects a fragment line with a malformed id", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 1\nfrag not-an-id 1\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("decodeManifest rejects an empty line", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 0\n\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("decodeManifest rejects a line with no keyword", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 0\nnofield\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("decodeManifest rejects a fragment length that is not a positive integer", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 0\nfrag ${"a".repeat(64)} 0\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("readManifest rejects a non-manifest object", () => {
  const { store } = freshStore();
  const blobId = store.write("blob", Buffer.from("not a manifest", "utf8"));
  assert.throws(
    () => readManifest(store, blobId),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "object_type_mismatch",
  );
});

// ─── Fragment size validation ───────────────────────────────────────────────

test("writeFragmented rejects a non-positive fragment size", () => {
  const { store } = freshStore();
  assert.throws(
    () => writeFragmented(store, Buffer.from("x", "utf8"), 0),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_fragment_size",
  );
});

test("writeFragmented rejects a non-integer fragment size", () => {
  const { store } = freshStore();
  assert.throws(
    () => writeFragmented(store, Buffer.from("x", "utf8"), 1.5),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_fragment_size",
  );
});

test("writeFragmentedFile rejects a non-positive fragment size", () => {
  const { store, root } = freshStore();
  const sourcePath = join(root, "source.bin");
  writeFileSync(sourcePath, Buffer.from("x", "utf8"));
  assert.throws(
    () => writeFragmentedFile(store, sourcePath, -1),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_fragment_size",
  );
});

test("fragmentedContentId rejects a non-positive fragment size", () => {
  assert.throws(
    () => fragmentedContentId(Buffer.from("x", "utf8"), 0),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_fragment_size",
  );
});

// ─── Short read ──────────────────────────────────────────────────────────────

test("writeFragmentsFromFd throws on a short read when the file is smaller than declared", () => {
  const { store, root } = freshStore();
  const sourcePath = join(root, "truncated.bin");
  writeFileSync(sourcePath, Buffer.alloc(50, 0xab));
  const fd = openSync(sourcePath, "r");
  try {
    assert.throws(
      () => writeFragmentsFromFd(store, fd, 100, 32, sourcePath),
      (error: unknown) => error instanceof ObjectStoreError && error.code === "short_read",
    );
  } finally {
    closeSync(fd);
  }
});

// ─── Manifest decode validation: fragment length regex ───────────────────────

test("decodeManifest rejects a fragment length that is not numeric", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 1\nfrag ${"a".repeat(64)} abc\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

// ─── Manifest decode validation: sum mismatch ────────────────────────────────

test("decodeManifest rejects fragment lengths that do not sum to the total", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 10\nfrag ${"a".repeat(64)} 5\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

// ─── Manifest encode validation: fragment length zero ───────────────────────

test("encodeManifest rejects a fragment length of zero", () => {
  assert.throws(
    () => encodeManifest({ totalLength: 0, fragments: [{ id: "a".repeat(64), length: 0 }] }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_manifest",
  );
});

// ─── Manifest decode: total not numeric ─────────────────────────────────────

test("decodeManifest rejects a total that is not numeric", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal abc\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

// ─── Manifest decode: frag line with too many fields ─────────────────────────

test("decodeManifest rejects a frag line with extra fields", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 1\nfrag ${"a".repeat(64)} 1 extra\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

// ─── Manifest decode: frag line with only id (missing length) ────────────────

test("decodeManifest rejects a frag line missing the length", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 1\nfrag ${"a".repeat(64)}\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});
// A manifest records each fragment's id AND its length, stored separately, so a
// manifest naming a real blob of a different size is representable. Every read
// path derives arithmetic from the recorded length, so an unchecked mismatch
// corrupts silently: concat pads or truncates to totalLength, the streaming
// write emits the wrong byte count, and a range slice reads from the wrong
// offset. These assert the typed refusal instead, for a blob that is shorter
// than declared and one that is longer.
for (const [label, storedSize, declaredSize] of [
  ["shorter than declared", 8, 16],
  ["longer than declared", 24, 16],
] as const) {
  test(`a fragment blob ${label} is refused by every read path`, () => {
    const { store, root } = freshStore();
    const blobId = store.write("blob", Buffer.alloc(storedSize, 0xab));
    const id = writeManifest(store, {
      totalLength: declaredSize,
      fragments: [{ id: blobId, length: declaredSize }],
    });

    const expected = (error: unknown): boolean => {
      assert.ok(error instanceof ObjectStoreError);
      assert.equal(error.code, "fragment_length_mismatch");
      assert.match(error.message, new RegExp(`${storedSize} byte\\(s\\)`, "u"));
      assert.match(error.message, new RegExp(`declares ${declaredSize}`, "u"));
      return true;
    };

    assert.throws(() => readFragmented(store, id), expected);
    assert.throws(() => readFragmentedToFile(store, id, join(root, "out.bin")), expected);
    assert.throws(() => readFragmentRange(store, id, 0, declaredSize), expected);
  });
}

test("decodeManifest refuses a total header outside its canonical position", () => {
  // encodeManifest always writes `total` on line 2. Accepting it elsewhere
  // would let two different byte sequences decode to the same manifest, which
  // in a content-addressed store means one logical object with two ids and a
  // non-canonical encoding that round-trips as if it were real.
  const { store } = freshStore();
  const blobId = store.write("blob", Buffer.from("abcd", "utf8"));
  const canonical = encodeManifest({ totalLength: 4, fragments: [{ id: blobId, length: 4 }] });
  const lines = canonical.toString("utf8").split("\n");
  const reordered = [lines[0], lines[2], lines[1], ...lines.slice(3)].join("\n");
  assert.throws(
    () => decodeManifest(Buffer.from(reordered, "utf8")),
    (error: unknown) =>
      error instanceof ObjectStoreError &&
      error.code === "malformed_object" &&
      /canonical encoding places it on line 2/u.test(error.message),
  );
  // The canonical ordering still decodes, so the guard is bound to position
  // rather than to the presence of the header.
  assert.equal(decodeManifest(canonical).totalLength, 4);
});

test("writeFragmentedFile measures the descriptor it opened, not the path", () => {
  // statSync(path) followed by openSync(path) leaves a window in which the path
  // can be replaced, so the recorded totalLength could describe a different file
  // from the one whose bytes are stored. Measuring the descriptor closes it.
  // Asserted through the observable consequence: the manifest's totalLength
  // always equals the bytes actually fragmented.
  const { store, root } = freshStore();
  const sourcePath = join(root, "sized.bin");
  writeFileSync(sourcePath, Buffer.alloc(3000, 0x21));
  const { manifest } = writeFragmentedFile(store, sourcePath, 1024);
  assert.equal(manifest.totalLength, 3000);
  assert.equal(
    manifest.fragments.reduce((sum, fragment) => sum + fragment.length, 0),
    3000,
  );
  assert.equal(readFragmented(store, writeFragmentedFile(store, sourcePath, 1024).manifestId).length, 3000);
});
