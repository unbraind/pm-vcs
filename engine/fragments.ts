// Fragment and range storage for large files.
//
// A file must never have to be resident in memory to be stored, read, or
// served. This module splits content into content-addressed fragments stored as
// ordinary blobs in the existing object store, and writes a manifest that
// orders them. Readers can request a byte range and receive only the fragments
// covering it. Storing the same content twice stores the fragments once,
// because fragments are content-addressed blobs and the store already skips
// writes whose content is present.
//
// The write path is genuinely streaming: `writeFragmentedFile` reads the source
// through a file descriptor in fixed-size chunks, writes each chunk as a blob,
// and never allocates a buffer larger than the fragment size. The read path is
// equally incremental: `readFragmentedToFile` reads one fragment at a time and
// writes it to the destination, so a multi-gigabyte file is restored within a
// fixed memory ceiling. Range reads skip fragments that do not overlap the
// requested range entirely — the non-overlapping fragments are never read from
// disk.

import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";

import {
  hashObject,
  type ObjectId,
  ObjectStoreError,
  type ObjectStore,
} from "./objects.ts";
import type { CdcParams, FragmentEntry, FragmentManifest, FragmentWriteResult } from "./model.ts";
import { manifestId as computeManifestId, readManifest, writeManifest } from "./model.ts";

/** Default fragment size: 1 MiB. Large enough to amortise per-fragment overhead, small enough to bound memory. */
export const DEFAULT_FRAGMENT_SIZE = 1 << 20;

/**
 * Validates that a fragment size is a positive integer.
 *
 * @param fragmentSize - Candidate fragment size in bytes.
 * @param code - Stable error code raised on rejection.
 * @throws ObjectStoreError When the size is not a positive integer.
 */
function assertFragmentSize(fragmentSize: number, code: string): void {
  if (!Number.isInteger(fragmentSize) || fragmentSize <= 0) {
    throw new ObjectStoreError(code, `Fragment size ${fragmentSize} is not a positive integer.`);
  }
}

/**
 * Reads content from an open file descriptor in fixed-size chunks and writes each
 * chunk as a content-addressed blob.
 *
 * The buffer is allocated once and reused for every chunk, so peak additional
 * heap is bounded by `fragmentSize` regardless of `totalLength`. Extracted from
 * {@link writeFragmentedFile} so the short-read path can be exercised directly
 * with a file descriptor that has fewer bytes than the declared total length.
 *
 * @param store - Destination object store.
 * @param fd - Open file descriptor to read from.
 * @param totalLength - Expected total content length in bytes.
 * @param fragmentSize - Maximum bytes per fragment.
 * @param sourcePath - Source path, used in error messages.
 * @returns The ordered fragment entries.
 * @throws ObjectStoreError When `readSync` returns fewer bytes than requested.
 */
export function writeFragmentsFromFd(
  store: ObjectStore,
  fd: number,
  totalLength: number,
  fragmentSize: number,
  sourcePath: string,
): FragmentEntry[] {
  // This helper is exported, so its callers are not only the two in this module
  // that validate first. A fragmentSize of 0 makes `toRead` 0, the inner read
  // loop exit immediately, and `remaining` never decrease — an infinite loop
  // writing empty blobs, which is a worse failure than a rejected argument. A
  // negative or non-integer totalLength is equally not a length.
  assertFragmentSize(fragmentSize, "invalid_fragment_size");
  if (!Number.isInteger(totalLength) || totalLength < 0) {
    throw new ObjectStoreError(
      "invalid_total_length",
      `Total length ${totalLength} is not a non-negative integer.`,
    );
  }
  const fragments: FragmentEntry[] = [];
  const buffer = Buffer.allocUnsafe(fragmentSize);
  let remaining = totalLength;
  while (remaining > 0) {
    const toRead = Math.min(fragmentSize, remaining);
    // readSync may return fewer bytes than asked for without the file being
    // truncated, so fill the fragment across as many reads as it takes. Only a
    // read that returns 0 means there are no more bytes, and that is the one
    // case where the file really is shorter than its recorded length. Treating
    // any partial return as short_read reports corruption on a healthy file.
    let filled = 0;
    while (filled < toRead) {
      const bytesRead = readSync(fd, buffer, filled, toRead - filled, null);
      if (bytesRead === 0) {
        throw new ObjectStoreError(
          "short_read",
          `Short read on ${sourcePath}: expected ${toRead} bytes, got ${filled}.`,
        );
      }
      filled += bytesRead;
    }
    const chunk = buffer.subarray(0, toRead);
    const id = store.write("blob", chunk);
    fragments.push({ id, length: toRead });
    remaining -= toRead;
  }
  return fragments;
}

