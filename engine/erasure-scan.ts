/** Name-independent, resumable proof that owned object storage contains no selected payload representation. */
import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { ZStream, zlibInflateInit2, zlibInflate, zlibInflateEnd, Z_SYNC_FLUSH, Z_OK, Z_BUF_ERROR } from "pako";
import { objectFiles } from "./object-files.ts";
import { ObjectStoreError } from "./object-error.ts";

/** Persist only lengths and byte-window hashes, never selected content. */
export interface ErasureFingerprint { readonly length: number; readonly rolling: number; readonly digest: string }
/** Receipts classify storage without disclosing names or content. */
export type ErasureFileClass = "object-root" | "loose-storage" | "pack-storage" | "temporary-storage" | "foreign-directory";
/** Complete physical scan receipt, including harmless foreign files rather than silently skipping them. */
export interface ErasureStorageReport { readonly files: number; readonly foreign: number; readonly classes: Readonly<Partial<Record<ErasureFileClass, number>>> }
/** Typed refusal includes a storage class and a remedy, without copying potentially sensitive filenames. */
export class ErasureStorageRefusal extends ObjectStoreError {
  /** Stable SDK discriminator for retained bytes or an incomplete physical proof. */
  override readonly code: "erasure_retained_copy" | "unsupported_erasure_storage";
  /** Class containing retained bytes, unreadable storage, or an unstable scan. */
  readonly fileClass: ErasureFileClass;
  /** Explicit cleanup remains the foreign owner's responsibility. */
  readonly remedy = "Remove the explicit retained copy or restore stable readable storage, then retry authorized obliteration.";
  /** Construct a safe refusal instead of issuing a physical-erasure success receipt. */
  constructor(code: "erasure_retained_copy" | "unsupported_erasure_storage", fileClass: ErasureFileClass) {
    super(code, `Physical erasure verification failed for ${fileClass}. Remove the explicit retained copy or restore stable readable storage, then retry authorized obliteration.`);
    this.name = "ErasureStorageRefusal"; this.code = code; this.fileClass = fileClass;
  }
}
/** Write/crash and storage-scan observations run inside the existing owning erasure lease. @internal */
export const erasureScanBoundary: { visit(step: string): void } = { visit() {} };
/** Forced decode-budget seam; ordinary scans allow six passes at the maximum DEFLATE expansion ratio. @internal */
export const erasureScanLimits = { minimum: 16 * 1024 * 1024, ratio: 1032 * 6 };
/** Produce a compact signature for one nonempty exact byte sequence. */
export function fingerprint(bytes: Buffer): ErasureFingerprint {
  let rolling = 0;
  for (const byte of bytes) rolling = (Math.imul(rolling, 257) + byte + 1) >>> 0;
  return { length: bytes.length, rolling: bytes.length <= 4 ? 0 : rolling, digest: createHash("sha256").update(bytes).digest("hex") };
}
/** Validate package-written proof metadata before using or extending it. */
export function readFingerprints(value: unknown): Record<string, ErasureFingerprint[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ObjectStoreError("unsupported_erasure_storage", "Erasure verification metadata is foreign or invalid; restore its package-written records before retrying.");
  for (const [id, entries] of Object.entries(value)) {
    if (!/^[0-9a-f]{64}$/.test(id) || !Array.isArray(entries) || entries.some((entry: unknown) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return true;
      const item = entry as ErasureFingerprint;
      return Object.keys(item).sort().join(",") !== "digest,length,rolling" || !Number.isSafeInteger(item.length) || item.length <= 0
        || !Number.isInteger(item.rolling) || item.rolling < 0 || item.rolling > 0xffff_ffff || typeof item.digest !== "string" || !/^[0-9a-f]{64}$/.test(item.digest);
    })) throw new ObjectStoreError("unsupported_erasure_storage", "Erasure verification metadata is foreign or invalid; restore its package-written records before retrying.");
  }
  return value as Record<string, ErasureFingerprint[]>;
}
/** Rolling windows retain only bounded scanner input; SHA-256 confirms every fast-hash candidate. */
class Matcher {
  private readonly ring: Buffer;
  private readonly groups: { length: number; power: number; hashes: Map<number, Set<string>>; rolling: number }[] = [];
  private count = 0;
  /** Compile reusable length groups; zero-length payloads are represented by their nonempty typed frames. */
  constructor(patterns: readonly ErasureFingerprint[]) {
    this.ring = Buffer.alloc(patterns.reduce((maximum, pattern) => Math.max(maximum, pattern.length), 1));
    for (const pattern of patterns) {
      let group = this.groups.find((item) => item.length === pattern.length);
      if (group === undefined) {
        let power = 1; for (let i = 1; i < pattern.length; i++) power = Math.imul(power, 257) >>> 0;
        group = { length: pattern.length, power, hashes: new Map(), rolling: 0 }; this.groups.push(group);
      }
      let digests = group.hashes.get(pattern.rolling);
      if (digests === undefined) { digests = new Set(); group.hashes.set(pattern.rolling, digests); }
      digests.add(pattern.digest);
    }
  }
  /** Reuse allocated windows for the next embedded compressed candidate. */
  reset(): void { this.count = 0; for (const group of this.groups) group.rolling = 0; }
  /** Inspect all windows, including matches crossing source/decompression chunk boundaries. */
  feed(bytes: Uint8Array): boolean {
    for (const byte of bytes) {
      for (const group of this.groups) {
        const old = this.count >= group.length ? this.ring[(this.count - group.length) % this.ring.length] + 1 : 0;
        group.rolling = (Math.imul(group.rolling - Math.imul(old, group.power), 257) + byte + 1) >>> 0;
      }
      this.ring[this.count % this.ring.length] = byte; this.count++;
      for (const group of this.groups) {
        if (this.count < group.length) continue;
        // Short sequences use SHA-only matching; their polynomial value would directly encode their bytes.
        const candidates = group.hashes.get(group.length <= 4 ? 0 : group.rolling); if (candidates === undefined) continue;
        const start = (this.count - group.length) % this.ring.length;
        const hash = createHash("sha256");
        const end = Math.min(this.ring.length, start + group.length);
        hash.update(this.ring.subarray(start, end));
        if (end - start < group.length) hash.update(this.ring.subarray(0, group.length - (end - start)));
        if (candidates.has(hash.digest("hex"))) return true;
      }
    }
    return false;
  }
}
/** Inspect an already observed representation using the same persisted byte-window proof. */
export function matchesFingerprints(bytes: Buffer, patterns: readonly ErasureFingerprint[]): boolean { return new Matcher(patterns).feed(bytes); }
/** Classify without exposing arbitrary names; unknown names remain foreign regardless of their decodable contents. */
function classify(parts: readonly string[]): { kind: ErasureFileClass; foreign: boolean } {
  const leaf = parts[parts.length - 1] ?? "";
  const knownLoose = parts.length === 2 && /^[0-9a-f]{2}$/.test(parts[0]) && /^[0-9a-f]{62}(?:\.[0-9]+\.[0-9a-f]{12}\.tmp)?$/.test(leaf);
  const knownPack = parts.length === 2 && parts[0] === "packs" && /^[0-9a-f]{64}\.pack$/.test(leaf);
  const kind = leaf.endsWith(".tmp") ? "temporary-storage" : parts[0] === "packs" ? "pack-storage" : parts.length <= 1 ? "object-root" : /^[0-9a-f]{2}$/.test(parts[0]) ? "loose-storage" : "foreign-directory";
  return { kind, foreign: !knownLoose && !knownPack };
}
/** Search every embedded zlib stream, independent of pack indexes, magic, filenames, checksums or trailing truncation. */
function compressedHit(fd: number, start: number, size: number, matcher: Matcher, budget: { remaining: number }, kind: ErasureFileClass): boolean {
  matcher.reset(); const stream = new ZStream();
  zlibInflateInit2(stream, 15);
  const input = Buffer.alloc(64); const output = Buffer.alloc(16_384); let offset = start;
  try {
    while (offset < size) {
      const count = readSync(fd, input, 0, Math.min(input.length, size - offset), offset);
      if (count === 0) throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
      offset += count; stream.input = input.subarray(0, count); stream.next_in = 0; stream.avail_in = count;
      let status: number;
      do {
        stream.output = output; stream.next_out = 0; stream.avail_out = output.length;
        status = zlibInflate(stream, Z_SYNC_FLUSH);
        // Inspect output even on checksum/truncation faults: those bytes remain recoverable.
        budget.remaining -= stream.next_out;
        if (budget.remaining < 0) throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
        if (matcher.feed(output.subarray(0, stream.next_out))) return true;
        if (status !== Z_OK && status !== Z_BUF_ERROR) return false;
      } while (stream.avail_in > 0 || stream.avail_out === 0);
    }
    return false;
  } finally { zlibInflateEnd(stream); }

}
/** Independently scan all regular storage files; callers hold the package writer lease throughout deletion and this final proof. */
export function scanErasureStorage(root: string, patterns: readonly ErasureFingerprint[], excluded: ReadonlySet<string> = new Set()): ErasureStorageReport {
  const classes: Partial<Record<ErasureFileClass, number>> = {}; let files = 0; let foreign = 0;
  /** Descend real directories only, including arbitrary foreign and temporary subdirectories. */
  const walk = (directory: string, parts: string[]): void => {
    if (!lstatSync(directory).isDirectory()) throw new ErasureStorageRefusal("unsupported_erasure_storage", classify(parts).kind);
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name); const names = [...parts, entry.name];
      if (entry.isDirectory()) { walk(path, names); continue; }
      const { kind, foreign: isForeign } = classify(names);
      if (!entry.isFile()) throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
      if (excluded.has(path)) continue;
      let file: ReturnType<typeof objectFiles.open> | undefined;
      try {
        file = objectFiles.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(file.fd, { bigint: true });
        if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
        const size = Number(before.size); const raw = new Matcher(patterns); const decoded = new Matcher(patterns);
        const input = Buffer.alloc(65_536); let offset = 0; let previous = -1;
        const budget = { remaining: Math.max(erasureScanLimits.minimum, size * erasureScanLimits.ratio) };
        erasureScanBoundary.visit("file-opened");
        while (offset < size) {
          const count = readSync(file.fd, input, 0, Math.min(input.length, size - offset), offset);
          if (count === 0) throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
          const bytes = input.subarray(0, count);
          if (raw.feed(bytes)) throw new ErasureStorageRefusal("erasure_retained_copy", kind);
          for (let i = 0; i < bytes.length; i++) {
            const byte = bytes[i];
            if (previous >= 0 && (previous & 15) === 8 && (previous >> 4) <= 7 && ((previous << 8) + byte) % 31 === 0
              && compressedHit(file.fd, offset + i - 1, size, decoded, budget, kind)) throw new ErasureStorageRefusal("erasure_retained_copy", kind);
            previous = byte;
          }
          offset += count; erasureScanBoundary.visit("file-chunk");
        }
        const after = fstatSync(file.fd, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
        files++; if (isForeign) foreign++; classes[kind] = (classes[kind] ?? 0) + 1;
        erasureScanBoundary.visit("file-verified");
      } catch (error) {
        if (error instanceof ErasureStorageRefusal) throw error;
        throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
      } finally { file?.close(); }
    }
    const names = entries.map((entry) => `${entry.name}:${entry.isDirectory()}`).sort();
    const current = readdirSync(directory, { withFileTypes: true }).map((entry) => `${entry.name}:${entry.isDirectory()}`).sort();
    if (JSON.stringify(names) !== JSON.stringify(current)) throw new ErasureStorageRefusal("unsupported_erasure_storage", classify(parts).kind);
  };
  walk(root, []); return { files, foreign, classes };
}
