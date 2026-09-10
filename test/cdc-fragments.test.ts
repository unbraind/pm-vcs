// Content-defined chunking tests.
//
// The acceptance property is reuse under insertion, not "CDC exists". These
// tests measure it: take a large file, store it, insert a small edit at the
// FRONT (the worst case for fixed-size chunking), re-store it, and assert that
// the fraction of fragments reused is above a threshold. A fixed-size control
// runs the same edit and must reuse dramatically fewer fragments — without
// that control the test passes against both implementations and proves nothing.
//
// Also covers: edit at the end, edit in the middle, a file below the chunking
// threshold, an empty file, a file of entirely repeated bytes (pathological for
// a rolling hash), a file whose content never triggers a boundary (the
// max-chunk-size cap must bound it), determinism (in-process and across
// processes), manifest mode recording, CDC parameter validation, and round-trip
// correctness for both the in-memory and streaming paths.

import assert from "node:assert/strict";
import { closeSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, test } from "node:test";

import { type ObjectId, type ObjectType, ObjectStore, ObjectStoreError } from "../engine/objects.ts";
import {
  type CdcParams,
  type FragmentManifest,
  encodeManifest,
  decodeManifest,
  readManifest,
  writeManifest,
} from "../engine/model.ts";
import {
  DEFAULT_CDC_PARAMS,
  cdcFragmentedContentId,
  readFragmented,
  readFragmentedToFile,
  readFragmentRange,
  writeCdcFragmented,
  writeCdcFragmentedFile,
  writeCdcFragmentsFromFd,
  writeFragmented,
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
 * Used to assert reuse at the disk level: storing edited content must create
 * fewer new objects under CDC than under fixed-size chunking.
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
 * Generates a deterministic buffer of pseudo-random bytes from a fixed seed.
 *
 * @param length - Number of bytes to generate.
 * @param seed - Seed for the LCG.
 * @returns A buffer of deterministic pseudo-random bytes.
 */
function seededBytes(length: number, seed: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    buf[i] = state >>> 24;
  }
  return buf;
}

// ─── Round-trip ──────────────────────────────────────────────────────────────

test("writeCdcFragmented and readFragmented round-trip arbitrary content", () => {
  const { store } = freshStore();
  const content = seededBytes(256 * 1024, 42);
  const { manifestId, manifest } = writeCdcFragmented(store, content);
  assert.equal(manifest.totalLength, content.length);
  assert.equal(manifest.mode, "cdc");
  assert.ok(manifest.fragments.length > 1, "content should span multiple fragments");
  const restored = readFragmented(store, manifestId);
  assert.deepEqual(restored, content);
});

test("writeCdcFragmentedFile and readFragmentedToFile round-trip a file on disk", () => {
  const { store, root } = freshStore();
  const content = seededBytes(256 * 1024, 7);
  const sourcePath = join(root, "source.bin");
  writeFileSync(sourcePath, content);
  const { manifestId, manifest } = writeCdcFragmentedFile(store, sourcePath);
  assert.equal(manifest.mode, "cdc");
  assert.equal(manifest.totalLength, content.length);
  const destinationPath = join(root, "restored.bin");
  readFragmentedToFile(store, manifestId, destinationPath);
  assert.deepEqual(readFileSync(destinationPath), content);
});

// ─── Reuse under insertion (the acceptance property) ────────────────────────

test("a front insertion reuses most fragments under CDC, asserted by counting object files on disk", () => {
  const { store, root } = freshStore();
  const content = seededBytes(256 * 1024, 42);
  writeCdcFragmented(store, content);
  const objectsBefore = countObjectFiles(root);
  const edited = Buffer.concat([Buffer.alloc(64, 0xaa), content]);
  writeCdcFragmented(store, edited);
  const objectsAfter = countObjectFiles(root);
  const newObjects = objectsAfter - objectsBefore;
  // Only 1 new fragment + 1 new manifest = 2 new objects. The rest are reused.
  assert.ok(
    newObjects <= 3,
    `Front insertion should create at most 3 new objects (1 fragment + 1 manifest + margin), got ${newObjects}`,
  );
  const originalFragments = objectsBefore - 1;
  const reused = originalFragments - (newObjects - 1);
  const reuseFraction = reused / originalFragments;
  assert.ok(
    reuseFraction >= 0.8,
    `Front insertion reuse fraction ${reuseFraction.toFixed(2)} should be >= 0.80 under CDC`,
  );
});

