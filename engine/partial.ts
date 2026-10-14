/** Explicit local shallow boundaries and payload promises, separate from content-addressed history. */
import { join } from "node:path";
import { readControlJson, isObjectId, ObjectStoreError, type ObjectId } from "./objects.ts";

/** User-selected transfer bounds. Omission always preserves original commit and tree identities. */
export interface HistoryOptions {
  readonly depth?: number;
  readonly filter?: "blob:none";
}

/** Durable promises name a configured remote, never embed its credentials. */
export interface PartialState {
  readonly remote: string;
  readonly shallow: readonly ObjectId[];
  readonly promised: readonly ObjectId[];
}

/** Validate an opt-in wire request before reading source history. */
export function historyOptions(value: HistoryOptions): HistoryOptions {
  if ((value.depth !== undefined && (!Number.isSafeInteger(value.depth) || value.depth < 1))
    || (value.filter !== undefined && value.filter !== "blob:none")) throw new ObjectStoreError("invalid_history_options", "Depth must be a positive safe integer; the supported filter is blob:none.");
  return value;
}

/** Validate exact address lists before they can authorize intentionally absent structure or payload. */
export function omissionIds(value: unknown): ObjectId[] {
  if (!Array.isArray(value) || value.some(/** Every omission must have a complete content address. */ (id) => typeof id !== "string" || !isObjectId(id))) {
    throw new ObjectStoreError("bad_partial_history", "Partial history has invalid omission addresses.");
  }
  return value;
}

/** Read clone-local promises strictly; a missing file means complete history. */
export function readPartialState(control: string): PartialState | null {
  const absent = Symbol("complete history");
  const value = readControlJson(join(control, "partial.json"), "bad_partial_history", "partial history", absent);
  if (value === absent) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof (value as PartialState).remote !== "string" || (value as PartialState).remote === "") {
    throw new ObjectStoreError("bad_partial_history", "Partial history requires a configured promisor remote.");
  }
  const state = value as PartialState;
  return { remote: state.remote, shallow: omissionIds(state.shallow), promised: omissionIds(state.promised) };
}
