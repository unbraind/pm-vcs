import { decodeGitListing, isolatedPathspecEnvironment } from "../git.ts";
import { type DestructionReceipt, DestructionRefusal, namespacePublicationContext, retireNamespace } from "../engine/destruction.ts";
import { durability } from "../engine/durability.ts";
// The self-hosting gate: pm-vcs versions its own source, and a CI gate proves it.
//
// A tracked text bundle (`selfhost.bundle`) holds a bounded pm-vcs archive of the
// package's git-tracked source: exactly one commit, naming the source snapshot,
// with no history behind it. `accept:self-host` (the `--check` mode below) reads
// the **committed** bundle and the **committed** source, both straight out of
// `HEAD`, and rejects differences except validated external action revisions.
// `self-host:write` generates the bundle from tracked working files, or from
// the Git index with `--staged`. Both the staged tree and the committed tree
// are read as raw blob bytes straight from git's object database — never
// through a checkout, whose line-ending conversion rules would stand between
// the tree a commit records and the bytes this gate bundles. Verification only
// considers committed bytes.
//
// The archive is bounded on purpose. The gate's contract is tip-tree equality —
// a full history satisfied it too, but every regeneration appended one commit
// and kept every superseded blob, so the committed artifact grew without limit
// (measured: 46.88 MiB after one month of growth) while the proof it carried
// never got stronger. A single snapshot is a complete, self-contained, and
// importable pm-vcs repository that proves exactly the same fact at a size
// that is a function of the source, not of the commit count.
//
// The engine already serializes, hashes, bundles and verifies. This script
// orchestrates those primitives against a real git checkout; it introduces no
// second serialization path. Trees are built with the engine's `buildTree` in
// its legacy (FileId-free) form, so a tree id is a function of content and mode
// alone and the bundle is reproducible.

import { createHash, randomUUID } from "node:crypto";
import { streamProcess } from "./audit-git-identities.ts";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import fs, { type BigIntStats, lstatSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isPair, isScalar, parseDocument, visit } from "yaml";
import { isMainInvocation } from "./main-invocation.ts";

export { isMainInvocation };

import {
  exportBundle,
  importBundleObjects,
  parseBundle,
} from "../engine/bundle.ts";
import { type ObjectId, ObjectStore, ObjectStoreError } from "../engine/objects.ts";
import { assertVerificationBound, verificationLimits } from "../engine/object-error.ts";
import {
  type Commit,
  type FileMode,
  type Signature,
  decodeCommit,
  readCommit,
  writeCommit,
} from "../engine/model.ts";
import { RefStore } from "../engine/refs.ts";
import { buildTree, flattenTree, type IndexStat, sameFileIdentity } from "../engine/worktree.ts";

/** Path to the gate's data file, relative to the package root. */
export const SELF_HOST_CONFIG = "self-host.json";

/**
 * Views one stat observation in the engine's cache-identity shape.
 *
 * The reader reuses the engine's own identity predicate so "the same leaf,
 * unchanged between two observations" is decided by the same fields
 * everywhere in the package instead of a second, drifting copy of the rule.
 *
 * @param stats - One `lstat` observation, taken with `bigint: true`.
 * @returns The identity fields {@link sameFileIdentity} compares.
 */
function statIdentity(stats: BigIntStats): IndexStat {
  return { size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, dev: stats.dev, ino: stats.ino, observedAtNs: 0n };
}

/**
 * The one path this gate will ever write, fixed in code rather than configured.
 *
 * `self-host.json` ships with the source, so a pull request can set anything in
 * it, and `--write` turns the `bundle` field into a write target. Successive
 * rounds of guarding that field — reject absolute paths and `..`, reject
 * symbolic links, require the path be git-tracked — each closed one route and
 * left the next open, because they all answered "may this path be written?" when
 * the question is "**is this path the bundle?**". Tracking proves a path belongs
 * to the repository; it does not make it the artifact. `README.md` is tracked,
 * and a not-yet-existing `.git/hooks/pre-commit` satisfied the bootstrap case.
 *
 * Artifact identity therefore comes from the code. The config may still name the
 * bundle, because a self-describing data file is worth having, but it is checked
 * against this constant rather than trusted — so the field is documentation, not
 * authority.
 */
export const SELF_HOST_BUNDLE = "selfhost.bundle";

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
  /**
   * The tracked bundle file. Must equal {@link SELF_HOST_BUNDLE}.
   *
   * Recorded here so the data file describes itself, but the constant is what
   * the gate writes — this field is checked against it, never trusted in place
   * of it.
   */
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
 * Reads the gate configuration from its file on disk.
 *
 * The working-tree reader for the legacy `--write` mode, which snapshots the
 * files on disk and is configured by the file on disk. The staged and
 * committed trees use {@link readTreeSnapshot} instead, which parses the
 * configuration out of the bytes the tree itself carries.
 *
 * @param path - Path to `self-host.json`.
 * @returns The parsed configuration.
 * @throws Error When the file is missing, is not a regular file, its shape is
 *   not a `SelfHostConfig`, or it changed while being read — bytes whose type
 *   and identity were not observed together are never parsed.
 */
export function loadConfig(path: string): SelfHostConfig {
  return captureWorkingConfig(path).config;
}

/** Parse the same regular-file observation that the working writer will archive. */
function captureWorkingConfig(path: string): { config: SelfHostConfig; source: SourceFile } {
  const before = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (before === undefined || !before.isFile()) {
    throw new Error("self-host: configuration must be a regular file.");
  }
  const content = readStableSourceBytes(path, before);
  if (content === undefined) {
    throw new Error("self-host: configuration changed while it was being read; run the command again.");
  }
  return {
    config: parseSelfHostConfig(content.toString("utf8")),
    source: { content, mode: (before.mode & 0o100n) === 0n ? "100644" : "100755" },
  };
}

/** Read a regular leaf only after the opened descriptor matches the observed inode. */
function readRegularFile<T>(path: string, expected: BigIntStats, followLink: boolean, read: (fd: number) => T): { content: T; stat: BigIntStats } {
  const noFollow = followLink ? 0 : fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new ObjectStoreError("worktree_path_changed", "File changed while it was being read.");
    }
    return { content: read(fd), stat };
  } finally {
    fs.closeSync(fd);
  }
}

