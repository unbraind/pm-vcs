/** Semantic reuse of durable core assurance receipts on immutable native snapshots. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listAssuranceVerdicts, type AssuranceGateVerdict } from "@unbrained/pm-cli/sdk";
import { writePrivateJson } from "./composition.ts";
import { canonicalRecordValue, compareByteOrder, decodeRecord, effectiveChangeId, type Commit, type RecordValue } from "./model.ts";
import { ObjectStoreError, isObjectId, type ObjectId, type ObjectStore } from "./objects.ts";
import { flattenTree } from "./worktree.ts";

/** Exact native path, optionally projected to top-level record fields. No globs or implicit dependencies. */
export interface CheckpointSelection { readonly path: string; readonly fields?: readonly string[] }
/** Receiver-owned meaning of a named checkpoint; sender claims cannot narrow it. */
export interface CheckpointRequirement {
  readonly id: string;
  readonly scope: readonly CheckpointSelection[];
  readonly dependencies: readonly CheckpointSelection[];
  readonly gateId: string;
  readonly assertionId: string;
}
/** Exact core receipt identity, captured when validation ran against the native tree. */
export interface CheckpointReceipt { readonly treeId: string; readonly evaluatedAt: string }
/** Request to bind an existing durable assertion receipt, without running or redefining its contract. */
export interface CheckpointRequest extends CheckpointRequirement { readonly receipt: CheckpointReceipt }
/** Immutable claim; the fingerprint covers its stable change identity, selectors and selected values. */
export interface SemanticCheckpoint extends CheckpointRequest {
  readonly version: 1;
  readonly changeId: ObjectId;
  readonly fingerprint: string;
  readonly evidenceDigest: string;
}
/** Diagnostic states shared by SDK and CLI. */
export type CheckpointStatus = "valid" | "missing" | "scope_changed" | "requirement_changed";
/** Bounded inspection receipt: values, tracker bodies and core verdict payloads never enter output. */
export interface CheckpointReport {
  readonly ok: boolean;
  readonly total: number;
  readonly omitted: number;
  readonly rows: readonly { readonly id: string; readonly status: CheckpointStatus; readonly remedy: string }[];
}
/** Stable refusal codes shared by SDK callers and transport diagnostics. */
export type CheckpointRefusalCode = "invalid_checkpoint" | "invalid_checkpoint_limit" | "invalid_checkpoint_policy"
  | "malformed_checkpoint" | "checkpoint_conflict" | "checkpoint_scope_unavailable" | "checkpoint_evidence_refused"
  | "checkpoint_evidence_unavailable" | "checkpoint_publication_refused" | "checkpoint_input_required" | "invalid_checkpoint_input";
/** Stable checkpoint refusal with an actionable remedy, also present in the message over HTTP. */
export class CheckpointRefusal extends ObjectStoreError {
  /** Stable machine-readable refusal category. */
  declare readonly code: CheckpointRefusalCode;
  /** Action required before the caller can retry safely. */
  readonly remedy: string;
  /** Preserve the code and remedy without echoing untrusted documents or receipt values. */
  constructor(code: CheckpointRefusalCode, remedy: string) {
    super(code, `Semantic checkpoint refused. ${remedy}`);
    this.remedy = remedy;
  }
}
/** Receiver administration file, never accepted from advertisements or a sender's working tree. */
export const CHECKPOINT_POLICY_FILE = "checkpoint-policy.json";
const REVALIDATE = "Collect a new durable passing core assertion for this native tree, then attach a checkpoint with the required scope and dependencies.";

