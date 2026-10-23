/** Signed, closed native histories whose replay authority is independently limited by the receiver. */
import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { collectCommitObjects, importBundleObjects, parseBundle, serializeBundle } from "./bundle.ts";
import { requireClosure, type ClosureMetadata } from "./closure.ts";
import { conflictReferences, decodeConflict } from "./conflicts.ts";
import { assertCheckpointPublication, checkpointClaims } from "./checkpoints.ts";
import { reachable } from "./merge.ts";
import { canonicalRecordValue, compareByteOrder, decodeCommit, decodeManifest, decodeTree, type RecordValue } from "./model.ts";
import { ObjectStoreError, isObjectId, type ObjectId, type ObjectStore } from "./objects.ts";
import { assertRefName } from "./refs.ts";
import type { Repository } from "./repo.ts";
import { assertTrustedChanges, parseTrustedKeys, readTrustedKeys } from "./signature-policy.ts";
import { keyFingerprint, parsePublicKey, publicKeyText, type TrustedKeys } from "./signatures.ts";

/** Exact relative paths and destination branch names; no globs, prefix grants or implicit dependencies. */
export interface ChangeBundleScope { readonly paths: readonly string[]; readonly refs: readonly string[] }
/** Independent receiver authority. Trust comes from this policy, never from the embedded key. */
export interface ChangeBundleAuthorization { readonly scope: ChangeBundleScope; readonly trust: TrustedKeys }
/** Signed inventory of carried and excluded physical objects. Completeness describes this source snapshot only. */
export interface ChangeBundleManifest {
  readonly version: 1;
  readonly scope: ChangeBundleScope;
  readonly tips: Readonly<Record<string, ObjectId>>;
  readonly included: readonly ObjectId[];
  readonly excluded: readonly ObjectId[];
  readonly unknownOmissions: boolean;
  readonly archiveDigest: string;
  readonly signer: string;
  readonly publicKey: string;
}
/** Compact agent receipt; the full inventory stays in the signed file, without expanding object contents. */
export interface ChangeBundleReport {
  readonly manifest: string;
  readonly objects: number;
  readonly excluded: number;
  readonly changes: number;
  readonly refs: number;
  readonly unknownOmissions: boolean;
  readonly complete: boolean;
  readonly scopeComplete: true;
}
/** Stable refusal discriminants for retry decisions. */
export type ChangeBundleRefusalCode = "invalid_change_bundle" | "bundle_scope_refused" | "bundle_signature_refused" | "bundle_incomplete" | "bundle_lease_refused" | "bundle_ref_conflict";
/** Sanitized refusal carrying a machine-readable code and concrete recovery instruction. */
export class ChangeBundleRefusal extends ObjectStoreError {
  /** Narrow discriminator shared by SDK and command handlers. */
  declare readonly code: ChangeBundleRefusalCode;
  /** Action to take before retrying. */
  readonly remedy: string;
  /** Do not echo attacker-controlled payloads, key contents or local paths. */
  constructor(code: ChangeBundleRefusalCode, remedy: string) { super(code, `Change bundle refused. ${remedy}`); this.remedy = remedy; }
}
const FORMAT = "pmvcs-change-bundle-1";
const INVALID = "Supply a canonical version 1 change bundle and explicit scope JSON; consult the change-bundle example.";
const SCOPE = "Select only fully authorized histories and paths, or obtain independent authority for every referenced path and branch; external links must be exported separately.";
const INCOMPLETE = "Restore complete selected ancestry and payloads; include every referenced native object exactly once, without unrelated objects.";
const SIGNATURE = "Use an external Ed25519 key trusted for this signer by the receiver, and regenerate the bundle after any manifest or archive change.";

