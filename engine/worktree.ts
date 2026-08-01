// The index, the working tree, and the difference between them.
//
// Paths are held in one canonical form throughout: slash-separated, relative to
// the repository root, never starting with `./` and never containing `..`. Every
// path that enters from outside goes through `normalizeRepoPath`, which is the
// single place that can refuse one — a path that escapes the repository root must
// never reach a filesystem call, and one boundary is easier to keep correct than
// a check at each call site.

import {
  type BigIntStats,
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { type IgnoreRules, isIgnored, isPrunableDirectory } from "./ignore.ts";
import { compareByteOrder, type FileMode, type TreeEntry, readTree, writeTree } from "./model.ts";
import { hashObject, isObjectId, type ObjectId, type ObjectStore, ObjectStoreError } from "./objects.ts";

const INDEX_HEADER = "pm-vcs-index 2";
const RACY_WINDOW_NS = 2_000_000_000n;

/** Whether a stored path is already in the canonical repository-relative form. */
function isCanonicalRepoPath(path: string): boolean {
  return path.length > 0
    && !path.startsWith("/")
    && !path.includes("\\")
    && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Filesystem identity recorded with an index entry to avoid re-reading unchanged content. */
export interface IndexStat {
  /** File size in bytes. */
  readonly size: bigint;
  /** Last-content-modification timestamp at the filesystem's native precision. */
  readonly mtimeNs: bigint;
  /** Metadata-change timestamp, which catches same-size writes whose mtime is restored. */
  readonly ctimeNs: bigint;
  /** Device identity, so replacing a mount cannot reuse another file's cache entry. */
  readonly dev: bigint;
  /** Inode identity, so an atomic same-metadata replacement is still re-read. */
  readonly ino: bigint;
  /** Wall-clock observation time used to age the cache beyond a coarse timestamp tick. */
  readonly observedAtNs: bigint;
}

/** One staged path: what content and mode the next commit should record for it. */
export interface IndexEntry {
  /** Canonical repository-relative path. */
  readonly path: string;
  /** Blob holding the staged content. */
  readonly id: ObjectId;
  /** Whether the staged file is executable. */
  readonly mode: Extract<FileMode, "100644" | "100755">;
  /** Filesystem identity observed while the staged content was read. */
  readonly stat?: IndexStat;
}

/** How a path differs across HEAD, the index and the working tree. */
export type ChangeKind = "added" | "modified" | "deleted";

/** One difference between two of the three states. */
export interface Change {
  readonly path: string;
  readonly kind: ChangeKind;
}

/** The full picture of what is staged, what is not, and what is untracked. */
export interface StatusReport {
  /** Differences between HEAD and the index. */
  readonly staged: readonly Change[];
  /** Differences between the index and the working tree. */
  readonly unstaged: readonly Change[];
  /** Paths in the working tree that the index does not carry. */
  readonly untracked: readonly string[];
  /** True when all three states agree. */
  readonly clean: boolean;
}

/**
 * Converts any incoming path to the canonical repository-relative form.
 *
 * @param root - Absolute repository root.
 * @param candidate - A path, absolute or relative to the root.
 * @returns The canonical slash-separated repository-relative path.
 * @throws ObjectStoreError When the path resolves outside the repository, or is
 *   the root itself.
 */
export function normalizeRepoPath(root: string, candidate: string): string {
  const portableCandidate = candidate.split(sep).join("/");
  if (portableCandidate.includes("\\")) {
    throw new ObjectStoreError(
      "path_outside_repo",
      `"${candidate}" contains a backslash, which is not portable in canonical slash-separated paths.`,
    );
  }
  const absolute = resolve(root, candidate);
  const rooted = relative(root, absolute);
  if (rooted.length === 0) {
    throw new ObjectStoreError("path_outside_repo", `"${candidate}" is the repository root, not a path inside it.`);
  }
  if (rooted === ".." || rooted.startsWith(`..${sep}`)) {
    throw new ObjectStoreError("path_outside_repo", `"${candidate}" resolves outside the repository.`);
  }
  return rooted.split(sep).join("/");
}

/**
 * Serializes the index.
 *
 * A version header is followed by one JSON tuple per entry, sorted by path, so
 * the file is diffable and its bytes are a function of its content alone. JSON
 * preserves paths containing spaces without making the stat fields ambiguous.
 *
 * @param entries - The staged entries in any order.
 * @returns The index file's contents.
 */
export function encodeIndex(entries: readonly IndexEntry[]): string {
  const lines = [...entries]
    .sort((left, right) => compareByteOrder(left.path, right.path))
    .map((entry) => {
      if (!isCanonicalRepoPath(entry.path)) {
        throw new ObjectStoreError("corrupt_index", `Index path "${entry.path}" is not canonical.`);
      }
      return JSON.stringify([
        entry.mode,
        entry.id,
        entry.path,
        entry.stat === undefined
          ? null
          : [
              entry.stat.size.toString(),
              entry.stat.mtimeNs.toString(),
              entry.stat.ctimeNs.toString(),
              entry.stat.dev.toString(),
              entry.stat.ino.toString(),
              entry.stat.observedAtNs.toString(),
            ],
      ]);
    });
  return [INDEX_HEADER, ...lines].join("\n");
}

/**
 * Parses the index.
 *
 * @param contents - The index file's contents, or the empty string.
 * Legacy three-field lines remain readable and acquire cache metadata on their
 * next stage. A newer version is refused rather than guessed at.
 *
 * @returns The staged entries.
 * @throws ObjectStoreError When a line is malformed or the version is newer
 *   than this build supports.
 */
export function decodeIndex(contents: string): IndexEntry[] {
  if (contents.length === 0) return [];
  const lines = contents.split("\n");
  if (lines[0]?.startsWith("pm-vcs-index ")) {
    if (lines[0] !== INDEX_HEADER) {
      throw new ObjectStoreError(
        "unsupported_index_version",
        `Index version ${lines[0].slice("pm-vcs-index ".length)} is newer than the supported version 2.`,
      );
    }
    const entries: IndexEntry[] = [];
    for (const line of lines.slice(1)) {
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new ObjectStoreError("corrupt_index", `Index line "${line}" is not valid JSON.`);
      }
      if (!Array.isArray(value) || value.length !== 4) {
        throw new ObjectStoreError("corrupt_index", `Index line "${line}" does not contain four fields.`);
      }
      const [mode, id, path, encodedStat] = value;
      if ((mode !== "100644" && mode !== "100755") || typeof id !== "string" || !isObjectId(id)
        || typeof path !== "string" || !isCanonicalRepoPath(path)) {
        throw new ObjectStoreError("corrupt_index", `Index line "${line}" has an invalid mode, object id, or path.`);
      }
      if (encodedStat === null) {
        entries.push({ mode, id, path });
        continue;
      }
      const statPatterns = [/^\d+$/, /^-?\d+$/, /^-?\d+$/, /^\d+$/, /^\d+$/, /^\d+$/] as const;
      if (!Array.isArray(encodedStat) || encodedStat.length !== 6
        || !encodedStat.every((field, position) => typeof field === "string"
          && statPatterns[position]?.test(field) === true)) {
        throw new ObjectStoreError("corrupt_index", `Index line "${line}" has invalid cached file metadata.`);
      }
      entries.push({
        mode,
        id,
        path,
        stat: {
          size: BigInt(encodedStat[0]),
          mtimeNs: BigInt(encodedStat[1]),
          ctimeNs: BigInt(encodedStat[2]),
          dev: BigInt(encodedStat[3]),
          ino: BigInt(encodedStat[4]),
          observedAtNs: BigInt(encodedStat[5]),
        },
      });
    }
    return entries;
  }
  const entries: IndexEntry[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = /^(100644|100755) ([0-9a-f]{64}) (.+)$/.exec(line);
    if (!match) {
      throw new ObjectStoreError("corrupt_index", `Index line "${line}" is not well-formed.`);
    }
    if (!isCanonicalRepoPath(match[3])) {
      throw new ObjectStoreError("corrupt_index", `Index line "${line}" has a non-canonical path.`);
    }
    entries.push({ mode: match[1] as IndexEntry["mode"], id: match[2], path: match[3] });
  }
  return entries;
}

/**
 * Lists every file in the working tree, excluding the control directory.
 *
 * Symlinks are reported by the path they occupy rather than followed. Following
 * them would let a link into a parent directory pull arbitrary host files into a
 * commit, and would make a link cycle an infinite walk.
 *
 * @param root - Absolute repository root.
 * @param controlDirectory - Name of the control directory to skip.
 * @param rules - Ignore rules excluding further paths.
 * @returns Canonical repository-relative paths, sorted.
 */
export function listWorkingTree(root: string, controlDirectory: string, rules: IgnoreRules): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === controlDirectory) continue;
      // Pruning happens on the directory name, before descending: walking
      // node_modules only to discard every path it yields is the difference
      // between an instant status and a multi-second one.
      if (entry.isDirectory() && isPrunableDirectory(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const path = relative(root, absolute).split(sep).join("/");
      if (!isCanonicalRepoPath(path)) {
        throw new ObjectStoreError(
          "path_outside_repo",
          `Working-tree path "${path}" cannot be represented as a canonical slash-separated path.`,
        );
      }
      if (!isIgnored(path, rules)) found.push(path);
    }
  };
  walk(root);
  return found.sort(compareByteOrder);
}

