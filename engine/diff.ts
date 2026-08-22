// Line diff, hunks, and tree diff.
//
// The line diff is Myers' O(ND) algorithm. `diffLines` routes by combined
// input width: at or below `linearSpaceDiffWidthThreshold` it runs the banded
// single-pass engine, which covers most real inputs and preserves this
// module's historical greedy tie-breaking byte for byte; wider inputs run the
// linear-space divide-and-conquer form, in which a forward and a reverse
// furthest-reaching search locate the middle snake and the two halves are
// recursed into. Both matter over a naive longest-common-subsequence table
// because the cost scales with how *different* the inputs are rather than
// with how large they are, and two revisions of one file are usually almost
// the same. The linear form matters over the banded trace because its working
// memory is a fixed number of full-width furthest arrays rather than one
// snapshot per edit distance, so peak memory no longer grows with the edit
// distance at all - which is the only regime the banded trace cannot serve.

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
 * Allocation statistics for the linear-space divide-and-conquer diff.
 *
 * The recursion keeps one forward and one reverse furthest array alive per
 * active stack frame, so peak live memory is a fixed multiple of the combined
 * input width times the recursion depth — it does not grow with the edit
 * distance, which is the property `pm-vcs-6ht8` requires to be testable.
 */
export interface LinearSpaceStats {
  /** Entries currently live across every active recursion frame. */
  live: number;
  /** The largest value `live` reached at any point of the computation. */
  peak: number;
}

/**
 * A maximal diagonal run found straddling the middle of an optimal path.
 *
 * All coordinates are absolute: they index directly into the full `left` and
 * `right` sequences, not into the subproblem the snake was found in.
 */
interface MiddleSnake {
  /** First position of the snake on the left side. */
  readonly startX: number;
  /** First position of the snake on the right side. */
  readonly startY: number;
  /** One past the last position of the snake on the left side. */
  readonly endX: number;
  /** One past the last position of the snake on the right side. */
  readonly endY: number;
}

/**
 * Allocates an {@link Int32Array} and charges its size to the live statistics.
 *
 * @param size - Number of entries to allocate.
 * @param stats - The statistics whose `live` and `peak` counters to update.
 * @returns The new array.
 */
function allocateTrace(size: number, stats: LinearSpaceStats): Int32Array {
  stats.live += size;
  if (stats.live > stats.peak) stats.peak = stats.live;
  return new Int32Array(size);
}

/**
 * Locates the middle snake of the subproblem's shortest edit script.
 *
 * Runs the furthest-reaching forward search to depth `ceil(D / 2)` and the
 * furthest-reaching reverse search to depth `floor(D / 2)` for whatever `D`
 * turns out to be, checking after each pass whether the two frontiers have met
 * on a shared diagonal. When delta (the diagonal of the far corner) is odd the
 * meeting can only pair a forward depth with a reverse depth one less, and is
 * therefore checked from the forward side; when delta is even the pairing is
 * equal depths and is checked from the reverse side. Following Myers' paper,
 * the snake reported is the extension just performed by the pass that detected
 * the overlap — "the last snake of the forward (or reverse) path is the middle
 * snake" — which is a genuine common substring by construction, so splitting
 * there leaves two independent subproblems whose edit distances sum to at most
 * the parent's. The reverse search works in minimized-y space, mirroring its
 * source at the bottom-right corner; diagonals are scanned in descending order
 * on both passes.
 *
 * @param left - The original lines.
 * @param right - The revised lines.
 * @param leftFrom - Absolute index of the subproblem's first left line.
 * @param leftLength - Number of left lines in the subproblem.
 * @param rightFrom - Absolute index of the subproblem's first right line.
 * @param rightLength - Number of right lines in the subproblem.
 * @param stats - The statistics charged for the two working arrays.
 * @returns The middle snake, in absolute coordinates. Both ends share a
 * diagonal and the span between them carries exactly one non-diagonal edit
 * edge plus a common diagonal run. The span is never empty - both report
 * sites include the edge that opened the snake, and the recursion depends on
 * that: a span advancing by nothing would make the tail recursion repeat the
 * identical subproblem forever. It cannot arise, because the even-delta check
 * needs at least one completed reverse pass and the callers only enter this
 * search with an edit distance of at least two.
 */
