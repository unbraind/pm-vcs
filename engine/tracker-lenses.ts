/** Read-only, explicitly selected tracker interpretations of immutable native changes. */
import { createHash } from "node:crypto";
import { parseItemDocument, isTimestampLiteral, RISK_VALUES, DEPENDENCY_KIND_VALUES } from "@unbrained/pm-cli/sdk";
import { VcsError } from "../git.ts";
import { changeProvenance, type AnnotationOrigin } from "./annotate.ts";
import { readConflict } from "./conflicts.ts";
import { canonicalRecordValue, compareByteOrder, decodeRecord, readCommit, type RecordDocument, type RecordValue, type TreeEntry } from "./model.ts";
import { type ObjectId, type ObjectStore } from "./objects.ts";
import { flattenTree } from "./worktree.ts";

/** Opt-in interpretations; these describe recorded metadata, never inferred validity or enforcement. */
export const TRACKER_LENSES = ["lifecycle", "dependency", "evidence", "policy"] as const;
/** Supported tracker projection name. */
export type TrackerLens = typeof TRACKER_LENSES[number];
/** Bounded query controls. Repeat identical revision and lenses with nextOffset for subsequent pages. */
export interface ExplainChangeOptions {
  readonly lenses?: readonly TrackerLens[];
  readonly limit?: number;
  readonly offset?: number;
}
/** Exact immutable source of one side of a statement. */
export interface ChangeCitation { readonly commit: ObjectId; readonly object: ObjectId; readonly path: string }
/** Large values retain their exact canonical digest and size instead of expanding agent output. */
export type LensValue = string | number | boolean | null | { readonly sha256: string; readonly bytes: number };
/** One change fact. Missing sides denote absence, not a null value. All facts cite their original bytes. */
export interface ChangeStatement {
  readonly lens: TrackerLens | "field" | "text" | "opaque" | "file" | "conflict";
  readonly field?: string;
  readonly item?: string;
  readonly before?: ChangeCitation;
  readonly after?: ChangeCitation;
  readonly was?: LensValue;
  readonly now?: LensValue;
  readonly entryBefore?: number;
  readonly entryAfter?: number;
  readonly coordinate?: Readonly<Record<string, LensValue>>;
}
/** First-parent delta with stable native provenance and an explicit omission receipt. */
export interface ExplainedChange {
  readonly commit: ObjectId;
  readonly base: ObjectId | null;
  readonly origin: Omit<AnnotationOrigin, "boundary">;
  readonly lenses: readonly TrackerLens[];
  readonly statements: readonly ChangeStatement[];
  readonly total: number;
  readonly omitted: number;
  readonly nextOffset: number | null;
}

type FileEntry = Omit<TreeEntry, "name">;

const FIELD_LENSES: Readonly<Record<TrackerLens, readonly string[]>> = {
  lifecycle: ["status", "type", "priority", "assignee", "closed_at", "completed_at", "close_reason", "resolution"],
  dependency: ["dependencies", "parent", "blocked_by", "blocked_reason"],
  evidence: ["files", "docs", "tests", "test_runs", "comments", "notes", "learnings"],
  policy: ["acceptance_criteria", "definition_of_ready", "risk", "confidence"],
};

