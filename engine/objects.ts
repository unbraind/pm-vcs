import { destructionBoundary, measureDestructionRevision } from "./destruction.ts";
import { objectFiles, type ObjectFile } from "./object-files.ts";
import { durability } from "./durability.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readPartialState, type PartialState } from "./partial.ts";
import { RemoteStore } from "./remotes.ts";
import { objectPayloadChunks, objectPayloadLines } from "./object-stream.ts";
// Content-addressed object store.
//
// Eight object kinds are framed identically — `<type> <byteLength>\0<payload>` —
// and named by the SHA-256 of that whole frame. Including the type and length in
// the hashed bytes is what stops a blob whose content happens to spell a valid
// tree from colliding with that tree: the frames differ, so the ids differ.
//
// Ordinary writes are immutable. Authorized FileId obliteration permanently
// removes payloads and preserves typed intentional absence; undo restores refs
// but cannot restore erased bytes. Existing live objects still deduplicate.

import { constants as zlibConstants, deflateSync, inflateSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import {
  type BigIntStats,
  constants as fsConstants,
  fstatSync,
  existsSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { resolveObjectsControl } from "./instance-link.ts";
import { decodeManifest, decodeTree } from "./model.ts";
import { encodeTombstone, assertArrivalsAllowed, readDenials, type ErasureDenial, type ObjectArrival } from "./lifecycle.ts";
import { writePrivateJson } from "./composition.ts";
import { PackStorage, PackRefusal, type PackReport, packBoundary } from "./packs.ts";

/** Synchronous store handles addressing one root share reentrancy; independent processes still use the exclusive filesystem lease. */
const activeLeases = new Set<string>();
/** Read-only recovery views may inspect physical storage, but cannot publish a generation. */
const validationLeases = new Set<string>();
/** An acquired recovery guard excludes ordinary writers until its validated action releases last. */
const recoveryLeases = new Set<string>();
/** A failed local cleanup may leave a closed, provably self-owned guard while its process remains alive. */
const recoveryOwners = new Map<string, BigIntStats>();
/** Nested synchronous mutations advance the owning process's transaction view without extra disk writes. */
const activeRevisions = new Map<string, number>();
/** Only a real representation or denial mutation publishes a persistent generation. */
const dirtyLeases = new Set<string>();
/** Maximum attempts to resolve a stable absence or a pinned immutable representation. */
export const OBJECT_READ_RETRIES = 8;
/** Reader interleaving seam; ordinary consumers receive no hooks. @internal */
export const objectReadBoundary: { visit(step: string, id: string, attempt: number): void } = { visit() {} };
/** Pinned descriptor and exact compressed range; ownership transfers to the consuming synchronous scope or iterator. @internal */
export interface ObjectHandle extends ObjectFile {
  readonly path: string;
  readonly offset: number;
  readonly length: number;
  readonly regular: boolean;
  readonly type?: ObjectType;
  readonly packed?: { readonly offset: number; readonly length: number };
  readonly bytes?: number;
  readonly maxFrameBytes?: number;
}
/** A resolved handle carries its generation and a terminal-denial check. @internal */
export interface ObjectLocation extends ObjectHandle {
  readonly generation: string;
  readonly check: () => void;
  /** Verify decoded kind and declared frame size against physical pack invariants. */
  readonly validateFrame: (type: string, framedBytes: number) => void;
}
/** A lease generation covers both the pack catalog and every loose fan-out. */
interface StorageGeneration { readonly key: string; readonly consistent: boolean; readonly active: boolean }


/** The kinds of object the store can hold. */
export const OBJECT_TYPES = ["blob", "tree", "commit", "record", "series", "manifest", "link", "tombstone", "conflict"] as const;

/** One of the eight object kinds. */
export type ObjectType = (typeof OBJECT_TYPES)[number];

/** A 64-character lowercase hex SHA-256 digest naming an object. */
export type ObjectId = string;

/** A parsed object: its kind and its raw payload, without the frame. */
export interface StoredObject {
  readonly type: ObjectType;
  readonly payload: Buffer;
}

/** One verified physical representation; packed members expose their actual file and compressed byte range. */
export interface InventoryEntry {
  readonly id: ObjectId;
  readonly path: string;
  readonly bytes: number;
  readonly object: StoredObject;
  readonly packed?: { readonly offset: number; readonly length: number };
}

/** Matches exactly a 64-character lowercase hex string. */
const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;

export { ObjectStoreError } from "./object-error.ts";
import { ObjectStoreError } from "./object-error.ts";

/**
 * Reads one control-directory JSON file, returning the fallback only on ENOENT.
 *
 * Every per-repository and per-instance control file — views, hints, instance
 * registries, remotes — is read through this one shape: absent means "nothing
 * recorded", a parse failure is a typed corruption of the named file, and any
 * other I/O error (permissions, ENOTDIR) passes through raw so the operator
 * sees the real errno instead of a story about the file's content.
 *
 * @param path - The file to read.
 * @param code - Stable error code raised for a parse failure.
 * @param what - What the file is called in messages, for example "view file".
 * @param absent - Value returned only for a missing file; defaults to null for
 *   existing readers. Parsed JSON null never selects this fallback. A caller
 *   needing to distinguish absence can supply its valid empty registry value
 *   without a separate existence probe or a second read.
 * @returns The parsed JSON value, or `absent` when the file does not exist.
 * @throws ObjectStoreError When the file exists but is not valid JSON.
 */
export function readControlJson(path: string, code: string, what: string, absent: unknown = null): unknown {
  let contents: string;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new ObjectStoreError(code, `The ${what} cannot be a symbolic link.`);
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return absent;
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new ObjectStoreError(code, `The ${what} at ${path} is not valid JSON.`);
  }
}

/**
 * Validates a caller-chosen single-segment name a registry keys on.
 *
 * Instance names and remote names obey one rule set — never empty, never a
 * relative path segment, never a path separator, whitespace, control
 * character, or a character reserved in refs — because both become registry
 * keys and both appear in command output where ambiguity is unaffordable.
 *
 * @param name - Candidate name.
 * @param code - Stable error code raised on rejection.
 * @param kind - What the name names, for example "Instance", in messages.
 * @throws ObjectStoreError When the name breaks any rule above.
 */
export function assertRegistryName(name: string, code: string, kind: string): void {
  const reject = (reason: string): never => {
    throw new ObjectStoreError(code, `${kind} name "${name}" is invalid: ${reason}`);
  };
  if (name.length === 0) reject("it is empty");
  if (name === "." || name === "..") reject("it is a relative path segment");
  if (name.includes("/") || name.includes("\\")) reject("it contains a path separator");
  if (/[\u0000-\u0020\u007f~^:?*[\]]/.test(name)) {
    reject("it contains whitespace, a control character, or one of ~^:?*[]");
  }
}

/**
 * Whether a string is well-formed as an object id.
 *
 * Callers use this to reject user input before it reaches the filesystem —
 * an id is interpolated into a path, so anything that is not 64 hex characters
 * must never get that far.
 *
 * @param value - Candidate id.
 * @returns True when the value is exactly 64 lowercase hex characters.
 */
export function isObjectId(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value);
}

