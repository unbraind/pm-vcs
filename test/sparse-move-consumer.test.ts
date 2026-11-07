import "./helpers/isolate-session.ts";
/** Verify source eligibility through packed SDK and CLI entrypoints in real non-git trackers. */
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
import { sourceCases, exerciseSourceCase } from ${JSON.stringify(new URL("./helpers/move-source-corpus.ts", import.meta.url).href)};
import assert from "node:assert/strict";
import { devNull } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "pm-vcs/dist/engine/repo.js";
const [runtime, archive, cli, cliRuntime] = process.argv.slice(2);
let cells = 0;
for (const entrypoint of ["sdk", "json", "toon"]) for (const scenario of sourceCases) {
 const root = join(process.cwd(), runtime + "-" + entrypoint + "-" + scenario); mkdirSync(root);
 await new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true }).init("move-source-policy", { defaults: true, author: "fixture" });
 const repo = Repository.init(root);
 if (entrypoint !== "sdk") {
  const installed = spawnSync(cliRuntime, [cli, "package", "install", archive, "--project"], { cwd: root, env: testEnvironment({ npm_config_userconfig: devNull, NPM_CONFIG_USERCONFIG: devNull }), encoding: "utf8", timeout: 120000 });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
 }
 exerciseSourceCase(repo, scenario, paths => {
  if (entrypoint === "sdk") { repo.stage(paths); return; }
  const args = [cli, ...(entrypoint === "json" ? ["--json"] : []), "vcs", "add", ...paths];
  const result = spawnSync(cliRuntime, args, { cwd: root, env: testEnvironment(), encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, entrypoint + "/" + scenario + ": " + result.stdout + result.stderr);
  if (entrypoint === "json") assert.doesNotThrow(() => JSON.parse(result.stdout));
 });
 cells++;
}
console.log(JSON.stringify({ runtime, cells }));
`;

test("packed npm and Bun SDK/CLI JSON/TOON consumers require eligible move sources", async (t) => {
  const scope = makeTempDir();
  try {
    const environment = testEnvironment({ ...discardChildCoverage(), npm_config_userconfig: devNull, NPM_CONFIG_USERCONFIG: devNull });
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--loglevel=error", "--pack-destination", scope.root], { cwd: packageRoot, env: environment, encoding: "utf8", timeout: 120_000 });
    assert.equal(packed.status, 0, packed.stderr);
    const archive = join(scope.root, packed.stdout.trim().split(/\r?\n/).at(-1)!);
    const root = join(scope.root, "consumer"); mkdirSync(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "move-source-consumer", private: true, type: "module" }));
    const installed = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", archive], { cwd: root, env: environment, encoding: "utf8", timeout: 120_000 });
    assert.equal(installed.status, 0, installed.stderr);
    symlinkSync(join(packageRoot, "node_modules/@unbrained"), join(root, "node_modules/@unbrained"), "junction");
    writeFileSync(join(root, "consumer.mjs"), program);
    for (const runtime of [process.execPath, "bun"]) {
      const result = spawnSync(runtime, [join(root, "consumer.mjs"), runtime === "bun" ? "bun" : "node", archive, pmExecutable, process.execPath], { cwd: root, env: environment, encoding: "utf8", timeout: 300_000 });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const receipt = JSON.parse(result.stdout.trim()) as { runtime: string; cells: number };
      assert.equal(receipt.cells, 21); t.diagnostic(JSON.stringify(receipt));
    }
  } finally { scope.cleanup(); }
});
