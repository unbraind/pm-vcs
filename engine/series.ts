// Patch series: a forge-independent change artifact.
//
// Kernel lore and `git send-email` show that a change under review can be a
// first-class, transferable artifact that exists without a server. pm-vcs makes
// the series an object kind (see `model.ts`) so "the same series" is an identity
// question with a content-addressed answer rather than a diff comparison.
//
// This module provides the verbs: produce a series from a commit range, transfer
// it as a bundle, apply it to a branch, and re-derive it — all natively, never by
// shelling out to git.

import { compareByteOrder, decodeTree, readCommit, readSeries, type PatchSeries, type SeriesPatch, type Signature, writeSeries } from "./model.ts";
import { type ObjectStore, type ObjectId, ObjectStoreError } from "./objects.ts";
import { reachable, isAncestor } from "./merge.ts";
import { BUNDLE_FORMAT, type BundleContents, serializeBundle } from "./bundle.ts";
import { type RefStore, BRANCH_PREFIX } from "./refs.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { type RewriteContext, planCherryPick } from "./rewrite.ts";

/** Options for producing a patch series. */
export interface SeriesOptions {
  /** Human-readable description of the series. */
  readonly description: string;
  /** The identity under which the series is authored. */
  readonly author: Signature;
}

/**
 * Collects the ordered list of commits in a range `(from, to]`.
 *
 * The range is exclusive of `from` and inclusive of `to`: every commit
 * reachable from `to` but not from `from`, ordered oldest first. This matches
 * the natural notion of "the commits I made on top of `from`".
 *
 * Ordering is topological: a commit appears before its children. Ties between
 * unrelated commits at the same depth break by byte order of id, so the same
 * range always produces the same ordering and therefore the same series bytes.
 *
 * @param store - Object store holding the commits.
 * @param from - The base commit (exclusive). Must be an ancestor of `to`.
 * @param to - The tip commit (inclusive).
 * @returns The commits in the range, oldest first.
 * @throws ObjectStoreError When `from` is not an ancestor of `to`.
 */
function collectRange(store: ObjectStore, from: ObjectId, to: ObjectId): ObjectId[] {
  if (!isAncestor(store, from, to)) {
    throw new ObjectStoreError(
      "invalid_range",
      `The base ${from.slice(0, 12)} is not an ancestor of the tip ${to.slice(0, 12)}, `
        + "so no commit range exists between them.",
    );
  }
  const excluded = reachable(store, from);
  const included = [...reachable(store, to)].filter((id) => !excluded.has(id));
  const includedSet = new Set(included);
  /** Count how many included commits are ancestors of a given commit. */
  const ancestorCount = (id: ObjectId): number => {
    let count = 0;
    for (const candidate of included) {
      if (candidate === id) continue;
      if (includedSet.has(candidate) && isAncestor(store, candidate, id)) count += 1;
    }
    return count;
  };
  return included.sort((left, right) => {
    const leftCount = ancestorCount(left);
    const rightCount = ancestorCount(right);
    return leftCount !== rightCount
      ? leftCount - rightCount
      : compareByteOrder(left, right);
  });
}

/**
 * Collects every object a commit reaches: its tree, subtrees, and every leaf.
 *
 * @param store - Object store holding the commit.
 * @param commitId - The commit to walk from.
 * @param into - The set to add object ids to.
 */
function collectObjectClosure(store: ObjectStore, commitId: ObjectId, into: Set<ObjectId>): void {
  if (into.has(commitId)) return;
  into.add(commitId);
  const commit = readCommit(store, commitId);
  collectTree(store, commit.tree, into);
  for (const parent of commit.parents) collectObjectClosure(store, parent, into);
}

/**
 * Walks a tree and adds it and every descendant to a set.
 *
 * @param store - Object store holding the trees.
 * @param treeId - The tree to walk.
 * @param into - The set to add object ids to.
 */
function collectTree(store: ObjectStore, treeId: ObjectId, into: Set<ObjectId>): void {
  if (into.has(treeId)) return;
  into.add(treeId);
  const payload = store.readTyped(treeId, "tree");
  for (const entry of decodeTree(payload)) {
    if (entry.mode === "40000") collectTree(store, entry.id, into);
    else into.add(entry.id);
  }
}

/**
 * Produces a patch series from a commit range.
 *
 * The series references each commit in the range `(from, to]` by its object id.
 * Since commit ids are content-addressed and canonical, re-deriving from the
 * same range produces the same series bytes and therefore the same object id —
 * the round-trip equality the acceptance criteria require.
 *
 * @param store - Object store holding the commits.
 * @param from - The base commit (exclusive). Must be an ancestor of `to`.
 * @param to - The tip commit (inclusive).
 * @param options - Description and author for the series.
 * @returns The id of the written series object.
 * @throws ObjectStoreError When the range is invalid, empty, or a commit is missing.
 */
