// Bundles: a set of commits, everything they reach, and the refs that name them.
//
// This is what makes the system distributed rather than local. There is no
// network protocol here on purpose — a file that can be copied, attached, or
// piped is the transport an agent already has, and it works identically between
// two directories on one host, between a job and its runner, and across a review.
//
// Import verifies every object against its own id before storing it. A bundle
// arrives from outside, so treating its claims about what an object is called as
// trustworthy would let a malformed or tampered bundle put content into the store
// under a name that does not describe it — after which every identity check in
// the system is reasoning about a lie.

import { readFileSync } from "node:fs";

import { compareByteOrder, decodeCommit, decodeTree, readCommit, readTree } from "./model.ts";
import {
  type ObjectId,
  type ObjectType,
  OBJECT_TYPES,
  type ObjectStore,
  ObjectStoreError,
  hashObject,
  isObjectId,
} from "./objects.ts";
import { reachable } from "./merge.ts";
import { BRANCH_PREFIX, type RefStore, TAG_PREFIX } from "./refs.ts";

/** Format marker written as a bundle's first line. */
export const BUNDLE_FORMAT = "pmvcs-bundle-1";

/** Canonical inventory of refs, prerequisites, and object payloads serialized into one transport-neutral archive. */
export interface BundleContents {
  /** Ref name to commit id, for the refs the bundle advertises. */
  readonly refs: Readonly<Record<string, ObjectId>>;
  /** Commits the bundle expects the receiver to already have. */
  readonly prerequisites: readonly ObjectId[];
  /** Object ids the bundle carries, sorted. */
  readonly objects: readonly ObjectId[];
}

/** Verified object-store additions, existing objects, and advertised refs produced by importing an archive. */
export interface ImportReport {
  /** Objects newly written to the store. */
  readonly added: readonly ObjectId[];
  /** Objects the store already had. */
  readonly skipped: readonly ObjectId[];
  /** Refs the bundle advertised and their targets. */
  readonly refs: Readonly<Record<string, ObjectId>>;
}

/** One line of a bundle body. */
interface BundleLine {
  readonly type: ObjectType;
  readonly id: ObjectId;
  readonly payload: Buffer;
}

/**
 * Collects every object a commit reaches: its tree, that tree's subtrees, and
 * every blob or record in them.
 *
 * Subtrees are collected as well as leaves. A bundle missing an intermediate
 * tree imports commits whose trees cannot be read — valid-looking history that
 * fails only when someone tries to check it out.
 *
 * @param store - Object store holding the commits.
 * @param commits - Commits to close over.
 * @returns Every reachable object id, commits included.
 */
function closure(store: ObjectStore, commits: readonly ObjectId[]): Set<ObjectId> {
  const objects = new Set<ObjectId>();
  /** Add a tree and every descendant tree or leaf object without revisiting shared subtrees. */
  const walkTree = (treeIdentifier: ObjectId): void => {
    if (objects.has(treeIdentifier)) return;
    objects.add(treeIdentifier);
    for (const entry of readTree(store, treeIdentifier)) {
      if (entry.mode === "40000") walkTree(entry.id);
      else objects.add(entry.id);
    }
  };
  for (const commitId of commits) {
    objects.add(commitId);
    walkTree(readCommit(store, commitId).tree);
  }
  return objects;
}

/**
 * What {@link importBundleObjects} stored, before any ref is published.
 */
export interface ObjectImportReport {
  /** The bundle's validated header. */
  readonly header: BundleContents;
  /** Objects newly written to the store. */
  readonly added: readonly ObjectId[];
  /** Objects the store already had. */
  readonly skipped: readonly ObjectId[];
}

/**
 * Refuses an advertised ref whose history is not fully present.
 *
 * A bundle arrives from outside and its header is a claim, not a fact. It can name
 * a ref at a well-formed but absent object id while carrying no object lines and
 * declaring no prerequisites. Publishing that ref would leave a branch pointing at
 * nothing — and every later read reports that as a corrupt repository rather than
 * as a bad import, so the diagnosis lands arbitrarily far from the cause.
 *
 * The whole closure is checked, not only the commits: a bundle missing one blob
 * deep inside a tree is just as unusable, and finding out at checkout time is
 * finding out too late.
 *
 * @param store - Destination store, already holding whatever the bundle carried.
 * @param name - Ref name being advertised, for the message.
 * @param target - Commit the ref would be published at.
 * @throws ObjectStoreError When any object in the closure is absent.
 */
