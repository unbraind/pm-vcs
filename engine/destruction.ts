/** Immutable deletion intents separate validation from retirement and retain exact crash/recovery receipts. */
import { createHash, randomBytes } from "node:crypto";
import { constants, fstatSync, lstatSync, mkdirSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { objectFiles, type ObjectFile } from "./object-files.ts";
import { ObjectStoreError, VerificationRefusal, assertVerificationBound, verificationLimits, type VerificationResult } from "./object-error.ts";

/** Primitive implementation is supplied by the one platform-aware durability helper. @internal */
export interface DestructionBackend {
  file(fd: number): void;
  directory(path: string): void;
  write(path: string, bytes: Buffer): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  rename(source: string, destination: string): void;
  link(source: string, destination: string): void;
  update(path: string, offset: number, bytes: Buffer, validate: (fd: number) => void): void;
}
/** One authorized namespace mutation; recursive removal is expanded before any deletion. */
export interface DestructionRequest { readonly path: string; readonly recursive?: boolean; readonly directory?: boolean; readonly destination?: string; readonly expected?: BigIntStats; readonly address?: string; readonly destinationAddress?: string }
/** Stable state distinguishes this operation's deletion from a peer's absence or replacement. */
export interface DestructionEntry {
  readonly path: string; readonly destination?: string; readonly kind: "file" | "link" | "directory" | "rename";
  readonly identity: string; readonly digest: string; readonly parent: string; readonly parentIdentity: string; readonly target?: string; readonly destinationParentIdentity?: string;
  status: "planned" | "deleted" | "moved" | "absent" | "foreign" | "cancelled"; reason?: string;
}
/** Bounded public receipt; the complete immutable set remains in the private intent journal. */
export interface DestructionReceipt {
  readonly id: string; readonly revision: string; readonly status: "pending" | "completed" | "superseded";
  readonly reason?: DestructionSupersession;
  readonly planned: number; readonly deleted: number; readonly moved: number; readonly observedAbsent: number; readonly skipped: number;
  readonly omitted: number; readonly entries: readonly DestructionEntry[];
}
/** Stable refusal codes cover validation, ownership, conflict and recoverable partial execution. */
export type DestructionRefusalCode = "EISDIR" | "invalid_receipt_limit" | "destructive_target_changed" | "destructive_target_unsupported" | "ENOTEMPTY" | "conflicting_destructive_requests" | "foreign_destructive_intent" | "destructive_intent_changed" | "destructive_intent_locked" | "destructive_plan_conflict" | "unplanned_deletion" | "destructive_operation_pending";
/** Recoverable partial failure always names its frozen receipt and an actionable remedy. */
export class DestructionRefusal extends ObjectStoreError {
  /** Narrow discriminator for exhaustive SDK handling. */
  override readonly code: DestructionRefusalCode;
  /** Exact original set and durable progress, when an intent was already published. */
  readonly receipt: DestructionReceipt | undefined;
  /** Safe recovery instruction; foreign entries never become deletion authority. */
  readonly remedy: string;
  /** Refuse before deleting an unvalidated/replaced target; preserve receipt metadata on partial failure. */
  constructor(code: DestructionRefusalCode, detail: string, receipt?: DestructionReceipt) { const remedy = "Retry the original operation to recover its recorded set; inspect replaced or foreign entries before a new request."; super(code, `${detail} ${remedy}`); this.name = "DestructionRefusal"; this.code = code; this.receipt = receipt; this.remedy = remedy; }
}
/** Boundary callbacks run before the next identity check, including after each durable progress update. @internal */
export const destructionBoundary: { visit(step: string, path: string): void } = { visit() {} };
/** Only a caller that has revalidated its complete current request may retire obsolete authority. */
export type DestructionSupersession = "reachability_changed" | "eligibility_changed";
interface Intent { format: "pm-vcs-destruction-1"; id: string; revision: string; root: string; rootIdentity: string; entries: DestructionEntry[]; status: "pending" | "completed" | "superseded"; reason?: DestructionSupersession }
interface Scope { control: string; repository: boolean; revision?: string }
let backend: DestructionBackend;
const scopes: Scope[] = [];
/** Install only the durability helper's platform-aware primitives. @internal */
export function configureDestruction(value: DestructionBackend): void { backend = value; }
/** Validate operator paths with the same scope/alias policy used by every native retirement. @internal */
export function resolveNamespacePath(path: string): string { return inScope(scope(resolve(path)), () => canonical(path)); }
/** Keep synchronous namespace mutations within their store's already-owned writer lease. @internal */
export function withDestructionScope<T>(control: string, action: () => T): T { return inScope({ control: resolve(control), repository: true }, action); }
/** Preserve the verified repository boundary without trusting arbitrary standalone parent links. */
function inScope<T>(scope: Scope, action: () => T): T { scopes.push(scope); try { return action(); } finally { scopes.pop(); } }
/** Only stable device/inode/birth identity grants authority across a directory lifetime. */
function birth(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }
/** A mutation stamp includes ctime so an in-place rewrite cannot retain deletion authority. */
function identity(stat: BigIntStats): string { return `${birth(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
/** Hash regular bytes or the literal link target, never following a leaf link. */
function digest(path: string, stat: BigIntStats, durable = false): string {
  const hash = createHash("sha256");
  if (stat.isSymbolicLink() || stat.isDirectory()) return hash.update(stat.isSymbolicLink() ? readlinkSync(path) : "directory").digest("hex");
  let file: ObjectFile;
  try { file = objectFiles.open(path, (durable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW); }
  catch (error) { if (!durable || !["EACCES", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; file = objectFiles.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  try {
    if (durable) backend.file(file.fd);
    if (identity(fstatSync(file.fd, { bigint: true })) !== identity(stat)) throw new DestructionRefusal("destructive_target_changed", "A leaf changed before hashing.");
    const buffer = Buffer.alloc(65_536); let offset = 0;
    for (;;) { const count = readSync(file.fd, buffer, 0, buffer.length, offset); if (count === 0) break; hash.update(buffer.subarray(0, count)); offset += count; }
    const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (current === undefined || identity(current) !== identity(stat) || identity(fstatSync(file.fd, { bigint: true })) !== identity(stat)) throw new DestructionRefusal("destructive_target_changed", "A pinned leaf changed while hashing.");
    return hash.digest("hex");
  } finally { file.close(); }
}
/** Resolve descriptor-relative mutation addresses while retaining their original ordinary parent identity. */
function canonical(path: string): string {
  if (typeof path !== "string" || path === "" || path.includes("\0")) throw new DestructionRefusal("destructive_target_unsupported", "A destructive path must be a nonempty ordinary namespace address.");
  const absolute = resolve(path); const parent = dirname(absolute);
  if (absolute === parent) throw new DestructionRefusal("destructive_target_unsupported", "A filesystem root is never a deletion target.");
  if (!/^\/proc\/self\/fd\/[0-9]+$/.test(parent)) {
    let current = parent; let alias = false;
    for (;;) { const stat = lstatSync(current, { throwIfNoEntry: false }); if (stat !== undefined && !stat.isDirectory()) {
      if (!stat.isSymbolicLink() || !scopes.some(scope => scope.repository && (scope.control === current || scope.control.startsWith(`${current}${sep}`))) || !lstatSync(realpathSync(current)).isDirectory()) throw new DestructionRefusal("destructive_target_changed", "A namespace parent is not an ordinary directory.");
      alias = true;
    } const next = dirname(current); if (next === current) break; current = next; }
    return alias ? join(realpathSync(parent), absolute.split(/[\\/]/).at(-1)!) : absolute;
  }
  return join(realpathSync(parent), absolute.split(/[\\/]/).at(-1)!);
}
/** A runtime descriptor alias may only address its recorded namespace member, including after caller object reuse. */
function addressFor(path: string, address?: string): string {
  if (address === undefined || address === path) return path;
  if (canonical(address) !== path) throw new DestructionRefusal("conflicting_destructive_requests", "A descriptor alias must name its recorded namespace member.");
  return address;
}
/** A format marker is required before an inferred scope may modify repository-private receipt state. */
function packageControl(path: string): boolean {
  const directory = lstatSync(path, { throwIfNoEntry: false }); if (!directory?.isDirectory()) return false;
  const marker = join(path, "format"); const stat = lstatSync(marker, { throwIfNoEntry: false }); if (!stat?.isFile() || stat.size !== 8) return false;
  try { return readFileSync(marker, "utf8") === "pmvcs-1\n"; } catch { return false; }
}
/** Prefer the caller's explicit scope, then a verified repository format; standalone primitives use private intent storage. */
function scope(path: string): Scope {
  if (scopes.length > 0) return scopes.at(-1)!;
  let current = dirname(path);
  for (;;) {
    if (packageControl(current)) return { control: current, repository: true };
    const nested = join(current, ".pmvcs"); if (packageControl(nested)) return { control: nested, repository: true };
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return { control: dirname(path), repository: false };
}
/** Namespace publication/cleanup receipts stay outside logical control data, keyed by their real owning root. */
function namespaceLedger(control: string): string {
  const absolute = resolve(control); const stat = lstatSync(absolute, { throwIfNoEntry: false });
  const root = stat?.isDirectory() ? realpathSync(absolute) : absolute;
  return join(tmpdir(), `pm-vcs-namespace-${createHash("sha256").update(root).digest("hex")}`);
}
/** Bind one operation key to its real root; copied journals cannot become authority in a new clone. */
function intentName(root: string, key: string): string { return createHash("sha256").update(`${root}\0${key}`).digest("hex"); }

/** Bind intents to reachability and authority; fresh recovery CAS also inventories payload namespace stamps without hashing payload bytes. */
function storeRevision(root: string, fresh = false): string {
  const active = fresh ? undefined : scopes.find(scope => scope.control === root); if (active?.revision !== undefined) return active.revision;
  const hash = createHash("sha256");
  /** Payload generations include every name and inode stamp; no compressed bytes are decoded by the recovery CAS. */
  const catalogue = (path: string): void => {
    const stat = lstatSync(path, { bigint: true }); hash.update(coordinate(root, path)); hash.update(identity(stat));
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) catalogue(join(path, name));
  };
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ((directory === root && entry.name === "destruction") || /(?:\.lock(?:\.|$)|\.tmp$)/.test(entry.name)) continue;
      if (directory === root && entry.name === "objects") { if (fresh) catalogue(join(directory, entry.name)); continue; }
      const path = join(directory, entry.name); const stat = lstatSync(path, { bigint: true }); hash.update(coordinate(root, path));
      if (stat.isDirectory()) walk(path); else if (stat.isFile() || stat.isSymbolicLink()) hash.update(digest(path, stat)); else hash.update("foreign-special-record");
    }
  };
  walk(root); const revision = hash.digest("hex"); if (active !== undefined) active.revision = revision; return revision;
}

/** Canonical relative audit coordinates never grant authority outside the recorded root/parent identities. */
function coordinate(root: string, path: string): string { return relative(root, path) || "."; }
/** Validate the complete request and bind lexical paths before any lease or publication callback. */
function normalizedRequests(requests: readonly DestructionRequest[], base: string): readonly DestructionRequest[] {
  if (!Array.isArray(requests) || requests.some(request => request === null || typeof request !== "object" || Object.keys(request).some(key => !["path", "recursive", "directory", "destination", "expected", "address", "destinationAddress"].includes(key)) || typeof request.path !== "string" || request.path === "" || [request.recursive, request.directory].some(value => value !== undefined && typeof value !== "boolean") || (request.destination !== undefined && (typeof request.destination !== "string" || request.destination === "" || request.recursive === true || request.directory === true)) || (request.expected !== undefined && (request.expected === null || typeof request.expected !== "object" || ["dev", "ino", "birthtimeNs", "size", "mtimeNs", "ctimeNs"].some(key => typeof Reflect.get(request.expected!, key) !== "bigint"))) || (request.address !== undefined && typeof request.address !== "string") || (request.destinationAddress !== undefined && typeof request.destinationAddress !== "string"))) throw new DestructionRefusal("conflicting_destructive_requests", "Deletion requests need ordinary paths and compatible explicit boolean flags.");
  return requests.map(request => ({ ...request, path: resolve(base, request.path),
    ...(request.destination === undefined ? {} : { destination: resolve(base, request.destination) }),
    ...(request.address === undefined ? {} : { address: resolve(base, request.address) }),
    ...(request.destinationAddress === undefined ? {} : { destinationAddress: resolve(base, request.destinationAddress) }),
  }));
}
/** Capture and validate the entire exact namespace before producing any intent or removing its first member. */
function snapshot(root: string, requests: readonly DestructionRequest[]): DestructionEntry[] {
  const result = new Map<string, DestructionEntry>();
  const directorySet = new Set(requests.filter(request => request.directory).map(request => canonical(request.path)));
  const capture = (path: string, request: DestructionRequest): void => {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (stat === undefined) return;
    if (request.expected !== undefined && identity(stat) !== identity(request.expected)) throw new DestructionRefusal("destructive_target_changed", "The supplied owner identity no longer names this leaf.");
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) throw new DestructionRefusal("destructive_target_unsupported", "Only ordinary files, literal links and captured directories may be retired.");
    if (request.destination !== undefined && !stat.isFile()) throw new DestructionRefusal("destructive_target_unsupported", "Atomic publication requires a regular source file.");
    if (stat.isDirectory()) {
      const names = readdirSync(path).sort();
      if (!request.recursive && (!request.directory || names.some(name => !directorySet.has(join(path, name))))) throw new DestructionRefusal("ENOTEMPTY", "Recursive deletion must be explicit and empty-directory retirement must be empty.");
      if (request.recursive) for (const name of names) capture(join(path, name), { path: join(path, name), recursive: true });
    }
    const parent = dirname(path); const parentStat = lstatSync(parent, { bigint: true }); if (!parentStat.isDirectory()) throw new DestructionRefusal("destructive_target_changed", "A deletion parent must be an ordinary directory.");
    let target: string | undefined; let destinationParentIdentity: string | undefined;
    if (request.destination !== undefined) { if (canonical(request.destination) === path) throw new DestructionRefusal("conflicting_destructive_requests", "A publication cannot retire its own destination."); const directory = lstatSync(dirname(request.destination), { bigint: true, throwIfNoEntry: false }); if (!directory?.isDirectory()) throw new DestructionRefusal("destructive_target_changed", "Publication requires an existing ordinary destination directory."); const dest = lstatSync(request.destination, { bigint: true, throwIfNoEntry: false }); if (dest !== undefined && !dest.isFile() && !dest.isSymbolicLink()) throw new DestructionRefusal(dest.isDirectory() ? "EISDIR" : "destructive_target_unsupported", "EISDIR: Publication destination is not a regular file or literal link."); target = dest === undefined ? "absent" : identity(dest); destinationParentIdentity = birth(directory); }
    const previous = result.get(path);
    if (previous !== undefined && previous.destination !== (request.destination === undefined ? undefined : coordinate(root, request.destination))) throw new DestructionRefusal("conflicting_destructive_requests", "Two requests assign incompatible actions to one leaf.");
    result.set(path, { path: coordinate(root, path), ...(request.destination === undefined ? {} : { destination: coordinate(root, request.destination), target, destinationParentIdentity }), kind: request.destination !== undefined ? "rename" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "link" : "file", identity: identity(stat), digest: digest(path, stat, true), parent: coordinate(root, parent), parentIdentity: birth(parentStat), status: "planned" });
  };
  for (const request of requests) {
    const path = canonical(request.path); const destination = request.destination === undefined ? undefined : canonical(request.destination);
    addressFor(path, request.address);
    if (request.destinationAddress !== undefined) { if (destination === undefined) throw new DestructionRefusal("conflicting_destructive_requests", "A destination alias requires a publication destination."); addressFor(destination, request.destinationAddress); }
    capture(path, { ...request, ...(destination === undefined ? {} : { destination }) });
  }
  return [...result.values()];
}
/** Parse only package-owned intent records; foreign or malformed metadata never grants deletion authority. */
function load(path: string, observation = false): Intent | undefined {
  let bytes: string;
  try {
    const observed = lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (observed === undefined) return undefined;
    if (observation) assertVerificationBound("receipts", "record_bytes", Number(observed.size), verificationLimits.receiptBytes);
    if (!observed.isFile()) throw new DestructionRefusal("foreign_destructive_intent", "A nonregular intent record was preserved.");
    const file = objectFiles.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const before = fstatSync(file.fd, { bigint: true }); bytes = readFileSync(file.fd, "utf8"); const current = lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (identity(before) !== identity(observed) || current === undefined || identity(current) !== identity(before) || identity(fstatSync(file.fd, { bigint: true })) !== identity(before)) throw new DestructionRefusal("destructive_intent_changed", "An intent record changed during its pinned read."); }
    finally { file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DestructionRefusal("destructive_intent_changed", "An observed intent disappeared during its pinned read."); throw error; }
  let value: Intent; try { value = JSON.parse(bytes) as Intent; } catch { throw new DestructionRefusal("foreign_destructive_intent", "Unparseable intent metadata was preserved."); }
  const canonicalName = (name: unknown): name is string => typeof name === "string" && name !== "" && !name.includes("\0") && !isAbsolute(name) && relative(value.root, resolve(value.root, name)) === (name === "." ? "" : name);
  if (value?.format !== "pm-vcs-destruction-1" || Object.keys(value).sort().join(",") !== (value.status === "superseded" ? "entries,format,id,reason,revision,root,rootIdentity,status" : "entries,format,id,revision,root,rootIdentity,status") || !/^[0-9a-f]{32}$/.test(value.id) || typeof value.root !== "string" || !isAbsolute(value.root) || (typeof value.revision !== "string" || !/^[0-9a-f]{64}$/.test(value.revision)) || !/^\d+:\d+:\d+$/.test(value.rootIdentity) || !["pending", "completed", "superseded"].includes(value.status) || (value.status === "superseded" && !["reachability_changed", "eligibility_changed"].includes(value.reason ?? "")) || !Array.isArray(value.entries) || value.entries.some(entry => entry === null || typeof entry !== "object" || Object.keys(entry).some(key => !["path", "destination", "kind", "identity", "digest", "parent", "parentIdentity", "target", "destinationParentIdentity", "status", "reason"].includes(key)) || !canonicalName(entry.path) || !canonicalName(entry.parent) || (entry.destination !== undefined && !canonicalName(entry.destination)) || !["file", "link", "directory", "rename"].includes(entry.kind) || !/^\d+:\d+:\d+:\d+:-?\d+:-?\d+$/.test(entry.identity) || !/^[0-9a-f]{64}$/.test(entry.digest) || !/^\d+:\d+:\d+$/.test(entry.parentIdentity) || !["planned", "deleted", "moved", "absent", "foreign", "cancelled"].includes(entry.status) || (entry.kind === "rename" ? entry.destination === undefined || typeof entry.target !== "string" || (entry.target !== "absent" && !/^\d+:\d+:\d+:\d+:-?\d+:-?\d+$/.test(entry.target)) || !/^\d+:\d+:\d+$/.test(entry.destinationParentIdentity ?? "") : entry.destination !== undefined || entry.target !== undefined || entry.destinationParentIdentity !== undefined) || !outcomes.some(outcome => outcome.status === entry.status && outcome.reason === entry.reason) || (value.status !== "pending" && entry.status === "planned"))) throw new DestructionRefusal("foreign_destructive_intent", "Foreign or invalid intent metadata was preserved.");
  return value;
}
const PROGRESS_MAGIC = Buffer.from("PMVCDP1\n");
const PROGRESS_HEADER = 76;
const outcomes: readonly { status: DestructionEntry["status"]; reason?: string }[] = [
  { status: "planned" }, { status: "deleted" }, { status: "moved" }, { status: "absent" },
  { status: "foreign", reason: "leaf_replaced" }, { status: "foreign", reason: "destination_replaced" },
  { status: "foreign", reason: "unplanned_child" }, { status: "cancelled", reason: "root_or_parent_retired" },
  { status: "cancelled", reason: "root_retired" }, { status: "foreign", reason: "retained_after_retirement" },
  { status: "cancelled", reason: "preconditions_changed" },
];
/** A fixed-size progress header binds every single-byte acknowledgment to one immutable intent and entry count. */
function progressHeader(intent: Intent): Buffer {
  const prefix = Buffer.alloc(44); PROGRESS_MAGIC.copy(prefix); prefix.write(intent.id, 8, "ascii"); prefix.writeUInt32BE(intent.entries.length, 40);
  return Buffer.concat([prefix, createHash("sha256").update(prefix).digest()]);
}
/** Verify the complete progress framing through the opened descriptor before reading or updating its bitmap. */
function verifyProgress(fd: number, intent: Intent): void {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.size !== BigInt(PROGRESS_HEADER + intent.entries.length)) throw new DestructionRefusal("foreign_destructive_intent", "A nonregular or incomplete progress bitmap was preserved.");
  const header = Buffer.alloc(PROGRESS_HEADER); const count = readSync(fd, header, 0, header.length, 0);
  if (count !== header.length || !header.equals(progressHeader(intent))) throw new DestructionRefusal("foreign_destructive_intent", "A foreign or incomplete progress bitmap was preserved.");
}
/** Read only a fixed header and one state byte; completed intents keep their immutable checkpoint and need no bitmap. */
function progressState(path: string, intent: Intent, index: number): { status: DestructionEntry["status"]; reason?: string } | undefined {
  let file: ObjectFile; try { file = objectFiles.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    verifyProgress(file.fd, intent); const state = Buffer.alloc(1); if (readSync(file.fd, state, 0, 1, PROGRESS_HEADER + index) !== 1 || outcomes[state[0]] === undefined) throw new DestructionRefusal("foreign_destructive_intent", "An unrecognized progress acknowledgment was preserved.");
    return outcomes[state[0]];
  } finally { file.close(); }
}

/** Progress may change outcomes, never the revision, root lifetime, ordered members or their captured identities. */
function authorityOf(intent: Intent): string {
  const hash = createHash("sha256").update(JSON.stringify([intent.id, intent.root, intent.rootIdentity, intent.revision]));
  for (const entry of intent.entries) hash.update(JSON.stringify([entry.path, entry.destination, entry.kind, entry.identity, entry.digest, entry.parent, entry.parentIdentity, entry.target, entry.destinationParentIdentity]));
  return hash.digest("hex");
}

/** Keep full private plans but bound every SDK/CLI refusal and success receipt to twenty members. */
function receipt(intent: Intent): DestructionReceipt { return { id: intent.id, revision: intent.revision, status: intent.status, ...(intent.reason === undefined ? {} : { reason: intent.reason }), planned: intent.entries.length, deleted: intent.entries.filter(entry => entry.status === "deleted").length, moved: intent.entries.filter(entry => entry.status === "moved").length, observedAbsent: intent.entries.filter(entry => entry.status === "absent").length, skipped: intent.entries.filter(entry => entry.status === "foreign" || entry.status === "cancelled").length, omitted: Math.max(0, intent.entries.length - 20), entries: intent.entries.slice(0, 20).map(entry => ({ ...entry })) }; }
/** One exact-set handle is reusable after every deletion/progress crash without adding newly arrived files. */
export interface DestructionPlan { readonly paths: readonly string[]; readonly resumed: boolean; remove(path: string): void; finish(): DestructionReceipt }
/** One exact checkpoint is advisory only; mutation still revalidates its recorded set inside the intent lease. */
export interface DestructionCheckpoint { readonly pending: boolean; readonly verification: VerificationResult; readonly skipped?: string }
/** Plans and read-only phase guards accept the same operation-key domain before filesystem access. */
function validateOperationKey(key: string): void { if (typeof key !== "string" || key === "" || key.includes("\0")) throw new DestructionRefusal("conflicting_destructive_requests", "A deletion intent requires a stable nonempty operation key."); }
/** Inspect one owned checkpoint without a truncated catalogue deciding whether recovery may run. */
export function inspectDestructionCheckpoint(control: string, key: string): DestructionCheckpoint {
  validateOperationKey(key); const started = performance.now(); const requested = resolve(control);
  assertVerificationBound("receipts", "record_count", 1, verificationLimits.receiptRecords); assertVerificationBound("receipts", "time_ms", 0, verificationLimits.receiptMs);
  /** Every returned outcome includes the complete query's elapsed work, including empty and foreign roots. */
  const finish = (value: DestructionCheckpoint): DestructionCheckpoint => { assertVerificationBound("receipts", "time_ms", performance.now() - started, verificationLimits.receiptMs); return value; };
  const owner = lstatSync(requested, { bigint: true, throwIfNoEntry: false }); const verified: VerificationResult = { status: "verified", verifier: "receipts" };
  if (owner === undefined) return finish({ pending: false, verification: verified });
  if (!owner.isDirectory()) return finish({ pending: false, verification: { status: "unverified", verifier: "receipts", bound: "foreign_record" }, skipped: "Foreign receipt root preserved; inspect its owner before recovery." });
  const root = realpathSync(requested); const directory = join(root, "destruction");
  try {
    canonical(join(directory, ".intent-directory"));
    const intent = load(join(directory, `${intentName(root, key)}.json`), true);
    if (intent === undefined) return finish({ pending: false, verification: verified });
    if (intent.root !== root) return finish({ pending: false, verification: { status: "unverified", verifier: "receipts", bound: "foreign_record" }, skipped: "Copied receipt belongs to another root; preserved without adopting its authority." });
    return finish({ pending: intent.rootIdentity === birth(owner) && intent.status === "pending", verification: verified });
  } catch (error) {
    if (!(error instanceof DestructionRefusal) || !["foreign_destructive_intent", "destructive_intent_changed", "destructive_target_changed"].includes(error.code)) throw error;
    return finish({ pending: false, verification: { status: "unverified", verifier: "receipts", bound: error.code === "foreign_destructive_intent" ? "decode_error" : "namespace_changed" }, skipped: "Foreign or changing checkpoint preserved; inspect its recorded owner before recovery." });
  }
}
/** Persist a revision-bound set after caller preflight; per-intent leases also serialize independent recovery drainers. */
export function prepareDestruction(control: string, key: string, requests: readonly DestructionRequest[], resumeCompleted = false, journalDirectory?: string, completedIsHistorical = false, supersedeChanged?: DestructionSupersession): DestructionPlan {
  return preparePlan([control, key, requests, resumeCompleted, journalDirectory, completedIsHistorical, supersedeChanged]);
}
/** Validate before recovery callbacks and snapshot again under the owning intent lease after they finish. */
function preparePlan(args: Parameters<typeof prepareDestruction>, beforeSnapshot?: () => void, observed?: { readonly id: string; readonly authority: string }, publication?: string): DestructionPlan {
  const [control, key, suppliedRequests, resumeCompleted = false, suppliedDirectory, completedIsHistorical = false, supersedeChanged] = args;
  let requests = suppliedRequests; let journalDirectory = suppliedDirectory;
  validateOperationKey(key);
  if (supersedeChanged !== undefined && !["reachability_changed", "eligibility_changed"].includes(supersedeChanged)) throw new DestructionRefusal("conflicting_destructive_requests", "Supersession requires a named, freshly validated precondition change.");
  const base = process.cwd(); const supplied = requests; requests = normalizedRequests(requests, base);
  const origins = new Map(requests.map((request, index) => [request, supplied[index]]));
  if (journalDirectory !== undefined) journalDirectory = resolve(base, journalDirectory);
  const requestedRoot = resolve(base, control); canonical(join(requestedRoot, ".intent-root")); mkdirSync(requestedRoot, { recursive: true, mode: 0o700 }); const root = realpathSync(requestedRoot); const rootStat = lstatSync(root, { bigint: true }); const rootIdentity = birth(rootStat);
  const directory = journalDirectory ?? join(root, "destruction"); const metadata = lstatSync(directory, { throwIfNoEntry: false }); if (metadata !== undefined && !metadata.isDirectory()) throw new DestructionRefusal("foreign_destructive_intent", "A foreign receipt-directory entry was preserved."); mkdirSync(directory, { recursive: true, mode: 0o700 });
  backend.directory(root); backend.directory(directory);
  const name = intentName(root, key); const path = join(directory, `${name}.json`);
  let held = false; let captured: Intent | undefined = undefined;
  /** Publish a fully flushed owner record exclusively; no empty lock can survive a crash before publication. */
  const claim = (): { file: ObjectFile; stat: BigIntStats } => {
    const lockPath = `${path}.lock`; const temporary = `${lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const candidate = objectFiles.open(temporary, "wx", 0o600); let original: BigIntStats | undefined; let acquired = false; let transferred = false;
    /** A cleanup attempt can remove only names still attached to this exact descriptor's inode. */
    const cleanup = (target: string): void => { const current = lstatSync(target, { bigint: true, throwIfNoEntry: false }); if (current !== undefined && original !== undefined && birth(current) === birth(original)) backend.unlink(target); };
    try {
      original = fstatSync(candidate.fd, { bigint: true }); destructionBoundary.visit("owner-opened", temporary);
      writeFileSync(candidate.fd, JSON.stringify({ format: "pm-vcs-destruction-lock-1", pid: process.pid, identity: birth(original), root, rootIdentity, key: name, cleanup: "unlink-only-this-inode" }));
      destructionBoundary.visit("owner-written", temporary); backend.file(candidate.fd); destructionBoundary.visit("owner-flushed", temporary);
      for (let attempt = 0; attempt < 8; attempt++) {
        try { backend.link(temporary, lockPath); acquired = true; destructionBoundary.visit("owner-published", lockPath); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const observed = lstatSync(lockPath, { bigint: true, throwIfNoEntry: false }); if (observed === undefined) continue;
          let record: { format?: string; pid?: number; identity?: string; root?: string; rootIdentity?: string; key?: string; cleanup?: string };
          try { record = JSON.parse(readFileSync(lockPath, "utf8")) as typeof record; } catch { throw new DestructionRefusal("destructive_intent_locked", "An unknown intent owner was preserved."); }
          if (record?.format !== "pm-vcs-destruction-lock-1" || record.cleanup !== "unlink-only-this-inode" || record.root !== root || record.rootIdentity !== rootIdentity || record.key !== name || record.identity !== birth(observed) || !Number.isSafeInteger(record.pid) || record.pid! <= 0 || record.pid! > 2_147_483_647) throw new DestructionRefusal("destructive_intent_locked", "A foreign intent owner was preserved.");
          try { process.kill(record.pid!, 0); throw new DestructionRefusal("destructive_intent_locked", "Another writer owns this intent."); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure; }
          destructionBoundary.visit("dead-lock-checked", lockPath);
          const current = lstatSync(lockPath, { bigint: true, throwIfNoEntry: false }); if (current === undefined) continue;
          if (identity(current) !== identity(observed)) throw new DestructionRefusal("destructive_intent_locked", "An intent owner changed during recovery.");
          backend.unlink(lockPath);
        }
      }
      if (!acquired) throw new DestructionRefusal("destructive_intent_locked", "Intent ownership changed throughout eight acquisition attempts.");
      cleanup(temporary); const stat = fstatSync(candidate.fd, { bigint: true }); const current = lstatSync(lockPath, { bigint: true, throwIfNoEntry: false });
      if (current === undefined || identity(current) !== identity(stat)) throw new DestructionRefusal("destructive_intent_locked", "The acquired owner was replaced before its first mutation.");
      transferred = true; return { file: candidate, stat };
    } finally {
      if (!transferred) { try { if (acquired) cleanup(lockPath); } finally { try { cleanup(temporary); } finally { candidate.close(); } } }
    }
  };
  /** Serialize every state read/modify/write and release the descriptor-owned lease last, including abort/error exits. */
  const locked = <T,>(action: () => T): T => {
    if (held) return action();
    const observedRoot = lstatSync(root, { bigint: true, throwIfNoEntry: false });
    if (observedRoot === undefined || !observedRoot.isDirectory() || birth(observedRoot) !== rootIdentity) {
      if (captured !== undefined) { for (const entry of captured.entries) if (entry.status === "planned") { entry.status = "cancelled"; entry.reason = "root_retired"; } captured.status = "completed"; }
      throw new DestructionRefusal("destructive_target_changed", "The intent root lifetime ended; its former journal is historical.", captured === undefined ? undefined : receipt(captured));
    }
    const owner = claim(); const lockPath = `${path}.lock`;
    try { held = true; return action(); }
    finally { held = false; try { destructionBoundary.visit("lock-release", lockPath); } finally { try { const current = lstatSync(lockPath, { bigint: true, throwIfNoEntry: false }); if (current !== undefined && identity(current) === identity(owner.stat)) backend.unlink(lockPath); } finally { owner.file.close(); } } }
  };
  let resumed = false;
  const intent = locked(() => {
    let current = load(path);
    if (publication !== undefined && current !== undefined && (current.entries.length !== 1 || current.entries[0].kind !== "rename" || resolve(root, current.entries[0].destination!) !== publication)) throw new DestructionRefusal("foreign_destructive_intent", "A publication receipt names another action; its record and destination were preserved.", receipt(current));
    if (observed !== undefined && (current?.id !== observed.id || current.status !== "pending" || current.rootIdentity !== rootIdentity || authorityOf(current) !== observed.authority)) throw new DestructionRefusal("destructive_intent_changed", "The selected publication changed before its recovery lease; retry the current request.", current === undefined ? undefined : receipt(current));
    if (current !== undefined && current.root !== root) throw new DestructionRefusal("foreign_destructive_intent", "An intent copied from another root was preserved.");
    if (current !== undefined && current.rootIdentity !== rootIdentity) {
      if (current.status === "pending") { for (const entry of current.entries) if (entry.status === "planned") { entry.status = "cancelled"; entry.reason = "root_retired"; } current.status = "completed"; }
      backend.write(join(directory, `${name}.${current.id}.receipt`), Buffer.from(JSON.stringify(current))); current = undefined;
    }
    if (beforeSnapshot !== undefined) {
      if (snapshot(root, requests).length === 0 && current === undefined) throw new DestructionRefusal("destructive_target_changed", "An unplanned publication source disappeared before recovery.");
      beforeSnapshot();
    }
    const entries = snapshot(root, requests);
    const absentPublication = requests.find(request => request.destination !== undefined && !hasLeaf(canonical(request.path)));
    if (absentPublication !== undefined && (current === undefined || !current.entries.some(entry => entry.kind === "rename" && resolve(root, entry.path) === canonical(absentPublication.path) && resolve(root, entry.destination!) === canonical(absentPublication.destination!)))) throw new DestructionRefusal("destructive_target_changed", "A missing publication source has no matching current receipt; inspect its historical outcome.");
    if (current !== undefined && current.status !== "superseded" && (current.status === "pending" || resumeCompleted)) {
      const requested = new Set(entries.map(entry => `${entry.path}:${entry.kind}:${entry.destination ?? ""}`));
      if (supersedeChanged !== undefined && current.status === "pending") {
        const progress = join(directory, `${name}.${current.id}.progress`);
        for (let index = 0; index < current.entries.length; index++) { const state = progressState(progress, current, index); if (state !== undefined) Object.assign(current.entries[index], state); }
      }
      const conflict = current.entries.some(entry => entry.status === "planned" && lstatSync(resolve(root, entry.path), { throwIfNoEntry: false }) !== undefined && !requested.has(`${entry.path}:${entry.kind}:${entry.destination ?? ""}`));
      const changed = supersedeChanged !== undefined && current.entries.some(entry => {
        const observed = lstatSync(resolve(root, entry.path), { bigint: true, throwIfNoEntry: false });
        if (observed === undefined) return false;
        return entry.status !== "planned" || !requested.has(`${entry.path}:${entry.kind}:${entry.destination ?? ""}`) || (entry.kind === "directory" ? birth(observed) !== entry.identity.split(":").slice(0, 3).join(":") : identity(observed) !== entry.identity);
      });
      if (changed) {
        if (current.status === "pending") {
          for (const entry of current.entries) if (entry.status === "planned") { entry.status = hasLeaf(resolve(root, entry.path)) ? "cancelled" : "absent"; if (entry.status === "cancelled") entry.reason = "preconditions_changed"; }
          current.status = "superseded"; current.reason = supersedeChanged;
          backend.write(path, Buffer.from(JSON.stringify(current))); destructionBoundary.visit("intent-superseded", path);
        }
      } else {
        if (conflict) throw new DestructionRefusal("destructive_plan_conflict", "Recovery cannot replace the original set with a different request.", receipt(current));
        resumed = true; return current;
      }
    }
    if (current?.status === "completed" && entries.length === 0 && (requests.length > 0 || current.entries.length === 0)) { resumed = true; return current; }
    const revision = journalDirectory === undefined ? storeRevision(root) : createHash("sha256").update(identity(rootStat)).update(JSON.stringify(entries)).digest("hex");
    const next: Intent = { format: "pm-vcs-destruction-1", id: randomBytes(16).toString("hex"), root, rootIdentity, revision, entries, status: "pending" };
    if (current !== undefined) backend.write(join(directory, `${name}.${current.id}.receipt`), Buffer.from(JSON.stringify(current)));
    backend.write(path, Buffer.from(JSON.stringify(next))); destructionBoundary.visit("intent-persisted", path); return next;
  });
  captured = intent;
  const frozenAuthority = authorityOf(intent);
  let checkpoint = identity(lstatSync(path, { bigint: true }));
  const addresses = new Map(requests.map(request => [canonical(request.path), request]));
  const indexes = new Map(intent.entries.map((entry, index) => [resolve(root, entry.path), index]));
  const progressPath = join(directory, `${name}.${intent.id}.progress`);
  /** Refresh only a changed peer checkpoint; unchanged immutable plans are never reparsed once per member. */
  const refresh = (): void => {
    const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (current === undefined) throw new DestructionRefusal("destructive_intent_changed", "The recorded intent disappeared.", receipt(intent));
    if (identity(current) === checkpoint) return;
    const fresh = load(path);
    if (fresh?.status === "superseded") throw new DestructionRefusal("destructive_intent_changed", "The recorded authority was superseded; inspect its terminal receipt.", receipt(fresh));
    if (fresh?.id !== intent.id || authorityOf(fresh) !== frozenAuthority) throw new DestructionRefusal("destructive_intent_changed", "The immutable intent authority changed; no new deletion was attempted.", receipt(intent));
    Object.assign(intent, fresh); checkpoint = identity(current);
  };
  /** Each acknowledgment flushes one bounded byte; an interrupted update leaves the original exact set authoritative. */
  const save = (entry: DestructionEntry): void => {
    if (lstatSync(progressPath, { throwIfNoEntry: false }) === undefined) backend.write(progressPath, Buffer.concat([progressHeader(intent), Buffer.alloc(intent.entries.length)]));
    const index = indexes.get(resolve(root, entry.path))!; const code = outcomes.findIndex(value => value.status === entry.status && value.reason === entry.reason);
    backend.update(progressPath, PROGRESS_HEADER + index, Buffer.from([code]), fd => verifyProgress(fd, intent));
  };
  /** An already retired leaf never grants authority over its replacement or changes its historical outcome. */
  const observe = (entry: DestructionEntry, index: number): void => {
    if (entry.status === "planned") {
      try { const state = progressState(progressPath, intent, index); if (state !== undefined) Object.assign(entry, state); }
      catch (error) { if (!(error instanceof DestructionRefusal) || lstatSync(resolve(root, entry.path), { throwIfNoEntry: false }) !== undefined) throw error; entry.status = "absent"; }
    }
    if (["deleted", "absent", "moved"].includes(entry.status)) {
      const source = resolve(root, entry.path);
      if (completedIsHistorical) {
        const current = lstatSync(source, { bigint: true, throwIfNoEntry: false });
        if (current === undefined || birth(current) !== entry.identity.split(":").slice(0, 3).join(":")) return;
      } else if (!hasLeaf(source)) return;
      throw new DestructionRefusal("destructive_target_changed", "A retired name still requires attention; the original completed outcome remains historical.", receipt(intent));
    }
  };
  /** Never follow an entry into a removed/recreated scope or a replaced parent. */
  const perform = (entry: DestructionEntry): void => {
    destructionBoundary.visit("before-delete", entry.path);
    const rootStat = lstatSync(root, { bigint: true, throwIfNoEntry: false }); const parent = resolve(root, entry.parent); const parentStat = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
    if (!rootStat?.isDirectory() || birth(rootStat) !== intent.rootIdentity || !parentStat?.isDirectory() || birth(parentStat) !== entry.parentIdentity) { entry.status = "cancelled"; entry.reason = "root_or_parent_retired"; save(entry); return; }
    const source = canonical(resolve(root, entry.path)); const selected = addresses.get(source);
    if (selected !== undefined) {
      const current = normalizedRequests([origins.get(selected)!], base)[0];
      if (current.path !== selected.path || current.address !== selected.address || current.destination !== selected.destination || current.destinationAddress !== selected.destinationAddress) throw new DestructionRefusal("conflicting_destructive_requests", "A caller changed its captured namespace request; retry with a new explicit plan.");
    }
    const address = addressFor(source, selected?.address);
    const stat = lstatSync(source, { bigint: true, throwIfNoEntry: false });
    if (stat === undefined) {
      if (entry.destination !== undefined) { const dest = resolve(root, entry.destination); const observed = lstatSync(dest, { bigint: true, throwIfNoEntry: false }); if (observed?.isFile() && identity(observed).split(":").slice(0, 5).join(":") === entry.identity.split(":").slice(0, 5).join(":") && digest(dest, observed) === entry.digest) { entry.status = "moved"; save(entry); return; } }
      entry.status = "absent"; save(entry); return;
    }
    if ((entry.kind === "directory" ? birth(stat) !== entry.identity.split(":").slice(0, 3).join(":") : identity(stat) !== entry.identity) || digest(source, stat) !== entry.digest) { entry.status = "foreign"; entry.reason = "leaf_replaced"; save(entry); return; }
    if (entry.destination !== undefined) {
      const destination = canonical(resolve(root, entry.destination)); const destinationParent = lstatSync(dirname(destination), { bigint: true, throwIfNoEntry: false });
      if (!destinationParent?.isDirectory() || birth(destinationParent) !== entry.destinationParentIdentity) { entry.status = "foreign"; entry.reason = "destination_replaced"; save(entry); return; }
      const observed = lstatSync(destination, { bigint: true, throwIfNoEntry: false });
      if ((observed === undefined ? "absent" : identity(observed)) !== entry.target) { entry.status = "foreign"; entry.reason = "destination_replaced"; save(entry); return; }
      backend.rename(address, addressFor(destination, selected?.destinationAddress)); entry.status = "moved";
    } else if (entry.kind === "directory") {
      if (readdirSync(source).length > 0) { entry.status = "foreign"; entry.reason = "unplanned_child"; save(entry); return; }
      backend.rmdir(address); entry.status = "deleted";
    } else { backend.unlink(address); entry.status = "deleted"; }
    destructionBoundary.visit("deleted", entry.path); save(entry); destructionBoundary.visit("progress-persisted", entry.path);
  };
  return {
    paths: intent.entries.map(entry => resolve(root, entry.path)), resumed,
    remove(target) {
      locked(() => {
        refresh(); const index = indexes.get(resolve(target)); const entry = index === undefined ? undefined : intent.entries[index];
        if (entry === undefined) throw new DestructionRefusal("unplanned_deletion", "This path is not a member of the recorded deletion set.", receipt(intent));
        try { observe(entry, index!); if (entry.status !== "planned") return; perform(entry); } catch (error) { if (error instanceof DestructionRefusal) throw error.receipt === undefined ? new DestructionRefusal(error.code, "Intent progress publication was refused; the original set remains recorded.", receipt(intent)) : error; if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") { if (!("receipt" in error)) Object.defineProperties(error, { receipt: { value: receipt(intent), enumerable: true }, remedy: { value: "Retry the original recorded operation after the native filesystem failure is resolved.", enumerable: true } }); throw error; } throw new DestructionRefusal("destructive_operation_pending", "Deletion stopped; its exact intent and progress remain recoverable.", receipt(intent)); }
      });
    },
    finish() {
      const result = locked(() => {
        refresh();
        for (let index = 0; index < intent.entries.length; index++) {
          const entry = intent.entries[index]; observe(entry, index);
        }
        settleRetiredMembers(intent);
        intent.status = intent.entries.every(entry => entry.status !== "planned") ? "completed" : "pending";
        backend.write(path, Buffer.from(JSON.stringify(intent))); checkpoint = identity(lstatSync(path, { bigint: true })); destructionBoundary.visit("receipt-persisted", path); const result = receipt(intent);
        return result;
      });
      if (result.skipped > 0 && intent.entries.some(entry => (entry.status === "foreign" || entry.status === "cancelled") && hasLeaf(resolve(root, entry.path)))) throw new DestructionRefusal("destructive_target_changed", "Replaced or unplanned entries were preserved; the finalized receipt names each outcome.", result);
      return result;
    },
  };
}
/** Retired parent files make their former descendants absent, while real I/O failures remain observable. */
function hasLeaf(path: string): boolean { try { return lstatSync(path, { throwIfNoEntry: false }) !== undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return false; throw error; } }

/** Every namespace primitive uses the same frozen-set journal, including owned temporaries and lease cleanup. @internal */
export function retireNamespace(request: DestructionRequest, completedIsHistorical = false): DestructionReceipt {
  const base = process.cwd();
  if (typeof request.path !== "string" || request.path === "" || request.path.includes("\0")) canonical(request.path);
  request = normalizedRequests([request], base)[0];
  const selected = scope(resolve(request.path));
  return inScope(selected, () => retireScoped(request, selected, completedIsHistorical));
}
/** Bind native retirement and marker-free recovery to the same canonical scope and receipt key. */
function namespaceTarget(request: DestructionRequest, selected: Scope) {
  const path = canonical(request.path); const destination = request.destination === undefined ? undefined : canonical(request.destination);
  const control = (request.recursive || request.directory) && (selected.control === path || selected.control.startsWith(`${path}${sep}`)) ? dirname(path) : selected.control;
  const ledger = join(namespaceLedger(control), "destruction");
  if (ledger === path || ledger.startsWith(`${path}${sep}`)) throw new DestructionRefusal("destructive_target_unsupported", "The receipt ledger cannot be inside its own deletion set.");
  const owner = request.expected === undefined || request.expected === null ? "" : `:${identity(request.expected)}`;
  const legacyKey = `${destination === undefined ? request.directory ? "rmdir" : "remove" : "rename"}:${path}:${destination ?? ""}${owner}`;
  const root = lstatSync(control, { throwIfNoEntry: false })?.isDirectory() ? realpathSync(control) : resolve(control); const key = destination === undefined ? legacyKey : `publication:${destination}`;
  return { path, destination, control, ledger, root, legacyKey, key };
}
/** Preserve namespace receipts independently of the data whose root may itself be retired. */
function retireScoped(request: DestructionRequest, selected: Scope, completedIsHistorical: boolean): DestructionReceipt {
  const { path, destination, control, ledger, root, legacyKey, key: primary } = namespaceTarget(request, selected); let key = primary;
  let current = load(join(ledger, `${intentName(root, key)}.json`));
  if (destination !== undefined && current === undefined) {
    for (const candidate of new Set([legacyKey, `rename:${path}:${destination}`])) {
      const legacy = load(join(ledger, `${intentName(root, candidate)}.json`));
      if (legacy !== undefined) { key = candidate; current = legacy; break; }
    }
  }
  const fresh = [{ ...request, path, address: request.address ?? request.path, ...(destination === undefined ? {} : { destination, destinationAddress: request.destinationAddress ?? request.destination }) }];
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
    if (current === undefined || destination !== undefined && !current.entries.some(entry => entry.kind === "rename" && resolve(root, entry.path) === path && resolve(root, entry.destination!) === destination)) {
      if (destination !== undefined) throw new DestructionRefusal("destructive_target_changed", "An unplanned publication source disappeared; no destination was replaced.");
      return { id: intentName(root, key).slice(0, 32), revision: "absent", status: "completed", planned: 0, deleted: 0, moved: 0, observedAbsent: 0, skipped: 0, omitted: 0, entries: [] };
    }
  }
  if (destination !== undefined && current?.status === "pending" && current.entries.length === 1 && resolve(root, current.entries[0].path) !== path) recoverPublication(root, ledger, key, current, fresh, destination);
  const migrate = destination !== undefined && current === undefined ? () => reconcilePublications(root, ledger, path, destination, fresh) : undefined;
  const plan = preparePlan([control, key, fresh, false, ledger, completedIsHistorical], migrate, undefined, destination);
  for (const member of plan.paths) plan.remove(member);
  return plan.finish();
}

/** Recover only the observed immutable receipt, validating the new request inside the original receipt lease. */
function recoverPublication(root: string, ledger: string, key: string, previous: Intent, fresh: readonly DestructionRequest[], destination: string): void {
  if (previous.status !== "pending" || previous.root !== root || previous.rootIdentity !== birth(lstatSync(root, { bigint: true })) || previous.entries.length !== 1) return;
  const entry = previous.entries[0]; if (entry.kind !== "rename" || entry.status !== "planned") return;
  const recovered = preparePlan([root, key, [{ path: resolve(root, entry.path), destination: resolve(root, entry.destination!) }], false, ledger], () => { if (snapshot(root, fresh).length === 0) throw new DestructionRefusal("destructive_target_changed", "A new publication source disappeared before recovery."); }, { id: previous.id, authority: authorityOf(previous) }, destination);
  try { for (const member of recovered.paths) recovered.remove(member); recovered.finish(); }
  catch (error) { if (!(error instanceof DestructionRefusal) || error.code !== "destructive_target_changed" || error.receipt?.status !== "completed") throw error; }
}

/** Migrate pre-target-key receipts once, before the first new publication can replace their completion evidence. */
function reconcilePublications(root: string, ledger: string, source: string, destination: string, fresh: readonly DestructionRequest[]): void {
  const temporary = /^(?:ref-.*\.lock|.*\.[0-9a-f]{12}\.tmp)$/;
  if (temporary.test(source.split(/[\\/]/).at(-1)!)) {
    const orphan = readdirSync(dirname(source)).some(name => temporary.test(name) && resolve(dirname(source), name) !== source);
    if (!orphan && !hasLeaf(destination)) return;
  }
  const started = performance.now(); let work = 0;
  for (const file of readdirSync(ledger, { withFileTypes: true })) {
    assertVerificationBound("receipts", "record_count", ++work, verificationLimits.receiptRecords);
    assertVerificationBound("receipts", "time_ms", performance.now() - started, verificationLimits.receiptMs);
    if (!file.isFile() || !/^[0-9a-f]{64}\.json$/.test(file.name)) continue;
    let previous: Intent | undefined;
    try { previous = load(join(ledger, file.name), true); }
    catch (error) { if (error instanceof DestructionRefusal && ["foreign_destructive_intent", "destructive_intent_changed"].includes(error.code)) continue; throw error; }
    if (previous === undefined || previous.status !== "pending" || previous.root !== root || previous.entries.length !== 1) continue;
    const entry = previous.entries[0]; if (entry.kind !== "rename" || resolve(root, entry.destination!) !== destination || entry.status !== "planned") continue;
    const original = resolve(root, entry.path);
    const prefix = `rename:${original}:${destination}`;
    const key = [prefix, `${prefix}:${entry.identity}`].find(candidate => `${intentName(root, candidate)}.json` === file.name);
    if (key === undefined) continue; // A foreign record never becomes mutation authority.
    recoverPublication(root, ledger, key, previous, fresh, destination);
  }
}

/** Resume an empty-directory retirement only from its original durable receipt and inode lifetime. @internal */
export function resumeNamespaceDirectory(address: string): boolean {
  address = resolve(address); const selected = scope(address);
  return inScope(selected, () => {
    const { path, control, ledger, root, key } = namespaceTarget({ path: address, directory: true }, selected);
    let current: Intent | undefined;
    try { current = load(join(ledger, `${intentName(root, key)}.json`), true); }
    catch (error) { if (error instanceof DestructionRefusal && ["foreign_destructive_intent", "destructive_intent_changed"].includes(error.code)) return false; throw error; }
    const owner = lstatSync(root, { bigint: true, throwIfNoEntry: false }); const leaf = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (current === undefined || current.root !== root || owner === undefined || current.rootIdentity !== birth(owner) || current.entries.length !== 1) return false;
    const entry = current.entries[0];
    if (entry.kind !== "directory" || resolve(root, entry.path) !== path) return false;
    if (current.status === "completed") return leaf === undefined;
    if (current.status !== "pending" || entry.status !== "planned" || leaf !== undefined && (!leaf.isDirectory() || birth(leaf) !== entry.identity.split(":").slice(0, 3).join(":"))) return false;
    try {
      const plan = preparePlan([control, key, [{ path, directory: true }], true, ledger, true], undefined, { id: current.id, authority: authorityOf(current) });
      for (const member of plan.paths) plan.remove(member);
      return plan.finish().status === "completed";
    } catch (error) {
      if (!(error instanceof DestructionRefusal) || !["foreign_destructive_intent", "destructive_intent_changed", "destructive_target_changed", "ENOTEMPTY"].includes(error.code)) throw error;
      return error.receipt?.id === current.id && error.receipt.status === "completed" && !hasLeaf(path);
    }
  });
}

/** Select the same repository/transient scope for a whole captured namespace, including standalone working-tree pruning. @internal */
export function prepareNamespaceDestruction(anchor: string, key: string, requests: readonly DestructionRequest[], resumeCompleted = false, supersedeChanged?: DestructionSupersession): DestructionPlan {
  const selected = scope(resolve(anchor));
  return inScope(selected, () => prepareDestruction(selected.control, `${key}:${canonical(anchor)}`, requests, resumeCompleted, selected.repository ? undefined : join(namespaceLedger(selected.control), "destruction"), false, supersedeChanged));
}

/** Agent-sized status inventory reports foreign records without decoding their contents into public output. */
export interface DestructionInventory {
  readonly verification: VerificationResult;
  readonly pending: number; readonly completed: number; readonly superseded: number; readonly omitted: number; readonly skippedCount: number;
  readonly receipts: readonly Omit<DestructionReceipt, "entries">[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}
/** Observe ended member lifetimes without granting old receipts authority over replacement files. */
function settleRetiredMembers(intent: Intent): boolean {
  let historical = false;
  for (const entry of intent.entries) {
    if (entry.status !== "planned") continue;
    const current = lstatSync(resolve(intent.root, entry.path), { bigint: true, throwIfNoEntry: false });
    if (current === undefined) {
      if (entry.kind === "rename") {
        const target = resolve(intent.root, entry.destination!); const observed = lstatSync(target, { bigint: true, throwIfNoEntry: false });
        if (observed?.isFile() && identity(observed).split(":").slice(0, 5).join(":") === entry.identity.split(":").slice(0, 5).join(":") && digest(target, observed) === entry.digest) entry.status = "moved";
        else { entry.status = "cancelled"; entry.reason = "preconditions_changed"; }
      } else entry.status = "absent";
      historical = true;
    }
    else if (entry.kind === "directory" ? birth(current) !== entry.identity.split(":").slice(0, 3).join(":") : identity(current) !== entry.identity) { entry.status = "foreign"; entry.reason = "leaf_replaced"; historical = true; }
  }
  if (intent.entries.every(entry => entry.status !== "planned")) intent.status = "completed";
  return historical;
}

/** Inspect durable receipts without modifying a journal, replaying a request, or following foreign record links. */
function inspectLedger(control: string, limit: number, directory = join(control, "destruction")): DestructionInventory {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new DestructionRefusal("invalid_receipt_limit", "Choose a receipt limit from 1 through 20.");
  const root = lstatSync(directory, { throwIfNoEntry: false });
  if (root === undefined) return { verification: { status: "verified", verifier: "receipts" }, pending: 0, completed: 0, superseded: 0, omitted: 0, skippedCount: 0, receipts: [], skipped: [] };
  if (!root.isDirectory()) return { verification: { status: "unverified", verifier: "receipts", bound: "foreign_record" }, pending: 0, completed: 0, superseded: 0, omitted: 0, skippedCount: 1, receipts: [], skipped: [{ name: "destruction", reason: "foreign non-directory receipt store; preserved" }] };
  const started = performance.now(); let work = 0; let bound: string | undefined;
  const found: DestructionReceipt[] = []; const skipped: { name: string; reason: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    try { assertVerificationBound("receipts", "record_count", ++work, verificationLimits.receiptRecords); assertVerificationBound("receipts", "time_ms", performance.now() - started, verificationLimits.receiptMs); } catch (error) { if (!(error instanceof VerificationRefusal)) throw error; bound = error.bound; break; }
    if (!entry.isFile() || !/^[0-9a-f]{64}(?:\.[0-9a-f]{32}\.receipt|\.json)$/.test(entry.name)) { skipped.push({ name: entry.name, reason: /^[0-9a-f]{64}\.[0-9a-f]{32}\.progress$/.test(entry.name) ? "progress auxiliary; preserved for audit" : "foreign or interrupted receipt record; preserved" }); continue; }
    try { const intent = load(join(directory, entry.name), true); if (intent === undefined) continue; if (intent.root !== resolve(control)) { skipped.push({ name: entry.name, reason: "receipt belongs to another root; preserved" }); continue; } if (intent.status === "pending") { const owner = lstatSync(control, { bigint: true, throwIfNoEntry: false }); if (!owner?.isDirectory() || birth(owner) !== intent.rootIdentity) { for (const entry of intent.entries) if (entry.status === "planned") { entry.status = "cancelled"; entry.reason = "root_retired"; } intent.status = "completed"; skipped.push({ name: entry.name, reason: "root_retired; pending authority is historical" }); } } if (intent.status === "pending") { const progress = join(directory, `${entry.name.slice(0, 64)}.${intent.id}.progress`); for (let index = 0; index < intent.entries.length; index++) { const state = progressState(progress, intent, index); if (state !== undefined && intent.entries[index].status === "planned") Object.assign(intent.entries[index], state); } if (settleRetiredMembers(intent)) skipped.push({ name: entry.name, reason: "member_lifetime_ended; original authority is historical" }); } found.push(receipt(intent)); }
    catch (error) { bound ??= error instanceof VerificationRefusal ? error.bound : "decode_error"; skipped.push({ name: entry.name, reason: error instanceof DestructionRefusal ? "foreign or changing receipt record; preserved" : "unreadable receipt record; preserved" }); }
  }
  found.sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || a.id.localeCompare(b.id));
  if (performance.now() - started >= verificationLimits.receiptMs) bound ??= "time_ms";
  const verification: VerificationResult = bound === undefined ? { status: "verified", verifier: "receipts" } : { status: "unverified", verifier: "receipts", bound };
  return { verification, pending: found.filter(item => item.status === "pending").length, completed: found.filter(item => item.status === "completed").length, superseded: found.filter(item => item.status === "superseded").length, omitted: Math.max(0, found.length - limit), skippedCount: skipped.length, receipts: found.slice(0, limit).map(({ entries: _entries, ...summary }) => summary), skipped: skipped.slice(0, 20) };
}

/** Inspect domain and namespace receipts together, preserving logical control data during observational reads. */
export function inspectDestructions(control: string, limit = 20): DestructionInventory {
  const absolute = resolve(control); const stat = lstatSync(absolute, { throwIfNoEntry: false }); const root = stat?.isDirectory() ? realpathSync(absolute) : absolute;
  const domain = inspectLedger(root, limit); const namespace = inspectLedger(root, limit, join(namespaceLedger(root), "destruction"));
  const receipts = [...domain.receipts, ...namespace.receipts].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || a.id.localeCompare(b.id));
  const pending = domain.pending + namespace.pending; const completed = domain.completed + namespace.completed; const superseded = domain.superseded + namespace.superseded;
  const verification = [domain.verification, namespace.verification].find(result => result.status === "unverified") ?? domain.verification;
  return { verification, pending, completed, superseded, omitted: Math.max(0, pending + completed + superseded - limit), skippedCount: domain.skippedCount + namespace.skippedCount, receipts: receipts.slice(0, limit), skipped: [...domain.skipped, ...namespace.skipped.map(entry => ({ ...entry, name: `namespace/${entry.name}` }))].slice(0, 20) };
}

/** A read-only semantic revision supports preflight CAS before a stale writer is ever retired. @internal */
export function measureDestructionRevision(control: string): string { return storeRevision(resolve(control), true); }
