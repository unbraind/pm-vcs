import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Real filesystem regressions for vanishing children and installation runtime fences, without Git. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { isIgnored, isRuntimeIgnored, parseIgnore, readIgnoreRules } from "../engine/ignore.ts";
import { Repository } from "../engine/repo.ts";
import { buildTree, listWorkingTree, materializeTree } from "../engine/worktree.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const owned: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { for (const directory of owned.splice(0)) directory.cleanup(); });
/** Allocate a disposable real directory with a cleanup owner. */
function temp() { const directory = makeTempDir(); owned.push(directory); return directory.root; }
/** Use the actual SDK for each independent plain-directory tracker. */
async function fixture() {
  const root = temp(); const pmRoot = join(root, ".agents/pm");
  await new PmClient({ cwd: root, pmRoot, noExtensions: true }).init("walk-race", { defaults: true, author: "fixture" });
  writeFileSync(join(root, "keep.txt"), "retained source");
  return { root, pmRoot, repo: Repository.init(root), rules: parseIgnore("") };
}

for (const replacement of ["removed", "file"] as const) test(`walk skips a child directory ${replacement === "removed" ? "removed" : "replaced by a file"} after its parent listing`, async () => {
  const { root, rules } = await fixture(); const child = join(root, "transient");
  mkdirSync(child); writeFileSync(join(child, "payload.txt"), "transient");
  const paths = listWorkingTree(root, ".pmvcs", rules, false, directory => {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (directory === root) {
      rmSync(child, { recursive: true });
      if (replacement === "file") writeFileSync(child, "new leaf");
    }
    return entries;
  });
  assert.ok(paths.includes("keep.txt"));
  assert.ok(!paths.some(path => path === "transient" || path.startsWith("transient/")));
  assert.equal(existsSync(child), replacement === "file");
});

test("walk skips a leaf removed between directory listing and stat", async () => {
  const { root, rules } = await fixture(); const leaf = join(root, "vanished.txt"); writeFileSync(leaf, "temporary");
  const paths = listWorkingTree(root, ".pmvcs", rules, false, directory => {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (directory === root) rmSync(leaf);
    return entries;
  });
  assert.ok(paths.includes("keep.txt")); assert.ok(!paths.includes("vanished.txt"));
});

test("walk skips ENOTDIR when a leaf's parent is replaced after its listing", async () => {
  const { root, rules } = await fixture(); const child = join(root, "replaced-parent");
  mkdirSync(child); writeFileSync(join(child, "leaf.txt"), "temporary");
  const paths = listWorkingTree(root, ".pmvcs", rules, false, directory => {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (directory === child) { rmSync(child, { recursive: true }); writeFileSync(child, "new parent leaf"); }
    return entries;
  });
  assert.ok(paths.includes("keep.txt")); assert.ok(!paths.some(path => path.startsWith("replaced-parent/")));
});

for (const replacement of ["directory", "link"] as const) test(`walk omits a listed file replaced by a ${replacement} before its final stat`, async () => {
  const { root, rules } = await fixture(); const path = join(root, "replaced.txt"); writeFileSync(path, "original");
  const paths = listWorkingTree(root, ".pmvcs", rules, false, directory => {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (directory === root) {
      rmSync(path);
      if (replacement === "directory") mkdirSync(path);
      else symlinkSync("keep.txt", path);
    }
    return entries;
  });
  assert.ok(paths.includes("keep.txt")); assert.ok(!paths.includes("replaced.txt"));
});

test("walk-root ENOENT and ENOTDIR remain failures", async () => {
  const { root, rules } = await fixture();
  assert.throws(() => listWorkingTree(join(root, "missing"), ".pmvcs", rules), { code: "ENOENT" });
  assert.throws(() => listWorkingTree(join(root, "keep.txt"), ".pmvcs", rules), { code: "ENOTDIR" });
});

test("child permission, I/O and non-filesystem failures propagate unchanged", async () => {
  const { root, rules } = await fixture(); const child = join(root, "protected"); mkdirSync(child);
  for (const failure of [Object.assign(new Error("permission"), { code: "EACCES" }), Object.assign(new Error("I/O"), { code: "EIO" }), new Error("unexpected"), null]) {
    assert.throws(() => listWorkingTree(root, ".pmvcs", rules, false, directory => {
      if (directory === child) throw failure;
      return readdirSync(directory, { withFileTypes: true });
    }), error => error === failure);
  }
});