/**
 * Splits a buffer into fixed-size fragments and writes a manifest.
 *
 * This is the convenience path for content already in memory. The streaming
 * path for large files is {@link writeFragmentedFile}, which never holds more
 * than one fragment in memory at a time.
 *
 * @param store - Destination object store.
 * @param content - The content to fragment and store.
 * @param fragmentSize - Maximum bytes per fragment. Defaults to 1 MiB.
 * @returns The manifest id and the manifest.
 * @throws ObjectStoreError When the fragment size is not a positive integer.
 */
export function writeFragmented(
  store: ObjectStore,
  content: Buffer,
  fragmentSize: number = DEFAULT_FRAGMENT_SIZE,
): FragmentWriteResult {
  assertFragmentSize(fragmentSize, "invalid_fragment_size");
  const totalLength = content.length;
  const fragments: FragmentEntry[] = [];
  for (let offset = 0; offset < totalLength; offset += fragmentSize) {
    const end = Math.min(offset + fragmentSize, totalLength);
    const chunk = content.subarray(offset, end);
    const id = store.write("blob", chunk);
    fragments.push({ id, length: end - offset });
  }
  const manifest: FragmentManifest = { totalLength, fragments };
  const id = writeManifest(store, manifest);
  return { manifestId: id, manifest };
}

/**
 * Streams a file from disk into content-addressed fragments and writes a manifest.
 *
 * The source file is read through a file descriptor in fixed-size chunks — each
 * chunk is at most `fragmentSize` bytes — and written as a blob immediately.
 * The buffer is allocated once and reused for every chunk, so peak additional
 * heap is bounded by `fragmentSize` plus the manifest entry list, regardless of
 * how large the source file is. A multi-gigabyte file is therefore stored
 * within a fixed memory ceiling.
 *
 * @param store - Destination object store.
 * @param sourcePath - Absolute path to the file to read and fragment.
 * @param fragmentSize - Maximum bytes per fragment. Defaults to 1 MiB.
 * @returns The manifest id and the manifest.
 * @throws ObjectStoreError When the fragment size is not a positive integer, or
 *   a short read is encountered on the source file.
 */
