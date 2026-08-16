// Sparse linked instances over a shared immutable object store.
//
// A repository's control directory holds two very different kinds of state.
// Objects, refs, configuration and remotes describe the *clone*: they are either
// immutable or compare-and-swap protected, and every working tree belonging to
// the clone shares them. HEAD, the index, the operation log, the in-progress
// merge state, the sparse view and the dirty hints describe *one working tree*:
// two agents in two working trees must never be able to overwrite each other's.
//
// This module owns the per-instance half of that split: the view that decides
// which paths a working tree materializes, the dirty hints a fast status may
// consult (but never trust), the link file that binds an instance to its hub,
// the shared-store read wrapper that turns an absent object into a typed,
// actionable "fetch this" error instead of a bare miss, and the registry of
// linked instances the hub keeps for itself.
//
// Nothing here writes instance state into the shared object store, and nothing
// here trusts a hint where the filesystem can be asked instead.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { matchesGlob } from "./config.ts";
import { compareByteOrder } from "./model.ts";
import { ObjectStore, ObjectStoreError, type ObjectId, type StoredObject, assertRegistryName, readControlJson } from "./objects.ts";

/** File inside an instance's control directory naming the hub it belongs to. */
export const INSTANCE_LINK_FILE = "link.json";

/** File inside the hub's control directory listing every linked instance. */
export const INSTANCE_REGISTRY_FILE = "instances.json";

/** File inside a control directory holding that working tree's sparse view. */
export const VIEW_FILE = "view.json";

/** File inside a control directory holding that working tree's dirty hints. */
export const HINTS_FILE = "dirty.json";

/**
 * Which paths a working tree materializes.
 *
 * Inbound only: the view decides what a materialization writes into the working
 * tree, never what a commit records. A commit always records the complete tree,
 * with out-of-view paths carried through the index as sparse entries holding
 * their committed content, so two working trees with different views of the same
 * revision commit byte-identical trees. An empty include list is the full view,
 * which is what a repository without a view file has.
 */
export interface ViewSpec {
  /** Glob patterns; a path is visible when any pattern matches. Empty means everything. */
  readonly include: readonly string[];
}

/** One registered linked instance, as the hub records it. */
export interface InstanceEntry {
  /** Caller-chosen instance name, unique within the hub. */
  readonly name: string;
  /** Instance working-tree root, POSIX-style relative to the hub root. */
  readonly path: string;
}

/** A full-scan reconciliation of dirty hints against filesystem truth. */
export interface ScanReport {
  /**
   * Index entries whose bytes were read and compared against the index.
   * Absent paths — sparse by view, or genuinely deleted — are excluded: the
   * filesystem was consulted about them, but their content was not, and a
   * deleted path still surfaces in `dirty` on its own.
   */
  readonly checked: number;
  /** Paths whose working-tree bytes genuinely differ from the index. */
  readonly dirty: readonly string[];
  /** Every hint that disagreed with reality, in path order. */
  readonly corrections: readonly ScanCorrection[];
}

/** One hint the full scan found to be a lie, and what the truth was. */
export interface ScanCorrection {
  /** The hinted path. */
  readonly path: string;
  /** What the hint claimed: true for dirty. */
  readonly hinted: boolean;
  /** What the filesystem proved: true for dirty. */
  readonly actual: boolean;
}

/**
 * Rejects an include pattern that cannot match a canonical path.
 *
 * Patterns are matched with {@link matchesGlob}, which anchors them, so a
 * pattern cannot escape the repository — but a pattern that is empty, absolute,
 * or holds relative segments can never match anything and would silently make
 * the view narrower than the caller believes it to be.
 *
 * @param pattern - Candidate include pattern.
 * @throws ObjectStoreError When the pattern is empty, absolute, or holds an
 *   empty, `.` or `..` segment, a backslash, or a NUL.
 */
