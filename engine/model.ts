// Serialization for the three composite object kinds.
//
// Every encoder here is canonical: one logical value has exactly one byte
// representation. That is a correctness requirement, not tidiness — the object
// id is the hash of these bytes, so a tree that sorted its entries differently
// on two machines would produce two ids for one tree, and every identity check
// the system makes (has this already been imported, is this a fast-forward, do
// these two branches share a subtree) would quietly stop working.

import {
  hashObject,
  isObjectId,
  type ObjectId,
  ObjectStoreError,
  type ObjectStore,
} from "./objects.ts";

/** File modes a tree entry can carry. */
export const FILE_MODES = ["100644", "100755", "40000"] as const;

/** A tree entry's mode: regular file, executable file, or subtree. */
export type FileMode = (typeof FILE_MODES)[number];

/** One name-to-object binding inside a tree. */
export interface TreeEntry {
  /** Entry name. A single path segment: never empty, never containing `/`. */
  readonly name: string;
  /** Whether the entry is a file, an executable file, or a subtree. */
  readonly mode: FileMode;
  /** The object this name binds to. */
  readonly id: ObjectId;
}

/** Who made a change and when. */
export interface Signature {
  /** Display name. */
  readonly name: string;
  /** Email address. */
  readonly email: string;
  /** Milliseconds since the Unix epoch. */
  readonly timestamp: number;
  /**
   * Minutes east of UTC at the time of writing.
   *
   * Stored alongside the absolute timestamp rather than folded into it, so a
   * commit can be rendered in the zone it was made in without that zone ever
   * affecting the ordering or the id.
   */
  readonly timezoneOffsetMinutes: number;
}

/** A commit: a tree, its ancestry, and who recorded it. */
export interface Commit {
  /** Root tree of the snapshot this commit names. */
  readonly tree: ObjectId;
  /**
   * Stable identity of the *change* this commit records, independent of the
   * commit's own id.
   *
   * A change survives being described, rebased and squashed: each of those
   * produces a new commit with a new id, but every one of them points back at
   * the same change so `pm vcs log` can speak of one thing across a rewrite.
   * A freshly created commit adopts the id it would hash to with no change line
   * (see {@link identityWithoutChangeLine}); a rewritten commit inherits the
   * effective change id of its predecessor. Absent on commits written before
   * change ids existed, which {@link effectiveChangeId} treats as their own id.
   */
  readonly changeId?: ObjectId;
  /**
   * Parent commits, oldest lineage first.
   *
   * Empty for a root commit, one for an ordinary commit, two or more for a
   * merge. The first parent is the branch that was checked out when the merge
   * ran, which is what makes first-parent history meaningful.
   */
  readonly parents: readonly ObjectId[];
  readonly author: Signature;
  readonly committer: Signature;
  /** Commit message, verbatim including any trailing newline. */
  readonly message: string;
}

/** A field value a record can hold. */
export type RecordValue = string | number | boolean | null | readonly RecordValue[];

/** A structured document stored as named fields. */
export interface RecordDocument {
  readonly [field: string]: RecordValue;
}

/**
 * Compares two names in UTF-8 byte order.
 *
 * This is the ordering the whole system sorts by, and it is deliberately not
 * `<`/`>` on the strings. JavaScript compares strings by UTF-16 code unit, which
 * disagrees with byte order for anything outside the Basic Multilingual Plane —
 * so a tree encoded here and a ref listing sorted with `<` would order the same
 * two names differently the moment one contains an emoji. It is also not
 * `localeCompare`, which is locale-sensitive and would let one tree hash
 * differently under two `LANG` settings.
 *
 * Being total — returning 0 for equal names rather than an arbitrary side — is
 * what makes it safe to sort a collection that may legitimately contain two
 * equal keys, and what keeps every call site free of a tie-breaking branch.
 *
 * @param left - First name.
 * @param right - Second name.
 * @returns Negative, zero or positive as `left` sorts before, with, or after `right`.
 */
export function compareByteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Encodes a tree.
 *
 * Entries are sorted by name in byte order via {@link compareByteOrder}, for the
 * reasons given there: the object id is the hash of these bytes, so an ordering
 * that varied with locale or with a name's plane would vary the id.
 *
 * @param entries - The tree's entries in any order.
 * @returns Canonical tree bytes.
 * @throws ObjectStoreError When a name is empty, contains `/` or NUL, or is
 *   duplicated — each of which would make the encoding ambiguous or the tree
 *   unrepresentable as a directory.
 */
