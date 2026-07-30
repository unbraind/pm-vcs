/**
 * Merge prediction: what would happen to tracker data if `<ref>` were merged
 * into HEAD right now.
 *
 * `pm merge report` accounts for a merge that already happened. This module
 * answers the question an agent has to settle *before* it merges — which items
 * collide, on which fields, and how each one resolves — while the working tree
 * is still untouched.
 *
 * The prediction is trustworthy for one structural reason: it does not model the
 * merge drivers' rules, it calls them. `mergeItemDocuments`,
 * `mergeHistoryStreams`, `mergeRelationshipEventStreams` and `mergeJsonDocuments`
 * are the exact functions `pm merge driver` runs, exported from
 * `@unbrained/pm-cli/sdk/merge`. Since both the preview and the real merge reduce
 * to the same call on the same three blobs, the preview cannot drift from the
 * outcome — a rule change in the CLI changes both at once.
 *
 * Nothing here writes to the working tree or the index. Blobs are read straight
 * out of the object database with `git show`, so a preview is safe to run with
 * uncommitted work in progress.
 */

import {
  mergeHistoryStreams,
  mergeItemDocuments,
  mergeJsonDocuments,
  mergeRelationshipEventStreams,
} from "@unbrained/pm-cli/sdk/merge";

import {
  VcsError,
  changedPaths,
  mergeAttributes,
  readBlob,
  requireGit,
  resolveCommit,
} from "./git.ts";

/**
 * Artifact classes the shipped merge drivers cover.
 *
 * These are the driver names pm writes into `.gitattributes`, so the mapping
 * from a path to a merge function is git's own attribute answer rather than a
 * filename convention this package invents.
 */
const DRIVER_ARTIFACTS = new Map<string, "item" | "history" | "relationship" | "json">([
  ["pm-item-toon", "item"],
  ["pm-item-markdown", "item"],
  ["pm-history", "history"],
  ["pm-relationship", "relationship"],
  ["pm-json", "json"],
]);

/** How a single artifact would resolve. */
export type PreviewResolution =
  /** Both sides are identical, or only one side changed: nothing to decide. */
  | "clean"
  /** Append-only streams, or commutative collections, that union losslessly. */
  | "union"
  /** Both sides changed the same scalar to different values; the driver picks a side. */
  | "conflict"
  /**
   * One side deleted the artifact while the other changed it.
   *
   * Git resolves this at the tree level and never invokes a merge driver, so
   * there is no per-field answer to report — the decision is whether the item
   * should exist at all, which only its author can settle.
   */
  | "delete_modify"
  /** The path is a tracker artifact that no merge driver covers in this clone. */
  | "unprotected";

/** Predicted outcome for one artifact changed on both sides. */
export interface PreviewEntry {
  /** Repository-relative POSIX path of the artifact. */
  readonly path: string;
  /** Item id when the path is an item document or its history stream. */
  readonly item_id: string | null;
  /** Merge driver git would apply, or `null` when the path has no `merge` attribute. */
  readonly driver: string | null;
  /** Artifact class the driver handles, or `null` for an unprotected path. */
  readonly artifact: "item" | "history" | "relationship" | "json" | null;
  /** Predicted resolution for this artifact. */
  readonly resolution: PreviewResolution;
  /** Fields (or dotted JSON paths) both sides changed to different values. */
  readonly conflict_fields: readonly string[];
  /** Collection fields that merge by element-identity union. */
  readonly union_fields: readonly string[];
  /** Fields cleanly taken from the incoming side. */
  readonly fields_from_theirs: readonly string[];
  /** Strategy label for an append-only stream, absent for other artifact classes. */
  readonly stream_strategy: string | null;
  /** Entry count the merged append-only stream would hold, when applicable. */
  readonly entries_total: number | null;
}

/** Full result of a preview, shaped for both `--json` and TOON rendering. */
export interface PreviewReport {
  /** Ref that was previewed. */
  readonly ref: string;
  /** Commit `ref` resolved to. */
  readonly theirs: string;
  /** Commit HEAD resolved to. */
  readonly ours: string;
  /** Merge base of the two commits. */
  readonly base: string;
  /** Whether HEAD already contains `ref`, making the merge a no-op. */
  readonly already_merged: boolean;
  /** Per-artifact predictions, only for paths changed on both sides. */
  readonly entries: readonly PreviewEntry[];
  /** Counts by resolution, so a gate can branch without walking `entries`. */
  readonly totals: {
    readonly clean: number;
    readonly union: number;
    readonly conflict: number;
    readonly delete_modify: number;
    readonly unprotected: number;
  };
}