/**
 * Builds the framed byte sequence that an object's id is computed over.
 *
 * @param type - The object kind.
 * @param payload - The object's raw content.
 * @returns `<type> <byteLength>\0<payload>` as a single buffer.
 */
export function frameObject(type: ObjectType, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${payload.length}\0`, "utf8"), payload]);
}

/**
 * Computes the id an object would be stored under.
 *
 * Pure, so callers can name content without a repository — the bundle importer
 * uses it to verify that what a bundle claims an object is called matches what
 * its bytes actually hash to.
 *
 * @param type - The object kind.
 * @param payload - The object's raw content.
 * @returns The 64-character hex SHA-256 of the framed object.
 */
export function hashObject(type: ObjectType, payload: Buffer): ObjectId {
  // Hashing incrementally over the header and payload avoids allocating a
  // single concatenated frame buffer, which matters when many fragments are
  // hashed in a tight loop: the concatenation would be one buffer per
  // fragment, and V8 would not collect them until the loop ends. SHA-256 is
  // additive, so `update(header).update(payload)` produces the same digest as
  // `update(Buffer.concat([header, payload]))`.
  const hash = createHash("sha256");
  hash.update(`${type} ${payload.length}\0`, "utf8");
  hash.update(payload);
  return hash.digest("hex");
}

/**
 * Splits a framed object back into its kind and payload.
 *
 * @param framed - The complete framed bytes as produced by {@link frameObject}.
 * @returns The parsed kind and payload.
 * @throws ObjectStoreError When the header is absent or malformed, the kind is
 *   not one of the four, or the declared length disagrees with the payload — any
 *   of which means the bytes are not a valid object.
 */
export function parseFramedObject(framed: Buffer): StoredObject {
  const separator = framed.indexOf(0);
  if (separator === -1) {
    throw new ObjectStoreError("malformed_object", "Object frame has no NUL separating header from payload.");
  }
  const header = framed.subarray(0, separator).toString("utf8");
  const space = header.indexOf(" ");
  if (space === -1) {
    throw new ObjectStoreError("malformed_object", `Object header "${header}" is missing the length field.`);
  }
  const type = header.slice(0, space);
  if (!(OBJECT_TYPES as readonly string[]).includes(type)) {
    throw new ObjectStoreError("malformed_object", `Object header declares unknown type "${type}".`);
  }
  const declaredLength = header.slice(space + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
    throw new ObjectStoreError("malformed_object", `Object header declares a non-numeric length "${declaredLength}".`);
  }
  const payload = framed.subarray(separator + 1);
  if (payload.length !== Number(declaredLength)) {
    throw new ObjectStoreError(
      "malformed_object",
      `Object header declares ${declaredLength} bytes but the payload is ${payload.length}.`,
    );
  }
  return { type: type as ObjectType, payload };
}

/**
 * Loose object database rooted at a directory.
 *
 * Objects live at `<root>/<first 2 hex>/<remaining 62 hex>`, zlib-deflated. The
 * two-character fan-out keeps any one directory from growing to the full object
 * count, which matters on filesystems whose directory lookup degrades with size.
 */
export class ObjectStore {
  /** Absolute path to the directory holding the fan-out subdirectories. */
  private readonly root: string;
  private readonly packs: PackStorage;
  /** Validated immutable denials and address indexes follow the registry's filesystem identity. */
  private denialCache?: { signature: string; entries: ErasureDenial[]; objects: Map<ObjectId, ErasureDenial>; files: Map<string, ErasureDenial> };

  /**
   * @param root - Directory that holds the object fan-out. Created on demand.
   */
  constructor(root: string) {
    this.root = root;
    this.packs = new PackStorage(root);
  }

  /**
   * Absolute path an object id maps to.
   *
   * @param id - A validated object id.
   * @returns The path, which may or may not exist.
   */
  private pathFor(id: ObjectId): string {
    return join(this.root, id.slice(0, 2), id.slice(2));
  }

  /** Check current terminal absence immediately before returning bytes or emitting another stream chunk. */
  private assertVisible(id: ObjectId): void {
    const denial = this.denial(id);
    if (denial !== undefined) throw new ObliteratedObjectError(id, denial.id);
  }

  /** Publish a version before the first real object/denial mutation, retaining pure preflight and no-op behavior. @internal */
  markStorageGeneration(): void {
    const lease = resolve(this.root);
    if (validationLeases.has(lease)) throw new ObjectStoreError("destructive_preflight_write", "A recovery preflight cannot publish or delete storage.");
    if (!activeLeases.has(lease)) throw new ObjectStoreError("store_locked", "A storage generation can change only inside its owning writer lease.");
    activeRevisions.set(lease, activeRevisions.get(lease)! + 1);
    if (dirtyLeases.has(lease)) return;
    writePrivateJson(join(dirname(this.root), "objects.generation"), randomBytes(16).toString("hex"));
    dirtyLeases.add(lease);
    packBoundary.visit("storage-generation");
  }

  /** Read a consistent transaction marker; legacy stores start in an absent generation. */
  private storageGeneration(): StorageGeneration {
    const lease = resolve(this.root);
    if (activeLeases.has(lease)) return { key: `owned:${activeRevisions.get(lease)}`, consistent: true, active: false };
    const marker = join(dirname(this.root), "objects.generation");
    const first = readControlJson(marker, "bad_storage_generation", "object storage generation", null);
    const writer = lstatSync(join(dirname(this.root), "objects.lock"), { bigint: true, throwIfNoEntry: false });
    objectReadBoundary.visit("generation-marker", "*", 0);
    const last = readControlJson(marker, "bad_storage_generation", "object storage generation", null);
    if (last !== null && (typeof last !== "string" || !/^[0-9a-f]{32}$/.test(last))) throw new ObjectStoreError("bad_storage_generation", "Storage generation is invalid; restore its verified metadata before retrying.");
    return { key: `${String(last)}:${writer === undefined ? "idle" : `${writer.dev}:${writer.ino}`}`, consistent: first === last, active: writer !== undefined };
  }

  /** Open one exact loose representation without decoding its payload or following a leaf link. */
  private openLooseLocation(path: string): ObjectHandle | undefined {
    let file: ObjectFile;
    try { file = objectFiles.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const stat = fstatSync(file.fd);
      return { ...file, path, offset: 0, length: stat.size, regular: stat.isFile() };
    } catch (error) { file.close(); throw error; }
  }

  /**
   * Resolve every reader through one generation protocol and transfer one opened immutable handle.
   * Only an unchanged idle generation proves absence. A changing store gets at most eight full retries.
   * Physical inventory may inspect denied bytes only inside the existing owning writer lease.
   * @internal
   */
  resolveLocation(id: ObjectId, options: { path?: string; standalone?: boolean; physical?: boolean } = {}): ObjectLocation | undefined {
    this.assertId(id);
    const physical = options.physical === true && activeLeases.has(resolve(this.root));
    if (options.physical === true && !physical) throw new ObjectStoreError("physical_read_requires_lease", "Physical erasure inspection requires the owning writer lease.");
    for (let attempt = 0; attempt < OBJECT_READ_RETRIES; attempt++) {
      const before = options.standalone ? { key: "standalone", consistent: true, active: false } : this.storageGeneration();
      objectReadBoundary.visit("generation", id, attempt);
      if (!physical && !options.standalone) this.assertVisible(id);
      if (!before.consistent) continue;
      let location: ObjectHandle | undefined;
      try {
        const exactPack = options.path !== undefined && dirname(options.path) === join(this.root, "packs") && /^[0-9a-f]{64}\.pack$/.test(basename(options.path));
        location = exactPack ? this.packs.locate(id, options.path) : this.openLooseLocation(options.path ?? this.pathFor(id));
        if (location === undefined && options.path !== undefined && !options.standalone && options.path !== this.pathFor(id)) location = this.openLooseLocation(this.pathFor(id));
        objectReadBoundary.visit("loose", id, attempt);
        if (location === undefined && !options.standalone) location = this.packs.locate(id);
        objectReadBoundary.visit("resolved", id, attempt);
        const after = options.standalone ? before : this.storageGeneration();
        if (!after.consistent || before.key !== after.key || (location === undefined && (before.active || after.active))) {
          if (location !== undefined) location.close();
          continue;
        }
        if (location === undefined) return undefined;
        const pinned = location;
        const check = () => { objectReadBoundary.visit("pinned-check", id, attempt); if (!physical && !options.standalone) this.assertVisible(id); };
        objectReadBoundary.visit("pinned", id, attempt);
        check();
        return { ...pinned, generation: after.key, check,
          /** Apply the same physical invariants to full, bounded and streamed decoding. */
          validateFrame(type, framedBytes) {
            if ((pinned.type !== undefined && pinned.type !== type) || (pinned.maxFrameBytes !== undefined && framedBytes > pinned.maxFrameBytes)) {
              throw new PackRefusal("corrupt_pack", "Pack member kind or decoded size disagrees with its format.", "Restore a verified pack before retrying.");
            }
          },
        };
      } catch (error) {
        if (location !== undefined) location.close();
        const after = options.standalone ? before : this.storageGeneration();
        if (before.key !== after.key || !after.consistent) continue;
        throw error;
      }
    }
    throw new ObjectStoreError("object_store_changing", `Object location changed during ${OBJECT_READ_RETRIES} attempts; retry when storage maintenance completes. No stable absence was observed.`);
  }

  /** Consume one pinned location, enforcing terminal denials before and after the read. */
  private withLocation<T>(id: ObjectId, read: (location: ObjectLocation) => T, options: { path?: string; physical?: boolean; hydrate?: boolean } = {}): T {
    let location = this.resolveLocation(id, options);
    if (location === undefined && options.hydrate === true) { this.hydrate(id); location = this.resolveLocation(id, options); }
    if (location === undefined) throw new ObjectStoreError("object_not_found", `No object ${id} in a stable storage generation; fetch a verified copy before retrying.`);
    try { location.check(); const result = read(location); location.check(); return result; } finally { location.close(); }
  }

  /** Read an exact compressed member from its pinned descriptor, independent of subsequent namespace changes. */
  private compressed(location: ObjectLocation): Buffer {
    if (location.packed === undefined) return readFileSync(location.fd);
    const bytes = Buffer.alloc(location.length); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(location.fd, bytes, offset, bytes.length - offset, location.offset + offset);
      if (count === 0) throw new ObjectStoreError("corrupt_object", "Pinned compressed object was truncated.");
      offset += count;
    }
    return bytes;
  }

  /** Verify one complete immutable frame without performing a second path lookup. */
  private readLocation(id: ObjectId, location: ObjectLocation): StoredObject {
    try {
      let framed: Buffer;
      try { framed = inflateSync(this.compressed(location), { maxOutputLength: location.maxFrameBytes }); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== undefined && !code.startsWith("Z_") && !(code === "ERR_BUFFER_TOO_LARGE" && location.maxFrameBytes !== undefined)) throw error;
        throw new ObjectStoreError("corrupt_object", `Object ${id} could not be decompressed.`);
      }
      const parsed = parseFramedObject(framed);
      location.validateFrame(parsed.type, framed.length);
      const actual = hashObject(parsed.type, parsed.payload);
      if (actual !== id) throw new ObjectStoreError("corrupt_object", `Object ${id} contains content that hashes to ${actual}.`);
      return parsed;
    } catch (error) {
      if (location.packed !== undefined && error instanceof ObjectStoreError) throw new PackRefusal("corrupt_pack", "Pack member failed verification.", "Restore a verified pack before retrying.");
      throw error;
    }
  }

  /**
   * Whether the store already holds an object.
   *
   * @param id - Object id to look for.
   * @returns True when the object is present.
   * @throws ObjectStoreError When the id is not well-formed.
   */
  has(id: ObjectId): boolean {
    try {
      const location = this.resolveLocation(id);
      if (location === undefined) return false;
      try { location.check(); return location.regular; } finally { location.close(); }
    } catch (error) { if (error instanceof ObliteratedObjectError) return false; throw error; }
  }

  /** Object storage root for representation backends; callers must retain the shared writer lease for mutations. */
  storageRoot(): string { return this.root; }

  /** Compact verified loose frames under the shared writer lease, preserving all logical identities. */
  compact(): PackReport { return this.packs.compact(this); }

  /** Restore loose representations durably before authorized erasure or a packed sweep. */
  unpack(): void { this.packs.unpack(this); }

  /**
   * Writes an object, or does nothing if its content is already stored.
   *
   * The write goes to a uniquely named temporary file in the destination
   * directory and is fsynced before being renamed into place. Rename within a
   * directory is atomic, so a reader either sees no object or sees the complete
   * one — a crash mid-write cannot leave truncated bytes under a valid id, which
   * would otherwise be indistinguishable from corruption forever after.
   *
   * @param type - The object kind.
   * @param payload - The object's raw content.
   * @param fileId - Owning stable file identity for a locally produced payload.
   *   Optional before erasure and for structural objects; blob, record and
   *   manifest writes require it once a denial exists. Attribution never skips
   *   denied-byte/representation inspection or permits a denied identity.
   * @returns The id the content is stored under.
   */
  write(type: ObjectType, payload: Buffer, fileId?: string): ObjectId {
    return this.withWriteLock(/** Check permanent denial while holding the publication lock. */ () => {
      const id = hashObject(type, payload);
      this.preflight([{ type, payload, id }], fileId !== undefined);
      if (fileId !== undefined && this.cachedDenials().files.has(fileId)) {
        throw new ObjectStoreError("file_obliterated", "This FileId is permanently denied.");
      }
      return this.writeRaw(type, payload);
    });
  }

  /** Publish preflighted bytes while a transaction already holds the store lock. */
  private writeRaw(type: ObjectType, payload: Buffer): ObjectId {
    const id = hashObject(type, payload);
    if (this.has(id)) return id;
    this.markStorageGeneration();
    const destination = this.pathFor(id);
    const directory = join(this.root, id.slice(0, 2));
    mkdirSync(directory, { recursive: true });
    const compressed = deflateSync(frameObject(type, payload), { level: zlibConstants.Z_BEST_SPEED });
    // The suffix disambiguates concurrent writers of the *same* object: both
    // compute one id, so both would otherwise target one temp path and could
    // rename a partially written file into place.
    const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = objectFiles.open(temporary, "wx");
    try {
      try {
        writeSync(handle.fd, compressed);
        durability.file(handle.fd);
      } finally {
        handle.close();
      }
      durability.rename(temporary, destination);
    } catch (error) {
      durability.remove(temporary, { force: true });
      throw error;
    }
    return id;
  }

  /**
   * Reads an object and verifies it hashes to the id it was stored under.
   *
   * The verification is not redundant with the frame check: a frame can stay
   * structurally valid while its bytes rot, and silently returning altered
   * content is the one failure a content-addressed store must never have.
   *
   * Only `ENOENT` means absent. Any other errno — a permission denial, a
   * directory where an object file belongs, a failing disk — is re-raised
   * unchanged, because reporting it as `object_not_found` would tell an operator
   * their history had lost objects when in fact the store was merely unreadable.
   * Those two conditions call for opposite responses: one is repaired by
   * re-fetching history, the other by fixing the machine.
   *
   * @param id - Object id to read.
   * @returns The object's kind and payload.
   * @throws ObjectStoreError When the id is malformed, the object is absent, its
   *   compressed bytes will not inflate, or its content does not hash to `id`.
   * @throws Error The underlying I/O error, when the object cannot be read for
   *   any reason other than being absent.
   */
  read(id: ObjectId): StoredObject {
    this.assertId(id);
    return this.withLocation(id, (location) => this.readLocation(id, location), { hydrate: true });
  }

  /**
   * Read a matching kind or alternative kinds in one prefix scan for a partial listing, advancing in 64-byte compressed chunks until the header is available.
   * This prefix is a hint, never closure evidence: matching objects still undergo full frame and hash verification.
   * Inflated output is capped at 4 KiB per attempt. A 64 KiB compressed-input budget exhaustion raises
   * object_prefix_limit rather than silently hiding an ambiguous object. Missing or malformed prefixes are omitted;
   * operational I/O failures remain visible. Ordinary recognizable unrelated objects avoid full payload reads.
   */
  readIfType(id: ObjectId, type: ObjectType, alternatives: readonly ObjectType[] = []): StoredObject | undefined {
    try {
      const location = this.resolveLocation(id);
      if (location === undefined) return undefined;
      try {
        const result = this.locationHasType(id, location, type, alternatives) ? this.readLocation(id, location) : undefined;
        location.check(); return result;
      } finally { location.close(); }
    } catch (error) { if (error instanceof ObliteratedObjectError) return undefined; throw error; }
  }

  /** Hint at an object's kind using bounded prefix decoding; never a substitute for verified object reads. */
  hasType(id: ObjectId, type: ObjectType, alternatives: readonly ObjectType[] = []): boolean {
    try {
      const location = this.resolveLocation(id);
      if (location === undefined) return false;
      try { const result = this.locationHasType(id, location, type, alternatives); location.check(); return result; } finally { location.close(); }
    } catch (error) { if (error instanceof ObliteratedObjectError) return false; throw error; }
  }

  /** Decode a bounded kind prefix from the same pinned range that later payload reads consume. */
  private locationHasType(id: ObjectId, location: ObjectLocation, type: ObjectType, alternatives: readonly ObjectType[]): boolean {
    if (location.type !== undefined) return [type, ...alternatives].includes(location.type);
    const fd = location.fd;
    let matching = false;
    {
      const bytes = Buffer.alloc(64 * 1024);
      let length = 0;
      for (;;) {
        if (length === bytes.length) throw new ObjectStoreError("object_prefix_limit", `Object ${id} has no recognizable header within the compressed prefix budget.`);
        const count = readSync(fd, bytes, length, Math.min(64, bytes.length - length, location.length - length), location.offset + length);
        if (count === 0) return false;
        length += count;
        let end = length;
        let prefix: Buffer;
        for (;;) {
          try {
            prefix = inflateSync(bytes.subarray(0, end), { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: 4096, chunkSize: 4096 });
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ERR_BUFFER_TOO_LARGE") return false;
            // Back off input, never increase the output budget for a highly compressible payload.
            end -= 1;
          }
        }
        if (prefix.includes(0)) {
          matching = [type, ...alternatives].some((candidate) => /^([a-z]+) (0|[1-9][0-9]*)\0/.exec(prefix.toString("latin1"))?.[1] === candidate);
          break;
        }
        // Any valid frame header fits in 32 bytes: longest kind, a space, at most 16 decimal length digits and NUL.
        if (prefix.length >= 32) return false;
      }
    }
    return matching;
  }

  /** Read a verified small object with bounded compressed input and inflation; larger payloads select streaming compatibility. */
  readBoundedTyped(id: ObjectId, type: ObjectType, limit = 16_384): Buffer {
    this.assertId(id);
    return this.withLocation(id, (location) => {
    const fd = location.fd;
    let compressed: Buffer;
    const size = location.length;
    {
      if (size > limit + 1024) throw new ObjectStoreError("object_payload_limit", "Object requires bounded streaming decoding.");
      compressed = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const count = readSync(fd, compressed, offset, size - offset, location.offset + offset);
        if (count === 0) throw new ObjectStoreError("corrupt_object", "Compressed object was truncated during its bounded read.");
        offset += count;
      }
    }
    let framed: Buffer;
    try { framed = inflateSync(compressed, { maxOutputLength: Math.min(limit + 32, location.maxFrameBytes ?? Number.MAX_SAFE_INTEGER) }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        if (location.maxFrameBytes !== undefined && location.maxFrameBytes <= limit + 32) throw new PackRefusal("corrupt_pack", "Pack member exceeds its decoded frame bound.", "Restore a verified pack before retrying.");
        throw new ObjectStoreError("object_payload_limit", "Object requires bounded streaming decoding.");
      }
      throw new ObjectStoreError("corrupt_object", "Object could not be decompressed.");
    }
    const object = parseFramedObject(framed);
    location.validateFrame(object.type, framed.length);
    if (hashObject(object.type, object.payload) !== id) throw new ObjectStoreError("corrupt_object", "Object does not match its address.");
    if (object.type !== type) throw new ObjectStoreError("object_type_mismatch", "Object has the wrong kind.");
    if (object.payload.length > limit) throw new ObjectStoreError("object_payload_limit", "Object requires bounded streaming decoding.");
    return object.payload;
    }, { hydrate: true });
  }

  /** Stream newline-terminated metadata with bounded decompression, full frame/hash verification and erasure denial enforcement. */
  *readLines(id: ObjectId, type: ObjectType): Generator<string> {
    for (const line of objectPayloadLines(this.readChunks(id, type))) { this.assertVisible(id); yield line; }
  }

  /** Stream a fully verified payload from one opened representation; the iterator owns its descriptor through namespace transitions. */
  *readChunks(id: ObjectId, type: ObjectType, timeoutMs = 30_000): Generator<Buffer> {
    this.assertId(id);
    let location = this.resolveLocation(id);
    if (location === undefined) { this.hydrate(id); location = this.resolveLocation(id); }
    if (location === undefined) throw new ObjectStoreError("object_not_found", `No object ${id} in a stable storage generation; fetch a verified copy before retrying.`);
    yield* objectPayloadChunks(location, id, type, timeoutMs);
  }

  /**
   * Reads an object and requires it to be of a particular kind.
   *
   * @param id - Object id to read.
   * @param type - The kind the caller requires.
   * @returns The object's payload.
   * @throws ObjectStoreError When the object is absent, corrupt, or of another kind.
   */
  readTyped(id: ObjectId, type: ObjectType): Buffer {
    const object = this.read(id);
    if (object.type !== type) {
      throw new ObjectStoreError("object_type_mismatch", `Object ${id} is a ${object.type}, not a ${type}.`);
    }
    return object.payload;
  }

  /** Immutable repository identity, created once on the first explicit request. */
  identity(): string {
    return this.withWriteLock(/** Concurrent explicit identity requests share one atomic creation. */ () => {
      const path = join(dirname(this.root), "identity");
      const recorded = this.recordedIdentity();
      if (recorded !== undefined) return recorded;
      const identity = randomBytes(16).toString("hex");
      writePrivateJson(path, identity);
      return identity;
    });
  }

  /** Read an existing identity without introducing nondeterminism into standalone archives. */
  recordedIdentity(): string | undefined {
    const path = join(dirname(this.root), "identity");
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return undefined;
    const identity = readControlJson(path, "bad_identity", "repository identity");
    if (typeof identity !== "string" || !/^[0-9a-f]{32}$/.test(identity)) throw new ObjectStoreError("bad_identity", "Repository identity is corrupt.");
    return identity;
  }

  /** Adopt an exported identity only into an empty store without an established local identity. */
  adoptIdentity(identity: string): void {
    if (!/^[0-9a-f]{32}$/.test(identity)) throw new ObjectStoreError("bad_identity", "Received repository identity is invalid.");
    this.withWriteLock(/** Empty clones adopt their source identity under the same creation lease. */ () => {
      if (this.recordedIdentity() !== undefined) return;
      if (existsSync(this.root) && (!lstatSync(this.root).isDirectory()
        || readdirSync(this.root, { withFileTypes: true }).some(/** Any unsupported entry or nonempty fan-out already establishes an occupied store. */ (entry) =>
          !entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name) || readdirSync(join(this.root, entry.name)).length > 0))) return;
      writePrivateJson(join(dirname(this.root), "identity"), identity);
    });
  }

  /** Read every durable terminal identity and incomplete cleanup record. */
  denials(): ErasureDenial[] { return [...this.cachedDenials().entries]; }

  /** Revalidate only after replacement or modification; never let mutable callers alter cached authorization. */
  private cachedDenials(): NonNullable<ObjectStore["denialCache"]> {
    const path = join(dirname(this.root), "denials.json");
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    const signature = stat === undefined ? "absent" : `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    if (this.denialCache?.signature === signature) return this.denialCache;
    const entries = readDenials(dirname(this.root));
    const objects = new Map<ObjectId, ErasureDenial>();
    const files = new Map<string, ErasureDenial>();
    for (const entry of entries) {
      Object.freeze(entry.tombstone.roots); Object.freeze(entry.tombstone.objects); Object.freeze(entry.tombstone.payloads);
      Object.freeze(entry.tombstone); Object.freeze(entry);
      files.set(entry.tombstone.fileId, entry);
      for (const id of entry.tombstone.objects) if (!objects.has(id)) objects.set(id, entry);
    }
    this.denialCache = { signature, entries, objects, files };
    return this.denialCache;
  }

  /** Find intentional absence independently of physical object presence. */
  denial(id: ObjectId): ErasureDenial | undefined {
    return this.cachedDenials().objects.get(id);
  }

  /** Inspect present, intentionally absent, missing and damaged content without conflating states. */
  state(id: ObjectId, read?: () => StoredObject): PayloadState {
    try { return { kind: "present", object: this.withLocation(id, (location) => read === undefined ? this.readLocation(id, location) : read(), { hydrate: true }) }; } catch (error) {
      if (error instanceof ObliteratedObjectError) return { kind: "obliterated", tombstone: error.tombstone };
      if (!(error instanceof ObjectStoreError) || error.code === "object_store_changing") throw error;
      return { kind: error.code === "object_not_found" || error.code === "missing_fragment" ? "missing" : "corrupt", code: error.code };
    }
  }

  /** Preflight a complete arrival before storing even its first payload. */
  preflight(objects: readonly ObjectArrival[], attributed: boolean): void {
    assertArrivalsAllowed(this.denials(), objects, attributed);
  }

  /** Store a batch that has passed whole-batch provenance validation under the same lock. */
  accept(objects: readonly ObjectArrival[], attributed: boolean): void {
    this.withWriteLock(/** Prevent erasure from interleaving with arrival preflight and publication. */ () => {
      this.preflight(objects, attributed);
      for (const object of objects) this.writeRaw(object.type, object.payload);
    });
  }

  /** Persist denial durably before deletion; pending cleanup closes every writer. */
  recordDenials(denials: readonly ErasureDenial[]): void {
    this.withWriteLock(/** The durable denial and canonical audit objects publish under the same store lease. */ () => {
      this.markStorageGeneration();
      writePrivateJson(join(dirname(this.root), "denials.json"), denials);
      this.denialCache = undefined;
      for (const denial of denials) this.writeRaw("tombstone", encodeTombstone(denial.tombstone));
    });
  }

  /** Read the shared clone's local omission policy without fetching any objects. */
  partialState(): PartialState | null { return readPartialState(dirname(this.root)); }

  /** Hydrate only a promised missing blob, verifying type and address before cache publication. */
  hydrate(id: ObjectId): void {
    if (this.has(id) || this.denial(id) !== undefined) return;
    const state = this.partialState();
    if (state === null || !state.promised.includes(id)) return;
    const remotes = new RemoteStore(join(dirname(this.root), "remotes.json"));
    const remote = remotes.require(state.remote);
    let object: StoredObject;
    if (/^https?:/i.test(remote.url)) {
      const worker = new URL(`./partial-fetch-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);
      const child = spawnSync(process.execPath, [fileURLToPath(worker)], { input: JSON.stringify({ url: remote.url, token: remotes.token(state.remote), id }), maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
      if (child.status !== 0) throw new ObjectStoreError("promisor_unavailable", "The promisor could not supply the requested blob.");
      object = parseFramedObject(child.stdout);
    } else {
      const source = remote.url.startsWith("file:") ? fileURLToPath(remote.url) : resolve(dirname(dirname(this.root)), remote.url);
      // A promisor that names a linked instance keeps its objects in the hub's
      // shared store, not in the instance's private control directory: the
      // same link binding every other reader of the remote resolves decides
      // which objects directory serves the demand read.
      object = new ObjectStore(join(resolveObjectsControl(source), "objects")).read(id);
    }
    if (object.type !== "blob" || hashObject(object.type, object.payload) !== id) throw new ObjectStoreError("bad_partial_history", "Promised payload has the wrong type or content address.");
    this.accept([{ id, ...object }], false);
  }

  /** Read durable upload pins; disconnected or interrupted sessions cannot lose their accepted objects. */
  uploadRoots(): ObjectId[] {
    const value = readControlJson(join(dirname(this.root), "upload-roots.json"), "unsafe_gc_roots", "upload roots", []);
    if (!Array.isArray(value) || value.some(/** Validate every persisted pin before trusting the inventory. */ (id) => typeof id !== "string" || !isObjectId(id))) {
      throw new ObjectStoreError("unsafe_gc_roots", "Upload roots are corrupt.");
    }
    return value;
  }

  /** Release upload pins only after a fresh complete root walk proves durable ownership. */
  releaseUploadRoots(reachable: ReadonlySet<ObjectId>): void {
    this.withWriteLock(/** Keep receipt retirement inside the collection transaction. */ () => {
      const before = this.uploadRoots();
      const remaining = before.filter(/** Unpublished uploads remain roots even after disconnection. */ (id) => !reachable.has(id) && this.denial(id) === undefined);
      if (remaining.length !== before.length) writePrivateJson(join(dirname(this.root), "upload-roots.json"), remaining);
    });
  }

  /** Persist pins before arrival writes, so a crash or a GC between upload and publication retains every delivery. */
  pinUploads(ids: readonly ObjectId[]): void {
    this.withWriteLock(/** Pin metadata and object acceptance share the outer publication transaction. */ () => {
      for (const id of ids) this.assertId(id);
      writePrivateJson(join(dirname(this.root), "upload-roots.json"), [...new Set([...this.uploadRoots(), ...ids])].sort());
    });
  }

  /** Materialize verified physical copies through the same location resolver as individual reads. */
  inventory(): InventoryEntry[] { return [...this.walkInventory()].filter((entry) => this.denial(entry.id) === undefined); }

  /** Enumerate complete physical copies; callers planning mutation retain the writer lease across all passes. */
  *walkInventory(): Generator<InventoryEntry> { yield* this.walkRepresentations("all"); }

  /** Enumerate loose representations; recognized write temporaries are skipped before decoding during compaction. */
  *walkLooseInventory(skipped?: { name: string; reason: string }[]): Generator<InventoryEntry> { yield* this.walkRepresentations("loose", skipped); }

  /** Pack-only physical inventory is used by compaction without inspecting loose writer temporaries. @internal */
  *walkPackedInventory(): Generator<InventoryEntry> { yield* this.walkRepresentations("pack"); }

  /** Inspect intentionally denied physical copies only inside authorized maintenance's writer transaction. @internal */
  *walkErasureInventory(kind: "all" | "pack" = "all", excluded: ReadonlySet<string> = new Set()): Generator<InventoryEntry> {
    if (!activeLeases.has(resolve(this.root))) throw new ObjectStoreError("physical_read_requires_lease", "Physical erasure inspection requires the owning writer lease.");
    yield* this.walkRepresentations(kind, [], true, excluded);
  }

  /** Re-read one denied physical copy for an already authorized erasure plan. @internal */
  readErasureObject(id: ObjectId, path: string): StoredObject { return this.inventoryObject(id, path, true); }

  /** Collect names only, so incomplete recognized temporaries cannot reach a decoder on the compaction path. */
  private looseLocations(skipped?: { name: string; reason: string }[], physical = false): { id: ObjectId; path: string }[] {
    const result: { id: ObjectId; path: string }[] = [];
    if (!existsSync(this.root)) return result;
    if (!lstatSync(this.root).isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Object storage cannot follow a symlink.");
    for (const directory of readdirSync(this.root, { withFileTypes: true })) {
      if (directory.name === "packs" && directory.isDirectory()) continue;
      if (!directory.isDirectory() || !/^[0-9a-f]{2}$/.test(directory.name)) {
        if (skipped !== undefined) { skipped.push({ name: directory.name, reason: "foreign loose-storage entry; left untouched" }); continue; }
        throw new ObjectStoreError("unsupported_erasure_storage", "Unknown object storage must be removed or supported before erasure.");
      }
      for (const file of readdirSync(join(this.root, directory.name), { withFileTypes: true })) {
        if (!file.isFile() || !/^[0-9a-f]{62}(?:\.[0-9]+\.[0-9a-f]{12}\.tmp)?$/.test(file.name)) {
          if (skipped !== undefined) { skipped.push({ name: `${directory.name}/${file.name}`, reason: "foreign loose-storage record; left untouched" }); continue; }
          throw new ObjectStoreError("unsupported_erasure_storage", "Unindexed storage artefacts prevent a complete erasure inventory.");
        }
        const id = directory.name + file.name.slice(0, 62);
        if (skipped !== undefined && file.name.endsWith(".tmp") && !physical) { skipped.push({ name: id, reason: "loose write temporary; retained for its writer" }); continue; }
        result.push({ id, path: join(this.root, directory.name, file.name) });
      }
    }
    return result;
  }

  /** Snapshot the loose set and pack indexes in one unchanged generation before yielding any representation. */
  private representationLocations(kind: "all" | "loose" | "pack", skipped?: { name: string; reason: string }[], physical = false, excluded: ReadonlySet<string> = new Set()): { id: ObjectId; path: string }[] {
    for (let attempt = 0; attempt < OBJECT_READ_RETRIES; attempt++) {
      const before = this.storageGeneration(); const notes: { name: string; reason: string }[] | undefined = skipped === undefined ? undefined : [];
      let result: { id: ObjectId; path: string }[];
      objectReadBoundary.visit("inventory", "*", attempt);
      try { result = [...(kind === "pack" ? [] : this.looseLocations(notes, physical).filter(entry => !excluded.has(entry.path))), ...(kind === "loose" ? [] : this.packs.locations(excluded))]; }
      catch (error) { const after = this.storageGeneration(); if (before.key !== after.key || !after.consistent) continue; throw error; }
      const after = this.storageGeneration();
      if (!before.consistent || !after.consistent || before.key !== after.key || before.active || after.active) continue;
      if (notes !== undefined) skipped?.push(...notes);
      return result;
    }
    throw new ObjectStoreError("object_store_changing", "Inventory changed during eight attempts; retry when storage maintenance completes.");
  }

  /** Verify each snapshot member using a pinned current location, deduplicating physical fallbacks after a transition. */
  private *walkRepresentations(kind: "all" | "loose" | "pack", skipped?: { name: string; reason: string }[], physical = false, excluded: ReadonlySet<string> = new Set()): Generator<InventoryEntry> {
    const seen = new Set<string>();
    for (const entry of this.representationLocations(kind, skipped, physical, excluded)) {
      let location: ObjectLocation | undefined;
      try { location = this.resolveLocation(entry.id, { path: entry.path, physical }); }
      catch (error) { if (error instanceof ObliteratedObjectError) continue; throw error; }
      if (location === undefined) continue;
      try {
        if ((kind === "loose" && location.packed !== undefined) || (kind === "pack" && location.packed === undefined)) continue;
        const key = `${location.path}:${entry.id}`; if (seen.has(key)) continue; seen.add(key);
        let object: StoredObject;
        try { object = this.readInventoryLocation(entry.id, location); }
        catch (error) {
          if (physical && entry.path.endsWith(".tmp") && error instanceof ObjectStoreError && ["corrupt_object", "malformed_object"].includes(error.code)) continue;
          throw error;
        }
        location.check();
        yield { id: entry.id, path: location.path, object, bytes: location.bytes ?? location.length, ...(location.packed === undefined ? {} : { packed: location.packed }) };
      } finally { location.close(); }
    }
  }

  /** Validate the physical address scope before an exact-path hint reaches the shared resolver. */
  readInventoryObject(id: ObjectId, path: string): StoredObject { return this.inventoryObject(id, path, false); }

  /** Share path validation and pinned resolution between logical inventory reads and the explicit erasure-only scope. */
  private inventoryObject(id: ObjectId, path: string, physical: boolean): StoredObject {
    this.assertId(id);
    const canonical = this.pathFor(id);
    const pack = dirname(path) === join(this.root, "packs") && /^[0-9a-f]{64}\.pack$/.test(basename(path));
    if (!pack && (dirname(path) !== dirname(canonical) || (basename(path) !== id.slice(2)
      && !new RegExp(`^${id.slice(2)}\\.[0-9]+\\.[0-9a-f]{12}\\.tmp$`).test(basename(path))))) {
      throw new ObjectStoreError("unsupported_erasure_storage", "Physical inventory location does not belong to this object.");
    }
    for (const directory of [this.root, dirname(path)]) {
      const stat = lstatSync(directory, { throwIfNoEntry: false });
      if (stat !== undefined && !stat.isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Physical inventory cannot follow directory or leaf links.");
    }
    const leaf = lstatSync(path, { throwIfNoEntry: false });
    if (leaf !== undefined && !leaf.isFile()) throw new ObjectStoreError("unsupported_erasure_storage", "Physical inventory cannot follow directory or leaf links.");
    return this.withLocation(id, (location) => this.readInventoryLocation(id, location), { path, physical });
  }

  /** Once pinned, validate only descriptor identity and bytes; pathname retirement never invalidates an immutable read. */
  private readInventoryLocation(id: ObjectId, location: ObjectLocation): StoredObject {
    const before = fstatSync(location.fd, { bigint: true });
    if (!before.isFile()) throw new ObjectStoreError("unsupported_erasure_storage", "Physical inventory requires a regular pinned descriptor.");
    const object = this.readLocation(id, location);
    const after = fstatSync(location.fd, { bigint: true });
    // Unlinking changes ctime/link count, but leaves this descriptor and its verified bytes intact.
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new ObjectStoreError("unsupported_erasure_storage", "Pinned inventory bytes changed during verification.");
    return object;
  }

  /** Hold a synchronous, reentrant store transaction across publication, worktree mutation and physical erasure; callbacks must not return asynchronous work. */
  withWriteLock<T>(action: () => T): T { return durability.scoped(dirname(this.root), () => this.writerLease(action)); }

  /** Own the store lease until every namespace receipt and descriptor cleanup has settled. */
  private writerLease<T>(action: () => T): T {
    const lease = resolve(this.root);
    if (!recoveryLeases.has(lease) && existsSync(join(dirname(this.root), "objects.recovery.lock"))) throw new ObjectStoreError("store_locked", "A recovery validator owns the store; retry after it releases its guard.");
    if (activeLeases.has(lease)) {
      activeRevisions.set(lease, activeRevisions.get(lease)! + 1);
      return action();
    }
    if (!existsSync(dirname(this.root))) mkdirSync(dirname(this.root), { recursive: true });
    const path = join(dirname(this.root), "objects.lock");
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const file = objectFiles.open(temporary, "wx", 0o600);
    const fd = file.fd;
    let acquired = false;
    let locked: BigIntStats | undefined;
    let result: T;
    let lockChanged = false;
    try {
      locked = fstatSync(fd, { bigint: true });
      writeFileSync(fd, String(process.pid));
      locked = fstatSync(fd, { bigint: true });
      durability.file(fd);
      const deadline = performance.now() + 5000;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      for (;;) {
        try { durability.link(temporary, path); acquired = true; break; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const remaining = deadline - performance.now();
          if (remaining <= 0) {
            throw new ObjectStoreError("store_locked", "Another writer holds the store lock after a 5-second wait; retry when it completes. Use vcs recover-lock only for an interrupted writer, never a live owner.");
          }
          Atomics.wait(sleeper, 0, 0, Math.min(25, remaining));
        }
      }
      const linked = fstatSync(fd, { bigint: true });
      if (linked.size !== locked.size || linked.mtimeNs !== locked.mtimeNs) throw new ObjectStoreError("worktree_path_changed", "Store owner bytes changed during publication.");
      locked = linked;
      durability.unlink(temporary, locked);
      const published = fstatSync(fd, { bigint: true });
      if (published.size !== locked.size || published.mtimeNs !== locked.mtimeNs) throw new ObjectStoreError("worktree_path_changed", "Store owner bytes changed during temporary retirement.");
      locked = published;
      activeLeases.add(lease); activeRevisions.set(lease, 0);
      result = action();
    } finally {
      activeLeases.delete(lease); activeRevisions.delete(lease); dirtyLeases.delete(lease);
      try {
        try {
          if (!acquired && locked !== undefined) durability.discardUnpublished(temporary, fd, locked);
          else {
            const candidate = lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
            if (candidate !== undefined && locked !== undefined && candidate.dev === locked.dev && candidate.ino === locked.ino && candidate.size === locked.size && candidate.mtimeNs === locked.mtimeNs && candidate.ctimeNs === locked.ctimeNs) {
              durability.unlink(temporary, locked);
              // Retiring our extra hardlink changes ctime; retain the original byte stamp before acknowledging it.
              const retired = fstatSync(fd, { bigint: true });
              if (retired.size === locked.size && retired.mtimeNs === locked.mtimeNs) locked = retired;
            }
          }
        } finally {
          // A moved root must neither hide the mutation refusal nor unlink a foreign lock.
          if (acquired) {
            const observed = lstatSync(path, { bigint: true, throwIfNoEntry: false });
            if (observed !== undefined && observed.dev === locked!.dev && observed.ino === locked!.ino && observed.size === locked!.size && observed.mtimeNs === locked!.mtimeNs && observed.ctimeNs === locked!.ctimeNs) durability.unlinkOwner(path, locked!);
            else lockChanged = true;
          }
        }
      } finally { file.close(); }
    }
    if (lockChanged) throw new ObjectStoreError("worktree_path_changed", "Store lock identity changed during mutation.");
    return result;
  }

  /** Validate a read-only request under a bounded revision CAS before retiring any stale recovery or writer lease. */
  withRecoveryValidation<T>(validate: () => void, action: () => T): T {
    const lease = resolve(this.root); const control = dirname(this.root); const guardPath = join(control, "objects.recovery.lock");
    return durability.scoped(control, () => {
      /** Lock identity is part of the CAS even when no payload generation changed. */
      const state = (): string | undefined => {
        try { const lock = lstatSync(join(control, "objects.lock"), { bigint: true, throwIfNoEntry: false });
        return `${measureDestructionRevision(control)}:${lock === undefined ? "absent" : `${lock.dev}:${lock.ino}:${lock.size}:${lock.mtimeNs}`}`; } catch (error) { if (["ENOENT", "ESTALE"].includes((error as NodeJS.ErrnoException).code!)) return undefined; throw error; }
      };
      for (let attempt = 0; attempt < OBJECT_READ_RETRIES; attempt++) {
        destructionBoundary.visit("recovery-view-start", control);
        const before = state(); if (before === undefined) continue; let failed = false; let failure: unknown;
        activeLeases.add(lease); activeRevisions.set(lease, 0); validationLeases.add(lease);
        try { validate(); } catch (error) { failed = true; failure = error; }
        finally { activeLeases.delete(lease); activeRevisions.delete(lease); validationLeases.delete(lease); }
        if (state() !== before) continue;
        if (failed) throw failure;
        destructionBoundary.visit("recovery-view-validated", control);
        const oldGuard = lstatSync(guardPath, { bigint: true, throwIfNoEntry: false });
        if (oldGuard !== undefined) {
          if (!oldGuard.isFile()) throw new ObjectStoreError("store_locked", "An unknown recovery owner was preserved.");
          const owner = readFileSync(guardPath, "utf8"); const pid = Number(owner);
          if (!/^[1-9][0-9]*$/.test(owner) || !Number.isSafeInteger(pid) || pid > 2_147_483_647) throw new ObjectStoreError("store_locked", "A foreign recovery owner was preserved.");
          const abandoned = recoveryOwners.get(guardPath);
          const self = pid === process.pid && !recoveryLeases.has(lease) && abandoned !== undefined && abandoned.dev === oldGuard.dev && abandoned.ino === oldGuard.ino && abandoned.size === oldGuard.size && abandoned.mtimeNs === oldGuard.mtimeNs && abandoned.ctimeNs === oldGuard.ctimeNs;
          if (!self) { try { process.kill(pid, 0); throw new ObjectStoreError("store_locked", "A live recovery owner was preserved."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
          durability.unlinkOwner(guardPath, oldGuard);
        }
        const temporary = `${guardPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        const guard = objectFiles.open(temporary, "wx", 0o600); let published = false;
        let owned: BigIntStats | undefined;
        try {
          destructionBoundary.visit("recovery-owner-opened", temporary);
          writeFileSync(guard.fd, String(process.pid)); destructionBoundary.visit("recovery-owner-written", temporary); durability.file(guard.fd); destructionBoundary.visit("recovery-owner-flushed", temporary); owned = fstatSync(guard.fd, { bigint: true });
          try { durability.link(temporary, guardPath); published = true; owned = fstatSync(guard.fd, { bigint: true }); recoveryOwners.set(guardPath, owned); recoveryLeases.add(lease); destructionBoundary.visit("recovery-owner-published", guardPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; throw new ObjectStoreError("store_locked", "A peer acquired the recovery guard; no payload deletion was attempted."); }
          durability.unlink(temporary, owned);
          owned = fstatSync(guard.fd, { bigint: true }); recoveryOwners.set(guardPath, owned);
          recoveryLeases.add(lease);
          if (state() !== before) throw new ObjectStoreError("store_locked", "The validated store revision changed before recovery; retry the original request.");
          this.recoverWriterLock(); destructionBoundary.visit("recovery-old-lock-retired", control);
          const result = action(); destructionBoundary.visit("recovery-action-completed", control); return result;
        } finally {
          recoveryLeases.delete(lease);
          try {
            const current = lstatSync(guardPath, { bigint: true, throwIfNoEntry: false }); if (published && owned !== undefined && current !== undefined && current.dev === owned.dev && current.ino === owned.ino && current.size === owned.size && current.mtimeNs === owned.mtimeNs && current.ctimeNs === owned.ctimeNs) durability.unlinkOwner(guardPath, owned);
            const candidate = lstatSync(temporary, { bigint: true, throwIfNoEntry: false }); if (owned !== undefined && candidate !== undefined && candidate.dev === owned.dev && candidate.ino === owned.ino) durability.unlink(temporary, candidate);
          } finally {
            guard.close();
            const registered = recoveryOwners.get(guardPath); const current = lstatSync(guardPath, { bigint: true, throwIfNoEntry: false });
            if (registered !== undefined && owned !== undefined && registered.dev === owned.dev && registered.ino === owned.ino && (current === undefined || current.dev !== owned.dev || current.ino !== owned.ino || current.size !== owned.size || current.mtimeNs !== owned.mtimeNs || current.ctimeNs !== owned.ctimeNs)) recoveryOwners.delete(guardPath);
            destructionBoundary.visit("recovery-owner-retired", control);
          }
        }
      }
      throw new ObjectStoreError("object_store_changing", "Recovery preflight could not observe a stable revision in eight attempts.");
    });
  }

  /** Recover a dead writer or an empty legacy lock older than one minute; live and unidentified owners refuse. */
  recoverWriterLock(): void {
    const path = join(dirname(this.root), "objects.lock");
    const observed = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (observed === undefined) return;
    if (observed.isSymbolicLink()) throw new ObjectStoreError("store_locked", "Lock owner is unknown.");
    let content: string;
    try { content = readFileSync(path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (content === "") {
      if (BigInt(Date.now()) * 1_000_000n - observed.mtimeNs < 60_000_000_000n) throw new ObjectStoreError("store_locked", "Empty legacy lock is within its owner-publication grace period.");
    } else {
      const pid = Number(content);
      if (!/^[1-9][0-9]*$/.test(content) || !Number.isSafeInteger(pid)) throw new ObjectStoreError("store_locked", "Lock owner is unknown.");
      let dead = false;
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        dead = true;
      }
      if (!dead) throw new ObjectStoreError("store_locked", "Lock owner is still running.");
    }
    const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (current === undefined) return;
    if (current.dev !== observed.dev || current.ino !== observed.ino || current.ctimeNs !== observed.ctimeNs
      || current.mtimeNs !== observed.mtimeNs || current.size !== observed.size) throw new ObjectStoreError("store_locked", "Lock owner changed during recovery.");
    durability.unlinkOwner(path, current);
  }

  /**
   * Rejects an id that is not 64 lowercase hex characters.
   *
   * @param id - Candidate id.
   * @throws ObjectStoreError When the id is malformed.
   */
  private assertId(id: ObjectId): void {
    if (!isObjectId(id)) {
      throw new ObjectStoreError("invalid_object_id", `"${id}" is not a valid object id.`);
    }
  }
}

/** Distinct terminal absence carrying the audit record rather than claiming corruption. */
export class ObliteratedObjectError extends ObjectStoreError {
  /** Immutable audit tombstone identity. */
  readonly tombstone: ObjectId;
  /** Construct the typed read refusal without exposing erased payloads. */
  constructor(id: ObjectId, tombstone: ObjectId) {
    super("object_obliterated", `Object ${id} was permanently obliterated; tombstone ${tombstone}.`);
    this.tombstone = tombstone;
  }
}

/** Four mutually exclusive content states; intentional absence remains auditable. */
export type PayloadState =
  | { readonly kind: "present"; readonly object: StoredObject }
  | { readonly kind: "obliterated"; readonly tombstone: ObjectId }
  | { readonly kind: "missing"; readonly code: string }
  | { readonly kind: "corrupt"; readonly code: string };
