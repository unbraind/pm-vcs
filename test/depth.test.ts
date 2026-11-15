import "./helpers/isolate-session.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { testDepth, testTime, testPrefix } from "./support/depth.ts";

test("quick depth keeps deterministic prefixes with a 25-case floor and defaults to full", () => {
  const original = process.env.PM_TEST_DEPTH;
  try {
    for (const depth of [undefined, "full", "unknown"]) {
      if (depth === undefined) delete process.env.PM_TEST_DEPTH; else process.env.PM_TEST_DEPTH = depth;
      assert.equal(testDepth(500), 500);
    }
    process.env.PM_TEST_DEPTH = "quick";
    for (const [full, quick] of [[8, 8], [25, 25], [100, 25], [128, 25], [500, 50], [512, 52], [2000, 200]]) {
      assert.equal(testDepth(full), quick);
      assert.deepEqual(Array.from({ length: testDepth(full) }, (_, seed) => seed), Array.from({ length: full }, (_, seed) => seed).slice(0, quick));
    }
  } finally {
    if (original === undefined) delete process.env.PM_TEST_DEPTH; else process.env.PM_TEST_DEPTH = original;
  }
});

test("slow-hardware watchdog scale defaults to one and refuses invalid timer budgets", () => {
  const original = process.env.PM_TEST_TIME_SCALE;
  try {
    delete process.env.PM_TEST_TIME_SCALE;
    assert.equal(testTime(30_000), 30_000);
    assert.equal(testTime(30_000, "3"), 90_000);
    assert.equal(testTime(1, "1.1"), 2);
    assert.equal(testTime(10, "0.01"), 1);
    process.env.PM_TEST_TIME_SCALE = "3";
    assert.equal(testTime(120_000), 360_000);
    for (const scale of ["", "0", "-1", "NaN", "Infinity", "1000000000"]) assert.throws(() => testTime(30_000, scale), /PM_TEST_TIME_SCALE/);
  } finally {
    if (original === undefined) delete process.env.PM_TEST_TIME_SCALE; else process.env.PM_TEST_TIME_SCALE = original;
  }
});


test("quick crash sampling counts only generated cuts and full retains every ordinal", () => {
  const previous = process.env.PM_TEST_DEPTH;
  try {
    const cuts = Array.from({ length: 500 }, (_, index) => index * 3 + 1);
    process.env.PM_TEST_DEPTH = "quick";
    assert.deepEqual(testPrefix(cuts), cuts.slice(0, 25));
    assert.deepEqual(testPrefix(cuts.slice(0, 12)), cuts.slice(0, 12));
    for (const depth of ["full", undefined]) {
      if (depth === undefined) delete process.env.PM_TEST_DEPTH; else process.env.PM_TEST_DEPTH = depth;
      assert.deepEqual(testPrefix(cuts), cuts);
    }
  } finally {
    if (previous === undefined) delete process.env.PM_TEST_DEPTH; else process.env.PM_TEST_DEPTH = previous;
  }
});