/** Inputs a preview needs, resolved by the caller from the command context. */
export interface PreviewOptions {
  /** Ref to preview merging into HEAD. */
  readonly ref: string;
  /** Absolute repository root. */
  readonly repoRoot: string;
  /** Tracker root as a repository-relative POSIX path (`""` when it is the root). */
  readonly trackerPrefix: string;
}

/**
 * Predicts the tracker-data outcome of merging `ref` into HEAD.
 *
 * Only paths changed on *both* sides can produce a decision, so the candidate
 * set is the intersection of the two diffs against the merge base. A path
 * changed on one side only fast-forwards to that side, which git resolves
 * without consulting a driver at all.
 *
 * @param options - Ref to preview plus the resolved repository and tracker roots.
 * @returns The per-artifact prediction and its totals.
 * @throws VcsError When the ref does not resolve, or the two commits share no history.
 */
export function previewMerge(options: PreviewOptions): PreviewReport {
  const { ref, repoRoot, trackerPrefix } = options;
  const theirs = resolveCommit(ref, repoRoot);
  if (theirs === null) {
    throw new VcsError(
      "ref_not_found",
      `Ref "${ref}" does not resolve to a commit in this repository.`,
      "Fetch the ref first (git fetch origin <branch>), or pass a ref that exists locally.",
    );
  }
  const ours = resolveCommit("HEAD", repoRoot);
  if (ours === null) {
    throw new VcsError(
      "head_not_found",
      "HEAD does not resolve to a commit.",
      "Make at least one commit before previewing a merge.",
    );
  }

  const mergeBase = requireGit(
    ["merge-base", ours, theirs],
    repoRoot,
    `HEAD and "${ref}" share no common ancestor, so there is no merge base to compare against. Check that the ref belongs to this project's history.`,
  ).trim();

  // An ancestor ref is already contained in HEAD: git would fast-forward or
  // report "already up to date", and no driver would ever run. Reporting that
  // plainly is more useful than an empty entry list the caller has to interpret.
  const alreadyMerged = mergeBase === theirs;

  const ourChanges = new Set(changedPaths(mergeBase, ours, repoRoot));
  const bothChanged = changedPaths(mergeBase, theirs, repoRoot)
    .filter((path) => ourChanges.has(path))
    .filter((path) => isTrackerPath(path, trackerPrefix))
    .sort();

  const attributes = mergeAttributes(bothChanged, repoRoot);
  const entries = attributes.map((attribute) =>
    predictPath(attribute.path, attribute.driver, { base: mergeBase, ours, theirs }, repoRoot),
  );

  return {
    ref,
    theirs,
    ours,
    base: mergeBase,
    already_merged: alreadyMerged,
    entries,
    totals: {
      clean: entries.filter((entry) => entry.resolution === "clean").length,
      union: entries.filter((entry) => entry.resolution === "union").length,
      conflict: entries.filter((entry) => entry.resolution === "conflict").length,
      delete_modify: entries.filter((entry) => entry.resolution === "delete_modify").length,
      unprotected: entries.filter((entry) => entry.resolution === "unprotected").length,
    },
  };
}

/**
 * Decides whether a repository-relative path belongs to the tracker.
 *
 * @param path - Repository-relative POSIX path from a git diff.
 * @param trackerPrefix - Tracker root relative to the repository root.
 * @returns True when the path is inside the tracker.
 */
export function isTrackerPath(path: string, trackerPrefix: string): boolean {
  if (trackerPrefix === "") return true;
  return path === trackerPrefix || path.startsWith(`${trackerPrefix}/`);
}

/**
 * Derives an item id from a tracker artifact path.
 *
 * Item documents live at `<tracker>/<type-folder>/<id>.toon` and their history
 * streams at `<tracker>/history/<id>.jsonl`, so the basename carries the id in
 * both cases. Other artifacts (settings, relationship stores) belong to no
 * single item.
 *
 * @param path - Repository-relative POSIX path.
 * @param artifact - Artifact class resolved from the merge driver.
 * @returns The item id, or `null` when the artifact is not item-scoped.
 */
export function itemIdFromPath(
  path: string,
  artifact: "item" | "history" | "relationship" | "json" | null,
): string | null {
  if (artifact !== "item" && artifact !== "history") return null;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  const id = dot === -1 ? basename : basename.slice(0, dot);
  return id === "" ? null : id;
}

/** The three commits a three-way merge reads from. */
interface MergeSides {
  /** Merge base commit. */
  readonly base: string;
  /** Current-branch commit. */
  readonly ours: string;
  /** Incoming commit. */
  readonly theirs: string;
}