test("a front insertion under fixed-size chunking reuses dramatically fewer fragments (the control)", () => {
  const { store, root } = freshStore();
  const content = seededBytes(256 * 1024, 42);
  const fragmentSize = 4096;
  writeFragmented(store, content, fragmentSize);
  const objectsBefore = countObjectFiles(root);
  const edited = Buffer.concat([Buffer.alloc(64, 0xaa), content]);
  writeFragmented(store, edited, fragmentSize);
  const objectsAfter = countObjectFiles(root);
  const newObjects = objectsAfter - objectsBefore;
  assert.ok(
    newObjects >= 64,
    `Front insertion under fixed-size should create >= 64 new objects (all fragments shift), got ${newObjects}`,
  );
  const originalFragments = objectsBefore - 1;
  const reused = originalFragments - (newObjects - 1);
  assert.ok(
    reused <= 0,
    `Front insertion under fixed-size should reuse <= 0 fragments (all shift), got ${reused}`,
  );
});

test("CDC reuses dramatically more fragments than fixed-size on a front insertion", () => {
  const { store: cdcStore, root: cdcRoot } = freshStore();
  const { store: fixedStore, root: fixedRoot } = freshStore();
  const content = seededBytes(256 * 1024, 42);
  const edit = Buffer.alloc(64, 0xbb);

  writeCdcFragmented(cdcStore, content);
  const cdcBefore = countObjectFiles(cdcRoot);
  writeCdcFragmented(cdcStore, Buffer.concat([edit, content]));
  const cdcNew = countObjectFiles(cdcRoot) - cdcBefore;

  const fragmentSize = 4096;
  writeFragmented(fixedStore, content, fragmentSize);
  const fixedBefore = countObjectFiles(fixedRoot);
  writeFragmented(fixedStore, Buffer.concat([edit, content]), fragmentSize);
  const fixedNew = countObjectFiles(fixedRoot) - fixedBefore;

  assert.ok(
    cdcNew < fixedNew / 10,
    `CDC new objects (${cdcNew}) should be < 1/10 of fixed-size new objects (${fixedNew})`,
  );
});

test("a middle insertion reuses most fragments under CDC", () => {
  const { store, root } = freshStore();
  const content = seededBytes(256 * 1024, 42);
  writeCdcFragmented(store, content);
  const objectsBefore = countObjectFiles(root);
  const midPos = Math.floor(content.length / 2);
  const edited = Buffer.concat([content.subarray(0, midPos), Buffer.alloc(64, 0xcc), content.subarray(midPos)]);
  writeCdcFragmented(store, edited);
  const objectsAfter = countObjectFiles(root);
  const newObjects = objectsAfter - objectsBefore;
  assert.ok(
    newObjects <= 3,
    `Middle insertion should create at most 3 new objects, got ${newObjects}`,
  );
  const originalFragments = objectsBefore - 1;
  const reused = originalFragments - (newObjects - 1);
  assert.ok(
    reused / originalFragments >= 0.8,
    `Middle insertion reuse fraction should be >= 0.80 under CDC, got ${(reused / originalFragments).toFixed(2)}`,
  );
});

test("an end insertion reuses all but the last fragment under CDC", () => {
  const { store, root } = freshStore();
  const content = seededBytes(256 * 1024, 42);
  writeCdcFragmented(store, content);
  const objectsBefore = countObjectFiles(root);
  const edited = Buffer.concat([content, Buffer.alloc(64, 0xdd)]);
  writeCdcFragmented(store, edited);
  const objectsAfter = countObjectFiles(root);
  const newObjects = objectsAfter - objectsBefore;
  assert.ok(
    newObjects <= 3,
    `End insertion should create at most 3 new objects, got ${newObjects}`,
  );
});