export function writeFragmentedFile(
  store: ObjectStore,
  sourcePath: string,
  fragmentSize: number = DEFAULT_FRAGMENT_SIZE,
): FragmentWriteResult {
  assertFragmentSize(fragmentSize, "invalid_fragment_size");
  const fd = openSync(sourcePath, "r");
  try {
    // fstat the DESCRIPTOR, not the path. Measuring with statSync and then
    // opening leaves a window in which the path can be replaced, so the length
    // recorded in the manifest would describe a different file from the one
    // whose bytes are stored — a manifest that is internally consistent and
    // wrong. The descriptor names one file for its whole lifetime.
    const totalLength = fstatSync(fd).size;
    const fragments = writeFragmentsFromFd(store, fd, totalLength, fragmentSize, sourcePath);
    const manifest: FragmentManifest = { totalLength, fragments };
    const id = writeManifest(store, manifest);
    return { manifestId: id, manifest };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read one fragment's blob, proving its length matches what the manifest claims.
 *
 * A manifest records each fragment's id **and** its length, and the two are
 * stored separately. A manifest that names a real blob of a different size is
 * therefore representable, and every read path derives its arithmetic from the
 * recorded length: `readFragmented` concatenates to `totalLength`,
 * `readFragmentedToFile` writes whatever bytes it gets, and `readFragmentRange`
 * slices with `Math.min(fragment.length, ...)`. Left unchecked, a mismatch
 * silently truncates, zero-fills, or returns bytes from the wrong offset —
 * corruption that reads as success. Checking here makes it a typed error at the
 * one place every path already goes through.
 *
 * @param store - Source object store.
 * @param fragment - The manifest entry naming the blob and its expected length.
 * @returns The blob's bytes.
 * @throws ObjectStoreError When the stored blob's length differs from the manifest's.
 */
function readFragmentBlob(store: ObjectStore, fragment: FragmentEntry): Buffer {
  const data = store.readTyped(fragment.id, "blob");
  if (data.length !== fragment.length) {
    throw new ObjectStoreError(
      "fragment_length_mismatch",
      `fragment ${fragment.id} stores ${data.length} byte(s) but its manifest entry declares ${fragment.length}`,
    );
  }
  return data;
}

/**
 * Reads the full content of a fragmented file into a single buffer.
 *
 * This is the convenience path for small files. The streaming path for large
 * files is {@link readFragmentedToFile}, which never holds more than one
 * fragment in memory at a time.
 *
 * @param store - Source object store.
 * @param id - The manifest id.
 * @returns The reassembled content.
 * @throws ObjectStoreError When the manifest is absent, corrupt, or a fragment is missing.
 */
export function readFragmented(store: ObjectStore, id: ObjectId): Buffer {
  const manifest = readManifest(store, id);
  const parts: Buffer[] = [];
  for (const fragment of manifest.fragments) {
    parts.push(readFragmentBlob(store, fragment));
  }
  return Buffer.concat(parts, manifest.totalLength);
}

/**
 * Streams the full content of a fragmented file to a destination path.
 *
 * Each fragment is read from the store and written to the destination file
 * immediately, so only one fragment is in memory at a time. A multi-gigabyte
 * file is therefore restored within a fixed memory ceiling. The destination
 * is fsynced before the file descriptor is closed, so a crash after the
 * function returns leaves a complete file on disk.
 *
 * @param store - Source object store.
 * @param id - The manifest id.
 * @param destinationPath - Absolute path to write the reassembled content to.
 *   The file must not already exist.
 * @throws ObjectStoreError When the manifest is absent, corrupt, or a fragment is missing.
 */
export function readFragmentedToFile(
  store: ObjectStore,
  id: ObjectId,
  destinationPath: string,
): void {
  const manifest = readManifest(store, id);
  const fd = openSync(destinationPath, "wx");
  let complete = false;
  try {
    for (const fragment of manifest.fragments) {
      const data = readFragmentBlob(store, fragment);
      // writeSync returns the bytes actually written and is not guaranteed to
      // transfer the whole buffer in one call. Ignoring the return value
      // truncates the output on a short write while reporting success, which
      // for a restore path means silent corruption of the restored file.
      let written = 0;
      while (written < data.length) {
        written += writeSync(fd, data, written, data.length - written);
      }
    }
    fsyncSync(fd);
    complete = true;
  } finally {
    closeSync(fd);
    // A fragment read can throw partway through - a missing blob, or one whose
    // length disagrees with its manifest entry - and the bytes written before
    // that point are already on disk. Leaving them behind is worse than the
    // failure itself: the file looks like a restore, and a caller retrying
    // meets EEXIST from the exclusive open rather than a clean second attempt.
    // The destination only survives a run that completed.
    if (!complete) rmSync(destinationPath, { force: true });
  }
}

/**
 * Computes the fragments that overlap a byte range [start, end).
 *
 * @param manifest - The manifest whose fragments to scan.
 * @param start - Inclusive start offset.
 * @param end - Exclusive end offset.
 * @returns Fragments with their absolute offsets that overlap the range.
 */
function fragmentsInRange(
  manifest: FragmentManifest,
  start: number,
  end: number,
): readonly { fragment: FragmentEntry; offset: number }[] {
  const result: { fragment: FragmentEntry; offset: number }[] = [];
  let offset = 0;
  for (const fragment of manifest.fragments) {
    const fragStart = offset;
    const fragEnd = offset + fragment.length;
    if (fragEnd > start && fragStart < end) {
      result.push({ fragment, offset });
    }
    offset = fragEnd;
  }
  return result;
}

/**
 * Reads a byte range [start, end) from a fragmented file.
 *
 * Only the fragments whose byte ranges overlap [start, end) are read from
 * the store; non-overlapping fragments are never touched. Each overlapping
 * fragment is sliced to the requested range before being concatenated.
 *
 * @param store - Source object store.
 * @param id - The manifest id.
 * @param start - Inclusive start offset (zero-based).
 * @param end - Exclusive end offset.
 * @returns The bytes in [start, end).
 * @throws ObjectStoreError When the range is out of bounds (negative, inverted,
 *   or beyond the content length) or a fragment is missing.
 */
export function readFragmentRange(
  store: ObjectStore,
  id: ObjectId,
  start: number,
  end: number,
): Buffer {
  const manifest = readManifest(store, id);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new ObjectStoreError(
      "range_out_of_bounds",
      `Range [${start}, ${end}) is not a pair of integers.`,
    );
  }
  if (start < 0 || end < 0) {
    throw new ObjectStoreError(
      "range_out_of_bounds",
      `Range [${start}, ${end}) has a negative boundary.`,
    );
  }
  if (start > end) {
    throw new ObjectStoreError(
      "range_out_of_bounds",
      `Range [${start}, ${end}) is inverted: start exceeds end.`,
    );
  }
  if (start > manifest.totalLength || end > manifest.totalLength) {
    throw new ObjectStoreError(
      "range_out_of_bounds",
      `Range [${start}, ${end}) extends beyond the content length ${manifest.totalLength}.`,
    );
  }
  if (start === end) return Buffer.alloc(0);
  const overlapping = fragmentsInRange(manifest, start, end);
  const parts: Buffer[] = [];
  for (const { fragment, offset } of overlapping) {
    const data = readFragmentBlob(store, fragment);
    const sliceStart = Math.max(0, start - offset);
    const sliceEnd = Math.min(fragment.length, end - offset);
    parts.push(data.subarray(sliceStart, sliceEnd));
  }
  return Buffer.concat(parts, end - start);
}

/**
 * Computes the id a manifest would have for content split at a given fragment size,
 * without writing anything.
 *
 * @param content - The content that would be fragmented.
 * @param fragmentSize - Maximum bytes per fragment. Defaults to 1 MiB.
 * @returns The manifest id the content would be stored under.
 * @throws ObjectStoreError When the fragment size is not a positive integer.
 */
export function fragmentedContentId(
  content: Buffer,
  fragmentSize: number = DEFAULT_FRAGMENT_SIZE,
): ObjectId {
  assertFragmentSize(fragmentSize, "invalid_fragment_size");
  const fragments: FragmentEntry[] = [];
  for (let offset = 0; offset < content.length; offset += fragmentSize) {
    const end = Math.min(offset + fragmentSize, content.length);
    const chunk = content.subarray(offset, end);
    const id = hashObject("blob", chunk);
    fragments.push({ id, length: end - offset });
  }
  return computeManifestId({ totalLength: content.length, fragments });
}

// ─── Content-defined chunking ──────────────────────────────────────────────
//
// Fixed-size chunking has the boundary-shift problem: insert one byte at the
// front and every subsequent fixed-size chunk changes, so a one-byte edit
// rewrites the whole object. Content-defined chunking (CDC) picks boundaries
// from a rolling hash of the content, so an insertion perturbs only the chunks
// around it. The rest of the fragments are byte-identical to the original and
// are deduplicated automatically by the content-addressed store.
//
// Both modes coexist: fixed-size chunks make a byte-range read cheap because
// the fragment covering an offset is computable, while CDC chunks make an edit
// cheap because unaffected fragments are reused. The mode is recorded in the
// manifest so a reader does not have to infer it.

/**
 * Deterministic Gear hash table for content-defined chunking.
 *
 * A Gear hash (as used in FastCDC) updates a single 32-bit state per byte:
 * `hash = (hash << 1) + GEAR[byte]`. The table has 256 entries, one per byte
 * value, and must be the same on every machine for chunk boundaries to be
 * reproducible. It is generated from a fixed seed by a simple linear
 * congruential generator — no crypto, just spread — so the table is deterministic
 * across processes and the chunking of the same bytes always produces
 * byte-identical boundaries.
 */
const GEAR_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  let state = 0x243f6a88;
  for (let i = 0; i < 256; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    table[i] = state;
  }
  return table;
})();

