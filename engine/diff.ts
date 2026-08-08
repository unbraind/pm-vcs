// Line diff, hunks, and tree diff.
//
// The line diff is Myers' O(ND) algorithm: it searches for the shortest edit
// script by advancing, for each edit distance D, the furthest-reaching path on
// each diagonal. That matters over a naive longest-common-subsequence table
// because the cost scales with how *different* the inputs are rather than with
// how large they are, and two revisions of one file are usually almost the same.

/** How a line in an edit script relates to the two sides. */
export type EditKind = "equal" | "insert" | "delete";

/** One line of an edit script. */
export interface Edit {
  readonly kind: EditKind;
  /** The line's text, without its terminator. */
  readonly text: string;
  /** Zero-based index in the left side, or null for an insertion. */
  readonly leftIndex: number | null;
  /** Zero-based index in the right side, or null for a deletion. */
  readonly rightIndex: number | null;
}

/** A run of changes plus its surrounding context. */
export interface Hunk {
  /** One-based first line shown from the left side. */
  readonly leftStart: number;
  /** Number of left-side lines the hunk covers. */
  readonly leftCount: number;
  /** One-based first line shown from the right side. */
  readonly rightStart: number;
  /** Number of right-side lines the hunk covers. */
  readonly rightCount: number;
  /** The hunk's edits, context included. */
  readonly edits: readonly Edit[];
}

/**
 * Splits text into lines for diffing.
 *
 * A trailing newline terminates the last line rather than starting an empty
 * one, so a file ending in `\n` does not diff as having a phantom final line —
 * but a genuinely empty file yields no lines at all rather than one empty one.
 *
 * @param text - The file's contents.
 * @returns The lines, without terminators.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * One banded furthest-reaching snapshot, taken at a single edit distance.
 *
 * `furthest` stores the furthest x reached on each diagonal of the reachable
 * band at the edit distance this snapshot was taken; `offset` maps a diagonal
 * number `k` to an index via `k + offset` (so the band runs from `-offset` to
 * `+offset`). Only the diagonals that carry information at that distance are
 * kept, which is what bounds peak memory to the band rather than the full width.
 */
interface TraceSnapshot {
  readonly furthest: Int32Array;
  readonly offset: number;
}

/**
 * The forward Myers search result: the banded trace plus allocation statistics.
 *
 * The statistics exist so the band bound is testable: `peakSnapshotEntries` is
 * the largest single snapshot and `totalSnapshotEntries` the sum across every
 * distance, both proportional to the reachable band rather than to the combined
 * input length.
 */
export interface DiffSearch {
  readonly snapshots: readonly TraceSnapshot[];
  readonly distance: number;
  readonly peakSnapshotEntries: number;
  readonly totalSnapshotEntries: number;
}

/**
 * A diff result annotated with the trace allocation statistics.
 *
 * Returned by {@link diffLinesWithStats} so callers that only need the script
 * use {@link diffLines} and callers that must prove the memory bound (tests)
 * read the snapshot statistics from one pass.
 */
export interface DiffResult {
  readonly edits: Edit[];
  readonly distance: number;
  readonly peakSnapshotEntries: number;
  readonly totalSnapshotEntries: number;
}

/**
 * Runs the forward Myers search, snapshotting only the reachable diagonal band.
 *
 * The working `furthest` array stays full width — a single `O(n + m)`
 * allocation, not one per distance — but each snapshot copied into the trace is
 * bounded to the `2d + 1` diagonals that carry information at edit distance `d`.
 * The snapshot taken at the top of the distance-`d` pass records the state after
 * distance `d - 1`, whose meaningful diagonals are `-(d - 1)..(d - 1)`; it is
 * stored in a `2d + 1` entry array with offset `d`, so the backtrack can look up
 * `previousK + d` for any `previousK` it can reach. That bounds the per-snapshot
 * cost to the band and the total trace to `O(d^2)` instead of `O(d * (n + m))`.
 *
 * @param left - The original lines.
 * @param right - The revised lines.
 * @returns The banded trace, the terminating edit distance, and the snapshot
 * allocation statistics.
 */
