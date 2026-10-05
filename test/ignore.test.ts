import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Repository } from "../engine/repo.ts";
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
  assert.deepEqual({ patterns: rules.patterns, negations: rules.negations }, empty);
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

test("SDK runtime fences resolve custom tracker roots and cannot be negated", () => {
  dir = makeTempDir();
  const tracker = join(dir.root, "custom/tracker");
  mkdirSync(tracker, { recursive: true });
  writeFileSync(join(tracker, "settings.json"), "{}");
  writeFileSync(join(dir.root, ".pmvcsignore"), "!custom/tracker/**\n");
  const rules = readIgnoreRules(dir.root, ["custom/tracker/Issues/*.toon", "missing/**/*.toon", "../outside/**/*.toon", "custom/tracker/**/*.toon"]);
  for (const path of ["runtime/context-usage.jsonl", "runtime/test-runs/results.json", "search/index.json", "search/nested/file", "locks/item.lock", "transactions/journal.json", "checkpoints/state.json"]) {
    assert.equal(isIgnored(`custom/tracker/${path}`, rules), true, path);
  }
  for (const path of ["search/eval-queries.json", "Issues/item.toon", "history/item.jsonl", "settings.json"]) {
    assert.equal(isIgnored(`custom/tracker/${path}`, rules), false, path);
  }
  assert.equal(isIgnored("unrelated/runtime/source.ts", rules), false);
});

test("an external PM_PATH is not a repository ignore fence; a tracker at the root is", () => {
  dir = makeTempDir();
  const saved = process.env.PM_PATH;
  try {
    process.env.PM_PATH = join(dir.root, "..");
    assert.equal(isIgnored("runtime/source.ts", readIgnoreRules(dir.root)), false);
    process.env.PM_PATH = dir.root;
    assert.equal(isIgnored("runtime/context.json", readIgnoreRules(dir.root)), true);
    assert.equal(isIgnored("search/eval-queries.json", readIgnoreRules(dir.root)), false);
  } finally { if (saved === undefined) delete process.env.PM_PATH; else process.env.PM_PATH = saved; }
});

test("legacy runtime index entries disappear on add and stay out of status", () => {
  dir = makeTempDir();
  const repository = Repository.init(dir.root);
  const runtime = ".agents/pm/runtime/context-usage.jsonl";
  mkdirSync(join(dir.root, ".agents/pm/runtime"), { recursive: true });
  writeFileSync(join(dir.root, runtime), "legacy runtime\n");
  const id = repository.objects.write("blob", Buffer.from("legacy runtime\n"));
  repository.writeIndex([{ path: runtime, id, mode: "100644" }]);
  assert.equal(repository.status().clean, true);
  assert.deepEqual(repository.stage([]), [runtime]);
  assert.deepEqual(repository.readIndex(), []);
  assert.equal(repository.status().clean, true);
  assert.throws(() => repository.stage([runtime]), /ignored/);
});