function findMiddleSnake(
  left: readonly string[],
  right: readonly string[],
  leftFrom: number,
  leftLength: number,
  rightFrom: number,
  rightLength: number,
  stats: LinearSpaceStats,
): MiddleSnake {
  const n = leftLength;
  const m = rightLength;
  // Callers only reach here after trimming left both sides non-empty with a
  // mismatch at the opening pair, so the subproblem's edit distance is at
  // least two. That matters for termination: the search below has no bound
  // in its header, and that is not an unbounded loop — the frontiers grow one
  // depth per pass and must cross by depth `ceil(D / 2)`, since deleting
  // every left line and inserting every right one is itself an edit script
  // the two passes between them cover.
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const maxDepth = Math.ceil((n + m) / 2);
  const offset = maxDepth + 1;
  const vf = allocateTrace(2 * offset + 1, stats);
  const vb = allocateTrace(2 * offset + 1, stats);
  // Both searches read one slot outside their band at depth zero — the forward
  // search at `k = -d` reads `k + 1`, the backward search at `c = -d` reads
  // `c + 1` — so slot +1 of each array is seeded with the corner cursor: the
  // forward search starts at the box's left edge (x units), the backward
  // search, which minimizes y, starts at its bottom edge (y units).
  vf[offset + 1] = 0;
  vb[offset + 1] = m;

  let result: MiddleSnake | undefined;
  for (let d = 0; result === undefined; d += 1) {
    for (let k = d; k >= -d && result === undefined; k -= 2) {
      // Same tie-break as the banded search: step down onto diagonal `k`
      // when the lower neighbour reached further, otherwise step right.
      let px: number;
      let x: number;
      if (k === -d || (k !== d && vf[offset + k - 1] < vf[offset + k + 1])) {
        px = x = vf[offset + k + 1];
      } else {
        px = vf[offset + k - 1];
        x = px + 1;
      }
      let y = x - k;
      // `py` backs up over the non-diagonal edge that opened this snake: one
      // row above `y` when the step was downward (x unchanged), else level.
      const py = d === 0 || x !== px ? y : y - 1;
      while (x < n && y < m && left[leftFrom + x] === right[rightFrom + y]) {
        x += 1;
        y += 1;
      }
      vf[offset + k] = x;
      // With odd delta the frontier met a reverse pass one depth shallower:
      // only diagonals inside that shallower band can close a path here.
      const c = k - delta;
      if (odd && d >= 1 && c >= -(d - 1) && c <= d - 1 && y >= vb[offset + c]) {
        result = {
          startX: leftFrom + px,
          startY: rightFrom + py,
          endX: leftFrom + x,
          endY: rightFrom + y,
        };
      }
    }
    for (let c = d; c >= -d && result === undefined; c -= 2) {
      const k = c + delta;
      // Mirror image of the forward tie-break read backwards, in y units:
      // arrive from the reverse-diagonal below (`c + 1`) when it got strictly
      // further back (smaller y), otherwise step from the one above.
      let py: number;
      let y: number;
      if (c === -d || (c !== d && vb[offset + c - 1] > vb[offset + c + 1])) {
        py = y = vb[offset + c + 1];
      } else {
        py = vb[offset + c - 1];
        y = py - 1;
      }
      let x = y + k;
      // Same trick as the forward pass's `py`, mirrored: `px` sits one column
      // right of `x` when this step consumed a right-side line, else level.
      const px = d === 0 || y !== py ? x : x + 1;
      while (x > 0 && y > 0 && left[leftFrom + x - 1] === right[rightFrom + y - 1]) {
        x -= 1;
        y -= 1;
      }
      vb[offset + c] = y;
      // With even delta the frontier met a forward pass at the same depth.
      if (!odd && k >= -d && k <= d && x <= vf[offset + k]) {
        result = {
          startX: leftFrom + x,
          startY: rightFrom + y,
          endX: leftFrom + px,
          endY: rightFrom + py,
        };
      }
    }
  }
  stats.live -= vf.length + vb.length;
  return result;
}

