import { derivations, upgradeDerivations, unknownDerivations, clearDerivations, UncataloguedProvenance } from "./derivations.ts";
import { nativeOutputs, outputBirth } from "./native-outputs.ts";
import { parseFileLeaseAudit } from "./publication-leases.ts";
import { payloadOwners } from "./payload-owners.ts";
import { accountErasureStorage, planErasureStorage, erasurePurge, parseErasurePurgeJournal, type ErasurePurgeReceipt, type ErasureAccountabilityReport } from "./erasure-accountability.ts";
import { assertDestructionStorage, prepareDestruction, type DestructionReceipt } from "./destruction.ts";
import { assertRefName } from "./refs.ts";
import { createHash } from "node:crypto";
import { manifestIdentities, recordRepresentations } from "./erasure-provenance.ts";
import { erasureOperations } from "./oplog.ts";
import { managedExports } from "./managed-exports.ts";
import { fingerprint, fingerprintJournal, matchesFingerprints, readFingerprints, scanErasureStorage, erasureScanBoundary, ErasureStorageRefusal, type ErasureFingerprint } from "./erasure-scan.ts";
import { durability } from "./durability.ts";
import { VerificationRefusal, assertVerificationBound, verificationLimits } from "./object-error.ts";
import { decodeConflict, conflictReferences } from "./conflicts.ts";
/** Authorized FileId-scoped erasure over accountable loose and packed storage. */
import { constants, type BigIntStats, existsSync, fstatSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { objectFiles, type ObjectFile } from "./object-files.ts";
import { dirname, join } from "node:path";
import { authorize, readLayers, assertCompositionPath, syncDirectory, writePrivateJson } from "./composition.ts";
import { payloadDigest, encodeTombstone, validateDenials, type ErasureDenial } from "./lifecycle.ts";
import { decodeManifest, decodeTree } from "./model.ts";
import { frameObject, hashObject, isObjectId, readControlJson, ObjectStoreError, type ObjectId, type ObjectStore, type ObjectType } from "./objects.ts";
import { inspectClosure } from "./closure.ts";
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
  /** The primary certificate concerns native object derivation, not arbitrary re-encodings of user data. */
  readonly guarantee: { readonly kind: "native-provenance"; readonly objects: readonly ObjectId[]; readonly excluded: readonly string[] };
  /** A bounded, nonblocking diagnostic is never evidence of absence. */
  readonly audit: { readonly suspected_residue: boolean; readonly limited: boolean; readonly scope: readonly string[]; readonly limits: { readonly bytes: number; readonly depth: number } };
}

/** Whole-store planning metadata excludes leaf buffers and retains only ownership and payload references. */
type InventoryObject =
  | { readonly type: "manifest" | "conflict"; readonly digest: string; readonly references: readonly ObjectId[] }
  | { readonly type: "tree"; readonly digest: string; readonly entries: ReturnType<typeof decodeTree> }
  | { readonly type: Exclude<ObjectType, "manifest" | "conflict" | "tree">; readonly digest: string };

