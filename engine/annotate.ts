/** Demand-driven attribution over immutable file identities and selected revision ancestry. */
import { canonicalRecordValue, decodeRecord, effectiveChangeId, readCommit, readTree, type Commit, type RecordDocument, type RecordValue, type TreeEntry } from "./model.ts";
import { type ObjectId, type ObjectStore, ObjectStoreError } from "./objects.ts";
import { diffLines, splitLines } from "./diff.ts";
import { readConflict, type ConflictUnit } from "./conflicts.ts";

/** Native change provenance; absent agent fields mean that no matching PM event recorded them. */
export interface AnnotationOrigin {
  readonly changeId: ObjectId;
  readonly author: string;
  readonly items: readonly string[];
  readonly agentHarness?: string;
  readonly agentModel?: string;
  readonly boundary?: true;
}

/** One text range or structured scalar/list entry with its last setter and unresolved alternatives. */
export interface AnnotationRow extends AnnotationOrigin {
  readonly unit: string;
  readonly field?: string;
  readonly start?: number;
  end?: number;
  text?: string;
  readonly value?: RecordValue;
  readonly alternatives?: readonly { conflict: ObjectId; side: "base" | "ours" | "theirs"; origins: readonly AnnotationOrigin[]; unavailable?: true }[];
}

interface Located { readonly path: string; readonly entry: TreeEntry }
interface Unit { readonly key: string; readonly field?: string; readonly group?: string; readonly index?: number; readonly value: RecordValue }
interface Task { readonly id: ObjectId; readonly file: Located; readonly wanted: ReadonlyMap<string, number> }

/** Escape structured keys as JSON pointers so punctuation and empty field names remain exact. */
function pointer(key: string): string { return key.replace(/~/g, "~0").replace(/\//g, "~1"); }

/** Scalar leaves are independent units; each array entry is atomic and ordered, including duplicates. */
function recordUnits(document: RecordDocument): Unit[] {
  const units: Unit[] = [];
  const visit = (value: RecordValue, key: string, field: string): void => {
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) units.push({ key: `${key}/${index}`, group: key, index, field, value: entry });
    } else if (value !== null && typeof value === "object") {
      for (const [name, child] of Object.entries(value)) visit(child, `${key}/${pointer(name)}`, field);
    } else units.push({ key, field, value });
  };
  for (const [field, value] of Object.entries(document)) visit(value, `/${pointer(field)}`, field);
  return units;
}

/** Match unchanged scalars and ordered list/text entries without conflating repeated values. */
function corresponding(before: readonly Unit[], after: readonly Unit[]): Map<string, string> {
  const matches = new Map<string, string>();
  const prior = new Map(before.map((unit) => [unit.key, unit]));
  const groups = new Set(after.filter((unit) => unit.group !== undefined).map((unit) => unit.group as string));
  for (const unit of after) {
    const old = prior.get(unit.key);
    if (unit.group === undefined && old !== undefined && old.group === undefined
      && canonicalRecordValue(old.value) === canonicalRecordValue(unit.value)) matches.set(unit.key, old.key);
  }
  for (const group of groups) {
    const left = before.filter((unit) => unit.group === group); const right = after.filter((unit) => unit.group === group);
    for (const edit of diffLines(left.map((unit) => canonicalRecordValue(unit.value)), right.map((unit) => canonicalRecordValue(unit.value)))) {
      if (edit.kind === "equal") matches.set(right[edit.rightIndex as number].key, left[edit.leftIndex as number].key);
    }
  }
  return matches;
}

/** Query-local caches keep object reads proportional to selected ancestry, never all refs or unrelated payloads. */
class Annotator {
  readonly store: ObjectStore;
  readonly commits = new Map<ObjectId, Commit>();
  readonly trees = new Map<ObjectId, readonly TreeEntry[]>();
  readonly units = new Map<ObjectId, readonly Unit[]>();
  readonly documents = new Map<ObjectId, RecordDocument>();
  readonly origins = new Map<string, AnnotationOrigin>();
  readonly histories = new Map<ObjectId, readonly RecordDocument[]>();
  readonly shallow: ReadonlySet<ObjectId>;

  constructor(store: ObjectStore) { this.store = store; this.shallow = new Set(store.partialState()?.shallow ?? []); }

  /** Decode one immutable commit once, regardless of merge fan-in. */
  commit(id: ObjectId): Commit {
    let value = this.commits.get(id);
    if (value === undefined) { value = readCommit(this.store, id); this.commits.set(id, value); }
    return value;
  }

  /** Decode one tree page once and follow only the requested path on ordinary edits. */
  tree(id: ObjectId): readonly TreeEntry[] {
    let value = this.trees.get(id);
    if (value === undefined) { value = readTree(this.store, id); this.trees.set(id, value); }
    return value;
  }