/**
 * Default CDC parameters, justified by scripts/cdc-benchmark.ts.
 *
 * The benchmark measures reuse fraction under front/middle/end insertion,
 * store size, and write throughput across candidate parameters on a
 * reproducible 256 KiB corpus of pseudo-random bytes with a 64-byte edit.
 *
 * Results (reuse = fraction of original fragment ids present in the edited
 * manifest):
 * - 11-bit mask (112 fragments, ~2.3 KiB avg): 99.1% reuse, max 11 KiB
 * - 12-bit mask (50 fragments, ~5.2 KiB avg): 98.0% reuse, max 14 KiB
 * - 13-bit mask (20 fragments, ~13 KiB avg): 95.0% reuse, max 55 KiB
 * - 14-bit mask (11 fragments, ~24 KiB avg): 90.9% reuse, max 55 KiB
 *
 * Fixed-size control at 4 KiB: 0% reuse on front insertion (all fragments shift).
 *
 * The 13-bit mask gives the best reuse-vs-fragment-count tradeoff: 95% reuse
 * with only 20 fragments, vs 98% at 50 fragments (12-bit) - the extra 3% reuse
 * is not worth 2.5x the manifest entries. The 14-bit mask drops to 91% with
 * only 11 fragments, so the reuse loss is too steep.
 *
 * - minChunkSize = 512: prevents tiny fragments from inflating the manifest.
 *   Below 512, the 11-bit benchmark shows 112 fragments for 256 KiB - one entry
 *   per 2.3 KiB, which is excessive for a multi-gigabyte file.
 * - maxChunkSize = 65536 (64 KiB): bounds memory at one chunk per stream.
 *   The benchmark shows the largest chunk at 54661 bytes (under the cap),
 *   confirming the cap binds without being reached on normal content.
 * - mask = 0x1fff (13 bits): average chunk ~8 KiB, which gives ~20 fragments
 *   for 256 KiB and ~95% reuse on a front insertion.
 *
 * Run npm run benchmark:cdc to reproduce these numbers.
 */
