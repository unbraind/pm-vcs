/**
 * Keep full local/release depth by default; quick runs the same deterministic
 * seed prefix at one tenth depth, with at least 25 cases (capped by full count).
 * Explicit finite matrices may supply a smaller quick count after preserving each kind.
 * Seeded callers keep the default floor and identical seed generation/assertions.
 */
export function testDepth(full: number, quick = Math.max(25, Math.ceil(full / 10))): number {
  return process.env.PM_TEST_DEPTH === "quick" ? Math.min(full, quick) : full;
}

/** Scale subprocess safety budgets on slower hardware, without changing product assertions. */
export function testTime(milliseconds: number, factor = process.env.PM_TEST_TIME_SCALE): number {
  const scale = factor === undefined ? 1 : Number(factor);
  const result = Math.ceil(milliseconds * scale);
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647) {
    throw new Error("PM_TEST_TIME_SCALE must produce a positive finite timer budget");
  }
  return result;
}

/** Bound quick crash recovery to 25 generated cases; full depth retains every enumerated cut. */
export function testPrefix<T>(cases: readonly T[]): T[] {
  return cases.slice(0, process.env.PM_TEST_DEPTH === "quick" ? Math.min(cases.length, 25) : cases.length);
}

/** Keep the first occurrence of every boundary kind; full retains every ordinal. */
export function testKinds<T>(cases: readonly T[], kind: (value: T) => unknown): T[] {
  const seen = new Set<unknown>();
  const representatives = cases.filter(value => { const key = kind(value); if (seen.has(key)) return false; seen.add(key); return true; });
  return testDepth(cases.length, representatives.length) === cases.length ? [...cases] : representatives;
}
