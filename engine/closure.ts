/** Role-aware history validation: only attributed payload leaves can be intentionally absent. */
import { decodeLink } from "./composition.ts";
import { decodeCommit, decodeManifest, decodeTree } from "./model.ts";
import { type ErasureDenial, type ObjectArrival } from "./lifecycle.ts";
import { ObjectStoreError, type ObjectId, type ObjectStore, type ObjectType } from "./objects.ts";

/** Closure inspection shared by publication and verification. */
export interface ClosureReport {
  /** Distinct successfully validated objects. */
  verified: number;
  /** Payload objects whose FileId and root match a canonical terminal denial. */
  obliterated: string[];
  /** Absent required objects. */
  missing: string[];
  /** Invalid structure, object kinds, audits or content. */
  corrupt: string[];
}

/** Context follows tree ownership through a payload manifest to its physical fragments. */
interface Reference {
  readonly id: ObjectId;
  readonly role: "commit" | "tree" | "payload" | "fragment" | "tombstone";
  readonly fileId?: string;
  readonly root?: ObjectId;
}

/** Verified closure metadata keeps decoded structure and leaf kinds, never leaf payload bytes. */
type VerifiedObject =
  | { readonly type: "commit"; readonly structure: ReturnType<typeof decodeCommit> }
  | { readonly type: "tree"; readonly structure: ReturnType<typeof decodeTree> }
  | { readonly type: "manifest"; readonly structure: ReturnType<typeof decodeManifest> }
  | { readonly type: Exclude<ObjectType, "commit" | "tree" | "manifest"> };

/** Validate commit roots against held objects plus an unpublished arrival, without mutating storage. */
export function inspectClosure(store: ObjectStore, targets: readonly ObjectId[], arrivals: readonly ObjectArrival[] = [], denials: readonly ErasureDenial[] = store.denials(), audits = false, trees: readonly ObjectId[] = []): ClosureReport {
  const result: ClosureReport = { verified: 0, obliterated: [], missing: [], corrupt: [] };
  const denied = new Map(denials.flatMap(/** Index addresses once while retaining each leaf's original attribution. */ (entry) => entry.tombstone.objects.map(/** Preserve the first denial when identical payloads have multiple terminal owners. */ (id) => [id, entry] as const)).reverse());
  const carried = new Map(arrivals.map(/** Resolve incoming objects before publication. */ (object) => [object.id, object]));
  const pending: Reference[] = targets.map(/** Every advertised root is a commit, independently of denial claims. */ (id) => ({ id, role: "commit" }));
  for (const id of trees) pending.push({ id, role: "tree" });
  if (audits) for (const denial of denials) pending.push({ id: denial.id, role: "tombstone" });
  const seen = new Set<string>();
  const verified = new Set<ObjectId>();
  const held = new Map<ObjectId, VerifiedObject>();
  while (pending.length > 0) {
    const reference = pending.pop() as Reference;
    const { id, role, fileId, root } = reference;
    const key = JSON.stringify(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    const denial = denied.get(id);
    if (denial !== undefined) {
      if (role === "payload" && fileId === denial.tombstone.fileId && root !== undefined && denial.tombstone.roots.includes(root)) result.obliterated.push(id);
      else result.corrupt.push(`${id}: invalid_erasure_role`);
      continue;
    }
    try {
      let object = held.get(id);
      if (object === undefined) {
        const bytes = carried.get(id) ?? store.read(id);
        if (bytes.type === "commit") object = { type: bytes.type, structure: decodeCommit(bytes.payload) };
        else if (bytes.type === "tree") object = { type: bytes.type, structure: decodeTree(bytes.payload) };
        else if (bytes.type === "manifest") object = { type: bytes.type, structure: decodeManifest(bytes.payload) };
        else {
          if (bytes.type === "link") decodeLink(bytes.payload);
          object = { type: bytes.type };
        }
        held.set(id, object);
      }
      const allowed = role === "payload" ? ["blob", "record", "link", "manifest"] : [role === "fragment" ? "blob" : role];
      if (!allowed.includes(object.type)) throw new ObjectStoreError("object_type_mismatch", "History reference has the wrong object kind.");
      if (object.type === "commit") {
        const commit = object.structure;
        pending.push({ id: commit.tree, role: "tree" }, ...commit.parents.map(/** Parent references always require real commits. */ (parent) => ({ id: parent, role: "commit" as const })));
      } else if (object.type === "tree") {
        for (const entry of object.structure) pending.push(entry.mode === "40000" ? { id: entry.id, role: "tree" } : { id: entry.id, role: "payload", fileId: entry.fileId, root: entry.id });
      } else if (object.type === "manifest") {
        for (const fragment of object.structure.fragments) pending.push({ id: fragment.id, role: "fragment", fileId, root });
      }

      verified.add(id);
    } catch (error) {
      if (!(error instanceof ObjectStoreError)) throw error;
      result[error.code === "object_not_found" || error.code === "missing_fragment" ? "missing" : "corrupt"].push(`${id}: ${error.code}`);
    }
  }
  result.verified = verified.size;
  if (denials.some(/** Interrupted deletion cannot establish a successful verification state. */ (denial) => denial.pending)) result.corrupt.push("erasure_incomplete");
  return result;
}

/** Refuse publication of an incomplete or incorrectly typed commit closure before any mutation. */
export function requireClosure(store: ObjectStore, targets: readonly ObjectId[], arrivals: readonly ObjectArrival[] = [], denials: readonly ErasureDenial[] = store.denials(), trees: readonly ObjectId[] = []): void {
  const report = inspectClosure(store, targets, arrivals, denials, false, trees);
  if (report.missing.length + report.corrupt.length > 0) throw new ObjectStoreError("incomplete_bundle", `History closure is invalid: ${[...report.missing, ...report.corrupt].join(", ")}.`);
}