export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.name.length === 0) {
      throw new ObjectStoreError("invalid_tree_entry", "A tree entry name cannot be empty.");
    }
    if (entry.name.includes("/") || entry.name.includes("\0")) {
      throw new ObjectStoreError("invalid_tree_entry", `Tree entry name "${entry.name}" contains a path separator or NUL.`);
    }
    if (seen.has(entry.name)) {
      throw new ObjectStoreError("invalid_tree_entry", `Tree entry name "${entry.name}" appears more than once.`);
    }
    seen.add(entry.name);
  }
  const sorted = [...entries].sort((left, right) => compareByteOrder(left.name, right.name));
  return Buffer.concat(sorted.map((entry) => Buffer.concat([
    Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"),
    Buffer.from(entry.id, "utf8"),
  ])));
}

/**
 * Decodes tree bytes back into entries.
 *
 * @param payload - Canonical tree bytes.
 * @returns The entries, in the stored (name-sorted) order.
 * @throws ObjectStoreError When the bytes are truncated, an entry declares an
 *   unknown mode, an entry name is not a usable single path segment or is
 *   duplicated, or an entry's id is not an object id.
 */
export function decodeTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let cursor = 0;
  while (cursor < payload.length) {
    const separator = payload.indexOf(0, cursor);
    if (separator === -1) {
      throw new ObjectStoreError("malformed_object", "Tree entry is missing the NUL before its object id.");
    }
    const header = payload.subarray(cursor, separator).toString("utf8");
    const space = header.indexOf(" ");
    if (space === -1) {
      throw new ObjectStoreError("malformed_object", `Tree entry header "${header}" has no mode.`);
    }
    const mode = header.slice(0, space);
    if (!(FILE_MODES as readonly string[]).includes(mode)) {
      throw new ObjectStoreError("malformed_object", `Tree entry declares unknown mode "${mode}".`);
    }
    const idStart = separator + 1;
    const idEnd = idStart + 64;
    if (idEnd > payload.length) {
      throw new ObjectStoreError("malformed_object", "Tree entry is truncated before its full object id.");
    }
    const name = header.slice(space + 1);
    // The encoder refuses these names; the decoder has to as well, because a tree
    // read back from a bundle never went through this build's encoder. An entry
    // named "" or ".." or carrying a separator is not representable as a directory
    // entry, and materializing it would write outside the path it claims to be.
    if (name.length === 0 || name.includes("/") || name === "." || name === "..") {
      throw new ObjectStoreError("malformed_object", `Tree entry name "${name}" is not a single usable path segment.`);
    }
    const id = payload.subarray(idStart, idEnd).toString("utf8");
    if (!isObjectId(id)) {
      throw new ObjectStoreError("malformed_object", `Tree entry "${name}" names "${id}", which is not an object id.`);
    }
    if (entries.some((entry) => entry.name === name)) {
      throw new ObjectStoreError("malformed_object", `Tree entry name "${name}" appears more than once.`);
    }
    entries.push({ name, mode: mode as FileMode, id });
    cursor = idEnd;
  }
  return entries;
}

/**
 * Renders a signature as one line.
 *
 * @param signature - The signature to render.
 * @returns `Name <email> <epochMs> <tzMinutes>`.
 * @throws ObjectStoreError When the name or email carries a line separator, the
 *   email carries an angle bracket, or either number is not a safe integer — each
 *   of which would produce a commit that cannot be decoded back to this signature.
 */
function encodeSignature(signature: Signature): string {
  // A commit's header block is line-oriented and this line sits inside it, so a
  // name or email carrying a line separator would inject further headers into the
  // commit — and a `\n\n` would terminate the header block early, moving the rest
  // of the identity into the message. Angle brackets in the email would make the
  // decoder's `<...>` capture ambiguous. Neither is representable, so neither is
  // accepted.
  for (const [field, value] of [["name", signature.name], ["email", signature.email]] as const) {
    if (/[\r\n]/.test(value)) {
      throw new ObjectStoreError("invalid_signature", `A signature ${field} cannot contain a line separator.`);
    }
  }
  if (/[<>]/.test(signature.email)) {
    throw new ObjectStoreError("invalid_signature", "A signature email cannot contain an angle bracket.");
  }
  // The decoder reads these back with a decimal-integer pattern, so anything the
  // pattern cannot express — a fraction, NaN, an infinity, a value past 2^53 — would
  // encode into a commit that no longer decodes, or decodes to a different number.
  for (const [field, value] of [
    ["timestamp", signature.timestamp],
    ["timezone offset", signature.timezoneOffsetMinutes],
  ] as const) {
    if (!Number.isSafeInteger(value)) {
      throw new ObjectStoreError("invalid_signature", `A signature ${field} must be a safe integer, not ${value}.`);
    }
  }
  return `${signature.name} <${signature.email}> ${signature.timestamp} ${signature.timezoneOffsetMinutes}`;
}