export function assertClosurePresent(store: ObjectStore, name: string, target: ObjectId): void {
  const seen = new Set<ObjectId>();
  const pending: ObjectId[] = [target];
  while (pending.length > 0) {
    const id = pending.pop() as ObjectId;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!store.has(id)) {
      throw new ObjectStoreError(
        "incomplete_bundle",
        `The bundle advertises ${name} at ${target}, but object ${id} in its history is neither carried nor already present.`,
      );
    }
    const object = store.read(id);
    if (object.type === "commit") {
      const commit = decodeCommit(object.payload);
      pending.push(commit.tree, ...commit.parents);
    } else if (object.type === "tree") {
      for (const entry of decodeTree(object.payload)) pending.push(entry.id);
    }
  }
}

/**
 * Exports refs and their history as a bundle file.
 *
 * @param store - Object store to read from.
 * @param refs - Ref store naming what to export.
 * @param refNames - Full ref names to include. Empty exports every branch and tag.
 * @param since - Commits the receiver already has; their history is excluded and
 *   recorded as a prerequisite instead, which is what keeps an incremental bundle
 *   small.
 * @returns The bundle's bytes.
 * @throws ObjectStoreError When a named ref does not exist.
 */
export function exportBundle(
  store: ObjectStore,
  refs: RefStore,
  refNames: readonly string[],
  since: readonly ObjectId[] = [],
): Buffer {
  const selected: Record<string, ObjectId> = {};
  const names = refNames.length > 0
    ? refNames
    : [...refs.list(BRANCH_PREFIX), ...refs.list(TAG_PREFIX)].map((entry) => entry.name);
  for (const name of names) {
    const target = refs.read(name);
    if (target === null) throw new ObjectStoreError("unknown_ref", `No ref named ${name} to export.`);
    selected[name] = target;
  }

  const excluded = new Set<ObjectId>();
  for (const boundary of since) {
    for (const id of reachable(store, boundary)) excluded.add(id);
  }
  const commits = new Set<ObjectId>();
  for (const target of Object.values(selected)) {
    for (const id of reachable(store, target)) {
      if (!excluded.has(id)) commits.add(id);
    }
  }

  const objects = [...closure(store, [...commits])].sort(compareByteOrder);
  const header: BundleContents = {
    refs: selected,
    prerequisites: [...since].sort(compareByteOrder),
    objects,
  };
  const lines = [BUNDLE_FORMAT, JSON.stringify(header)];
  for (const id of objects) {
    const object = store.read(id);
    // base64 rather than raw bytes so the whole bundle stays a text file that
    // survives being pasted, attached, or stored in a field that assumes UTF-8.
    lines.push(`${object.type} ${id} ${object.payload.toString("base64")}`);
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

/**
 * Parses a bundle without storing anything.
 *
 * @param bytes - The bundle's contents.
 * @returns Its header and its object lines.
 * @throws ObjectStoreError When the format marker, header, or any object line is
 *   malformed, or an object's bytes do not hash to the id it is filed under.
 */
export function parseBundle(bytes: Buffer): { header: BundleContents; lines: BundleLine[] } {
  const text = bytes.toString("utf8");
  const rawLines = text.split("\n").filter((line) => line.length > 0);
  if (rawLines[0] !== BUNDLE_FORMAT) {
    throw new ObjectStoreError("bad_bundle", `Bundle does not start with the ${BUNDLE_FORMAT} marker.`);
  }
  let header: BundleContents;
  try {
    header = JSON.parse(rawLines[1] ?? "") as BundleContents;
  } catch {
    throw new ObjectStoreError("bad_bundle", "Bundle header is not valid JSON.");
  }
  // A bundle is untrusted input, so the header is validated as a schema rather than
  // trusted as a type. `typeof null` is "object" and so is an array, so the obvious
  // shape check admitted `{"refs": null}` and `{"refs": []}` — which then failed
  // downstream as a TypeError from `Object.entries`, reported to the user as a crash
  // rather than as the malformed bundle it is.
  if (header === null || typeof header !== "object" || Array.isArray(header)) {
    throw new ObjectStoreError("bad_bundle", "Bundle header is not a JSON object.");
  }
  if (header.refs === null || typeof header.refs !== "object" || Array.isArray(header.refs)) {
    throw new ObjectStoreError("bad_bundle", "Bundle header does not describe any refs.");
  }
  for (const [name, target] of Object.entries(header.refs)) {
    if (typeof target !== "string" || !isObjectId(target)) {
      throw new ObjectStoreError("bad_bundle", `Bundle advertises ref ${name} at "${String(target)}", which is not an object id.`);
    }
  }
  if (header.prerequisites !== undefined) {
    if (!Array.isArray(header.prerequisites)) {
      throw new ObjectStoreError("bad_bundle", "Bundle prerequisites are not a list.");
    }
    for (const id of header.prerequisites) {
      if (typeof id !== "string" || !isObjectId(id)) {
        throw new ObjectStoreError("bad_bundle", `Bundle declares prerequisite "${String(id)}", which is not an object id.`);
      }
    }
  }
  const lines: BundleLine[] = [];
  for (const raw of rawLines.slice(2)) {
    const parts = raw.split(" ");
    if (parts.length !== 3) {
      throw new ObjectStoreError("bad_bundle", `Bundle object line "${raw.slice(0, 40)}" is not three fields.`);
    }
    const [type, id, encoded] = parts;
    if (!(OBJECT_TYPES as readonly string[]).includes(type)) {
      throw new ObjectStoreError("bad_bundle", `Bundle declares unknown object type "${type}".`);
    }
    if (!isObjectId(id)) {
      throw new ObjectStoreError("bad_bundle", `Bundle declares "${id}" as an object id.`);
    }
    const payload = Buffer.from(encoded, "base64");
    const actual = hashObject(type as ObjectType, payload);
    if (actual !== id) {
      throw new ObjectStoreError(
        "bad_bundle",
        `Bundle files an object under ${id} whose content hashes to ${actual}.`,
      );
    }
    lines.push({ type: type as ObjectType, id, payload });
  }
  return { header, lines };
}

/**
 * Stores a bundle's objects without publishing any of the refs it advertises.
 *
 * Fetch needs exactly this half. A bundle names the refs as the *sender* knows
 * them, so importing one wholesale into a repository that already has a branch of
 * the same name moves that branch onto the sender's tip — discarding whatever the
 * receiving agent committed there, which is the single loss this package exists to
 * prevent. A fetch therefore takes the objects here and publishes them under
 * `refs/remotes/` itself.
 *
 * Prerequisites are checked before anything is written, so a bundle that depends
 * on history the receiver does not have fails whole rather than leaving commits
 * whose parents are missing.
 *
 * @param store - Destination object store.
 * @param bytes - The bundle's contents.
 * @returns The validated header, and which objects were written versus already held.
 * @throws ObjectStoreError When a prerequisite commit is absent, or the bundle is
 *   malformed.
 */
export function importBundleObjects(store: ObjectStore, bytes: Buffer): ObjectImportReport {
  const { header, lines } = parseBundle(bytes);
  const carried = new Set(lines.map((line) => line.id));
  const missing = (header.prerequisites ?? []).filter((id) => !carried.has(id) && !store.has(id));
  if (missing.length > 0) {
    throw new ObjectStoreError(
      "missing_prerequisites",
      `The bundle needs commits this repository does not have: ${missing.join(", ")}. `
      + "Import the bundle that carries them first.",
    );
  }
  const added: ObjectId[] = [];
  const skipped: ObjectId[] = [];
  for (const line of lines) {
    if (store.has(line.id)) {
      skipped.push(line.id);
      continue;
    }
    store.write(line.type, line.payload);
    added.push(line.id);
  }
  return { header, added, skipped };
}

/**
 * Imports a bundle into a repository, publishing the refs it advertises.
 *
 * @param store - Destination object store.
 * @param refs - Destination ref store.
 * @param bytes - The bundle's contents.
 * @returns What was added, what was already present, and the refs advertised.
 * @throws ObjectStoreError When a prerequisite commit is absent, the bundle is
 *   malformed, or an advertised ref's history is incomplete.
 */
export function importBundle(store: ObjectStore, refs: RefStore, bytes: Buffer): ImportReport {
  const { header, added, skipped } = importBundleObjects(store, bytes);
  for (const [name, target] of Object.entries(header.refs)) assertClosurePresent(store, name, target);
  // One transaction, not a loop of independent swaps: a bundle advertising three
  // refs must not be able to publish two and fail on the third, which would leave
  // the repository advertising a history it did not fully receive.
  refs.transaction(Object.entries(header.refs).map(([name, target]) => ({
    name,
    expected: refs.read(name),
    next: target,
  })));
  return { added, skipped, refs: header.refs };
}


/**
 * Reads a bundle from disk.
 *
 * @param path - Source file.
 * @returns The bundle's contents.
 * @throws ObjectStoreError When the file cannot be read.
 */
export function readBundle(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new ObjectStoreError("bundle_not_found", `Could not read a bundle at ${path}.`);
  }
}
