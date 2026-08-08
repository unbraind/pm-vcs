import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyEdits,
  buildHunks,
  diffLines,
  diffLinesWithStats,
  formatUnifiedDiff,
  splitLines,
  unifiedDiff,
  type Edit,
} from "../engine/diff.ts";

test("splitLines drops the trailing empty line but keeps an empty file empty", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("one"), ["one"]);
  // A trailing newline terminates the last line rather than starting an empty one.
  assert.deepEqual(splitLines("one\ntwo\n"), ["one", "two"]);
  // A genuine blank line in the middle survives.
  assert.deepEqual(splitLines("one\n\ntwo\n"), ["one", "", "two"]);
});

test("identical inputs produce an all-equal script, and an empty diff renders empty", () => {
  const edits = diffLines(["a", "b", "c"], ["a", "b", "c"]);
  assert.ok(edits.every((edit) => edit.kind === "equal"));
  assert.equal(formatUnifiedDiff(buildHunks(edits), "a", "b"), "");
});

test("a pure insertion and a pure deletion diff cleanly", () => {
  const inserted = diffLines([], ["x", "y"]);
  assert.ok(inserted.every((edit) => edit.kind === "insert"));
  assert.deepEqual(applyEdits(inserted), ["x", "y"]);

  const deleted = diffLines(["x", "y"], []);
  assert.ok(deleted.every((edit) => edit.kind === "delete"));
  assert.deepEqual(applyEdits(deleted), []);
});

test("unifiedDiff renders a hunk with context and correct line ranges", () => {
  const diff = unifiedDiff("a\nb\nc\nd\ne\n", "a\nB\nc\nd\ne\n", "a.txt", "b.txt");
  // The change is on line 2; with context 3 the hunk covers the whole file.
  assert.match(diff, /^--- a\.txt\n\+\+\+ b\.txt\n@@ -1,5 \+1,5 @@\n a\n-b\n\+B\n c\n d\n e\n$/);
  assert.equal(unifiedDiff("same\n", "same\n", "a", "b"), "");
});

test("applying the edit script to the left side reproduces the right side", () => {
  const left = ["the", "quick", "brown", "fox", "jumps"];
  const right = ["the", "slow", "brown", "dog", "jumps", "high"];
  const edits = diffLines(left, right);
  assert.deepEqual(applyEdits(edits), right);
  // Every edit's indices are consistent: equal lines map back to both sides.
  for (const edit of edits) {
    if (edit.kind === "equal") {
      assert.equal(left[edit.leftIndex as number], right[edit.rightIndex as number]);
    } else if (edit.kind === "delete") {
      assert.equal(left[edit.leftIndex as number], edit.text);
    } else {
      assert.equal(right[edit.rightIndex as number], edit.text);
    }
  }
});

/**
 * A tiny deterministic PRNG so the property test is reproducible.
 *
 * Mulberry32: a single 32-bit state advanced by a fixed recurrence. Seeded
 * once at the top of the property test, so the same inputs run every time and
 * the suite never flakes under the hard coverage gate.
 *
 * @param seed - Initial state.
 * @returns A function returning the next float in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a small random line sequence from a fixed alphabet.
 *
 * @param random - The seeded PRNG.
 * @param maxLength - Maximum number of lines.
 * @returns The generated lines.
 */
function randomLines(random: () => number, maxLength: number): string[] {
  const alphabet = ["alpha", "beta", "gamma", "delta", "epsilon"];
  const length = Math.floor(random() * (maxLength + 1));
  const lines: string[] = [];
  for (let index = 0; index < length; index += 1) {
    lines.push(alphabet[Math.floor(random() * alphabet.length)]);
  }
  return lines;
}

test("diffLines is a correct edit script over many random small inputs (fixed seed)", () => {
  // A diff is correct exactly when replaying its script over the left side
  // reproduces the right side. Asserting that property over a seeded input space
  // is a stronger statement than checking a handful of hand-picked cases.
  const random = mulberry32(0xc0ffee);
  for (let trial = 0; trial < 500; trial += 1) {
    const left = randomLines(random, 8);
    const right = randomLines(random, 8);
    const edits = diffLines(left, right);
    assert.deepEqual(applyEdits(edits), right, `trial ${trial}: ${JSON.stringify(left)} -> ${JSON.stringify(right)}`);
  }
});