/**
 * Parses a signature line.
 *
 * Parsed from the right, because a display name may contain spaces and angle
 * brackets while the three trailing fields never do.
 *
 * @param line - The line following the `author ` or `committer ` keyword.
 * @returns The parsed signature.
 * @throws ObjectStoreError When the line does not carry all four fields.
 */
function decodeSignature(line: string): Signature {
  const match = /^(.*) <([^<>]*)> (-?\d+) (-?\d+)$/.exec(line);
  if (!match) {
    throw new ObjectStoreError("malformed_object", `Commit signature "${line}" is not well-formed.`);
  }
  return {
    name: match[1],
    email: match[2],
    timestamp: Number(match[3]),
    timezoneOffsetMinutes: Number(match[4]),
  };
}

/**
 * Encodes a commit.
 *
 * The change line, when present, is written immediately after the `tree` line
 * and before any parents. Position is fixed rather than left to insertion order
 * so a commit decoded and re-encoded hashes to the same id, which is what every
 * identity check in the system relies on.
 *
 * @param commit - The commit to encode.
 * @returns Canonical commit bytes: headers, a blank line, then the message.
 */
export function encodeCommit(commit: Commit): Buffer {
  const lines = [`tree ${commit.tree}`];
  if (commit.changeId !== undefined) lines.push(`change ${commit.changeId}`);
  lines.push(
    ...commit.parents.map((parent) => `parent ${parent}`),
    `author ${encodeSignature(commit.author)}`,
    `committer ${encodeSignature(commit.committer)}`,
  );
  return Buffer.from(`${lines.join("\n")}\n\n${commit.message}`, "utf8");
}

/**
 * The id a commit would hash to if it carried no change line.
 *
 * A freshly created commit adopts this value as its change id. It is derived
 * from the content the commit describes — its tree, parents, author, committer
 * and message — none of which a rebase or squash alters in a way that should
 * change *which change* this is, so the value is stable across a rewrite even
 * though the commit's own id is not. The five fields are picked explicitly so a
 * stray `changeId` on the input can never feed the hash and break the
 * determinism the property depends on.
 *
 * @param commit - The commit's canonical fields, without its change id.
 * @returns The id the commit would be stored under with no change line.
 */
export function identityWithoutChangeLine(
  commit: Pick<Commit, "tree" | "parents" | "author" | "committer" | "message">,
): ObjectId {
  return hashObject("commit", encodeCommit({
    tree: commit.tree,
    parents: commit.parents,
    author: commit.author,
    committer: commit.committer,
    message: commit.message,
  }));
}

/**
 * The change identity a commit should be known by.
 *
 * A commit that carries a change id is known by it; a commit written before
 * change ids existed carries none, and is its own change — the only honest
 * answer, since nothing else names it. Centralising the fallback keeps every
 * caller (log output, descendant replay, conflict reporting) agreeing on one
 * identity for one commit.
 *
 * @param commitId - The commit's own id.
 * @param commit - The parsed commit.
 * @returns The commit's change id when it has one, otherwise its own id.
 */
export function effectiveChangeId(commitId: ObjectId, commit: Commit): ObjectId {
  return commit.changeId ?? commitId;
}

/**
 * Decodes commit bytes.
 *
 * @param payload - Canonical commit bytes.
 * @returns The parsed commit.
 * @throws ObjectStoreError When a required header is absent, unrecognised or
 *   repeated, an id is malformed, or the header block is not terminated by a blank
 *   line.
 */
export function decodeCommit(payload: Buffer): Commit {
  const text = payload.toString("utf8");
  const blankLine = text.indexOf("\n\n");
  if (blankLine === -1) {
    throw new ObjectStoreError("malformed_object", "Commit has no blank line separating headers from message.");
  }
  let tree: ObjectId | undefined;
  let changeId: ObjectId | undefined;
  const parents: ObjectId[] = [];
  let author: Signature | undefined;
  let committer: Signature | undefined;
  for (const line of text.slice(0, blankLine).split("\n")) {
    const space = line.indexOf(" ");
    const keyword = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    // Each singleton header may appear once. A second one would make the commit's
    // meaning depend on which occurrence a parser happened to keep — and two
    // parsers keeping different ones is how one commit becomes two truths.
    if (keyword === "tree") {
      if (tree !== undefined) {
        throw new ObjectStoreError("malformed_object", "Commit carries more than one tree header.");
      }
      if (!isObjectId(value)) {
        throw new ObjectStoreError("malformed_object", `Commit names tree "${value}", which is not an object id.`);
      }
      tree = value;
    } else if (keyword === "change") {
      if (changeId !== undefined) {
        throw new ObjectStoreError("malformed_object", "Commit carries more than one change header.");
      }
      if (!isObjectId(value)) {
        throw new ObjectStoreError("malformed_object", `Commit names change "${value}", which is not an object id.`);
      }
      changeId = value;
    } else if (keyword === "parent") {
      if (!isObjectId(value)) {
        throw new ObjectStoreError("malformed_object", `Commit names parent "${value}", which is not an object id.`);
      }
      parents.push(value);
    } else if (keyword === "author") {
      if (author !== undefined) {
        throw new ObjectStoreError("malformed_object", "Commit carries more than one author header.");
      }
      author = decodeSignature(value);
    } else if (keyword === "committer") {
      if (committer !== undefined) {
        throw new ObjectStoreError("malformed_object", "Commit carries more than one committer header.");
      }
      committer = decodeSignature(value);
    } else {
      throw new ObjectStoreError("malformed_object", `Commit carries unknown header "${keyword}".`);
    }
  }
  if (!tree || !author || !committer) {
    throw new ObjectStoreError("malformed_object", "Commit is missing its tree, author or committer header.");
  }
  // The change id is optional: a commit written before change ids existed has
  // none, and is its own change. Assembling the object with it only when present
  // is what keeps the encoder's `changeId !== undefined` check honest on a
  // round-trip.
  return changeId === undefined
    ? { tree, parents, author, committer, message: text.slice(blankLine + 2) }
    : { tree, changeId, parents, author, committer, message: text.slice(blankLine + 2) };
}