/** Reject non-object input at every untrusted JSON boundary. */
function object(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new CheckpointRefusal("invalid_checkpoint", "Supply a checkpoint JSON object matching the documented schema.");
  return raw as Record<string, unknown>;
}
/** Fixed small public identifiers keep reports bounded and exclude arbitrary prose. */
function label(raw: unknown): string {
  if (typeof raw !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(raw)) throw new CheckpointRefusal("invalid_checkpoint", "Use nonempty public identifiers of at most 128 ASCII letters, digits or . _ : -.");
  return raw;
}
/** Canonical bounded selectors; path, identity, mode, missing fields and conflicts remain semantically significant. */
function selections(raw: unknown, empty: boolean): CheckpointSelection[] {
  if (!Array.isArray(raw) || raw.length > 100 || (!empty && raw.length === 0)) throw new CheckpointRefusal("invalid_checkpoint", "Select 1..100 scope paths and 0..100 explicit dependency paths.");
  const seen = new Set<string>();
  return raw.map((value: unknown) => {
    const row = object(value); const path = row.path;
    if (typeof path !== "string" || path.length > 512 || path === "" || /[\\\x00-\x1f:*?[\]]/.test(path)
      || path.split("/").some(part => part === "" || part === "." || part === "..") || seen.has(path)
      || Object.keys(row).some(key => !["path", "fields"].includes(key))) throw new CheckpointRefusal("invalid_checkpoint", "Use unique canonical relative file paths, without globs or traversal.");
    seen.add(path);
    if (row.fields === undefined) return { path };
    if (!Array.isArray(row.fields) || row.fields.length < 1 || row.fields.length > 100
      || row.fields.some(field => typeof field !== "string" || field.length === 0 || field.length > 128)
      || new Set(row.fields).size !== row.fields.length) throw new CheckpointRefusal("invalid_checkpoint", "Select 1..100 unique top-level record fields, or omit fields for the entire file.");
    return { path, fields: [...row.fields].sort() as string[] };
  }).sort((a, b) => compareByteOrder(a.path, b.path));
}
/** Normalize a requirement, independently of the sender's checkpoint. */
export function parseCheckpointRequirement(raw: unknown): CheckpointRequirement {
  const row = object(raw);
  return { id: label(row.id), scope: selections(row.scope, false), dependencies: selections(row.dependencies, true), gateId: label(row.gateId), assertionId: label(row.assertionId) };
}
/** Validate an exact receipt selector rather than choosing a convenient newer verdict. */
export function parseCheckpointRequest(raw: unknown): CheckpointRequest {
  const row = object(raw); const receipt = object(row.receipt);
  if (typeof receipt.treeId !== "string" || !isObjectId(receipt.treeId) || typeof receipt.evaluatedAt !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receipt.evaluatedAt) || !Number.isFinite(Date.parse(receipt.evaluatedAt)) || new Date(receipt.evaluatedAt).toISOString() !== receipt.evaluatedAt) {
    throw new CheckpointRefusal("invalid_checkpoint", "Use the exact native tree id and canonical UTC evaluated_at from a durable core assurance verdict.");
  }
  return { ...parseCheckpointRequirement(row), receipt: { treeId: receipt.treeId, evaluatedAt: receipt.evaluatedAt } };
}
/** Domain-separated canonical JSON hash; undefined values are never part of a selected scope. */
function digest(value: unknown): string {
  return createHash("sha256").update("pm-vcs/semantic-checkpoint/v1\0").update(canonicalRecordValue(value as RecordValue)).digest("hex");
}
/** Project immutable native bytes, never mutable files, tracker caches or Git state. */
function fingerprint(store: ObjectStore, changeId: ObjectId, commit: Commit, request: CheckpointRequest, evidenceDigest: string): string {
  const tree = flattenTree(store, commit.tree);
  /** Bind missing files distinctly so deletion is invalidation rather than reuse. */
  const project = (selection: CheckpointSelection): unknown => {
    const entry = tree.get(selection.path);
    if (entry === undefined) return { path: selection.path, missing: true };
    if ((entry.conflicts?.length ?? 0) > 0) throw new CheckpointRefusal("checkpoint_conflict", "Resolve selected native file conflicts before accepting or reusing validation.");
    const identity = { path: selection.path, fileId: entry.fileId ?? null, mode: entry.mode };
    if (selection.fields === undefined) return { ...identity, object: entry.id };
    let record: ReturnType<typeof decodeRecord>;
    try { record = decodeRecord(store.readTyped(entry.id, "record")); }
    catch { throw new CheckpointRefusal("checkpoint_scope_unavailable", "Restore selected objects and configure field-selected files as valid native records before revalidating."); }
    return { ...identity, fields: selection.fields.map(field => Object.hasOwn(record, field) ? [field, true, record[field]] : [field, false]) };
  };
  return digest({ changeId, requirement: parseCheckpointRequirement(request), receipt: request.receipt, evidenceDigest, scope: request.scope.map(project), dependencies: request.dependencies.map(project) });
}
/** Decode and normalize carried claims; malformed or excessive headers fail closed before publication. */
export function checkpointClaims(commit: Commit): SemanticCheckpoint[] {
  if (commit.checkpoints === undefined) return [];
  try {
    if (commit.checkpoints.length > 262144) throw new Error("Oversized header.");
    const bytes = Buffer.from(commit.checkpoints, "base64");
    if (bytes.toString("base64") !== commit.checkpoints) throw new Error("Noncanonical encoding.");
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) throw new Error("Invalid claims.");
    const ids = new Set<string>();
    return raw.map((value: unknown) => {
      const row = object(value); const request = parseCheckpointRequest(row);
      if (row.version !== 1 || typeof row.changeId !== "string" || !isObjectId(row.changeId)
        || typeof row.fingerprint !== "string" || !isObjectId(row.fingerprint) || typeof row.evidenceDigest !== "string" || !isObjectId(row.evidenceDigest)
        || ids.has(request.id)) throw new Error("Invalid claim.");
      ids.add(request.id);
      return { ...request, version: 1, changeId: row.changeId, fingerprint: row.fingerprint, evidenceDigest: row.evidenceDigest };
    });
  } catch { throw new CheckpointRefusal("malformed_checkpoint", "Restore a well-formed checkpoint header or collect and attach fresh validation."); }
}
/** Bind a passing core receipt from an authenticated backend; directory callers use loadCheckpointReceipt. */
export function createSemanticCheckpoint(store: ObjectStore, id: ObjectId, commit: Commit, input: CheckpointRequest, verdict: AssuranceGateVerdict): SemanticCheckpoint {
  const request = parseCheckpointRequest(input);
  const assertion = verdict.assertions.filter(row => row.assertion_id === request.assertionId);
  if (request.receipt.treeId !== commit.tree || verdict.tree_id !== commit.tree || verdict.gate_id !== request.gateId
    || verdict.evaluated_at !== request.receipt.evaluatedAt || verdict.dry_run !== false || verdict.assertions_total !== verdict.assertions.length
    || assertion.length !== 1 || assertion[0].verdict !== "pass" || assertion[0].negative_control_proven !== true || !Number.isSafeInteger(assertion[0].population_size) || assertion[0].population_size <= 0) {
    throw new CheckpointRefusal("checkpoint_evidence_refused", REVALIDATE);
  }
  const tree = flattenTree(store, commit.tree);
  if ([...request.scope, ...request.dependencies].some(selection => !tree.has(selection.path))) {
    throw new CheckpointRefusal("checkpoint_scope_unavailable", "Commit every selected scope and policy dependency before collecting validation.");
  }
  const changeId = effectiveChangeId(id, commit);
  return { ...request, version: 1, changeId, fingerprint: fingerprint(store, changeId, commit, request, digest(verdict)), evidenceDigest: digest(verdict) };
}
/** Read durable verified workspace history through the SDK; missing or ambiguous receipts never become claims. */
export async function loadCheckpointReceipt(pmRoot: string, input: CheckpointRequest): Promise<AssuranceGateVerdict> {
  const request = parseCheckpointRequest(input);
  let receipts: AssuranceGateVerdict[];
  try { receipts = await listAssuranceVerdicts(pmRoot, { gate_id: request.gateId, limit: 1000 }); }
  catch { throw new CheckpointRefusal("checkpoint_evidence_unavailable", "Restore readable, verified core assurance history before attaching validation."); }
  const matching = receipts.filter(row => row.tree_id === request.receipt.treeId && row.evaluated_at === request.receipt.evaluatedAt);
  if (matching.length !== 1) throw new CheckpointRefusal("checkpoint_evidence_unavailable", "Select one exact durable core receipt in the newest 1000 gate verdicts.");
  return matching[0];
}
/** Replace only the named claim; retaining stale claims makes invalidation visible until explicitly revalidated. */
export function attachCheckpoint(commit: Commit, claim: SemanticCheckpoint): string {
  const claims = checkpointClaims(commit).filter(row => row.id !== claim.id).concat(claim).sort((a, b) => compareByteOrder(a.id, b.id));
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64");
  checkpointClaims({ ...commit, checkpoints: encoded });
  return encoded;
}
/** Inspect all claims before compacting, with independently supplied receiver requirements. */
export function inspectCheckpoints(store: ObjectStore, id: ObjectId, commit: Commit, requirements: readonly CheckpointRequirement[] = [], limit = 20): CheckpointReport {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CheckpointRefusal("invalid_checkpoint_limit", "Use a checkpoint output limit from 1 to 100.");
  const claims = checkpointClaims(commit); const required = parseCheckpointPolicy(requirements);
  const names = [...new Set([...required.map(row => row.id), ...claims.map(row => row.id)])].sort();
  const rows = names.map(name => {
    const claim = claims.find(row => row.id === name); const requirement = required.find(row => row.id === name);
    let status: CheckpointStatus = "valid";
    if (claim === undefined) status = "missing";
    else if (requirement !== undefined && digest(requirement) !== digest(parseCheckpointRequirement(claim))) status = "requirement_changed";
    else if (claim.changeId !== effectiveChangeId(id, commit) || claim.fingerprint !== fingerprint(store, claim.changeId, commit, claim, claim.evidenceDigest)) status = "scope_changed";
    return { id: name, status, remedy: status === "valid" ? "Reuse this scoped receipt." : REVALIDATE };
  });
  return { ok: rows.every(row => row.status === "valid"), total: rows.length, omitted: Math.max(0, rows.length - limit), rows: rows.slice(0, limit) };
}
/** Validate bounded receiver policy before administration or use. */
export function parseCheckpointPolicy(raw: unknown): CheckpointRequirement[] {
  if (!Array.isArray(raw) || raw.length > 32) throw new CheckpointRefusal("invalid_checkpoint_policy", "Supply an array of at most 32 unique checkpoint requirements.");
  const requirements = raw.map(parseCheckpointRequirement);
  if (new Set(requirements.map(row => row.id)).size !== requirements.length) throw new CheckpointRefusal("invalid_checkpoint_policy", "Use unique checkpoint requirement identifiers.");
  return requirements;
}
/** Persist receiver administration under the same writer lease as native publication. */
export function updateCheckpointPolicy(store: ObjectStore, control: string, raw: unknown): void {
  const requirements = parseCheckpointPolicy(raw);
  store.withWriteLock(/** Linearize policy changes against ref publication. */ () => writePrivateJson(join(control, CHECKPOINT_POLICY_FILE), requirements));
}
/** Read policy anew for each publication; absent policy preserves opt-in legacy operation. */
export function readCheckpointPolicy(control: string): CheckpointRequirement[] {
  let raw: string;
  try { raw = readFileSync(join(control, CHECKPOINT_POLICY_FILE), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CheckpointRefusal("invalid_checkpoint_policy", "Restore readable receiver checkpoint policy before publishing.");
  }
  try { return parseCheckpointPolicy(JSON.parse(raw)); }
  catch { throw new CheckpointRefusal("invalid_checkpoint_policy", "Restore valid receiver checkpoint policy before publishing."); }
}
/** Enforce required scopes and every carried claim on published tips inside the receiver ref transaction. */
export function assertCheckpointPublication(store: ObjectStore, control: string, commits: ReadonlyMap<ObjectId, Commit>, roots: readonly ObjectId[]): void {
  const requirements = readCheckpointPolicy(control);
  for (const id of new Set(roots)) {
    const commit = commits.get(id);
    if (commit === undefined) throw new CheckpointRefusal("checkpoint_scope_unavailable", "Validate complete native commit closure before checking publication requirements.");
    const report = inspectCheckpoints(store, id, commit, requirements, 100);
    if (!report.ok) throw new CheckpointRefusal("checkpoint_publication_refused", REVALIDATE);
  }
}
