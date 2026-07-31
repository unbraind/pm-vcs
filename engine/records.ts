// Per-field merge for structured records.
//
// This is the reason the VCS exists. Every general-purpose version control
// system merges text, so two agents that edit two different fields of one
// tracker item are merging two revisions of one *file* — and whether that
// succeeds depends on how many lines apart the fields happen to be serialized.
// That is not a property of the change; it is an accident of the file format.
//
// A record merge asks a different question: which fields did each side change?
// Disjoint field sets always merge. Only a field both sides moved to different
// values can conflict, and it conflicts alone rather than taking the document
// with it.

import type { RecordDocument, RecordValue } from "./model.ts";

/** How a field's concurrent edits are reconciled. */
export type FieldStrategy =
  /** Last-writer-wins is unsafe, so a genuine disagreement conflicts. */
  | "scalar"
  /** Unordered: both sides' members survive, duplicates collapse. */
  | "set"
  /** Append-only: both sides' additions survive in a deterministic order. */
  | "sequence";

/** Per-field strategies, with a fallback for fields not named. */
export interface MergePolicy {
  /** Strategy per field name. */
  readonly fields?: Readonly<Record<string, FieldStrategy>>;
  /**
   * Strategy for a field with no explicit entry.
   *
   * Defaults to inferring from the value: an array merges as a set, anything
   * else as a scalar. Inference is deliberately conservative — treating an
   * unknown array as a sequence could duplicate entries, whereas set-union of a
   * genuine sequence at worst loses an intentional repeat, which shows up as a
   * visible difference rather than as silent growth.
   */
  readonly fallback?: FieldStrategy;
}

/** A field both sides changed to different values. */
export interface FieldConflict {
  readonly field: string;
  /** The field's value in the common ancestor, absent when it was added. */
  readonly base: RecordValue | undefined;
  readonly ours: RecordValue | undefined;
  readonly theirs: RecordValue | undefined;
}

/** How a record merge turned out. */
export interface RecordMergeResult {
  readonly clean: boolean;
  /** The merged document. Conflicting fields keep our side's value. */
  readonly document: RecordDocument;
  /** Every field that could not be reconciled, sorted by name. */
  readonly conflicts: readonly FieldConflict[];
  /** Fields whose value differs from the base, sorted by name. */
  readonly changedFields: readonly string[];
}

/**
 * Canonical form of a value, used only for equality.
 *
 * Two values are the same edit when they serialize identically. Going through
 * the canonical encoder rather than `===` is what makes object and array values
 * comparable at all, and what makes "both sides made the same change" detectable
 * for a field whose value is structured.
 *
 * @param value - Any record value, or undefined for an absent field.
 * @returns A string that is equal exactly when the values are equal.
 */
function canonical(value: RecordValue | undefined): string {
  return value === undefined ? "\0absent" : JSON.stringify(value);
}

/**
 * Resolves which strategy applies to a field.
 *
 * @param field - The field name.
 * @param policy - The merge policy.
 * @param sample - A value for the field from whichever side has one, used for
 *   inference when the policy names neither the field nor a fallback.
 * @returns The strategy to apply.
 */
function strategyFor(field: string, policy: MergePolicy, sample: RecordValue | undefined): FieldStrategy {
  return policy.fields?.[field] ?? policy.fallback ?? (Array.isArray(sample) ? "set" : "scalar");
}

/**
 * Coerces a value to an array for set and sequence merging.
 *
 * A field declared as a collection but holding a scalar is treated as a
 * one-element collection rather than rejected: a record's shape can change over
 * its history, and refusing to merge across that change would strand the item.
 *
 * @param value - The field's value, possibly absent.
 * @returns The value as an array of members.
 */