test("installation runtime is non-negatable at every depth while non-runtime paths remain eligible", () => {
  const rules = parseIgnore("!.pm-cli/**\n!nested/**\n");
  for (const path of [".pm-cli/runtime", ".pm-cli/runtime/telemetry/flush.lock/owner", "nested/.pm-cli/runtime/cache.json", "nested/.PM-CLI/RuNtImE/event.json"]) {
    assert.equal(isIgnored(path, rules), true, path); assert.equal(isRuntimeIgnored(path, rules), true, path);
  }
  for (const path of [".pm-cli", ".pm-cli/settings.json", ".pm-cli/runtime-config.json", ".pm-cli/documents/runtime/a.txt", "other/runtime/a.txt", ".pm-cli-other/runtime/a.txt"]) {
    assert.equal(isIgnored(path, rules), false, path); assert.equal(isRuntimeIgnored(path, rules), false, path);
  }
});

test("runtime subtrees are pruned before descent, including tracker discovery", async () => {
  const { root } = await fixture();
  const runtime = join(root, "nested/.pm-cli/runtime"); mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "payload.json"), "temporary");
  writeFileSync(join(root, "nested/.pm-cli/settings.json"), "{}");
  const rules = readIgnoreRules(root, ["**/*.toon"]);
  const paths = listWorkingTree(root, ".pmvcs", rules, false, directory => {
    assert.notEqual(directory, runtime, "walk entered installation runtime");
    return readdirSync(directory, { withFileTypes: true });
  });
  assert.ok(paths.includes("keep.txt")); assert.ok(paths.includes("nested/.pm-cli/settings.json"));
  assert.ok(!paths.some(path => path.startsWith("nested/.pm-cli/runtime/")));
});

test("native staging excludes installation runtime and removes visible legacy index entries without Git", async () => {
  const { root, pmRoot, repo } = await fixture();
  const runtime = ".pm-cli/runtime/telemetry/flush.lock/owner.json";
  mkdirSync(dirname(join(root, runtime)), { recursive: true }); writeFileSync(join(root, runtime), '{"pid":1}');
  writeFileSync(join(root, ".pm-cli/settings.json"), "{}");
  writeFileSync(join(root, ".pmvcsignore"), "!.pm-cli/**\n");
  const old = repo.objects.write("blob", Buffer.from("legacy runtime"));
  repo.writeIndex([{ path: runtime, id: old, mode: "100644", fileId: "c".repeat(32) }]);
  repo.stage([]);
  assert.ok(!repo.readIndex().some(entry => entry.path.startsWith(".pm-cli/runtime/")));
  assert.ok(repo.readIndex().some(entry => entry.path === ".pm-cli/settings.json"));
  assert.throws(() => repo.stage([runtime]), { code: "path_ignored" });
  const url = pathToFileURL(join(packageRoot, "engine/repo.ts")).href;
  const program = `import {Repository} from ${JSON.stringify(url)}; const repo=Repository.open(process.argv[1],process.argv[2]); repo.stage([]); process.stdout.write(JSON.stringify(repo.readIndex().map(entry=>entry.path)));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", program, root, pmRoot], {
    cwd: root, encoding: "utf8", env: { ...testEnvironment(), NODE_V8_COVERAGE: "", PATH: temp(), GIT_CEILING_DIRECTORIES: dirname(root), PM_PATH: pmRoot, PM_GLOBAL_PATH: temp() },
  });
  const paths = JSON.parse(output) as string[];
  assert.ok(paths.includes("keep.txt")); assert.ok(!paths.some(path => path.startsWith(".pm-cli/runtime/")));
  assert.equal(existsSync(join(root, ".git")), false);
});


test("materialization preserves installation runtime even when a stored tree names it", async () => {
  const { root, repo, rules } = await fixture(); const path = ".pm-cli/runtime/telemetry/state.json";
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), "live runtime");
  const id = repo.objects.write("blob", Buffer.from("historical runtime"));
  const tree = buildTree(repo.objects, new Map([[path, { id, mode: "100644", fileId: "c".repeat(32) }]]));
  assert.deepEqual(materializeTree(repo.objects, root, tree, ".pmvcs", rules), []);
  assert.equal(readFileSync(join(root, path), "utf8"), "live runtime");
});


test("directory pruning preserves exceptions inside ordinary runtime fences", async () => {
  const { root } = await fixture(); mkdirSync(join(root, "cache"));
  writeFileSync(join(root, "cache/keep.txt"), "curated"); writeFileSync(join(root, "cache/drop.txt"), "runtime");
  const rules = { patterns: [], negations: [], runtime: [{ patterns: ["cache", "cache/**"], negations: ["cache/keep.txt"] }] };
  assert.equal(isRuntimeIgnored("cache", rules), true);
  const paths = listWorkingTree(root, ".pmvcs", rules);
  assert.ok(paths.includes("cache/keep.txt")); assert.ok(!paths.includes("cache/drop.txt"));
});