function assertIncludePattern(pattern: string): void {
  const reject = (reason: string): never => {
    throw new ObjectStoreError("bad_view", `View include pattern "${pattern}" is invalid: ${reason}`);
  };
  if (pattern.length === 0) reject("it is empty");
  if (pattern.startsWith("/") || pattern.endsWith("/")) reject("it starts or ends with a slash");
  if (pattern.includes("\\")) reject("it contains a backslash");
  if (pattern.includes("\0")) reject("it contains a NUL");
  for (const segment of pattern.split("/")) {
    if (segment.length === 0) reject("it contains an empty path segment");
    if (segment === "." || segment === "..") reject("it contains a relative path segment");
  }
}

/**
 * Validates parsed view-file content.
 *
 * @param raw - Parsed JSON from the view file.
 * @returns The validated view. A missing `include` is the full view, so a
 *   hand-written `{}` behaves like an empty include list.
 * @throws ObjectStoreError When the shape is not an object with an optional
 *   string-array `include` of valid patterns.
 */
export function parseView(raw: unknown): ViewSpec {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ObjectStoreError("bad_view", "View is not a JSON object.");
  }
  const source = raw as Record<string, unknown>;
  const include = source.include ?? [];
  if (!Array.isArray(include) || include.some((entry) => typeof entry !== "string")) {
    throw new ObjectStoreError("bad_view", "View include must be an array of glob patterns.");
  }
  for (const pattern of include as string[]) assertIncludePattern(pattern);
  return { include };
}

/**
 * Reads a working tree's sparse view.
 *
 * A corrupt view file is fatal rather than read as "full view": the file decides
 * what a materialization may overwrite, and quietly treating a damaged view as
 * "materialize everything" is exactly the silent state change this module
 * exists to prevent.
 *
 * @param controlDirectory - The working tree's control directory.
 * @returns The view, or null when there is none (the full view).
 * @throws ObjectStoreError When the file exists but is not valid JSON or not a
 *   valid view.
 */
export function readView(controlDirectory: string): ViewSpec | null {
  const parsed = readControlJson(join(controlDirectory, VIEW_FILE), "bad_view", "view file");
  return parsed === null ? null : parseView(parsed);
}

/**
 * Writes a sparse view atomically.
 *
 * @param controlDirectory - The working tree's control directory.
 * @param view - The view to record.
 */
export function writeView(controlDirectory: string, view: ViewSpec): void {
  writeControlFile(join(controlDirectory, VIEW_FILE), `${JSON.stringify(view, null, 2)}\n`);
}

/**
 * Whether a path is inside a view.
 *
 * @param view - The view to test against.
 * @param path - Canonical repository-relative path.
 * @returns True when the path should be materialized; an empty include list
 *   includes everything.
 */
export function viewIncludes(view: ViewSpec, path: string): boolean {
  return view.include.length === 0 || view.include.some((pattern) => matchesGlob(path, pattern));
}

/**
 * Validates a parsed instance-link file.
 *
 * @param raw - Parsed JSON from the link file.
 * @returns The hub location exactly as recorded, POSIX-style and relative to
 *   the instance root.
 * @throws ObjectStoreError When the file does not name a hub location.
 */
export function parseInstanceLink(raw: unknown): string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ObjectStoreError("broken_instance_link", "Instance link is not a JSON object.");
  }
  const hub = (raw as Record<string, unknown>).hub;
  if (typeof hub !== "string" || hub.length === 0) {
    throw new ObjectStoreError("broken_instance_link", 'Instance link does not name a hub under a "hub" key.');
  }
  return hub;
}

/**
 * Reads a working tree's dirty hints.
 *
 * Hints are an optimization input, never an authority: callers may use them to
 * force extra verification of a path, never to skip verification. A corrupt
 * hints file is fatal for the same reason as a corrupt view — degrading it to
 * "no hints" would silently drop the extra checks the file exists to request.
 *
 * @param controlDirectory - The working tree's control directory.
 * @returns The hinted-dirty paths, sorted. Empty when no hints are recorded.
 * @throws ObjectStoreError When the file exists but is not a string array.
 */
