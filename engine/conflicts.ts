/** First-class unresolved units. Trees retain readable payloads separately from these immutable alternatives. */
import { canonicalRecordValue, compareByteOrder, decodeRecord, encodeRecord, type RecordValue } from "./model.ts";
import { isObjectId, ObjectStoreError, type ObjectId, type ObjectStore } from "./objects.ts";
import { flattenTree } from "./worktree.ts";
import { diffLines, splitLines } from "./diff.ts";

/** Every side is a separately addressed scalar envelope or hunk blob, including absence. */
export interface ConflictSides {
  readonly base: ObjectId;
  readonly ours: ObjectId;
  readonly theirs: ObjectId;
}

/** EOF newline state is part of a final hunk, including an empty deletion side. */
export interface ConflictEndings {
  readonly base: boolean;
  readonly ours: boolean;
  readonly theirs: boolean;
}

/** One scalar field or one text hunk; never a document containing marker text. */
export type ConflictUnit = ConflictSides & (
  | { readonly kind: "field"; readonly field: string }
  | { readonly kind: "text"; readonly start: number; readonly end: number; readonly endings?: ConflictEndings }
);

/** Flat, token-lean attribution row shared by status, show, log and items. */
export interface ConflictSummary {
  readonly conflict: ObjectId;
  readonly path: string;
  readonly unit: string;
  readonly item?: string;
  readonly changeId?: ObjectId;
}