/**
 * Reads a working-tree path as the bytes a blob would hold.
 *
 * A symlink contributes its target text rather than the linked file's content,
 * which is what makes it representable without following it.
 *
 * @param root - Absolute repository root.
 * @param path - Canonical repository-relative path.
 * @returns The content, executable state, and stable stat observation when the
 *   file did not change during the read.
 */
export function readWorkingFile(
  root: string,
  path: string,
  now: () => bigint = () => BigInt(Date.now()) * 1_000_000n,
): { readonly content: Buffer; readonly executable: boolean; readonly stat?: IndexStat } {
  const absolute = join(root, ...path.split("/"));
  const before = readWorkingStat(root, path, now);
  const content = before.symbolicLink
    ? Buffer.from(readlinkSync(absolute), "utf8")
    : readFileSync(absolute);
  const after = readWorkingStat(root, path, now);
  // The owner-execute bit alone decides, so a file's mode does not change with
  // the umask of whichever agent happened to create it.
  return {
    content,
    executable: after.executable,
    ...(sameFileIdentity(before.stat, after.stat) ? { stat: after.stat } : {}),
  };
}

/** Filesystem identity and executable state for a working-tree path, without reading its content. */
export function readWorkingStat(
  root: string,
  path: string,
  now: () => bigint = () => BigInt(Date.now()) * 1_000_000n,
): { readonly stat: IndexStat; readonly executable: boolean; readonly symbolicLink: boolean } {
  const stats: BigIntStats = lstatSync(join(root, ...path.split("/")), { bigint: true, throwIfNoEntry: true });
  const symbolicLink = stats.isSymbolicLink();
  return {
    stat: {
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
      dev: stats.dev,
      ino: stats.ino,
      observedAtNs: now(),
    },
    executable: !symbolicLink && (stats.mode & 0o100n) !== 0n,
    symbolicLink,
  };
}