/** Close one payload over all fragments and conflict alternatives, failing on incomplete inventory. */
function payloadClosure(ids: readonly ObjectId[], inventory: ReadonlyMap<ObjectId, InventoryObject>, store: ObjectStore, check: () => void): Set<ObjectId> {
  const selected = new Set<ObjectId>();
  const pending = [...ids];
  while (pending.length > 0) {
    check(); const current = pending.pop() as ObjectId;
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
function assertSupportedControl(control: string, observe: ((bytes: Buffer, binary: boolean) => void) | undefined, check: () => void): void {
  const supported = new Set(["objects", "refs", "leases", "destruction", "payload-owners", "derivations", "lease-proofs.json", "format", "index", "config.json", "HEAD", "oplog.jsonl", "exports.json", "outputs.json", "remotes.json",
    "partial.json", "upload-roots.json", "identity", "credentials.json", "authority.json", "denials.json", "objects.lock", "objects.recovery.lock", "objects.generation", "erasure-verification.json", "erasure-purge.json", "layers.json", "view.json", "dirty.json", "instances.json", "link.json", "unlinked-instances.json", "MERGE_STATE"]);
  for (const entry of readdirSync(control, { withFileTypes: true })) {
    check();
    if (supported.has(entry.name) && (["objects", "refs", "leases", "destruction", "payload-owners", "derivations"].includes(entry.name) ? !entry.isDirectory() : !entry.isFile())) {
      throw new ObjectStoreError("unsupported_erasure_storage", "Control storage must retain its supported native kind.");
    }
    const nativeOwner = entry.isFile() && ["oplog.jsonl.lock", "instances.json.lock"].some(name => durability.processMarker(join(control, entry.name), join(control, name)));
    if ((!supported.has(entry.name) && !nativeOwner && !(entry.isFile() && /^(?:objects\.(?:(?:recovery\.)?lock\.[0-9]+|generation)|(?:(?:erasure-verification|erasure-purge|denials|exports|outputs)\.json|oplog\.jsonl))\.[0-9a-f]{12}\.tmp$/.test(entry.name))) || entry.isSymbolicLink()) {
      throw new ObjectStoreError("unsupported_erasure_storage", "Unknown control storage or symlinks prevent a complete erasure receipt.");
    }
    if (entry.isFile() && /\.json$/.test(entry.name) && !["erasure-purge.json", "erasure-verification.json", "denials.json", "layers.json", "exports.json", "outputs.json"].includes(entry.name)) {
      const value = readControlJson(join(control, entry.name), "unsupported_erasure_storage", "native control JSON");
      if (value === null ? entry.name !== "view.json" : typeof value !== "object") throw new ObjectStoreError("unsupported_erasure_storage", "Unknown native control JSON shape was preserved.");
    }
    if (entry.isFile() && /^objects\.(?:recovery\.)?lock(?:\.[0-9]+\.[0-9a-f]{12}\.tmp)?$/.test(entry.name)) {
      const text = readFileSync(join(control, entry.name), "utf8");
      if (text !== "" && (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > 2_147_483_647)) throw new ObjectStoreError("unsupported_erasure_storage", "Unknown writer lease bytes were preserved.");
    }
    if (entry.isFile() && ["identity", "objects.generation"].includes(entry.name)) {
      const value = readControlJson(join(control, entry.name), "unsupported_erasure_storage", "native identity");
      if (!(entry.name === "objects.generation" && value === null) && (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value))) throw new ObjectStoreError("unsupported_erasure_storage", "Unknown native identity bytes were preserved.");
    }
    if (entry.isFile() && ["HEAD", "format"].includes(entry.name)) {
      const text = readFileSync(join(control, entry.name), "utf8").trim();
      try {
        if (entry.name === "format") { if (text !== "pmvcs-1") throw new Error("Unknown format."); }
        else if (text.startsWith("ref: ")) assertRefName(text.slice(5).trim());
        else if (!isObjectId(text)) throw new Error("Unknown HEAD.");
      } catch { throw new ObjectStoreError("unsupported_erasure_storage", "Unknown native control text was preserved."); }
    }
    if (entry.isFile() && /^(?:objects\.generation|(?:erasure-verification|erasure-purge|denials|exports|outputs)\.json)\.[0-9a-f]{12}\.tmp$/.test(entry.name)) {
      const bytes = readFileSync(join(control, entry.name));
      if (bytes.length > 0) {
        try {
          const value: unknown = JSON.parse(bytes.toString("utf8"));
          if (entry.name.startsWith("erasure-verification.")) readFingerprints(value);
          else if (entry.name.startsWith("denials.")) validateDenials(value);
          else if (entry.name.startsWith("exports.")) managedExports(control, entry.name);
          else if (entry.name.startsWith("outputs.")) nativeOutputs(control, entry.name);
          else if (entry.name.startsWith("erasure-purge.")) parseErasurePurgeJournal(control, [], value);
          else if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) throw new Error("Invalid generation.");
        } catch { throw new ObjectStoreError("unsupported_erasure_storage", "Unknown native control-stage bytes were preserved."); }
      }
    }
    if (entry.isFile() && /^oplog\.jsonl(?:\.[0-9a-f]{12}\.tmp)?$/.test(entry.name)) {
      const operations = erasureOperations(join(control, entry.name));
      if (entry.name !== "oplog.jsonl" && operations.some(operation => operation.summary !== "Summary removed by authorized erasure." && !(operation.command === "obliterate" && /^Obliterated FileId [0-9a-f]{32}; tombstone [0-9a-f]{64}\.$/.test(operation.summary)))) throw new ObjectStoreError("unsupported_erasure_storage", "Unknown operation-log stage bytes were preserved.");
    }

  }
  assertDestructionStorage(control, observe);
  managedExports(control);
  payloadOwners(control);
  /** Every reference leaf is native metadata, never an opaque backup namespace. */
  const inspectRefs = (directory: string, prefix: string): void => {
    const original = lstatSync(directory, { bigint: true });
    if (!original.isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Reference directories cannot follow links.");
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name); const name = `${prefix}/${entry.name}`;
      let file: ObjectFile | undefined;
      try {
        if (!entry.isDirectory() && !entry.isFile()) throw new Error("nonregular reference");
        if (!/^ref-[1-9][0-9]*-[0-9a-f]{12}\.lock$/.test(entry.name) || entry.isDirectory()) assertRefName(name);
        if (entry.isDirectory()) inspectRefs(path, name);
        else {
          file = objectFiles.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const before = fstatSync(file.fd, { bigint: true });
          if (!before.isFile() || before.size > BigInt(verificationLimits.receiptBytes)) throw new Error("unsupported reference size or kind");
          const bytes = readFileSync(file.fd);
          if (!isObjectId(bytes.toString("utf8").trim())) throw new Error("invalid reference bytes");
          // A verified ObjectId is literal metadata, not a compressed stream.
          const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
          if (current === undefined || controlStamp(current) !== controlStamp(before) || controlStamp(fstatSync(file.fd, { bigint: true })) !== controlStamp(before)) throw new Error("changed reference");
        }
      } catch { throw new ObjectStoreError("unsupported_erasure_storage", "Unknown reference storage prevents a complete erasure receipt."); }
      finally { file?.close(); }
    }
    const after = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    if (after === undefined || !after.isDirectory() || JSON.stringify(entries.map(entry => entry.name).sort()) !== JSON.stringify(readdirSync(directory).sort()) || controlStamp(after) !== controlStamp(original)) throw new ObjectStoreError("unsupported_erasure_storage", "The reference namespace changed during inspection.");
  };
  if (existsSync(join(control, "refs"))) inspectRefs(join(control, "refs"), "refs");
  const leases = join(control, "leases");
  if (existsSync(leases)) {
    if (!lstatSync(leases).isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Lease audits must occupy a real directory.");
    for (const entry of readdirSync(leases, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f]{32}\.jsonl$/.test(entry.name)) {
        throw new ObjectStoreError("unsupported_erasure_storage", "Unknown lease audit storage prevents a complete erasure receipt.");
      }
      const path = join(leases, entry.name); let file: ObjectFile | undefined;
      try {
        file = objectFiles.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(file.fd, { bigint: true }); const bytes = readFileSync(file.fd);
        if (!before.isFile() || before.size !== BigInt(bytes.length)) throw new Error("Changed lease audit.");
        if (bytes.length > 0) parseFileLeaseAudit(bytes.toString("utf8"), entry.name.slice(0, 32));
        const named = lstatSync(path, { bigint: true });
        if (controlStamp(before) !== controlStamp(named) || controlStamp(before) !== controlStamp(fstatSync(file.fd, { bigint: true }))) throw new Error("Changed lease audit.");
      } catch { throw new ObjectStoreError("unsupported_erasure_storage", "Unknown lease audit bytes were preserved."); }
      finally { file?.close(); }
    }
  }
  nativeOutputs(control);
  derivations(control, check);
  if (existsSync(join(control, "MERGE_STATE"))) {
    throw new ObjectStoreError("erasure_merge_in_progress", "Finish or abort the merge before permanent erasure.");
  }
}

