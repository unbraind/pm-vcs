/** Physical erasure certificates require complete native representations and a stable namespace. */
import { createHash, randomBytes } from "node:crypto";
import { constants, fstatSync, lstatSync, readdirSync, readSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { writePrivateJson } from "./composition.ts";
import { ZStream, zlibInflateInit2, zlibInflate, zlibInflateEnd, Z_NO_FLUSH, Z_STREAM_END, Z_OK, Z_BUF_ERROR } from "pako";
import { objectFiles } from "./object-files.ts";
import { assertVerificationBound, verificationLimits, VerificationRefusal } from "./object-error.ts";
import { durability } from "./durability.ts";
import { OBJECT_TYPES, readControlJson, type ObjectType } from "./objects.ts";
import { PackStorage, PackRefusal } from "./packs.ts";
import { classifyErasureFile, ErasureStorageRefusal, type ErasureFileClass, type ErasureStorageReport } from "./erasure-scan.ts";

/** Interleavings occur before the final identity barrier, never after a successful certificate. @internal */
export const accountabilityBoundary: { visit(step: string, path: string, attempt: number): void } = { visit() {} };
/** Both per-file and whole-namespace retries are bounded. */
export const ACCOUNTABILITY_ATTEMPTS = 8;
/** Complete native-format accounting; the erasure caller additionally requires complete representation inspection. */
export interface ErasureAccountabilityReport extends ErasureStorageReport { readonly accountable: true; readonly objects: number }
/** Exact identity selected by an explicit purge; content is never retained in its receipt. */
export interface UnaccountedFile { readonly path: string; readonly fileClass: ErasureFileClass; readonly sha256: string; readonly bytes: number; readonly identity: string }
/** The caller holds its native writer lease and persists purge authorization before invoking remove. */
export interface AccountabilityOptions {
  readonly forbiddenIds: ReadonlySet<string>;
  readonly forbiddenPayloads: ReadonlySet<string>;
  readonly purge?: (file: UnaccountedFile, remove: () => void) => boolean;
}
/** Internal retry never escapes as a claim of stable absence. */
class Changed extends Error {}
/** Only actual format failures can authorize purge; operational I/O errors never become foreign files. */
class InvalidRepresentation extends Error {}
/** Namespace identity deliberately excludes ctime/link count, while checking content size and mtime. */
function identity(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`; }
/** Read one bounded source slot from the pinned file; EOF before its recorded range is not accountable. */
function slot(fd: number, start: number, length: number): Buffer {
  const bytes = Buffer.alloc(length); let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, { offset, length: length - offset, position: start + offset });
    if (count === 0) throw new Changed(); offset += count;
  }
  return bytes;
}
/** Verify a complete zlib stream, canonical native framing and logical identity with bounded decoded slots. */
function nativeObject(fd: number, offset: number, length: number, id: string, hint?: ObjectType, maxFrameBytes?: number): { digest: string; length: number } {
  const stream = new ZStream(); zlibInflateInit2(stream, 15);
  const output = new Uint8Array(16_384); const hash = createHash("sha256"); const payload = createHash("sha256");
  let header = Buffer.alloc(0); let declared: number | undefined; let consumed = 0; let read = 0; let ended = false; let framedBytes = 0;
  try {
    while (read < length && !ended) {
      const bytes = slot(fd, offset + read, Math.min(65_536, length - read)); read += bytes.length;
      stream.input = Uint8Array.from(bytes); stream.next_in = 0; stream.avail_in = bytes.length;
      do {
        stream.output = output; stream.next_out = 0; stream.avail_out = output.length;
        const status = zlibInflate(stream, Z_NO_FLUSH); let data: Buffer = Buffer.from(output.subarray(0, stream.next_out)); framedBytes += data.length;
        assertVerificationBound("accountability", "decoded_bytes", framedBytes, verificationLimits.accountabilityDecodedBytes);
        if (maxFrameBytes !== undefined && framedBytes > maxFrameBytes) throw new InvalidRepresentation("oversized pack frame");
        hash.update(data);
        if (declared === undefined) {
          header = Buffer.concat([header, data]); const nul = header.indexOf(0);
          if (nul < 0) { if (header.length > 32) throw new InvalidRepresentation("invalid frame"); data = Buffer.alloc(0); }
          else {
            const match = /^([a-z]+) (0|[1-9][0-9]*)$/.exec(header.subarray(0, nul).toString("latin1"));
            if (nul > 32 || match === null || !(OBJECT_TYPES as readonly string[]).includes(match[1]) || (hint !== undefined && hint !== match[1]) || !Number.isSafeInteger(Number(match[2]))) throw new InvalidRepresentation("invalid frame");
            declared = Number(match[2]); data = header.subarray(nul + 1); header = Buffer.alloc(0);
          }
        }
        payload.update(data); consumed += data.length;
        if (declared !== undefined && consumed > declared) throw new InvalidRepresentation("invalid length");
        if (status === Z_STREAM_END) { ended = true; break; }
        if (status !== Z_OK && status !== Z_BUF_ERROR) throw new InvalidRepresentation("invalid zlib");
      } while (stream.avail_in > 0 || stream.avail_out === 0);
    }
    if (!ended || stream.total_in !== length || declared === undefined || consumed !== declared || hash.digest("hex") !== id) throw new InvalidRepresentation("incomplete representation");
    return { digest: payload.digest("hex"), length: consumed };
  } finally { zlibInflateEnd(stream); }
}
/** Hash unaccounted bytes for an exact, resumable purge plan without persisting their content. */
function physicalDigest(fd: number, size: number): string {
  const hash = createHash("sha256");
  for (let offset = 0; offset < size; offset += 65_536) hash.update(slot(fd, offset, Math.min(65_536, size - offset)));
  return hash.digest("hex");
}
/** Verify every regular file, retrying a replaced file and then the whole catalogue before certification. */
function inspectStorage(scope: string | readonly string[], options: AccountabilityOptions, planning?: Map<string, UnaccountedFile>): ErasureAccountabilityReport {
  const started = performance.now(); let visited = 0;
  /** Work exhaustion refuses both certification and purge authorization. */
  const check = (): void => { assertVerificationBound("accountability", "time_ms", performance.now() - started, verificationLimits.accountabilityMs); };
  check();
  const roots = typeof scope === "string" ? [scope] : scope;
  const packs = new Map(roots.map((root) => [root, new PackStorage(root)]));
  const root = roots[0] ?? ".";
  for (let pass = 0; pass < ACCOUNTABILITY_ATTEMPTS; pass++) {
    planning?.clear();
    const snapshots = new Map<string, string>(); const directories = new Map<string, string>();
    const classes: Partial<Record<ErasureFileClass, number>> = {}; let files = 0; let objects = 0; let purged = false;
    const missing = new Set<string>();
    /** Capture a directory catalogue, rejecting links and special leaves rather than following foreign storage. */
    const catalogue = (path: string): string[] => readdirSync(path, { encoding: "utf8" });
    /** Inspect one file while retaining its descriptor until its pathname has been compared. */
    const inspect = (path: string, parts: string[], pack: PackStorage): void => {
      assertVerificationBound("accountability", "file_count", ++visited, verificationLimits.accountabilityFiles); check();
      const kind = classifyErasureFile(parts).kind;
      for (let attempt = 0; attempt < ACCOUNTABILITY_ATTEMPTS; attempt++) {
        accountabilityBoundary.visit("file-resolve", path, attempt);
        const file = objectFiles.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = fstatSync(file.fd, { bigint: true });
          assertVerificationBound("accountability", "file_bytes", Number(before.size), verificationLimits.accountabilityFileBytes);
          if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new ErasureStorageRefusal("unverifiable", kind);
          const stamp = identity(before); let parsed = false; let forbidden = false; let count = 0;
          accountabilityBoundary.visit("file-opened", path, attempt);
          /** Logical denial covers both stable addresses and type-independent, nonempty payloads. */
          const object = (id: string, offset: number, length: number, type?: ObjectType, maxFrameBytes?: number): void => {
            const value = nativeObject(file.fd, offset, length, id, type, maxFrameBytes); count++;
            forbidden ||= options.forbiddenIds.has(id) || (value.length > 0 && options.forbiddenPayloads.has(value.digest));
            accountabilityBoundary.visit("object-verified", path, attempt);
          };
          try {
            if (parts.length === 2 && /^[0-9a-f]{2}$/.test(parts[0]) && /^[0-9a-f]{62}$/.test(parts[1])) object(parts.join(""), 0, Number(before.size));
            else if (parts.length === 2 && parts[0] === "packs" && /^[0-9a-f]{64}\.pack$/.test(parts[1])) pack.verifyFile(file.fd, path, object);
            else throw new InvalidRepresentation("foreign name");
            parsed = true;
          } catch (error) { if (!(error instanceof InvalidRepresentation) && !(error instanceof PackRefusal && error.code === "corrupt_pack")) throw error; }
          accountabilityBoundary.visit("file-parsed", path, attempt);
          /** A purge authorization write can itself race a replacement, so check again immediately before removal. */
          const same = (): boolean => {
            const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
            return current?.isFile() === true && identity(current) === stamp && identity(fstatSync(file.fd, { bigint: true })) === stamp;
          };
          accountabilityBoundary.visit("file-check", path, attempt);
          if (!same()) continue;
          if (!parsed) {
            if (options.purge === undefined && planning === undefined) throw new ErasureStorageRefusal("unverifiable", kind);
            const candidate: UnaccountedFile = { path, fileClass: kind, sha256: physicalDigest(file.fd, Number(before.size)), bytes: Number(before.size), identity: stamp };
            if (!same()) continue;
            if (planning !== undefined) { planning.set(path, candidate); snapshots.set(path, stamp); return; }
            const removed = options.purge!(candidate, () => {
              accountabilityBoundary.visit("purge-check", path, attempt);
              if (!same()) throw new Changed();
              durability.unlink(path); accountabilityBoundary.visit("purge-deleted", path, attempt);
            });
            if (removed !== true) throw new ErasureStorageRefusal("unverifiable", kind);
            purged = true; return;
          }
          if (forbidden) throw new ErasureStorageRefusal("erasure_retained_copy", kind);
          snapshots.set(path, stamp); classes[kind] = (classes[kind] ?? 0) + 1; files++; objects += count;
          accountabilityBoundary.visit("file-verified", path, attempt);
        } catch (error) {
          if (error instanceof Changed) throw error;
          if (error instanceof ErasureStorageRefusal || error instanceof VerificationRefusal) throw error;
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Changed();
          throw new ErasureStorageRefusal("unverifiable", kind);
        } finally { file.close(); }
        return;
      }
      throw new Changed();
    };
    /** Every directory and regular leaf participates, regardless of name or extension. */
    const walk = (path: string, parts: string[], pack: PackStorage): void => {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isDirectory()) throw new ErasureStorageRefusal("unverifiable", classifyErasureFile(parts).kind);
      const names = catalogue(path).sort(); directories.set(path, `${stat.dev}:${stat.ino}:${JSON.stringify(names)}`);
      for (const name of names) {
        const leaf = join(path, name); const child = [...parts, name]; const info = lstatSync(leaf);
        if (info.isDirectory()) walk(leaf, child, pack);
        else if (info.isFile()) inspect(leaf, child, pack);
        else throw new ErasureStorageRefusal("unverifiable", classifyErasureFile(child).kind);
      }
    };
    try {
      for (const current of roots) {
        accountabilityBoundary.visit("pass-start", current, pass);
        if (lstatSync(current, { throwIfNoEntry: false }) === undefined) missing.add(current);
        else walk(current, [], packs.get(current)!);
      }
      if (purged) throw new Changed();
      accountabilityBoundary.visit("pass-check", root, pass);
      check();
      for (const path of missing) if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) throw new Changed();
      for (const [path, expected] of directories) {
        const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
        if (!stat?.isDirectory() || `${stat.dev}:${stat.ino}:${JSON.stringify(catalogue(path).sort())}` !== expected) throw new Changed();
      }
      for (const [path, expected] of snapshots) {
        const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
        if (!stat?.isFile() || identity(stat) !== expected) throw new Changed();
      }
      check();
      return { files, objects, foreign: 0, accountable: true, classes };
    } catch (error) {
      if (error instanceof Changed || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof ErasureStorageRefusal || error instanceof VerificationRefusal) throw error;
      throw new ErasureStorageRefusal("unverifiable", "object-root");
    }
  }
  throw new VerificationRefusal("accountability", "storage_attempts", "The storage namespace did not stabilize.", "unverifiable");
}

/** Certify only a fully accounted, payload-free generation; planning never grants a certificate. */
export function accountErasureStorage(scope: string | readonly string[], options: AccountabilityOptions): ErasureAccountabilityReport { return inspectStorage(scope, options); }

/** Snapshot every unaccounted file without changing bytes, before request validation or deletion authorization. */
export function planErasureStorage(scope: readonly string[]): readonly UnaccountedFile[] {
  const files = new Map<string, UnaccountedFile>();
  inspectStorage(scope, { forbiddenIds: new Set(), forbiddenPayloads: new Set() }, files);
  return [...files.values()];
}

/** Pending authority ends with its exact storage-root lifetime, with a safe machine-readable audit reason. */
export type ErasurePurgeCancellation = "root_retired" | "root_missing" | "root_replaced" | "legacy_authorization";
/** Terminal entries are immutable historical facts, not membership claims about the current root set. */
export interface ErasurePurgeEntry {
  readonly file: string; readonly fileClass: ErasureFileClass; readonly sha256: string; readonly bytes: number; readonly identity: string;
  readonly root?: string; readonly rootIdentity?: string;
  status: "planned" | "deleted" | "absent" | "replaced" | "cancelled";
  reason?: ErasurePurgeCancellation;
}
/** Agent-sized purge receipt preserves historical counts and explicitly reports cancelled pending authority. */
export interface ErasurePurgeReceipt { readonly intents: readonly { readonly id: string; readonly revision: string; readonly planned: number; readonly pending: number }[]; readonly omittedIntents: number; readonly deleted: number; readonly observedAbsent: number; readonly replaced: number; readonly cancelled: number; readonly bytes: number; readonly omitted: number; readonly files: readonly ErasurePurgeEntry[] }
/** Recover only package-written authorization under the caller's owning writer lease. */
export function erasurePurge(control: string, fileId: string, roots: readonly string[], authorized: boolean, readOnly = false): { readonly canPurge: boolean; purge: NonNullable<AccountabilityOptions["purge"]>; begin(files: readonly UnaccountedFile[]): void; plan(files: readonly UnaccountedFile[], resume?: boolean): void; receipt(): ErasurePurgeReceipt } {
  const path = join(control, "erasure-purge.json");
  let raw: unknown;
  try { raw = readControlJson(path, "unverifiable", "purge journal", { format: "pm-vcs-erasure-purge-1", operations: {} }); }
  catch { throw new ErasureStorageRefusal("unverifiable", "verification-metadata"); }
  /** Paths remain canonical audit text even after their root ceases to exist; they never grant authority alone. */
  const canonical = (file: unknown): file is string => typeof file === "string" && file !== "" && !file.includes("\0") && !isAbsolute(file) && relative(control, resolve(control, file)) === file;
  /** Prefix membership is checked against current roots only when exercising pending deletion authority. */
  const scoped = (file: string, scope: readonly string[] = roots): string | undefined => scope.find((root) => { const name = relative(root, resolve(control, file)); return name !== "" && name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name); });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ErasureStorageRefusal("unverifiable", "verification-metadata");
  const input = raw as { format: string; operations: Record<string, ErasurePurgeEntry[]>; plans?: Record<string, { id: string; revision: string }[]> };
  const legacy = input.format === "pm-vcs-erasure-purge-1" && Object.keys(input).sort().join(",") === "format,operations";
  if ((!legacy && (input.format !== "pm-vcs-erasure-purge-2" || Object.keys(input).sort().join(",") !== "format,operations,plans")) || input.operations === null || typeof input.operations !== "object" || Array.isArray(input.operations)) throw new ErasureStorageRefusal("unverifiable", "verification-metadata");
  const journal: { format: string; operations: Record<string, ErasurePurgeEntry[]>; plans: Record<string, { id: string; revision: string }[]> } = { format: "pm-vcs-erasure-purge-2", operations: input.operations, plans: legacy ? {} : input.plans! };
  for (const [id, entries] of Object.entries(journal.operations)) {
    if (!/^[0-9a-f]{32}$/.test(id) || !Array.isArray(entries) || entries.some((entry) => entry === null || typeof entry !== "object"
      || !["bytes,file,fileClass,identity,sha256,status", "bytes,file,fileClass,identity,reason,sha256,status", "bytes,file,fileClass,identity,root,rootIdentity,sha256,status", "bytes,file,fileClass,identity,reason,root,rootIdentity,sha256,status"].includes(Object.keys(entry).sort().join(","))
      || !canonical(entry.file) || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.identity !== "string" || !/^\d+:\d+:\d+:-?\d+$/.test(entry.identity)
      || !["object-root","loose-storage","pack-storage","temporary-storage","foreign-directory"].includes(entry.fileClass)
      || !["planned","deleted","absent","replaced","cancelled"].includes(entry.status)
      || (entry.root !== undefined && (!canonical(entry.root) || typeof entry.rootIdentity !== "string" || !/^\d+:\d+:\d+$/.test(entry.rootIdentity) || scoped(entry.file, [resolve(control, entry.root)]) === undefined))
      || (entry.status === "cancelled" ? !["root_retired","root_missing","root_replaced","legacy_authorization"].includes(entry.reason!) : entry.reason !== undefined))) throw new ErasureStorageRefusal("unverifiable", "verification-metadata");
  }
  if (legacy) for (const [id, entries] of Object.entries(journal.operations)) journal.plans[id] = [{ id, revision: createHash("sha256").update(JSON.stringify(entries)).digest("hex") }];
  if (journal.plans === null || typeof journal.plans !== "object" || Array.isArray(journal.plans)) throw new ErasureStorageRefusal("unverifiable", "verification-metadata");
  const claimed = new Set<string>();
  for (const [file, plans] of Object.entries(journal.plans)) {
    if (!/^[0-9a-f]{32}$/.test(file) || !Array.isArray(plans)) throw new ErasureStorageRefusal("unverifiable", "verification-metadata");
    for (const plan of plans) {
      if (plan === null || typeof plan !== "object" || Object.keys(plan).sort().join(",") !== "id,revision" || !/^[0-9a-f]{32}$/.test(plan.id) || !/^[0-9a-f]{64}$/.test(plan.revision) || !Object.hasOwn(journal.operations, plan.id) || claimed.has(plan.id)) throw new ErasureStorageRefusal("unverifiable", "verification-metadata");
      claimed.add(plan.id);
    }
  }
  if (claimed.size !== Object.keys(journal.operations).length) throw new ErasureStorageRefusal("unverifiable", "verification-metadata");
  /** Root birth identity is stable through ordinary file arrivals and changes when a directory is recreated. */
  const rootStamp = (root: string): string | undefined => {
    const stat = lstatSync(root, { bigint: true, throwIfNoEntry: false });
    if (stat === undefined) return undefined;
    if (!stat.isDirectory()) throw new ErasureStorageRefusal("unverifiable", "object-root");
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  };
  /** Never inspect a retired pathname or allow an old plan to follow a replacement root. */
  const cancellation = (entry: ErasurePurgeEntry): ErasurePurgeCancellation | undefined => {
    const root = entry.root === undefined ? scoped(entry.file) : roots.find(root => relative(control, root) === entry.root);
    if (root === undefined) return "root_retired";
    const stamp = rootStamp(root);
    if (stamp === undefined) return "root_missing";
    if (entry.root === undefined) return "legacy_authorization";
    if (entry.rootIdentity !== stamp) return "root_replaced";
    return undefined;
  };
  /** Settle obsolete pending authority across all operations, leaving terminal audit entries untouched. */
  const retire = (): void => {
    let changed = false;
    for (const entries of Object.values(journal.operations)) for (const entry of entries) if (entry.status === "planned") {
      const reason = cancellation(entry);
      if (reason !== undefined) { entry.status = "cancelled"; entry.reason = reason; changed = true; }
    }
    if (changed && !readOnly) {
      accountabilityBoundary.visit("purge-lifecycle-planned", path, 0);
      writePrivateJson(path, journal);
      accountabilityBoundary.visit("purge-lifecycle-recorded", path, 0);
    }
  };
  retire();
  const plans = journal.plans[fileId] ?? []; journal.plans[fileId] = plans;
  const entries = plans.flatMap(plan => journal.operations[plan.id]);
  let sealed = false;
  /** A fresh explicit request publishes a new exact batch; previous batch membership never changes. */
  const publish = (files: readonly UnaccountedFile[]): void => {
    const additions: ErasurePurgeEntry[] = [];
    for (const file of files) {
      const name = relative(control, file.path); const root = scoped(name);
      if (root === undefined) throw new ErasureStorageRefusal("unverifiable", file.fileClass);
      const stamp = rootStamp(root); if (stamp === undefined) throw new Changed();
      const rootName = relative(control, root);
      if (![...entries, ...additions].some(entry => entry.status === "planned" && entry.file === name && entry.identity === file.identity && entry.sha256 === file.sha256 && entry.root === rootName && entry.rootIdentity === stamp)) additions.push({ file: name, fileClass: file.fileClass, sha256: file.sha256, bytes: file.bytes, identity: file.identity, root: rootName, rootIdentity: stamp, status: "planned" });
    }
    if (additions.length === 0 && plans.length > 0) return;
    if (readOnly) throw new ErasureStorageRefusal("unverifiable", "verification-metadata");
    let id = plans.length === 0 && !Object.hasOwn(journal.operations, fileId) ? fileId : randomBytes(16).toString("hex");
    while (Object.hasOwn(journal.operations, id)) id = randomBytes(16).toString("hex");
    const revision = createHash("sha256").update(JSON.stringify([roots.map(root => [relative(control, root), rootStamp(root)]), additions])).digest("hex");
    journal.operations[id] = additions; plans.push({ id, revision }); entries.push(...additions); writePrivateJson(path, journal);
    for (const entry of additions) accountabilityBoundary.visit("purge-set-persisted", resolve(control, entry.file), 0);
  };
  return {
    /** Only current pending authority can permit automatic replay. */
    get canPurge() { return authorized || entries.some((entry) => entry.status === "planned"); },
    /** Publish one separately identified fresh authorization after full caller preflight; one helper represents one request. */
    begin(files) { if (sealed) return; sealed = true; if (authorized) publish(files); },
    /** Recovery preserves prior batches exactly and never authorizes a newly arrived member. */
    plan(files, resume = false) { if (sealed) return; sealed = true; if (authorized && !resume) publish(files); },
    /** Persist current root and file identity before removal; historical entries never become fresh authority. */
    purge(file, remove) {
      const name = relative(control, file.path); const root = scoped(name);
      if (root === undefined) return false;
      const stamp = rootStamp(root); if (stamp === undefined) throw new Changed();
      const rootName = relative(control, root);
      const existing = entries.find((entry) => entry.status === "planned" && entry.file === name && entry.identity === file.identity && entry.sha256 === file.sha256 && entry.root === rootName && entry.rootIdentity === stamp);
      if ((!authorized || sealed) && existing === undefined) return false;
      if (existing === undefined) publish([file]);
      const entry = existing ?? entries.find(entry => entry.status === "planned" && entry.file === name && entry.identity === file.identity && entry.sha256 === file.sha256 && entry.root === rootName && entry.rootIdentity === stamp)!;
      accountabilityBoundary.visit("purge-planned", file.path, 0);
      if (cancellation(entry) !== undefined) { retire(); throw new Changed(); }
      remove(); entry.status = "deleted"; writePrivateJson(path, journal);
      accountabilityBoundary.visit("purge-recorded", file.path, 0); return true;
    },
    /** Resolve only active pending files; completed and cancelled records are historical without filesystem lookups. */
    receipt() {
      retire(); let changed = false;
      for (const entry of entries) if (entry.status === "planned") {
        const stat = lstatSync(resolve(control, entry.file), { bigint: true, throwIfNoEntry: false });
        if (stat === undefined) { entry.status = "absent"; changed = true; }
        else if (identity(stat) !== entry.identity) { entry.status = "replaced"; changed = true; }
        else throw new ErasureStorageRefusal("unverifiable", entry.fileClass);
      }
      if (changed) writePrivateJson(path, journal);
      return { intents: plans.slice(0, 20).map(plan => ({ ...plan, planned: journal.operations[plan.id].length, pending: journal.operations[plan.id].filter(entry => entry.status === "planned").length })), omittedIntents: Math.max(0, plans.length - 20), deleted: entries.filter((entry) => entry.status === "deleted").length, observedAbsent: entries.filter((entry) => entry.status === "absent").length,
        replaced: entries.filter((entry) => entry.status === "replaced").length, cancelled: entries.filter((entry) => entry.status === "cancelled").length,
        bytes: entries.filter((entry) => entry.status === "deleted").reduce((sum, entry) => sum + entry.bytes, 0), omitted: Math.max(0, entries.length - 20), files: entries.slice(0,20) };
    },
  };
}