/**
 * Predicts the outcome for one path by running the real merge primitive.
 *
 * A path with no `merge` attribute is reported as `unprotected` without being
 * merged: that is the finding, and it is the one gap that silently produces
 * line-merged tracker data.
 *
 * Missing blobs are handled asymmetrically, mirroring git:
 *
 * - **base absent** (added on both sides) is passed to the primitive as an empty
 *   string, because git does hand add/add to a driver with an empty base file.
 * - **ours or theirs absent** (delete/modify) short-circuits to `delete_modify`
 *   and never reaches a primitive, because git settles that at the tree level
 *   and never runs a driver — and `mergeItemDocuments` rejects an empty side
 *   outright rather than reading it as a deletion.
 *
 * @param path - Repository-relative POSIX path.
 * @param driver - Merge driver git reported for the path.
 * @param sides - Base, ours and theirs commits.
 * @param repoRoot - Absolute repository root.
 * @returns The prediction for this path.
 */
export function predictPath(
  path: string,
  driver: string | null,
  sides: MergeSides,
  repoRoot: string,
): PreviewEntry {
  const artifact = driver === null ? null : (DRIVER_ARTIFACTS.get(driver) ?? null);
  const itemId = itemIdFromPath(path, artifact);
  if (artifact === null) {
    return {
      path,
      item_id: itemId,
      driver,
      artifact: null,
      resolution: "unprotected",
      conflict_fields: [],
      union_fields: [],
      fields_from_theirs: [],
      stream_strategy: null,
      entries_total: null,
    };
  }

  // An absent base is the add/add case, which git *does* hand to a driver with an
  // empty base file, and which the merge primitives accept.
  const base = readBlob(sides.base, path, repoRoot) ?? "";
  const ours = readBlob(sides.ours, path, repoRoot);
  const theirs = readBlob(sides.theirs, path, repoRoot);

  // An absent ours or theirs is delete/modify. Git settles that at the tree level
  // and never runs a merge driver, so neither does this: calling the primitive
  // with an empty side is not what the real merge does, and the item primitive
  // rejects it outright ("not a readable item document") rather than treating it
  // as a deletion. Reporting the structural decision is the honest answer.
  if (ours === null || theirs === null) {
    return {
      path,
      item_id: itemId,
      driver,
      artifact,
      resolution: "delete_modify",
      conflict_fields: [],
      union_fields: [],
      fields_from_theirs: [],
      stream_strategy: null,
      entries_total: null,
    };
  }

  if (artifact === "item") {
    const merged = mergeItemDocuments(base, ours, theirs);
    return {
      path,
      item_id: itemId,
      driver,
      artifact,
      resolution:
        merged.conflict_fields.length > 0
          ? "conflict"
          : merged.union_fields.length > 0
            ? "union"
            : "clean",
      conflict_fields: merged.conflict_fields,
      union_fields: merged.union_fields,
      fields_from_theirs: merged.fields_from_theirs,
      stream_strategy: null,
      entries_total: null,
    };
  }

  if (artifact === "json") {
    const merged = mergeJsonDocuments(base, ours, theirs);
    return {
      path,
      item_id: itemId,
      driver,
      artifact,
      resolution: merged.conflict_paths.length > 0 ? "conflict" : "clean",
      conflict_fields: merged.conflict_paths,
      union_fields: [],
      fields_from_theirs: merged.paths_from_theirs,
      stream_strategy: null,
      entries_total: null,
    };
  }

  const merged =
    artifact === "history"
      ? mergeHistoryStreams(base, ours, theirs)
      : mergeRelationshipEventStreams(base, ours, theirs);
  return {
    path,
    item_id: itemId,
    driver,
    artifact,
    // An append-only stream never conflicts: identical inputs and one-sided
    // fast-forwards keep a side byte-for-byte, and genuine divergence unions
    // both suffixes. Reporting the strategy is what tells an agent whether the
    // merge will re-anchor the hash chain, which is what `pm merge reconcile`
    // later accounts for.
    resolution: streamResolution(merged.strategy),
    conflict_fields: [],
    union_fields: [],
    fields_from_theirs: [],
    stream_strategy: merged.strategy,
    entries_total: merged.entries_total,
  };
}

/**
 * Maps an append-only stream merge strategy onto a preview resolution.
 *
 * @param strategy - Strategy label reported by the stream merge primitive.
 * @returns `union` when both sides contributed entries, `clean` otherwise.
 */
export function streamResolution(strategy: string): PreviewResolution {
  return strategy === "union_reanchor" ? "union" : "clean";
}