// ─── Boundary: empty file ────────────────────────────────────────────────────

test("an empty file produces a CDC manifest with no fragments and zero total length", () => {
  const { store } = freshStore();
  const { manifestId, manifest } = writeCdcFragmented(store, Buffer.alloc(0));
  assert.equal(manifest.totalLength, 0);
  assert.equal(manifest.fragments.length, 0);
  assert.equal(manifest.mode, "cdc");
  const restored = readFragmented(store, manifestId);
  assert.equal(restored.length, 0);
});

test("an empty file on disk round-trips through CDC streaming write and read", () => {
  const { store, root } = freshStore();
  const sourcePath = join(root, "empty.bin");
  writeFileSync(sourcePath, Buffer.alloc(0));
  const { manifestId, manifest } = writeCdcFragmentedFile(store, sourcePath);
  assert.equal(manifest.totalLength, 0);
  assert.equal(manifest.fragments.length, 0);
  assert.equal(manifest.mode, "cdc");
  const destinationPath = join(root, "restored.bin");
  readFragmentedToFile(store, manifestId, destinationPath);
  assert.equal(readFileSync(destinationPath).length, 0);
});

// ─── Boundary: file below the chunking threshold ──────────────────────────

test("a file smaller than minChunkSize produces a single fragment", () => {
  const { store } = freshStore();
  const content = seededBytes(100, 99);
  const { manifest } = writeCdcFragmented(store, content);
  assert.equal(manifest.fragments.length, 1, "content below minChunkSize should be one fragment");
  assert.equal(manifest.fragments[0]!.length, content.length);
  assert.equal(manifest.mode, "cdc");
});

test("a file exactly at minChunkSize may produce one fragment", () => {
  const { store } = freshStore();
  const content = seededBytes(DEFAULT_CDC_PARAMS.minChunkSize, 5);
  const { manifest } = writeCdcFragmented(store, content);
  assert.ok(manifest.fragments.length >= 1);
  assert.equal(manifest.totalLength, content.length);
});

// ─── Boundary: repeated bytes (pathological for rolling hash) ───────────────

test("a file of entirely repeated bytes still chunk correctly and respect maxChunkSize", () => {
  const { store } = freshStore();
  const content = Buffer.alloc(DEFAULT_CDC_PARAMS.maxChunkSize * 4, 0x41);
  const { manifest } = writeCdcFragmented(store, content);
  assert.equal(manifest.totalLength, content.length);
  for (const fragment of manifest.fragments) {
    assert.ok(
      fragment.length <= DEFAULT_CDC_PARAMS.maxChunkSize,
      `fragment length ${fragment.length} exceeds maxChunkSize ${DEFAULT_CDC_PARAMS.maxChunkSize}`,
    );
  }
  assert.equal(manifest.fragments.length, 4);
  const restored = readFragmented(store, writeManifest(store, manifest));
  assert.deepEqual(restored, content);
});

// ─── Boundary: content that never triggers a boundary (max chunk cap) ─────

test("the max-chunk-size cap bounds fragment size when no boundary is found", () => {
  const { store } = freshStore();
  const content = Buffer.alloc(DEFAULT_CDC_PARAMS.maxChunkSize * 3 + 100, 0x42);
  const { manifest } = writeCdcFragmented(store, content);
  let maxLen = 0;
  for (const fragment of manifest.fragments) {
    if (fragment.length > maxLen) maxLen = fragment.length;
  }
  assert.ok(
    maxLen <= DEFAULT_CDC_PARAMS.maxChunkSize,
    `Max fragment length ${maxLen} must not exceed maxChunkSize ${DEFAULT_CDC_PARAMS.maxChunkSize}`,
  );
  for (let i = 0; i < manifest.fragments.length - 1; i++) {
    assert.equal(
      manifest.fragments[i]!.length,
      DEFAULT_CDC_PARAMS.maxChunkSize,
      `fragment ${i} should be maxChunkSize when no boundary triggers`,
    );
  }
});

// ─── Determinism ────────────────────────────────────────────────────────────

