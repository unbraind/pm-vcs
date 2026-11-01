import { assertVerificationBound } from "./object-error.ts";
import { decodeManifest } from "./model.ts";
import { decodeConflict, conflictReferences } from "./conflicts.ts";
import { durability } from "./durability.ts";
/** Clone-private native derivation certificates, committed before recoverable payload bytes. */
import { type BigIntStats, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writePrivateJson } from "./composition.ts";
import { isObjectId, ObjectStoreError, readControlJson, type ObjectId, type StoredObject } from "./objects.ts";

/** Each role records whether this identity was independently supplied or produced from native inputs. */
export interface DerivationRecord {
  readonly format: "pm-vcs-derivation-1" | "pm-vcs-derivation-2";
  /** Version two sources contain every transitive native input; unknowns cannot be silently forgotten. */
  readonly unknown?: readonly ObjectId[];
  readonly sources: readonly ObjectId[];
  readonly independent: readonly string[];
  readonly derived: readonly string[];
}

/** Catalog authority is bound to the exact directory inspected before deletion. */
const catalogRoots = new WeakMap<ReadonlyMap<ObjectId, DerivationRecord>, BigIntStats | undefined>();

/** Compare native directory lifetimes without treating a recycled inode as the same owner. */
function directoryBirth(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }

/** Unknown legacy identities are a primary refusal, with bounded display and complete machine-readable IDs. */
export class UncataloguedProvenance extends ObjectStoreError {
  /** Complete uncatalogued identities for an operator to recover without relying on truncated display text. */
  readonly objects: readonly ObjectId[];
  /** Preserve legacy bytes until their complete native origin can be established. */
  constructor(objects: readonly ObjectId[]) {
    super("uncatalogued_provenance", `Native provenance is unknown for ${objects.length} object(s): ${objects.slice(0, 20).join(", ")}. Restore complete derivation evidence before erasure.`);
    this.objects = objects;
  }
}

/** Read the exact native schema through the ordinary no-symlink control reader. */
function readRecord(path: string): DerivationRecord {
  const value = readControlJson(path, "unsupported_erasure_storage", "native derivation") as DerivationRecord;
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join(",") !== (value.format === "pm-vcs-derivation-2" ? "derived,format,independent,sources,unknown" : "derived,format,independent,sources")
    || !["pm-vcs-derivation-1", "pm-vcs-derivation-2"].includes(value.format) || value.format === "pm-vcs-derivation-2" && (!Array.isArray(value.unknown) || !value.unknown.every(id => typeof id === "string" && isObjectId(id))) || !Array.isArray(value.sources) || !value.sources.every(id => typeof id === "string" && isObjectId(id))
    || ![value.independent, value.derived].every(roles => Array.isArray(roles) && roles.every(id => typeof id === "string" && /^[0-9a-f]{32}$/.test(id)))) {
    throw new ObjectStoreError("unsupported_erasure_storage", "Unknown native derivation record was preserved.");
  }
  return value;
}

