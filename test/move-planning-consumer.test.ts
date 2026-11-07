import "./helpers/isolate-session.ts";
/** Verify frozen merge plans and lazy staging with real installed consumers and filesystem-probe budgets. */
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

const stageWorker = `
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { Repository } from "pm-vcs/dist/engine/repo.js";
const [root, kind, data] = process.argv.slice(2);
if (kind === "baseline") lstatSync(join(root, "scope/p0"));
else { const command = JSON.parse(data); Repository.open(root).stage(command.paths, undefined, command.moves); }
`;

const program = `
import { testEnvironment } from ${JSON.stringify(new URL("./helpers/test-environment.ts", import.meta.url).href)};
import { chainAuthor, prepareRenameChain } from ${JSON.stringify(new URL("./helpers/rename-chain.ts", import.meta.url).href)};
import assert from "node:assert/strict";
import { devNull } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "pm-vcs/dist/engine/repo.js";
const [runtime, archive, cli, cliRuntime, selected, group] = process.argv.slice(2);
const worker = join(process.cwd(), "stage-worker.mjs"); writeFileSync(worker, ${JSON.stringify(stageWorker)});
const environment = testEnvironment({ npm_config_userconfig: devNull, NPM_CONFIG_USERCONFIG: devNull });
let merges = 0; let traces = 0;
async function fixture(name, entrypoint) {
 const root = join(process.cwd(), runtime + "-" + name); mkdirSync(root);
 await new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true }).init("move-planning", { defaults: true, author: "fixture" });
 const repo = Repository.init(root);
 if (entrypoint !== "sdk") {
  const result = spawnSync(cliRuntime, [cli, "package", "install", archive, "--project"], { cwd: root, env: environment, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
 }
 return repo;
}
for (const entrypoint of [selected]) {
 if (group === "merge") for (const [order, names] of [["forward", ["a", "b", "c"]], ["reverse", ["b", "a", "c"]]]) for (const side of ["ours", "theirs"]) {
  const repo = await fixture("merge-" + entrypoint + "-" + order + "-" + side, entrypoint);
  const other = prepareRenameChain(repo, names, side); const before = repo.refs.resolveHead();
  if (entrypoint === "sdk") {
   const result = repo.merge(other, { message: "merge", author: chainAuthor }, new Date(1));
   assert.equal(result.clean, false); assert.ok(result.conflicts.some(c => c.path === names[1] && c.reason === "identity"));
  } else {
   const result = spawnSync(cliRuntime, [cli, ...(entrypoint === "json" ? ["--json"] : []), "vcs", "merge", other], { cwd: repo.root, env: environment, encoding: "utf8", timeout: 120000 });
   assert.equal(result.status, 0, result.stdout + result.stderr);
   if (entrypoint === "json") { const report = JSON.parse(result.stdout); assert.equal(report.merge.clean, false); assert.equal(report.ok, false); }
   else assert.match(result.stdout, /clean: false/);
  }
  assert.notEqual(repo.refs.resolveHead(), before); assert.equal(existsSync(join(repo.root, ".git")), false); merges++;
 }
 if (group === "stage") for (const kind of ["unchanged", "edit", "delete", "explicit", "two-new"]) {
  const repo = await fixture("stage-" + entrypoint + "-" + kind, entrypoint);
  mkdirSync(join(repo.root, "scope")); const probes = ["scope/p0", "scope/p1", "scope/p2"];
  for (const [i, path] of [...probes, "target", "moving"].entries()) writeFileSync(join(repo.root, path), "original " + i);
  repo.stage([...probes, "target", "moving"]); const before = repo.readIndex(); const source = repo.readIndex().find(e => e.path === "moving");
  let paths = ["target"]; let moves = [];
  if (kind === "edit") writeFileSync(join(repo.root, "target"), "edited known identity");
  if (kind === "delete") unlinkSync(join(repo.root, "target"));
  if (kind === "explicit") { renameSync(join(repo.root, "moving"), join(repo.root, "moved")); paths = ["moved"]; moves = [{ path: "moved", fileId: source.fileId }]; }
  if (kind === "two-new") { paths = ["new-a", "new-b"]; for (const path of paths) writeFileSync(join(repo.root, path), "fresh " + path); }
  function trace(label, executable, args) {
   const log = join(repo.root, label + ".trace");
   const result = spawnSync("strace", ["-f", "-qq", "-s", "4096", "-e", "trace=stat,lstat,newfstatat,statx", "-o", log, executable, ...args], { cwd: repo.root, env: environment, encoding: "utf8", timeout: 120000 });
   assert.equal(result.status, 0, result.stdout + result.stderr);
   return { text: readFileSync(log, "utf8"), output: result.stdout };
  }
  const baseline = trace("baseline", entrypoint === "sdk" ? process.execPath : cliRuntime, [worker, repo.root, "baseline"]);
  const unit = baseline.text.split(String.fromCharCode(10)).filter(line => line.includes(JSON.stringify(join(repo.root, probes[0])))).length; assert.ok(unit > 0);
  const args = entrypoint === "sdk" ? [worker, repo.root, kind, JSON.stringify({ paths, moves })] : [cli, ...(entrypoint === "json" ? ["--json"] : []), "vcs", "add", ...paths, ...(moves.length ? ["--file-id", source.fileId] : [])];
  const result = trace("stage", entrypoint === "sdk" ? process.execPath : cliRuntime, args);
  for (const probe of probes) {
   const count = result.text.split(String.fromCharCode(10)).filter(line => line.includes(JSON.stringify(join(repo.root, probe)))).length;
   assert.ok(count <= unit * (kind === "two-new" ? 2 : 1), entrypoint + "/" + kind + "/" + probe + ": exceeded mandatory validation plus one on-demand inference pass: " + count);
  }
  if (entrypoint === "json") assert.doesNotThrow(() => JSON.parse(result.output));
  const after = repo.readIndex();
  for (const probe of probes) assert.equal(after.find(e => e.path === probe).id, before.find(e => e.path === probe).id);
  if (kind === "edit") { const edited = after.find(e => e.path === "target"); assert.equal(edited.fileId, before.find(e => e.path === "target").fileId); assert.equal(repo.objects.read(edited.id).payload.toString(), "edited known identity"); }
  if (kind === "unchanged") assert.equal(after.find(e => e.path === "target").id, before.find(e => e.path === "target").id);
  if (kind === "delete") assert.equal(after.some(e => e.path === "target"), false);
  if (kind === "explicit") assert.equal(repo.readIndex().find(e => e.path === "moved").fileId, source.fileId);
  if (kind === "two-new") { const index = repo.readIndex(); assert.equal(index.length, 7); assert.equal(new Set(index.map(e => e.fileId)).size, 7); }
  assert.equal(existsSync(join(repo.root, ".git")), false); traces++;
 }
}
console.log(JSON.stringify({ runtime, merges, traces }));
`;