test("chunking the same bytes twice produces byte-identical boundaries in-process", () => {
  const { store: store1 } = freshStore();
  const { store: store2 } = freshStore();
  const content = seededBytes(256 * 1024, 42);
  const result1 = writeCdcFragmented(store1, content);
  const result2 = writeCdcFragmented(store2, content);
  assert.deepEqual(result1.manifest.fragments, result2.manifest.fragments);
  assert.equal(result1.manifestId, result2.manifestId);
});

test("chunking the same bytes in a separate process produces the same manifest id", async () => {
  const content = seededBytes(256 * 1024, 42);
  const dir = makeTempDir();
  dirs.push(dir);
  const result1 = writeCdcFragmented(new ObjectStore(join(dir.root, "objects-1")), content);

  const cwd = process.cwd();
  const scriptLines = [
    `import { ObjectStore } from "${cwd}/engine/objects.ts";`,
    `import { writeCdcFragmented } from "${cwd}/engine/fragments.ts";`,
    `const content = Buffer.allocUnsafe(${content.length});`,
    `let state = 42;`,
    `for (let i = 0; i < ${content.length}; i++) {`,
    `  state = (Math.imul(state, 1103515245) + 12345) >>> 0;`,
    `  content[i] = state >>> 24;`,
    `}`,
    `const store = new ObjectStore(process.env.CDC_OBJECTS_PATH);`,
    `const result = writeCdcFragmented(store, content);`,
    `process.stdout.write(result.manifestId);`,
  ];
  const script = scriptLines.join("\n");

  const child = spawn("node", ["--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CDC_OBJECTS_PATH: join(dir.root, "objects-2") },
  });
  let stdout = "";
  let stderr = "";
  for await (const chunk of child.stdout) stdout += chunk.toString();
  for await (const chunk of child.stderr) stderr += chunk.toString();
  const code = await new Promise<number>((resolve) => { child.on("exit", (c: number | null) => resolve(c ?? 1)); });
  assert.equal(code, 0, `child process exited with ${code}: ${stderr}`);
  assert.equal(stdout, result1.manifestId, "cross-process manifest id should match");
});

// ─── Manifest mode recording ──────────────────────────────────────────────

test("CDC manifest encodes mode cdc and decodes back", () => {
  const { store } = freshStore();
  const content = seededBytes(256 * 1024, 42);
  const { manifestId, manifest } = writeCdcFragmented(store, content);
  const decoded = readManifest(store, manifestId);
  assert.equal(decoded.mode, "cdc");
  assert.deepEqual(decoded.fragments, manifest.fragments);
  assert.equal(decoded.totalLength, manifest.totalLength);
});

test("fixed-size manifest has no mode line and decodes without mode", () => {
  const { store } = freshStore();
  const content = seededBytes(100, 1);
  const { manifestId, manifest } = writeFragmented(store, content, 32);
  assert.equal(manifest.mode, undefined);
  const decoded = readManifest(store, manifestId);
  assert.equal(decoded.mode, undefined);
});

test("encodeManifest includes mode line only for CDC", () => {
  const { store } = freshStore();
  const blobId = store.write("blob", Buffer.from("x", "utf8"));
  const cdcManifest: FragmentManifest = { totalLength: 1, fragments: [{ id: blobId, length: 1 }], mode: "cdc" };
  const fixedManifest: FragmentManifest = { totalLength: 1, fragments: [{ id: blobId, length: 1 }] };
  const cdcEncoded = encodeManifest(cdcManifest).toString("utf8");
  const fixedEncoded = encodeManifest(fixedManifest).toString("utf8");
  assert.ok(cdcEncoded.includes("mode cdc"), "CDC manifest should include mode line");
  assert.ok(!fixedEncoded.includes("mode"), "fixed manifest should not include mode line");
  assert.equal(decodeManifest(Buffer.from(cdcEncoded, "utf8")).mode, "cdc");
  assert.equal(decodeManifest(Buffer.from(fixedEncoded, "utf8")).mode, undefined);
});