function searchForward(left: readonly string[], right: readonly string[]): DiffSearch {
  const leftLength = left.length;
  const rightLength = right.length;
  const maximum = leftLength + rightLength;
  // Two empty inputs have one edit script — the empty one — and the search below
  // would read `furthest[1]` on an array of length 1 to find it, producing NaN
  // cursors and falling out of the loop instead of returning from it.
  if (maximum === 0) return { snapshots: [], distance: 0, peakSnapshotEntries: 0, totalSnapshotEntries: 0 };
  // One full-width working array; the cost is a single `O(n + m)` allocation,
  // not the per-distance snapshots that dominated the old memory.
  const furthest = new Int32Array(2 * maximum + 1);
  const snapshots: TraceSnapshot[] = [];
  let peakSnapshotEntries = 0;
  let totalSnapshotEntries = 0;

  // The search runs until a script is found rather than to a fixed bound, and that
  // is not an unbounded loop: `d` reaches at most `maximum`, since deleting every
  // left line and inserting every right one is an edit script of exactly that
  // length, and the both-empty case returned above. A `d <= maximum` condition would
  // be one no input can make false — dead code, or a suppression in a gate that
  // allows none.
  let distance = -1;
  for (let d = 0; distance < 0; d += 1) {
    // Snapshot the band of the current furthest state — the state after distance
    // `d - 1` — before this pass overwrites it. Only diagonals of parity `d - 1`
    // within `-(d - 1)..(d - 1)` hold values at that point; the outer `k = ±d`
    // slots stay zero and are never read by the backtrack (its `k = ±d` cases
    // short-circuit the comparison that would touch them).
    const band = new Int32Array(2 * d + 1);
    for (let k = -(d - 1); k <= d - 1; k += 2) {
      band[k + d] = furthest[k + maximum];
    }
    snapshots.push({ furthest: band, offset: d });
    peakSnapshotEntries = Math.max(peakSnapshotEntries, band.length);
    totalSnapshotEntries += band.length;
    for (let k = -d; k <= d; k += 2) {
      // Step down (an insertion from the right side) when the diagonal below is
      // behind, otherwise step right (a deletion from the left side).
      const goDown = k === -d || (k !== d && furthest[k - 1 + maximum] < furthest[k + 1 + maximum]);
      let x = goDown ? furthest[k + 1 + maximum] : furthest[k - 1 + maximum] + 1;
      let y = x - k;
      while (x < leftLength && y < rightLength && left[x] === right[y]) {
        x += 1;
        y += 1;
      }
      furthest[k + maximum] = x;
      if (x >= leftLength && y >= rightLength) {
        distance = d;
        break;
      }
    }
  }
  return { snapshots, distance, peakSnapshotEntries, totalSnapshotEntries };
}

/**
 * Walks the banded traces backwards to turn an edit distance into a script.
 *
 * @param left - The original lines.
 * @param right - The revised lines.
 * @param search - The banded trace and terminating distance from {@link searchForward}.
 * @returns The edit script in forward order.
 */
function backtrack(left: readonly string[], right: readonly string[], search: DiffSearch): Edit[] {
  const edits: Edit[] = [];
  let x = left.length;
  let y = right.length;
  for (let d = search.distance; d > 0; d -= 1) {
    const previous = search.snapshots[d]!;
    const offset = previous.offset;
    const k = x - y;
    const goDown = k === -d || (k !== d && previous.furthest[k - 1 + offset] < previous.furthest[k + 1 + offset]);
    const previousK = goDown ? k + 1 : k - 1;
    const previousX = previous.furthest[previousK + offset];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      edits.push({ kind: "equal", text: left[x]!, leftIndex: x, rightIndex: y });
    }
    if (goDown) {
      y -= 1;
      edits.push({ kind: "insert", text: right[y]!, leftIndex: null, rightIndex: y });
    } else {
      x -= 1;
      edits.push({ kind: "delete", text: left[x]!, leftIndex: x, rightIndex: null });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    edits.push({ kind: "equal", text: left[x]!, leftIndex: x, rightIndex: y });
  }
  return edits.reverse();
}

/**
 * Computes the shortest edit script between two line sequences.
 *
 * @param left - The original lines.
 * @param right - The revised lines.
 * @returns The edit script, in order, covering every line of both sides.
 */
export function diffLines(left: readonly string[], right: readonly string[]): Edit[] {
  return backtrack(left, right, searchForward(left, right));
}

/**
 * Computes the edit script together with the trace allocation statistics.
 *
 * The script is identical to {@link diffLines}; the statistics let a caller
 * prove the trace memory is bounded by the reachable band (`2d + 1` per
 * snapshot) rather than by the full width (`2 * (n + m) + 1` per snapshot),
 * which is the property `pm-vcs-ze24` requires to be testable.
 *
 * @param left - The original lines.
 * @param right - The revised lines.
 * @returns The edit script plus the peak and total snapshot allocation.
 */