/** Fence content and namespace replacement across one pinned native control read. */
function controlStamp(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }

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
    const check = (): void => { store.assertWriteLease(); assertVerificationBound("erasure", "time_ms", performance.now() - started, verificationLimits.erasureMs); };
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
    for (const instance of instances) assertSupportedControl(instance.controlDirectory, undefined, check);
    assertSupportedControl(control, undefined, check);
    const objectRoots = [...new Set([store.storageRoot(), ...instances.map((instance) => join(instance.controlDirectory, "objects"))])];
    const purgeFiles = planErasureStorage(objectRoots);
    const excluded = new Set(purgeFiles.map(file => file.path));
    const physical = new Map<string, ObjectId>();
    const inventory = new Map<ObjectId, InventoryObject>();
    const locations: { id: ObjectId; path: string }[] = [];
    for (const { id, path, object } of store.walkErasureInventory("all", excluded)) {
      check();
      locations.push({ id, path });
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
    const ownership = payloadOwners(control);
    entries.push(...ownership.filter(owner => owner.fileId !== fileId && inventory.has(owner.id)));
    const roots = new Set(existing?.tombstone.roots ?? []);
    for (const entry of entries) if (entry.fileId === fileId) roots.add(entry.id);
    if (roots.size === 0) for (const owner of ownership) if (owner.fileId === fileId && inventory.has(owner.id)) roots.add(owner.id);
    if (roots.size === 0) throw new ObjectStoreError("unknown_file", "No payload is attributable to this FileId.");
    const selected = new Set([...(existing?.tombstone.objects ?? []), ...ownership.filter(owner => owner.fileId === fileId).map(owner => owner.id)]);
    for (const id of payloadClosure([...new Set([...roots, ...ownership.filter(owner => owner.fileId === fileId && inventory.has(owner.id)).map(owner => owner.id)])], inventory, store, check)) selected.add(id);
    const physicalLocation = new Map(locations.map(location => [location.id, location.path]));
    /** Read verified native payloads even while resuming an authorized pending denial. */
    const readNative = (id: ObjectId) => {
      const path = physicalLocation.get(id);
      if (path === undefined) throw new ObjectStoreError("incomplete_erasure_inventory", "A native composition references an absent payload.");
      return store.readErasureObject(id, path);
    };
    const outputs = instances.flatMap(instance => nativeOutputs(instance.controlDirectory));
    const virtual = new Set(outputs.map(output => output.id));
    const catalog = upgradeDerivations(control, derivations(control, check), id => physicalLocation.has(id) ? readNative(id) : undefined, check, !validateOnly, virtual);
    const logical = existing === undefined ? manifestIdentities([...inventory].filter(([_id, object]) => object.type === "manifest").map(([id]) => id), readNative, check) : new Map<ObjectId, { id: ObjectId; digest: string }>();
    const unknown = unknownDerivations(catalog, [...virtual, ...[...inventory].filter(([_id, object]) => ["blob", "record", "manifest", "link", "conflict"].includes(object.type)).map(([id]) => id)], check);
    if (unknown.length > 0) throw new UncataloguedProvenance(unknown);
    const artifacts = instances.flatMap(instance => [...managedExports(instance.controlDirectory), ...nativeOutputs(instance.controlDirectory).map(output => ({ ...output, sha256: "" }))]);
    const selectedDigests = new Set(existing?.tombstone.payloads ?? []);
    const primary = new Set(selected);
    const reverse = new Map<ObjectId, Set<ObjectId>>(); const aliases = new Map<string, Set<ObjectId>>();
    /** Index each native source edge once, including catalogued transformations and structural wrappers. */
    const edge = (source: ObjectId, result: ObjectId): void => { check(); const values = reverse.get(source) ?? new Set<ObjectId>(); values.add(result); reverse.set(source, values); };
    /** Type-independent equivalence preserves the existing shared-byte ownership refusal. */
    const alias = (digest: string, id: ObjectId): void => { const values = aliases.get(digest) ?? new Set<ObjectId>(); values.add(id); aliases.set(digest, values); };
    for (const [id, record] of catalog) { for (const source of record.sources) edge(source, id); for (const member of record.members!) edge(member, id); }
    for (const [id, object] of inventory) {
      check(); if (["blob", "record", "manifest", "link", "conflict"].includes(object.type)) alias(object.digest, id);
      if (object.type === "manifest" || object.type === "conflict") for (const source of object.references) edge(source, id);
      const identity = logical.get(id); if (identity !== undefined) { edge(identity.id, id); alias(identity.digest, id); }
    }
    for (const artifact of artifacts) for (const source of artifact.objects) edge(source, artifact.id);
    const queue = [...selected];
    /** New derived roots are terminal absences under their precise historical FileId roles. */
    const add = (id: ObjectId): void => { if (!selected.has(id)) { selected.add(id); queue.push(id); } };
    for (const digest of selectedDigests) for (const id of aliases.get(digest) ?? []) add(id);
    for (let offset = 0; offset < queue.length; offset++) {
      check(); const id = queue[offset];
      for (const member of catalog.get(id)?.members ?? []) add(member);
      const object = inventory.get(id); const identity = logical.get(id);
      if (object?.type === "manifest") for (const child of object.references) add(child);
      const digests = [...(object === undefined ? [] : [object.digest]), ...(identity === undefined ? [] : [identity.digest])];
      if (identity !== undefined) add(identity.id);
      if (object?.type === "record") for (const bytes of recordRepresentations(readNative(id).payload)) { add(hashObject("blob", bytes)); digests.push(payloadDigest(bytes)); }
      for (const digest of digests) { selectedDigests.add(digest); for (const equivalent of aliases.get(digest) ?? []) add(equivalent); aliases.delete(digest); }
      for (const child of reverse.get(id) ?? []) add(child);
    }
    const derived: { id: ObjectId; fileId: string }[] = [];
    for (const entry of entries) {
      if (entry.fileId === fileId) continue;
      // A native transformation can invalidate its new output under another FileId. Independently
      // supplied shared objects still refuse; erasure never grants itself ownership by byte matching.
      if (selected.has(entry.id)) {
        check(); const record = catalog.get(entry.id);
        const priorRole = existing?.tombstone.derived?.some(role => role.id === entry.id && role.fileId === entry.fileId) === true;
        if (!priorRole && (primary.has(entry.id) || entry.fileId === undefined || record === undefined || !record.derived.includes(entry.fileId) || record.independent.includes(entry.fileId))) {
          throw new ObjectStoreError("erasure_dedup_conflict", "Another FileId or legacy file owns bytes selected for erasure.");
        }
        derived.push({ id: entry.id, fileId: entry.fileId! });
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
    for (const { id, path } of locations) {
      if (!selected.has(id) || loaded.has(id)) continue;
      const object = store.readErasureObject(id, path);
      loaded.add(id);
      payloads.push(fingerprint(frameObject(object.type, object.payload)));
      if (object.payload.length > 0) payloads.push(fingerprint(object.payload));
    }
    const deleting = new Set(locations.filter(({ id }) => selected.has(id)).map(({ path }) => path));
    for (const file of purgeFiles) deleting.add(file.path);
    const audit = { suspected_residue: false, limited: existing !== undefined && (proofs[existing.id]?.length ?? 0) === 0,
      scope: ["raw native members", "decoded native JSON strings", "raw physical storage"],
      limits: { bytes: 16 * 1024 * 1024, depth: 8 } };
    let auditRemaining = audit.limits.bytes;
    /** Inspect only declared JSON strings; all budgets truncate diagnostics rather than deny benign data. */
    const observe = (bytes: Buffer, json = false): void => {
      if (bytes.length > auditRemaining) { audit.limited = true; return; }
      auditRemaining -= bytes.length;
      audit.suspected_residue ||= matchesFingerprints(bytes, payloads);
      if (!json) return;
      /** Visit native JSON values and keys without recursively guessing their encodings. */
      const visit = (value: unknown, depth: number): void => {
        if (depth > audit.limits.depth) { audit.limited = true; return; }
        if (typeof value === "string") observe(Buffer.from(value));
        else if (Array.isArray(value)) for (const child of value) visit(child, depth + 1);
        else if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) { observe(Buffer.from(key)); visit(child, depth + 1); }
      };
      try { visit(JSON.parse(bytes.toString("utf8")), 0); } catch { /* A non-JSON native text record has only its raw representation. */ }
    };
    /** Diagnostic residue cannot replace native identity, ownership and namespace accountability. */
    const diagnose = (excluded: ReadonlySet<string>, decoded = true): void => {
      if (decoded) for (const { id, object } of store.walkErasureInventory("all", new Set(purgeFiles.filter(file => excluded.has(file.path)).map(file => file.path)))) {
        if (!selected.has(id)) observe(object.payload, object.type === "record" || object.type === "tombstone");
      }
      for (const root of objectRoots.filter(path => existsSync(path))) {
        try {
          if (auditRemaining <= 0) { audit.limited = true; continue; }
          scanErasureStorage(root, payloads, excluded, false, bytes => { auditRemaining -= bytes; if (auditRemaining < 0) { audit.limited = true; throw audit; } });
        }
        catch (error) {
          if (error === audit) audit.limited = true;
          else if (error instanceof ObjectStoreError && error.code === "erasure_retained_copy") audit.suspected_residue = true;
          else throw error;
        }
      }
    };
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
    diagnose(deleting);
    /** Native control records must not become a hidden selected-byte copy during cleanup either. */
    const diagnoseControl = (): void => {
      for (const instanceControl of new Set([control, ...instances.map(instance => instance.controlDirectory)])) {
        assertSupportedControl(instanceControl, (bytes, binary) => observe(bytes, !binary), check);
      }
    };
    diagnoseControl();
    for (const instance of instances) {
      for (const entry of readdirSync(instance.controlDirectory, { withFileTypes: true })) {
        if (entry.isFile()) observe(readFileSync(join(instance.controlDirectory, entry.name)), entry.name.endsWith(".json"));
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
            if (owned.has(file.path) || file.source !== undefined && selected.has(file.source) || selectedDigests.has(payloadDigest(Buffer.from(file.content, "base64")))) {
              throw new ObjectStoreError("erasure_layer_conflict", "Remove affected private layers before authorized erasure.");
            }
          }
        }
        const layerPath = join(instance.controlDirectory, "layers.json");
        if (existsSync(layerPath)) observe(readFileSync(layerPath), true);
        for (const output of nativeOutputs(instance.controlDirectory)) {
          if (owned.has(output.path) || !output.objects.some(id => selected.has(id)) && !selected.has(output.id)) continue;
          const leaf = mutation.inspectForErasure(output.path);
          if (leaf === undefined) continue;
          if (outputBirth(leaf.stat) !== output.birth || output.complete && hashObject("blob", leaf.content) !== output.id) throw new ObjectStoreError("worktree_path_changed", "A native output was replaced; foreign bytes were preserved.");
          owned.add(output.path);
        }
        for (const entry of index) {
          if (entry.fileId === fileId || !selected.has(entry.id) || owned.has(entry.path)) continue;
          // A derived identity does not authorize deleting an independently replaced or unregistered leaf.
          if (mutation.inspectForErasure(entry.path) !== undefined) throw new ObjectStoreError("worktree_path_changed", "A derived materialization lacks current native ownership evidence; foreign bytes were preserved.");
          owned.add(entry.path);
        }
        for (const artifact of managedExports(instance.controlDirectory)) {
          if (!artifact.objects.some(id => selected.has(id))) continue;
          const leaf = mutation.inspectForErasure(artifact.path);
          if (leaf === undefined) continue;
          if (!nativeOutputs(instance.controlDirectory).some(output => output.path === artifact.path && !output.complete && outputBirth(leaf.stat) === output.birth) && createHash("sha256").update(leaf.content).digest("hex") !== artifact.sha256) throw new ObjectStoreError("worktree_path_changed", "A managed export was replaced; foreign bytes were preserved.");
          owned.add(artifact.path);
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
          else { observe(Buffer.from(path)); observe(leaf.content); }
        }
      }
      const tombstone = existing?.tombstone ?? { version: 1 as const, fileId, roots: [...roots], objects: [...selected], ...(derived.length === 0 ? {} : { derived }), payloads: [...selectedDigests], principal, timestamp: now.toISOString(), reason };
      const payload = encodeTombstone(tombstone);
      const id = hashObject("tombstone", payload);
      const denial: ErasureDenial = { id, tombstone, pending: true };
      const next = [...local.filter(/** Replace only this identity's cleanup state. */ (entry) => entry.tombstone.fileId !== fileId), denial];
      const completed = next.map(/** Completion follows durable deletion and never precedes it. */ (entry) => entry.id === id ? { ...entry, pending: false } : entry);
      const summary = `Obliterated FileId ${fileId}; tombstone ${id}.`;
      const operation = { sequence: repository.operations.read().length + 1, command: "obliterate", at: now.toISOString(), summary, refs: [] };
      for (const bytes of [payload, Buffer.from(JSON.stringify(next)), Buffer.from(JSON.stringify(completed)), Buffer.from(JSON.stringify(operation))]) observe(bytes, true);
      // Payload authorization, identity, ownership, worktree and audit checks are read-only.
      // Certificate migrations above only retain native evidence; they never remove payload bytes.
      // Only this frozen set can be purged, even if a new foreign file arrives during execution.
      const signatures = [...new Map(payloads.map(item => [`${item.length}:${item.rolling}:${item.digest}`, item])).values()];
      const updatedProofs = { ...proofs, [id]: signatures };
      observe(Buffer.from(JSON.stringify(fingerprintJournal(updatedProofs))), true);
      const probe = erasurePurge(control, fileId, objectRoots, options.purgeUnaccounted === true, true);
      if (purgeFiles.length > 0 && !probe.canPurge) throw new ErasureStorageRefusal("unverifiable", purgeFiles[0].fileClass);
      if (validateOnly) {
        throw new ErasureValidated();
      }
      check();
      // Prepare immutable audit objects before opening the destructive purge phase.
      // Recovery must not discover an unplanned object temporary created after its purge set was frozen.
      store.prepareDenialObjects(next);
      const purge = erasurePurge(control, fileId, objectRoots, options.purgeUnaccounted === true);
      if (purgeFiles.length > 0 && !purge.canPurge) throw new ErasureStorageRefusal("unverifiable", purgeFiles[0].fileClass);
      const planned = new Map(purgeFiles.map(file => [file.path, file]));
      const accountStorage = (strict = false): ErasureAccountabilityReport => accountErasureStorage(objectRoots, {
        forbiddenIds: strict ? new Set([...selected, ...store.denials().flatMap(entry => entry.tombstone.objects)]) : new Set(),
        forbiddenPayloads: strict ? new Set([...store.denials().flatMap(entry => entry.tombstone.payloads), ...[...selected].flatMap(id => inventory.has(id) ? [inventory.get(id)!.digest] : [])]) : new Set(),
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
      store.recordDenials(next);
      erasureScanBoundary.visit("pending");
      for (const instance of instances) instance.operations.redactForErasure(selected);
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
      for (const instance of instances) {
        const outputs = nativeOutputs(instance.controlDirectory);
        const remaining = outputs.filter(output => !selected.has(output.id) && !output.objects.some(id => selected.has(id)));
        if (remaining.length !== outputs.length) writePrivateJson(join(instance.controlDirectory, "outputs.json"), remaining);
        const exports = managedExports(instance.controlDirectory);
        const retained = exports.filter(artifact => !artifact.objects.some(id => selected.has(id)));
        if (retained.length !== exports.length) writePrivateJson(join(instance.controlDirectory, "exports.json"), retained);
      }
      clearDerivations(control, selected, catalog, check);
      for (const directory of directories) syncDirectory(directory);
      accountStorage(true);
      erasureScanBoundary.visit("storage-verified");
      erasureScanBoundary.visit("completed");
      erasureScanBoundary.visit("receipt");
      for (const instance of instances) assertSupportedControl(instance.controlDirectory, undefined, check);
      assertSupportedControl(control, undefined, check);
      diagnoseControl();
      check(); diagnose(new Set(), false);
      const certified = { purgeReceipt: purge.receipt(), storage: accountStorage(true) };
      check();
      const { purgeReceipt } = certified;
      const storage = certified.storage;
      // No observer callback follows the final namespace barrier before completion publication.
      store.recordDenials(completed);
      const alreadyRecorded = new Error("The original erasure operation is already recorded.");
      try {
        repository.operations.append("obliterate", summary, [], now, undefined, /** Reconcile owners and deduplicate under the operation log's own lease. */ (_receipt) => {
          if (repository.operations.read().some(entry => entry.command === "obliterate" && entry.summary === summary)) throw alreadyRecorded;
          observe(Buffer.from(JSON.stringify(_receipt)), true);
        });
      } catch (error) { if (error !== alreadyRecorded) throw error; }
      return { destruction: { objects: objectReceipt, worktrees: worktreeReceipts.slice(0, 20), omittedWorktrees: Math.max(0, worktreeReceipts.length - 20) }, guarantee: { kind: "native-provenance", objects: [...selected].sort(), excluded: ["independent user files", "user-authored alternate encodings", "independent names and metadata", "caller-owned exports and external copies"] }, audit, fileId, tombstone: id, removed: [...selected].sort(), storage, purge: purgeReceipt };
    } finally {
      for (const mutation of mutations.values()) mutation.close();
    }
  };
  return validateOnly ? execute() : store.withWriteLock(execute);
}