/** Validate controls at the SDK boundary as well as at the CLI boundary. */
function controls(options: ExplainChangeOptions): { lenses: TrackerLens[]; limit: number; offset: number } {
  const lenses = options.lenses ?? []; const limit = options.limit ?? 20; const offset = options.offset ?? 0;
  if (!Array.isArray(lenses) || lenses.some((lens) => !TRACKER_LENSES.includes(lens))) {
    throw new VcsError("invalid_lens", "Unknown tracker lens.", "Select lifecycle,dependency,evidence,policy; omit lenses for ordinary provenance.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new VcsError("invalid_lens_page", "Invalid explanation page.", "Pass limit 1..100 and a nonnegative safe integer offset.");
  }
  return { lenses: [...new Set(lenses)], limit, offset };
}

/** Keep compact scalars; represent long text and collections without truncation or content expansion. */
function compact(value: RecordValue): LensValue {
  const bytes = canonicalRecordValue(value);
  if ((value === null || typeof value !== "object") && Buffer.byteLength(bytes) <= 160) return value;
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
}

/** Require collection entries to have the recorded string coordinates needed by their semantic interpretation. */
function entries(value: RecordValue | undefined, required: readonly string[], alternative: readonly string[] = [], scoped = false, kinds: readonly string[] = []): boolean {
  return value === undefined || (Array.isArray(value) && value.every((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as RecordDocument;
    return required.every((key) => typeof record[key] === "string" && record[key] !== "")
      && (alternative.length === 0 || alternative.some((key) => typeof record[key] === "string" && record[key] !== ""))
      && (!scoped || record.scope === "project" || record.scope === "global")
      && ["created_at", "started_at", "finished_at", "recorded_at"].every((key) => record[key] === undefined || (typeof record[key] === "string" && isTimestampLiteral(record[key] as string)))
      && (kinds.length === 0 || kinds.includes(record.kind as string));
  }));
}

/** The SDK normalizer accepts legacy collection payloads; semantic projections additionally require typed coordinates. */
function semanticShape(document: RecordDocument): boolean {
  const strings = ["id", "title", "description", "type", "status", "created_at", "updated_at", "body"];
  const optional = [...FIELD_LENSES.lifecycle, ...FIELD_LENSES.dependency, ...FIELD_LENSES.policy]
    .filter((field) => !["priority", "dependencies", "confidence"].includes(field));
  return strings.every((key) => typeof document[key] === "string")
    && typeof document.priority === "number" && Number.isInteger(document.priority) && document.priority >= 0 && document.priority <= 4
    && Array.isArray(document.tags) && document.tags.every((tag) => typeof tag === "string")
    && optional.every((key) => document[key] === undefined || typeof document[key] === "string")
    && ["created_at", "updated_at", "closed_at", "completed_at"].every((key) => document[key] === undefined || isTimestampLiteral(document[key] as string))
    && (document.risk === undefined || RISK_VALUES.includes(document.risk as typeof RISK_VALUES[number]))
    && (document.confidence === undefined || typeof document.confidence === "string" || typeof document.confidence === "number")
    && entries(document.dependencies, ["id", "kind", "created_at"], [], false, DEPENDENCY_KIND_VALUES)
    && entries(document.files, ["path"], [], true) && entries(document.docs, ["path"], [], true)
    && entries(document.tests, [], ["command", "path"], true)
    && entries(document.test_runs, ["run_id", "kind", "status", "started_at", "finished_at", "recorded_at"], [], false, ["test", "test-all"])
    && ["comments", "notes", "learnings"].every((field) => entries(document[field], ["created_at", "author", "text"]));
}

/** A semantic envelope must be a canonical SDK-valid item whose identity agrees with its tracker filename. */
function trackerItem(path: string, document: RecordDocument): boolean {
  const match = /^\.agents\/pm\/[^/]+\/([a-zA-Z0-9_-]+)\.(?:toon|md)$/.exec(path);
  if (match === null || document.id !== match[1] || !semanticShape(document)) return false;
  const { body: _body, ...metadata } = document;
  try {
    const normalized = parseItemDocument(JSON.stringify(metadata), { format: "json_markdown", requireSupportedFormat: true }).metadata;
    return canonicalRecordValue(decodeRecord(Buffer.from(JSON.stringify(normalized)))) === canonicalRecordValue(metadata);
  } catch { return false; }
}

/** Decode only selected immutable records; unconfigured blobs and non-record payloads stay opaque. */
function documentAt(store: ObjectStore, entry: FileEntry | undefined): RecordDocument | undefined {
  if (entry === undefined) return undefined;
  const object = store.read(entry.id);
  if (object.type !== "record") return undefined;
  // The object is addressable, but its tracker payload may be malformed. Reads and integrity failures propagate above.
  try { return decodeRecord(object.payload); } catch { return undefined; }
}

/** Project recorded collection additions/removals by exact value, retaining duplicates and ignoring order-only edits. */
function collectionStatements(source: ChangeStatement, was: RecordValue | undefined, now: RecordValue | undefined): ChangeStatement[] {
  const before = (was ?? []) as readonly RecordValue[]; const after = (now ?? []) as readonly RecordValue[];
  const unused = new Set(after.map((_, index) => index)); const rows: ChangeStatement[] = [];
  const matches = new Map<string, number[]>();
  for (const [index, value] of after.entries()) {
    const key = canonicalRecordValue(value); const positions = matches.get(key) ?? [];
    positions.push(index); matches.set(key, positions);
  }
  /** Show typed coordinates without expanding evidence text, commands or paths beyond the scalar budget. */
  const coordinate = (value: RecordValue): Readonly<Record<string, LensValue>> => Object.fromEntries(
    Object.entries(value as RecordDocument).filter(([key]) => ["id", "kind", "path", "command", "created_at", "text", "run_id"].includes(key))
      .map(([key, value]) => [key, compact(value)]));
  for (const [index, value] of before.entries()) {
    const equal = matches.get(canonicalRecordValue(value))?.pop();
    if (equal !== undefined) unused.delete(equal);
    else rows.push({ ...source, entryBefore: index, was: compact(value), coordinate: coordinate(value) });
  }
  for (const index of unused) rows.push({ ...source, entryAfter: index, now: compact(after[index]), coordinate: coordinate(after[index]) });
  return rows;
}

/** Explain one file delta, refusing semantic claims across malformed or unresolved tracker data. */
function fileStatements(store: ObjectStore, path: string, before: FileEntry | undefined, after: FileEntry | undefined,
  base: ObjectId | null, revision: ObjectId, lenses: readonly TrackerLens[]): ChangeStatement[] {
  const citations = { ...(before === undefined ? {} : { before: { commit: base as ObjectId, object: before.id, path } }),
    ...(after === undefined ? {} : { after: { commit: revision, object: after.id, path } }) };
  const left = documentAt(store, before); const right = documentAt(store, after);
  const tracker = path.startsWith(".agents/pm/");
  const valid = (!before || (left !== undefined && trackerItem(path, left))) && (!after || (right !== undefined && trackerItem(path, right)));
  if (tracker && !valid) return [{ lens: "opaque", ...citations }];
  if ((before && left === undefined) || (after && right === undefined)) return [{ lens: "text", ...citations }];
  const rows: ChangeStatement[] = [];
  const item = tracker ? (right ?? left)!.id as string : undefined;
  const source = { ...citations, ...(item === undefined ? {} : { item }) };
  const conflictIds = [...new Set([...(before?.conflicts ?? []), ...(after?.conflicts ?? [])])];
  const conflicts = conflictIds.map((id) => readConflict(store, id));
  for (const field of [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])].sort(compareByteOrder)) {
    const was = left?.[field]; const now = right?.[field];
    if (was !== undefined && now !== undefined && canonicalRecordValue(was) === canonicalRecordValue(now)) continue;
    const disputed = conflicts.some((conflict) => conflict.kind === "field" && conflict.field === field);
    let lens = tracker && !disputed ? lenses.find((lens) => FIELD_LENSES[lens].includes(field)) : undefined;
    if ((lens === "dependency" || lens === "evidence") && (was === undefined || Array.isArray(was)) && (now === undefined || Array.isArray(now))) {
      const entries = collectionStatements({ lens, field, ...source }, was, now);
      if (entries.length > 0) { rows.push(...entries); continue; }
      // Reordering a collection does not establish a dependency or evidence membership change.
      lens = undefined;
    }
    rows.push({ lens: lens ?? "field", field, ...source,
      ...(was === undefined ? {} : { was: compact(was) }), ...(now === undefined ? {} : { now: compact(now) }) });
  }
  if (JSON.stringify(before?.conflicts) !== JSON.stringify(after?.conflicts)) rows.push({ lens: "conflict", ...source,
    was: compact(before?.conflicts ?? []), now: compact(after?.conflicts ?? []) });
  if (rows.length === 0) rows.push({ lens: "file", ...source });
  return rows;
}