export function diffLinesWithStats(left: readonly string[], right: readonly string[]): DiffResult {
  const search = searchForward(left, right);
  return {
    edits: backtrack(left, right, search),
    distance: search.distance,
    peakSnapshotEntries: search.peakSnapshotEntries,
    totalSnapshotEntries: search.totalSnapshotEntries,
  };
}

/**
 * Applies an edit script to the left side.
 *
 * Exists so the diff can be checked against its own definition rather than
 * against expected output: a script is correct exactly when replaying it over
 * the left side reproduces the right side.
 *
 * @param edits - An edit script.
 * @returns The right-side lines the script reconstructs.
 */
export function applyEdits(edits: readonly Edit[]): string[] {
  return edits.filter((edit) => edit.kind !== "delete").map((edit) => edit.text);
}

/**
 * Groups an edit script into hunks with surrounding context.
 *
 * @param edits - An edit script.
 * @param context - Unchanged lines to keep on each side of a change.
 * @returns The hunks, or an empty array when nothing changed.
 */
export function buildHunks(edits: readonly Edit[], context = 3): Hunk[] {
  const changed = edits.map((edit) => edit.kind !== "equal");
  if (!changed.includes(true)) return [];

  // Mark every edit within `context` of a change, then cut the marked set into
  // maximal runs. Two changes closer than 2*context merge into one hunk because
  // their marked regions overlap — which is the behaviour unified diff expects.
  const keep = new Array<boolean>(edits.length).fill(false);
  for (let index = 0; index < edits.length; index += 1) {
    if (!changed[index]) continue;
    for (let near = Math.max(0, index - context); near <= Math.min(edits.length - 1, index + context); near += 1) {
      keep[near] = true;
    }
  }

  const hunks: Hunk[] = [];
  let cursor = 0;
  while (cursor < edits.length) {
    if (!keep[cursor]) {
      cursor += 1;
      continue;
    }
    let end = cursor;
    while (end + 1 < edits.length && keep[end + 1]) end += 1;
    const slice = edits.slice(cursor, end + 1);
    const leftIndices = slice.filter((edit) => edit.leftIndex !== null).map((edit) => edit.leftIndex as number);
    const rightIndices = slice.filter((edit) => edit.rightIndex !== null).map((edit) => edit.rightIndex as number);
    hunks.push({
      // A hunk that only inserts covers no left lines; unified diff renders that
      // as the line number *after* which the insertion goes, hence the fallback
      // to the count rather than to 1.
      leftStart: leftIndices.length > 0 ? leftIndices[0] + 1 : 0,
      leftCount: leftIndices.length,
      rightStart: rightIndices.length > 0 ? rightIndices[0] + 1 : 0,
      rightCount: rightIndices.length,
      edits: slice,
    });
    cursor = end + 1;
  }
  return hunks;
}

/**
 * Renders hunks as a unified diff.
 *
 * @param hunks - Hunks from {@link buildHunks}.
 * @param leftLabel - Path shown on the `---` line.
 * @param rightLabel - Path shown on the `+++` line.
 * @returns The unified diff, or an empty string when there are no hunks.
 */
export function formatUnifiedDiff(hunks: readonly Hunk[], leftLabel: string, rightLabel: string): string {
  if (hunks.length === 0) return "";
  const lines = [`--- ${leftLabel}`, `+++ ${rightLabel}`];
  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.leftStart},${hunk.leftCount} +${hunk.rightStart},${hunk.rightCount} @@`);
    for (const edit of hunk.edits) {
      lines.push(`${edit.kind === "equal" ? " " : edit.kind === "insert" ? "+" : "-"}${edit.text}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Diffs two texts end to end.
 *
 * @param left - The original text.
 * @param right - The revised text.
 * @param leftLabel - Path shown on the `---` line.
 * @param rightLabel - Path shown on the `+++` line.
 * @param context - Unchanged lines to keep on each side of a change.
 * @returns The unified diff, empty when the texts are identical.
 */
export function unifiedDiff(
  left: string,
  right: string,
  leftLabel: string,
  rightLabel: string,
  context = 3,
): string {
  return formatUnifiedDiff(buildHunks(diffLines(splitLines(left), splitLines(right)), context), leftLabel, rightLabel);
}
