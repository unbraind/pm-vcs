/** One bounded logical closure walk serves both retention and publication preconditions. */
import { decodeCommit, decodeManifest, decodeSeries, decodeTree } from "./model.ts";
import { decodeConflict, conflictReferences } from "./conflicts.ts";
import type { ObjectId, ObjectStore } from "./objects.ts";
import { assertVerificationBound, verificationLimits } from "./object-error.ts";

/** Traverse available history, sparse promises, manifests, conflicts and review series without changing storage. */
export function reachableObjects(store: ObjectStore, roots: Iterable<ObjectId>, visit?: () => void): Set<ObjectId> {
  const check = visit ?? reachabilityBudget();
  const partial = store.partialState(); const visited = new Set<ObjectId>(); const pending = [...roots];
  while (pending.length > 0) {
    check(); const id = pending.pop()!;
    if (visited.has(id) || store.denial(id) !== undefined) continue;
    visited.add(id);
    if (partial?.promised.includes(id) === true && !store.has(id)) continue;
    const object = store.read(id);
    if (object.type === "commit") { const commit = decodeCommit(object.payload); pending.push(commit.tree); for (const parent of commit.parents) if (partial?.shallow.includes(id) !== true || store.has(parent)) pending.push(parent); }
    else if (object.type === "tree") for (const entry of decodeTree(object.payload)) { check(); pending.push(entry.id); for (const conflict of entry.conflicts ?? []) pending.push(conflict); }
    else if (object.type === "conflict") { for (const source of conflictReferences(decodeConflict(object.payload))) pending.push(source); }
    else if (object.type === "manifest") { const manifest = decodeManifest(object.payload); for (const entry of manifest.pages ?? manifest.fragments) pending.push(entry.id); }
    else if (object.type === "series") { const series = decodeSeries(object.payload); pending.push(series.base); for (const patch of series.patches) pending.push(patch.commit); }
  }
  check(); return visited;
}
/** Share one dynamic bound counter across physical preflight and logical closure, including the final deadline. */
export function reachabilityBudget(): () => void {
  const started = performance.now(); let work = 0;
  return () => { assertVerificationBound("reachability", "object_count", ++work, verificationLimits.reachabilityObjects); assertVerificationBound("reachability", "time_ms", performance.now() - started, verificationLimits.reachabilityMs); };
}
