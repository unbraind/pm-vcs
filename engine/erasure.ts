/** Authorized FileId-scoped erasure over the complete supported loose storage backend. */
import { existsSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authorize, readLayers, assertSafeFilePath, syncDirectory } from "./composition.ts";
import { payloadDigest, encodeTombstone, type ErasureDenial } from "./lifecycle.ts";
import { decodeManifest, decodeTree } from "./model.ts";
import { frameObject, hashObject, ObjectStoreError, type ObjectId, type ObjectStore, type StoredObject } from "./objects.ts";
import { inspectClosure } from "./closure.ts";
import { inspectRepresentations } from "./representations.ts";
import { listWorkingTree, type IndexEntry } from "./worktree.ts";
import { WorktreeMutation } from "./worktree-mutation.ts";
import type { Repository } from "./repo.ts";

/** Complete physical-erasure receipt, without retaining the erased bytes. */
export interface ErasureReceipt {
  /** Terminal FileId. */
  readonly fileId: string;
  /** Canonical typed audit address. */
  readonly tombstone: ObjectId;
  /** Permanently denied object addresses, including fragments. */
  readonly removed: readonly ObjectId[];
}

/** Close one payload over all manifest fragments, failing on incomplete inventory. */
function payloadClosure(id: ObjectId, inventory: ReadonlyMap<ObjectId, StoredObject>, store: ObjectStore): Set<ObjectId> {
  const selected = new Set<ObjectId>();
  const pending = [id];
  while (pending.length > 0) {
    const current = pending.pop() as ObjectId;
    if (selected.has(current)) continue;
    selected.add(current);
    const object = inventory.get(current);
    if (object === undefined) {
      if (store.denial(current) !== undefined) continue;
      throw new ObjectStoreError("incomplete_erasure_inventory", "History or index names payloads absent from the complete inventory.");
    }
    if (object.type === "manifest") pending.push(...decodeManifest(object.payload).fragments.map(/** Include every fragment even outside current refs. */ (fragment) => fragment.id));
    else if (object.type !== "blob" && object.type !== "record" && object.type !== "link") {
      throw new ObjectStoreError("incomplete_erasure_inventory", "A file entry names a non-payload object.");
    }
  }
  return selected;
}

/** Refuse unsupported control storage and temporary metadata copies before reporting physical erasure. */
function assertSupportedControl(control: string): void {
  const supported = new Set(["objects", "refs", "format", "index", "config.json", "HEAD", "oplog.jsonl", "remotes.json",
    "identity", "credentials.json", "authority.json", "denials.json", "objects.lock", "layers.json", "view.json", "dirty.json", "instances.json", "link.json", "unlinked-instances.json", "MERGE_STATE"]);
  for (const entry of readdirSync(control, { withFileTypes: true })) {
    if ((!supported.has(entry.name) && !(entry.isFile() && /^objects\.lock\.[0-9]+\.[0-9a-f]{12}\.tmp$/.test(entry.name))) || entry.isSymbolicLink()) {
      throw new ObjectStoreError("unsupported_erasure_storage", "Unknown control storage or symlinks prevent a complete erasure receipt.");
    }
  }
  if (existsSync(join(control, "MERGE_STATE"))) {
    throw new ObjectStoreError("erasure_merge_in_progress", "Finish or abort the merge before permanent erasure.");
  }
}

/** Detect recoverable selected bytes in raw, compressed and base64 worktree representations. */
function containsSelectedBytes(bytes: Buffer, payloads: readonly Buffer[]): boolean {
  return inspectRepresentations(bytes, /** A retained full payload or fragment prevents a false physical-erasure receipt. */ (candidate) => payloads.some(/** Preserve ambiguous or independently owned copies rather than deleting them. */ (payload) => candidate.includes(payload)));
}

/** Validate proposed and actual audit representations without retaining a selected payload in generated metadata. */
function assertAuditSafe(candidates: readonly Buffer[], payloads: readonly Buffer[]): void {
  for (const candidate of candidates) if (containsSelectedBytes(candidate, payloads)) {
    throw new ObjectStoreError("erasure_audit_conflict", "Generated audit metadata retains selected bytes; choose nonconflicting bounded metadata before retrying.");
  }
}

