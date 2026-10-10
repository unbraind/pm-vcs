/** Typed erasure metadata and provenance checks at every object arrival boundary. */
import { inspectRepresentations } from "./representations.ts";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { decodeManifest, decodeTree } from "./model.ts";
import { hashObject, isObjectId, ObjectStoreError, readControlJson, type ObjectId, type StoredObject } from "./objects.ts";

/** Canonical terminal erasure record containing identities and audit metadata only. */
export interface ErasureTombstone {
  /** Tombstone format version. */
  readonly version: 1;
  /** Stable FileId that can never receive new payloads. */
  readonly fileId: string;
  /** Historical root payload IDs belonging to this FileId. */
  readonly roots: readonly ObjectId[];
  /** Root objects and all their fragments permanently denied. */
  readonly objects: readonly ObjectId[];
  /** Type-independent payload digests prevent renaming erased bytes as a different object kind. */
  readonly payloads: readonly string[];
  /** Locally authorized audit principal. */
  readonly principal: string;
  /** Absolute ISO timestamp of initial authorization. */
  readonly timestamp: string;
  /** Bounded machine-readable reason code, never arbitrary payload text. */
  readonly reason: string;
}

/** Durable denial survives failed or interrupted byte cleanup. */
export interface ErasureDenial {
  /** Content address of the canonical typed tombstone. */
  readonly id: ObjectId;
  /** Typed audit metadata. */
  readonly tombstone: ErasureTombstone;
  /** True until physical deletion has been durably completed. */
  readonly pending: boolean;
}

/** Encode a strictly validated canonical tombstone without credentials or payloads. */
export function encodeTombstone(value: ErasureTombstone): Buffer {
  if (value === null || typeof value !== "object" || value.version !== 1
    || typeof value.fileId !== "string" || !/^[0-9a-f]{32}$/.test(value.fileId)
    || !Array.isArray(value.roots) || value.roots.length === 0 || !Array.isArray(value.objects) || !Array.isArray(value.payloads)
    || ![...value.roots, ...value.objects, ...value.payloads].every(/** Require immutable addresses for every affected object. */ (id) => typeof id === "string" && isObjectId(id))
    || !value.roots.every(/** Every root must also be permanently denied. */ (id) => value.objects.includes(id))
    || typeof value.principal !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(value.principal)
    || typeof value.reason !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value.reason)
    || typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))
    || Object.keys(value).sort().join(",") !== "fileId,objects,payloads,principal,reason,roots,timestamp,version") {
    throw new ObjectStoreError("bad_tombstone", "Tombstone must contain only canonical identities and bounded audit metadata.");
  }
  return Buffer.from(JSON.stringify({ version: 1, fileId: value.fileId,
    roots: [...new Set(value.roots)].sort(), objects: [...new Set(value.objects)].sort(),
    payloads: [...new Set(value.payloads)].sort(), principal: value.principal, timestamp: value.timestamp, reason: value.reason }), "utf8");
}

/** Read persisted denial, refusing corruption rather than reopening an erased identity. */
export function readDenials(control: string): ErasureDenial[] {
  const path = join(control, "denials.json");
  const raw = readControlJson(path, "bad_tombstone", "erasure denial registry");
  if (raw === null && lstatSync(path, { throwIfNoEntry: false }) === undefined) return [];
  return validateDenials(raw);
}

/** Validate local or received denial records including their canonical content addresses. */
export function validateDenials(raw: unknown): ErasureDenial[] {
  if (!Array.isArray(raw)) throw new ObjectStoreError("bad_tombstone", "Denials must be an array.");
  const identities = new Set<string>();
  for (const value of raw as ErasureDenial[]) {
    if (value === null || typeof value !== "object" || typeof value.pending !== "boolean"
      || Object.keys(value).sort().join(",") !== "id,pending,tombstone"
      || typeof value.id !== "string" || hashObject("tombstone", encodeTombstone(value.tombstone)) !== value.id
      || identities.has(value.tombstone.fileId)) {
      throw new ObjectStoreError("bad_tombstone", "Denial record is corrupt or duplicates a FileId.");
    }
    identities.add(value.tombstone.fileId);
  }
  return raw as ErasureDenial[];
}

/** One verified candidate object before any storage mutation. */
export interface ObjectArrival extends StoredObject {
  /** Address already verified against the content. */
  readonly id: ObjectId;
}

/** Refuse payload resurrection and novel bytes assigned to a denied FileId. */
export function assertArrivalsAllowed(denials: readonly ErasureDenial[], objects: readonly ObjectArrival[], attributed: boolean): void {
  if (denials.length === 0) return;
  if (denials.some(/** An interrupted erasure never permits publication. */ (denial) => denial.pending)) {
    throw new ObjectStoreError("erasure_incomplete", "Authorized cleanup must finish before store writes resume.");
  }
  const deniedObjects = new Map(denials.flatMap(/** Index every permanently denied address once per arrival batch. */ (denial) => denial.tombstone.objects.map(/** Preserve attribution for structural role checks. */ (id) => [id, denial] as const)).reverse());
  const digests = new Set(denials.flatMap(/** Deny both original loose frames and type-independent payload bytes. */ (denial) => [...denial.tombstone.objects, ...denial.tombstone.payloads]));
  const files = new Map(denials.map(/** Index terminal identities independently of their current paths. */ (denial) => [denial.tombstone.fileId, denial]));
  for (const object of objects) {
    if (deniedObjects.has(object.id) || (object.payload.length > 0 && digests.has(payloadDigest(object.payload))) || inspectRepresentations(object.payload, /** Nonempty frames and payloads remain denied beneath supported encodings; empty content retains its exact typed address. */ (bytes) => bytes.length > 0 && digests.has(payloadDigest(bytes)))) throw new ObjectStoreError("object_obliterated", "Arrival contains permanently denied payload bytes.");
    if (object.type === "tree") {
      for (const entry of decodeTree(object.payload)) {
        const affected = deniedObjects.get(entry.id);
        if (affected !== undefined && (entry.mode === "40000" || entry.fileId !== affected.tombstone.fileId || !affected.tombstone.roots.includes(entry.id))) {
          throw new ObjectStoreError("invalid_erasure_role", "Tree denial does not match its payload FileId and root.");
        }
        const denial = files.get(entry.fileId ?? "");
        if (denial !== undefined && !denial.tombstone.roots.includes(entry.id)) {
          throw new ObjectStoreError("file_obliterated", "Arrival assigns novel payloads to a permanently denied FileId.");
        }
      }
    } else if (object.type === "manifest") {
      if (decodeManifest(object.payload).fragments.some(/** A new manifest cannot retain erased fragments. */ (fragment) => deniedObjects.has(fragment.id))) {
        throw new ObjectStoreError("object_obliterated", "Arrival manifest refers to permanently denied fragments.");
      }
    }
    if (!attributed && ["blob", "record", "manifest"].includes(object.type)) {
      throw new ObjectStoreError("unattributed_arrival", "Payload writes after erasure require complete FileId provenance.");
    }
  }
}

/** Compute a type-independent one-way digest for denial without retaining erased bytes. */
export function payloadDigest(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}