  /** Locate the path directly, or scan metadata for its stable identity after a rename or copy. */
  locate(tree: ObjectId, path: string, identity?: string): Located | undefined {
    let cursor = tree; const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      const entry = this.tree(cursor).find((entry) => entry.name === part);
      if (entry === undefined) break;
      if (index === parts.length - 1 && entry.mode !== "40000" && (identity === undefined || entry.fileId === identity)) return { path, entry };
      if (entry.mode !== "40000") break;
      cursor = entry.id;
    }
    if (identity === undefined) return undefined;
    const pending = [{ id: tree, prefix: "" }];
    while (pending.length > 0) {
      const current = pending.pop() as { id: ObjectId; prefix: string };
      for (const entry of this.tree(current.id)) {
        const name = current.prefix + entry.name;
        if (entry.mode === "40000") pending.push({ id: entry.id, prefix: `${name}/` });
        else if (entry.fileId === identity) return { path: name, entry };
      }
    }
    return undefined;
  }

  /** Read only selected file payloads; structured native items are already decoded into canonical records. */
  content(entry: TreeEntry): readonly Unit[] {
    let units = this.units.get(entry.id);
    if (units === undefined) {
      const object = this.store.read(entry.id);
      if (object.type === "record") {
        const document = decodeRecord(object.payload); this.documents.set(entry.id, document); units = recordUnits(document);
      } else if (object.type === "blob") units = splitLines(object.payload.toString("utf8")).map((value, index) => ({ key: String(index), group: "lines", index, value }));
      else throw new ObjectStoreError("unsupported_annotation", "Annotation requires a text blob or structured record.");
      this.units.set(entry.id, units);
    }
    return units;
  }

  /** Resolve provenance from that immutable change's own PM history, never today's mutable tracker. */
  origin(id: ObjectId, file: Located): AnnotationOrigin {
    const key = `${id}:${file.path}`;
    const known = this.origins.get(key);
    if (known !== undefined) return known;
    const commit = this.commit(id); this.content(file.entry);
    const item = this.documents.get(file.entry.id)?.id;
    const items = [...new Set([...(commit.items ?? []), ...(typeof item === "string" ? [item] : [])])];
    let agentHarness: string | undefined; let agentModel: string | undefined;
    for (const item of items) {
      // PM item ids are path components, not arbitrary paths supplied by a commit.
      if (!/^[a-zA-Z0-9_-]+$/.test(item)) continue;
      const history = this.locate(commit.tree, `.agents/pm/history/${item}.jsonl`);
      if (history === undefined) continue;
      let events = this.histories.get(history.entry.id);
      if (events === undefined) {
        events = this.store.readTyped(history.entry.id, "blob").toString("utf8").split("\n").filter(Boolean).map((line) => decodeRecord(Buffer.from(line)));
        this.histories.set(history.entry.id, events);
      }
      for (const event of events) {
        if (event.author !== commit.author.name) continue;
        agentHarness = typeof event.agent_harness === "string" ? event.agent_harness : undefined;
        agentModel = typeof event.agent_model === "string" ? event.agent_model : undefined;
      }
      if (agentHarness !== undefined || agentModel !== undefined) break;
    }
    const origin: AnnotationOrigin = { changeId: effectiveChangeId(id, commit), author: commit.author.name, items,
      ...(agentHarness === undefined ? {} : { agentHarness }), ...(agentModel === undefined ? {} : { agentModel }),
      ...(this.shallow.has(id) ? { boundary: true } : {}) };
    this.origins.set(key, origin);
    return origin;
  }

  /** Attribute requested units iteratively; merge parents retain incoming attribution and traversal stops at setters. */
  blame(id: ObjectId, file: Located): AnnotationRow[] {
    const units = this.content(file.entry); const result: AnnotationRow[] = [];
    const pending: Task[] = [{ id, file, wanted: new Map(units.map((unit, index) => [unit.key, index])) }];
    while (pending.length > 0) {
      const task = pending.pop() as Task; const current = this.commit(task.id);
      const wanted = new Map(task.wanted);
      const currentUnits = this.content(task.file.entry);
      for (const parent of this.shallow.has(task.id) ? [] : current.parents) {
        if (wanted.size === 0) break;
        const tree = this.commit(parent).tree;
        const before = this.locate(tree, task.file.path, task.file.entry.fileId)
          ?? (task.file.entry.copiedFrom === undefined ? undefined : this.locate(tree, task.file.path, task.file.entry.copiedFrom));
        if (before === undefined) continue;
        const matches = corresponding(this.content(before.entry), currentUnits);
        const inherited = new Map<string, number>();
        for (const [key, index] of wanted) {
          const previous = matches.get(key);
          if (previous !== undefined) { inherited.set(previous, index); wanted.delete(key); }
        }
        if (inherited.size > 0) pending.push({ id: parent, file: before, wanted: inherited });
      }
      if (wanted.size > 0) {
        const origin = this.origin(task.id, task.file);
        for (const index of wanted.values()) {
          const unit = units[index];
          result[index] = { ...origin, unit: unit.key,
            ...(unit.field === undefined ? { start: index + 1, end: index + 1, text: unit.value as string } : { field: unit.field, value: unit.value }) };
        }
      }
    }
    return result;
  }

  /** Find the last setters of an immutable conflict alternative using only selected revision ancestry. */
  alternative(id: ObjectId, file: Located, unit: ConflictUnit, side: "base" | "ours" | "theirs"): AnnotationOrigin[] {
    const expected = unit.kind === "field" ? decodeRecord(this.store.readTyped(unit[side], "record")).value
      : this.store.readTyped(unit[side], "blob").toString("utf8");
    const pending = this.shallow.has(id) ? [] : this.commit(id).parents.map((parent) => ({ id: parent, file }));
    const seen = new Set<string>();
    while (pending.length > 0) {
      const task = pending.shift() as { id: ObjectId; file: Located };
      const candidate = task.id;
      const key = `${candidate}:${task.file.entry.fileId}:${task.file.path}`;
      if (seen.has(key)) continue; seen.add(key);
      const commit = this.commit(candidate);
      const located = this.locate(commit.tree, task.file.path, task.file.entry.fileId)
        ?? (task.file.entry.copiedFrom === undefined ? undefined : this.locate(commit.tree, task.file.path, task.file.entry.copiedFrom));
      if (located !== undefined) {
        const units = this.content(located.entry);
        const value = unit.kind === "field" ? this.documents.get(located.entry.id)?.[unit.field] : undefined;
        const index = unit.kind === "text" ? units.findIndex((_, index) => units.slice(index, index + splitLines(expected as string).length).map((unit) => unit.value).join("\n") === expected) : -1;
        if ((unit.kind === "field" && canonicalRecordValue(value ?? null) === canonicalRecordValue(expected ?? null) && (value === undefined) === (expected === undefined)) || index >= 0) {
          const rows = this.blame(candidate, located).filter((row) => unit.kind === "field" ? row.field === unit.field : row.start! > index && row.start! <= index + splitLines(expected as string).length);
          return [...new Map(rows.map(({ unit: _unit, field: _field, value: _value, start: _start, end: _end, text: _text, ...origin }) => [origin.changeId, origin])).values()];
        }
        if (!this.shallow.has(candidate)) pending.push(...commit.parents.map((parent) => ({ id: parent, file: located })));
      }
    }
    return [];
  }
}

