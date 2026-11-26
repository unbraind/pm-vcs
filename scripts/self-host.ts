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

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isPair, isScalar, parseDocument, visit } from "yaml";
import { isMainInvocation } from "./main-invocation.ts";

export { isMainInvocation };

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
  decodeCommit,
  readCommit,
  writeCommit,
} from "../engine/model.ts";
import { RefStore } from "../engine/refs.ts";
import { buildTree, flattenTree, readWorkingFile } from "../engine/worktree.ts";

/** Path to the gate's data file, relative to the package root. */
export const SELF_HOST_CONFIG = "self-host.json";

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
 * @throws Error When the file is missing or its shape is not a `SelfHostConfig`.
 */
export function loadConfig(path: string): SelfHostConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`self-host: could not read configuration at ${path}.`);
  }
  return parseSelfHostConfig(raw);
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
 * target itself must not be a link. Nothing here is normalised away — a link is
 * refused rather than silently followed to wherever it happens to point.
 *
 * @param root - The repository root.
 * @param bundle - The configured, already lexically validated bundle path.
 * @returns The absolute path to write.
 * @throws Error When the target or an ancestor escapes the repository.
 */
export function resolveBundleTarget(root: string, bundle: string): string {
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
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw new Error(
      `self-host: ${bundle} is a symbolic link. Refusing to write through it — `
        + `the bundle must be a regular file inside the repository.`,
    );
  }
  // Staying inside the repository is not enough. Every check above still permits
  // `"bundle": ".git/config"` or `"bundle": ".env"` — lexically relative, not a
  // link, comfortably inside the tree — and `--write` would overwrite the
  // maintainer's git configuration, or an ignored local secret, with bundle
  // bytes. The config arrives with the source, so that is a write primitive a
  // pull request could aim.
  //
  // The real invariant is what the bundle *is*: tracked source. So it must
  // already be tracked, or not exist yet (the bootstrap case, where this run
  // creates it). An existing untracked file is never a legitimate target, which
  // is exactly what `.git/config` and `.env` are.
  const exists = lstatSync(target, { throwIfNoEntry: false }) !== undefined;
  if (exists && !listTrackedFiles(root).includes(bundle)) {
    throw new Error(
      `self-host: ${bundle} exists but is not tracked by git. Refusing to overwrite it — `
        + `the bundle must be a tracked file, so this would clobber something else.`,
    );
  }
  return target;
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
 * Enumerates the git-tracked source: every path `git ls-files` reports.
 *
 * NUL-delimited (`-z`) rather than newline-delimited, because a newline is a
 * legal character in a git path. Splitting on `"\n"` would silently cut such a
 * path into two entries, and every one of them would then be compared against
 * the bundle under the wrong name — a gate that desynchronises its own path
 * list can report a mismatch that is not there, or miss one that is.
 */
export function listTrackedFiles(root: string, environment = process.env): string[] {
  // Deliberately NOT `runGit`, which trims. `trim()` strips spaces and tabs from
  // the ends of the whole payload but leaves the trailing NUL, so a tracked path
  // like " leading.ts" comes back as "leading.ts" and is then compared against a
  // file that does not exist. Same class of bug as splitting on "\n": the
  // delimiter is NUL precisely so no byte of a path needs interpreting.
  const raw = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...environment, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  });
  return raw.split("\0").filter((line) => line.length > 0);
}

/** One leaf entry of a git tree listing: its mode, object id and path. */
export interface TreeEntry {
  /** Git tree mode: `100644`, `100755`, or `120000` for a symbolic link. */
  readonly mode: "100644" | "100755" | "120000";
  /** Object id of the entry's blob, exactly as the tree records it. */
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
  /** Raw blob bytes for every entry in the tree, keyed by path, before exclusion. */
  readonly blobs: ReadonlyMap<string, Buffer>;
}

