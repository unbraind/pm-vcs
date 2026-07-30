// Commit-graph queries and three-way content merge.
//
// Two independent pieces live here because they are the two halves of one
// question. Merging needs to know *what* to merge against — the merge base — and
// that is a graph problem; then it needs to combine three texts, and that is the
// diff3 problem. Getting the first wrong makes the second produce a confident,
// well-formatted, wrong answer, which is why the base search below handles
// several candidates rather than assuming one.

import { diffLines, splitLines } from "./diff.ts";
import { readCommit } from "./model.ts";
import type { ObjectId, ObjectStore } from "./objects.ts";

/** How a three-way merge of one file turned out. */
export interface ContentMergeResult {
  /** True when no region needed a conflict marker. */
  readonly clean: boolean;
  /** The merged text. Carries conflict markers when `clean` is false. */
  readonly text: string;
  /** One entry per conflicting region, in order. */
  readonly conflicts: readonly ContentConflict[];
}

/** A region both sides changed differently. */
export interface ContentConflict {
  /** Base lines the region covered. */
  readonly base: readonly string[];
  /** What our side made of them. */
  readonly ours: readonly string[];
  /** What their side made of them. */
  readonly theirs: readonly string[];
}

/** Labels written into conflict markers. */
export interface ConflictLabels {
  readonly ours: string;
  readonly base: string;
  readonly theirs: string;
}

/** Default labels, matching what most tools expect to find. */
export const DEFAULT_CONFLICT_LABELS: ConflictLabels = { ours: "ours", base: "base", theirs: "theirs" };

/**
 * Every commit reachable from a starting commit, including itself.
 *
 * Iterative rather than recursive: a long linear history would otherwise
 * overflow the call stack, and histories in this system are machine-generated
 * and can get long.
 *
 * @param store - Object store holding the commits.
 * @param start - Commit to walk back from.
 * @returns The set of reachable commit ids.
 */
export function reachable(store: ObjectStore, start: ObjectId): Set<ObjectId> {
  const seen = new Set<ObjectId>();
  const pending = [start];
  while (pending.length > 0) {
    const id = pending.pop() as ObjectId;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...readCommit(store, id).parents);
  }
  return seen;
}

/**
 * Whether one commit is an ancestor of another.
 *
 * A commit is considered its own ancestor, which is what makes "is this a
 * fast-forward" a single call.
 *
 * @param store - Object store holding the commits.
 * @param candidate - The possible ancestor.
 * @param descendant - The commit to search back from.
 * @returns True when `candidate` is reachable from `descendant`.
 */
export function isAncestor(store: ObjectStore, candidate: ObjectId, descendant: ObjectId): boolean {
  return reachable(store, descendant).has(candidate);
}

/**
 * Finds the best common ancestors of two commits.
 *
 * "Best" means minimal: a common ancestor that is itself reachable from another
 * common ancestor is discarded, because merging against it would replay changes
 * the closer ancestor already contains. Usually one commit survives. A
 * criss-cross history — two branches that already merged each other once — leaves
 * several, and returning all of them is what lets the caller build a virtual
 * base instead of silently picking one and mis-merging.
 *
 * @param store - Object store holding the commits.
 * @param left - First commit.
 * @param right - Second commit.
 * @returns The minimal common ancestors, sorted by id for determinism. Empty
 *   when the two commits share no history at all.
 */
export function mergeBases(store: ObjectStore, left: ObjectId, right: ObjectId): ObjectId[] {
  const fromLeft = reachable(store, left);
  const common = [...reachable(store, right)].filter((id) => fromLeft.has(id));
  const minimal = common.filter((candidate) => !common.some((other) => (
    other !== candidate && isAncestor(store, candidate, other)
  )));
  return minimal.sort();
}

/**
 * Maps base line indices to the side line indices they are equal to.
 *
 * @param base - Base lines.
 * @param side - One side's lines.
 * @returns For each base index that survives unchanged, the side index it sits at.
 */
function matchMap(base: readonly string[], side: readonly string[]): Map<number, number> {
  const matches = new Map<number, number>();
  for (const edit of diffLines(base, side)) {
    if (edit.kind === "equal" && edit.leftIndex !== null && edit.rightIndex !== null) {
      matches.set(edit.leftIndex, edit.rightIndex);
    }
  }
  return matches;
}

/**
 * One aligned region of a three-way comparison.
 *
 * Stable regions are identical across all three inputs. Unstable regions are
 * everything else, and it is the merge's job to decide what an unstable region
 * resolves to.
 */
