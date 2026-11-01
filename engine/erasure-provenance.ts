import { assertVerificationBound } from "./object-error.ts";
/** Native composition identities, independent of guesses about user-authored encodings. */
import { createHash } from "node:crypto";
import { renderWorkingRecord } from "./record-format.ts";
import { decodeRecord, decodeManifest } from "./model.ts";
import { assertManifestChild } from "./manifest-pages.ts";
import { ObjectStoreError, type ObjectId, type StoredObject } from "./objects.ts";

/** Primary composition proof bounds are distinct from the nonblocking residue audit. @internal */
export const compositionLimits = { bytes: 256 * 1024 * 1024, cacheBytes: 512 * 1024 * 1024, edges: 1_000_000, timeMs: 300_000 };

/** Inspect a batch with one memo per identity; repeated edges reuse bytes and never expand descendants again. */
export function manifestIdentities(ids: readonly ObjectId[], read: (id: ObjectId) => StoredObject, fence: () => void = () => {}): Map<ObjectId, { id: ObjectId; digest: string }> {
  const started = performance.now(); const memo = new Map<ObjectId, Buffer>(); const visiting = new Set<ObjectId>();
  const headers = new Map<ObjectId, ReturnType<typeof decodeManifest>>();
  let cached = 0; let edges = 0;
  /** Every distinct node, edge and bounded hashing chunk observes both time and the caller's lease. */
  const check = (): void => {
    fence(); assertVerificationBound("erasure-composition", "time_ms", performance.now() - started, compositionLimits.timeMs);
  };
  /** Flatten one native node once, only after its declared length fits the primary work budget. */
  const visit = (id: ObjectId): Buffer => {
    check(); const previous = memo.get(id); if (previous !== undefined) return previous;
    if (visiting.has(id)) throw new ObjectStoreError("invalid_manifest", "Native composition contains a cycle.");
    visiting.add(id); const object = read(id); check(); let bytes: Buffer;
    if (object.type === "blob") bytes = object.payload;
    else if (object.type === "manifest") {
      const header = decodeManifest(object.payload); headers.set(id, header);
      assertVerificationBound("erasure-composition", "logical_bytes", header.totalLength, compositionLimits.bytes);
      assertVerificationBound("erasure-composition", "cache_bytes", cached + header.totalLength, compositionLimits.cacheBytes);
      const parts: Buffer[] = [];
      for (const child of header.pages ?? header.fragments) {
        check(); assertVerificationBound("erasure-composition", "edges", ++edges, compositionLimits.edges);
        const content = visit(child.id);
        if (header.pages !== undefined) {
          const node = headers.get(child.id);
          if (node === undefined) throw new ObjectStoreError("invalid_manifest", "Manifest page has the wrong kind.");
          assertManifestChild(header, child as NonNullable<typeof header.pages>[number], node);
        } else if (headers.has(child.id) || content.length !== child.length) throw new ObjectStoreError("invalid_manifest", "Manifest fragment has the wrong kind or length.");
        parts.push(content);
      }
      // Recheck after children reserved their own cache; no allocation can cross the aggregate bound.
      assertVerificationBound("erasure-composition", "cache_bytes", cached + header.totalLength, compositionLimits.cacheBytes);
      check(); bytes = Buffer.concat(parts, header.totalLength); check();
    } else throw new ObjectStoreError("invalid_manifest", "Native composition has the wrong object kind.");
    assertVerificationBound("erasure-composition", "cache_bytes", cached + bytes.length, compositionLimits.cacheBytes);
    cached += bytes.length; memo.set(id, bytes); visiting.delete(id); return bytes;
  };
  const result = new Map<ObjectId, { id: ObjectId; digest: string }>();
  for (const id of ids) {
    const bytes = visit(id);
    if (!headers.has(id)) throw new ObjectStoreError("invalid_manifest", "Composition identity requires a manifest.");
    const framed = createHash("sha256").update(`blob ${bytes.length}\0`); const payload = createHash("sha256");
    for (let offset = 0; offset < bytes.length; offset += 65536) { check(); const part = bytes.subarray(offset, offset + 65536); framed.update(part); payload.update(part); }
    check(); result.set(id, { id: framed.digest("hex"), digest: payload.digest("hex") });
  }
  return result;
}

/** Inspect one native composition using the same memoized bounded batch implementation. */
export function manifestIdentity(id: ObjectId, read: (id: ObjectId) => StoredObject, check?: () => void): { id: ObjectId; digest: string } {
  return manifestIdentities([id], read, check).get(id)!;
}

/** Enumerate only the actual native record producer's two working-file formats, including legacy resolved snapshots. */
export function* recordRepresentations(payload: Buffer): Generator<Buffer> {
  const document = decodeRecord(payload);
  yield renderWorkingRecord("record.json", document);
  yield renderWorkingRecord("record.toon", document);
}