/** Classify every record and atomic publication stage before granting erasure authority. */
export function derivations(control: string, check: () => void): Map<ObjectId, DerivationRecord> {
  const directory = join(control, "derivations");
  const original = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
  if (original === undefined) { const absent = new Map<ObjectId, DerivationRecord>(); catalogRoots.set(absent, undefined); return absent; }
  if (!original.isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Derivations must occupy a real directory.");
  const records = new Map<ObjectId, DerivationRecord>(); catalogRoots.set(records, original);
  const entries = readdirSync(directory, { withFileTypes: true });
  const names = new Set(entries.map(entry => entry.name));
  for (const entry of entries) {
    check();
    const match = /^([0-9a-f]{64})\.json(?:\.[0-9a-f]{12}\.tmp)?$/.exec(entry.name);
    if (match === null || !entry.isFile()) throw new ObjectStoreError("unsupported_erasure_storage", "Unknown derivation storage was preserved.");
    const path = join(directory, entry.name);
    if (entry.name.endsWith(".tmp") && lstatSync(path).size === 0) continue;
    const record = readRecord(path);
    if (entry.name === `${match[1]}.json`) records.set(match[1], record);
  }
  const current = lstatSync(directory, { bigint: true });
  const finalNames = readdirSync(directory);
  if (finalNames.length !== entries.length || finalNames.some(name => !names.has(name)) || `${directoryBirth(current)}:${current.mtimeNs}:${current.ctimeNs}` !== `${directoryBirth(original)}:${original.mtimeNs}:${original.ctimeNs}`) throw new ObjectStoreError("unsupported_erasure_storage", "Native derivation namespace changed during inspection.");
  return records;
}

/** Primary certificate work bounds are independent of content-audit limits. @internal */
export const provenanceLimits = { objects: 1_000_000, edges: 1_000_000, depth: 256, timeMs: 300_000 };

/** Only native container formats supply implicit inputs; malformed opaque writes remain unknown. */
export function nativeDerivationInputs(object: StoredObject): readonly ObjectId[] | undefined {
  try {
    if (object.type === "manifest") { const value = decodeManifest(object.payload); return (value.pages ?? value.fragments).map(child => child.id); }
    if (object.type === "conflict") return conflictReferences(decodeConflict(object.payload));
    return [];
  } catch { return undefined; }
}

/** Resolve old direct-parent certificates once, retaining all intermediate identities and unknown evidence. */
function certificateResolver(lookup: (id: ObjectId) => DerivationRecord | undefined, read: (id: ObjectId) => StoredObject | undefined, fence: () => void, virtual: ReadonlySet<ObjectId> = new Set()) {
  const memo = new Map<ObjectId, DerivationRecord>(); const active = new Set<ObjectId>(); const started = performance.now(); let edges = 0;
  /** Every node and edge observes the lease and deadline before doing further work. */
  const check = (): void => { fence(); assertVerificationBound("provenance", "time_ms", performance.now() - started, provenanceLimits.timeMs); };
  /** Version two is self-contained, so an absent physical ancestor never needs reconstruction. */
  const visit = (id: ObjectId): DerivationRecord | undefined => {
    check(); const cached = memo.get(id); if (cached !== undefined) return cached;
    assertVerificationBound("provenance", "objects", memo.size + active.size, provenanceLimits.objects);
    let record = lookup(id);
    if (record === undefined) {
      // Native structural frames contain identities and caller metadata, not payload copies.
      const object = read(id); check();
      if (object === undefined || ["blob", "record", "manifest", "link", "conflict"].includes(object.type)) return undefined;
      record = { format: "pm-vcs-derivation-2", sources: [], unknown: [], independent: [], derived: [] };
    }
    if (record.format === "pm-vcs-derivation-2") { memo.set(id, record); return record; }
    const sources = new Set(record.sources); const unknown = new Set<ObjectId>();
    if (active.has(id)) return { ...record, format: "pm-vcs-derivation-2", unknown: [id] };
    assertVerificationBound("provenance", "depth", active.size, provenanceLimits.depth); active.add(id);
    const object = read(id); check(); const native = virtual.has(id) ? [] : object === undefined ? undefined : nativeDerivationInputs(object);
    if (native === undefined) unknown.add(id); else for (const source of native) sources.add(source);
    for (const source of [...sources]) {
      check(); assertVerificationBound("provenance", "edges", ++edges, provenanceLimits.edges);
      if (source === id) { unknown.add(id); continue; }
      const parent = visit(source);
      if (parent === undefined) unknown.add(source);
      else { for (const root of parent.sources) { check(); sources.add(root); assertVerificationBound("provenance", "edges", ++edges, provenanceLimits.edges); } for (const root of parent.unknown!) { check(); unknown.add(root); assertVerificationBound("provenance", "edges", ++edges, provenanceLimits.edges); } }
    }
    sources.delete(id); active.delete(id);
    const next: DerivationRecord = { ...record, format: "pm-vcs-derivation-2", sources: [...sources].sort(), unknown: [...unknown].sort() }; memo.set(id, next); return next;
  };
  return { visit, check, memo };
}

/** Bind metadata migration and retirement to the same classified directory lifetime. */
function catalogParent(control: string, catalog: ReadonlyMap<ObjectId, DerivationRecord>, check: () => void): BigIntStats | undefined {
  check(); const original = catalogRoots.get(catalog); const stat = lstatSync(join(control, "derivations"), { bigint: true, throwIfNoEntry: false });
  if (!catalogRoots.has(catalog) || (original === undefined ? stat !== undefined : stat === undefined || !stat.isDirectory() || directoryBirth(stat) !== directoryBirth(original))) throw new ObjectStoreError("unsupported_erasure_storage", "Native derivation directory changed before retirement.");
  return stat;
}

/** Upgrade retained metadata before GC removes native structures; previews may inspect without writing. */
export function upgradeDerivations(control: string, catalog: Map<ObjectId, DerivationRecord>, read: (id: ObjectId) => StoredObject | undefined, fence: () => void, apply = true, virtual: ReadonlySet<ObjectId> = new Set()): Map<ObjectId, DerivationRecord> {
  const resolver = certificateResolver(id => catalog.get(id), read, fence, virtual); const updates: [ObjectId, DerivationRecord][] = [];
  for (const [id, record] of catalog) { resolver.check(); if (record.format === "pm-vcs-derivation-1") updates.push([id, resolver.visit(id)!]); }
  for (const [id, record] of resolver.memo) if (!catalog.has(id)) updates.push([id, record]);
  for (const [id, record] of updates) { resolver.check(); if (apply) { catalogParent(control, catalog, resolver.check); writePrivateJson(join(control, "derivations", `${id}.json`), record); } catalog.set(id, record); }
  return catalog;
}

/** Unknown ancestry includes absent certificate inputs, even when the derived payload itself is catalogued. */
export function unknownDerivations(catalog: ReadonlyMap<ObjectId, DerivationRecord>, ids: readonly ObjectId[], check: () => void): ObjectId[] {
  return [...new Set(ids)].filter(id => {
    check(); const record = catalog.get(id);
    if (record === undefined || record.format !== "pm-vcs-derivation-2" || record.unknown!.length > 0) return true;
    return record.sources.some(source => { check(); const parent = catalog.get(source); return parent === undefined || parent.format !== "pm-vcs-derivation-2" || parent.unknown!.length > 0; });
  }).sort();
}

/** Publish a self-contained monotonic certificate before bytes; existing unknown objects cannot be relabelled. */
export function recordDerivation(control: string, id: ObjectId, sources: readonly ObjectId[], fileId: string | undefined, exists: boolean, independent = sources.length === 0, read: (id: ObjectId) => StoredObject | undefined = () => undefined, fence: () => void = () => {}, valid = true): void {
  if (!isObjectId(id) || !sources.every(source => typeof source === "string" && isObjectId(source))
    || fileId !== undefined && !/^[0-9a-f]{32}$/.test(fileId)) throw new ObjectStoreError("invalid_provenance", "Derivations require canonical object and file identities.");
  const directory = join(control, "derivations"); const path = join(directory, `${id}.json`);
  const present = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  if (!present && exists) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Derivations cannot follow directory links.");
  const resolver = certificateResolver(source => { const name = join(directory, `${source}.json`); return lstatSync(name, { throwIfNoEntry: false }) === undefined ? undefined : readRecord(name); }, read, fence);
  const previous = present ? resolver.visit(id)! : { format: "pm-vcs-derivation-2" as const, sources: [], unknown: [], independent: [], derived: [] };
  resolver.check();
  const roots = new Set(previous.sources); const unknown = new Set(previous.unknown);
  if (!valid) unknown.add(id);
  for (const source of sources) {
    resolver.check(); if (source === id) continue; roots.add(source); const parent = resolver.visit(source);
    if (parent === undefined) unknown.add(source);
    else { for (const root of parent.sources) { resolver.check(); roots.add(root); assertVerificationBound("provenance", "edges", roots.size, provenanceLimits.edges); } for (const root of parent.unknown!) { resolver.check(); unknown.add(root); assertVerificationBound("provenance", "edges", unknown.size, provenanceLimits.edges); } }
  }
  for (const [source, record] of resolver.memo) { resolver.check(); if (source !== id && lstatSync(join(directory, `${source}.json`), { throwIfNoEntry: false }) === undefined) writePrivateJson(join(directory, `${source}.json`), record); }
  roots.delete(id);
  const next: DerivationRecord = { format: "pm-vcs-derivation-2", sources: [...roots].sort(), unknown: [...unknown].sort(),
    independent: [...new Set([...previous.independent, ...(fileId !== undefined && independent ? [fileId] : [])])].sort(),
    derived: [...new Set([...previous.derived, ...(fileId !== undefined && !independent ? [fileId] : [])])].sort() };
  if (!present || JSON.stringify(next) !== JSON.stringify(previous)) writePrivateJson(path, next);
}

/** One queue follows reverse edges transitively; each distinct edge is inspected once. */
export function derivationClosure(records: ReadonlyMap<ObjectId, DerivationRecord>, roots: ReadonlySet<ObjectId>, check: () => void): Set<ObjectId> {
  const reverse = new Map<ObjectId, ObjectId[]>();
  for (const [id, record] of records) for (const source of record.sources) {
    check(); const children = reverse.get(source) ?? []; children.push(id); reverse.set(source, children);
  }
  const selected = new Set(roots); const queue = [...roots];
  for (let offset = 0; offset < queue.length; offset++) {
    check();
    for (const id of reverse.get(queue[offset]) ?? []) if (!selected.has(id)) { selected.add(id); queue.push(id); }
  }
  return selected;
}

/** Retire selected certificates only after every recoverable object copy was durably removed. */
export function clearDerivations(control: string, selected: ReadonlySet<ObjectId>, catalog: ReadonlyMap<ObjectId, DerivationRecord>, check: () => void): void {
  const directory = join(control, "derivations");
  /** Recheck the classified parent immediately around every retirement. */
  const parent = (): BigIntStats | undefined => catalogParent(control, catalog, check);
  if (parent() === undefined) return;
  for (const name of readdirSync(directory)) {
    parent(); const id = name.slice(0, 64); if (!selected.has(id)) continue;
    const path = join(directory, name); const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || !/^([0-9a-f]{64})\.json(?:\.[0-9a-f]{12}\.tmp)?$/.test(name)) throw new ObjectStoreError("unsupported_erasure_storage", "Unknown derivation retirement bytes were preserved.");
    if (!name.endsWith(".tmp") || stat.size !== 0n) readRecord(path);
    parent(); durability.unlink(path, stat);
  }
}
