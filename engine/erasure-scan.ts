/** Name-independent, resumable proof that owned object storage contains no selected payload representation. */
import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { ZStream, zlibInflateInit2, zlibInflate, zlibInflateEnd, Z_SYNC_FLUSH, Z_STREAM_END, Z_OK, Z_BUF_ERROR } from "pako";
import { objectFiles } from "./object-files.ts";
import { ObjectStoreError, VerificationRefusal } from "./object-error.ts";

/** Persist only lengths and byte-window hashes, never selected content. */
export interface ErasureFingerprint { readonly length: number; readonly rolling: number; readonly digest: string }
/** Receipts classify storage without disclosing names or content. */
export type ErasureFileClass = "object-root" | "loose-storage" | "pack-storage" | "temporary-storage" | "foreign-directory" | "verification-metadata";
/** Complete physical scan receipt, including harmless foreign files rather than silently skipping them. */
export interface ErasureStorageReport { readonly accountable?: true; readonly objects?: number; readonly diagnostic?: string; readonly files: number; readonly foreign: number; readonly classes: Readonly<Partial<Record<ErasureFileClass, number>>> }
/** Typed refusal includes a storage class and a remedy, without copying potentially sensitive filenames. */
export class ErasureStorageRefusal extends ObjectStoreError {
  /** Stable SDK discriminator for retained bytes or an incomplete physical proof. */
  override readonly code: "unverifiable" | "erasure_retained_copy" | "unsupported_erasure_storage" | "uninspectable_payload";
  /** Class containing retained bytes, unreadable storage, or an unstable scan. */
  readonly fileClass: ErasureFileClass;
  /** Explicit cleanup remains the foreign owner's responsibility. */
  readonly remedy: string;
  /** Construct a safe refusal instead of issuing a physical-erasure success receipt. */
  constructor(code: "unverifiable" | "erasure_retained_copy" | "unsupported_erasure_storage" | "uninspectable_payload", fileClass: ErasureFileClass) {
    super(code, code === "unverifiable" ? `Object storage is unverifiable for ${fileClass}. Restore a complete native representation or explicitly retry with --purge-unaccounted; selected files are receipted and storage is re-verified.` : `Physical erasure verification failed for ${fileClass}. Remove the explicit retained copy or restore stable readable storage, then retry authorized obliteration.`);
    this.name = "ErasureStorageRefusal"; this.code = code; this.fileClass = fileClass;
    this.remedy = code === "unverifiable" ? "Restore complete native storage or retry with --purge-unaccounted to remove exactly the unaccounted files and re-verify." : "Remove the explicit retained copy or restore stable readable storage, then retry authorized obliteration.";
  }
}
/** Write/crash and storage-scan observations run inside the existing owning erasure lease. @internal */
export const erasureScanBoundary: { visit(step: string): void } = { visit() {} };
/** Forced decode-budget seam; ordinary scans allow six passes at the maximum DEFLATE expansion ratio. @internal */
export const erasureScanLimits = { minimum: 16 * 1024 * 1024, ratio: 1032 * 6, depth: 6, streams: 32, contexts: 512, wordBytes: 16 * 1024 * 1024 };
/** Use one bounded suffix filter and a full SHA-256 proof, independent of the number of pattern lengths. */
export function fingerprint(bytes: Buffer): ErasureFingerprint {
  let rolling = 0;
  for (const byte of bytes.subarray(-8)) rolling = (Math.imul(rolling, 257) + byte + 1) >>> 0;
  return { length: bytes.length, rolling: bytes.length <= 4 ? 0 : rolling, digest: createHash("sha256").update(bytes).digest("hex") };
}
/** Versioned private journal binds all lookup signatures to one checksum, without retaining payload bytes. */
export interface ErasureFingerprintJournal {
  readonly format: "pm-vcs-erasure-byteproof-2";
  readonly records: Readonly<Record<string, readonly ErasureFingerprint[]>>;
  readonly checksum: string;
}
/** Wrap trusted signatures in the exact package-written journal format. @internal */
export function fingerprintJournal(records: Readonly<Record<string, readonly ErasureFingerprint[]>>): ErasureFingerprintJournal {
  return { format: "pm-vcs-erasure-byteproof-2", records, checksum: createHash("sha256").update(JSON.stringify(records)).digest("hex") };
}
/** Reject unknown formats and checksum damage before any signature can influence a physical certificate. */
export function readFingerprints(value: unknown): Record<string, ErasureFingerprint[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ErasureStorageRefusal("unsupported_erasure_storage", "verification-metadata");
  const journal = value as ErasureFingerprintJournal;
  if (Object.keys(journal).sort().join(",") !== "checksum,format,records" || journal.format !== "pm-vcs-erasure-byteproof-2"
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
  private readonly groups: { width: number; power: number; hashes: Map<number, ErasureFingerprint[]>; rolling: number }[] = [];
  private count = 0;
  private lastByte = -1;
  private constantRun = 0;
  /** Compile bounded suffix groups; zero-length payloads use their nonempty typed frames. */
  constructor(patterns: readonly ErasureFingerprint[], template?: Matcher) {
    this.maximum = patterns.reduce((maximum, pattern) => Math.max(maximum, pattern.length), 1);
    if (template !== undefined) { this.groups.push(...template.groups.map((group) => ({ ...group, rolling: 0 }))); return; }
    for (const pattern of patterns) {
      const width = Math.min(8, pattern.length);
      let group = this.groups.find((item) => item.width === width);
      if (group === undefined) {
        let power = 1; for (let i = 1; i < width; i++) power = Math.imul(power, 257) >>> 0;
        group = { width, power, hashes: new Map(), rolling: 0 }; this.groups.push(group);
      }
      let candidates = group.hashes.get(pattern.rolling);
      if (candidates === undefined) { candidates = []; group.hashes.set(pattern.rolling, candidates); }
      candidates.push(pattern);
    }
  }
  /** Inspect all windows, including matches crossing source/decompression chunk boundaries. */
  feed(bytes: Uint8Array): boolean {
    const first = bytes[0];
    const uniform = bytes.length > 8 && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(Buffer.alloc(bytes.length, first));
    // Once a complete maximum-length window is constant, every remaining window is identical.
    const inspect = uniform ? Math.min(bytes.length, Math.max(1, this.maximum - (this.lastByte === first ? this.constantRun : 0))) : bytes.length;
    const needed = Math.min(this.maximum, this.count + bytes.length);
    if (needed > this.ring.length) {
      const grown = Buffer.alloc(Math.min(this.maximum, Math.max(needed, this.ring.length * 2)));
      this.ring.copy(grown); this.ring = grown;
    }
    for (const byte of bytes.subarray(0, inspect)) {
      for (const group of this.groups) {
        const old = this.count >= group.width ? this.ring[(this.count - group.width) % this.ring.length] + 1 : 0;
        group.rolling = (Math.imul(group.rolling - Math.imul(old, group.power), 257) + byte + 1) >>> 0;
      }
      this.ring[this.count % this.ring.length] = byte; this.count++;
      this.constantRun = this.lastByte === byte ? this.constantRun + 1 : 1; this.lastByte = byte;
      for (const group of this.groups) {
        if (this.count < group.width) continue;
        // Short sequences use SHA-only matching; their polynomial value would directly encode their bytes.
        const candidates = group.hashes.get(group.width <= 4 ? 0 : group.rolling); if (candidates === undefined) continue;
        for (const candidate of candidates) {
          if (this.count < candidate.length) continue;
          const start = (this.count - candidate.length) % this.ring.length;
          const hash = createHash("sha256");
          const end = Math.min(this.ring.length, start + candidate.length);
          hash.update(this.ring.subarray(start, end));
          if (end - start < candidate.length) hash.update(this.ring.subarray(0, candidate.length - (end - start)));
          if (hash.digest("hex") === candidate.digest) return true;
        }
      }
    }
    const skipped = bytes.length - inspect;
    if (skipped > 0) { this.ring.fill(first); this.count += skipped; this.constantRun += skipped; }
    return false;
  }
}
/** Inspect an already observed representation using the same persisted byte-window proof. */
export function matchesFingerprints(bytes: Buffer, patterns: readonly ErasureFingerprint[]): boolean { return new Matcher(patterns).feed(bytes); }
/** Classify without exposing arbitrary names; unknown names remain foreign regardless of their decodable contents. */
export function classifyErasureFile(parts: readonly string[]): { kind: ErasureFileClass; foreign: boolean } {
  const leaf = parts[parts.length - 1] ?? "";
  const knownLoose = parts.length === 2 && /^[0-9a-f]{2}$/.test(parts[0]) && /^[0-9a-f]{62}(?:\.[0-9]+\.[0-9a-f]{12}\.tmp)?$/.test(leaf);
  const knownPack = parts.length === 2 && parts[0] === "packs" && /^[0-9a-f]{64}\.pack$/.test(leaf);
  const kind = leaf.endsWith(".tmp") ? "temporary-storage" : parts[0] === "packs" ? "pack-storage" : parts.length <= 1 ? "object-root" : /^[0-9a-f]{2}$/.test(parts[0]) ? "loose-storage" : "foreign-directory";
  return { kind, foreign: !knownLoose && !knownPack };
}
/** One file shares decode accounting and a terminal hit across all nested representations. */
interface InspectionState { remaining: number; hit: boolean; blocked?: string; live: number }
/** Each native zlib context owns its output inspector until completion, cancellation or fault. */
interface Codec { recognized: boolean; stream: ZStream; output: Uint8Array<ArrayBuffer>; child: EncodedInspector }
/** Four alignments retain at most a partial quartet and a short undecidable decoded prefix. */
interface Base64Phase { skip: number; pending: string; prefix: Buffer; child?: EncodedInspector }
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
  private consumed = 0;
  private word: Base64Phase[] | undefined;
  private closed = false;
  /** Reuse immutable matcher tables; lazy windows grow only with actually observed bytes. */
  constructor(patterns: readonly ErasureFingerprint[], state: InspectionState, kind: ErasureFileClass, depth = 0, template?: Matcher) {
    this.patterns = patterns; this.state = state; this.kind = kind; this.depth = depth;
    this.matcher = new Matcher(patterns, template); this.template = template ?? this.matcher; state.live++;
  }
  /** Reject excessive supported encodings rather than certifying their uninspected remainder. */
  private child(): EncodedInspector | undefined {
    if (this.depth >= erasureScanLimits.depth) { this.state.blocked ??= "decode_depth"; return undefined; }
    if (this.state.live >= erasureScanLimits.contexts) { this.state.blocked ??= "decode_contexts"; return undefined; }
    return new EncodedInspector(this.patterns, this.state, this.kind, this.depth + 1, this.template);
  }
  /** Delay tiny decoded prefixes only until they can contain a supported stream or selected signature. */
  private decoded(phase: Base64Phase, bytes: Buffer): void {
    if (phase.child === undefined) {
      const prefix = Buffer.concat([phase.prefix, bytes]);
      if (prefix.length < 4 && !this.patterns.some(pattern => pattern.length <= prefix.length)) { phase.prefix = prefix; return; }
      phase.child = this.child(); phase.prefix = Buffer.alloc(0); if (phase.child === undefined) return;
      phase.child.feed(prefix);
    } else phase.child.feed(bytes);
  }
  /** Decode bounded quartets incrementally; long supported words never require an unbounded token buffer. */
  private feedWord(text: string): void {
    this.word ??= [0,1,2,3].map(skip => ({ skip, pending: "", prefix: Buffer.alloc(0) }));
    const capacity = Math.min(65_536, Math.floor((erasureScanLimits.wordBytes - 1) / 4) * 4);
    for (const phase of this.word) {
      const skip = Math.min(phase.skip, text.length); phase.skip -= skip;
      const encoded = phase.pending + text.slice(skip); let offset = 0;
      while (encoded.length - offset >= 4) {
        if (capacity < 4) { this.state.blocked ??= "base64_word_bytes"; phase.pending = ""; return; }
        const length = Math.min(capacity, Math.floor((encoded.length - offset) / 4) * 4);
        this.decoded(phase, Buffer.from(encoded.slice(offset, offset + length), "base64")); offset += length;
        if (this.state.hit) return;
      }
      phase.pending = encoded.slice(offset);
      if (phase.pending.length >= erasureScanLimits.wordBytes) { this.state.blocked ??= "base64_word_bytes"; phase.pending = ""; return; }
    }
  }
  /** Finish all alignments, including unpadded final groups, then release every child on all exits. */
  private endWord(): void {
    const word = this.word; this.word = undefined;
    if (word === undefined) return;
    try {
      for (const phase of word) {
        if (phase.pending.length >= 2) this.decoded(phase, Buffer.from(phase.pending, "base64"));
        phase.child?.finish(); if (this.state.hit) return;
      }
    } finally { for (const phase of word) phase.child?.close(); }
  }
  /** Close each dictionary exactly once, even when a deeper inspection refuses or finds a copy. */
  private closeCodec(codec: Codec): void {
    try { codec.child.close(); } finally { zlibInflateEnd(codec.stream); }
  }
  /** Unanchored zero-output header guesses are format nonmatches; recognized streams never hide decode faults. */
  private push(codec: Codec, bytes: Uint8Array): boolean {
    codec.stream.input = Uint8Array.from(bytes); codec.stream.next_in = 0; codec.stream.avail_in = bytes.length;
    do {
      codec.stream.output = codec.output; codec.stream.next_out = 0; codec.stream.avail_out = codec.output.length;
      const status = zlibInflate(codec.stream, Z_SYNC_FLUSH);
      codec.child.feed(codec.output.subarray(0, codec.stream.next_out));
      codec.recognized ||= codec.stream.total_out > 0;
      if (this.state.hit || (status !== Z_OK && status !== Z_BUF_ERROR)) {
        if (!this.state.hit && status !== Z_STREAM_END && codec.recognized) this.state.blocked ??= "decode_error";
        codec.child.finish(); this.closeCodec(codec); return true;
      }
    } while (codec.stream.avail_in > 0 || codec.stream.avail_out === 0);
    return false;
  }
  /** Consume source or decoded slots; no namespace lookup or unbounded object materialization occurs here. */
  feed(bytes: Uint8Array): void {
    if (this.closed) throw new VerificationRefusal("erasure", "inspection_contract", "A closed inspection cannot accept more bytes.");
    if (bytes.length === 0 || this.state.hit) return;
    const start = this.consumed; this.consumed += bytes.length;
    this.state.remaining -= bytes.length;
    if (this.state.remaining <= 0) throw new VerificationRefusal("erasure", "decoded_bytes", "Decoded representation bytes could not be fully inspected.", "unsupported_erasure_storage");
    if (this.matcher.feed(bytes)) { this.state.hit = true; return; }
    for (const codec of [...this.codecs]) if (this.push(codec, bytes)) this.codecs.splice(this.codecs.indexOf(codec), 1);
    if (this.state.hit) return;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (this.previous >= 0 && (this.previous & 15) === 8 && (this.previous >> 4) <= 7 && ((this.previous << 8) + byte) % 31 === 0) {
        if (this.codecs.length >= erasureScanLimits.streams) this.state.blocked ??= "decode_streams";
        else {
          const child = this.child();
          if (child !== undefined) {
            const stream = new ZStream(); zlibInflateInit2(stream, 15);
            const codec: Codec = { recognized: start + i === 1, stream, output: new Uint8Array(16_384), child }; this.codecs.push(codec);
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
      this.feedWord(match[0]);
      end = match.index + match[0].length;
      if (match[0].endsWith("=")) this.endWord();
      if (this.state.hit) return;
    }
    if (end < text.length) this.endWord();
  }
  /** Flush final partial words and recoverable streams, then close dictionaries before returning or throwing. */
  finish(): void {
    try {
      this.endWord();
      while (this.codecs.length > 0) {
        const codec = this.codecs.shift()!;
        if (codec.recognized) this.state.blocked ??= "incomplete_stream";
        try { codec.child.finish(); } finally { this.closeCodec(codec); }
      }
    } finally { this.close(); }
  }
  /** Release all remaining dictionaries on early hit, exception or normal completion. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const codec of this.codecs) this.closeCodec(codec);
    for (const phase of this.word ?? []) phase.child?.close();
    this.word = undefined; this.codecs.length = 0; this.state.live--;
  }
}

/** Streaming proof belongs to its caller's pinned native member and closes on every exit. */
export interface ErasureRepresentationInspection { feed(bytes: Uint8Array): void; finish(): void; close(): void }
/** Build the same bounded proof for materialized and descriptor-streamed canonical members. @internal */
export function createErasureInspection(patterns: readonly ErasureFingerprint[], frameBytes: number, kind: ErasureFileClass = "loose-storage"): ErasureRepresentationInspection {
  const state: InspectionState = { remaining: Math.max(erasureScanLimits.minimum, frameBytes * erasureScanLimits.ratio), hit: false, live: 0 };
  const inspector = new EncodedInspector(patterns, state, kind);
  let observed = 0; let finished = false; let failure: ObjectStoreError | undefined;
  /** Failed or aborted proof state is sticky, even if a caller ignores its first exception. */
  const inspect = (action: () => void): void => {
    if (failure !== undefined) throw failure;
    try { action(); } catch (error) { failure = error instanceof ObjectStoreError ? error : new VerificationRefusal("erasure", "decode_error", "Representation inspection did not complete."); inspector.close(); throw failure; }
  };
  return {
    /** Inspect borrowed slots without retaining their source buffers. */
    feed(bytes) { inspect(() => { inspector.feed(bytes); observed += bytes.length; }); },
    /** A hit or incomplete decode cannot become a successful native-member proof. */
    finish() {
      try { inspect(() => {
        if (observed !== frameBytes) throw new VerificationRefusal("erasure", "representation_bytes", "The native member's complete byte range was not inspected.");
        inspector.finish();
        if (state.hit) throw new ErasureStorageRefusal("erasure_retained_copy", kind);
        if (state.blocked !== undefined) throw new VerificationRefusal("erasure", state.blocked, `A supported ${kind} representation remains uninspected.`, "uninspectable_payload");
        finished = true;
      }); } finally { inspector.close(); }
    },
    /** The owner releases remaining dictionaries after parse errors and early termination too. */
    close() { if (!finished && failure === undefined) failure = new VerificationRefusal("erasure", "inspection_incomplete", "The native inspection was closed before a complete proof."); inspector.close(); },
  };
}
/** Verify one decoded object independently of the physical pack that also carries selected members. */
export function inspectErasureRepresentation(bytes: Buffer, patterns: readonly ErasureFingerprint[]): void {
  const inspector = createErasureInspection(patterns, bytes.length);
  try { for (let offset = 0; offset < bytes.length; offset += 65_536) inspector.feed(bytes.subarray(offset, offset + 65_536)); inspector.finish(); }
  finally { inspector.close(); }
}
/** Inspect raw bytes on the same descriptor that native accounting will identity-check before certifying. @internal */
export function inspectErasureFile(fd: number, size: number, patterns: readonly ErasureFingerprint[], kind: ErasureFileClass, budget?: () => void): void {
  const matcher = new Matcher(patterns); const bytes = Buffer.alloc(65_536); let offset = 0;
  while (offset < size) {
    budget?.();
    const count = readSync(fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
    if (count === 0) throw new VerificationRefusal("erasure", "storage_read", "A pinned physical range became incomplete.");
    if (matcher.feed(bytes.subarray(0, count))) throw new ErasureStorageRefusal("erasure_retained_copy", kind);
    offset += count;
  }
}
/** Independently scan all regular storage files; callers hold the package writer lease throughout deletion and this final proof. */
export function scanErasureStorage(root: string, patterns: readonly ErasureFingerprint[], excluded: ReadonlySet<string> = new Set(), encodings = true): ErasureStorageReport {
  const classes: Partial<Record<ErasureFileClass, number>> = {}; let files = 0; let foreign = 0;
  /** Descend real directories only, including arbitrary foreign and temporary subdirectories. */
  const walk = (directory: string, parts: string[]): void => {
    if (!lstatSync(directory).isDirectory()) throw new ErasureStorageRefusal("unsupported_erasure_storage", classifyErasureFile(parts).kind);
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name); const names = [...parts, entry.name];
      if (entry.isDirectory()) { walk(path, names); continue; }
      const { kind, foreign: isForeign } = classifyErasureFile(names);
      if (!entry.isFile()) throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
      if (excluded.has(path)) continue;
      let file: ReturnType<typeof objectFiles.open> | undefined;
      try {
        file = objectFiles.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(file.fd, { bigint: true });
        if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
        const size = Number(before.size);
        const input = Buffer.alloc(65_536); let offset = 0;
        const state: InspectionState = { remaining: Math.max(erasureScanLimits.minimum, size * erasureScanLimits.ratio), hit: false, live: 0 };
        const inspector = encodings ? new EncodedInspector(patterns, state, kind) : undefined;
        const raw = inspector === undefined ? new Matcher(patterns) : undefined;
        try {
          erasureScanBoundary.visit("file-opened");
          while (offset < size) {
            const count = readSync(file.fd, input, 0, Math.min(input.length, size - offset), offset);
            if (count === 0) throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
            const bytes = input.subarray(0, count);
            if (inspector === undefined) state.hit = raw!.feed(bytes); else inspector.feed(bytes);
            if (state.hit) throw new ErasureStorageRefusal("erasure_retained_copy", kind);
            offset += count; erasureScanBoundary.visit("file-chunk");
          }
          inspector?.finish();
          if (state.hit) throw new ErasureStorageRefusal("erasure_retained_copy", kind);
          if (state.blocked !== undefined) throw new VerificationRefusal("erasure", state.blocked, "A supported representation remains uninspected.", "uninspectable_payload");
        } finally { inspector?.close(); }
        const after = fstatSync(file.fd, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
        files++; if (isForeign) foreign++; classes[kind] = (classes[kind] ?? 0) + 1;
        erasureScanBoundary.visit("file-verified");
      } catch (error) {
        if (error instanceof ErasureStorageRefusal || error instanceof VerificationRefusal) throw error;
        throw new ErasureStorageRefusal("unsupported_erasure_storage", kind);
      } finally { file?.close(); }
    }
    const names = entries.map((entry) => `${entry.name}:${entry.isDirectory()}`).sort();
    const current = readdirSync(directory, { withFileTypes: true }).map((entry) => `${entry.name}:${entry.isDirectory()}`).sort();
    if (JSON.stringify(names) !== JSON.stringify(current)) throw new ErasureStorageRefusal("unsupported_erasure_storage", classifyErasureFile(parts).kind);
  };
  walk(root, []); return { files, foreign, classes };
}