test("buildHunks skips leading and trailing equal edits beyond the context", () => {
  // A change in the middle of a long file with context 1: the edits before and
  // after the hunk's context window are not kept, so the cursor walks past them
  // rather than carrying them into a hunk.
  const left = ["l0", "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"];
  const right = ["l0", "l1", "l2", "l3", "CHANGED", "l5", "l6", "l7", "l8"];
  const hunks = buildHunks(diffLines(left, right), 1);
  assert.equal(hunks.length, 1);
  // The hunk covers the changed line plus one line of context each side, and it
  // carries BOTH sides of the change: the deleted `l4` and the inserted
  // `CHANGED`. A hunk that showed only the insertion could not be applied in
  // reverse, and would not be a unified diff.
  assert.equal(hunks[0].leftCount, 3);
  assert.deepEqual(
    hunks[0].edits.map((edit) => edit.text),
    ["l3", "l4", "CHANGED", "l5"],
  );
  assert.deepEqual(
    hunks[0].edits.map((edit) => edit.kind),
    ["equal", "delete", "insert", "equal"],
  );
});

test("buildHunks merges two changes closer than twice the context into one hunk", () => {
  // Two edits two lines apart, with context 3: their context windows overlap, so
  // they collapse into a single hunk rather than two adjacent ones.
  const edits = diffLines(["a", "b1", "c", "d1", "e"], ["a", "b2", "c", "d2", "e"]);
  const hunks = buildHunks(edits, 3);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].leftStart, 1);
  assert.equal(hunks[0].leftCount, 5);
});

test("buildHunks emits a pure-insertion hunk with a zero left start", () => {
  // Inserting into an empty left side: the hunk covers no left lines, so its left
  // start is 0 (the position after which the insertion goes).
  const hunks = buildHunks(diffLines([], ["new"]), 3);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].leftCount, 0);
  assert.equal(hunks[0].rightCount, 1);
});

/**
 * The pre-band reference Myers diff: snapshots the FULL-WIDTH furthest array once
 * per edit distance.
 *
 * Kept here verbatim from the implementation before `pm-vcs-ze24` so the banded
 * diff can be proved to produce byte-identical edit scripts against the original
 * unbounded algorithm, and so the snapshot allocation of the two can be compared
 * directly. This is the implementation the band test must fail against.
 *
 * @param left - The original lines.
 * @param right - The revised lines.
 * @returns The edit script and the full-width snapshot allocation statistics.
 */