/**
 * Emits one reported middle-snake segment into the output.
 *
 * A reported segment spans one non-diagonal edit edge plus the diagonal run
 * that follows it — the edge opens the segment when the forward pass reported
 * it and closes it when the backward pass did. The walk emits the leading
 * common run, then the single edit edge (whichever axis outruns the other),
 * then any trailing common run.
 *
 * @param left - The original lines.
 * @param right - The revised lines.
 * @param sx - Segment start index on the left side.
 * @param sy - Segment start index on the right side.
 * @param ex - Segment end index on the left side.
 * @param ey - Segment end index on the right side.
 * @param out - The output list edits are appended to.
 */
function emitSnakeSegment(
  left: readonly string[],
  right: readonly string[],
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  out: Edit[],
): void {
  while (sx < ex && sy < ey && left[sx] === right[sy]) {
    out.push({ kind: "equal", text: left[sx]!, leftIndex: sx, rightIndex: sy });
    sx += 1;
    sy += 1;
  }
  if (ex - sx >= ey - sy && ex > sx) {
    out.push({ kind: "delete", text: left[sx]!, leftIndex: sx, rightIndex: null });
    sx += 1;
  } else if (ey > sy) {
    out.push({ kind: "insert", text: right[sy]!, leftIndex: null, rightIndex: sy });
    sy += 1;
  }
  while (sx < ex && sy < ey) {
    out.push({ kind: "equal", text: left[sx]!, leftIndex: sx, rightIndex: sy });
    sx += 1;
    sy += 1;
  }
}

/**
 * Emits the edit script of one subproblem into the shared output array.
 *
 * The common prefix and suffix are peeled off first — the greedy search's own
 * first and last moves are maximal snakes, so this only fixes the endpoints the
 * recursion splits between — then an empty side degenerates into pure inserts
 * or deletes, and anything else is split at the middle snake and recursed.
 * Every emitted edit carries absolute indices, so no stitching is needed.
 *
 * @param left - The original lines.
 * @param right - The revised lines.
 * @param leftFrom - Absolute index of the subproblem's first left line.
 * @param leftTo - Absolute index one past the subproblem's last left line.
 * @param rightFrom - Absolute index of the subproblem's first right line.
 * @param rightTo - Absolute index one past the subproblem's last right line.
 * @param out - The output list edits are appended to.
 * @param stats - The statistics charged for recursive allocations.
 */
function emitLinearScript(
  left: readonly string[],
  right: readonly string[],
  leftFrom: number,
  leftTo: number,
  rightFrom: number,
  rightTo: number,
  out: Edit[],
  stats: LinearSpaceStats,
): void {
  let lf = leftFrom;
  let lt = leftTo;
  let rf = rightFrom;
  let rt = rightTo;
  while (lf < lt && rf < rt && left[lf] === right[rf]) {
    out.push({ kind: "equal", text: left[lf]!, leftIndex: lf, rightIndex: rf });
    lf += 1;
    rf += 1;
  }
  let suffix = 0;
  while (lf + suffix < lt && rf + suffix < rt && left[lt - 1 - suffix] === right[rt - 1 - suffix]) {
    suffix += 1;
  }
  lt -= suffix;
  rt -= suffix;
  if (lt === lf) {
    for (; rf < rt; rf += 1) out.push({ kind: "insert", text: right[rf]!, leftIndex: null, rightIndex: rf });
  } else if (rt === rf) {
    for (; lf < lt; lf += 1) out.push({ kind: "delete", text: left[lf]!, leftIndex: lf, rightIndex: null });
  } else {
    const snake = findMiddleSnake(left, right, lf, lt - lf, rf, rt - rf, stats);
    emitLinearScript(left, right, lf, snake.startX, rf, snake.startY, out, stats);
    emitSnakeSegment(left, right, snake.startX, snake.startY, snake.endX, snake.endY, out);
    emitLinearScript(left, right, snake.endX, lt, snake.endY, rt, out, stats);
  }
  while (suffix > 0) {
    out.push({ kind: "equal", text: left[lt]!, leftIndex: lt, rightIndex: rt });
    lt += 1;
    rt += 1;
    suffix -= 1;
  }
}

