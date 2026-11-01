import { durability } from "./durability.ts";
/** Clone-private native derivation certificates, committed before recoverable payload bytes. */
import { type BigIntStats, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writePrivateJson } from "./composition.ts";
import { isObjectId, ObjectStoreError, readControlJson, type ObjectId } from "./objects.ts";

/** Each role records whether this identity was independently supplied or produced from native inputs. */
export interface DerivationRecord {
  readonly format: "pm-vcs-derivation-1";
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
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join(",") !== "derived,format,independent,sources"
    || value.format !== "pm-vcs-derivation-1" || !Array.isArray(value.sources) || !value.sources.every(id => typeof id === "string" && isObjectId(id))
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

/** Atomically union sources and roles; an existing uncatalogued object can never be relabelled as a new origin. */
export function recordDerivation(control: string, id: ObjectId, sources: readonly ObjectId[], fileId: string | undefined, exists: boolean, independent = sources.length === 0): void {
  if (!isObjectId(id) || !sources.every(source => typeof source === "string" && isObjectId(source))
    || fileId !== undefined && !/^[0-9a-f]{32}$/.test(fileId)) throw new ObjectStoreError("invalid_provenance", "Derivations require canonical object and file identities.");
  const directory = join(control, "derivations"); const path = join(directory, `${id}.json`);
  const present = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  if (!present && exists) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Derivations cannot follow directory links.");
  const previous = present ? readRecord(path) : { format: "pm-vcs-derivation-1" as const, sources: [], independent: [], derived: [] };
  const next: DerivationRecord = { format: previous.format,
    sources: [...new Set([...previous.sources, ...sources.filter(source => source !== id)])].sort(),
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
  const directory = join(control, "derivations"); const original = catalogRoots.get(catalog);
  /** Directory replacement cannot turn a validated catalog into deletion authority over a foreign namespace. */
  const parent = (): BigIntStats | undefined => {
    check(); const stat = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    if (!catalogRoots.has(catalog) || (original === undefined ? stat !== undefined : stat === undefined || !stat.isDirectory() || directoryBirth(stat) !== directoryBirth(original))) throw new ObjectStoreError("unsupported_erasure_storage", "Native derivation directory changed before retirement.");
    return stat;
  };
  if (parent() === undefined) return;
  for (const name of readdirSync(directory)) {
    parent(); const id = name.slice(0, 64); if (!selected.has(id)) continue;
    const path = join(directory, name); const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || !/^([0-9a-f]{64})\.json(?:\.[0-9a-f]{12}\.tmp)?$/.test(name)) throw new ObjectStoreError("unsupported_erasure_storage", "Unknown derivation retirement bytes were preserved.");
    if (!name.endsWith(".tmp") || stat.size !== 0n) readRecord(path);
    parent(); durability.unlink(path, stat);
  }
}
