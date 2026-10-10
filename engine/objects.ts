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
  closeSync,
  fsyncSync,
  fstatSync,
  existsSync,
  lstatSync,
  linkSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeManifest, decodeTree } from "./model.ts";
import { encodeTombstone, assertArrivalsAllowed, readDenials, type ErasureDenial, type ObjectArrival } from "./lifecycle.ts";
import { writePrivateJson } from "./composition.ts";

/** Synchronous store handles addressing one root share reentrancy; independent processes still use the exclusive filesystem lease. */
const activeLeases = new Set<string>();

/** The kinds of object the store can hold. */
export const OBJECT_TYPES = ["blob", "tree", "commit", "record", "series", "manifest", "link", "tombstone"] as const;

/** One of the eight object kinds. */
export type ObjectType = (typeof OBJECT_TYPES)[number];

/** A 64-character lowercase hex SHA-256 digest naming an object. */
export type ObjectId = string;

/** A parsed object: its kind and its raw payload, without the frame. */
export interface StoredObject {
  readonly type: ObjectType;
  readonly payload: Buffer;
}

/** Matches exactly a 64-character lowercase hex string. */
const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Raised for every fault this module can detect, so callers can distinguish a
 * repository problem from a programming error without matching on messages.
 */
export class ObjectStoreError extends Error {
  /** Stable machine-readable discriminator for the fault. */
  readonly code: string;

  /** Construct a repository fault carrying a stable code while retaining the native error message contract. */
  constructor(code: string, message: string) {
    super(message);
    this.name = "ObjectStoreError";
    this.code = code;
  }
}

/**
 * Reads one control-directory JSON file, returning null when it is absent.
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
 * @returns The parsed JSON value, or null when the file does not exist.
 * @throws ObjectStoreError When the file exists but is not valid JSON.
 */