/** Annotate a selected path, preserving rename/copy origins and grouping consecutive text lines by default. */
export function annotatePath(store: ObjectStore, revision: ObjectId, path: string, full = false): AnnotationRow[] {
  const query = new Annotator(store); const file = query.locate(query.commit(revision).tree, path);
  if (file === undefined) throw new ObjectStoreError("unknown_file", `No file at ${path} in the selected change.`);
  const rows = query.blame(revision, file);
  for (const id of file.entry.conflicts ?? []) {
    const unit = readConflict(store, id);
    const alternatives = (["base", "ours", "theirs"] as const).map((side) => {
      const origins = query.alternative(revision, file, unit, side);
      return { conflict: id, side, origins, ...(origins.length === 0 ? { unavailable: true as const } : {}) };
    });
    let represented = false;
    for (const [index, row] of rows.entries()) {
      if (unit.kind === "field" ? row.field === unit.field : row.start !== undefined && row.start > unit.start && row.start <= unit.end) {
        rows[index] = { ...row, alternatives: [...(row.alternatives ?? []), ...alternatives] }; represented = true;
      }
    }
    if (!represented) rows.push({ ...query.origin(revision, file), alternatives,
      ...(unit.kind === "field" ? { unit: `/${pointer(unit.field)}`, field: unit.field }
        : { unit: `hunk:${unit.start + 1}-${unit.end}`, start: unit.start + 1, end: unit.end, text: "" }) });
  }
  if (full) return rows;
  const grouped: AnnotationRow[] = [];
  for (const row of rows) {
    const previous = grouped.at(-1);
    if (row.start !== undefined && previous?.end === row.start - 1 && previous.changeId === row.changeId
      && JSON.stringify(previous.alternatives) === JSON.stringify(row.alternatives)) {
      previous.end = row.end; previous.text += `\n${row.text}`;
    } else grouped.push({ ...row });
  }
  return grouped;
}