/**
 * Encodes a record as canonical JSON.
 *
 * Keys are sorted and no whitespace is emitted, so two agents that built the
 * same document by different routes produce the same id. Arrays keep their
 * order: for an append-only sequence the order is the data, and for a set the
 * merge normalises order rather than the encoder, which keeps the encoding a
 * faithful record of what was written.
 *
 * @param document - The record's fields.
 * @returns Canonical record bytes.
 */
export function encodeRecord(document: RecordDocument): Buffer {
  const fields = Object.keys(document).sort(compareByteOrder);
  const body = fields.map((field) => `${JSON.stringify(field)}:${JSON.stringify(document[field])}`);
  return Buffer.from(`{${body.join(",")}}`, "utf8");
}

/**
 * Decodes record bytes.
 *
 * @param payload - Canonical record bytes.
 * @returns The record's fields.
 * @throws ObjectStoreError When the bytes are not a JSON object, or a field holds a
 *   value outside {@link RecordValue} — a nested object, or a non-finite number.
 */
export function decodeRecord(payload: Buffer): RecordDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new ObjectStoreError("malformed_object", "Record payload is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ObjectStoreError("malformed_object", "Record payload is not a JSON object.");
  }
  // `RecordValue` admits scalars, null and arrays of those. Casting past that let a
  // tampered bundle put a nested object or a non-finite number into a document whose
  // type says neither can occur, and the first thing to notice would be the record
  // merge, arbitrarily later and with no way to attribute it.
  const assertValue = (value: unknown, path: string): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new ObjectStoreError("malformed_object", `Record field ${path} holds a non-finite number.`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((member, index) => assertValue(member, `${path}[${index}]`));
      return;
    }
    throw new ObjectStoreError("malformed_object", `Record field ${path} holds a value a record cannot carry.`);
  };
  for (const [field, value] of Object.entries(parsed)) assertValue(value, field);
  return parsed as RecordDocument;
}

/**
 * Writes a tree and returns its id.
 *
 * @param store - Destination object store.
 * @param entries - The tree's entries.
 * @returns The stored tree's id.
 */
export function writeTree(store: ObjectStore, entries: readonly TreeEntry[]): ObjectId {
  return store.write("tree", encodeTree(entries));
}

/**
 * Reads a tree.
 *
 * @param store - Source object store.
 * @param id - The tree's id.
 * @returns The tree's entries.
 * @throws ObjectStoreError When the object is absent, corrupt, or not a tree.
 */
export function readTree(store: ObjectStore, id: ObjectId): TreeEntry[] {
  return decodeTree(store.readTyped(id, "tree"));
}

/**
 * Writes a commit and returns its id.
 *
 * @param store - Destination object store.
 * @param commit - The commit to write.
 * @returns The stored commit's id.
 */
export function writeCommit(store: ObjectStore, commit: Commit): ObjectId {
  return store.write("commit", encodeCommit(commit));
}

/**
 * Reads a commit.
 *
 * @param store - Source object store.
 * @param id - The commit's id.
 * @returns The parsed commit.
 * @throws ObjectStoreError When the object is absent, corrupt, or not a commit.
 */
export function readCommit(store: ObjectStore, id: ObjectId): Commit {
  return decodeCommit(store.readTyped(id, "commit"));
}

/**
 * Computes the id a tree would have without writing it.
 *
 * @param entries - The tree's entries.
 * @returns The id the tree would be stored under.
 */
export function treeId(entries: readonly TreeEntry[]): ObjectId {
  return hashObject("tree", encodeTree(entries));
}