export function readControlJson(path: string, code: string, what: string): unknown {
  let contents: string;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new ObjectStoreError(code, `The ${what} cannot be a symbolic link.`);
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
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
  /** Validated immutable denials and address indexes follow the registry's filesystem identity. */
  private denialCache?: { signature: string; entries: ErasureDenial[]; objects: Map<ObjectId, ErasureDenial>; files: Map<string, ErasureDenial> };

  /**
   * @param root - Directory that holds the object fan-out. Created on demand.
   */
  constructor(root: string) {
    this.root = root;
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

  /**
   * Whether the store already holds an object.
   *
   * @param id - Object id to look for.
   * @returns True when the object is present.
   * @throws ObjectStoreError When the id is not well-formed.
   */
  has(id: ObjectId): boolean {
    this.assertId(id);
    try {
      return statSync(this.pathFor(id)).isFile();
    } catch {
      return false;
    }
  }

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
    const destination = this.pathFor(id);
    const directory = join(this.root, id.slice(0, 2));
    mkdirSync(directory, { recursive: true });
    const compressed = deflateSync(frameObject(type, payload), { level: zlibConstants.Z_BEST_SPEED });
    // The suffix disambiguates concurrent writers of the *same* object: both
    // compute one id, so both would otherwise target one temp path and could
    // rename a partially written file into place.
    const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = openSync(temporary, "wx");
    try {
      writeSync(handle, compressed);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    try {
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, { force: true });
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
    const denial = this.denial(id);
    if (denial !== undefined) throw new ObliteratedObjectError(id, denial.id);
    let compressed: Buffer;
    try {
      compressed = readFileSync(this.pathFor(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new ObjectStoreError("object_not_found", `No object ${id} in the store.`);
    }
    let framed: Buffer;
    try {
      framed = inflateSync(compressed);
    } catch {
      throw new ObjectStoreError("corrupt_object", `Object ${id} could not be decompressed.`);
    }
    const parsed = parseFramedObject(framed);
    const actual = hashObject(parsed.type, parsed.payload);
    if (actual !== id) {
      throw new ObjectStoreError("corrupt_object", `Object ${id} contains content that hashes to ${actual}.`);
    }
    return parsed;
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
  state(id: ObjectId, read: () => StoredObject = /** Default inspection verifies the loose object itself. */ () => this.read(id)): PayloadState {
    try { return { kind: "present", object: read() }; } catch (error) {
      if (error instanceof ObliteratedObjectError) return { kind: "obliterated", tombstone: error.tombstone };
      if (!(error instanceof ObjectStoreError)) throw error;
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
      writePrivateJson(join(dirname(this.root), "denials.json"), denials);
      this.denialCache = undefined;
      for (const denial of denials) this.writeRaw("tombstone", encodeTombstone(denial.tombstone));
    });
  }

  /** Inventory every loose object and valid loose temporary copy; unknown backends refuse. */
  inventory(): { id: ObjectId; path: string; object: StoredObject }[] {
    const result: { id: ObjectId; path: string; object: StoredObject }[] = [];
    if (!existsSync(this.root)) return result;
    if (!lstatSync(this.root).isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Object storage cannot follow a symlink.");
    for (const directory of readdirSync(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^[0-9a-f]{2}$/.test(directory.name)) {
        throw new ObjectStoreError("unsupported_erasure_storage", "Unknown object storage must be removed or supported before erasure.");
      }
      for (const file of readdirSync(join(this.root, directory.name), { withFileTypes: true })) {
        if (!file.isFile() || !/^[0-9a-f]{62}(?:\.[0-9]+\.[0-9a-f]{12}\.tmp)?$/.test(file.name)) {
          throw new ObjectStoreError("unsupported_erasure_storage", "Unindexed storage artefacts prevent a complete erasure inventory.");
        }
        const id = directory.name + file.name.slice(0, 62);
        const path = join(this.root, directory.name, file.name);
        const compressed = readFileSync(path);
        let framed: Buffer;
        try { framed = inflateSync(compressed); } catch { throw new ObjectStoreError("corrupt_object", "Inventory found an unreadable compressed object."); }
        const object = parseFramedObject(framed);
        if (hashObject(object.type, object.payload) !== id) throw new ObjectStoreError("corrupt_object", "Inventory found a mismatched loose object.");
        result.push({ id, path, object });
      }
    }
    return result;
  }

  /** Hold a synchronous, reentrant store transaction across publication, worktree mutation and physical erasure; callbacks must not return asynchronous work. */
  withWriteLock<T>(action: () => T): T {
    const lease = resolve(this.root);
    if (activeLeases.has(lease)) return action();
    if (!existsSync(dirname(this.root))) mkdirSync(dirname(this.root), { recursive: true });
    const path = join(dirname(this.root), "objects.lock");
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    let acquired = false;
    const locked = fstatSync(fd, { bigint: true });
    let result: T;
    let lockChanged = false;
    try {
      writeFileSync(fd, String(process.pid));
      fsyncSync(fd);
      for (let attempt = 0; ; attempt += 1) {
        try { linkSync(temporary, path); acquired = true; break; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (attempt === 200) {
            throw new ObjectStoreError("store_locked", "Another writer holds the store lock; use vcs recover-lock for interrupted writers.");
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      unlinkSync(temporary);
      activeLeases.add(lease);
      result = action();
    } finally {
      activeLeases.delete(lease);
      closeSync(fd);
      rmSync(temporary, { force: true });
      // A moved root must neither hide the mutation refusal nor unlink a foreign lock.
      if (acquired) {
        const observed = lstatSync(path, { bigint: true, throwIfNoEntry: false });
        if (observed !== undefined && observed.dev === locked.dev && observed.ino === locked.ino) unlinkSync(path);
        else lockChanged = true;
      }
    }
    if (lockChanged) throw new ObjectStoreError("worktree_path_changed", "Store lock identity changed during mutation.");
    return result;
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
    unlinkSync(path);
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