interface Region {
  readonly stable: boolean;
  readonly base: readonly string[];
  readonly ours: readonly string[];
  readonly theirs: readonly string[];
}

/**
 * Splits three inputs into alternating stable and unstable regions.
 *
 * This is the diff3 alignment. A position is stable when the same base line sits
 * at the corresponding offset in both sides; the algorithm advances through the
 * longest such run it can, and everything between two stable runs becomes one
 * unstable region spanning all three inputs.
 *
 * @param base - The common ancestor's lines.
 * @param ours - Our side's lines.
 * @param theirs - Their side's lines.
 * @returns The regions, in order, covering every line of all three inputs.
 */
function alignThreeWay(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): Region[] {
  const ourMatches = matchMap(base, ours);
  const theirMatches = matchMap(base, theirs);
  const regions: Region[] = [];
  let baseCursor = 0;
  let ourCursor = 0;
  let theirCursor = 0;

  while (baseCursor < base.length || ourCursor < ours.length || theirCursor < theirs.length) {
    // How far the three can advance in lockstep from here.
    let run = 0;
    while (
      ourMatches.get(baseCursor + run) === ourCursor + run
      && theirMatches.get(baseCursor + run) === theirCursor + run
    ) {
      run += 1;
    }
    if (run > 0) {
      regions.push({
        stable: true,
        base: base.slice(baseCursor, baseCursor + run),
        ours: ours.slice(ourCursor, ourCursor + run),
        theirs: theirs.slice(theirCursor, theirCursor + run),
      });
      baseCursor += run;
      ourCursor += run;
      theirCursor += run;
      continue;
    }

    // Not stable here, so find where stability resumes. The next stable point is
    // the earliest base line that both sides still carry at or after the current
    // cursors; everything before it is one unstable region.
    let nextBase = base.length;
    let nextOurs = ours.length;
    let nextTheirs = theirs.length;
    for (let probe = baseCursor + 1; probe <= base.length; probe += 1) {
      const ourIndex = ourMatches.get(probe);
      const theirIndex = theirMatches.get(probe);
      if (ourIndex === undefined || theirIndex === undefined) continue;
      if (ourIndex < ourCursor || theirIndex < theirCursor) continue;
      nextBase = probe;
      nextOurs = ourIndex;
      nextTheirs = theirIndex;
      break;
    }
    regions.push({
      stable: false,
      base: base.slice(baseCursor, nextBase),
      ours: ours.slice(ourCursor, nextOurs),
      theirs: theirs.slice(theirCursor, nextTheirs),
    });
    baseCursor = nextBase;
    ourCursor = nextOurs;
    theirCursor = nextTheirs;
  }
  return regions;
}

/** True when two line arrays hold the same lines in the same order. */
function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/**
 * Three-way merges two revisions of one text against their common ancestor.
 *
 * A region only one side touched takes that side. A region both sides changed
 * *identically* is not a conflict — two agents reaching the same conclusion
 * independently is agreement, and reporting it as a conflict is the single most
 * common way an automated merge wastes a human's attention. Only a genuine
 * disagreement produces markers.
 *
 * @param base - The common ancestor's text.
 * @param ours - Our side's text.
 * @param theirs - Their side's text.
 * @param labels - Names written into conflict markers.
 * @returns The merged text and every conflict encountered.
 */
export function mergeContent(
  base: string,
  ours: string,
  theirs: string,
  labels: ConflictLabels = DEFAULT_CONFLICT_LABELS,
): ContentMergeResult {
  const regions = alignThreeWay(splitLines(base), splitLines(ours), splitLines(theirs));
  const output: string[] = [];
  const conflicts: ContentConflict[] = [];

  for (const region of regions) {
    if (region.stable) {
      output.push(...region.base);
      continue;
    }
    if (sameLines(region.ours, region.theirs)) {
      output.push(...region.ours);
      continue;
    }
    if (sameLines(region.ours, region.base)) {
      output.push(...region.theirs);
      continue;
    }
    if (sameLines(region.theirs, region.base)) {
      output.push(...region.ours);
      continue;
    }
    conflicts.push({ base: region.base, ours: region.ours, theirs: region.theirs });
    output.push(
      `<<<<<<< ${labels.ours}`,
      ...region.ours,
      `||||||| ${labels.base}`,
      ...region.base,
      "=======",
      ...region.theirs,
      `>>>>>>> ${labels.theirs}`,
    );
  }

  return {
    clean: conflicts.length === 0,
    text: output.length === 0 ? "" : `${output.join("\n")}\n`,
    conflicts,
  };
}

