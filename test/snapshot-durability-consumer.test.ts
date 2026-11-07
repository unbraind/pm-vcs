import "./helpers/isolate-session.ts";
/** Verify the same ownership barrier through packed SDK and CLI entrypoints in real non-git trackers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devNull } from "node:os";
import { test } from "node:test";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { pmExecutable } from "../scripts/pm-environment.ts";

const program = `
import { testEnvironment } from ${JSON.stringify(new URL("./helpers/test-environment.ts", import.meta.url).href)};
import assert from "node:assert/strict";
import { devNull } from "node:os";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "pm-vcs/dist/engine/repo.js";
import { objectFiles } from "pm-vcs/dist/engine/object-files.js";
const [runtime, archive, cli, cliRuntime] = process.argv.slice(2);
const injector = \`import fs from "node:fs"; import { dirname } from "node:path"; import { objectFiles } from OBJECT_FILES_URL;
const opened = objectFiles.opened;
objectFiles.opened = (file, path) => {
 opened(file, path);
 if (/objects\\\\.lock\\\\.[0-9]+\\\\.[0-9a-f]{12}\\\\.tmp$/.test(path) && objectFiles.storageOwners.has(dirname(path))) {
  if (process.env.SNAPSHOT_CASE === "absent") fs.unlinkSync(path);
  else if (process.env.SNAPSHOT_CASE === "replacement") { fs.renameSync(path, path + ".held"); fs.writeFileSync(path, "foreign owner"); }
 }
};\`;

let cells = 0;
for (const entrypoint of ["sdk", "json", "toon"]) for (const scenario of ["owned", "absent", "replacement"]) {
 const root = join(process.cwd(), runtime + "-" + entrypoint + "-" + scenario); fs.mkdirSync(root);
 await new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true }).init("snapshot-policy", { defaults: true, author: "fixture" });
 const repo = Repository.init(root); const paths = Array.from({ length: 10 }, (_, i) => "payload-" + i);
 for (const [i, path] of paths.entries()) fs.writeFileSync(join(root, path), Buffer.alloc(512 * 1024, i + 1));
 const before = fs.readFileSync(join(repo.controlDirectory, "index")); const objects = repo.objects.inventory().map(entry => entry.id);
 let captured;
 if (entrypoint === "sdk") {
  const original = objectFiles.opened;
  objectFiles.opened = (file, path) => {
   original(file, path);
   if (dirname(path) === repo.controlDirectory && /objects\\.lock\\.[0-9]+\\.[0-9a-f]{12}\\.tmp$/.test(path) && objectFiles.storageOwners.has(dirname(path))) {
    captured = path;
    if (scenario === "absent") fs.unlinkSync(path);
    if (scenario === "replacement") { fs.renameSync(path, path + ".held"); fs.writeFileSync(path, "foreign owner"); }
   }
  };
  try {
   if (scenario === "owned") repo.stage(paths);
   else assert.throws(() => repo.stage(paths), { code: "worktree_path_changed" });
  } finally { objectFiles.opened = original; }
 } else {
  const installed = spawnSync(cliRuntime, [cli, "package", "install", archive, "--project"], { cwd: root, env: testEnvironment({ npm_config_userconfig: devNull, NPM_CONFIG_USERCONFIG: devNull }), encoding: "utf8", timeout: 120000 });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const preload = join(root, "inject.mjs");
  fs.writeFileSync(preload, injector.replace("OBJECT_FILES_URL", JSON.stringify(pathToFileURL(join(root, ".agents/pm/extensions/pm-vcs/dist/engine/object-files.js")).href)));
  const args = [cli, ...(entrypoint === "json" ? ["--json"] : []), "vcs", "add", ...paths];
  const result = spawnSync(cliRuntime, args, { cwd: root, env: testEnvironment({ SNAPSHOT_CASE: scenario, NODE_OPTIONS: "--import=" + pathToFileURL(preload).href }), encoding: "utf8", timeout: 120000 });
  if (scenario === "owned") assert.equal(result.status, 0, result.stdout + result.stderr);
  else { assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /worktree_path_changed|snapshot ownership/); }
  if (entrypoint === "json" && scenario === "owned") assert.doesNotThrow(() => JSON.parse(result.stdout));
  captured = fs.readdirSync(repo.controlDirectory).filter(name => /^objects\\.lock\\..*\\.tmp$/.test(name)).map(name => join(repo.controlDirectory, name))[0];
 }
 assert.equal(fs.existsSync(join(root, ".git")), false);
 if (scenario === "owned") assert.equal(repo.readIndex().length, paths.length);
 else {
  assert.deepEqual(fs.readFileSync(join(repo.controlDirectory, "index")), before);
  assert.deepEqual(repo.objects.inventory().map(entry => entry.id), objects);
  if (scenario === "replacement") {
   assert.ok(captured); assert.equal(fs.readFileSync(captured, "utf8"), "foreign owner");
   assert.equal(fs.statSync(captured + ".held").size, 0, "unreleased descriptors must receive no snapshot bytes");
  }
 }
 assert.equal(objectFiles.active.size, 0); cells++;
}
console.log(JSON.stringify({ runtime, cells }));
`;

test("packed npm and Bun SDK/CLI JSON/TOON consumers require positive snapshot release", async (t) => {
  const scope = makeTempDir();
  try {
    const environment = testEnvironment({ ...discardChildCoverage(), npm_config_userconfig: devNull, NPM_CONFIG_USERCONFIG: devNull });
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--loglevel=error", "--pack-destination", scope.root], { cwd: packageRoot, env: environment, encoding: "utf8", timeout: 120_000 });
    assert.equal(packed.status, 0, packed.stderr);
    const archive = join(scope.root, packed.stdout.trim().split(/\r?\n/).at(-1)!);
    const root = join(scope.root, "consumer"); mkdirSync(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "snapshot-consumer", private: true, type: "module" }));
    const installed = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", archive], { cwd: root, env: environment, encoding: "utf8", timeout: 120_000 });
    assert.equal(installed.status, 0, installed.stderr);
    symlinkSync(join(packageRoot, "node_modules/@unbrained"), join(root, "node_modules/@unbrained"), "junction");
    writeFileSync(join(root, "consumer.mjs"), program);
    for (const runtime of [process.execPath, "bun"]) {
      const result = spawnSync(runtime, [join(root, "consumer.mjs"), runtime === "bun" ? "bun" : "node", archive, pmExecutable, process.execPath], { cwd: root, env: environment, encoding: "utf8", timeout: 300_000 });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const receipt = JSON.parse(result.stdout.trim()) as { runtime: string; cells: number };
      assert.equal(receipt.cells, 9); t.diagnostic(JSON.stringify(receipt));
    }
  } finally { scope.cleanup(); }
});
