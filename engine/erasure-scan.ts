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
export type ErasureFileClass = "object-root" | "loose-storage" | "pack-storage" | "temporary-storage" | "foreign-directory" | "verification-metadata";
/** Complete physical scan receipt, including harmless foreign files rather than silently skipping them. */
export interface ErasureStorageReport { readonly files: number; readonly foreign: number; readonly classes: Readonly<Partial<Record<ErasureFileClass, number>>> }
/** Typed refusal includes a storage class and a remedy, without copying potentially sensitive filenames. */
export class ErasureStorageRefusal extends ObjectStoreError {
  /** Stable SDK discriminator for retained bytes or an incomplete physical proof. */
  override readonly code: "erasure_retained_copy" | "unsupported_erasure_storage" | "uninspectable_payload";
  /** Class containing retained bytes, unreadable storage, or an unstable scan. */
  readonly fileClass: ErasureFileClass;
  /** Explicit cleanup remains the foreign owner's responsibility. */
  readonly remedy = "Remove the explicit retained copy or restore stable readable storage, then retry authorized obliteration.";
  /** Construct a safe refusal instead of issuing a physical-erasure success receipt. */
  constructor(code: "erasure_retained_copy" | "unsupported_erasure_storage" | "uninspectable_payload", fileClass: ErasureFileClass) {
    super(code, `Physical erasure verification failed for ${fileClass}. Remove the explicit retained copy or restore stable readable storage, then retry authorized obliteration.`);
    this.name = "ErasureStorageRefusal"; this.code = code; this.fileClass = fileClass;
  }
}
/** Write/crash and storage-scan observations run inside the existing owning erasure lease. @internal */
export const erasureScanBoundary: { visit(step: string): void } = { visit() {} };
/** Forced decode-budget seam; ordinary scans allow six passes at the maximum DEFLATE expansion ratio. @internal */
export const erasureScanLimits = { minimum: 16 * 1024 * 1024, ratio: 1032 * 6, depth: 6, streams: 32, contexts: 512, wordBytes: 16 * 1024 * 1024 };
/** Produce a compact signature for one nonempty exact byte sequence. */
export function fingerprint(bytes: Buffer): ErasureFingerprint {
  let rolling = 0;
  for (const byte of bytes) rolling = (Math.imul(rolling, 257) + byte + 1) >>> 0;
  return { length: bytes.length, rolling: bytes.length <= 4 ? 0 : rolling, digest: createHash("sha256").update(bytes).digest("hex") };
}
/** Versioned private journal binds all lookup signatures to one checksum, without retaining payload bytes. */
export interface ErasureFingerprintJournal {
  readonly format: "pm-vcs-erasure-byteproof-1";
  readonly records: Readonly<Record<string, readonly ErasureFingerprint[]>>;
  readonly checksum: string;
}
/** Wrap trusted signatures in the exact package-written journal format. @internal */
export function fingerprintJournal(records: Readonly<Record<string, readonly ErasureFingerprint[]>>): ErasureFingerprintJournal {
  return { format: "pm-vcs-erasure-byteproof-1", records, checksum: createHash("sha256").update(JSON.stringify(records)).digest("hex") };
}
/** Reject unknown formats and checksum damage before any signature can influence a physical certificate. */
export function readFingerprints(value: unknown): Record<string, ErasureFingerprint[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ErasureStorageRefusal("unsupported_erasure_storage", "verification-metadata");
  const journal = value as ErasureFingerprintJournal;
  if (Object.keys(journal).sort().join(",") !== "checksum,format,records" || journal.format !== "pm-vcs-erasure-byteproof-1"
    || journal.records === null || typeof journal.records !== "object" || Array.isArray(journal.records)
    || typeof journal.checksum !== "string" || !/^[0-9a-f]{64}$/.test(journal.checksum)
    || fingerprintJournal(journal.records).checksum !== journal.checksum) throw new ErasureStorageRefusal("unsupported_erasure_storage", "verification-metadata");
  for (const [id, entries] of Object.entries(journal.records)) {
    if (!/^[0-9a-f]{64}$/.test(id) || !Array.isArray(entries) || entries.some((entry: unknown) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return true;
      const item = entry as ErasureFingerprint;
      return Object.keys(item).sort().join(",") !== "digest,length,rolling" || !Number.isSafeInteger(item.length) || item.length <= 0
        || !Number.isInteger(item.rolling) || item.rolling < 0 || item.rolling > 0xffff_ffff || typeof item.digest !== "string" || !/^[0-9a-f]{64}$/.test(item.digest);
    })) throw new ErasureStorageRefusal("unsupported_erasure_storage", "verification-metadata");
  }
  return journal.records as Record<string, ErasureFingerprint[]>;
}
/** Rolling windows retain only bounded scanner input; SHA-256 confirms every fast-hash candidate. */
class Matcher {
  private ring = Buffer.alloc(0);
  private readonly maximum: number;
  private readonly groups: { length: number; power: number; hashes: Map<number, Set<string>>; rolling: number }[] = [];
  private count = 0;
  /** Compile reusable length groups; zero-length payloads are represented by their nonempty typed frames. */
  constructor(patterns: readonly ErasureFingerprint[], template?: Matcher) {
    this.maximum = patterns.reduce((maximum, pattern) => Math.max(maximum, pattern.length), 1);
    if (template !== undefined) { this.groups.push(...template.groups.map((group) => ({ ...group, rolling: 0 }))); return; }
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
  /** Inspect all windows, including matches crossing source/decompression chunk boundaries. */
  feed(bytes: Uint8Array): boolean {
    const needed = Math.min(this.maximum, this.count + bytes.length);
    if (needed > this.ring.length) {
      const grown = Buffer.alloc(Math.min(this.maximum, Math.max(needed, this.ring.length * 2)));
      this.ring.copy(grown); this.ring = grown;
    }
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
/** One file shares decode accounting and a terminal hit across all nested representations. */
interface InspectionState { remaining: number; hit: boolean; blocked: boolean; live: number }
/** Each native zlib context owns its output inspector until completion, cancellation or fault. */
interface Codec { stream: ZStream; output: Uint8Array<ArrayBuffer>; child: EncodedInspector }
/** Bounded streaming inspection composes embedded zlib and canonical/partial base64 at arbitrary offsets. */
class EncodedInspector {
  private readonly patterns: readonly ErasureFingerprint[];
  private readonly state: InspectionState;
  private readonly kind: ErasureFileClass;
  private readonly depth: number;
  private readonly matcher: Matcher;
  private readonly template: Matcher;
  private readonly codecs: Codec[] = [];
  private previous = -1;
  private word = "";
  private skipWord = false;
  /** Reuse immutable matcher tables; lazy windows grow only with actually observed bytes. */
  constructor(patterns: readonly ErasureFingerprint[], state: InspectionState, kind: ErasureFileClass, depth = 0, template?: Matcher) {
    this.patterns = patterns; this.state = state; this.kind = kind; this.depth = depth;
    this.matcher = new Matcher(patterns, template); this.template = template ?? this.matcher; state.live++;
  }
  /** Reject excessive supported encodings rather than certifying their uninspected remainder. */
  private child(): EncodedInspector | undefined {
    if (this.depth >= erasureScanLimits.depth || this.state.live >= erasureScanLimits.contexts) { this.state.blocked = true; return undefined; }
    return new EncodedInspector(this.patterns, this.state, this.kind, this.depth + 1, this.template);
  }
  /** Decode complete words in all four alignments, so an alphabetic prefix cannot hide an embedded encoding. */
  private endWord(): void {
    const word = this.word; this.word = "";
    if (this.skipWord) { this.skipWord = false; return; }
    for (let phase = 0; phase < Math.min(4, word.length); phase++) {
      const encoded = word.slice(phase); if (encoded.length < 2) continue;
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length === 0) continue;
      // Fewer than four bytes cannot contain a zlib payload; further base64 only shrinks them.
      if (bytes.length < 4 && !this.patterns.some((pattern) => pattern.length <= bytes.length)) continue;
      const child = this.child(); if (child === undefined) continue;
      try { child.feed(bytes); child.finish(); } finally { child.close(); }
      if (this.state.hit) return;
    }
  }
  /** Close each dictionary exactly once, even when a deeper inspection refuses or finds a copy. */
  private closeCodec(codec: Codec): void {
    try { codec.child.close(); } finally { zlibInflateEnd(codec.stream); }
  }
  /** Inspect output before accepting end/error status, retaining bytes recoverable despite a bad checksum. */
  private push(codec: Codec, bytes: Uint8Array): boolean {
    codec.stream.input = Uint8Array.from(bytes); codec.stream.next_in = 0; codec.stream.avail_in = bytes.length;
    do {
      codec.stream.output = codec.output; codec.stream.next_out = 0; codec.stream.avail_out = codec.output.length;
      const status = zlibInflate(codec.stream, Z_SYNC_FLUSH);
      codec.child.feed(codec.output.subarray(0, codec.stream.next_out));
      if (this.state.hit || (status !== Z_OK && status !== Z_BUF_ERROR)) {
        codec.child.finish(); this.closeCodec(codec); return true;
      }
    } while (codec.stream.avail_in > 0 || codec.stream.avail_out === 0);
    return false;
  }
  /** Consume source or decoded slots; no namespace lookup or unbounded object materialization occurs here. */
  feed(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.state.hit) return;
    this.state.remaining -= bytes.length;
    if (this.state.remaining < 0) throw new ErasureStorageRefusal("unsupported_erasure_storage", this.kind);
    if (this.matcher.feed(bytes)) { this.state.hit = true; return; }
    for (const codec of [...this.codecs]) if (this.push(codec, bytes)) this.codecs.splice(this.codecs.indexOf(codec), 1);
    if (this.state.hit) return;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (this.previous >= 0 && (this.previous & 15) === 8 && (this.previous >> 4) <= 7 && ((this.previous << 8) + byte) % 31 === 0) {
        if (this.codecs.length >= erasureScanLimits.streams) this.state.blocked = true;
        else {
          const child = this.child();
          if (child !== undefined) {
            const stream = new ZStream(); zlibInflateInit2(stream, 15);
            const codec: Codec = { stream, output: new Uint8Array(16_384), child }; this.codecs.push(codec);
            const input = i === 0 ? Buffer.concat([Buffer.from([this.previous]), bytes]) : bytes.subarray(i - 1);
            if (this.push(codec, input)) this.codecs.splice(this.codecs.indexOf(codec), 1);
          }
        }
      }
      this.previous = byte; if (this.state.hit) return;
    }
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1"); let end = 0;
    for (const match of text.matchAll(/[A-Za-z0-9+/]+={0,2}/g)) {
      if (match.index > end) this.endWord();
      if (!this.skipWord) {
        if (this.word.length + match[0].length > erasureScanLimits.wordBytes) { this.state.blocked = true; this.skipWord = true; this.word = ""; }
        else this.word += match[0];
      }
      end = match.index + match[0].length;
      if (match[0].endsWith("=")) this.endWord();
      if (this.state.hit) return;
    }
    if (end < text.length) this.endWord();
  }
  /** Flush final partial words and recoverable truncated streams before making a no-copy decision. */
  finish(): void {
    this.endWord();
    while (this.codecs.length > 0) {
      const codec = this.codecs.shift()!;
      try { codec.child.finish(); } finally { this.closeCodec(codec); }
    }
  }
  /** Release all remaining dictionaries on early hit, exception or normal completion. */
  close(): void {
    for (const codec of this.codecs) this.closeCodec(codec);
    this.codecs.length = 0; this.state.live--;
  }
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
        const size = Number(before.size);
        const input = Buffer.alloc(65_536); let offset = 0;
        const state: InspectionState = { remaining: Math.max(erasureScanLimits.minimum, size * erasureScanLimits.ratio), hit: false, blocked: false, live: 0 };
        const inspector = new EncodedInspector(patterns, state, kind);
        try {
          erasureScanBoundary.visit("file-opened");
          while (offset < size) {
            const count = readSync(file.fd, input, 0, Math.min(input.length, size - offset), offset);
            if (count === 0) throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
            const bytes = input.subarray(0, count);
            inspector.feed(bytes);
            if (state.hit) throw new ErasureStorageRefusal("erasure_retained_copy", kind);
            offset += count; erasureScanBoundary.visit("file-chunk");
          }
          inspector.finish();
          if (state.hit) throw new ErasureStorageRefusal("erasure_retained_copy", kind);
          if (state.blocked) throw new ErasureStorageRefusal("uninspectable_payload", kind);
        } finally { inspector.close(); }
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