/**
 * A linear-space diff result: the script plus allocation statistics.
 *
 * Returned by {@link diffLinesLinearWithStats} so callers that only need the
 * script use {@link diffLines} and callers that must prove the memory ceiling
 * (tests) read the peak live allocation from one pass.
 */
export interface LinearDiffResult {
  readonly edits: Edit[];
  readonly distance: number;
  /** Peak Int32 entries held live by the whole divide-and-conquer run. */
  readonly peakLiveEntries: number;
}

/**
 * Computes the edit script together with the peak live allocation.
 *
 * This is the divide-and-conquer engine proper — no width threshold, it always
 * runs the middle-snake recursion — so the memory ceiling is provable rather
 * than anecdotal: peak live memory is a fixed multiple of the combined input
 * width times the recursion depth, never a function of the edit distance,
 * which is what `pm-vcs-6ht8` requires. {@link diffLines} routes to this same
 * code only above `linearSpaceDiffWidthThreshold`, where the banded engine's
 * worst case stops being affordable.
 *
 * @param left - The original lines.
 * @param right - The revised lines.
 * @returns The edit script, its edit distance, and the peak live allocation.
 */
export function diffLinesLinearWithStats(left: readonly string[], right: readonly string[]): LinearDiffResult {
  const stats: LinearSpaceStats = { live: 0, peak: 0 };
  const edits: Edit[] = [];
  emitLinearScript(left, right, 0, left.length, 0, right.length, edits, stats);
  let distance = 0;
  for (const edit of edits) {
    if (edit.kind !== "equal") distance += 1;
  }
  return { edits, distance, peakLiveEntries: stats.peak };
}

/**
 * Combined input width at or below which {@link diffLines} keeps the banded
 * engine.
 *
 * The banded trace is quadratic in the edit distance, but its worst case — two
 * inputs with no line in common — is bounded by `(width + 1)^2` entries, so at
 * this threshold it peaks around 67 MB of Int32 storage. Below it the banded
 * engine is kept because its greedy tie-breaking is the historical output of
 * this module; above it the divide-and-conquer engine takes over, because the
 * band is exactly what becomes unaffordable there.
 */
export const linearSpaceDiffWidthThreshold = 4096;

/**
 * Computes the shortest edit script between two line sequences.
 *
 * Inputs whose combined width fits the banded engine's worst-case memory are
 * served by Myers' O(ND) algorithm with a banded trace, exactly as before
 * `pm-vcs-6ht8`. Wider inputs switch to the linear-space divide-and-conquer
 * form: the middle snake is located from a forward and a reverse
 * furthest-reaching pass and the two halves are recursed into, so peak memory
 * stays proportional to the combined input width regardless of how large the
 * edit distance grows. Both engines produce shortest edit scripts; on inputs
 * with several equally short scripts their tie-breaking can differ.
 *
 * @param left - The original lines.
 * @param right - The revised lines.
 * @returns The edit script, in order, covering every line of both sides.
 */
export function diffLines(left: readonly string[], right: readonly string[]): Edit[] {
  if (left.length + right.length > linearSpaceDiffWidthThreshold) {
    return diffLinesLinearWithStats(left, right).edits;
  }
  return backtrack(left, right, searchForward(left, right));
}

/**
 * Computes the edit script together with the banded-trace allocation statistics.
 *
 * Runs the banded single-pass search rather than the divide-and-conquer form,
 * so its statistics describe the trace memory `pm-vcs-ze24` bounded: each
 * snapshot holds the reachable band (`2d + 1` entries at distance `d`) instead
 * of the full width (`2 * (n + m) + 1`). It exists so that relative bound stays
 * testable — and so tests can measure how much the linear-space default saves
 * against it on inputs where the band itself is unaffordable.
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
