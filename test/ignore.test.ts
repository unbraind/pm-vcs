import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { ALWAYS_IGNORED, isIgnored, isPrunableDirectory, parseIgnore, readIgnoreRules } from "../engine/ignore.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

/** Empty rules ignore nothing except the always-ignored set. */
const empty = { patterns: [], negations: [] };

test("the always-ignored set is ignored whatever the project asks for", () => {
  // A path inside .git is the canonical case this module exists to prevent.
  assert.equal(isIgnored(".git/objects/ab/cd", empty), true);
  assert.equal(isIgnored(".git/HEAD", empty), true);
  // node_modules is reconstructible and huge, so it is pruned too.
  assert.equal(isIgnored("node_modules/pkg/index.js", empty), true);
  // Every declared always-ignored name is ignored at the root and at depth.
  for (const name of ALWAYS_IGNORED) {
    assert.equal(isIgnored(`${name}/x`, empty), true);
    assert.equal(isIgnored(`deep/${name}/x`, empty), true);
  }
  // A normal path is not ignored.
  assert.equal(isIgnored("src/index.ts", empty), false);
});

test("a negation cannot re-include an always-ignored path", () => {
  const rules = parseIgnore("*.log\n!debug.log\n!.git/**\n");
  // A project negation re-includes a path an earlier project pattern excluded.
  assert.equal(isIgnored("debug.log", rules), false);
  // The same negation cannot re-include an always-ignored path like .git.
  assert.equal(isIgnored(".git/config", rules), true);
});

test("a project pattern can be negated", () => {
  // Ignore all .log files, then re-include keep.log.
  const rules = parseIgnore("*.log\n!keep.log\n");
  assert.equal(isIgnored("noise.log", rules), true);
  assert.equal(isIgnored("keep.log", rules), false);
});

test("parseIgnore treats a pattern with no slash as a basename match at any depth", () => {
  const rules = parseIgnore("*.log");
  assert.equal(isIgnored("build.log", rules), true);
  // A basename pattern matches at any depth, which is what everyone expects of
  // `*.log` rather than only a root-level match.
  assert.equal(isIgnored("logs/build.log", rules), true);
});

test("parseIgnore treats a trailing slash as a directory and everything under it", () => {
  const rules = parseIgnore("dist/");
  assert.equal(isIgnored("dist/index.js", rules), true);
  assert.equal(isIgnored("src/index.ts", rules), false);
});

test("parseIgnore skips blank lines and comments and normalises a leading ./", () => {
  const rules = parseIgnore("# comment\n\n./build/\n");
  // One real pattern survives; the comment and blank line are dropped.
  assert.equal(rules.patterns.length, 1);
  // A leading ./ is stripped, and a trailing slash matches everything beneath.
  assert.equal(isIgnored("build/out.js", rules), true);
  assert.equal(isIgnored("src/other.js", rules), false);
});

test("readIgnoreRules returns empty rules when no ignore file exists", () => {
  dir = makeTempDir();
  const rules = readIgnoreRules(dir.root);
  assert.deepEqual(rules, empty);
});

test("readIgnoreRules reads a real ignore file", () => {
  dir = makeTempDir();
  writeFileSync(join(dir.root, ".pmvcsignore"), "*.tmp\n");
  const rules = readIgnoreRules(dir.root);
  assert.equal(isIgnored("scratch.tmp", rules), true);
});

test("isPrunableDirectory is true only for the always-ignored names", () => {
  assert.equal(isPrunableDirectory("node_modules"), true);
  assert.equal(isPrunableDirectory(".git"), true);
  // A project-ignored directory name is not prunable, because a later rule could
  // re-include it.
  assert.equal(isPrunableDirectory("dist"), false);
});