/** Permanently erase a stable identity, or resume its already authorized pending cleanup. */
export function eraseFile(repository: Repository, instances: readonly Repository[], selector: string, credential: string, reason: string, now: Date): ErasureReceipt {
  const store = repository.objects;
  const control = repository.instanceLink?.controlDirectory ?? repository.controlDirectory;
  return store.withWriteLock(/** Hold the same writer lock for planning, durable denial and every deletion. */ () => {
    const principal = authorize(control, "erase", credential);
    syncDirectory(control);
    const local = store.denials();
    const fileId = /^[0-9a-f]{32}$/.test(selector) ? selector : repository.readIndex().find(/** Resolve a path only through its stable staged identity. */ (entry) => entry.path === selector)?.fileId;
    if (fileId === undefined) throw new ObjectStoreError("unknown_file", "Obliteration needs a known FileId or indexed path.");
    const existing = local.find(/** Retry uses the original immutable audit metadata. */ (entry) => entry.tombstone.fileId === fileId);
    for (const instance of instances) assertSupportedControl(instance.controlDirectory);
    assertSupportedControl(control);
    const physical = store.inventory();
    const inventory = new Map(physical.map(/** Deduplicate canonical files and valid temporary copies by content ID. */ (entry) => [entry.id, entry.object]));
    const history = inspectClosure(store, [...inventory].filter(/** Every unreachable commit still requires a real structural closure. */ ([_id, object]) => object.type === "commit").map(/** Inspect all commit roots, not merely advertised refs. */ ([id]) => id), [], local.map(/** Pending payload absence is legitimate during an authorized cleanup retry. */ (denial) => ({ ...denial, pending: false })));
    if (history.missing.length + history.corrupt.length > 0) throw new ObjectStoreError("incomplete_erasure_inventory", "Complete historical structure is required before erasure.");
    const entries: { id: string; fileId?: string }[] = [];
    for (const object of inventory.values()) {
      if (object.type === "tree") entries.push(...decodeTree(object.payload).filter(/** Directory identities belong to structure, never file payload. */ (entry) => entry.mode !== "40000"));
    }
    const indexes = new Map<Repository, IndexEntry[]>();
    for (const instance of instances) {
      const index = instance.readIndex();
      indexes.set(instance, index);
      entries.push(...index);
    }
    const roots = new Set(existing?.tombstone.roots ?? []);
    for (const entry of entries) if (entry.fileId === fileId) roots.add(entry.id);
    if (roots.size === 0) throw new ObjectStoreError("unknown_file", "No payload is attributable to this FileId.");
    const selected = new Set(existing?.tombstone.objects ?? []);
    for (const root of roots) for (const id of payloadClosure(root, inventory, store)) selected.add(id);
    for (const entry of entries) {
      if (entry.fileId === fileId) continue;
      for (const id of payloadClosure(entry.id, inventory, store)) {
        if (selected.has(id)) throw new ObjectStoreError("erasure_dedup_conflict", "Another FileId or legacy file owns bytes selected for erasure.");
      }
    }
    // Unattributed manifests can retain or reconstruct fragments. They cannot
    // be erased under someone else's FileId or silently left recoverable.
    for (const [id, object] of inventory) {
      if (object.type === "manifest" && !selected.has(id)
        && decodeManifest(object.payload).fragments.some(/** Refuse unknown fragment owners before mutation. */ (fragment) => selected.has(fragment.id))) {
        throw new ObjectStoreError("erasure_dedup_conflict", "An unrelated manifest shares fragments selected for erasure.");
      }
    }
    const payloads = [...selected].flatMap(/** Only nonempty physical payloads can occur in worktree copies. */ (id) => {
      const object = inventory.get(id);
      return object !== undefined && object.type !== "manifest" && object.payload.length > 0 ? [object.payload] : [];
    });
    for (const object of physical) {
      if (!selected.has(object.id) && containsSelectedBytes(object.object.payload, payloads)) {
        throw new ObjectStoreError("erasure_retained_copy", "A surviving physical object retains selected bytes; remove the explicit copy before retrying.");
      }
    }
    for (const instance of instances) {
      for (const entry of readdirSync(instance.controlDirectory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name !== "layers.json" && containsSelectedBytes(readFileSync(join(instance.controlDirectory, entry.name)), payloads)) {
          throw new ObjectStoreError("unsupported_erasure_storage", "Control metadata retains selected payload bytes; clean the ambiguous copy before retrying.");
        }
      }
    }
    const mutations = new Map<Repository, WorktreeMutation>();
    try {
      const removals = new Map<Repository, Set<string>>();
      for (const [instance, index] of indexes) {
        const rules = instance.ignoreRules();
        mutations.set(instance, new WorktreeMutation(instance.root, ".pmvcs"));
        const paths = new Set<string>();
        removals.set(instance, paths);
        const owned = new Set(index.filter(/** Worktree removal follows identity, not a historical path now reused by another file. */ (entry) => entry.fileId === fileId).map(/** Collect current paths belonging to the selected identity. */ (entry) => entry.path));
        for (const layer of readLayers(instance.controlDirectory, rules)) {
          for (const file of layer.files) {
            if (owned.has(file.path) || containsSelectedBytes(Buffer.from(file.content, "base64"), payloads)) {
              throw new ObjectStoreError("erasure_layer_conflict", "Remove affected private layers before authorized erasure.");
            }
          }
        }
        for (const path of listWorkingTree(instance.root, ".pmvcs", { patterns: [], negations: [], runtime: rules.runtime })) {
          assertSafeFilePath(instance.root, path, rules);
          const absolute = join(instance.root, ...path.split("/"));
          if (owned.has(path)) paths.add(path);
          else if (containsSelectedBytes(readFileSync(absolute), payloads)) {
            throw new ObjectStoreError("erasure_worktree_conflict", "An unrelated or untracked file retains selected bytes; remove the copy before retrying.");
          }
        }
        // Ignored but owned paths must still be scrubbed.
        for (const path of owned) {
          assertSafeFilePath(instance.root, path, rules);
          const absolute = join(instance.root, ...path.split("/"));
          if (existsSync(absolute)) paths.add(path);
        }
      }
      const tombstone = existing?.tombstone ?? { version: 1 as const, fileId, roots: [...roots], objects: [...selected], payloads: [...selected].map(/** Hash actual physical payloads without copying them into audit metadata. */ (id) => payloadDigest(inventory.get(id)!.payload)), principal, timestamp: now.toISOString(), reason };
      const payload = encodeTombstone(tombstone);
      const id = hashObject("tombstone", payload);
      const denial: ErasureDenial = { id, tombstone, pending: true };
      const next = [...local.filter(/** Replace only this identity's cleanup state. */ (entry) => entry.tombstone.fileId !== fileId), denial];
      const completed = next.map(/** Completion follows durable deletion and never precedes it. */ (entry) => entry.id === id ? { ...entry, pending: false } : entry);
      const summary = `Obliterated FileId ${fileId}; tombstone ${id}.`;
      const operation = { sequence: repository.operations.read().length + 1, command: "obliterate", at: now.toISOString(), summary, refs: [] };
      assertAuditSafe([frameObject("tombstone", payload), Buffer.from(JSON.stringify(next)), Buffer.from(JSON.stringify(completed)), Buffer.from(`${JSON.stringify(operation)}\n`)], payloads);
      // Preflight every proposed representation before the first audit-object or denial write.
      if (existing === undefined) store.write("tombstone", payload);
      store.recordDenials(next);
      const directories = new Set<string>();
      for (const [instance, paths] of removals) {
        for (const path of paths) {
          mutations.get(instance)!.remove(path);
          directories.add(dirname(join(instance.root, ...path.split("/"))));
        }
      }
      for (const path of new Set(physical.filter(/** Delete every canonical and temporary representation. */ (entry) => selected.has(entry.id)).map(/** Retain only the deletion target, never payload bytes in the receipt. */ (entry) => entry.path))) {
        rmSync(path, { force: true });
        directories.add(dirname(path));
      }
      for (const directory of directories) syncDirectory(directory);
      store.recordDenials(completed);
      repository.operations.append("obliterate", summary, [], now, undefined, /** Validate the exact assigned receipt even if an independent log writer changed its sequence. */ (receipt) => assertAuditSafe([Buffer.from(`${JSON.stringify(receipt)}\n`)], payloads));
      return { fileId, tombstone: id, removed: [...selected].sort() };
    } finally {
      for (const mutation of mutations.values()) mutation.close();
    }
  });
}
