import { deflateSync } from "node:zlib";
import { fingerprint, fingerprintJournal, matchesFingerprints, readFingerprints, scanErasureStorage, erasureScanBoundary, type ErasureFingerprint, type ErasureFileClass, type ErasureStorageReport } from "./erasure-scan.ts";
import { durability } from "./durability.ts";
import { decodeConflict, conflictReferences } from "./conflicts.ts";
/** Authorized FileId-scoped erasure over the complete supported loose storage backend. */
import { type BigIntStats, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authorize, readLayers, assertCompositionPath, syncDirectory, writePrivateJson } from "./composition.ts";
import { payloadDigest, encodeTombstone, type ErasureDenial } from "./lifecycle.ts";
import { decodeManifest, decodeTree } from "./model.ts";
import { frameObject, hashObject, OBJECT_TYPES, readControlJson, ObjectStoreError, type ObjectId, type ObjectStore, type ObjectType } from "./objects.ts";
import { inspectClosure } from "./closure.ts";
import { inspectRepresentations } from "./representations.ts";
import { ALWAYS_IGNORED } from "./ignore.ts";
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
  /** Every surviving regular storage file was inspected, including harmless foreign files. */
  readonly storage: ErasureStorageReport;
}

/** Whole-store planning metadata excludes leaf buffers and retains only ownership and payload references. */
type InventoryObject =
  | { readonly type: "manifest" | "conflict"; readonly digest: string; readonly references: readonly ObjectId[] }
  | { readonly type: "tree"; readonly digest: string; readonly entries: ReturnType<typeof decodeTree> }
  | { readonly type: Exclude<ObjectType, "manifest" | "conflict" | "tree">; readonly digest: string };

/** Close one payload over all fragments and conflict alternatives, failing on incomplete inventory. */
function payloadClosure(id: ObjectId, inventory: ReadonlyMap<ObjectId, InventoryObject>, store: ObjectStore): Set<ObjectId> {
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
    if (object.type === "manifest" || object.type === "conflict") pending.push(...object.references);
    else if (object.type !== "blob" && object.type !== "record" && object.type !== "link") {
      throw new ObjectStoreError("incomplete_erasure_inventory", "A file entry names a non-payload object.");
    }
  }
  return selected;
}

/** Refuse unsupported control storage and temporary metadata copies before reporting physical erasure. */
function assertSupportedControl(control: string): void {
  const supported = new Set(["objects", "refs", "leases", "lease-proofs.json", "format", "index", "config.json", "HEAD", "oplog.jsonl", "remotes.json",
    "partial.json", "upload-roots.json", "identity", "credentials.json", "authority.json", "denials.json", "objects.lock", "objects.generation", "erasure-verification.json", "layers.json", "view.json", "dirty.json", "instances.json", "link.json", "unlinked-instances.json", "MERGE_STATE"]);
  for (const entry of readdirSync(control, { withFileTypes: true })) {
    if ((!supported.has(entry.name) && !(entry.isFile() && /^(?:objects\.(?:lock\.[0-9]+|generation)|(?:erasure-verification|denials)\.json)\.[0-9a-f]{12}\.tmp$/.test(entry.name))) || entry.isSymbolicLink()) {
      throw new ObjectStoreError("unsupported_erasure_storage", "Unknown control storage or symlinks prevent a complete erasure receipt.");
    }
  }
  const leases = join(control, "leases");
  if (existsSync(leases)) {
    if (!lstatSync(leases).isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Lease audits must occupy a real directory.");
    for (const entry of readdirSync(leases, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f]{32}\.jsonl$/.test(entry.name)) {
        throw new ObjectStoreError("unsupported_erasure_storage", "Unknown lease audit storage prevents a complete erasure receipt.");
      }
    }
  }
  if (existsSync(join(control, "MERGE_STATE"))) {
    throw new ObjectStoreError("erasure_merge_in_progress", "Finish or abort the merge before permanent erasure.");
  }
}

/** Detect recoverable selected bytes in raw, compressed and base64 worktree representations. */
function containsSelectedBytes(bytes: Buffer, payloads: readonly ErasureFingerprint[]): boolean {
  return inspectRepresentations(bytes, /** A retained full payload or fragment prevents a false physical-erasure receipt. */ (candidate) => matchesFingerprints(candidate, payloads));
}