export function createSeries(
  store: ObjectStore,
  from: ObjectId,
  to: ObjectId,
  options: SeriesOptions,
): ObjectId {
  const commits = collectRange(store, from, to);
  if (commits.length === 0) {
    throw new ObjectStoreError(
      "empty_range",
      `The range ${from.slice(0, 12)}..${to.slice(0, 12)} contains no commits. `
        + "The tip must have commits on top of the base.",
    );
  }
  // The base of the series is the parent of the oldest commit in the range.
  // For a linear range this is `from`; for a range where the oldest commit has
  // multiple parents (a merge), the first parent is the lineage the series
  // builds on.
  const oldest = readCommit(store, commits[0]!);
  const base = oldest.parents[0] ?? from;
  const patches: SeriesPatch[] = commits.map((commit) => ({ commit }));
  const series: PatchSeries = {
    base,
    patches,
    description: options.description,
    author: options.author,
  };
  return writeSeries(store, series);
}

/**
 * Re-derives a patch series from the same commit range.
 *
 * This is the same operation as {@link createSeries}; the function exists as a
 * named verb so a test can assert round-trip equality by producing, re-deriving,
 * and comparing the two object ids. The identity holds because commit ids are
 * content-addressed and the series encoding is canonical.
 *
 * @param store - Object store holding the commits.
 * @param from - The base commit (exclusive).
 * @param to - The tip commit (inclusive).
 * @param options - Description and author — must match the original production.
 * @returns The id of the re-derived series object.
 */
export function rederiveSeries(
  store: ObjectStore,
  from: ObjectId,
  to: ObjectId,
  options: SeriesOptions,
): ObjectId {
  return createSeries(store, from, to, options);
}

/**
 * Exports a patch series and all objects it references as a bundle.
 *
 * The bundle carries the series object itself, every commit referenced by its
 * patches, and the full tree and blob closure behind those commits. Importing
 * the bundle into a fresh store (via `importBundleObjects`) gives the receiver
 * everything needed to read and apply the series without any further transfer.
 *
 * @param store - Object store holding the series and its commits.
 * @param seriesId - The series object id.
 * @returns The bundle bytes.
 * @throws ObjectStoreError When the series or any referenced object is absent.
 */
export function exportSeriesBundle(store: ObjectStore, seriesId: ObjectId): Buffer {
  const series = readSeries(store, seriesId);
  const tip = series.patches[series.patches.length - 1]!.commit;
  // Collect the full closure: every commit reachable from each patch, plus all
  // trees and leaves. The series object itself is included explicitly.
  const objects = new Set<ObjectId>([seriesId]);
  for (const patch of series.patches) {
    collectObjectClosure(store, patch.commit, objects);
  }
  const sortedObjects = [...objects].sort(compareByteOrder);
  const header: BundleContents = {
    refs: { [`${BRANCH_PREFIX}series/${seriesId.slice(0, 12)}`]: tip },
    prerequisites: [series.base].sort(compareByteOrder),
    objects: sortedObjects,
  };
  return serializeBundle(store, header);
}

/**
 * Applies a patch series to the current HEAD of a repository.
 *
 * Each patch is cherry-picked onto HEAD in order. The commits referenced by the
 * series must be present in the object store. The series' base is not checked
 * against HEAD — the series describes a set of changes, and applying them is a
 * cherry-pick, not a merge.
 *
 * When HEAD is unborn, the first patch is applied on top of the series' own base,
 * which is the parent the series was produced from.
 *
 * @param store - Object store holding the series and all referenced commits.
 * @param refs - Ref store for the target repository.
 * @param seriesId - The series object id to apply.
 * @param committer - Signature for the new commits.
 * @returns The id of the final commit produced.
 * @throws ObjectStoreError When the series is empty, a referenced commit is
 *   absent, or a cherry-pick cannot be planned.
 */
export function applySeries(
  store: ObjectStore,
  refs: RefStore,
  seriesId: ObjectId,
  committer: Signature,
): ObjectId {
  const series = readSeries(store, seriesId);
  if (series.patches.length === 0) {
    throw new ObjectStoreError("empty_series", "The series contains no patches to apply.");
  }
  const context: RewriteContext = { store, config: DEFAULT_CONFIG, committer };
  const head = refs.readHead();
  let current: ObjectId | null = head.target;
  for (const patch of series.patches) {
    const onto = current ?? series.base;
    const newCommit = planCherryPick(context, patch.commit, onto);
    if (head.kind === "branch") {
      refs.compareAndSwap(head.ref, current, newCommit);
    } else {
      refs.setHeadDetached(newCommit);
    }
    current = newCommit;
  }
  return current as ObjectId;
}