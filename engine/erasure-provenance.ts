/** Native composition identities, independent of guesses about user-authored encodings. */
import { createHash } from "node:crypto";
import { renderWorkingRecord } from "./record-format.ts";
import { decodeRecord, decodeManifest } from "./model.ts";
import { assertManifestChild } from "./manifest-pages.ts";
import { ObjectStoreError, type ObjectId, type StoredObject } from "./objects.ts";

/** Hash a native manifest's complete logical blob, retaining at most one fragment and eight metadata nodes. */
export function manifestIdentity(id: ObjectId, read: (id: ObjectId) => StoredObject): { id: ObjectId; digest: string } {
  const root = read(id);
  if (root.type !== "manifest") throw new ObjectStoreError("invalid_manifest", "Composition identity requires a manifest.");
  const header = decodeManifest(root.payload);
  const framed = createHash("sha256").update(`blob ${header.totalLength}\0`);
  const payload = createHash("sha256");
  /** Native edges, lengths and page heights establish composition; arbitrary content is never decoded. */
  function visit(node: ReturnType<typeof decodeManifest>): void {
    if (node.pages !== undefined) {
      for (const page of node.pages) {
        const object = read(page.id);
        if (object.type !== "manifest") throw new ObjectStoreError("invalid_manifest", "Manifest page has the wrong kind.");
        const child = decodeManifest(object.payload); assertManifestChild(node, page, child); visit(child);
      }
    } else {
      for (const fragment of node.fragments) {
        const object = read(fragment.id);
        if (object.type !== "blob" || object.payload.length !== fragment.length) throw new ObjectStoreError("invalid_manifest", "Manifest fragment has the wrong kind or length.");
        framed.update(object.payload); payload.update(object.payload);
      }
    }
  }
  visit(header);
  return { id: framed.digest("hex"), digest: payload.digest("hex") };
}

/** Enumerate only the actual native record producer's two working-file formats, including legacy resolved snapshots. */
export function* recordRepresentations(payload: Buffer): Generator<Buffer> {
  const document = decodeRecord(payload);
  yield renderWorkingRecord("record.json", document);
  yield renderWorkingRecord("record.toon", document);
}
