import { accountErasureStorage, planErasureStorage, erasurePurge, type ErasurePurgeReceipt, type ErasureAccountabilityReport } from "./erasure-accountability.ts";
import { prepareDestruction, type DestructionReceipt } from "./destruction.ts";
import { deflateSync } from "node:zlib";
import { fingerprint, fingerprintJournal, matchesFingerprints, readFingerprints, scanErasureStorage, inspectErasureRepresentation, createErasureInspection, inspectErasureFile, erasureScanBoundary, ErasureStorageRefusal, type ErasureFingerprint } from "./erasure-scan.ts";
import { durability } from "./durability.ts";
import { VerificationRefusal, assertVerificationBound, verificationLimits } from "./object-error.ts";
import { decodeConflict, conflictReferences } from "./conflicts.ts";
/** Authorized FileId-scoped erasure over accountable loose and packed storage. */
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

/** Explicit authorization for removal of unaccounted physical storage. */
export interface ErasureOptions { readonly purgeUnaccounted?: boolean; readonly recoverLock?: boolean }

/** A successful certificate includes a bounded durable purge receipt. */
export interface ErasureReceipt {
  readonly destruction: { readonly objects: DestructionReceipt; readonly worktrees: readonly DestructionReceipt[]; readonly omittedWorktrees: number };
  readonly purge: ErasurePurgeReceipt;
  /** Terminal FileId. */
  readonly fileId: string;
  /** Canonical typed audit address. */
  readonly tombstone: ObjectId;
  /** Permanently denied object addresses, including fragments. */
  readonly removed: readonly ObjectId[];
  /** Every surviving regular storage file is a complete, verified native representation. */
  readonly storage: ErasureAccountabilityReport;
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
  const supported = new Set(["objects", "refs", "leases", "destruction", "lease-proofs.json", "format", "index", "config.json", "HEAD", "oplog.jsonl", "remotes.json",
    "partial.json", "upload-roots.json", "identity", "credentials.json", "authority.json", "denials.json", "objects.lock", "objects.recovery.lock", "objects.generation", "erasure-verification.json", "erasure-purge.json", "layers.json", "view.json", "dirty.json", "instances.json", "link.json", "unlinked-instances.json", "MERGE_STATE"]);
  for (const entry of readdirSync(control, { withFileTypes: true })) {
    if ((!supported.has(entry.name) && !(entry.isFile() && /^(?:objects\.(?:(?:recovery\.)?lock\.[0-9]+|generation)|(?:erasure-verification|erasure-purge|denials)\.json)\.[0-9a-f]{12}\.tmp$/.test(entry.name))) || entry.isSymbolicLink()) {
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

/** Internal success sentinel closes all pinned preflight resources without executing an erasure. */
class ErasureValidated extends Error {}
/** Validate the complete flag shape before either ordinary or recovery lease mutation. */
export function assertErasureOptions(options: ErasureOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["purgeUnaccounted", "recoverLock"].includes(key)) || [options.purgeUnaccounted, options.recoverLock].some(value => value !== undefined && typeof value !== "boolean")) throw new ObjectStoreError("invalid_erasure_options", "Use only boolean purgeUnaccounted and recoverLock options; incompatible or unknown flags refuse before deletion.");
}
/** Recovery validates the same complete request while holding a revision CAS, leaving stale locks intact on refusal. */
export function validateErasureRequest(repository: Repository, instances: readonly Repository[], selector: string, credential: string, reason: string, now: Date, options: ErasureOptions): void {
  try { eraseFile(repository, instances, selector, credential, reason, now, options, true); }
  catch (error) { if (!(error instanceof ErasureValidated)) throw error; }
}

/** Permanently erase a stable identity, or resume its already authorized pending cleanup. */
export function eraseFile(repository: Repository, instances: readonly Repository[], selector: string, credential: string, reason: string, now: Date, options: ErasureOptions = {}, validateOnly = false): ErasureReceipt {
  const store = repository.objects;
  const control = repository.instanceLink?.controlDirectory ?? repository.controlDirectory;
  const execute = (): ErasureReceipt => {
    const started = performance.now();
    /** Time exhaustion is a refusal before mutation and again before final certification. */
    const check = (): void => assertVerificationBound("erasure", "time_ms", performance.now() - started, verificationLimits.erasureMs);
    check();
    assertErasureOptions(options);
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new ObjectStoreError("bad_tombstone", "Erasure requires a valid audit timestamp.");
    const principal = authorize(control, "erase", credential);
    syncDirectory(control);
    const local = store.denials();
    const fileId = /^[0-9a-f]{32}$/.test(selector) ? selector : repository.readIndex().find(/** Resolve a path only through its stable staged identity. */ (entry) => entry.path === selector)?.fileId;
    if (fileId === undefined) throw new ObjectStoreError("unknown_file", "Obliteration needs a known FileId or indexed path.");
    const existing = local.find(/** Retry uses the original immutable audit metadata. */ (entry) => entry.tombstone.fileId === fileId);
    // Validate audit arguments with the canonical codec before an explicitly authorized purge can remove bytes.
    if (existing === undefined) {
      const placeholder = hashObject("blob", Buffer.alloc(0));
      encodeTombstone({ version: 1, fileId, roots: [placeholder], objects: [placeholder], payloads: [], principal, timestamp: now.toISOString(), reason });
    }
    for (const instance of instances) assertSupportedControl(instance.controlDirectory);
    assertSupportedControl(control);
    const objectRoots = [...new Set([store.storageRoot(), ...instances.map((instance) => join(instance.controlDirectory, "objects"))])];
    const purgeFiles = planErasureStorage(objectRoots);
    const excluded = new Set(purgeFiles.map(file => file.path));
    const physical = new Map<string, ObjectId>();
    const inventory = new Map<ObjectId, InventoryObject>();
    const locations = new Map<ObjectId, string>();
    for (const { id, path, object } of store.walkErasureInventory("all", excluded)) {
      locations.set(id, path);
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
    if (history.verification.status === "unverified" || history.missing.length + history.corrupt.length > 0) throw new ObjectStoreError("incomplete_erasure_inventory", "Complete historical structure is required before erasure.");
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
    const authorization = erasurePurge(control, fileId, objectRoots, options.purgeUnaccounted === true, true);
    if (purgeFiles.length > 0 && !authorization.canPurge) throw new ErasureStorageRefusal("unverifiable", purgeFiles[0].fileClass);
    const proofsPath = join(control, "erasure-verification.json");
    let proofs: Record<string, ErasureFingerprint[]> = {};
    try { proofs = readFingerprints(readControlJson(proofsPath, "unsupported_erasure_storage", "erasure verification", fingerprintJournal({}))); }
    catch { throw new VerificationRefusal("erasure", "decode_error", "Restore the original valid fingerprint evidence; foreign verification metadata was preserved."); }
    const payloads: ErasureFingerprint[] = [...(existing === undefined ? [] : proofs[existing.id] ?? [])];
    const loaded = new Set<ObjectId>();
    for (const [id, path] of locations) {
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
    const deleting = new Set([...locations].filter(([id]) => selected.has(id)).map(([_id, path]) => path));
    for (const file of purgeFiles) deleting.add(file.path);
    /** Both native accountability and complete byte inspection are required for a certificate. */
    const diagnose = (excluded: ReadonlySet<string>, decoded = true): void => {
      if (payloads.length === 0) throw new VerificationRefusal("erasure", "missing_evidence", "Restore the original physical inspection evidence before certification.");
      try {
        // Parse the known native encoding once; compressed byte noise is not a nested representation.
        // Every surviving pack member participates, even when its pack also holds selected bytes.
        if (decoded) for (const { id, object } of store.walkErasureInventory("all", new Set(purgeFiles.filter(file => excluded.has(file.path)).map(file => file.path)))) {
          if (!selected.has(id)) inspectErasureRepresentation(frameObject(object.type, object.payload), payloads);
        }
        for (const root of objectRoots.filter((path) => existsSync(path))) scanErasureStorage(root, payloads, excluded, false);
      } catch (error) {
        if (error instanceof ObjectStoreError && error.code === "erasure_retained_copy") throw error;
        if (error instanceof VerificationRefusal) throw error;
        throw new VerificationRefusal("erasure", "decode_error", "Byte inspection did not complete; native accountability cannot replace that proof.");
      }
    };
    diagnose(deleting);
    // A second complete verified pass checks identity/path stability without retaining unrelated leaves.
    const inspected = new Set<string>();
    for (const { path } of store.walkErasureInventory("all", excluded)) {
      if (!physical.has(path)) {
        if (path.endsWith(".tmp")) throw new ErasureStorageRefusal("unverifiable", "temporary-storage");
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
          const ownedPid = (entry.name === "objects.lock" || entry.name === "objects.recovery.lock" || /^objects\.(?:recovery\.)?lock\.[0-9]+\.[0-9a-f]{12}\.tmp$/.test(entry.name)) && /^[1-9][0-9]*$/.test(bytes.toString("utf8"));
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
      // Every authorization, logical identity, ownership, worktree and audit check above is read-only.
      // Only this frozen set can be purged, even if a new foreign file arrives during execution.
      const signatures = [...new Map(payloads.map(item => [`${item.length}:${item.rolling}:${item.digest}`, item])).values()];
      const updatedProofs = { ...proofs, [id]: signatures };
      assertAuditSafe([Buffer.from(JSON.stringify(fingerprintJournal(updatedProofs)))], payloads);
      const probe = erasurePurge(control, fileId, objectRoots, options.purgeUnaccounted === true, true);
      if (purgeFiles.length > 0 && !probe.canPurge) throw new ErasureStorageRefusal("unverifiable", purgeFiles[0].fileClass);
      if (validateOnly) {
        if (containsPidBytes(Buffer.from(String(process.pid)), payloads)) throw new ObjectStoreError("erasure_audit_conflict", "Proposed recovery lease metadata retains selected bytes; no existing lease was retired.");
        throw new ErasureValidated();
      }
      check();
      const purge = erasurePurge(control, fileId, objectRoots, options.purgeUnaccounted === true);
      if (purgeFiles.length > 0 && !purge.canPurge) throw new ErasureStorageRefusal("unverifiable", purgeFiles[0].fileClass);
      const planned = new Map(purgeFiles.map(file => [file.path, file]));
      const accountStorage = (strict = false, representations = false): ErasureAccountabilityReport => accountErasureStorage(objectRoots, {
        forbiddenIds: strict ? new Set([...selected, ...store.denials().flatMap(entry => entry.tombstone.objects)]) : new Set(),
        forbiddenPayloads: strict ? new Set([...store.denials().flatMap(entry => entry.tombstone.payloads), ...[...selected].flatMap(id => inventory.has(id) ? [inventory.get(id)!.digest] : [])]) : new Set(),
        inspection: representations ? (_id, frameBytes, kind) => createErasureInspection(payloads, frameBytes, kind) : undefined,
        physical: representations ? (fd, bytes, kind, budget) => inspectErasureFile(fd, bytes, payloads, kind, budget) : undefined,
        purge: purge.canPurge ? (file, remove) => {
          const expected = planned.get(file.path);
          if (expected === undefined || expected.identity !== file.identity || expected.sha256 !== file.sha256) throw new ErasureStorageRefusal("unverifiable", file.fileClass);
          return purge.purge(file, () => { store.markStorageGeneration(); remove(); });
        } : undefined,
      });
      const worktreePlans = [...removals].map(([instance, paths]) => mutations.get(instance)!.planErasure(fileId, paths, existing?.pending === true));
      if (options.purgeUnaccounted === true) purge.begin(purgeFiles); else purge.plan(purgeFiles, true);
      if (JSON.stringify(proofs) !== JSON.stringify(updatedProofs)) writePrivateJson(proofsPath, fingerprintJournal(updatedProofs));
      erasureScanBoundary.visit("proof-persisted");
      // Preflight every proposed representation before the first audit-object or denial write.
      // recordDenials publishes verified audit objects even while another authorized cleanup is pending.
      store.recordDenials(next);
      erasureScanBoundary.visit("pending");
      accountStorage();
      store.unpack();
      physical.clear();
      for (const { id: objectId, path } of store.walkErasureInventory()) physical.set(path, objectId);
      const deletion = prepareDestruction(control, `obliterate-objects:${fileId}`, [...physical].filter(([_path, objectId]) => selected.has(objectId)).map(([path]) => ({ path })), existing?.pending === true, undefined, false, "eligibility_changed");
      const directories = new Set<string>();
      const worktreeReceipts: DestructionReceipt[] = [];
      for (const plan of worktreePlans) { for (const path of plan.paths) { plan.remove(path); directories.add(dirname(path)); } worktreeReceipts.push(plan.finish()); }
      for (const path of deletion.paths) {
        deletion.remove(path); directories.add(dirname(path)); erasureScanBoundary.visit("object-deleted");
      }
      const objectReceipt = deletion.finish();
      for (const directory of directories) syncDirectory(directory);
      accountStorage(true);
      erasureScanBoundary.visit("storage-verified");
      erasureScanBoundary.visit("completed");
      erasureScanBoundary.visit("receipt");
      for (const instance of instances) assertSupportedControl(instance.controlDirectory);
      assertSupportedControl(control);
      check(); diagnose(new Set(), false);
      const certified = { purgeReceipt: purge.receipt(), storage: accountStorage(true, true) };
      check();
      const { purgeReceipt } = certified;
      const storage = certified.storage;
      // No observer callback follows the final namespace barrier before completion publication.
      store.recordDenials(completed);
      if (!repository.operations.read().some((entry) => entry.command === "obliterate" && entry.summary === summary)) {
        repository.operations.append("obliterate", summary, [], now, undefined, /** Validate the exact assigned receipt. */ (receipt) => assertAuditSafe([Buffer.from(`${JSON.stringify(receipt)}\n`)], payloads));
      }
      return { destruction: { objects: objectReceipt, worktrees: worktreeReceipts.slice(0, 20), omittedWorktrees: Math.max(0, worktreeReceipts.length - 20) }, fileId, tombstone: id, removed: [...selected].sort(), storage, purge: purgeReceipt };
    } finally {
      for (const mutation of mutations.values()) mutation.close();
    }
  };
  return validateOnly ? execute() : store.withWriteLock(execute);
}