/** Decode and validate the complete conflict schema before following any address. */
export function decodeConflict(payload: Buffer): ConflictUnit {
  let value: unknown;
  try { value = JSON.parse(payload.toString("utf8")); } catch {
    throw new ObjectStoreError("malformed_conflict", "Conflict is not valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ObjectStoreError("malformed_conflict", "Conflict must be an object.");
  }
  const unit = value as ConflictUnit;
  if (unit.kind === "text" && unit.endings !== undefined && (unit.endings === null || typeof unit.endings !== "object"
    || Object.keys(unit.endings).sort().join(",") !== "base,ours,theirs"
    || Object.values(unit.endings).some((value) => typeof value !== "boolean"))) {
    throw new ObjectStoreError("malformed_conflict", "Final hunk newline alternatives must be booleans.");
  }
  if (![unit.base, unit.ours, unit.theirs].every((id) => typeof id === "string" && isObjectId(id))
    || (unit.kind !== "field" && unit.kind !== "text")
    || (unit.kind === "field" && typeof unit.field !== "string")
    || (unit.kind === "text" && (!Number.isSafeInteger(unit.start) || !Number.isSafeInteger(unit.end) || unit.start < 0 || unit.end < unit.start))
    || Object.keys(value).sort().join(",") !== (unit.kind === "field" ? "base,field,kind,ours,theirs" : unit.endings === undefined ? "base,end,kind,ours,start,theirs" : "base,end,endings,kind,ours,start,theirs")) {
    throw new ObjectStoreError("malformed_conflict", "Conflict has invalid unit metadata or side addresses.");
  }
  return unit;
}

/** Canonical encoding gives each logical unresolved unit a stable content address. */
export function encodeConflict(unit: ConflictUnit): Buffer {
  const bytes = Buffer.from(canonicalRecordValue(unit as unknown as RecordValue), "utf8");
  decodeConflict(bytes);
  return bytes;
}

/** Read through the object store so digest and kind validation precede schema validation. */
export function readConflict(store: ObjectStore, id: ObjectId): ConflictUnit {
  return decodeConflict(store.readTyped(id, "conflict"));
}

/** The three reachable alternatives are required even when their owning commit is shallow. */
export function conflictReferences(unit: ConflictSides): ObjectId[] {
  return [unit.base, unit.ours, unit.theirs];
}

/** Store an absent-or-present field without confusing deletion with a JSON null. */
export function fieldSide(store: ObjectStore, value: RecordValue | undefined, fileId?: string): ObjectId {
  return store.write("record", encodeRecord(value === undefined ? {} : { value }), fileId);
}

/** Report one row per unresolved unit, omitting side payloads from routine output. */
export function summarizeConflicts(store: ObjectStore, tree: ObjectId | null, changeId?: ObjectId,
  cache: Map<ObjectId | null, ReturnType<typeof flattenTree>> = new Map()): ConflictSummary[] {
  let flat = cache.get(tree);
  if (flat === undefined) { flat = flattenTree(store, tree); cache.set(tree, flat); }
  const rows: ConflictSummary[] = [];
  for (const [path, entry] of flat) {
    if (entry.conflicts === undefined || store.denial(entry.id) !== undefined) continue;
    const payload = store.readIfType(entry.id, "record");
    const item = payload === undefined ? undefined : decodeRecord(payload.payload).id;
    for (const id of entry.conflicts) {
      const unit = readConflict(store, id);
      rows.push({ conflict: id, path, unit: unit.kind === "field" ? unit.field : `hunk:${unit.start + 1}-${unit.end}`,
        ...(typeof item === "string" ? { item } : {}), ...(changeId === undefined ? {} : { changeId }) });
    }
  }
  return rows.sort((a, b) => compareByteOrder(a.path, b.path) || compareByteOrder(a.unit, b.unit));
}

/** Carry unresolved units through ordinary edits; text ranges follow edits in the readable projection. */
export function carryConflicts(store: ObjectStore, ids: readonly ObjectId[] | undefined, previous: ObjectId, next: ObjectId, fileId?: string): readonly ObjectId[] | undefined {
  if (ids === undefined || previous === next) return ids;
  return ids.map((id) => {
    const unit = readConflict(store, id);
    if (unit.kind === "field") { store.readTyped(next, "record"); return id; }
    const edits = diffLines(splitLines(store.readTyped(previous, "blob").toString("utf8")), splitLines(store.readTyped(next, "blob").toString("utf8")));
    const hunks: { oldStart: number; oldEnd: number; newStart: number; newEnd: number }[] = [];
    let oldLine = 0;
    let newLine = 0;
    for (let index = 0; index < edits.length;) {
      if (edits[index].kind === "equal") { oldLine++; newLine++; index++; continue; }
      const oldStart = oldLine; const newStart = newLine;
      while (index < edits.length && edits[index].kind !== "equal") {
        if (edits[index].kind !== "insert") oldLine++;
        if (edits[index].kind !== "delete") newLine++;
        index++;
      }
      hunks.push({ oldStart, oldEnd: oldLine, newStart, newEnd: newLine });
    }
    /** Map a half-open boundary, excluding adjacent insertions from the conflicted unit. */
    const boundary = (line: number, end: boolean): number => {
      let shift = 0;
      for (const hunk of hunks) {
        if (line < hunk.oldStart || (line === hunk.oldStart && end)) return line + shift;
        if (line > hunk.oldEnd || (line === hunk.oldEnd && !end)) shift = hunk.newEnd - hunk.oldEnd;
        else return end ? hunk.newEnd : hunk.newStart;
      }
      return line + shift;
    };
    const start = boundary(unit.start, false);
    return store.write("conflict", encodeConflict({ ...unit, start, end: Math.max(start, boundary(unit.end, true)) }), fileId);
  });
}

/** Explicit resolution selects a side or supplies a typed replacement value. */
export type ResolutionOptions = { readonly field?: string } & (
  | { readonly take: "base" | "ours" | "theirs"; readonly value?: never }
  | { readonly value: RecordValue; readonly take?: never }
);

/** Resolve selected units while retaining every independent edit and every unselected conflict. */
export function resolvePayload(store: ObjectStore, entry: { readonly id: ObjectId; readonly conflicts?: readonly ObjectId[]; readonly fileId?: string }, options: ResolutionOptions): { id: ObjectId; conflicts?: readonly ObjectId[] } {
  const selected = (entry.conflicts ?? []).map((id) => ({ id, unit: readConflict(store, id) }))
    .filter(({ unit }) => options.field === undefined || (unit.kind === "field" && unit.field === options.field));
  if (selected.length === 0) throw new ObjectStoreError("no_matching_conflict", "No recorded conflict matches this path and field.");
  const object = store.read(entry.id);
  let payload: Buffer;
  if (object.type === "record") {
    const document = { ...decodeRecord(object.payload) };
    const choices = new Map<string, ObjectId>();
    for (const { unit } of selected) {
      if (unit.kind !== "field") throw new ObjectStoreError("conflict_payload_mismatch", "A record requires field conflicts.");
      if (options.take !== undefined) {
        const selected = choices.get(unit.field);
        if (selected !== undefined && selected !== unit[options.take]) throw new ObjectStoreError("ambiguous_resolution", "Several disputes name this field with different side values; choose --value explicitly.");
        choices.set(unit.field, unit[options.take]);
      }
      const value = options.take === undefined ? options.value : decodeRecord(store.readTyped(unit[options.take], "record")).value;
      if (value === undefined) delete document[unit.field];
      else Object.defineProperty(document, unit.field, { value, writable: true, enumerable: true, configurable: true });
    }
    payload = encodeRecord(document);
  } else if (object.type === "blob") {
    const text = object.payload.toString("utf8");
    const lines = splitLines(text);
    let terminated = text.endsWith("\n");
    const hunks: Extract<ConflictUnit, { kind: "text" }>[] = [];
    for (const { unit } of selected) {
      if (unit.kind !== "text" || unit.end > lines.length) throw new ObjectStoreError("conflict_payload_mismatch", "Text requires in-range hunk conflicts.");
      hunks.push(unit);
    }
    hunks.sort((a, b) => a.start - b.start);
    const regions: { start: number; end: number; unit: Extract<ConflictUnit, { kind: "text" }> }[] = [];
    for (const unit of hunks) {
      const previous = regions.at(-1);
      if (previous !== undefined && (unit.start === previous.start || unit.start < previous.end)) {
        if (options.take !== undefined) throw new ObjectStoreError("ambiguous_resolution", "Recorded hunks share or overlap a line range; choose --value explicitly.");
        previous.end = Math.max(previous.end, unit.end);
      } else regions.push({ start: unit.start, end: unit.end, unit });
    }
    // All coordinates refer to the original projection. Replace each connected
    // disputed region once, from right to left, including coincident insertions.
    const lineCount = lines.length;
    for (const [index, { start, end, unit }] of regions.reverse().entries()) {
      const value = options.take === undefined ? options.value : store.readTyped(unit[options.take], "blob").toString("utf8");
      if (typeof value !== "string") throw new ObjectStoreError("invalid_resolution", "Text hunk values must be strings.");
      // A final insertion owns EOF even when an earlier range ends at its boundary.
      if (index === 0 && end === lineCount) terminated = options.take === undefined ? value.endsWith("\n") : unit.endings?.[options.take] ?? terminated;
      lines.splice(start, end - start, ...splitLines(value));
    }
    payload = Buffer.from(lines.join("\n") + (lines.length > 0 && terminated ? "\n" : ""), "utf8");
  } else throw new ObjectStoreError("conflict_payload_mismatch", "Recorded conflicts require a record or text payload.");
  const remaining = entry.conflicts!.filter((id) => !selected.some((entry) => entry.id === id));
  return { id: store.write(object.type, payload, entry.fileId), ...(remaining.length > 0 ? { conflicts: remaining } : {}) };
}

/** Preserve competing explicit resolutions, including choosing the original readable projection. */
export function competingResolutions(
  store: ObjectStore,
  base: { id: ObjectId; conflicts: readonly ObjectId[] },
  ours: { id: ObjectId; conflicts?: readonly ObjectId[]; fileId?: string },
  theirs: { id: ObjectId; conflicts?: readonly ObjectId[] },
  merged: { id: ObjectId; conflicts?: readonly ObjectId[] },
): { id: ObjectId; conflicts?: readonly ObjectId[]; fields: string[] } {
  let result = merged;
  const fields: string[] = [];
  for (const id of base.conflicts) {
    const unit = readConflict(store, id);
    const inherited = (entry: { conflicts?: readonly ObjectId[] }): boolean => (entry.conflicts ?? []).some((candidate) => {
      const other = readConflict(store, candidate);
      return other.kind === unit.kind && other.base === unit.base && other.ours === unit.ours && other.theirs === unit.theirs
        && (unit.kind !== "field" || (other as Extract<ConflictUnit, { kind: "field" }>).field === unit.field);
    });
    if (inherited(ours) || inherited(theirs)) continue;
    const present = (result.conflicts ?? []).map((id) => readConflict(store, id));
    let dispute: ConflictUnit;
    if (unit.kind === "field") {
      if (present.some((current) => (current as Extract<ConflictUnit, { kind: "field" }>).field === unit.field)) continue;
      const value = (id: ObjectId): RecordValue | undefined => {
        const record = decodeRecord(store.readTyped(id, "record"));
        return Object.hasOwn(record, unit.field) ? record[unit.field] : undefined;
      };
      const ourSide = fieldSide(store, value(ours.id), ours.fileId);
      const theirSide = fieldSide(store, value(theirs.id), ours.fileId);
      if (ourSide === theirSide) continue;
      dispute = { kind: "field", field: unit.field, base: fieldSide(store, value(base.id), ours.fileId), ours: ourSide, theirs: theirSide };
      fields.push(unit.field);
    } else {
      const mapped = (payload: ObjectId): Extract<ConflictUnit, { kind: "text" }> =>
        readConflict(store, carryConflicts(store, [id], base.id, payload, ours.fileId)![0]) as Extract<ConflictUnit, { kind: "text" }>;
      const position = mapped(result.id);
      if (present.some((current) => {
        const range = current as Extract<ConflictUnit, { kind: "text" }>;
        return range.start <= position.end && range.end >= position.start;
      })) continue;
      const side = (payload: ObjectId): { id: ObjectId; ending: boolean } => {
        const text = store.readTyped(payload, "blob").toString("utf8");
        const range = mapped(payload);
        return { id: store.write("blob", Buffer.from(splitLines(text).slice(range.start, range.end).join("\n")), ours.fileId), ending: text.endsWith("\n") };
      };
      const before = side(base.id); const left = side(ours.id); const right = side(theirs.id);
      if (left.id === right.id && left.ending === right.ending) continue;
      const final = position.end === splitLines(store.readTyped(result.id, "blob").toString("utf8")).length;
      dispute = { kind: "text", start: position.start, end: position.end, base: before.id, ours: left.id, theirs: right.id,
        ...(final ? { endings: { base: before.ending, ours: left.ending, theirs: right.ending } } : {}) };
    }
    const conflict = store.write("conflict", encodeConflict(dispute), ours.fileId);
    const projection = resolvePayload(store, { ...result, fileId: ours.fileId, conflicts: [conflict] }, { take: "ours" });
    const carried = carryConflicts(store, [...(result.conflicts ?? []), conflict], result.id, projection.id, ours.fileId);
    result = { id: projection.id, conflicts: carried };
  }
  return { ...result, fields };
}
