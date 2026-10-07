import assert from "node:assert/strict";
import fs, { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Repository } from "../engine/repo.ts";
import { ALWAYS_IGNORED, isIgnored, isRuntimeIgnored, isPrunableDirectory, parseIgnore, readIgnoreRules } from "../engine/ignore.ts";
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
  assert.equal(isIgnored(".git/config", rules), true);
  assert.equal(isRuntimeIgnored(".git/config", rules), false);
  assert.equal(isRuntimeIgnored("custom/tracker/runtime/context.json", rules), true);
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

test("an out-of-view legacy runtime entry survives an unrelated add", () => {
  // A sparse entry is a path this working tree cannot see; dropping it during
  // an unrelated add would make the next commit delete it invisibly.
  dir = makeTempDir();
  const repository = Repository.init(dir.root);
  const runtime = ".agents/pm/runtime/context-usage.jsonl";
  const id = repository.objects.write("blob", Buffer.from("legacy runtime\n"));
  writeFileSync(join(dir.root, "visible.txt"), "visible\n");
  repository.writeIndex([{ path: runtime, id, mode: "100644", sparse: true }]);
  assert.deepEqual(repository.stage([]), ["visible.txt"]);
  assert.deepEqual(repository.readIndex().map((entry) => [entry.path, entry.sparse === true]), [[runtime, true], ["visible.txt", false]]);
});

test("tracker roots below globbed record-path prefixes are discovered and fenced", () => {
  // The glob `custom/*/Issues/*.toon` names records inside trackers the
  // pattern does not spell out — `custom/team`. Discovery used to walk only
  // toward the repository root, so a tracker below the globbed prefix was
  // never found: no runtime fence covered it, and `stage` took its
  // `runtime/context.jsonl` as an ordinary file.
  dir = makeTempDir();
  const team = join(dir.root, "custom/team");
  const nested = join(dir.root, "custom/team/nested");
  mkdirSync(join(team, "Issues"), { recursive: true });
  mkdirSync(join(nested, "Issues"), { recursive: true });
  writeFileSync(join(team, "settings.json"), "{}");
  writeFileSync(join(nested, "settings.json"), "{}");
  const partial = readIgnoreRules(dir.root, ["custom/te*/Issues/*.toon"]);
  assert.equal(isIgnored("custom/team/runtime/context.jsonl", partial), true);
  const rules = readIgnoreRules(dir.root, ["custom/*/Issues/*.toon"]);
  for (const path of ["custom/team/runtime/context.jsonl", "custom/team/locks/item.lock", "custom/team/transactions/journal.json", "custom/team/nested/runtime/context.jsonl"]) {
    assert.equal(isIgnored(path, rules), true, path);
    assert.equal(isRuntimeIgnored(path, rules), true, path);
  }
  // The records themselves stay trackable, and the walk below the prefix does
  // not fence anything that is not a tracker's runtime state.
  for (const path of ["custom/team/settings.json", "custom/team/Issues/item.toon", "custom/team/nested/Issues/item.toon", "custom/other/source.ts"]) {
    assert.equal(isIgnored(path, rules), false, path);
  }
  // A prefix outside the repository is not walked, whatever the glob says: the
  // fences it produces are exactly the ones the repository root itself yields.
  const outside = readIgnoreRules(dir.root, ["../outside/*/Issues/*.toon"]);
  assert.equal(isRuntimeIgnored("outside/runtime/context.jsonl", outside), false);
  assert.deepEqual(outside.runtime, readIgnoreRules(dir.root).runtime);
});

test("staging cannot take a tracker's runtime files once a glob discovers the tracker", () => {
  // The end-to-end shape of the finding: without discovery, `stage([])` took
  // the tracker's runtime context as an ordinary untracked file.
  dir = makeTempDir();
  const team = join(dir.root, "custom/team");
  mkdirSync(join(team, "runtime"), { recursive: true });
  mkdirSync(join(team, "Issues"), { recursive: true });
  writeFileSync(join(team, "settings.json"), "{}");
  writeFileSync(join(team, "runtime", "context.jsonl"), "{}\n");
  writeFileSync(join(team, "Issues", "item.toon"), JSON.stringify({ title: "example" }) + "\n");
  const repository = Repository.init(dir.root, "main", { recordPaths: ["custom/*/Issues/*.toon"], recordPolicy: {} });
  assert.deepEqual(repository.stage([]), ["custom/team/Issues/item.toon", "custom/team/settings.json"]);
  assert.equal(repository.status().untracked.includes("custom/team/runtime/context.jsonl"), false);
});

test("tracker discovery never walks the root .pmvcs object store", (context) => {
  dir = makeTempDir();
  const control = join(dir.root, ".pmvcs");
  const hidden = join(control, "objects", "tracker");
  const visible = join(dir.root, "custom", ".pmvcs", "tracker");
  for (const tracker of [hidden, visible]) {
    mkdirSync(join(tracker, "Issues"), { recursive: true });
    writeFileSync(join(tracker, "settings.json"), "{}");
    writeFileSync(join(tracker, "Issues", "planted.toon"), "title: planted\n");
  }
  const visited: string[] = [];
  const realReaddir = fs.readdirSync;
  context.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    visited.push(String(args[0]));
    return realReaddir(...args);
  });
  syncBuiltinESMExports();
  try {
    const rules = readIgnoreRules(dir.root, ["**/*.toon"]);
    assert.equal(visited.some((path) => path === control || path.startsWith(`${control}/`)), false);
    assert.equal(isRuntimeIgnored(".pmvcs/objects/tracker/runtime/cache.json", rules), false);
    // This change deliberately leaves nested control-directory policy alone.
    assert.equal(isRuntimeIgnored("custom/.pmvcs/tracker/runtime/cache.json", rules), true);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