function referenceDiffLines(left: readonly string[], right: readonly string[]): {
  edits: Edit[];
  peakSnapshotEntries: number;
  totalSnapshotEntries: number;
  distance: number;
} {
  const leftLength = left.length;
  const rightLength = right.length;
  const maximum = leftLength + rightLength;
  if (maximum === 0) return { edits: [], peakSnapshotEntries: 0, totalSnapshotEntries: 0, distance: 0 };
  const trace: Int32Array[] = [];
  const furthest = new Int32Array(2 * maximum + 1);
  let peakSnapshotEntries = 0;
  let totalSnapshotEntries = 0;
  let distance = -1;
  for (let d = 0; distance < 0; d += 1) {
    const snapshot = Int32Array.from(furthest);
    trace.push(snapshot);
    peakSnapshotEntries = Math.max(peakSnapshotEntries, snapshot.length);
    totalSnapshotEntries += snapshot.length;
    for (let k = -d; k <= d; k += 2) {
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
  const edits: Edit[] = [];
  let x = leftLength;
  let y = rightLength;
  for (let d = distance; d > 0; d -= 1) {
    const previous = trace[d]!;
    const k = x - y;
    const goDown = k === -d || (k !== d && previous[k - 1 + maximum] < previous[k + 1 + maximum]);
    const previousK = goDown ? k + 1 : k - 1;
    const previousX = previous[previousK + maximum]!;
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
  return { edits: edits.reverse(), peakSnapshotEntries, totalSnapshotEntries, distance };
}

test("the banded diff produces byte-identical edit scripts to the unbounded reference over many random inputs", () => {
  // The band only changes how the trace is stored, not the search or the
  // backtrack decisions, so the edit script must be identical to the original
  // full-width algorithm for every input. A seeded input space makes this a
  // reproducible property rather than a handful of hand-picked cases.
  const random = mulberry32(0xbadf00d);
  for (let trial = 0; trial < 2000; trial += 1) {
    const left = randomLines(random, 12);
    const right = randomLines(random, 12);
    const actual = diffLines(left, right);
    const reference = referenceDiffLines(left, right);
    assert.deepEqual(
      actual,
      reference.edits,
      `trial ${trial}: ${JSON.stringify(left)} -> ${JSON.stringify(right)}`,
    );
    assert.deepEqual(applyEdits(actual), right);
  }
});

test("the banded diff also matches the reference on structured and edge-shaped inputs", () => {
  // Random lines over a small alphabet exercise many edit paths, but a few
  // structured shapes catch off-by-one band edges the random set may miss:
  // pure insertion/deletion, a single middle change, and interleaving.
  const shapes: Array<[string[], string[]]> = [
    [[], []],
    [[], ["a"]],
    [["a"], []],
    [["a", "b", "c", "d", "e"], ["a", "X", "c", "Y", "e"]],
    [["a", "a", "a", "a"], ["a", "a"]],
    [["a", "b", "a", "b"], ["b", "a", "b", "a"]],
    [Array.from({ length: 30 }, (_, i) => `l${i}`), Array.from({ length: 30 }, (_, i) => (i === 15 ? `CHANGED` : `l${i}`))],
  ];
  for (const [left, right] of shapes) {
    assert.deepEqual(diffLines(left, right), referenceDiffLines(left, right).edits);
  }
});

test("peak snapshot allocation is bounded by the reachable band, not the full width", () => {
  // A 2000-line file with a single changed line: the combined width is large
  // (2 * 4000 + 1 = 8001 entries) but the edit distance is tiny (one delete plus
  // one insert = 2), so the reachable band is only 2 * 2 + 1 = 5 entries. The
  // banded snapshot must be proportional to the band; the unbounded reference
  // snapshots the full width every time, so this assertion fails against it.
  const left = Array.from({ length: 2000 }, () => "same");
  const right = left.slice();
  right[1000] = "different";
  const maximum = left.length + right.length;
  const actual = diffLinesWithStats(left, right);
  const reference = referenceDiffLines(left, right);
  assert.equal(actual.distance, 2);
  // The largest banded snapshot is exactly the band at the terminating distance.
  assert.equal(actual.peakSnapshotEntries, 2 * actual.distance + 1);
  // The band is far smaller than the full width, which the reference pays for.
  assert.ok(actual.peakSnapshotEntries < 2 * maximum + 1, "peak must be below the full width");
  assert.ok(actual.peakSnapshotEntries < reference.peakSnapshotEntries, "peak must beat the unbounded reference");
  // The total trace is the sum of the band, not distance times the full width.
  assert.equal(actual.totalSnapshotEntries, (actual.distance + 1) ** 2);
  assert.ok(actual.totalSnapshotEntries < reference.totalSnapshotEntries);
  // And the script still matches the reference exactly.
  assert.deepEqual(actual.edits, reference.edits);
});

test("a pathological 10000-line no-common-lines diff completes within a bounded memory budget", () => {
  // Two 10000-line files with no line in common: the edit distance is the whole
  // combined length (20000). The old full-width trace would allocate one
  // 40001-entry snapshot per distance — 20001 * 40001 entries, about 3.2 GiB of
  // Int32 storage — which is the blow-up `pm-vcs-ze24` was raised against. The
  // banded trace keeps the sum of (2d + 1) over d = 0..20000 = (20001)^2 entries
  // (about 1.6 GiB), and this test completing without an out-of-memory crash is
  // the bounded-budget assertion.
  const size = 10000;
  const left = Array.from({ length: size }, (_, i) => `left-${i}`);
  const right = Array.from({ length: size }, (_, i) => `right-${i}`);
  const result = diffLinesWithStats(left, right);
  assert.equal(result.distance, 2 * size);
  // The largest snapshot is the band at the terminating distance, not the
  // rectangular distance-times-width the unbounded reference would pay.
  assert.equal(result.peakSnapshotEntries, 2 * result.distance + 1);
  assert.equal(result.totalSnapshotEntries, (result.distance + 1) ** 2);
  const rectangularTotal = (result.distance + 1) * (2 * (left.length + right.length) + 1);
  assert.ok(result.totalSnapshotEntries < rectangularTotal, "banded total must be below the unbounded rectangular total");
  // Nothing is in common, so every edit is an insertion or a deletion.
  assert.ok(result.edits.every((edit) => edit.kind !== "equal"));
  assert.equal(result.edits.filter((edit) => edit.kind === "delete").length, size);
  assert.equal(result.edits.filter((edit) => edit.kind === "insert").length, size);
  // Replaying the script reproduces the right side exactly.
  assert.deepEqual(applyEdits(result.edits), right);
});