/**
 * Enumerates every leaf of a git tree straight from the object database.
 *
 * NUL-delimited (`-z`) for the same reason {@link listTrackedFiles} is: a
 * newline is a legal byte in a git path, and this listing feeds a byte-exact
 * comparison, so no byte of a path may be read as a delimiter. The listing is
 * also where gitlink entries are rejected: a submodule records a commit id, not
 * content, so no bundle built over it could ever be byte-identical to anything
 * this gate verifies, and failing here names the path instead of letting a
 * checkout materialize an empty directory the reader would only trip over.
 *
 * @param root - The repository root.
 * @param treeish - A tree id (from `git write-tree`) or a committish such as `HEAD`.
 * @returns Every leaf entry, in the tree's own order.
 * @throws Error When git cannot list the tree, or the tree carries an entry
 *   that is not an ordinary blob or symbolic link.
 */
export function listTreeEntries(root: string, treeish: string): TreeEntry[] {
  // Deliberately NOT `runGit`, which trims: the listing is NUL-delimited, and
  // trimming the payload would be one more place a path byte gets interpreted.
  const raw = execFileSync("git", ["ls-tree", "-r", "-z", treeish], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  });
  const entries: TreeEntry[] = [];
  for (const record of raw.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    const head = tab < 0 ? "" : record.slice(0, tab);
    const [mode, type, sha] = head.split(" ");
    const path = tab < 0 ? "" : record.slice(tab + 1);
    if (tab < 0 || path.length === 0 || (mode !== "100644" && mode !== "100755" && mode !== "120000")) {
      throw new Error(
        `self-host: ${treeish} carries "${path}" as a ${type} entry (mode ${mode}); `
        + `the bundle covers ordinary blobs, and a gitlink records a commit, not content.`,
      );
    }
    entries.push({ mode, sha, path });
  }
  return entries;
}

/**
 * Reads every entry's blob bytes straight from git's object database.
 *
 * One `git cat-file --batch` process serves the whole tree, and `cat-file`
 * returns stored bytes exactly as git hashes them: it applies none of the
 * checkout conversions — `core.autocrlf`, `eol` attributes, filter drivers —
 * that a working-tree materialization would. That is the whole point. A
 * checkout-based reader (`read-tree -u`, `worktree add`) smudges LF blobs into
 * CRLF on a conversion-enabled host, so the writer would archive bytes the
 * committed tree never stored and the check would read bytes the commit never
 * recorded; the same commit then verified differently on different machines.
 * Reading the object database is the only source whose bytes are identical to
 * what the tree being committed actually is.
 *
 * @param root - The repository root.
 * @param entries - The tree listing to read, from {@link listTreeEntries}.
 * @returns Raw blob bytes keyed by path, one entry per listing entry.
 * @throws Error When git cannot be run, reports a missing object, or answers
 *   out of order — every one of which names the path at fault.
 */
