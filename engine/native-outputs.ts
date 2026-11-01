import { recordDerivation } from "./derivations.ts";
/** Durable source edges for native working-file writes, including interrupted publications. */
import { type BigIntStats } from "node:fs";
import { join } from "node:path";
import { writePrivateJson, assertCompositionPath } from "./composition.ts";
import { hashObject, isObjectId, ObjectStoreError, readControlJson, type ObjectId, type ObjectStore } from "./objects.ts";
import { recordPayloadOwner } from "./payload-owners.ts";

/** Sources are native identities, never inferred encodings of opaque user input. */
export interface NativeOutputSource { readonly objects: readonly ObjectId[]; readonly fileId?: string }
/** An identity-bound native output contains no content snapshot. */
export interface NativeOutput extends NativeOutputSource { readonly path: string; readonly id: ObjectId; readonly birth: string; readonly complete: boolean }

/** A birth identity survives partial writes while distinguishing an unrelated replacement. */
export function outputBirth(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }

/** Accept only native source records, including the previous writer's ordinary atomic stages. */
export function nativeOutputs(control: string, name = "outputs.json"): NativeOutput[] {
  const raw: unknown = readControlJson(join(control, name), "unsupported_erasure_storage", "native outputs", []);
  if (!Array.isArray(raw)) throw new ObjectStoreError("unsupported_erasure_storage", "Unknown native output registry.");
  const paths = new Set<string>();
  for (const value of raw as NativeOutput[]) {
    if (value === null || typeof value !== "object" || Object.keys(value).some(key => !["path", "id", "birth", "objects", "fileId", "complete"].includes(key))
      || typeof value.complete !== "boolean" || typeof value.path !== "string" || !isObjectId(value.id) || typeof value.birth !== "string" || !/^\d+:\d+:\d+$/.test(value.birth)
      || !Array.isArray(value.objects) || value.objects.length === 0 || !value.objects.every(id => typeof id === "string" && isObjectId(id))
      || value.fileId !== undefined && (typeof value.fileId !== "string" || !/^[0-9a-f]{32}$/.test(value.fileId)) || paths.has(value.path)) {
      throw new ObjectStoreError("unsupported_erasure_storage", "Unknown native output provenance was preserved.");
    }
    try { assertCompositionPath(value.path); }
    catch { throw new ObjectStoreError("unsupported_erasure_storage", "Unknown native output path was preserved."); }
    paths.add(value.path);
  }
  return raw as NativeOutput[];
}

/** Denial checks precede creation; provenance is flushed before the first recoverable output byte. */
export function recordNativeOutput(control: string, store: ObjectStore, path: string, content: Buffer, source: NativeOutputSource, stat?: BigIntStats, complete = false): void {
  if (source.fileId !== undefined && (typeof source.fileId !== "string" || !/^[0-9a-f]{32}$/.test(source.fileId))) throw new ObjectStoreError("invalid_file_id", "Native output requires a canonical FileId.");
  if (!Array.isArray(source.objects) || source.objects.length === 0 || !source.objects.every(id => typeof id === "string" && isObjectId(id))) throw new ObjectStoreError("unsupported_erasure_storage", "Native outputs require canonical source identities.");
  for (const id of source.objects) if (store.denial(id) !== undefined) throw new ObjectStoreError("object_obliterated", "Native output source is permanently denied.");
  if (source.fileId !== undefined && store.denials().some(denial => denial.tombstone.fileId === source.fileId)) throw new ObjectStoreError("file_obliterated", "This native output FileId is permanently denied.");
  const id = hashObject("blob", content);
  if (stat === undefined) { store.preflight([{ id, type: "blob", payload: content }], true); return; }
  if (source.fileId !== undefined) for (const object of source.objects) recordPayloadOwner(join(store.storageRoot(), ".."), object, source.fileId);
  store.withWriteLock(() => recordDerivation(join(store.storageRoot(), ".."), id, source.objects, source.fileId, store.has(id), false, input => store.has(input) ? store.read(input) : undefined, () => store.assertWriteLease()));
  const records = nativeOutputs(control);
  writePrivateJson(join(control, "outputs.json"), [...records.filter(record => record.path !== path), { path, id, birth: outputBirth(stat), complete, objects: [...source.objects], ...(source.fileId === undefined ? {} : { fileId: source.fileId }) }]);
}