/** Inspect a schema-validated live writer PID as raw and canonical base64 bytes, without mistaking decimal 80-prefixed PIDs for zlib streams. */
function containsPidBytes(bytes: Buffer, payloads: readonly ErasureFingerprint[]): boolean {
  if (matchesFingerprints(bytes, payloads)) return true;
  const text = bytes.toString("utf8");
  const decoded = Buffer.from(text, "base64");
  return decoded.toString("base64") === text && containsSelectedBytes(decoded, payloads);
}

/** Validate proposed and actual audit representations without retaining a selected payload in generated metadata. */
function assertAuditSafe(candidates: readonly Buffer[], payloads: readonly ErasureFingerprint[]): void {
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
    // Rewrite representation only after authorization and before taking the physical deletion inventory.
    store.unpack();
    const physical = new Map<string, ObjectId>();
    const inventory = new Map<ObjectId, InventoryObject>();
    for (const { id, path, object } of store.walkErasureInventory()) {
      const digest = payloadDigest(object.payload);
      physical.set(path, id);
      if (object.type === "manifest") {
        // Decode once: a legacy manifest has no pages, and decoding parses its complete fragment list.
        const manifest = decodeManifest(object.payload);
        inventory.set(id, { type: object.type, digest, references: (manifest.pages ?? manifest.fragments).map((fragment) => fragment.id) });
      }
      else if (object.type === "conflict") inventory.set(id, { type: object.type, digest, references: conflictReferences(decodeConflict(object.payload)) });
      else if (object.type === "tree") inventory.set(id, { type: object.type, digest, entries: decodeTree(object.payload) });
      else inventory.set(id, { type: object.type, digest });
    }
    const history = inspectClosure(store, [...inventory].filter(/** Every unreachable commit still requires a real structural closure. */ ([_id, object]) => object.type === "commit").map(/** Inspect all commit roots, not merely advertised refs. */ ([id]) => id), [], local.map(/** Pending payload absence is legitimate during an authorized cleanup retry. */ (denial) => ({ ...denial, pending: false })));
    if (history.missing.length + history.corrupt.length > 0) throw new ObjectStoreError("incomplete_erasure_inventory", "Complete historical structure is required before erasure.");
    const entries: { id: string; fileId?: string; conflicts?: readonly string[] }[] = [];
    for (const object of inventory.values()) {
      if (object.type === "tree") entries.push(...object.entries.filter(/** Directory identities belong to structure, never file payload. */ (entry) => entry.mode !== "40000"));
    }
    const indexes = new Map<Repository, IndexEntry[]>();
    for (const instance of instances) {
      const index = instance.readIndex();
      indexes.set(instance, index);
      entries.push(...index);
    }
    entries.push(...entries.flatMap((entry) => (entry.conflicts ?? []).map((id) => ({ id, fileId: entry.fileId }))));
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
    // Unattributed manifests and conflicts can retain selected payloads. They
    // cannot be erased under someone else's FileId or left recoverable.
    for (const [id, object] of inventory) {
      if ((object.type === "manifest" || object.type === "conflict") && !selected.has(id)
        && object.references.some(/** Refuse unknown payload owners before mutation. */ (reference) => selected.has(reference))) {
        throw new ObjectStoreError("erasure_dedup_conflict", "An unrelated manifest or conflict references payloads selected for erasure.");
      }
    }
    const proofsPath = join(control, "erasure-verification.json");
    const proofs = readFingerprints(readControlJson(proofsPath, "unsupported_erasure_storage", "erasure verification", fingerprintJournal({})));
    const payloads: ErasureFingerprint[] = [...(existing === undefined ? [] : proofs[existing.id] ?? [])];
    const loaded = new Set<ObjectId>();
    for (const [path, id] of physical) {
      if (!selected.has(id) || loaded.has(id)) continue;
      const object = store.readErasureObject(id, path);
      loaded.add(id);
      const frame = frameObject(object.type, object.payload);
      payloads.push(fingerprint(frame));
      // Payload denial is type-independent, including native members retyped before their wrappers were stripped.
      for (const kind of object.payload.length === 0 ? [object.type] : OBJECT_TYPES) {
        const member = frameObject(kind, object.payload);
        for (const level of [1, 6, 9]) payloads.push(fingerprint(deflateSync(member, { level }).subarray(2, -4)));
      }
      if (object.type !== "manifest" && object.payload.length > 0) payloads.push(fingerprint(object.payload), fingerprint(Buffer.from(object.payload.toString("base64"))));
    }
    if (payloads.length === 0) throw new ObjectStoreError("incomplete_erasure_inventory", "No byte-proof metadata is available; restore verified erasure evidence from its source before retrying. No physical-erasure success was certified.");
    const deleting = new Set([...physical].filter(([_path,id]) => selected.has(id)).map(([path]) => path));
    /** Include dormant object trees inside every registered instance's physical erasure scope. */
    const scanStorage = (excluded: ReadonlySet<string> = new Set()): ErasureStorageReport => {
      const roots = new Set([store.storageRoot(), ...instances.map((instance) => join(instance.controlDirectory, "objects")).filter((path) => existsSync(path))]);
      const classes: Partial<Record<ErasureFileClass, number>> = {}; let files = 0; let foreign = 0;
      for (const root of roots) {
        const report = scanErasureStorage(root, payloads, excluded); files += report.files; foreign += root === store.storageRoot() ? report.foreign : report.files;
        for (const [kind, count] of Object.entries(report.classes) as [ErasureFileClass, number][]) classes[kind] = (classes[kind] ?? 0) + count;
      }
      return { files, foreign, classes };
    };
    scanStorage(deleting);
    // A second complete verified pass checks identity/path stability without retaining unrelated leaves.
    const inspected = new Set<string>();
    for (const { path } of store.walkErasureInventory()) {
      if (!physical.has(path)) {
        throw new ObjectStoreError("incomplete_erasure_inventory", "Physical inventory changed between verified passes.");
      }
      inspected.add(path);
    }
    if (inspected.size !== physical.size) throw new ObjectStoreError("incomplete_erasure_inventory", "Physical inventory lost a copy between verified passes.");
    for (const instance of instances) {
      const leaseDirectory = join(instance.controlDirectory, "leases");
      if (existsSync(leaseDirectory)) {
        for (const name of readdirSync(leaseDirectory)) {
          if (containsSelectedBytes(readFileSync(join(leaseDirectory, name)), payloads)) {
            throw new ObjectStoreError("unsupported_erasure_storage", "Lease audit metadata retains selected payload bytes; clean the ambiguous copy before retrying.");
          }
        }
      }
      for (const entry of readdirSync(instance.controlDirectory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name !== "layers.json") {
          const bytes = readFileSync(join(instance.controlDirectory, entry.name));
          // A verified live writer's decimal PID is typed control metadata, not an encoded payload.
          // Other lock contents retain full representation inspection; raw selected bytes remain forbidden.
          const ownedPid = entry.name === "objects.lock" && bytes.equals(Buffer.from(String(process.pid)));
          const retained = ownedPid ? containsPidBytes(bytes, payloads) : containsSelectedBytes(bytes, payloads);
          if (retained) throw new ObjectStoreError("unsupported_erasure_storage", "Control metadata retains selected payload bytes; clean the ambiguous copy before retrying.");
        }
      }
    }
    const mutations = new Map<Repository, WorktreeMutation>();
    try {
      const removals = new Map<Repository, Map<string, BigIntStats>>();
      for (const [instance, index] of indexes) {
        const rules = instance.ignoreRules();
        if (!lstatSync(instance.controlDirectory).isDirectory()) throw new ObjectStoreError("unsafe_composition_path", "Repository control roots must be real directories.");
        const mutation = new WorktreeMutation(instance.root, ".pmvcs");
        mutations.set(instance, mutation);
        const paths = new Map<string, BigIntStats>();
        removals.set(instance, paths);
        const owned = new Set(index.filter(/** Worktree removal follows identity, not a historical path now reused by another file. */ (entry) => entry.fileId === fileId).map(/** Collect current paths belonging to the selected identity. */ (entry) => entry.path));
        for (const layer of readLayers(instance.controlDirectory, rules)) {
          for (const file of layer.files) {
            if (owned.has(file.path) || containsSelectedBytes(Buffer.from(file.content, "base64"), payloads)) {
              throw new ObjectStoreError("erasure_layer_conflict", "Remove affected private layers before authorized erasure.");
            }
          }
        }
        // Inspect observed leaves first, then any absent or excluded owned paths.
        const observed = new Set(listWorkingTree(instance.root, ".pmvcs", { patterns: [], negations: [], runtime: rules.runtime }, true));
        for (const path of new Set([...observed, ...owned])) {
          // Unowned tool artifacts, including submodule gitfiles, are outside the physical-erasure boundary.
          if (!owned.has(path) && path.split("/").some(/** Exclude tool-owned leaves without inspecting their bytes or link targets. */ (part) => (ALWAYS_IGNORED as readonly string[]).includes(part))) continue;
          assertCompositionPath(path, rules);
          const leaf = mutation.inspectForErasure(path);
          if (leaf === undefined) {
            if (owned.has(path) && !observed.has(path)) continue;
            throw new ObjectStoreError("worktree_path_changed", "An inspected working-tree leaf disappeared during erasure.");
          }
          if (owned.has(path)) paths.set(path, leaf.stat);
          else if (containsSelectedBytes(leaf.content, payloads)) {
            throw new ObjectStoreError("erasure_worktree_conflict", "An unrelated or untracked file retains selected bytes; remove the copy before retrying.");
          }
        }
      }
      const tombstone = existing?.tombstone ?? { version: 1 as const, fileId, roots: [...roots], objects: [...selected], payloads: [...selected].map(/** Hash actual physical payloads without copying them into audit metadata. */ (id) => inventory.get(id)!.digest), principal, timestamp: now.toISOString(), reason };
      const payload = encodeTombstone(tombstone);
      const id = hashObject("tombstone", payload);
      const denial: ErasureDenial = { id, tombstone, pending: true };
      const next = [...local.filter(/** Replace only this identity's cleanup state. */ (entry) => entry.tombstone.fileId !== fileId), denial];
      const completed = next.map(/** Completion follows durable deletion and never precedes it. */ (entry) => entry.id === id ? { ...entry, pending: false } : entry);
      const summary = `Obliterated FileId ${fileId}; tombstone ${id}.`;
      const operation = { sequence: repository.operations.read().length + 1, command: "obliterate", at: now.toISOString(), summary, refs: [] };
      assertAuditSafe([frameObject("tombstone", payload), Buffer.from(JSON.stringify(next)), Buffer.from(JSON.stringify(completed)), Buffer.from(`${JSON.stringify(operation)}\n`)], payloads);
      const signatures = [...new Map(payloads.map((item) => [`${item.length}:${item.rolling}:${item.digest}`,item])).values()];
      const updatedProofs = { ...proofs, [id]: signatures };
      assertAuditSafe([Buffer.from(JSON.stringify(fingerprintJournal(updatedProofs)))], payloads);
      if (JSON.stringify(proofs) !== JSON.stringify(updatedProofs)) writePrivateJson(proofsPath, fingerprintJournal(updatedProofs));
      erasureScanBoundary.visit("proof-persisted");
      // Preflight every proposed representation before the first audit-object or denial write.
      if (existing === undefined) store.write("tombstone", payload);
      store.recordDenials(next);
      erasureScanBoundary.visit("pending");
      const directories = new Set<string>();
      for (const [instance, paths] of removals) {
        for (const [path, stat] of paths) {
          mutations.get(instance)!.removeForErasure(path, stat);
          directories.add(dirname(join(instance.root, ...path.split("/"))));
        }
      }
      for (const [path, objectId] of physical) {
        if (!selected.has(objectId)) continue;
        durability.remove(path, { force: true });
        directories.add(dirname(path));
        erasureScanBoundary.visit("object-deleted");
      }
      for (const directory of directories) syncDirectory(directory);
      const storage = scanStorage();
      erasureScanBoundary.visit("storage-verified");
      store.recordDenials(completed);
      erasureScanBoundary.visit("completed");
      if (!repository.operations.read().some((entry) => entry.command === "obliterate" && entry.summary === summary)) {
        repository.operations.append("obliterate", summary, [], now, undefined, /** Validate the exact assigned receipt even if an independent log writer changed its sequence. */ (receipt) => assertAuditSafe([Buffer.from(`${JSON.stringify(receipt)}\n`)], payloads));
      }
      erasureScanBoundary.visit("receipt");
      return { fileId, tombstone: id, removed: [...selected].sort(), storage };
    } finally {
      for (const mutation of mutations.values()) mutation.close();
    }
  });
}