/**
 * Whether two cache observations identify the same non-racy filesystem state.
 *
 * An observation made less than one timestamp tick after mtime or ctime is
 * deliberately never trusted. On a coarse filesystem, another same-size write
 * in that tick can preserve every visible stat field; re-reading is the only
 * lossless answer. A later stage refreshes the entry after the tick and makes
 * subsequent status calls metadata-only.
 *
 * @param left - Metadata stored in the index.
 * @param right - Current working-tree metadata.
 * @returns True only when content hashing can safely be skipped.
 */
/** Whether two observations carry the same filesystem identity fields. */
function sameFileIdentity(left: IndexStat, right: IndexStat): boolean {
  return left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.dev === right.dev
    && left.ino === right.ino;
}

export function sameIndexStat(left: IndexStat | undefined, right: IndexStat): boolean {
  return left !== undefined
    && left.observedAtNs - (left.ctimeNs > left.mtimeNs ? left.ctimeNs : left.mtimeNs) >= RACY_WINDOW_NS
    && right.observedAtNs >= left.observedAtNs
    && right.observedAtNs - left.observedAtNs >= RACY_WINDOW_NS
    && sameFileIdentity(left, right);
}

/**
 * Flattens a tree, recursively, into path-to-entry pairs.
 *
 * @param store - Object store holding the trees.
 * @param treeIdentifier - Root tree to walk, or null for an empty tree.
 * @param prefix - Path prefix accumulated so far.
 * @returns Every file path in the tree with its blob id and mode.
 */