export function readHints(controlDirectory: string): readonly string[] {
  const parsed = readControlJson(join(controlDirectory, HINTS_FILE), "bad_hints", "dirty-hints file");
  if (parsed === null) return [];
  if (typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray((parsed as Record<string, unknown>).dirty)
    || (parsed as { dirty: unknown[] }).dirty.some((entry) => typeof entry !== "string")) {
    throw new ObjectStoreError("bad_hints", "Dirty hints must be an object holding an array of paths under \"dirty\".");
  }
  return [...(parsed as { dirty: string[] }).dirty].sort(compareByteOrder);
}

/**
 * Records dirty hints atomically.
 *
 * @param controlDirectory - The working tree's control directory.
 * @param paths - The paths to record as hinted dirty.
 */
export function writeHints(controlDirectory: string, paths: readonly string[]): void {
  writeControlFile(join(controlDirectory, HINTS_FILE), `${JSON.stringify({ dirty: [...paths].sort(compareByteOrder) }, null, 2)}\n`);
}

/**
 * Writes one small control file atomically: temp file, fsync-less write, rename.
 *
 * Every per-instance state file is written through here so an interrupted write
 * leaves the previous state rather than a truncated file — the same discipline
 * the ref store and remotes apply to their durable files.
 *
 * @param path - Destination path.
 * @param contents - Exact bytes to write.
 */
function writeControlFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * The object store of a linked instance: the hub's shared store, read lazily.
 *
 * Immutable objects are physically shared — an instance never copies the store,
 * it reads and writes the hub's — so the only behavior this wrapper changes is
 * what an absent object means. In the hub, a miss is a miss. In an instance, a
 * miss is a fragment that was never fetched or has been lost, and the caller is
 * an agent who can go get it: the error names the object and the commands that
 * retrieve it. A bare `object_not_found` answers "does not exist" to a question
 * whose honest answer is "not here yet".
 */
export class SharedObjectStore extends ObjectStore {
  /**
   * Reads an object, translating an absence into an actionable fetch error.
   *
   * Every other failure passes through unchanged: corruption and unreadable
   * storage mean different things than an unfetched fragment, and folding them
   * together would send an agent to re-fetch history when the machine needs
   * repair instead.
   *
   * @param id - Object id to read.
   * @returns The object's kind and payload.
   * @throws ObjectStoreError With code `missing_fragment` when the shared store
   *   holds no object with this id; the message names the id and how to fetch it.
   */
  read(id: ObjectId): StoredObject {
    try {
      return super.read(id);
    } catch (error) {
      if (error instanceof ObjectStoreError && error.code === "object_not_found") {
        throw new ObjectStoreError(
          "missing_fragment",
          `Object ${id} is missing from the shared object store this instance reads. `
          + "Fetch it with `pm vcs fetch <remote>` from the hub or any linked instance, "
          + "or import a bundle that carries it with `pm vcs import <file>`, then retry.",
        );
      }
      throw error;
    }
  }
}

/**
 * Rejects an instance name that cannot be stored or spoken safely.
 *
 * Names become registry keys and appear in command output; one holding a path
 * separator could be mistaken for a path, and control characters make output
 * unreadable. The rules match ref-name hygiene for the same reason.
 *
 * @param name - Candidate instance name.
 * @throws ObjectStoreError When the name is empty, dot-only, or contains a path
 *   separator, whitespace, a control character, or a character reserved in refs.
 */
export function assertInstanceName(name: string): void {
  assertRegistryName(name, "invalid_instance_name", "Instance");
}

/**
 * Validates one parsed registry entry.
 *
 * @param raw - Parsed JSON for one entry.
 * @returns The validated entry.
 * @throws ObjectStoreError When the entry does not hold a valid name and a
 *   non-empty relative path.
 */
function parseInstanceEntry(raw: unknown): InstanceEntry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ObjectStoreError("bad_instances", "Instance registry entry is not a JSON object.");
  }
  const source = raw as Record<string, unknown>;
  const name = source.name;
  const path = source.path;
  if (typeof name !== "string" || typeof path !== "string" || path.length === 0) {
    throw new ObjectStoreError("bad_instances", "Instance registry entry does not hold a name and a path.");
  }
  assertInstanceName(name);
  return { name, path };
}