export const DEFAULT_CDC_PARAMS: CdcParams = {
  minChunkSize: 512,
  maxChunkSize: 65536,
  mask: 0x1fff,
};

/**
 * Validates that CDC parameters are positive integers with min ≤ max and a
 * non-negative mask.
 *
 * @param params - Candidate CDC parameters.
 * @param code - Stable error code raised on rejection.
 * @throws ObjectStoreError When any parameter is not a positive integer, min
 *   exceeds max, or the mask is negative.
 */
function assertCdcParams(params: CdcParams, code: string): void {
  const { minChunkSize, maxChunkSize, mask } = params;
  if (!Number.isInteger(minChunkSize) || minChunkSize <= 0) {
    throw new ObjectStoreError(code, `CDC minChunkSize ${minChunkSize} is not a positive integer.`);
  }
  if (!Number.isInteger(maxChunkSize) || maxChunkSize <= 0) {
    throw new ObjectStoreError(code, `CDC maxChunkSize ${maxChunkSize} is not a positive integer.`);
  }
  if (minChunkSize > maxChunkSize) {
    throw new ObjectStoreError(code, `CDC minChunkSize ${minChunkSize} exceeds maxChunkSize ${maxChunkSize}.`);
  }
  if (!Number.isInteger(mask) || mask < 0) {
    throw new ObjectStoreError(code, `CDC mask ${mask} is not a non-negative integer.`);
  }
}