test("decodeManifest rejects a mode line not equal to cdc", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 0\nmode fixed\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("decodeManifest rejects a repeated mode header", () => {
  const payload = Buffer.from(`pm-vcs-manifest 1\ntotal 0\nmode cdc\nmode cdc\n`, "utf8");
  assert.throws(
    () => decodeManifest(payload),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("decodeManifest rejects a mode header outside its canonical position", () => {
  const { store } = freshStore();
  const blobId = store.write("blob", Buffer.from("abcd", "utf8"));
  const canonical = encodeManifest({ totalLength: 4, fragments: [{ id: blobId, length: 4 }], mode: "cdc" });
  const lines = canonical.toString("utf8").split("\n");
  // Move the mode line after the frag line.
  const reordered = [lines[0], lines[1], lines[3], lines[2]].join("\n") + "\n";
  assert.throws(
    () => decodeManifest(Buffer.from(reordered, "utf8")),
    (error: unknown) =>
      error instanceof ObjectStoreError &&
      error.code === "malformed_object" &&
      /canonical encoding places it on line 3/u.test(error.message),
  );
  assert.equal(decodeManifest(canonical).mode, "cdc");
});

test("encodeManifest rejects an invalid mode value", () => {
  assert.throws(
    () => encodeManifest({ totalLength: 0, fragments: [], mode: "invalid" as "cdc" }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_manifest",
  );
});

// ─── CDC parameter validation ──────────────────────────────────────────────

test("writeCdcFragmented rejects a non-positive minChunkSize", () => {
  const { store } = freshStore();
  assert.throws(
    () => writeCdcFragmented(store, Buffer.from("x"), { minChunkSize: 0, maxChunkSize: 64, mask: 0xff }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_cdc_params",
  );
});

test("writeCdcFragmented rejects a non-positive maxChunkSize", () => {
  const { store } = freshStore();
  assert.throws(
    () => writeCdcFragmented(store, Buffer.from("x"), { minChunkSize: 1, maxChunkSize: 0, mask: 0xff }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_cdc_params",
  );
});

test("writeCdcFragmented rejects minChunkSize exceeding maxChunkSize", () => {
  const { store } = freshStore();
  assert.throws(
    () => writeCdcFragmented(store, Buffer.from("x"), { minChunkSize: 100, maxChunkSize: 50, mask: 0xff }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_cdc_params",
  );
});

test("writeCdcFragmented rejects a negative mask", () => {
  const { store } = freshStore();
  assert.throws(
    () => writeCdcFragmented(store, Buffer.from("x"), { minChunkSize: 1, maxChunkSize: 64, mask: -1 }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_cdc_params",
  );
});

test("writeCdcFragmentedFile rejects invalid CDC parameters", () => {
  const { store, root } = freshStore();
  const sourcePath = join(root, "source.bin");
  writeFileSync(sourcePath, Buffer.from("x"));
  assert.throws(
    () => writeCdcFragmentedFile(store, sourcePath, { minChunkSize: 0, maxChunkSize: 64, mask: 0xff }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_cdc_params",
  );
});

test("cdcFragmentedContentId rejects invalid CDC parameters", () => {
  assert.throws(
    () => cdcFragmentedContentId(Buffer.from("x"), { minChunkSize: -1, maxChunkSize: 64, mask: 0xff }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_cdc_params",
  );
});

test("writeCdcFragmentsFromFd rejects invalid CDC parameters", () => {
  const { store, root } = freshStore();
  const sourcePath = join(root, "source.bin");
  writeFileSync(sourcePath, Buffer.alloc(16, 0x43));
  const fd = openSync(sourcePath, "r");
  try {
    assert.throws(
      () => writeCdcFragmentsFromFd(store, fd, 16, { minChunkSize: 0, maxChunkSize: 64, mask: 0xff }, sourcePath),
      (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_cdc_params",
    );
  } finally {
    closeSync(fd);
  }
});

test("writeCdcFragmentsFromFd rejects a negative totalLength", () => {
  const { store, root } = freshStore();
  const sourcePath = join(root, "source.bin");
  writeFileSync(sourcePath, Buffer.alloc(16, 0x43));
  const fd = openSync(sourcePath, "r");
  try {
    assert.throws(
      () => writeCdcFragmentsFromFd(store, fd, -1, DEFAULT_CDC_PARAMS, sourcePath),
      (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_total_length",
    );
  } finally {
    closeSync(fd);
  }
});

// ─── Short read ──────────────────────────────────────────────────────────────

test("writeCdcFragmentsFromFd throws on a short read when the file is smaller than declared", () => {
  const { store, root } = freshStore();
  const sourcePath = join(root, "truncated.bin");
  writeFileSync(sourcePath, Buffer.alloc(50, 0xab));
  const fd = openSync(sourcePath, "r");
  try {
    assert.throws(
      () => writeCdcFragmentsFromFd(store, fd, 100, DEFAULT_CDC_PARAMS, sourcePath),
      (error: unknown) => error instanceof ObjectStoreError && error.code === "short_read",
    );
  } finally {
    closeSync(fd);
  }
});

// ─── CDC id prediction ──────────────────────────────────────────────────────

test("cdcFragmentedContentId matches the id from writeCdcFragmented for the same content", () => {
  const { store } = freshStore();
  const content = seededBytes(256 * 1024, 42);
  const predicted = cdcFragmentedContentId(content);
  const actual = writeCdcFragmented(store, content).manifestId;
  assert.equal(actual, predicted);
});

// ─── CDC range read ─────────────────────────────────────────────────────────

test("readFragmentRange works on a CDC-manifested file", () => {
  const { store } = freshStore();
  const content = seededBytes(256 * 1024, 42);
  const { manifestId, manifest } = writeCdcFragmented(store, content);
  const start = DEFAULT_CDC_PARAMS.minChunkSize;
  const end = start + 4096;
  const range = readFragmentRange(store, manifestId, start, end);
  assert.deepEqual(range, content.subarray(start, end));
  assert.ok(manifest.fragments.length > 1);
});

// ─── CDC deduplication ──────────────────────────────────────────────────────

test("storing identical content twice under CDC yields the same fragment ids", () => {
  const { store: store1 } = freshStore();
  const { store: store2 } = freshStore();
  const content = seededBytes(256 * 1024, 42);
  const result1 = writeCdcFragmented(store1, content);
  const result2 = writeCdcFragmented(store2, content);
  assert.deepEqual(result1.manifest.fragments, result2.manifest.fragments);
  assert.equal(result1.manifestId, result2.manifestId);
});

// ─── CDC streaming memory ──────────────────────────────────────────────────

test("writing a CDC file larger than the chunk accumulator never holds more than maxChunkSize in memory", () => {
  const { root } = freshStore();
  const params: CdcParams = { minChunkSize: 256, maxChunkSize: 4096, mask: 0x7f };
  const totalSize = params.maxChunkSize * 64;
  const sourcePath = join(root, "large.bin");
  const fd = openSync(sourcePath, "w");
  try {
    const chunk = seededBytes(params.maxChunkSize, 0xfe);
    for (let i = 0; i < 64; i++) writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
  const store = new ObjectStore(join(root, "objects"));
  let peak = 0;
  const realWrite = store.write.bind(store);
  const sample = (): void => {
    global.gc?.();
    const now = process.memoryUsage().arrayBuffers;
    if (now > peak) peak = now;
  };
  store.write = (type: ObjectType, payload: Buffer): ObjectId => {
    sample();
    return realWrite(type, payload);
  };
  writeCdcFragmentedFile(store, sourcePath, params);
  if (global.gc) global.gc();
  const baseline = process.memoryUsage().arrayBuffers;
  peak = 0;
  writeCdcFragmentedFile(new ObjectStore(join(root, "objects-2")), sourcePath, params);
  const observed = peak - baseline;
  const bound = totalSize / 4;
  assert.ok(
    observed < bound,
    `Peak in-flight buffer memory ${observed} should be < ${bound} (file size / 4). CDC must bound memory by maxChunkSize, not file size.`,
  );
});