export function flattenTree(
  store: ObjectStore,
  treeIdentifier: ObjectId | null,
  prefix = "",
): Map<string, { id: ObjectId; mode: FileMode }> {
  const flat = new Map<string, { id: ObjectId; mode: FileMode }>();
  if (treeIdentifier === null) return flat;
  for (const entry of readTree(store, treeIdentifier)) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === "40000") {
      for (const [nested, value] of flattenTree(store, entry.id, path)) flat.set(nested, value);
      continue;
    }
    flat.set(path, { id: entry.id, mode: entry.mode });
  }
  return flat;
}

/**
 * Builds the nested trees a flat path map implies and returns the root tree id.
 *
 * @param store - Destination object store.
 * @param files - Path-to-blob map using canonical paths.
 * @returns The root tree's id.
 */
export function buildTree(
  store: ObjectStore,
  files: ReadonlyMap<string, { id: ObjectId; mode: FileMode }>,
): ObjectId {
  // Group by first segment: names with no further segment become file entries,
  // the rest recurse into a subtree built from their remaining path.
  const directChildren = new Map<string, { id: ObjectId; mode: FileMode }>();
  const subdirectories = new Map<string, Map<string, { id: ObjectId; mode: FileMode }>>();
  for (const [path, value] of files) {
    const slash = path.indexOf("/");
    if (slash === -1) {
      directChildren.set(path, value);
      continue;
    }
    const head = path.slice(0, slash);
    const rest = path.slice(slash + 1);
    const nested = subdirectories.get(head) ?? new Map();
    nested.set(rest, value);
    subdirectories.set(head, nested);
  }
  const entries: TreeEntry[] = [
    ...[...directChildren].map(([name, value]) => ({ name, mode: value.mode, id: value.id })),
    ...[...subdirectories].map(([name, nested]) => ({
      name,
      mode: "40000" as FileMode,
      id: buildTree(store, nested),
    })),
  ];
  return writeTree(store, entries);
}

/**
 * Writes a tree's content onto disk and removes anything it does not carry.
 *
 * Removal is what makes switching branches correct rather than additive: a file
 * that exists only on the branch being left has to disappear, or the working tree
 * silently accumulates every file every branch ever had.
 *
 * @param store - Object store holding the tree and its blobs.
 * @param root - Absolute repository root.
 * @param treeIdentifier - Tree to materialize, or null for an empty tree.
 * @param controlDirectory - Control directory name, never touched.
 * @param rules - Ignore rules. A tree entry matching one is skipped rather than
 *   written, so a commit that recorded an ignored path before the rules existed
 *   still cannot overwrite it.
 * @returns The index entries describing what was written.
 */
export function materializeTree(
  store: ObjectStore,
  root: string,
  treeIdentifier: ObjectId | null,
  controlDirectory: string,
  rules: IgnoreRules,
): IndexEntry[] {
  const target = new Map(
    [...flattenTree(store, treeIdentifier)].filter(([path]) => !isIgnored(path, rules)),
  );
  for (const existing of listWorkingTree(root, controlDirectory, rules)) {
    if (!target.has(existing)) rmSync(join(root, ...existing.split("/")), { force: true });
  }
  const entries: IndexEntry[] = [];
  for (const [path, value] of target) {
    const absolute = join(root, ...path.split("/"));
    const content = store.read(value.id).payload;
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    // chmod in addition to the write's mode: `writeFileSync` applies `mode` only
    // on creation, so rewriting a pre-existing executable file with a 100644
    // entry would otherwise leave the executable bit set and `status` would
    // never see the tree it just materialised as clean.
    chmodSync(absolute, value.mode === "100755" ? 0o755 : 0o644);
    const mode = value.mode === "100755" ? "100755" : "100644";
    // A concurrent writer can race the write and chmod above. Do not pair the
    // expected object id with metadata from bytes that were never verified.
    entries.push({ path, id: value.id, mode });
  }
  // Directories left empty by the removals above are pruned, so switching away
  // from a branch that introduced a directory does not leave its skeleton.
  pruneEmptyDirectories(root, root, controlDirectory);
  return entries;
}