/**
 * Reads the hub's instance registry.
 *
 * @param controlDirectory - The hub's control directory.
 * @returns The registered instances in registry order.
 * @throws ObjectStoreError When the registry exists but is not a valid
 *   instance list.
 */
export function readInstances(controlDirectory: string): readonly InstanceEntry[] {
  const parsed = readControlJson(join(controlDirectory, INSTANCE_REGISTRY_FILE), "bad_instances", "instance registry");
  if (parsed === null) return [];
  if (typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray((parsed as Record<string, unknown>).instances)) {
    throw new ObjectStoreError("bad_instances", "Instance registry must be an object holding an \"instances\" array.");
  }
  return (parsed as { instances: unknown[] }).instances.map(parseInstanceEntry);
}

/**
 * Rewrites the registry under its lock, checking the caller's invariants.
 *
 * The read-modify-write happens while holding an exclusive lock file, so two
 * concurrent `instance link` commands cannot both read the same registry and
 * each write a registry missing the other's instance — the same lost-update a
 * compare-and-swap ref update refuses to allow.
 *
 * @param controlDirectory - The hub's control directory.
 * @param mutate - Receives the current entries and returns the next entries;
 *   returning them unchanged writes nothing.
 * @returns The entries after the mutation.
 * @throws ObjectStoreError When another process holds the registry lock, or
 *   when the mutation produced duplicate names or paths.
 */
function updateInstances(
  controlDirectory: string,
  mutate: (entries: readonly InstanceEntry[]) => readonly InstanceEntry[],
): readonly InstanceEntry[] {
  const path = join(controlDirectory, INSTANCE_REGISTRY_FILE);
  mkdirSync(controlDirectory, { recursive: true });
  const lockPath = `${path}.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx");
  } catch (error) {
    // `wx` fails with EEXIST only when the lock file is already there — another
    // process holds the registry. Any other errno (EACCES, ENOSPC, ENOTDIR,
    // EROFS, …) is a different fault about the directory itself, and reporting
    // it as a busy lock would send the caller retrying a retry that can never
    // succeed while telling them nothing about the real damage.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new ObjectStoreError(
      "instance_registry_locked",
      `The instance registry is locked by another process (${lockPath}); retry after that pm-vcs command completes.`,
    );
  }
  try {
    const before = readInstances(controlDirectory);
    const after = mutate(before);
    if (after !== before) {
      writeControlFile(path, `${JSON.stringify({ instances: after }, null, 2)}\n`);
    }
    return after;
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

/**
 * Registers a linked instance.
 *
 * @param controlDirectory - The hub's control directory.
 * @param entry - The instance to register, its path relative to the hub root.
 * @throws ObjectStoreError When the name or path is already registered.
 */
export function registerInstance(controlDirectory: string, entry: InstanceEntry): void {
  updateInstances(controlDirectory, (entries) => {
    if (entries.some((existing) => existing.name === entry.name || existing.path === entry.path)) {
      throw new ObjectStoreError(
        "instance_exists",
        `An instance named ${entry.name} or living at ${entry.path} is already registered. Unlink it first or choose another name and path.`,
      );
    }
    return [...entries, entry];
  });
}

/**
 * Removes a linked instance from the registry.
 *
 * @param controlDirectory - The hub's control directory.
 * @param name - The instance to remove.
 * @throws ObjectStoreError When no instance is registered under that name.
 */
export function unregisterInstance(controlDirectory: string, name: string): void {
  updateInstances(controlDirectory, (entries) => {
    if (!entries.some((existing) => existing.name === name)) {
      throw new ObjectStoreError("unknown_instance", `No instance named ${name} is registered.`);
    }
    return entries.filter((existing) => existing.name !== name);
  });
}

/**
 * Whether a directory exists and holds anything at all.
 *
 * @param path - Directory to inspect.
 * @returns True when the directory exists and holds at least one entry.
 */
export function isDirectoryOccupied(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}