/**
 * Interpret a native change against its first parent without reading mutable tracker state or invoking Git.
 * Root changes compare against absence; shallow boundaries refuse rather than inventing creation facts.
 * Only SDK-valid, canonical item records receive selected semantic labels; all other tracker bytes stay opaque.
 * Ordinary fields/text retain object citations. Use annotatePath for last-setter and conflict-side provenance,
 * verifyChangeSignature for trust, and bisect for execution evidence; this query makes none of those claims.
 */
export function explainChange(store: ObjectStore, revision: ObjectId, options: ExplainChangeOptions = {}): ExplainedChange {
  const { lenses, limit, offset } = controls(options);
  const commit = readCommit(store, revision); const base = commit.parents[0] ?? null;
  if (base !== null && store.partialState()?.shallow.includes(revision)) {
    throw new VcsError("lens_shallow_boundary", "The selected change has omitted parent ancestry.", "Fetch its parent objects before explaining this delta; annotate still reports boundary provenance.");
  }
  const before = flattenTree(store, base === null ? null : readCommit(store, base).tree);
  const after = flattenTree(store, commit.tree); const rows: ChangeStatement[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort(compareByteOrder)) {
    const left = before.get(path); const right = after.get(path);
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    rows.push(...fileStatements(store, path, left, right, base, revision, lenses));
  }
  const statements = rows.slice(offset, offset + limit); const end = offset + statements.length;
  return { commit: revision, base, origin: changeProvenance(store, revision), lenses, statements,
    total: rows.length, omitted: rows.length - statements.length, nextOffset: end < rows.length ? end : null };
}