/**
 * Removes directories that contain no files, deepest first.
 *
 * @param root - Absolute repository root, never itself removed.
 * @param directory - Directory to consider.
 * @param controlDirectory - Control directory name, never descended into.
 * @returns True when the directory is now empty of tracked content.
 */
function pruneEmptyDirectories(root: string, directory: string, controlDirectory: string): boolean {
  let empty = true;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === controlDirectory) {
      empty = false;
      continue;
    }
    if (entry.isDirectory() && isPrunableDirectory(entry.name)) {
      empty = false;
      continue;
    }
    const absolute = join(directory, entry.name);
    if (!entry.isDirectory()) {
      empty = false;
      continue;
    }
    if (pruneEmptyDirectories(root, absolute, controlDirectory)) rmSync(absolute, { recursive: true, force: true });
    else empty = false;
  }
  return empty;
}

/**
 * Compares HEAD, the index and the working tree.
 *
 * @param store - Object store holding HEAD's tree.
 * @param root - Absolute repository root.
 * @param headTree - HEAD's root tree, or null on an unborn branch.
 * @param index - The staged entries.
 * @param controlDirectory - Control directory name, excluded from the walk.
 * @param rules - Ignore rules excluding paths from the walk.
 * @param identify - Names a working file's content as the object kind the
 *   repository would store it under. Defaults to hashing it as a blob; a
 *   repository with record paths supplies one that canonicalises those, so a
 *   reformatted record does not read as modified.
 * @returns What is staged, what is not, and what is untracked.
 */
export function computeStatus(
  store: ObjectStore,
  root: string,
  headTree: ObjectId | null,
  index: readonly IndexEntry[],
  controlDirectory: string,
  rules: IgnoreRules,
  identify: (path: string, content: Buffer) => ObjectId = (_path, content) => hashObject("blob", content),
  read: typeof readWorkingFile = readWorkingFile,
): StatusReport {
  const committed = flattenTree(store, headTree);
  const staged = new Map(index.map((entry) => [entry.path, entry]));

  const stagedChanges: Change[] = [];
  for (const path of new Set([...committed.keys(), ...staged.keys()])) {
    const before = committed.get(path);
    const after = staged.get(path);
    if (!before && after) stagedChanges.push({ path, kind: "added" });
    else if (before && !after) stagedChanges.push({ path, kind: "deleted" });
    else if (before && after && (before.id !== after.id || before.mode !== after.mode)) {
      stagedChanges.push({ path, kind: "modified" });
    }
  }

  const present = new Set(listWorkingTree(root, controlDirectory, rules));
  const unstagedChanges: Change[] = [];
  for (const entry of index) {
    if (!present.has(entry.path)) {
      unstagedChanges.push({ path: entry.path, kind: "deleted" });
      continue;
    }
    const observed = readWorkingStat(root, entry.path);
    const expectedMode = observed.executable ? "100755" : "100644";
    if (expectedMode === entry.mode && sameIndexStat(entry.stat, observed.stat)) continue;
    const { content, executable } = read(root, entry.path);
    if ((executable ? "100755" : "100644") !== entry.mode || identify(entry.path, content) !== entry.id) {
      unstagedChanges.push({ path: entry.path, kind: "modified" });
    }
  }

  const untracked = [...present].filter((path) => !staged.has(path)).sort(compareByteOrder);
  return {
    staged: stagedChanges.sort((left, right) => compareByteOrder(left.path, right.path)),
    unstaged: unstagedChanges.sort((left, right) => compareByteOrder(left.path, right.path)),
    untracked,
    clean: stagedChanges.length === 0 && unstagedChanges.length === 0 && untracked.length === 0,
  };
}
