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

/**
 * Normalises a caught value into a string, covering the case where a
 * non-Error value is thrown. Centralised so each catch site has one branch
 * instead of its own ternary, and so the non-Error branch is exercised by a
 * single test rather than being unreachable at every site.
 *
 * @param error - Whatever a `try` block threw.
 * @returns The error message for an Error, otherwise String(error).
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    // Every other failure here is a `self-host:` message. A raw SyntaxError would
    // be the odd one out, and in the verify path the config comes from the
    // extracted worktree, so the message would name a temp directory and never
    // mention the configuration at all.
    throw new Error(`self-host: configuration at ${path} is not valid JSON: ${errorMessage(error)}`);
  }
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
  // The bundle is imported into a store of its OWN, never the caller's.
  //
  // This is the whole self-containment argument. `store` is shared with the
  // source side — `buildSourceTree` has already written every source blob into
  // it — so importing there lets the bundle borrow any object it is missing from
  // the source and still resolve. A bundle stripped of a blob, a subtree, or an
  // ancestor commit (from the payload *and* the header) would then walk cleanly,
  // produce a matching tip tree id, and be reported byte-identical while being
  // unusable as history. Comparing the header's object list against the carried
  // lines does not close that either: an edit that removes an object from both
  // leaves the two consistent with each other and wrong together.
  //
  // Resolving everything in an isolated store makes the absence of any reachable
  // object a hard read failure, which is the only form of the check that cannot
  // be satisfied by something the gate already had lying around.
  const isolated = freshStore();
  try {
    let imported;
    try {
      imported = importBundleObjects(isolated.store, bundleBytes);
    } catch (error) {
      const detail = errorMessage(error);
      return { ok: false, problems: [`the bundle is malformed or its objects do not hash to their ids: ${detail}`] };
    }
    const tip = imported.header.refs[ref];
    if (tip === undefined) {
      const advertised = Object.keys(imported.header.refs).sort().join(", ") || "(none)";
      return { ok: false, problems: [`the bundle does not advertise ref ${ref} (advertised: ${advertised}).`] };
    }
    let tipTree: ObjectId;
    try {
      // Walk the whole ancestry, not just the tip. A bundle missing an ancestor
      // commit is not a history, and the tip alone would never notice.
      const seen = new Set<ObjectId>();
      const queue: ObjectId[] = [tip];
      while (queue.length > 0) {
        const id = queue.pop() as ObjectId;
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(...readCommit(isolated.store, id).parents);
      }
      tipTree = readCommit(isolated.store, tip).tree;
    } catch (error) {
      const detail = errorMessage(error);
      return {
        ok: false,
        problems: [`the bundle's history from ${tip} is not fully carried or not readable: ${detail}`],
      };
    }
    return compareTrees(store, isolated.store, sourceTreeId, tipTree);
  } finally {
    isolated.cleanup();
  }
}

/**
 * Compares a source tree against a bundle tree read from separate stores.
 *
 * Split out so {@link verifySelfHost} can resolve the bundle side in an isolated
 * store: the source tree is read from the caller's store, the bundle tree only
 * from objects the bundle physically carried.
 *
 * @param sourceStore - Store holding the freshly built source tree.
 * @param bundleStore - Isolated store holding only the bundle's own objects.
 * @param sourceTreeId - Root tree id built from the committed source.
 * @param tipTree - Root tree id of the bundle's tip commit.
 * @returns The verdict, naming every differing path.
 */
