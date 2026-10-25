import { durability } from "./durability.ts";
/** Immutable indexed packs: independently compressed frames keep their uncompressed addresses. */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { deflateSync } from "node:zlib";
import { ObjectStoreError } from "./object-error.ts";
import { syncDirectory } from "./composition.ts";
import { frameObject, isObjectId, OBJECT_TYPES, ObjectStore, objectReadBoundary, type ObjectHandle, type InventoryEntry, type ObjectId, type ObjectType, type StoredObject } from "./objects.ts";

const MAGIC = Buffer.from("PMVCSP1\n");
const LIMIT = 16 * 1024 * 1024;
/** Address, body-relative compressed byte offset, compressed length and object kind. */
type Entry = readonly [ObjectId, number, number, ObjectType];
/** Validated immutable index, tied to the pack's current filesystem identity. */
interface Index { readonly entries: readonly Entry[]; readonly byId: ReadonlyMap<ObjectId, Entry>; readonly start: number; readonly bytes: number; readonly signature: string }
/** Agent-sized compaction receipt; physical paths and address lists are deliberately omitted. */
export interface PackReport {
  readonly objects: number;
  readonly packs: number;
  readonly looseBytes: number;
  readonly packBytes: number;
  readonly skippedCount: number;
  readonly omittedSkipped: number;
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}
/** Public refusal discriminators for pack integrity and authorized-erasure lifecycle guards. */
export type PackRefusalCode = "corrupt_pack" | "pack_erasure_pending";
/** Stable typed refusals also carry an actionable operator remedy. */
export class PackRefusal extends ObjectStoreError {
  /** Narrow discriminator for exhaustive SDK handling. */
  override readonly code: PackRefusalCode;
  /** Safe next action, also included in the CLI error message. */
  readonly remedy: string;
  /** Construct a corruption or lifecycle refusal without exposing storage paths. */
  constructor(code: PackRefusalCode, detail: string, remedy: string) {
    super(code, `${detail} ${remedy}`); this.name = "PackRefusal"; this.code = code; this.remedy = remedy;
  }
}
/** Crash/interleaving seam; callbacks run inside the existing shared writer lease. @internal */
export const packBoundary: { visit(step: string): void } = { visit() {} };

/** Hash physical pack bytes independently of logical object identities. */
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
/** Refuse suspect bytes before any source copy can be retired. */
function corrupt(): never { throw new PackRefusal("corrupt_pack", "Pack index or content failed verification.", "Restore a verified copy of the pack before retrying; loose sources have not been retired by this attempt."); }
/** Read an exact bounded range from a pinned descriptor, never neighboring members. */
function range(fd: number, start: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, start + offset);
    if (count === 0) corrupt();
    offset += count;
  }
  return bytes;
}
/** Manage only files with a validated package format; unknown records are foreign and remain untouched. */
export class PackStorage {
  private readonly directory: string;
  private readonly indexes = new Map<string, Index>();
  /** Bind a pack backend to the loose object directory. */
  constructor(root: string) { this.directory = join(root, "packs"); }

