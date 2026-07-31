import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyEdits,
  buildHunks,
  diffLines,
  formatUnifiedDiff,
  splitLines,
  unifiedDiff,
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
