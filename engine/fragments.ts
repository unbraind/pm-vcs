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
  fsyncSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";

import {
  hashObject,
  type ObjectId,
  ObjectStoreError,
  type ObjectStore,
} from "./objects.ts";
import {
  type FragmentEntry,
  type FragmentManifest,
  type FragmentWriteResult,
  manifestId as computeManifestId,
  readManifest,
  writeManifest,
} from "./model.ts";

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
  const fragments: FragmentEntry[] = [];
  const buffer = Buffer.allocUnsafe(fragmentSize);
  let remaining = totalLength;
  while (remaining > 0) {
    const toRead = Math.min(fragmentSize, remaining);
    const bytesRead = readSync(fd, buffer, 0, toRead, null);
    if (bytesRead !== toRead) {
      throw new ObjectStoreError(
        "short_read",
        `Short read on ${sourcePath}: expected ${toRead} bytes, got ${bytesRead}.`,
      );
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
  const totalLength = statSync(sourcePath).size;
  const fd = openSync(sourcePath, "r");
  try {
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
  try {
    for (const fragment of manifest.fragments) {
      const data = readFragmentBlob(store, fragment);
      writeSync(fd, data);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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