  /** Enumerate regular package packs, reporting every foreign entry without deleting it. */
  files(skipped: { name: string; reason: string }[] = []): string[] {
    if (!existsSync(this.directory)) return [];
    if (!lstatSync(this.directory).isDirectory()) corrupt();
    const result: string[] = [];
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (entry.isFile() && /^[0-9a-f]{64}\.pack$/.test(entry.name)) result.push(join(this.directory, entry.name));
      else skipped.push({ name: `packs/${entry.name}`, reason: "foreign or unpublished storage; left untouched" });
    }
    return result.sort();
  }

  /** Validate the bounded index and pin it to the exact open file identity; payload verification remains per read. */
  private index(fd: number, path: string): Index {
    const stat = fstatSync(fd, { bigint: true });
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = this.indexes.get(path);
    if (cached?.signature === signature) return cached;
    const header = range(fd, 0, 12);
    if (!header.subarray(0, 8).equals(MAGIC)) corrupt();
    const length = header.readUInt32BE(8);
    const bytes = Number(stat.size);
    if (length > LIMIT || length < 2 || bytes > LIMIT * 2 || bytes < 12 + length) corrupt();
    let value: unknown;
    try { value = JSON.parse(range(fd, 12, length).toString("utf8")); } catch { corrupt(); }
    if (!Array.isArray(value) || value.length === 0) corrupt();
    let offset = 0; let previous = "";
    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length !== 4 || typeof entry[0] !== "string" || !isObjectId(entry[0]) || entry[0] <= previous
        || entry[1] !== offset || !Number.isSafeInteger(entry[2]) || entry[2] <= 0 || !OBJECT_TYPES.includes(entry[3])) corrupt();
      previous = entry[0]; offset += entry[2];
    }
    if (offset !== bytes - 12 - length) corrupt();
    const index: Index = { entries: value as Entry[], byId: new Map((value as Entry[]).map((entry) => [entry[0], entry])), start: 12 + length, bytes, signature };
    this.indexes.set(path, index); return index;
  }

  /** Open one immutable indexed range; descriptor ownership transfers to the common resolver. @internal */
  locate(id: ObjectId, exactPath?: string): ObjectHandle | undefined {
    const paths = exactPath === undefined ? this.files() : [exactPath];
    objectReadBoundary.visit("pack-catalog", id, 0);
    for (const path of paths) {
      let fd: number;
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let transferred = false;
      try {
        const index = this.index(fd, path); const entry = index.byId.get(id);
        if (entry === undefined) { if (exactPath !== undefined) corrupt(); continue; }
        const offset = index.start + entry[1]; transferred = true;
        return { fd, path, offset, length: entry[2], regular: true, type: entry[3], packed: { offset, length: entry[2] }, bytes: entry[2] + (entry === index.entries[0] ? index.start : 0) };
      } finally { if (!transferred) closeSync(fd); }
    }
    return undefined;
  }

  /** Presence goes through the same generation resolver as loose storage. */
  has(id: ObjectId): boolean { return new ObjectStore(join(this.directory, "..")).has(id); }

  /** Kind probes use the common pinned-location protocol before reading the index hint. */
  type(id: ObjectId): ObjectType | undefined {
    try { return this.read(id)?.type; } catch (error) {
      if (error instanceof ObjectStoreError && error.code === "object_obliterated") return undefined;
      throw error;
    }
  }

  /** Read through the common logical resolver, preserving the optional-absence contract of this backend. */
  read(id: ObjectId): StoredObject | undefined {
    try { return new ObjectStore(join(this.directory, "..")).read(id); } catch (error) {
      if (error instanceof ObjectStoreError && error.code === "object_not_found") return undefined;
      throw error;
    }
  }

  /** Exact inventory rereads also use the common generation and denial protocol. */
  readAt(id: ObjectId, path: string): StoredObject { return new ObjectStore(join(this.directory, "..")).readInventoryObject(id, path); }

  /** Enumerate verified pack metadata without decoding members or trusting paths after descriptor release. @internal */
  locations(): { id: ObjectId; path: string }[] {
    const result: { id: ObjectId; path: string }[] = [];
    for (const path of this.files()) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const index = this.index(fd, path);
        if (digest(range(fd, 0, index.bytes)) !== basename(path, ".pack")) corrupt();
        for (const entry of index.entries) result.push({ id: entry[0], path });
      } finally { closeSync(fd); }
    }
    return result;
  }

  /** Verified physical pack inventory shares the logical resolver and never scans loose temporaries. */
  *inventory(): Generator<InventoryEntry> { yield* new ObjectStore(join(this.directory, "..")).walkPackedInventory(); }

  /** Remove only recognized owned staging jobs; authoritative source representations always precede staging. */
  recover(): void {
    if (!existsSync(this.directory)) return;
    if (!lstatSync(this.directory).isDirectory()) corrupt();
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^job-[0-9a-f]{24}$/.test(entry.name)) continue;
      const path = join(this.directory, entry.name);
      const marker = join(path, "owner");
      if (!lstatSync(marker, { throwIfNoEntry: false })?.isFile() || readFileSync(marker, "utf8") !== `pm-vcs-pack-1 ${entry.name}\n`) continue;
      this.cleanupJob(path); packBoundary.visit("recovered");
    }
  }

  /** Publish one complete pack durably before deleting any loose source, in bounded deterministic batches. */
  compact(store: ObjectStore): PackReport {
    return store.withWriteLock(() => {
      this.assertRoot(store);
      if (store.denials().some((denial) => denial.pending)) throw new PackRefusal("pack_erasure_pending", "Authorized erasure is incomplete.", "Resume the authorized obliterate command before compacting.");
      this.recover();
      const skipped: { name: string; reason: string }[] = [];
      const before = this.files(skipped);
      // Preflight all published storage, including members that have duplicate loose representations.
      for (const item of store.walkErasureInventory("pack")) void item;
      let objects = 0; let looseBytes = 0;
      // Resume a published pack by retiring its duplicate loose copies, instead of building overlapping packs.
      for (const item of store.walkErasureInventory("pack")) {
        const path = join(store.storageRoot(), item.id.slice(0, 2), item.id.slice(2));
        if (!existsSync(path)) continue;
        store.readInventoryObject(item.id, path);
        store.markStorageGeneration(); looseBytes += lstatSync(path).size; durability.unlink(path); syncDirectory(join(store.storageRoot(), item.id.slice(0, 2))); objects++; packBoundary.visit("retired");
      }
      let batch: { id: ObjectId; path: string; object: StoredObject }[] = []; let size = 0;
      const flush = (): void => {
        if (batch.length === 0) return;
        const entries: Entry[] = []; const chunks: Buffer[] = []; let offset = 0;
        for (const item of batch.sort((a, b) => a.id.localeCompare(b.id))) {
          const compressed = deflateSync(frameObject(item.object.type, item.object.payload), { level: 9 });
          entries.push([item.id, offset, compressed.length, item.object.type]); chunks.push(compressed); offset += compressed.length;
        }
        const index = Buffer.from(JSON.stringify(entries)); const header = Buffer.alloc(12); MAGIC.copy(header); header.writeUInt32BE(index.length, 8);
        const bytes = Buffer.concat([header, index, ...chunks]); const destination = join(this.directory, `${digest(bytes)}.pack`);
        const job = this.publish(bytes, destination, store);
        // The verified immutable destination is now the authority; interruptions merely leave duplicate sources.
        for (const item of batch) { looseBytes += lstatSync(item.path).size; durability.unlink(item.path); syncDirectory(join(store.storageRoot(), item.id.slice(0, 2))); objects++; packBoundary.visit("retired"); }
        this.cleanupJob(job); packBoundary.visit("cleaned");
        batch = []; size = 0;
      };
      for (const item of store.walkLooseInventory(skipped)) {
        const cost = item.object.payload.length + 256;
        if (cost > LIMIT) { skipped.push({ name: item.id, reason: "object exceeds the 16 MiB pack bound; retained loose" }); continue; }
        if (size + cost > LIMIT) flush();
        batch.push(item); size += cost;
      }
      flush();
      const late: { name: string; reason: string }[] = [];
      const after = this.files(late);
      const known = new Set(skipped.map((entry) => entry.name));
      for (const entry of late) if (!known.has(entry.name)) { skipped.push(entry); known.add(entry.name); }
      return { objects, packs: after.length - before.length, looseBytes, packBytes: after.filter((path) => !before.includes(path)).reduce((sum, path) => sum + lstatSync(path).size, 0), skippedCount: skipped.length, omittedSkipped: Math.max(0, skipped.length - 20), skipped: skipped.slice(0, 20) };
    });
  }

  /** Write an owned staging job, then publish its payload by exclusive link; an existing verified peer result is success. */
  private publish(bytes: Buffer, destination: string, store: ObjectStore): string {
    store.markStorageGeneration();
    mkdirSync(this.directory, { recursive: true }); syncDirectory(store.storageRoot()); packBoundary.visit("directory");
    const job = join(this.directory, `job-${randomBytes(12).toString("hex")}`); mkdirSync(job); packBoundary.visit("job");
    this.durableFile(join(job, "owner"), Buffer.from(`pm-vcs-pack-1 ${basename(job)}\n`)); syncDirectory(job); syncDirectory(this.directory); packBoundary.visit("owner");
    const staged = join(job, "payload"); this.durableFile(staged, bytes); syncDirectory(job); packBoundary.visit("staged");
    try { durability.link(staged, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lstatSync(destination).isFile() || !readFileSync(destination).equals(bytes)) corrupt();
    }
    syncDirectory(this.directory); syncDirectory(join(destination, "..")); packBoundary.visit("published");
    return job;
  }

  /** Retire only package-owned regular staging leaves; foreign children keep their directory and are reported by files(). */
  private cleanupJob(job: string): void {
    // Payload goes first: a crash after marker retirement must never leave unmarked owned bytes.
    for (const name of ["payload", "owner"]) {
      const path = join(job, name);
      if (lstatSync(path, { throwIfNoEntry: false })?.isFile() === true) { durability.unlink(path); syncDirectory(job); packBoundary.visit(`staging-${name}-retired`); }
    }
    try { durability.removeDirectory(job); packBoundary.visit("staging-job-retired"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
    syncDirectory(this.directory);
  }

  /** Reject aliases before recovery can touch a store protected by a different lexical lease path. */
  private assertRoot(store: ObjectStore): void {
    const root = lstatSync(store.storageRoot(), { throwIfNoEntry: false });
    if (root !== undefined && !root.isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Pack maintenance requires a real object directory. Use the repository's real object directory and retry.");
  }

  /** Persist one owned staging file and close it even if durability fails. */
  private durableFile(path: string, bytes: Buffer): void {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); durability.file(fd); } finally { closeSync(fd); }
  }

  /** Materialize verified loose copies before retiring packs; erasure can then use its existing physical deletion proof. */
  unpack(store: ObjectStore): void {
    store.withWriteLock(() => {
      this.assertRoot(store);
      this.recover();
      // Finish complete verification before representation changes, then retain only one leaf buffer per copy.
      for (const item of store.walkErasureInventory("pack")) void item;
      for (const item of store.walkErasureInventory("pack")) {
        const directory = join(store.storageRoot(), item.id.slice(0, 2)); mkdirSync(directory, { recursive: true });
        const destination = join(directory, item.id.slice(2));
        if (!existsSync(destination)) {
          const job = this.publish(deflateSync(frameObject(item.object.type, item.object.payload)), destination, store);
          this.cleanupJob(job); packBoundary.visit("cleaned");
        } else store.readInventoryObject(item.id, destination);
        syncDirectory(directory); packBoundary.visit("unpacked");
      }
      for (const path of this.files()) { store.markStorageGeneration(); durability.unlink(path); this.indexes.delete(path); syncDirectory(this.directory); packBoundary.visit("pack-retired"); }
    });
  }
}