export function readTreeBlobs(root: string, entries: readonly TreeEntry[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  if (entries.length === 0) return blobs;
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: entries.map((entry) => `${entry.sha}\n`).join(""),
    maxBuffer: 64 * 1024 * 1024,
  });
  // `spawnSync` reports a failure to *launch* in `error`, leaving `status` null.
  // Treating that as an absent object would turn a missing `git` into a clean
  // verdict about the repository, so it stays a distinct failure.
  if (result.error) {
    throw new Error(`self-host: could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr as Buffer).toString("utf8").trim();
    throw new Error(`self-host: git cat-file --batch failed: ${detail}`);
  }
  const output = result.stdout as Buffer;
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = headerEnd < 0 ? "" : output.subarray(offset, headerEnd).toString("utf8");
    const [sha, type, sizeText] = header.split(" ");
    const size = Number(sizeText);
    if (headerEnd < 0 || type === "missing" || !Number.isInteger(size) || sha !== entry.sha || type !== "blob"
      || headerEnd + 1 + size + 1 > output.length) {
      throw new Error(
        `self-host: git cat-file did not return ${entry.sha} for ${entry.path} `
        + `(answered: ${header.length === 0 ? "end of stream" : header}).`,
      );
    }
    // Copy out of the response buffer so the map does not pin the whole stream.
    blobs.set(entry.path, Buffer.from(output.subarray(headerEnd + 1, headerEnd + 1 + size)));
    offset = headerEnd + 1 + size + 1;
  }
  return blobs;
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
 * @returns The tree's configuration, source files and raw blobs.
 * @throws Error When the tree cannot be listed, a blob is missing, the tree
 *   does not carry the configuration, or the configuration is invalid.
 */
export function readTreeSnapshot(root: string, treeish: string): TreeSnapshot {
  const entries = listTreeEntries(root, treeish);
  const blobs = readTreeBlobs(root, entries);
  const configBytes = blobs.get(SELF_HOST_CONFIG);
  if (configBytes === undefined) {
    throw new Error(`self-host: ${treeish} does not carry ${SELF_HOST_CONFIG}; the gate cannot be configured from it.`);
  }
  const config = parseSelfHostConfig(configBytes.toString("utf8"));
  const files = new Map<string, SourceFile>();
  for (const entry of entries) {
    if (isExcluded(entry.path, config.exclude)) continue;
    // `readTreeBlobs` sets a blob for every listing entry or throws, so the
    // lookup cannot miss; it stays a lookup so the map stays the one authority.
    files.set(entry.path, {
      content: blobs.get(entry.path)!,
      mode: entry.mode === "100755" ? "100755" : "100644",
    });
  }
  return { config, files, blobs };
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
 * same code that stages any other repository. The working-tree source for the
 * legacy `--write` mode; the staged and committed trees are read from git's
 * object database by `readTreeSnapshot` instead.
 *
 * @param root - Directory holding the working source.
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
      // `readWorkingFile` reports this as a bare ENOENT, which explains
      // nothing. The interesting fact is *why* a path git tracks is missing
      // from the working tree — a file deleted on disk but not staged is the
      // usual story — so say that instead.
      const detail = errorMessage(error);
      throw new Error(
        `self-host: tracked path ${path} is absent from ${root} (deleted from the working tree?): ${detail}`,
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

/**
 * Writes the bundle for the supplied source and skips an identical artifact.
 *
 * The caller decides where the source bytes come from: the working tree (the
 * legacy `--write` mode) or the frozen Git index (`--staged`). The write path
 * itself only ever reads the committed bundle — `HEAD`, through
 * {@link readCommittedFile}, which is already conversion-free — and writes the
 * new artifact at the fixed target.
 */
function writeSnapshot(root: string, config: SelfHostConfig, files: ReadonlyMap<string, SourceFile>): void {
  const { store, refs, cleanup } = freshStore();
  try {
    const sourceTreeId = buildSourceTree(store, files);
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
    const target = resolveBundleTarget(root, config.bundle);
    if (lstatSync(target, { throwIfNoEntry: false })?.isFile() && readFileSync(target).equals(bytes)) {
      console.log(`self-host: ${config.bundle} is unchanged`);
      return;
    }
    writeFileSync(target, bytes);
    console.log(`self-host: wrote ${config.bundle} (${bytes.length} bytes)`);
  } finally {
    cleanup();
  }
}

/**
 * Freezes the candidate tree and snapshots it straight from the object database.
 *
 * `git write-tree` turns the index into a tree object, and the snapshot is
 * then read from that tree with `ls-tree` and `cat-file` — raw stored bytes,
 * no checkout. The earlier design materialized the tree with `read-tree -u`
 * into a scratch work-tree first, which is a checkout and applies the host's
 * conversion rules (`core.autocrlf`, `eol` attributes, filter drivers): with
 * `core.autocrlf=true` the writer archived LF blobs as CRLF and the committed
 * bundle failed the gate on a default checkout of the same commit. Reading
 * the object database cannot record bytes the tree does not store.
 */
function writeStagedSnapshot(root: string): void {
  const tree = runGit(root, ["write-tree"]);
  const snapshot = readTreeSnapshot(root, tree);
  writeSnapshot(root, snapshot.config, snapshot.files);
}

/** Verifies committed HEAD by default, or writes from working or staged source. */
export function main(root: string, args: readonly string[]): void {
  if (args.includes("--write")) {
    if (args.includes("--staged")) writeStagedSnapshot(root);
    else {
      const config = loadConfig(join(root, SELF_HOST_CONFIG));
      writeSnapshot(root, config, readSourceFiles(root, listTrackedFiles(root), config.exclude));
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
    const snapshot = readTreeSnapshot(root, "HEAD");
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

if (isMainInvocation(process.argv, import.meta.url)) main(resolve(import.meta.dirname, ".."), process.argv);