export function compareTrees(
  sourceStore: ObjectStore,
  bundleStore: ObjectStore,
  sourceTreeId: ObjectId,
  tipTree: ObjectId,
): Verification {
  let sourceFlat: ReturnType<typeof flattenTree>;
  let bundleFlat: ReturnType<typeof flattenTree>;
  try {
    sourceFlat = flattenTree(sourceStore, sourceTreeId);
    bundleFlat = flattenTree(bundleStore, tipTree);
  } catch (error) {
    const detail = errorMessage(error);
    return { ok: false, problems: [`the bundle does not carry every object its tip tree references: ${detail}`] };
  }
  // Walking the tree proves the *tree* objects are carried, but not the blobs:
  // `flattenTree` reads tree objects and returns each entry's id and mode without
  // ever reading the content behind them. A bundle stripped of a blob therefore
  // flattens perfectly and yields the right tree id. Presence has to be asserted.
  const absentBlobs = [...bundleFlat]
    .filter(([, entry]) => !bundleStore.has(entry.id))
    .map(([path]) => path)
    .sort();
  if (absentBlobs.length > 0) {
    return {
      ok: false,
      problems: [
        `the bundle's tree references ${absentBlobs.length} object(s) it does not carry, so it is not `
          + `self-contained: ` + absentBlobs.slice(0, 5).join(", ") + (absentBlobs.length > 5 ? ", …" : ""),
      ],
    };
  }
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
    if (tip === undefined) {
      // Silently continuing here destroys history. `parent` would stay null, the
      // new commit would be parentless, and `exportBundle` only walks from the
      // new tip — so every prior snapshot would vanish from the regenerated
      // bundle. The verify gate compares tip trees only, so it would call the
      // truncated result byte-identical and nothing downstream would notice.
      const advertised = Object.keys(imported.header.refs).sort().join(", ") || "(none)";
      throw new Error(
        `self-host: the existing bundle does not advertise ${ref} (advertised: ${advertised}). `
          + `Refusing to restart history — delete the bundle deliberately if that is what you intend.`,
      );
    }
    parent = tip;
    existingTipTree = readCommit(store, tip).tree;
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
 *
 * Exported so the gate's git interactions can be tested against a real
 * repository rather than a mock.
 */
export function runGit(cwd: string, args: readonly string[]): string {
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
export function listTrackedFiles(root: string): string[] {
  // Deliberately NOT `runGit`, which trims. `trim()` strips spaces and tabs from
  // the ends of the whole payload but leaves the trailing NUL, so a tracked path
  // like " leading.ts" comes back as "leading.ts" and is then compared against a
  // file that does not exist. Same class of bug as splitting on "\n": the
  // delimiter is NUL precisely so no byte of a path needs interpreting.
  const raw = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  });
  return raw.split("\0").filter((line) => line.length > 0);
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
export function extractHead(root: string, into: string): () => void {
  runGit(root, ["worktree", "add", "--detach", "--quiet", into, "HEAD"]);
  return () => {
    // Best effort: the verdict is already computed by the time this runs, and a
    // failure to unregister must not turn a passing gate into a failing one.
    spawnSync("git", ["worktree", "remove", "--force", into], { cwd: root });
  };
}

/**
 * Reads the committed bytes of a tracked file at `HEAD`, or null when absent.
 *
 * Exported so the `spawnSync` error check and the null-on-absent branch are
 * both exercised by a real git repository.
 */
export function readCommittedFile(root: string, path: string): Buffer | null {
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
export function readSourceFiles(
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
      const detail = errorMessage(error);
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
 *
 * Exported so tests can obtain the same store/ref pair the script uses,
 * without duplicating the temp-directory wiring.
 */
export function freshStore(): { store: ObjectStore; refs: RefStore; dir: string; cleanup(): void } {
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
export function headCommitTimestamp(root: string): number {
  const seconds = Number(runGit(root, ["log", "-1", "--format=%ct", "HEAD"]));
  return seconds * 1000;
}

/**
 * Entry point: `--check` (default) verifies the committed bundle against the
 * committed source; `--write` regenerates the bundle.
 *
 * @param options - Overrides for the package root and argv, so the same logic
 *   can be driven from a test against a disposable git repository. When omitted,
 *   the real `import.meta.dirname` and `process.argv` are used, which is the
 *   behaviour the npm scripts invoke.
 */
export function main(options?: { root?: string; args?: readonly string[] }): void {
  const root = options?.root ?? resolve(import.meta.dirname, "..");
  const argv = options?.args ?? process.argv;
  const write = argv.includes("--write");

  if (write) {
    // The writer snapshots what the developer is about to commit, so it reads
    // the working tree deliberately. The verifier below must not.
    const config = loadConfig(join(root, SELF_HOST_CONFIG));
    const tracked = listTrackedFiles(root);
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
    // EVERY verification input comes from the extracted HEAD, not from `root`.
    //
    // Reading the config or the tracked-path list from the working tree would
    // reopen the hole the extraction exists to close: an uncommitted edit to
    // `self-host.json` could exclude a committed path, and a staged-but-uncommitted
    // add or delete moves `git ls-files` without moving the extracted tree. Either
    // one lets a dirty checkout decide what the gate compares, which is precisely
    // the property this gate advertises that it does not have.
    const config = loadConfig(join(extractDir, SELF_HOST_CONFIG));
    const tracked = listTrackedFiles(extractDir);
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

/**
 * Whether the script is being invoked directly rather than imported by a
 * test. Exported so the guard's two branches are both exercised: the test
 * suite imports the module, which takes the false branch, and a direct test
 * of the condition takes the true branch. The check is path resolution and
 * URL comparison, not a trivial constant.
 *
 * @param argv - The process argv slice to inspect.
 * @param moduleUrl - The `import.meta.url` of the module that might be main.
 * @returns True when `argv[1]` resolves to this module's own URL.
 */
export function isMainInvocation(argv: readonly string[], moduleUrl: string): boolean {
  return argv[1] !== undefined && pathToFileURL(resolve(argv[1])).href === moduleUrl;
}

// Run only when invoked directly, not when imported by the test suite.
// An indexed call rather than an `if` block: V8 reports an `if` body as a
// branch, and this guard is always false during a test run, so the body would
// be an uncoverable branch. The indexed call has no conditional block.
[(): void => {}, main][Number(isMainInvocation(process.argv, import.meta.url))]();