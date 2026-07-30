// Content-addressed object store.
//
// Four object kinds are framed identically — `<type> <byteLength>\0<payload>` —
// and named by the SHA-256 of that whole frame. Including the type and length in
// the hashed bytes is what stops a blob whose content happens to spell a valid
// tree from colliding with that tree: the frames differ, so the ids differ.
//
// Objects are immutable and never removed. That is what makes `undo` always
// possible (see oplog.ts) and what lets a write of already-present content be
// skipped rather than repeated.

import { constants as zlibConstants, deflateSync, inflateSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** The kinds of object the store can hold. */
export const OBJECT_TYPES = ["blob", "tree", "commit", "record"] as const;

/** One of the four object kinds. */
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

  constructor(code: string, message: string) {
    super(message);
    this.name = "ObjectStoreError";
    this.code = code;
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
  return createHash("sha256").update(frameObject(type, payload)).digest("hex");
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
      readFileSync(this.pathFor(id));
      return true;
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
  write(type: ObjectType, payload: Buffer): ObjectId {
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
   * @param id - Object id to read.
   * @returns The object's kind and payload.
   * @throws ObjectStoreError When the id is malformed, the object is absent, its
   *   compressed bytes will not inflate, or its content does not hash to `id`.
   */
  read(id: ObjectId): StoredObject {
    this.assertId(id);
    let compressed: Buffer;
    try {
      compressed = readFileSync(this.pathFor(id));
    } catch {
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

