/** Immutable indexed packs: independently compressed frames keep their uncompressed addresses. */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { ObjectStoreError } from "./object-error.ts";
import { syncDirectory } from "./composition.ts";
import { frameObject, hashObject, isObjectId, OBJECT_TYPES, parseFramedObject, type InventoryEntry, type ObjectId, type ObjectStore, type ObjectType, type StoredObject } from "./objects.ts";

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
      else skipped.push({ name: entry.name, reason: "foreign or unpublished storage; left untouched" });
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

  /** Pin an index/member lookup for presence hints and fully verified reads. */
  private access<T>(id: ObjectId, use: (fd: number, index: Index, entry: Entry) => T): T | undefined {
    for (const path of this.files()) {
      let fd: number;
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        const index = this.index(fd, path);
        const entry = index.byId.get(id);
        if (entry !== undefined) return use(fd, index, entry);
      } finally { closeSync(fd); }
    }
    return undefined;
  }

  /** Presence is an indexed hint; callers needing integrity use read or the complete inventory. */
  has(id: ObjectId): boolean { return this.access(id, () => true) === true; }

  /** Object kind is an index hint until a full member read verifies framing and digest. */
  type(id: ObjectId): ObjectType | undefined { return this.access(id, (_fd, _index, entry) => entry[3]); }

  /** Read only one pinned compressed range and verify its logical address. */
  read(id: ObjectId): StoredObject | undefined { return this.access(id, (fd, index, entry) => this.member(fd, index, entry)); }

  /** Re-read an exact inventoried representation, without applying logical erasure denials. */
  readAt(id: ObjectId, path: string): StoredObject {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const index = this.index(fd, path); const entry = index.byId.get(id);
      if (entry === undefined) corrupt();
      return this.member(fd, index, entry);
    } finally { closeSync(fd); }
  }

  /** Inflate and hash a single indexed frame, bounding both compressed and uncompressed allocation. */
  private member(fd: number, index: Index, entry: Entry): StoredObject {
    let framed: Buffer;
    try { framed = inflateSync(range(fd, index.start + entry[1], entry[2]), { maxOutputLength: LIMIT }); } catch { corrupt(); }
    const object = parseFramedObject(framed);
    if (object.type !== entry[3] || hashObject(object.type, object.payload) !== entry[0]) corrupt();
    return object;
  }

  /** Verify the physical pack digest and every member before inventory, GC or erasure relies on it. */
  *inventory(): Generator<InventoryEntry> {
    for (const path of this.files()) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const index = this.index(fd, path);
        if (digest(range(fd, 0, index.bytes)) !== basename(path, ".pack")) corrupt();
        for (const entry of index.entries) yield { id: entry[0], path, packed: { offset: index.start + entry[1], length: entry[2] }, bytes: entry[2] + (entry === index.entries[0] ? index.start : 0), object: this.member(fd, index, entry) };
      } finally { closeSync(fd); }
    }
  }

  /** Remove only recognized owned staging jobs; authoritative source representations always precede staging. */
  recover(): void {
    if (!existsSync(this.directory)) return;
    if (!lstatSync(this.directory).isDirectory()) corrupt();
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^job-[0-9a-f]{24}$/.test(entry.name)) continue;
      const path = join(this.directory, entry.name);
      const marker = join(path, "owner");
      if (!lstatSync(marker, { throwIfNoEntry: false })?.isFile() || readFileSync(marker, "utf8") !== `pm-vcs-pack-1 ${entry.name}\n`) continue;
      const children = readdirSync(path, { withFileTypes: true });
      if (children.some((child) => !child.isFile() || !["owner", "payload"].includes(child.name))) continue;
      rmSync(path, { recursive: true }); syncDirectory(this.directory); packBoundary.visit("recovered");
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
      for (const item of this.inventory()) void item;
      let objects = 0; let looseBytes = 0;
      // Resume a published pack by retiring its duplicate loose copies, instead of building overlapping packs.
      for (const item of this.inventory()) {
        const path = join(store.storageRoot(), item.id.slice(0, 2), item.id.slice(2));
        if (!existsSync(path)) continue;
        store.readInventoryObject(item.id, path);
        looseBytes += lstatSync(path).size; unlinkSync(path); syncDirectory(join(store.storageRoot(), item.id.slice(0, 2))); objects++; packBoundary.visit("retired");
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
        for (const item of batch) { looseBytes += lstatSync(item.path).size; unlinkSync(item.path); syncDirectory(join(store.storageRoot(), item.id.slice(0, 2))); objects++; packBoundary.visit("retired"); }
        rmSync(job, { recursive: true }); syncDirectory(this.directory); packBoundary.visit("cleaned");
        batch = []; size = 0;
      };
      for (const item of store.walkLooseInventory(skipped)) {
        if (item.path.endsWith(".tmp")) { skipped.push({ name: item.id, reason: "loose write temporary; retained for its writer" }); continue; }
        const cost = item.object.payload.length + 256;
        if (cost > LIMIT) { skipped.push({ name: item.id, reason: "object exceeds the 16 MiB pack bound; retained loose" }); continue; }
        if (size + cost > LIMIT) flush();
        batch.push(item); size += cost;
      }
      flush();
      const after = this.files();
      return { objects, packs: after.length - before.length, looseBytes, packBytes: after.filter((path) => !before.includes(path)).reduce((sum, path) => sum + lstatSync(path).size, 0), skippedCount: skipped.length, omittedSkipped: Math.max(0, skipped.length - 20), skipped: skipped.slice(0, 20) };
    });
  }

  /** Write an owned staging job, then publish its payload by exclusive link; an existing verified peer result is success. */
  private publish(bytes: Buffer, destination: string, store: ObjectStore): string {
    mkdirSync(this.directory, { recursive: true }); syncDirectory(store.storageRoot()); packBoundary.visit("directory");
    const job = join(this.directory, `job-${randomBytes(12).toString("hex")}`); mkdirSync(job); packBoundary.visit("job");
    this.durableFile(join(job, "owner"), Buffer.from(`pm-vcs-pack-1 ${basename(job)}\n`)); syncDirectory(job); syncDirectory(this.directory); packBoundary.visit("owner");
    const staged = join(job, "payload"); this.durableFile(staged, bytes); syncDirectory(job); packBoundary.visit("staged");
    try { linkSync(staged, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lstatSync(destination).isFile() || !readFileSync(destination).equals(bytes)) corrupt();
    }
    syncDirectory(this.directory); syncDirectory(join(destination, "..")); packBoundary.visit("published");
    return job;
  }

  /** Reject aliases before recovery can touch a store protected by a different lexical lease path. */
  private assertRoot(store: ObjectStore): void {
    const root = lstatSync(store.storageRoot(), { throwIfNoEntry: false });
    if (root !== undefined && !root.isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Pack maintenance requires a real object directory. Use the repository's real object directory and retry.");
  }

  /** Persist one owned staging file and close it even if durability fails. */
  private durableFile(path: string, bytes: Buffer): void {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  }

  /** Materialize verified loose copies before retiring packs; erasure can then use its existing physical deletion proof. */
  unpack(store: ObjectStore): void {
    store.withWriteLock(() => {
      this.assertRoot(store);
      this.recover();
      // Finish complete verification before representation changes, then retain only one leaf buffer per copy.
      for (const item of this.inventory()) void item;
      for (const item of this.inventory()) {
        const directory = join(store.storageRoot(), item.id.slice(0, 2)); mkdirSync(directory, { recursive: true });
        const destination = join(directory, item.id.slice(2));
        if (!existsSync(destination)) {
          const job = this.publish(deflateSync(frameObject(item.object.type, item.object.payload)), destination, store);
          rmSync(job, { recursive: true }); syncDirectory(this.directory); packBoundary.visit("cleaned");
        } else store.readInventoryObject(item.id, destination);
        syncDirectory(directory); packBoundary.visit("unpacked");
      }
      for (const path of this.files()) { unlinkSync(path); this.indexes.delete(path); syncDirectory(this.directory); packBoundary.visit("pack-retired"); }
    });
  }
}