/** Compare exact key arrays so punctuation in a ref name cannot impersonate multiple authorized fields. */
function row(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify([...keys].sort())) throw new ChangeBundleRefusal("invalid_change_bundle", INVALID);
  return raw as Record<string, unknown>;
}
/** Require a bounded, unique, canonically sorted set, without silently dropping selectors. */
function strings(raw: unknown, valid: (value: string) => boolean): string[] {
  if (!Array.isArray(raw) || raw.length > 100000 || raw.some(value => typeof value !== "string" || !valid(value))
    || raw.some((value, index) => index > 0 && compareByteOrder(raw[index - 1], value) >= 0)) throw new ChangeBundleRefusal("invalid_change_bundle", INVALID);
  return raw as string[];
}
/** Canonical native relative path, excluding traversal, wildcards, controls and platform ambiguity. */
function pathAllowed(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !/[\\\x00-\x1f\x7f:*?[\]]/.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
/** Parse explicit replay scope at both SDK and CLI boundaries. Lists must already be sorted and unique. */
export function parseChangeBundleScope(raw: unknown): ChangeBundleScope {
  const scope = row(raw, ["paths", "refs"]);
  const paths = strings(scope.paths, pathAllowed);
  const refs = strings(scope.refs, name => { assertRefName(name); return name.startsWith("refs/heads/"); });
  if (paths.length === 0 || refs.length === 0 || refs.length > 100 || paths.length > 1000) throw new ChangeBundleRefusal("invalid_change_bundle", INVALID);
  return { paths, refs };
}
/** Parse receiver-owned trust using the core native signature policy rather than a second key schema. */
export function parseChangeBundleAuthorization(raw: unknown): ChangeBundleAuthorization {
  const policy = row(raw, ["scope", "trust"]);
  return { scope: parseChangeBundleScope(policy.scope), trust: parseTrustedKeys(policy.trust) };
}
/** Canonical JSON bytes shared with native record encoding; the signature covers every manifest field. */
function canonical(value: unknown): Buffer { return Buffer.from(canonicalRecordValue(value as RecordValue)); }
/** Digest immutable bytes for a compact receipt and exact archive binding. */
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
/** Domain separation prevents an ordinary change signature from authorizing a bundle manifest. */
function signingBytes(manifest: ChangeBundleManifest): Buffer { return Buffer.concat([Buffer.from("pm-vcs/change-bundle\0v1\0"), canonical(manifest)]); }
/** Validate the exact destination tips independently of advertised archive headers. */
function tips(raw: unknown, scope: ChangeBundleScope): Record<string, ObjectId> {
  const values = row(raw, scope.refs);
  if (Object.values(values).some(value => typeof value !== "string" || !isObjectId(value))) throw new ChangeBundleRefusal("invalid_change_bundle", INVALID);
  return values as Record<string, ObjectId>;
}
/** Reject unsupported headers, missing references and unrelated payloads before touching the receiving store. */
function closure(store: ObjectStore, archive: Buffer, manifest: ChangeBundleManifest): ClosureMetadata {
  const parsed = parseBundle(archive);
  if (!canonical(parsed.header).equals(canonical({ refs: manifest.tips, prerequisites: [], objects: manifest.included }))
    || parsed.lines.length !== manifest.included.length || new Set(parsed.lines.map(line => line.id)).size !== parsed.lines.length
    || !canonical(parsed.lines.map(line => line.id).sort(compareByteOrder)).equals(canonical(manifest.included))) throw new ChangeBundleRefusal("bundle_incomplete", INCOMPLETE);
  const incoming = new Map(parsed.lines.map(line => [line.id, line]));
  const pending = Object.values(manifest.tips); const visited = new Set<ObjectId>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const object = incoming.get(id);
    if (object === undefined) throw new ChangeBundleRefusal("bundle_incomplete", INCOMPLETE);
    if (object.type === "commit") { const commit = decodeCommit(object.payload); pending.push(commit.tree, ...commit.parents); }
    else if (object.type === "tree") for (const entry of decodeTree(object.payload)) pending.push(entry.id, ...entry.conflicts ?? []);
    else if (object.type === "manifest") { const node = decodeManifest(object.payload); pending.push(...(node.pages ?? node.fragments).map(entry => entry.id)); }
    else if (object.type === "conflict") pending.push(...conflictReferences(decodeConflict(object.payload)));
    else if (object.type !== "blob" && object.type !== "record") throw new ChangeBundleRefusal("bundle_scope_refused", SCOPE);
  }
  if (visited.size !== incoming.size) throw new ChangeBundleRefusal("bundle_incomplete", INCOMPLETE);
  const metadata = requireClosure(store, Object.values(manifest.tips), parsed.lines, [], [], null);
  const fileIds = new Set<string>(); const copies: string[] = [];
  for (const commit of metadata.commits.values()) {
    for (const claim of checkpointClaims(commit)) for (const selection of [...claim.scope, ...claim.dependencies]) {
      if (!manifest.scope.paths.includes(selection.path)) throw new ChangeBundleRefusal("bundle_scope_refused", SCOPE);
    }
    const trees = [{ id: commit.tree, prefix: "" }];
    while (trees.length > 0) {
      const tree = trees.pop()!;
      for (const entry of metadata.trees.get(tree.id)!) {
        const path = tree.prefix + entry.name;
        if (entry.mode === "40000") {
          if (!manifest.scope.paths.some(selected => selected.startsWith(path + "/"))) throw new ChangeBundleRefusal("bundle_scope_refused", SCOPE);
          trees.push({ id: entry.id, prefix: path + "/" });
        }
        else {
          if (!manifest.scope.paths.includes(path)) throw new ChangeBundleRefusal("bundle_scope_refused", SCOPE);
          if (entry.fileId !== undefined) fileIds.add(entry.fileId);
          if (entry.copiedFrom !== undefined) copies.push(entry.copiedFrom);
        }
      }
    }
  }
  if (copies.some(id => !fileIds.has(id))) throw new ChangeBundleRefusal("bundle_scope_refused", SCOPE);
  return metadata;
}
/** Export exact selected tips and full closure under a single source lease; never rewrite or project native identities. */
export function exportChangeBundle(store: ObjectStore, selected: Readonly<Record<string, ObjectId>>, scope: ChangeBundleScope, signer: string, key: KeyObject): Buffer {
  scope = parseChangeBundleScope(scope); selected = tips(selected, scope);
  if (typeof signer !== "string" || !/^[a-zA-Z0-9_.@+-]{1,128}$/.test(signer) || key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new ChangeBundleRefusal("bundle_signature_refused", SIGNATURE);
  return store.withWriteLock(() => {
    const commits = new Set(Object.values(selected).flatMap(id => [...reachable(store, id)]));
    const included = [...collectCommitObjects(store, [...commits])].sort(compareByteOrder);
    const inventory = new Set<ObjectId>();
    for (const entry of store.walkInventory()) inventory.add(entry.id);
    const carried = new Set(included);
    const excluded = [...inventory].filter(id => !carried.has(id)).sort(compareByteOrder);
    strings(included, isObjectId); strings(excluded, isObjectId);
    const archive = serializeBundle(store, { refs: selected, prerequisites: [], objects: included }, false);
    const manifest: ChangeBundleManifest = { version: 1, scope, tips: selected, included, excluded,
      unknownOmissions: store.partialState() !== null || store.denials().length > 0,
      archiveDigest: digest(archive), signer, publicKey: publicKeyText(createPublicKey(key)) };
    closure(store, archive, manifest);
    const bytes = Buffer.from(FORMAT + "\n" + canonical({ manifest, signature: sign(null, signingBytes(manifest), key).toString("base64"), archive: archive.toString("base64") }).toString("utf8") + "\n");
    if (bytes.length > 33554432) throw new ChangeBundleRefusal("invalid_change_bundle", INVALID);
    return bytes;
  });
}
/** Parse a bounded canonical envelope and verify exact manifest bytes before any native object import. */
function preflight(store: ObjectStore, bytes: Buffer, authorization: ChangeBundleAuthorization, now: number) {
  authorization = parseChangeBundleAuthorization(authorization);
  let envelope: Record<string, unknown>;
  try {
    if (bytes.length > 33554432 || !bytes.subarray(0, FORMAT.length + 1).equals(Buffer.from(FORMAT + "\n"))) throw new Error("Format.");
    envelope = row(JSON.parse(bytes.subarray(FORMAT.length + 1).toString("utf8")), ["archive", "manifest", "signature"]);
    if (!bytes.equals(Buffer.from(FORMAT + "\n" + canonical(envelope).toString("utf8") + "\n"))) throw new Error("Canonical.");
  } catch { throw new ChangeBundleRefusal("invalid_change_bundle", INVALID); }
  const source = row(envelope.manifest, ["archiveDigest", "excluded", "included", "publicKey", "scope", "signer", "tips", "unknownOmissions", "version"]);
  const scope = parseChangeBundleScope(source.scope);
  const included = strings(source.included, isObjectId); const excluded = strings(source.excluded, isObjectId); const carried = new Set(included);
  if (source.version !== 1 || typeof source.unknownOmissions !== "boolean" || typeof source.archiveDigest !== "string" || !isObjectId(source.archiveDigest)
    || typeof source.signer !== "string" || typeof source.publicKey !== "string" || typeof envelope.signature !== "string" || typeof envelope.archive !== "string"
    || excluded.some(id => carried.has(id))) throw new ChangeBundleRefusal("invalid_change_bundle", INVALID);
  const manifest: ChangeBundleManifest = { version: 1, scope, tips: tips(source.tips, scope), included, excluded,
    unknownOmissions: source.unknownOmissions, archiveDigest: source.archiveDigest, signer: source.signer, publicKey: source.publicKey };
  const archive = Buffer.from(envelope.archive, "base64");
  if (archive.toString("base64") !== envelope.archive || digest(archive) !== manifest.archiveDigest) throw new ChangeBundleRefusal("bundle_signature_refused", SIGNATURE);
  let valid = false;
  try {
    const signature = Buffer.from(envelope.signature, "base64");
    valid = signature.length === 64 && signature.toString("base64") === envelope.signature && verify(null, signingBytes(manifest), parsePublicKey(manifest.publicKey), signature);
  } catch { throw new ChangeBundleRefusal("bundle_signature_refused", SIGNATURE); }
  if (!valid) throw new ChangeBundleRefusal("bundle_signature_refused", SIGNATURE);
  assertManifestSigner(manifest, authorization.trust, now);
  if (scope.refs.some(name => !authorization.scope.refs.includes(name)) || scope.paths.some(path => !authorization.scope.paths.includes(path))) throw new ChangeBundleRefusal("bundle_scope_refused", SCOPE);
  const metadata = closure(store, archive, manifest);
  const report: ChangeBundleReport = { manifest: digest(canonical(manifest)), objects: included.length, excluded: excluded.length, changes: metadata.commits.size,
    refs: scope.refs.length, unknownOmissions: manifest.unknownOmissions, complete: !manifest.unknownOmissions && excluded.length === 0, scopeComplete: true };
  return { manifest, archive, metadata, report };
}
/** Re-evaluate the independent receiver grant and effective revocations at the current publication clock. */
function assertManifestSigner(manifest: ChangeBundleManifest, trust: TrustedKeys, now: number): void {
  const keyId = keyFingerprint(manifest.publicKey);
  if (!Number.isSafeInteger(now) || !trust.keys.some(entry => entry.publicKey === manifest.publicKey && entry.identity === manifest.signer)
    || trust.revocations.some(entry => entry.keyId === keyId && entry.effectiveAt <= now)) throw new ChangeBundleRefusal("bundle_signature_refused", SIGNATURE);
}
/** Check the whole incoming namespace and existing filesystem before admission, including empty ref directories. */
function assertDestinationRefs(control: string, names: readonly string[]): void {
  const selected = new Set(names);
  for (const name of names) {
    const segments = name.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const prefix = segments.slice(0, length).join("/");
      const parent = length < segments.length;
      const entry = lstatSync(join(control, prefix), { throwIfNoEntry: false });
      if ((parent && selected.has(prefix)) || (entry !== undefined && (parent ? !entry.isDirectory() : !entry.isFile()))) {
        throw new ChangeBundleRefusal("bundle_ref_conflict", "Choose destination branches without parent/child name collisions; independently review and rename conflicting local refs or remove abandoned empty ref directories before retrying.");
      }
    }
  }
}
/** Read-only verification of cryptography, receiver authorization and complete native closure, without Git. */
export function inspectChangeBundle(store: ObjectStore, bytes: Buffer, authorization: ChangeBundleAuthorization, now = Date.now()): ChangeBundleReport {
  return preflight(store, bytes, authorization, now).report;
}
/** Import only after complete preflight and exact receiver CAS checks; preserve local signature/checkpoint publication policy. */
export function importChangeBundle(repository: Repository, bytes: Buffer, authorization: ChangeBundleAuthorization, expected: Readonly<Record<string, ObjectId | null>>, now = Date.now()): ChangeBundleReport {
  const { objects: store, refs } = repository;
  return store.withWriteLock(() => {
    const checked = preflight(store, bytes, authorization, now);
    const control = repository.instanceLink?.controlDirectory ?? repository.controlDirectory;
    assertDestinationRefs(control, checked.manifest.scope.refs);
    const leases = row(expected, checked.manifest.scope.refs);
    if (Object.entries(leases).some(([name, value]) => (value !== null && (typeof value !== "string" || !isObjectId(value))) || refs.read(name) !== value)) throw new ChangeBundleRefusal("bundle_lease_refused", "Read every destination branch and provide its exact expected object id, or null for a new branch; retry after reviewing concurrent changes.");
    const targets = Object.values(checked.manifest.tips);
    const recheck = assertTrustedChanges(control, checked.metadata.commits, targets);
    importBundleObjects(store, checked.archive);
    assertCheckpointPublication(store, control, checked.metadata.commits, targets);
    refs.transaction(Object.entries(checked.manifest.tips).map(([name, next]) => ({ name, next, expected: expected[name] })), () => {
      recheck();
      const publicationNow = Date.now();
      assertManifestSigner(checked.manifest, parseTrustedKeys(authorization.trust), publicationNow);
      const local = readTrustedKeys(control);
      if (local !== null && local.revocations.some(entry => entry.keyId === keyFingerprint(checked.manifest.publicKey) && entry.effectiveAt <= publicationNow)) throw new ChangeBundleRefusal("bundle_signature_refused", SIGNATURE);
    });
    return checked.report;
  });
}