function asMembers(value: RecordValue | undefined): readonly RecordValue[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Unions two collections against their base, preserving order.
 *
 * Order is base members first (minus any both sides removed), then our
 * additions, then theirs. Deterministic regardless of which side is called
 * "ours", except where both added distinct members — and there, ordering by side
 * is the only stable choice available.
 *
 * @param base - Members in the common ancestor.
 * @param ours - Members on our side.
 * @param theirs - Members on their side.
 * @param sorted - Whether to sort the result canonically, for set semantics
 *   where order carries no meaning.
 * @returns The unioned members.
 */
function unionMembers(
  base: readonly RecordValue[],
  ours: readonly RecordValue[],
  theirs: readonly RecordValue[],
  sorted: boolean,
): RecordValue[] {
  const keyOf = (value: RecordValue): string => JSON.stringify(value);
  const ourKeys = new Set(ours.map(keyOf));
  const theirKeys = new Set(theirs.map(keyOf));
  const result: RecordValue[] = [];
  const emitted = new Set<string>();
  const emit = (value: RecordValue): void => {
    const key = keyOf(value);
    if (emitted.has(key)) return;
    emitted.add(key);
    result.push(value);
  };
  // A base member survives unless a side removed it. Removal by one side is
  // honoured, matching the scalar rule that an untouched side defers.
  for (const member of base) {
    const key = keyOf(member);
    if (ourKeys.has(key) && theirKeys.has(key)) emit(member);
  }
  const baseKeys = new Set(base.map(keyOf));
  for (const member of ours) if (!baseKeys.has(keyOf(member))) emit(member);
  for (const member of theirs) if (!baseKeys.has(keyOf(member))) emit(member);
  // Two arms: `emit` deduplicates by key, so no two members share one and an
  // equality arm would be dead code.
  return sorted ? result.sort((left, right) => (keyOf(left) < keyOf(right) ? -1 : 1)) : result;
}

/**
 * Three-way merges two revisions of a record against their common ancestor.
 *
 * Field by field: a field neither side touched keeps its base value; a field one
 * side changed takes that side; a field both sides changed to the same value is
 * agreement, not conflict; and a field both sides changed differently either
 * unions (set, sequence) or conflicts (scalar). Field deletion is a change like
 * any other, so a field one side removed and the other left alone is removed.
 *
 * @param base - The common ancestor's fields. Empty when the record was added on
 *   both sides independently.
 * @param ours - Our side's fields.
 * @param theirs - Their side's fields.
 * @param policy - Per-field strategies.
 * @returns The merged document, every conflict, and which fields changed.
 */
export function mergeRecords(
  base: RecordDocument,
  ours: RecordDocument,
  theirs: RecordDocument,
  policy: MergePolicy = {},
): RecordMergeResult {
  const fields = [...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])].sort();
  const merged: Record<string, RecordValue> = {};
  const conflicts: FieldConflict[] = [];
  const changedFields: string[] = [];

  for (const field of fields) {
    const baseValue = base[field];
    const ourValue = ours[field];
    const theirValue = theirs[field];
    const ourChanged = canonical(ourValue) !== canonical(baseValue);
    const theirChanged = canonical(theirValue) !== canonical(baseValue);

    let resolved: RecordValue | undefined;
    if (!ourChanged && !theirChanged) {
      resolved = baseValue;
    } else if (ourChanged && !theirChanged) {
      resolved = ourValue;
    } else if (!ourChanged && theirChanged) {
      resolved = theirValue;
    } else if (canonical(ourValue) === canonical(theirValue)) {
      resolved = ourValue;
    } else {
      // At least one side has a value here: reaching this point means both sides
      // changed the field AND disagree, and two absent values would be equal.
      /* c8 ignore next -- ?? fallback unreachable: both changed it, so ourValue is defined */
      const strategy = strategyFor(field, policy, ourValue ?? theirValue);
      if (strategy === "scalar") {
        conflicts.push({ field, base: baseValue, ours: ourValue, theirs: theirValue });
        resolved = ourValue;
      } else {
        resolved = unionMembers(
          asMembers(baseValue),
          asMembers(ourValue),
          asMembers(theirValue),
          strategy === "set",
        );
      }
    }

    if (resolved !== undefined) merged[field] = resolved;
    if (canonical(resolved) !== canonical(baseValue)) changedFields.push(field);
  }

  return { clean: conflicts.length === 0, document: merged, conflicts, changedFields };
}

/**
 * Merges two append-only event logs against their common ancestor.
 *
 * Item history in this ecosystem is append-only JSON Lines, and its merge rule
 * is not the same as a record's: entries are never edited, so any entry present
 * on either side must survive, and the only real question is ordering. Entries
 * are ordered by their timestamp field when both carry one, falling back to
 * base-then-ours-then-theirs, and an entry byte-identical on both sides appears
 * once.
 *
 * @param base - Lines in the common ancestor.
 * @param ours - Lines on our side.
 * @param theirs - Lines on their side.
 * @param timestampField - Field to order by when present on both entries.
 * @returns The unioned lines, ordered deterministically. Never conflicts.
 */
export function mergeAppendOnlyLog(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
  timestampField = "at",
): string[] {
  const seen = new Set<string>();
  const ordered: Array<{ line: string; timestamp: string; arrival: number }> = [];
  // An entry with no usable timestamp inherits the last one seen in arrival
  // order. Defaulting it to the empty string instead would sort every such entry
  // ahead of every timestamped one, tearing a non-JSON line out of the position
  // it was actually appended at; inheriting keeps it adjacent to its neighbours
  // while still giving the comparator a total order to work with.
  let lastTimestamp = "";
  for (const line of [...base, ...ours, ...theirs]) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A line that is not JSON still belongs in the union; it simply carries no
      // timestamp of its own.
      parsed = null;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidate = (parsed as Record<string, unknown>)[timestampField];
      if (typeof candidate === "string") lastTimestamp = candidate;
    }
    ordered.push({ line: trimmed, timestamp: lastTimestamp, arrival: ordered.length });
  }
  // Ties keep arrival order, so the result is a function of the inputs alone.
  return ordered
    .sort((left, right) => (
      left.timestamp === right.timestamp
        ? left.arrival - right.arrival
        : left.timestamp < right.timestamp ? -1 : 1
    ))
    .map((entry) => entry.line);
}