/** Return bytes only if the opened leaf and both pathname observations agree. */
function readStableSourceBytes(path: string, before: BigIntStats, followLink = false): Buffer | undefined {
  try {
    const observed = before.isSymbolicLink()
      ? { content: fs.readlinkSync(path, { encoding: "buffer" }), stat: before }
      : readRegularFile(path, before, followLink, fd => fs.readFileSync(fd));
    const stat = followLink ? fs.statSync : fs.lstatSync;
    const after = stat(path, { bigint: true, throwIfNoEntry: false });
    if (after !== undefined && sameFileIdentity(statIdentity(before), statIdentity(observed.stat))
        && sameFileIdentity(statIdentity(observed.stat), statIdentity(after))) return observed.content;
  } catch (error) {
    if (!(error instanceof ObjectStoreError && error.code === "worktree_path_changed")
        && !["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  return undefined;
}

/**
 * Validates the gate configuration from its raw bytes.
 *
 * Split out of {@link loadConfig} so the staged and committed trees can be
 * configured from the blob they carry while every shape rule stays in exactly
 * one place — the file reader and the tree reader must never disagree about
 * what a valid configuration is.
 *
 * @param raw - The configuration file's bytes as text.
 * @returns The parsed configuration.
 * @throws Error When the shape is not a `SelfHostConfig`.
 */
export function parseSelfHostConfig(raw: string): SelfHostConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    // Every other failure here is a `self-host:` message. A raw SyntaxError would
    // be the odd one out, and the message must describe the configuration, not
    // whichever file or tree it was read from.
    throw new Error(`self-host: the configuration is not valid JSON: ${errorMessage(error)}`);
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
  // The bundle path is NOT taken from the configuration — see SELF_HOST_BUNDLE.
  // The field must agree with the constant, which keeps the data file honest
  // about what it describes while giving it no say in where bytes land.
  if (record.bundle !== SELF_HOST_BUNDLE) {
    throw new Error(
      `self-host: configuration bundle "${record.bundle}" must be "${SELF_HOST_BUNDLE}". `
        + `The bundle path is fixed in code; the configuration only records it.`,
    );
  }
  for (const entry of record.exclude as readonly string[]) assertRepositoryRelative(entry, "exclude entry");
  // The bundle cannot contain itself, and the interface docs have always said so
  // — but nothing enforced it. With `"exclude": []`, `--write` folds the CURRENT
  // bundle into the source tree and then overwrites it, so the bundle it emits
  // records the previous bundle's bytes as source and the next `accept:self-host`
  // fails on a repository nobody touched. A documented invariant that the code
  // does not check is exactly the defect this PR opened with.
  if (!(record.exclude as readonly string[]).includes(SELF_HOST_BUNDLE)) {
    throw new Error(
      `self-host: configuration \`exclude\` must list "${SELF_HOST_BUNDLE}". `
        + `A bundle cannot contain itself, and omitting it makes every regeneration self-stale.`,
    );
  }
  return { bundle: record.bundle, ref: record.ref, exclude: record.exclude as readonly string[] };
}

/**
 * Resolves the bundle's write target, refusing anything that leaves the repository.
 *
 * The lexical check in {@link loadConfig} is necessary but not sufficient:
 * `selfhost.bundle` is lexically fine, and git tracks symbolic links, so a pull
 * request could commit that name as a link to a file outside the tree — or make
 * an ancestor directory a link and keep a perfectly ordinary-looking
 * `generated/selfhost.bundle`. `writeFileSync` follows both, so the lexical rule
 * would pass while the write landed elsewhere.
 *
 * Resolution therefore happens against the filesystem: the containing directory
 * is fully resolved and must sit inside the resolved repository root, and the
 * target itself must not be a link. The returned path uses the physical parent
 * so publication and recovery use the same namespace.
 *
 * @param root - The repository root.
 * @param bundle - The configured, already lexically validated bundle path.
 * @returns The absolute path to write.
 * @throws Error When the target or an ancestor escapes the repository.
 */
export function resolveBundleTarget(root: string, bundle: string): string {
  const { target, observed } = resolveConfinedBundleTarget(root, bundle);
  assertBundleMayReplace(root, bundle, observed !== undefined);
  return target;
}

/** Check path confinement and leaf type before consulting publication recovery. */
function resolveConfinedBundleTarget(root: string, bundle: string): { target: string; observed: BigIntStats | undefined } {
  const target = join(root, bundle);
  const realRoot = realpathSync(root);
  let realParent: string;
  try {
    realParent = realpathSync(dirname(target));
  } catch {
    throw new Error(`self-host: the directory for ${bundle} does not exist under ${root}.`);
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw new Error(
      `self-host: ${bundle} resolves outside the repository (${realParent}). `
        + `Refusing to write through a symbolic link.`,
    );
  }
  const physicalTarget = join(realParent, basename(target));
  const observed = lstatSync(physicalTarget, { bigint: true, throwIfNoEntry: false });
  if (observed?.isSymbolicLink() === true) {
    throw new Error(
      `self-host: ${bundle} is a symbolic link. Refusing to write through it — `
        + `the bundle must be a regular file inside the repository.`,
    );
  }
  return { target: physicalTarget, observed };
}

/** Read replacement authority from the live Git index. */
function bundleIsTracked(root: string, bundle: string): boolean {
  return listTrackedFiles(root, [bundle]).includes(bundle);
}

/**
 * Require a live index entry to replace an existing bundle. A missing bundle can be bootstrapped,
 * and a retry may replace the exact file confirmed by its own recovery.
 */
function assertBundleMayReplace(root: string, bundle: string, exists: boolean, recoveredReplacement = false): void {
  if (exists && !recoveredReplacement && !bundleIsTracked(root, bundle)) {
    throw new Error(
      `self-host: ${bundle} exists but is not tracked by git. Refusing to overwrite it — `
        + `the bundle must be a tracked file, so this would clobber something else.`,
    );
  }
}

/** Preserve the owner, group and permission bits from one regular bundle observation. */
function bundlePermissions(stat: BigIntStats | undefined): { mode: number; uid: bigint; gid: bigint } | undefined {
  return stat?.isFile() ? { mode: Number(stat.mode & 0o7777n), uid: stat.uid, gid: stat.gid } : undefined;
}

/**
 * Rejects a configured path that is not confined to the repository.
 *
 * Absolute paths (POSIX and Windows drive/UNC forms) and any `..` segment are
 * refused. Normalising and re-checking would be weaker: `join` collapses
 * segments, so a value only has to *resolve* inside the tree to pass, and that
 * is a property of the current root rather than of the configuration.
 *
 * @param value - The configured path.
 * @param field - Field name, for the error message.
 * @throws Error When the path is absolute or escapes via `..`.
 */
function assertRepositoryRelative(value: string, field: string): void {
  const segments = value.split(/[/\\]/);
  const absolute = value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value);
  if (absolute || segments.includes("..")) {
    throw new Error(
      `self-host: configuration ${field} "${value}" must be a repository-relative path `
        + `without ".." segments.`,
    );
  }
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
  return store.withWriteLock(() => {
    const map = new Map<string, { id: ObjectId; mode: FileMode }>();
    for (const [path, file] of files) {
      map.set(path, { id: store.write("blob", file.content), mode: file.mode });
    }
    return buildTree(store, map);
  });
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
 * Byte-exactness normally follows from the root tree id: canonical trees hash
 * every name, mode and blob id, so equality covers content and mode
 * together. The path-by-path comparison also permits validated external action
 * revision updates; every other byte and every file mode remain significant.
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
  let actionRevisionsChanged = false;
  for (const path of [...sourceFlat.keys()].sort()) {
    const bundleEntry = bundleFlat.get(path);
    if (bundleEntry === undefined) continue;
    const sourceEntry = sourceFlat.get(path)!;
    if (sourceEntry.id !== bundleEntry.id) {
      if (sameWorkflowExceptActionRevisions(
        path, sourceStore.readTyped(sourceEntry.id, "blob"), bundleStore.readTyped(bundleEntry.id, "blob"),
      )) {
        actionRevisionsChanged = true;
      } else {
        problems.push(`${path}: content differs (source ${sourceEntry.id}, bundle ${bundleEntry.id}).`);
      }
    }
    if (sourceEntry.mode !== bundleEntry.mode) {
      problems.push(`${path}: mode differs (source ${sourceEntry.mode}, bundle ${bundleEntry.mode}).`);
    }
  }
  if (sourceTreeId !== tipTree && (!actionRevisionsChanged || problems.length > 0)) {
    problems.push(
      `the bundle's tip tree ${tipTree} is not byte-identical to the source tree ${sourceTreeId}.`,
    );
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Permit only immutable external action revision updates in workflow comparisons.
 * Both sides must retain a trusted owner, the same action path, a full SHA and
 * a version comment. All other bytes, including whitespace, remain significant.
 * Major/minor annotations are supported because Dependabot preserves them.
 * The archive still carries the original, independently hash-verified bytes.
 */
export function sameWorkflowExceptActionRevisions(path: string, source: Buffer, bundled: Buffer): boolean {
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return false;
  return workflowRevisionView(source) === workflowRevisionView(bundled);
}

/** Mask revisions only at real YAML job or step action references, never script text or inputs. */
function workflowRevisionView(content: Buffer): string {
  const text = content.toString("latin1");
  const document = parseDocument(text);
  if (document.errors.length > 0) return text;
  const actionOffsets = new Set<number>();
  visit(document, {
    Pair(_key, pair, path) {
      const keys = path.filter(isPair).map((parent) => isScalar(parent.key) ? parent.key.value : null);
      if (isScalar(pair.key) && pair.key.value === "uses" && isScalar(pair.value)
        && keys[0] === "jobs" && (keys.length === 2 || (keys.length === 3 && keys[2] === "steps"))) {
        actionOffsets.add(pair.value.range![0]);
      }
    },
  });
  return text.replace(
    /^([ \t]*(?:- +)?uses: +)((?:actions|github|oven-sh|dependabot|unbraind)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@)[0-9a-f]{40}([ \t]+#[ \t]+(?:v|pm-github ))[0-9]+(?:\.[0-9]+){0,2}(?=[ \t]*\r?$)/gm,
    (line: string, prefix: string, action: string, comment: string, offset: number) => actionOffsets.has(offset + prefix.length)
      ? prefix + action + "0".repeat(40) + comment + "0.0.0" : line,
  );
}

/**
 * Whether the committed bundle already is a bounded snapshot of exactly this
 * source tree, so regeneration can leave the file byte-untouched.
 *
 * Three things make a bundle "the same snapshot": it advertises the configured
 * ref, it carries exactly one commit — the advertised tip — with no
 * prerequisites behind it, and that commit's tree is the source tree. Anything
 * else is stale in one of two directions, and the two directions are treated
 * differently:
 *
 * - A bundle with the right ref but the wrong *shape* (a pre-bounding history
 *   bundle, a thin bundle declaring prerequisites, a ref pointing somewhere a
 *   snapshot would not) is regenerated, not reused. Reusing it would keep an
 *   unbounded artifact committed forever — its tip tree matches, so the no-op
 *   shortcut alone could never shrink it — and the bound is an invariant of the
 *   artifact, not a hope about how it was last written.
 * - A bundle that does not advertise the ref at all is not this gate's
 *   artifact, and the writer refuses rather than overwrite it: the file is
 *   supposed to be one specific thing, and silently replacing something else
 *   that happens to sit at its path is how an anomaly gets buried instead of
 *   investigated. Deleting the bundle deliberately is the documented remedy.
 *
 * Only the header and the object lines are inspected — the bundle is parsed
 * (which re-hashes nothing but validates structure and every advertised id)
 * rather than imported, because a superseded snapshot contributes nothing to
 * the next one and importing it would just hold its bytes in memory for no
 * decision.
 *
 * @param existingBundle - The committed bundle, never null at this call site.
 * @param ref - Full ref name the snapshot must advertise.
 * @param sourceTreeId - The tree id built from the current source.
 * @returns True when the committed bundle already proves this exact tree.
 * @throws Error When the bundle is malformed, or does not advertise the ref.
 */
export function snapshotIsUnchanged(
  existingBundle: Buffer,
  ref: string,
  sourceTreeId: ObjectId,
): boolean {
  const parsed = parseBundle(existingBundle);
  const tip = parsed.header.refs[ref];
  if (tip === undefined) {
    const advertised = Object.keys(parsed.header.refs).sort().join(", ") || "(none)";
    throw new Error(
      `self-host: the existing bundle does not advertise ${ref} (advertised: ${advertised}). `
        + `Refusing to overwrite a bundle that is not this gate's artifact — delete the bundle `
        + `deliberately if that is what you intend.`,
    );
  }
  const commits = parsed.lines.filter((line) => line.type === "commit");
  if (commits.length !== 1) return false;
  const commit = commits[0];
  if (commit.id !== tip) return false;
  if ((parsed.header.prerequisites ?? []).length > 0) return false;
  const decoded = decodeCommit(commit.payload);
  // A sole commit that still names a parent is not a bounded snapshot, even if its tree matches.
  return decoded.parents.length === 0 && decoded.tree === sourceTreeId;
}

/**
 * Regenerates the bundle as a bounded archive: one parentless commit naming
 * the current source tree, and nothing else.
 *
 * The superseded snapshot is discarded rather than appended to. Appending
 * kept every prior tree in the committed artifact — the gate compares tip
 * trees, so the accumulated history proved nothing extra while the file grew
 * without bound, which is the defect this exists to fix. A single commit is
 * still a complete pm-vcs repository: it verifies through the same import, the
 * same isolated store and the same ancestry walk the gate has always used,
 * because a parentless commit *is* a whole ancestry.
 *
 * When the committed bundle already is a bounded snapshot of exactly this
 * source tree, it is returned unchanged — regenerating from identical source
 * must not churn the file. Otherwise a fresh root commit is written with a
 * deterministic signature and message derived from the git commit, so two
 * runs over the same `HEAD` produce the same bytes.
 *
 * @param store - Object store holding the source tree.
 * @param refs - Ref store used to publish the tip for export.
 * @param existingBundle - The committed bundle, or null on the first run.
 * @param ref - The ref to publish the snapshot under.
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
  // Reuse only a bundle that is shaped as this snapshot AND passes the gate's own isolated verification,
  // so a snapshot missing any reachable object is rebuilt instead of being kept.
  if (existingBundle !== null && snapshotIsUnchanged(existingBundle, ref, sourceTreeId)
    && verifySelfHost(store, existingBundle, ref, sourceTreeId).ok) {
    return existingBundle;
  }
  const commit: Commit = {
    tree: sourceTreeId,
    parents: [],
    author: signature,
    committer: signature,
    message,
  };
  const tipId = writeCommit(store, commit);
  // The scratch ref store is fresh on a real run, so the expected value is the
  // ref's current state (null until something publishes it), not the previous
  // commit id. Comparing against anything else would make every run after the
  // first fail the swap, because a superseded snapshot is discarded, not
  // published into this ref store first.
  refs.compareAndSwap(ref, refs.read(ref), tipId);
  return exportBundle(store, refs, [ref]);
}

/**
 * Runs a git command in `cwd` and returns trimmed stdout, failing loudly.
 *
 * Exported so the gate's git interactions can be tested against a real
 * repository rather than a mock.
 */
export function runGit(cwd: string, args: readonly string[], environment = process.env): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...environment, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/**
 * Enumerates the caller's index without letting Git refresh its shared base.
 *
 * NUL-delimited (`-z`) rather than newline-delimited, because a newline is a
 * legal character in a git path. Splitting on `"\n"` would silently cut such a
 * path into two entries, and every one of them would then be compared against
 * the bundle under the wrong name — a gate that desynchronises its own path
 * list can report a mismatch that is not there, or miss one that is.
 */
export function listTrackedFiles(root: string, paths: readonly string[] = []): string[] {
  // Deliberately NOT `runGit`, which trims. `trim()` strips spaces and tabs from
  // the ends of the whole payload but leaves the trailing NUL, so a tracked path
  // like " leading.ts" comes back as "leading.ts" and is then compared against a
  // file that does not exist. Same class of bug as splitting on "\n": the
  // delimiter is NUL precisely so no byte of a path needs interpreting.
  const raw = withCapturedIndex(root, environment => execFileSync("git", ["--literal-pathspecs", "ls-files", "-z", "--", ...paths], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...isolatedPathspecEnvironment(environment), GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  }));
  return decodeGitListing(raw).split("\0").filter((line) => line.length > 0);
}

/** One leaf entry of a git tree listing: its mode, object id and path. */
export interface TreeEntry {
  /** Raw Git mode, including `160000` for a gitlink that configuration may exclude. */
  readonly mode: string;
  /** Object id recorded in the tree, including the commit id of a gitlink. */
  readonly sha: string;
  /** Canonical repository-relative path. */
  readonly path: string;
}

/** A tree's verification inputs: its configuration, raw blobs and source files. */
export interface TreeSnapshot {
  /** The gate configuration as staged or committed in the tree itself. */
  readonly config: SelfHostConfig;
  /** Every non-excluded source file: raw blob bytes and the tree-recorded mode. */
  readonly files: ReadonlyMap<string, SourceFile>;
  /** Raw bytes of the configuration, included source and requested verification bundle. */
  readonly blobs: ReadonlyMap<string, Buffer>;
}

/**
 * Enumerates every leaf of a git tree straight from the object database.
 *
 * NUL-delimited (`-z`) for the same reason {@link listTrackedFiles} is: a
 * newline is a legal byte in a git path, and this listing feeds a byte-exact
 * comparison, so paths retain all their bytes. The listing
 * retains unsupported modes until the snapshot configuration selects its inputs.
 *
 * @param root - The repository root.
 * @param treeish - A tree id (from `git write-tree`) or a committish such as `HEAD`.
 * @returns Every leaf entry, in the tree's own order.
 * @throws Error When git cannot list the tree, or a path cannot be represented losslessly.
 */
export function listTreeEntries(root: string, treeish: string, paths: readonly string[] = []): TreeEntry[] {
  const result = spawnSync("git", ["--literal-pathspecs", "ls-tree", "-r", "-z", treeish, "--", ...paths], {
    cwd: root, maxBuffer: 64 * 1024 * 1024,
    // The literal matching above is the tool's choice, so the child environment
    // carries no ambient pathspec setting that git would either combine into a
    // fatal error or substitute for it.
    env: isolatedPathspecEnvironment(process.env),
  });
  if (result.error) throw new Error(`self-host: could not run git: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`self-host: git ls-tree failed: ${result.stderr.toString("utf8").trim()}`);
  const entries: TreeEntry[] = [];
  for (const record of decodeGitListing(result.stdout).split("\0")) {
    if (record.length === 0) continue;
    // git's `-z` format is \`<mode> <type> <sha>\\t<path>\`; the tab is structural.
    const tab = record.indexOf("\t");
    const [mode, , sha] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    entries.push({ mode, sha, path });
  }
  return entries;
}

/** Consume exactly one batch frame per request, retaining only the requested blob contents. */
class BlobBatch {
  private readonly blobs = new Map<string, Buffer>();
  private readonly entries: readonly TreeEntry[];
  private position = 0;
  private header = Buffer.alloc(0);
  private remaining: number | undefined;
  private chunks: Buffer[] = [];

  /** Bind responses to the ordered object ids in the frozen listing. */
  constructor(entries: readonly TreeEntry[]) {
    this.entries = entries;
  }

  /** Consume arbitrary transport chunks, including split headers, binary payloads and split separators. */
  consume(chunk: Buffer): void {
    while (chunk.length > 0) {
      const entry = this.entries[this.position];
      if (!entry) throw new Error("self-host: git cat-file returned unrequested trailing bytes.");
      if (this.remaining === undefined) {
        const newline = chunk.indexOf(0x0a);
        const headerBytes = newline < 0 ? chunk.length : newline;
        // The longest valid header ends with the decimal form of a safe integer.
        if (this.header.length + headerBytes > entry.sha.length + " blob ".length + String(Number.MAX_SAFE_INTEGER).length) {
          throw new Error(`self-host: git cat-file returned an oversized header for ${entry.path} (${entry.sha}).`);
        }
        if (newline < 0) {
          this.header = Buffer.concat([this.header, chunk]);
          return;
        }
        const header = Buffer.concat([this.header, chunk.subarray(0, newline)]).toString("latin1");
        const fields = header.split(" ");
        const [sha, type, sizeText] = fields;
        const size = Number(sizeText);
        if (fields.length !== 3 || sha !== entry.sha || type !== "blob" || !/^[0-9]+$/u.test(sizeText)
          || !Number.isSafeInteger(size)) {
          throw new Error(`self-host: git cat-file returned an invalid header for ${entry.path} (${entry.sha}).`);
        }
        this.remaining = size;
        this.header = Buffer.alloc(0);
        chunk = chunk.subarray(newline + 1);
      }
      const take = Math.min(this.remaining, chunk.length);
      this.chunks.push(chunk.subarray(0, take));
      this.remaining -= take;
      chunk = chunk.subarray(take);
      if (chunk.length === 0) return;
      if (chunk[0] !== 0x0a) {
        throw new Error(`self-host: git cat-file omitted the separator for ${entry.path} (${entry.sha}).`);
      }
      this.blobs.set(entry.path, Buffer.concat(this.chunks));
      this.position++;
      this.chunks = [];
      this.remaining = undefined;
      chunk = chunk.subarray(1);
    }
  }

  /** Reject a partial final response or a missing response before exposing any contents. */
  finish(): Map<string, Buffer> {
    const pending = this.entries[this.position];
    if (pending) throw new Error(`self-host: git cat-file ended before answering for ${pending.path} (${pending.sha}).`);
    return this.blobs;
  }
}

/** Parse captured batch data with the same framing checks used on live subprocess chunks. */
export function parseBatchResponse(output: Buffer | readonly Buffer[], entries: readonly TreeEntry[]): Map<string, Buffer> {
  const batch = new BlobBatch(entries);
  for (const chunk of Buffer.isBuffer(output) ? [output] : output) batch.consume(chunk);
  return batch.finish();
}

/** Stream the selected object ids through Git without a shared payload buffer or checkout filters. */
export async function readTreeBlobs(root: string, entries: readonly TreeEntry[]): Promise<Map<string, Buffer>> {
  const batch = new BlobBatch(entries);
  if (entries.length > 0) {
    await streamProcess("git", ["cat-file", "--batch"], {
      cwd: root, env: { ...process.env }, input: entries.map(entry => entry.sha + "\n").join(""), timeoutMs: 120_000,
    }, chunk => batch.consume(chunk));
  }
  return batch.finish();
}

/**
 * Reads a tree's verification inputs straight from git's object database.
 *
 * Shared by the staged writer and the check, so both derive the configuration,
 * the source files and (for the check) the committed bundle from the same
 * conversion-free source of truth: the bytes the tree actually stores. The
 * configuration must come from the tree, never the working file — a staged run
 * may leave an entirely different file on disk — and the mode comes from the
 * tree rather than the filesystem, so the executable bit is what git recorded,
 * not what a checkout happened to write. A symbolic link (`120000`) stores its
 * target text as blob content; the reader keeps the historical bytes such a
 * link always contributed: the target text as a non-executable file.
 *
 * @param root - The repository root.
 * @param treeish - A tree id (from `git write-tree`) or a committish such as `HEAD`.
 * @param includeBundle - Request the archive for verification. The staged writer reuses the archive from HEAD.
 * @returns The tree's configuration, source files and required raw blobs.
 * @throws Error When the tree cannot be listed, a blob is missing, the tree
 *   does not carry the configuration, or the configuration is invalid.
 */
export async function readTreeSnapshot(root: string, treeish: string, includeBundle = true): Promise<TreeSnapshot> {
  const entries = listTreeEntries(root, treeish);
  const configuration = entries.find(entry => entry.path === SELF_HOST_CONFIG);
  if (!configuration) {
    throw new Error(`self-host: ${treeish} does not carry ${SELF_HOST_CONFIG}; the gate cannot be configured from it.`);
  }
  if (configuration.mode !== "100644" && configuration.mode !== "100755") {
    throw new Error("self-host: configuration must be a regular file.");
  }
  const configBlob = (await readTreeBlobs(root, [configuration])).get(SELF_HOST_CONFIG)!;
  const config = parseSelfHostConfig(configBlob.toString("utf8"));
  const source = entries.filter(entry => !isExcluded(entry.path, config.exclude));
  const selected = entries.filter(entry => entry !== configuration && (entry.path === config.bundle
    ? includeBundle : !isExcluded(entry.path, config.exclude)));
  for (const entry of selected) {
    if (entry.mode !== "100644" && entry.mode !== "100755" && entry.mode !== "120000") {
      throw new Error(`self-host: unsupported mode ${entry.mode} for ${entry.path}; exclude gitlinks explicitly.`);
    }
  }
  const blobs = await readTreeBlobs(root, selected);
  blobs.set(SELF_HOST_CONFIG, configBlob);
  const files = new Map<string, SourceFile>();
  for (const entry of source) {
    files.set(entry.path, { content: blobs.get(entry.path)!, mode: entry.mode === "100755" ? "100755" : "100644" });
  }
  return { config, files, blobs };
}

/**
 * Reads the committed bytes of a tracked file at `HEAD`, or null when absent
 * or when the prior entry is a gitlink with no reusable archive.
 *
 * An empty path lookup means the file is absent. Listing and blob read errors propagate.
 */
export async function readCommittedFile(root: string, path: string): Promise<Buffer | null> {
  const entry = listTreeEntries(root, "HEAD", [path]).find(entry => entry.path === path);
  return entry && entry.mode !== "160000" ? (await readTreeBlobs(root, [entry])).get(path)! : null;
}

/**
 * Capture each non-excluded working path with its leaf type and mode. Only
 * regular captured bytes go through Git's clean conversion check; symlinks
 * contribute their raw link text.
 *
 * @param root - Directory holding the working source.
 * @param tracked - Paths reported by `git ls-files`.
 * @param exclude - The exclusion list.
 * @param configuration - The configuration the working writer already observed.
 * @returns Path to content and mode for every source file.
 * @throws Error When a tracked, non-excluded path is missing from `root` — the
 *   one way a path silently disappears — or changed while it was being read,
 *   because bytes captured across a replacement cannot be classified. Converted
 *   content requires the staged writer.
 */
export function readSourceFiles(
  root: string,
  tracked: readonly string[],
  exclude: readonly string[],
  configuration?: SourceFile,
): Map<string, SourceFile> {
  const files = new Map<string, SourceFile>();
  const regular: string[] = [];
  for (const path of tracked) {
    if (path === SELF_HOST_CONFIG && configuration !== undefined) {
      files.set(path, configuration);
      regular.push(path);
      continue;
    }
    if (path !== SELF_HOST_CONFIG && isExcluded(path, exclude)) continue;
    const absolute = join(root, ...path.split("/"));
    let before: BigIntStats;
    let content: Buffer | undefined;
    try {
      before = fs.lstatSync(absolute, { bigint: true });
      content = readStableSourceBytes(absolute, before);
    } catch (error) {
      throw new Error(
        `self-host: tracked path ${path} is absent from ${root} (deleted from the working tree?): ${errorMessage(error)}`,
      );
    }
    if (content === undefined) {
      throw new Error(`self-host: tracked path ${path} changed while it was being read; run the write again.`);
    }
    const symbolicLink = before.isSymbolicLink();
    if (!symbolicLink) regular.push(path);
    const executable = !symbolicLink && (before.mode & 0o100n) !== 0n;
    files.set(path, { content, mode: executable ? "100755" : "100644" });
  }
  if (regular.length > 0) {
    assertUnconvertedFiles(root, regular, files);
  }
  if (isExcluded(SELF_HOST_CONFIG, exclude)) files.delete(SELF_HOST_CONFIG);
  return files;
}

/** Ask Git to apply staging-time conversion checks to the captured bytes. */
function assertUnconvertedFiles(root: string, paths: readonly string[], files: ReadonlyMap<string, SourceFile>): void {
  const algorithm = runGit(root, ["rev-parse", "--show-object-format"]);
  const objects = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-git-objects-"));
  try {
    for (const path of paths) {
      const bytes = files.get(path)!.content;
      const raw = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      // Without -w, Git can report a conversion error and hash the raw bytes.
      const clean = childProcess.execFileSync("git", ["hash-object", "-w", "--stdin", `--path=${path}`], {
        cwd: root, input: bytes, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        env: { ...process.env, GIT_OBJECT_DIRECTORY: objects },
      }).trim();
      if (clean !== raw) throw new Error(`self-host: Git converts ${path}. Stage the candidate and run --write --staged.`);
    }
  } finally {
    durability.discardTemporary(objects);
  }
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
      durability.discardTemporary(dir);
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

/** Read a fixed-size journal observation. The engine still parses and authorizes the replay. */
function readBootstrapJournal(path: string, observed: BigIntStats): Pick<DestructionReceipt, "id" | "status" | "entries"> {
  assertVerificationBound("receipts", "record_bytes", Number(observed.size), verificationLimits.receiptBytes);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(statIdentity(opened), statIdentity(observed))) {
      throw new Error("self-host: the bootstrap journal changed before it was read.");
    }
    const bytes = Buffer.alloc(Number(observed.size));
    if (fs.readSync(fd, bytes) !== bytes.length || !sameFileIdentity(statIdentity(opened), statIdentity(fs.fstatSync(fd, { bigint: true })))) {
      throw new Error("self-host: the bootstrap journal changed while it was read.");
    }
    return JSON.parse(bytes.toString("utf8")) as Pick<DestructionReceipt, "id" | "status" | "entries">;
  } finally {
    fs.closeSync(fd);
  }
}

/** Use the namespace journal's inode stamp, whose last field may change across a rename. */
function publicationIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** Compare the five fields that survive a rename. */
function movedPublicationIdentity(identity: string): string {
  return identity.split(":").slice(0, 5).join(":");
}

/** Hash the published bundle through its pinned descriptor with fixed-size reads. */
function hashPublishedBundle(fd: number): string {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(64 * 1024);
  let count: number;
  while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, count));
  return hash.digest("hex");
}

/** Locate an exact bootstrap journal and its candidate, which may already be at the destination. */
function selectBootstrapPublication(control: string, destination: string, bundle: BigIntStats | undefined) {
  const directory = dirname(destination);
  const prefix = `.${basename(destination)}.pm-vcs-`;
  const candidates = new Map<string, BigIntStats>();
  const keys = [`publication:${destination}`];
  for (const name of bundle === undefined ? fs.readdirSync(directory) : []) {
    if (!name.startsWith(prefix)) continue;
    const path = join(directory, name);
    const expected = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!expected?.isFile() || expected.nlink !== 1n) continue;
    candidates.set(path, expected);
    const legacy = `rename:${path}:${destination}`;
    keys.push(`${legacy}:${publicationIdentity(expected)}`, legacy);
  }
  // The engine keeps publication journals outside the repository and keys
  // them by the canonical namespace root and destination (older keys name
  // the source as well). Read only those exact record names.
  const ledger = join(tmpdir(), `pm-vcs-namespace-${createHash("sha256").update(control).digest("hex")}`);
  // The engine applies the same ownership rule on replay. Check the outer
  // directory first because a foreign private ledger blocks its child lookup.
  const owner = fs.lstatSync(ledger, { throwIfNoEntry: false });
  if (owner !== undefined && (!owner.isDirectory()
      || typeof process.getuid === "function" && (owner.uid !== process.getuid() || (owner.mode & 0o022) !== 0))) {
    throw new DestructionRefusal("foreign_destructive_intent", "An unowned or shared-writable namespace ledger was preserved.");
  }
  for (const key of keys) {
    const journal = join(ledger, "destruction", `${createHash("sha256").update(`${control}\0${key}`).digest("hex")}.json`);
    const observed = fs.lstatSync(journal, { bigint: true, throwIfNoEntry: false });
    if (observed === undefined) continue;
    const record = readBootstrapJournal(journal, observed);
    const entry = record.entries?.[0];
    // Staging a replacement can fail after recovery has completed the move.
    // Keep that receipt usable while the exact bootstrap inode is still here.
    if (entry?.kind !== "rename" || entry.destination === undefined || resolve(control, entry.destination) !== destination
        || !(record.status === "pending" && entry.status === "planned"
          || bundle !== undefined && record.status === "completed" && entry.status === "moved")) return undefined;
    const path = resolve(control, entry.path);
    if (bundle !== undefined) {
      const matches = bundle.isFile() && bundle.nlink === 1n && entry.target === "absent"
        && dirname(path) === directory && basename(path).startsWith(prefix)
        && movedPublicationIdentity(publicationIdentity(bundle)) === movedPublicationIdentity(entry.identity);
      // A saved move records the outcome at the rename boundary. Verify the
      // current bytes before using it to authorize replacement of an untracked file.
      if (!matches || readRegularFile(destination, bundle, false, hashPublishedBundle).content !== entry.digest) return undefined;
      return { journal, observed, id: record.id, path, expected: undefined };
    }
    const expected = candidates.get(path);
    return expected !== undefined && publicationIdentity(expected) === entry.identity
      ? { journal, observed, id: record.id, path, expected } : undefined;
  }
  return undefined;
}

/** Replay or acknowledge a bootstrap with a receipt for the exact candidate that moved. */
function recoverBootstrapBundle(target: string, bundle: BigIntStats | undefined): BigIntStats | undefined {
  const directory = dirname(target);
  const control = realpathSync(namespacePublicationContext(target)?.control ?? directory);
  const destination = join(realpathSync(directory), basename(target));
  const candidate = selectBootstrapPublication(control, destination, bundle);
  if (candidate === undefined) {
    if (bundle === undefined) durability.recoverPublication(target);
    return undefined;
  }
  // Keep the selected journal pinned through the engine's lease and rename
  // validation. The engine checks the recovered candidate's identity and
  // streaming digest against the journal independently of its byte limit.
  const receipt = retireNamespace({ path: candidate.path, expected: candidate.expected, destination: target }, false, () => {
    const current = lstatSync(candidate.journal, { bigint: true, throwIfNoEntry: false });
    if (current === undefined || !sameFileIdentity(statIdentity(current), statIdentity(candidate.observed))) {
      throw new Error("self-host: the bootstrap journal changed before recovery.");
    }
    if (bundle !== undefined && lstatSync(candidate.path, { throwIfNoEntry: false }) !== undefined) {
      throw new Error("self-host: the bootstrap temporary reappeared before recovery.");
    }
  });
  const published = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (!published?.isFile() || receipt.status !== "completed" || receipt.id !== candidate.id) return undefined;
  // Rename can change ctime. The other identity fields still name the moved inode.
  const movedIdentity = movedPublicationIdentity(publicationIdentity(published));
  return receipt.entries.some(entry => entry.kind === "rename" && entry.status === "moved"
    && entry.destination !== undefined && resolve(control, entry.destination) === destination
    && resolve(control, entry.path) === candidate.path
    && movedPublicationIdentity(entry.identity) === movedIdentity) ? published : undefined;
}

/** Recover under the engine's private ledger ownership rules and give operators a retry path. */
function recoverBundlePublication(root: string, bundle: string, target: string, observed: BigIntStats | undefined): BigIntStats | undefined {
  try {
    if (observed === undefined || !bundleIsTracked(root, bundle)) return recoverBootstrapBundle(target, observed);
    durability.recoverPublication(target);
    return undefined;
  } catch (error) {
    if (!(error instanceof DestructionRefusal) || error.code !== "foreign_destructive_intent") throw error;
    throw Object.assign(new Error(
      `self-host: ${error.message} If another user owns the publication ledger, run regeneration as the ledger-owning UID.`,
      { cause: error },
    ), { code: error.code });
  }
}

/**
 * Writes the bundle for the supplied source and skips an identical artifact.
 *
 * The caller decides where the source bytes come from: the working tree (the
 * legacy `--write` mode) or the frozen Git index (`--staged`). The previous
 * snapshot comes from the committed bundle through {@link readCommittedFile}.
 * Publication uses the live index for replacement permission. "Unchanged" is decided from one stable
 * observation of that target, and the write itself lands through a rename so a
 * replacement at the path is replaced rather than followed. A pending publication
 * left by an interrupted write is reconciled before a new candidate is created.
 * Regeneration uses the UID that owns the private publication ledger.
 */
async function writeSnapshot(root: string, config: SelfHostConfig, files: ReadonlyMap<string, SourceFile>): Promise<void> {
  const { store, refs, cleanup } = freshStore();
  try {
    const sourceTreeId = buildSourceTree(store, files);
    const existingBundle = await readCommittedFile(root, config.bundle);
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
    const { target, observed: beforeRecovery } = resolveConfinedBundleTarget(root, config.bundle);
    // An interrupted bootstrap can leave the candidate at either name. A
    // receipt for that exact inode can also survive a failed replacement.
    const publication = recoverBundlePublication(root, config.bundle, target, beforeRecovery);
    const before = beforeRecovery ?? fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
    const recovered = publication !== undefined && before !== undefined
      && sameFileIdentity(statIdentity(publication), statIdentity(before));
    assertBundleMayReplace(root, config.bundle, before !== undefined, recovered);
    if (before?.isFile() && before.size === BigInt(bytes.length) && readStableSourceBytes(target, before)?.equals(bytes)) {
      console.log(recovered
        ? `self-host: recovered publication of ${config.bundle} (${bytes.length} bytes)`
        : `self-host: ${config.bundle} is unchanged`);
      return;
    }
    // Write through a same-directory temporary and rename over the target
    // through the engine's durability policy: a rename replaces whatever sits
    // at the path, where a direct write would follow a symbolic link that
    // landed there after the checks above and corrupt the file it points at.
    const temporary = join(dirname(target), `.${basename(target)}.pm-vcs-${randomUUID()}`);
    const permissions = bundlePermissions(before);
    const fd = fs.openSync(temporary, "wx", permissions === undefined ? undefined : 0o600);
    try {
      let expected: BigIntStats;
      try {
        fs.writeFileSync(fd, bytes);
        if (permissions !== undefined) {
          const { uid, gid } = fs.fstatSync(fd, { bigint: true });
          // A privileged regenerator owns the temporary as itself; restoring
          // only the group would leave the bundle owned by that identity, so
          // both ids move back before the mode. A refusal propagates and the
          // original bundle stays in place.
          if (uid !== permissions.uid || gid !== permissions.gid) fs.fchownSync(fd, Number(permissions.uid), Number(permissions.gid));
          fs.fchmodSync(fd, permissions.mode);
        }
        expected = fs.fstatSync(fd, { bigint: true });
        const applied = bundlePermissions(expected);
        if (permissions !== undefined && (applied?.mode !== permissions.mode
          || applied?.uid !== permissions.uid || applied?.gid !== permissions.gid)) {
          throw new Error(`self-host: could not preserve the permissions of ${config.bundle}. The existing bundle was left in place.`);
        }
      } finally {
        fs.closeSync(fd);
      }
      /** Recheck publication authority before the journal starts and at the rename boundary. */
      const validate = (): void => {
        const current = lstatSync(target, { bigint: true, throwIfNoEntry: false });
        // Only the file this run's own recovery confirmed may be replaced
        // while untracked; any other untracked file at the target stays refused.
        const replacesRecovery = recovered && before !== undefined && current !== undefined
          && sameFileIdentity(statIdentity(current), statIdentity(before));
        assertBundleMayReplace(root, config.bundle, current !== undefined, replacesRecovery);
        const atPublication = bundlePermissions(current);
        if (atPublication !== undefined && (atPublication.mode !== permissions?.mode || atPublication.uid !== permissions?.uid || atPublication.gid !== permissions.gid)) {
          throw new Error(`self-host: ${config.bundle} permissions changed before publication. Run the write again.`);
        }
      };
      validate();
      // The namespace journal can flush an already read-only source. The
      // durability.rename convenience method first reopens its source for writing.
      const receipt = retireNamespace({ path: temporary, destination: target, expected }, false, validate);
      // A completed receipt with no move means the temporary vanished without
      // the rename landing — for example a cleanup race after the journal
      // captured the source. The previous bundle is then still in place, and
      // reporting a write would hide the failure.
      if (!receipt.entries.some(entry => entry.status === "moved")) {
        throw new Error(`self-host: publication of ${config.bundle} did not complete; ${config.bundle} keeps its previous bytes. Run the write again.`);
      }
    } finally {
      durability.discardTemporary(temporary);
    }
    console.log(`self-host: wrote ${config.bundle} (${bytes.length} bytes)`);
  } finally {
    cleanup();
  }
}

/** Read a Git administrative pathname losslessly, keeping any significant whitespace. */
function gitPath(root: string, ...args: string[]): string {
  const bytes = execFileSync("git", ["rev-parse", ...args], { cwd: root, env: { ...process.env } });
  return decodeGitListing(bytes).replace(/\n$/u, "");
}

/** Capture a Git index file, allowing Git's ordinary symlink lookup. */
function captureIndexFile(path: string): Buffer {
  const before = fs.statSync(path, { bigint: true });
  const bytes = before.isFile() ? readStableSourceBytes(path, before, true) : undefined;
  if (bytes === undefined) throw new Error("self-host: expected a stable, regular Git index file.");
  return bytes;
}

/**
 * Locate the split-index dependency in captured DIRC bytes. Git's
 * `--shared-index-path` itself needs the base, so it cannot discover it from
 * the private index before the base is copied. Git still validates the full
 * index and the split overlay when it writes the tree.
 *
 * @see https://git-scm.com/docs/gitformat-index
 */
function sharedIndexName(index: Buffer, hashSize: number): string | undefined {
  const end = index.length - hashSize;
  const version = index.readUInt32BE(4);
  const count = index.readUInt32BE(8);
  if (index.toString("latin1", 0, 4) !== "DIRC" || version < 2 || version > 4) {
    throw new Error("self-host: unsupported Git index header.");
  }
  let offset = 12;
  for (let entry = 0; entry < count; ++entry) {
    const flags = index.readUInt16BE(offset + 40 + hashSize);
    let name = offset + 42 + hashSize + ((flags & 0x4000) === 0 ? 0 : 2);
    if (version === 4) {
      // The prefix-reuse count is a varint. Only its byte width matters here.
      while ((index.readUInt8(name++) & 0x80) !== 0) { /* skip continuation bytes */ }
    }
    const nul = index.indexOf(0, name);
    if (nul < 0 || nul >= end) throw new Error("self-host: unterminated Git index pathname.");
    const entrySize = nul + 1 - offset;
    offset += version === 4 ? entrySize : Math.ceil(entrySize / 8) * 8;
  }
  while (offset < end) {
    const signature = index.toString("latin1", offset, offset + 4);
    const size = index.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > end || (signature === "link" && size < hashSize)) {
      throw new Error("self-host: invalid Git index extension length.");
    }
    if (signature === "link") {
      const oid = index.toString("hex", offset, offset + hashSize);
      return /^0+$/u.test(oid) ? undefined : `sharedindex.${oid}`;
    }
    offset += size;
  }
  return undefined;
}

/** Read the one base Git would use, preferring its per-worktree Git directory. */
function captureSharedIndex(root: string, index: string, base: string): Buffer {
  const primary = join(gitPath(root, "--absolute-git-dir"), base);
  try {
    return captureIndexFile(primary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return captureIndexFile(`${dirname(index)}${sep}${base}`);
  }
}

/** Run a Git operation against a private copy of the selected index and required split base. */
function withCapturedIndex<T>(root: string, action: (environment: NodeJS.ProcessEnv) => T): T {
  // Git's default spelling preserves the selected index symlink. Its directory
  // is the base fallback, even when opening the index follows the link elsewhere.
  const selected = gitPath(root, "--git-path", "index");
  const index = isAbsolute(selected) ? selected : `${root}${sep}${selected}`;
  const scratch = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-index-"));
  try {
    const copy = join(scratch, "index");
    const indexEnv = { ...process.env, GIT_INDEX_FILE: copy };
    if (lstatSync(index, { throwIfNoEntry: false }) === undefined) return action(indexEnv);
    const bytes = captureIndexFile(index);
    const hashSize = createHash(runGit(root, ["rev-parse", "--show-object-format"])).digest().length;
    const base = sharedIndexName(bytes, hashSize);
    writeFileSync(copy, bytes);
    if (base !== undefined) {
      writeFileSync(join(scratch, base), captureSharedIndex(root, index, base));
      // Git prefers a base in GIT_DIR, so direct its lookup and mtime update
      // to the captured copy while retaining the original common object store.
      writeFileSync(join(scratch, "HEAD"), "ref: refs/heads/self-host\n");
      Object.assign(indexEnv, {
        GIT_DIR: scratch,
        GIT_COMMON_DIR: gitPath(root, "--path-format=absolute", "--git-common-dir"),
        GIT_WORK_TREE: root,
      });
    }
    return action(indexEnv);
  } finally {
    durability.discardTemporary(scratch);
  }
}

/** Freeze the selected index before reading the staged tree from Git objects. */
async function writeStagedSnapshot(root: string): Promise<void> {
  const tree = withCapturedIndex(root, environment => runGit(root, ["-c", "core.splitIndex=false", "write-tree"], environment));
  const snapshot = await readTreeSnapshot(root, tree, false);
  await writeSnapshot(root, snapshot.config, snapshot.files);
}

/** Verifies committed HEAD by default, or writes from working or staged source. */
export async function main(root: string, args: readonly string[]): Promise<void> {
  if (args.includes("--write")) {
    if (args.includes("--staged")) await writeStagedSnapshot(root);
    else {
      const tracked = listTrackedFiles(root);
      if (!tracked.includes(SELF_HOST_CONFIG)) throw new Error("self-host: the configuration must be tracked.");
      const { config, source } = captureWorkingConfig(join(root, SELF_HOST_CONFIG));
      await writeSnapshot(root, config, readSourceFiles(root, tracked, config.exclude, source));
    }
    return;
  }

  const { store, cleanup } = freshStore();
  try {
    // EVERY verification input comes from HEAD's object database, not from `root`.
    //
    // The gate used to extract HEAD through `git worktree add` and read the
    // files that checkout produced. A checkout applies the host's conversion
    // rules — `core.autocrlf`, `eol` attributes, filter drivers — so one
    // machine could read the same commit as CRLF and reject a bundle another
    // machine accepted. `ls-tree` and `cat-file` return stored bytes exactly
    // as git hashes them: an uncommitted edit, a staged change, or a
    // line-ending preference can no longer move what the gate compares, which
    // is the property this gate advertises that it has.
    const snapshot = await readTreeSnapshot(root, "HEAD");
    const sourceTreeId = buildSourceTree(store, snapshot.files);
    const bundleBytes = snapshot.blobs.get(snapshot.config.bundle) ?? null;
    if (bundleBytes === null) {
      throw new Error(
        `self-host: no committed bundle at HEAD:${snapshot.config.bundle}. Run \`npm run self-host:write -- --staged\` and commit ${snapshot.config.bundle}.`,
      );
    }
    const result = verifySelfHost(store, bundleBytes, snapshot.config.ref, sourceTreeId);
    if (!result.ok) {
      console.error("self-host: the bundle's tip tree is not byte-identical to the committed source.");
      for (const problem of result.problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    // Confirm the bundle's self-description is parseable on its own, which is the
    // explicit re-hash of every object against its own id that point 3 requires.
    parseBundle(bundleBytes);
    console.log("self-host: the committed bundle's tip tree is byte-identical to the committed source except validated external action revisions.");
  } finally {
    cleanup();
  }
}

if (isMainInvocation(process.argv, import.meta.url)) await main(resolve(import.meta.dirname, ".."), process.argv);