/**
 * Computes content-defined chunk boundaries for a buffer and returns the
 * fragment entries, without writing them to a store.
 *
 * Extracted from {@link writeCdcFragmented} so the CDC write path from a file
 * descriptor can share the boundary logic and so the pure computation can be
 * tested without a store. The `writeChunk` callback lets the caller choose
 * whether to write the blob to a store (for {@link writeCdcFragmented}) or only
 * compute its hash (for {@link cdcFragmentedContentId}).
 *
 * @param content - The content to chunk.
 * @param params - CDC parameters.
 * @param writeChunk - Called for each chunk; returns the blob id.
 * @returns The ordered fragment entries.
 */
function cdcBoundaries(
  content: Buffer,
  params: CdcParams,
  writeChunk: (chunk: Buffer) => ObjectId,
): FragmentEntry[] {
  const { minChunkSize, maxChunkSize, mask } = params;
  const fragments: FragmentEntry[] = [];
  let chunkStart = 0;
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 1) + GEAR_TABLE[content[i]!]!) | 0;
    const chunkLen = i - chunkStart + 1;
    if (chunkLen >= maxChunkSize || (chunkLen >= minChunkSize && (hash & mask) === 0)) {
      const chunk = content.subarray(chunkStart, i + 1);
      const id = writeChunk(chunk);
      fragments.push({ id, length: chunkLen });
      chunkStart = i + 1;
      hash = 0;
    }
  }
  if (chunkStart < content.length) {
    const chunk = content.subarray(chunkStart);
    const id = writeChunk(chunk);
    fragments.push({ id, length: content.length - chunkStart });
  }
  return fragments;
}

/**
 * Reads content from an open file descriptor through a rolling hash and writes
 * content-defined chunks as content-addressed blobs.
 *
 * The read buffer is allocated once and reused; the chunk accumulator is at
 * most `maxChunkSize` bytes. Peak additional heap is bounded by `maxChunkSize`
 * plus the read buffer, regardless of `totalLength`. Extracted from
 * {@link writeCdcFragmentedFile} so the short-read path can be exercised
 * directly with a file descriptor that has fewer bytes than declared.
 *
 * @param store - Destination object store.
 * @param fd - Open file descriptor to read from.
 * @param totalLength - Expected total content length in bytes.
 * @param params - CDC parameters.
 * @param sourcePath - Source path, used in error messages.
 * @returns The ordered fragment entries.
 * @throws ObjectStoreError When CDC parameters are invalid, or a short read is
 *   encountered on the source file.
 */
export function writeCdcFragmentsFromFd(
  store: ObjectStore,
  fd: number,
  totalLength: number,
  params: CdcParams,
  sourcePath: string,
): FragmentEntry[] {
  assertCdcParams(params, "invalid_cdc_params");
  if (!Number.isInteger(totalLength) || totalLength < 0) {
    throw new ObjectStoreError(
      "invalid_total_length",
      `Total length ${totalLength} is not a non-negative integer.`,
    );
  }
  const { minChunkSize, maxChunkSize, mask } = params;
  const readSize = Math.min(8192, maxChunkSize);
  const readBuf = Buffer.allocUnsafe(readSize);
  const chunkBuf = Buffer.allocUnsafe(maxChunkSize);
  const fragments: FragmentEntry[] = [];
  let chunkLen = 0;
  let hash = 0;
  let remaining = totalLength;

  while (remaining > 0) {
    const toRead = Math.min(readSize, remaining);
    let filled = 0;
    while (filled < toRead) {
      const bytesRead = readSync(fd, readBuf, filled, toRead - filled, null);
      if (bytesRead === 0) {
        throw new ObjectStoreError(
          "short_read",
          `Short read on ${sourcePath}: expected ${toRead} bytes, got ${filled}.`,
        );
      }
      filled += bytesRead;
    }

    for (let i = 0; i < filled; i++) {
      chunkBuf[chunkLen] = readBuf[i]!;
      chunkLen++;
      hash = ((hash << 1) + GEAR_TABLE[readBuf[i]!]!) | 0;
      if (chunkLen >= maxChunkSize || (chunkLen >= minChunkSize && (hash & mask) === 0)) {
        const chunk = chunkBuf.subarray(0, chunkLen);
        const id = store.write("blob", chunk);
        fragments.push({ id, length: chunkLen });
        chunkLen = 0;
        hash = 0;
      }
    }
    remaining -= filled;
  }

  if (chunkLen > 0) {
    const chunk = chunkBuf.subarray(0, chunkLen);
    const id = store.write("blob", chunk);
    fragments.push({ id, length: chunkLen });
  }
  return fragments;
}

