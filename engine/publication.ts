/** Native publication owns the same lease and logical dependencies as collection. */
import { constants, fstatSync, lstatSync, readFileSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import { ObjectStore, isObjectId, type ObjectId } from "./objects.ts";
import { ObjectStoreError, VerificationRefusal, assertVerificationBound, verificationLimits } from "./object-error.ts";
import { objectFiles } from "./object-files.ts";
import { namespacePublicationContext } from "./destruction.ts";
import { resolveInstanceLink } from "./instance-link.ts";
import { decodeIndex } from "./worktree.ts";
import { validateDenials } from "./lifecycle.ts";
import { reachableObjects } from "./reachability.ts";
import { configureNativePublication, nativePublicationKind } from "./publication-gate.ts";

/** Resolve linked instances through their existing binding and preserve the active store lease. */
export function withPublicationLock<T>(destination: string, action: () => T): T {
 const context = namespacePublicationContext(destination); if (context === undefined) return action();
 const control = resolveInstanceLink(context.control, dirname(context.control))?.controlDirectory ?? context.control;
 const owner = objectFiles.storageOwners.get(realpathSync(control));
 if (owner !== undefined) { if (!owner()) throw new ObjectStoreError("worktree_path_changed", "The publication store owner changed; retry after its lease is safely recovered."); return action(); }
 return new ObjectStore(join(control, "objects")).withWriteLock(action);
}
/** Require canonical object identities without treating stable ChangeIds, payload digests or credentials as objects. */
function ids(value: unknown): ObjectId[] { if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !isObjectId(id))) throw new ObjectStoreError("unsafe_gc_roots", "Publication root addresses are corrupt."); return value; }
/** Only logical native roots participate in pending-publication retention. */
export function isRootPublication(destination: string): boolean { return nativePublicationKind(destination) !== undefined; }
/** Upload pins name arrivals individually and may precede missing children; they do not advertise a complete root graph. */
export function isDeferredPublication(destination: string): boolean { return nativePublicationKind(destination) === "upload-roots.json"; }
/** Shared pinned decoder accepts an optional existing-object filter for future upload pins. */
export function publicationRootsFromFd(fd: number, destination: string, store?: ObjectStore): ObjectId[] {
 const stat = fstatSync(fd, { bigint: true }); assertVerificationBound("receipts", "record_bytes", Number(stat.size), verificationLimits.receiptBytes);
 const roots = publicationRootIds(destination, readFileSync(fd, "utf8"));
 return nativePublicationKind(destination) === "upload-roots.json" && store !== undefined ? roots.filter(id => store.has(id)) : roots;
}
/** Decode both active and prepared root-bearing native formats through their existing codecs. */
export function publicationRootIds(destination: string, bytes: string): ObjectId[] {
 const format = nativePublicationKind(destination); if (format === undefined) return [];
 if (format === "ref" || format === "HEAD") { const value = bytes.trim(); if (format === "HEAD" && value.startsWith("ref: ")) return []; return ids([value]); }
 if (format === "index") return decodeIndex(bytes).flatMap(entry => [entry.id, ...(entry.conflicts ?? [])]);
 let value: unknown; try { value = JSON.parse(bytes); } catch { throw new ObjectStoreError("unsafe_gc_roots", "Publication metadata is not complete JSON."); }
 if (format === "denials.json") return validateDenials(value).map(entry => entry.id);
 if (format === "upload-roots.json") return ids(value);
 if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ObjectStoreError("unsafe_gc_roots", "Publication merge state is corrupt.");
 const state = value as { ours?: unknown; theirs?: unknown; bases?: unknown }; return ids([state.ours, state.theirs, ...ids(state.bases)]);
}
/** Pin and bound prepared control bytes; never interpret compressed objects or unrelated private metadata as roots. */
export function readPublicationRoots(source: string, destination: string): ObjectId[] {
 if (nativePublicationKind(destination) === undefined) return [];
 const file = objectFiles.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
 try { const before = fstatSync(file.fd, { bigint: true }); const roots = publicationRootsFromFd(file.fd, destination); const after = lstatSync(source, { bigint: true, throwIfNoEntry: false }); if (after === undefined || stamp(before) !== stamp(after) || stamp(before) !== stamp(fstatSync(file.fd, { bigint: true }))) throw new VerificationRefusal("receipts", "namespace_changed", "The pinned publication source changed before validation ended."); return roots; }
 finally { file.close(); }
}
/** Full immutable byte/namespace evidence fences every prepared control-source read. */
function stamp(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
/** Revalidate dependencies under the declared shallow/promise policy immediately before fresh or recovered publication. */
export function validatePublication(source: string, destination: string): void {
 const context = namespacePublicationContext(destination); if (context === undefined) return;
 const roots = readPublicationRoots(source, destination); if (roots.length === 0) return;
 validatePublicationIds(destination, roots);
}
/** Validate a fresh request before lease recovery can perform any prior operation. */
export function validatePublicationIds(destination: string, roots: readonly ObjectId[]): void {
 const context = namespacePublicationContext(destination); if (context === undefined || roots.length === 0) return;
 const control = resolveInstanceLink(context.control, dirname(context.control))?.controlDirectory ?? context.control;
 const store = new ObjectStore(join(control, "objects"));
 const format = nativePublicationKind(destination);
 if (format === "upload-roots.json") return; // Pins deliberately precede their corresponding arrivals.
 // A replacement denial registry repairs its own prior unreadable state. Audit
 // objects have no outgoing edges and are verified physically under this lease.
 if (format === "denials.json") {
  for (const id of roots) if (store.readErasureObject(id, join(store.storageRoot(), id.slice(0, 2), id.slice(2))).type !== "tombstone") throw new ObjectStoreError("bad_tombstone", "Denial publication requires canonical audit objects.");
  return;
 }
 for (const id of roots) {
  if (store.denial(id) !== undefined) { if (format === "index") continue; throw new ObjectStoreError("object_obliterated", "Publication cannot revive a permanently denied root."); }
  if (format !== "index" && !store.has(id)) throw new VerificationRefusal("reachability", "missing_object", "A publication target is unavailable; restore it before replaying the recorded transition.", "publication_unverified");
 }
 const proof = objectFiles.publicationClosures.get(realpathSync(control));
 if (proof !== undefined && proof.owner === objectFiles.storageOwners.get(realpathSync(control)) && proof.owner() && roots.every(id => proof.roots.has(id)) && proof.policy === JSON.stringify([store.partialState(), store.denials()])) return;
 try { reachableObjects(store, roots); }
 catch (error) { if (!(error instanceof ObjectStoreError) || error instanceof VerificationRefusal) throw error; throw new VerificationRefusal("reachability", error.code === "object_not_found" ? "missing_object" : "decode_error", "Publication dependencies are unavailable; restore their verified objects and retry the recorded intent.", "publication_unverified"); }
 const owner = objectFiles.storageOwners.get(realpathSync(control));
 if (owner !== undefined && owner()) {
  const policy = JSON.stringify([store.partialState(), store.denials()]);
  const previous = proof !== undefined && proof.owner === owner && proof.policy === policy ? proof.roots : [];
  objectFiles.publicationClosures.set(realpathSync(control), { owner, roots: new Set([...previous, ...roots]), policy });
 }
}

// Registration captures functions only; native I/O starts after the module graph is initialized.
configureNativePublication({ within: withPublicationLock, validate: validatePublication });
