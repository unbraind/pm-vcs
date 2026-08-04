// The self-hosting gate: pm-vcs versions its own source, and a CI gate proves it.
//
// A tracked text bundle (`selfhost.bundle`) holds a pm-vcs history of the
// package's git-tracked source. `accept:self-host` (the `--check` mode below)
// reads the **committed** bundle and the **committed** source, both straight
// out of `HEAD`, and rejects any byte difference. `self-host:write` (the
// `--write` mode) is the only thing that regenerates the bundle; the gate never
// writes, so regenerating the bundle from a dirty tree and leaving it
// uncommitted changes the verdict by exactly nothing.
//
// The engine already serializes, hashes, bundles and verifies. This script
// orchestrates those primitives against a real git checkout; it introduces no
// second serialization path. Trees are built with the engine's `buildTree` in
// its legacy (FileId-free) form, so a tree id is a function of content and mode
// alone and the bundle is reproducible.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  exportBundle,
  importBundleObjects,
  parseBundle,
} from "../engine/bundle.ts";
import { type ObjectId, ObjectStore } from "../engine/objects.ts";
import {
  type Commit,
  type FileMode,
  type Signature,
  readCommit,
  writeCommit,
} from "../engine/model.ts";
import { RefStore } from "../engine/refs.ts";
import { buildTree, flattenTree, readWorkingFile } from "../engine/worktree.ts";

/** Path to the gate's data file, relative to the package root. */
export const SELF_HOST_CONFIG = "self-host.json";

/** Identity stamped on every self-host commit. */
const SELF_HOST_AUTHOR: Signature = {
  name: "pm-vcs self-host",
  email: "self-host@pm-vcs.local",
  timestamp: 0,
  timezoneOffsetMinutes: 0,
};

/**
 * The gate's configuration, read from {@link SELF_HOST_CONFIG}.
 *
 * Holding the bundle path, the ref the bundle advertises, and the exclusion
 * set in one file is what makes the exclusion set *data*: every tracked path is
 * either in the bundle or declared here, and a path in neither fails closed.
 * There is no scattered `if (path === "...")` literal anywhere else.
 */
export interface SelfHostConfig {
  /** Repository-relative path of the tracked bundle file. */
  readonly bundle: string;
  /** Full ref name the bundle advertises (its tip names the source snapshot). */
  readonly ref: string;
  /**
   * Tracked paths excluded from the source the bundle must cover.
   *
   * An entry matches exactly or as a directory prefix when it ends in `/`. The
   * bundle file itself must be listed: a bundle cannot contain itself, and
   * leaving it out would otherwise be a silent skip the gate could not detect.
   * Git-ignored paths (`dist/`, `coverage/`, `node_modules/`) never appear in
   * `git ls-files`, so they need no entry; the exclusion set is the set of
   * *tracked* paths deliberately kept out of the history.
   */
  readonly exclude: readonly string[];
}

/** One source file's bytes and the mode pm-vcs models it with. */
export interface SourceFile {
  /** Raw file content. */
  readonly content: Buffer;
  /** `100644` or `100755` — the executable bit decides. */
  readonly mode: FileMode;
}

/** The verdict of a self-host verification, with every discrepancy named. */
export interface Verification {
  /** True only when the bundle's tip is byte-identical to the source tree. */
  readonly ok: boolean;
  /** Human-readable problems, empty when `ok`. */
  readonly problems: readonly string[];
}

/**
 * Reads and validates the gate configuration.
 *
 * @param path - Path to `self-host.json`.
 * @returns The parsed configuration.
 * @throws Error When the file is missing or its shape is not a `SelfHostConfig`.
 */
export function loadConfig(path: string): SelfHostConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`self-host: could not read configuration at ${path}.`);
  }
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("self-host: configuration is not a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.bundle !== "string" || record.bundle.length === 0) {
    throw new Error("self-host: configuration is missing a non-empty `bundle` path.");
  }
  if (typeof record.ref !== "string" || record.ref.length === 0) {
    throw new Error("self-host: configuration is missing a non-empty `ref` name.");
  }
  if (!Array.isArray(record.exclude) || record.exclude.some((entry) => typeof entry !== "string")) {
    throw new Error("self-host: configuration `exclude` must be a list of strings.");
  }
  return { bundle: record.bundle, ref: record.ref, exclude: record.exclude as readonly string[] };
}