/**
 * Splits a buffer into content-defined fragments and writes a manifest.
 *
 * This is the convenience path for content already in memory. The streaming
 * path for large files is {@link writeCdcFragmentedFile}, which never holds more
 * than one chunk in memory at a time.
 *
 * @param store - Destination object store.
 * @param content - The content to chunk and store.
 * @param params - CDC parameters. Defaults to {@link DEFAULT_CDC_PARAMS}.
 * @returns The manifest id and the manifest.
 * @throws ObjectStoreError When CDC parameters are invalid.
 */
export function writeCdcFragmented(
  store: ObjectStore,
  content: Buffer,
  params: CdcParams = DEFAULT_CDC_PARAMS,
): FragmentWriteResult {
  assertCdcParams(params, "invalid_cdc_params");
  const fragments = cdcBoundaries(content, params, (chunk) => store.write("blob", chunk));
  const manifest: FragmentManifest = { totalLength: content.length, fragments, mode: "cdc" };
  const id = writeManifest(store, manifest);
  return { manifestId: id, manifest };
}

/**
 * Streams a file from disk into content-defined fragments and writes a manifest.
 *
 * The source file is read through a file descriptor in small chunks, a rolling
 * hash determines content-defined boundaries, and each chunk is written as a
 * blob immediately. The chunk accumulator is at most `maxChunkSize` bytes, so
 * peak additional heap is bounded regardless of the source file size.
 *
 * @param store - Destination object store.
 * @param sourcePath - Absolute path to the file to read and chunk.
 * @param params - CDC parameters. Defaults to {@link DEFAULT_CDC_PARAMS}.
 * @returns The manifest id and the manifest.
 * @throws ObjectStoreError When CDC parameters are invalid, or a short read is
 *   encountered on the source file.
 */
export function writeCdcFragmentedFile(
  store: ObjectStore,
  sourcePath: string,
  params: CdcParams = DEFAULT_CDC_PARAMS,
): FragmentWriteResult {
  assertCdcParams(params, "invalid_cdc_params");
  const fd = openSync(sourcePath, "r");
  try {
    const totalLength = fstatSync(fd).size;
    const fragments = writeCdcFragmentsFromFd(store, fd, totalLength, params, sourcePath);
    const manifest: FragmentManifest = { totalLength, fragments, mode: "cdc" };
    const id = writeManifest(store, manifest);
    return { manifestId: id, manifest };
  } finally {
    closeSync(fd);
  }
}

/**
 * Computes the id a content-defined manifest would have for content chunked
 * with the given parameters, without writing anything.
 *
 * @param content - The content that would be chunked.
 * @param params - CDC parameters. Defaults to {@link DEFAULT_CDC_PARAMS}.
 * @returns The manifest id the content would be stored under.
 * @throws ObjectStoreError When CDC parameters are invalid.
 */
export function cdcFragmentedContentId(
  content: Buffer,
  params: CdcParams = DEFAULT_CDC_PARAMS,
): ObjectId {
  assertCdcParams(params, "invalid_cdc_params");
  const fragments = cdcBoundaries(content, params, (chunk) => hashObject("blob", chunk));
  return computeManifestId({ totalLength: content.length, fragments, mode: "cdc" });
}