for (const entrypoint of ["sdk", "json", "toon"]) for (const group of ["merge", "stage"]) test(`packed ${entrypoint} ${group} consumers preserve snapshot decisions and probe budgets`, async (t) => {
  const scope = makeTempDir();
  try {
    const environment = testEnvironment({ ...discardChildCoverage(), npm_config_userconfig: devNull, NPM_CONFIG_USERCONFIG: devNull });
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--loglevel=error", "--pack-destination", scope.root], { cwd: packageRoot, env: environment, encoding: "utf8", timeout: 120_000 });
    assert.equal(packed.status, 0, packed.stderr);
    const archive = join(scope.root, packed.stdout.trim().split(/\r?\n/).at(-1)!);
    const root = join(scope.root, "consumer"); mkdirSync(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "move-planning-consumer", private: true, type: "module" }));
    const installed = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", archive], { cwd: root, env: environment, encoding: "utf8", timeout: 120_000 });
    assert.equal(installed.status, 0, installed.stderr);
    symlinkSync(join(packageRoot, "node_modules/@unbrained"), join(root, "node_modules/@unbrained"), "junction");
    writeFileSync(join(root, "consumer.mjs"), program);
    for (const runtime of [process.execPath, "bun"]) {
      const result = spawnSync(runtime, [join(root, "consumer.mjs"), runtime === "bun" ? "bun" : "node", archive, pmExecutable, process.execPath, entrypoint, group], { cwd: root, env: environment, encoding: "utf8", timeout: 900_000 });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const receipt = JSON.parse(result.stdout.trim()) as { runtime: string; merges: number; traces: number };
      assert.equal(receipt.merges, group === "merge" ? 4 : 0); assert.equal(receipt.traces, group === "stage" ? 5 : 0); t.diagnostic(JSON.stringify(receipt));
    }
  } finally { scope.cleanup(); }
});