/**
 * Whether a tracked path is deliberately kept out of the bundle.
 *
 * An entry matches exactly, or as a directory prefix when it ends in `/`. This
 * is the single place the exclusion rule lives, so adding a tracked path that
 * should not be versioned means editing data here, not code elsewhere.
 *
 * @param path - Canonical repository-relative path.
 * @param exclude - The exclusion list from {@link SelfHostConfig}.
 * @returns True when the path matches an exclusion entry.
 */
export function isExcluded(path: string, exclude: readonly string[]): boolean {
  return exclude.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

/**
 * Builds the source tree from a flat path map, reusing the engine's canonical
 * tree builder.
 *
 * Blobs and trees are written into `store` with no stable file identity, which
 * selects the engine's legacy tree encoding: a tree id then depends only on
 * (name, mode, blob id), and a blob id depends only on content. The resulting
 * bundle is therefore reproducible from the same source — two runs over
 * identical bytes produce identical tree ids, and the gate's comparison is a
 * hash equality rather than a fragile byte walk.
 *
 * @param store - Destination object store.
 * @param files - Path to content and mode for every source file.
 * @returns The root tree id.
 */
export function buildSourceTree(
  store: ObjectStore,
  files: ReadonlyMap<string, SourceFile>,
): ObjectId {
  const map = new Map<string, { id: ObjectId; mode: FileMode }>();
  for (const [path, file] of files) {
    map.set(path, { id: store.write("blob", file.content), mode: file.mode });
  }
  return buildTree(store, map);
}

/**
 * Verifies a committed bundle against a freshly built source tree.
 *
 * The bundle is untrusted input, so {@link importBundleObjects} parses it through
 * {@link parseBundle}, which recomputes the id of every object line from its own
 * bytes and rejects a mismatch — the bundle's own header index is never taken on
 * trust. Every object is then read back through the store, which re-hashes on
 * read, so the tip tree is reconstructed from content the gate has verified twice.
 *
 * Byte-exactness is the root tree id: canonical trees make it a hash of every
 * name, mode and blob id beneath them, so equality covers content and mode
 * together. The path-by-path comparison exists to name the offending file when
 * the ids disagree, not to substitute for the hash check.
 *
 * @param store - Object store holding the bundle's objects and the source blobs.
 * @param bundleBytes - The committed bundle.
 * @param ref - The ref whose tip commits the source snapshot.
 * @param sourceTreeId - The tree id built from the committed source.
 * @returns A verdict and, on failure, the specific problems.
 */
export function verifySelfHost(
  store: ObjectStore,
  bundleBytes: Buffer,
  ref: string,
  sourceTreeId: ObjectId,
): Verification {
  let imported;
  try {
    imported = importBundleObjects(store, bundleBytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`the bundle is malformed or its objects do not hash to their ids: ${detail}`] };
  }
  // Completeness, checked before anything reads through `store`. The store is
  // shared with the source side — `buildSourceTree` has already written every
  // source blob into it — so a bundle that omits an object it declares would
  // still resolve here, borrowing the missing bytes from the source. The tip
  // tree id would match and the gate would call a truncated bundle byte-identical.
  // Comparing the declared object list against the lines actually carried closes
  // that, and it is the only check here that does not consult `store` at all.
  const carried = new Set(parseBundle(bundleBytes).lines.map((line) => line.id));
  const undelivered = imported.header.objects.filter((id) => !carried.has(id));
  if (undelivered.length > 0) {
    return {
      ok: false,
      problems: [
        `the bundle declares ${undelivered.length} object(s) it does not carry, so it is not self-contained: `
          + undelivered.slice(0, 5).join(", ") + (undelivered.length > 5 ? ", …" : ""),
      ],
    };
  }
  const tip = imported.header.refs[ref];
  if (tip === undefined) {
    const advertised = Object.keys(imported.header.refs).sort().join(", ") || "(none)";
    return { ok: false, problems: [`the bundle does not advertise ref ${ref} (advertised: ${advertised}).`] };
  }
  let tipTree: ObjectId;
  try {
    tipTree = readCommit(store, tip).tree;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`the bundle's tip ${tip} is not a readable commit: ${detail}`] };
  }
  const sourceFlat = flattenTree(store, sourceTreeId);
  const bundleFlat = flattenTree(store, tipTree);
  const problems: string[] = [];
  const missingInBundle = [...sourceFlat.keys()].filter((path) => !bundleFlat.has(path)).sort();
  const extraInBundle = [...bundleFlat.keys()].filter((path) => !sourceFlat.has(path)).sort();
  if (missingInBundle.length > 0) {
    problems.push(
      `${missingInBundle.length} tracked source path(s) absent from the bundle (not excluded, not versioned): `
        + missingInBundle.join(", "),
    );
  }
  if (extraInBundle.length > 0) {
    problems.push(
      `${extraInBundle.length} path(s) in the bundle are not tracked source: ` + extraInBundle.join(", "),
    );
  }
  for (const path of [...sourceFlat.keys()].sort()) {
    const bundleEntry = bundleFlat.get(path);
    if (bundleEntry === undefined) continue;
    const sourceEntry = sourceFlat.get(path)!;
    if (sourceEntry.id !== bundleEntry.id) {
      problems.push(`${path}: content differs (source ${sourceEntry.id}, bundle ${bundleEntry.id}).`);
    }
    if (sourceEntry.mode !== bundleEntry.mode) {
      problems.push(`${path}: mode differs (source ${sourceEntry.mode}, bundle ${bundleEntry.mode}).`);
    }
  }
  if (sourceTreeId !== tipTree) {
    problems.push(
      `the bundle's tip tree ${tipTree} is not byte-identical to the source tree ${sourceTreeId}.`,
    );
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Regenerates the bundle, appending one commit when the source tree changed and
 * leaving the history untouched when it has not.
 *
 * The existing committed bundle is imported so a new commit descends from the
 * real previous tip rather than restarting history. When the new source tree
 * already equals that tip's tree, the existing bundle is returned unchanged —
 * regenerating from identical source must not churn the file. Otherwise a commit
 * is written with a deterministic signature and message derived from the git
 * commit, so two runs over the same `HEAD` produce the same bytes.
 *
 * @param store - Object store holding the source tree and the imported history.
 * @param refs - Ref store used to publish the tip for export.
 * @param existingBundle - The committed bundle, or null on the first run.
 * @param ref - The ref to advance.
 * @param sourceTreeId - The tree id built from the current source.
 * @param signature - Author and committer signature.
 * @param message - Commit message.
 * @returns The new bundle bytes.
 */
export function writeSelfHostBundle(
  store: ObjectStore,
  refs: RefStore,
  existingBundle: Buffer | null,
  ref: string,
  sourceTreeId: ObjectId,
  signature: Signature,
  message: string,
): Buffer {
  let parent: ObjectId | null = null;
  let existingTipTree: ObjectId | null = null;
  if (existingBundle !== null) {
    const imported = importBundleObjects(store, existingBundle);
    const tip = imported.header.refs[ref];
    if (tip !== undefined) {
      parent = tip;
      existingTipTree = readCommit(store, tip).tree;
    }
  }
  if (existingBundle !== null && existingTipTree !== null && existingTipTree === sourceTreeId) {
    return existingBundle;
  }
  const commit: Commit = {
    tree: sourceTreeId,
    parents: parent === null ? [] : [parent],
    author: signature,
    committer: signature,
    message,
  };
  const tipId = writeCommit(store, commit);
  // The scratch ref store is fresh on a real run, so the expected value is the
  // ref's current state (null until something publishes it), not the parent
  // commit id. Using the parent here would make every run after the first fail
  // with a compare-and-swap mismatch, because the imported bundle's objects are
  // in the store but its ref was never published into this scratch ref store.
  refs.compareAndSwap(ref, refs.read(ref), tipId);
  return exportBundle(store, refs, [ref]);
}

/**
 * Runs a git command in `cwd` and returns trimmed stdout, failing loudly.
 */
function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/**
 * Enumerates the git-tracked source: every path `git ls-files` reports.
 *
 * NUL-delimited (`-z`) rather than newline-delimited, because a newline is a
 * legal character in a git path. Splitting on `"\n"` would silently cut such a
 * path into two entries, and every one of them would then be compared against
 * the bundle under the wrong name — a gate that desynchronises its own path
 * list can report a mismatch that is not there, or miss one that is.
 */
function listTrackedFiles(root: string): string[] {
  return runGit(root, ["ls-files", "-z"]).split("\0").filter((line) => line.length > 0);
}

/**
 * Materializes the committed tree (`HEAD`) in a fresh directory so the gate reads
 * committed content and mode, never the working tree. A dirty checkout cannot
 * affect the verdict because the source bytes come from here, not from disk.
 *
 * Uses a detached worktree rather than `git archive | tar`. Both produce the same
 * bytes, but the pipe made `tar` the only non-`git` binary the gate depended on,
 * and nothing tested that dependency: `accept:self-host` runs inside
 * `release:check` and therefore `prepublishOnly`, while the Windows CI job never
 * invokes it. A gate that can fail at publish time on a platform its own CI does
 * not exercise is worth one extra `git` call to avoid.
 *
 * The worktree is registered in `.git/worktrees` for the duration; the caller's
 * cleanup removes it, and a `git worktree prune` recovers from an interrupted run.
 *
 * @returns A cleanup function that removes the worktree registration.
 */
function extractHead(root: string, into: string): () => void {
  runGit(root, ["worktree", "add", "--detach", "--quiet", into, "HEAD"]);
  return () => {
    // Best effort: the verdict is already computed by the time this runs, and a
    // failure to unregister must not turn a passing gate into a failing one.
    spawnSync("git", ["worktree", "remove", "--force", into], { cwd: root });
  };
}

/**
 * Reads the committed bytes of a tracked file at `HEAD`, or null when absent.
 */
function readCommittedFile(root: string, path: string): Buffer | null {
  const result = spawnSync("git", ["cat-file", "blob", `HEAD:${path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  // `spawnSync` reports a failure to *launch* in `error`, leaving `status` null.
  // Treating that as "file absent" would turn a missing `git` into a clean
  // verdict about the repository, so it has to be told apart from exit != 0.
  if (result.error) {
    throw new Error(`self-host: could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) return null;
  return result.stdout as Buffer;
}

/**
 * Reads every non-excluded tracked source file from a directory tree, using the
 * engine's own working-tree reader so content and mode are interpreted by the
 * same code that stages any other repository.
 *
 * @param root - Directory holding the files (the extracted `HEAD` for the gate,
 *   the real checkout for `--write`).
 * @param tracked - Paths reported by `git ls-files`.
 * @param exclude - The exclusion list.
 * @returns Path to content and mode for every source file.
 * @throws Error When a tracked, non-excluded path is missing from `root` — the
 *   one way a path silently disappears, surfaced as a failure rather than a skip.
 */
function readSourceFiles(
  root: string,
  tracked: readonly string[],
  exclude: readonly string[],
): Map<string, SourceFile> {
  const files = new Map<string, SourceFile>();
  for (const path of tracked) {
    if (isExcluded(path, exclude)) continue;
    let observed;
    try {
      observed = readWorkingFile(root, path);
    } catch (error) {
      // `readWorkingFile` reports this as a bare ENOENT, which names a temp
      // directory the reader has never heard of and explains nothing. The
      // interesting fact is *why* a path git tracks is not in the tree we
      // extracted from HEAD — almost always an addition staged but not
      // committed — so say that instead.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `self-host: tracked path ${path} is absent from ${root} (uncommitted addition?): ${detail}`,
      );
    }
    files.set(path, { content: observed.content, mode: observed.executable ? "100755" : "100644" });
  }
  return files;
}

/**
 * Builds a fresh object store and ref store sharing a temp directory.
 */
function freshStore(): { store: ObjectStore; refs: RefStore; dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-"));
  return {
    store: new ObjectStore(join(dir, "objects")),
    refs: new RefStore(dir),
    dir,
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Determines the committer timestamp from the git `HEAD` commit, so a self-host
 * commit is tied to the source commit it snapshots and two runs over the same
 * `HEAD` produce the same bundle.
 */
function headCommitTimestamp(root: string): number {
  const seconds = Number(runGit(root, ["log", "-1", "--format=%ct", "HEAD"]));
  return Number.isSafeInteger(seconds) ? seconds * 1000 : 0;
}

/**
 * Entry point: `--check` (default) verifies the committed bundle against the
 * committed source; `--write` regenerates the bundle.
 */
function main(): void {
  const root = resolve(import.meta.dirname, "..");
  const write = process.argv.includes("--write");
  const config = loadConfig(join(root, SELF_HOST_CONFIG));
  const tracked = listTrackedFiles(root);

  if (write) {
    const { store, refs, cleanup } = freshStore();
    try {
      const sourceFiles = readSourceFiles(root, tracked, config.exclude);
      const sourceTreeId = buildSourceTree(store, sourceFiles);
      const existingBundle = readCommittedFile(root, config.bundle);
      const headSha = runGit(root, ["rev-parse", "HEAD"]);
      const signature: Signature = {
        ...SELF_HOST_AUTHOR,
        timestamp: headCommitTimestamp(root),
      };
      const bytes = writeSelfHostBundle(
        store,
        refs,
        existingBundle,
        config.ref,
        sourceTreeId,
        signature,
        `self-host: source snapshot at ${headSha}\n`,
      );
      writeFileSync(join(root, config.bundle), bytes);
      console.log(`self-host: wrote ${config.bundle} (${bytes.length} bytes)`);
    } finally {
      cleanup();
    }
    return;
  }

  const extractDir = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-src-"));
  const { store, cleanup } = freshStore();
  let removeWorktree: (() => void) | undefined;
  try {
    removeWorktree = extractHead(root, extractDir);
    // `readSourceFiles` now raises the absent-path failure itself, naming the
    // one path at fault. The post-hoc `missing` filter that used to live here
    // could never fire — every non-excluded tracked path either landed in the
    // map or had already thrown — so it was an unreachable diagnostic standing
    // in for one that never ran.
    const sourceFiles = readSourceFiles(extractDir, tracked, config.exclude);
    const sourceTreeId = buildSourceTree(store, sourceFiles);
    const bundleBytes = readCommittedFile(root, config.bundle);
    if (bundleBytes === null) {
      throw new Error(
        `self-host: no committed bundle at HEAD:${config.bundle}. Run \`npm run self-host:write\` and commit ${config.bundle}.`,
      );
    }
    const result = verifySelfHost(store, bundleBytes, config.ref, sourceTreeId);
    if (!result.ok) {
      console.error("self-host: the bundle's tip tree is not byte-identical to the committed source.");
      for (const problem of result.problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    // Confirm the bundle's self-description is parseable on its own, which is the
    // explicit re-hash of every object against its own id that point 3 requires.
    parseBundle(bundleBytes);
    console.log("self-host: the committed bundle's tip tree is byte-identical to the committed source.");
  } finally {
    // Unregister before deleting: `git worktree remove` needs the directory it
    // is removing to still be there, and a stale registration left behind would
    // make the *next* run's `worktree add` fail on a path that no longer exists.
    removeWorktree?.();
    rmSync(extractDir, { recursive: true, force: true });
    cleanup();
  }
}

// Run only when invoked directly, not when imported by the test suite.
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}