import "./helpers/isolate-session.ts";
/** Exercise one packed artifact under actual supported launch/install layouts without host configuration. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testEnvironment } from "./helpers/test-environment.ts";
const packageRoot = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(process.env.PM_VCS_CRASH_TMPDIR ?? tmpdir(), "pm-vcs-admission-installs-"));
const registry = "https://registry.npmjs.org";
const host = "@unbrained/pm-cli@2026.10.30";
const environment = testEnvironment({ NPM_CONFIG_USERCONFIG: process.platform === "win32" ? "NUL" : "/dev/null", NPM_CONFIG_REGISTRY: registry, PM_AUTHOR: "fixture" });
/** Run argv literally in a clean public-registry environment, retaining diagnostic output locally only. */
function run(bin: string, args: readonly string[], cwd: string, overrides = environment): string {
  return execFileSync(bin, [...args], { cwd, env: overrides, encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"] });
}
try {
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", root], packageRoot);
  const archive = join(root, readdirSync(root).find(name => name.endsWith(".tgz"))!);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const results: { mode: string; jsonBytes: number; toonBytes: number; retryBytes: number }[] = [];
  for (const mode of ["npm-global", "bun-global", "npx", "bunx", "project-local"]) {
    const project = join(root, mode); mkdirSync(project);
    let bin: string; let prefix: string[] = [];
    if (mode === "npm-global") {
      const install = join(project, "global"); run("npm", ["install", "--global", "--prefix", install, "--ignore-scripts", host, archive], project);
      bin = join(install, "bin/pm");
    } else if (mode === "bun-global") {
      const install = join(project, "global"); const bins = join(project, "bin"); mkdirSync(bins); mkdirSync(install); writeFileSync(join(install, "package.json"), "{}"); writeFileSync(join(project, "package.json"), "{}");
      run("bun", ["add", "--global", "--ignore-scripts", host, archive], project, { ...environment, BUN_INSTALL: project, BUN_INSTALL_GLOBAL_DIR: install, BUN_INSTALL_BIN: bins });
      bin = join(bins, "pm");
    } else if (mode === "npx") {
      bin = "npx"; prefix = ["--yes", "--package", host, "pm"];
    } else if (mode === "bunx") {
      bin = "bunx"; prefix = ["--package", host, "pm"];
    } else {
      run("npm", ["install", "--prefix", project, "--ignore-scripts", host, archive], project);
      bin = join(project, "node_modules/.bin/pm");
    }
    const pm = (args: string[], env = environment) => run(bin, [...prefix, ...args], project, env);
    pm(["init", "fixture", "--defaults"]);
    pm(["package", "install", archive, "--project"]);
    const created = JSON.parse(pm(["create", "--type", "Task", "--title", "Certified packed item", "--unset", "parent", "--unset", "sprint", "--unset", "release", "--json"])) as { id: string };
    pm(["vcs", "init", "--json"]);
    const request = join(project, "selection.json"); writeFileSync(request, JSON.stringify({ items: [created.id], expectedTip: null }));
    const json = pm(["vcs", "commit-tracker", "Packed JSON", "--input", request, "--json"]);
    const receipt = JSON.parse(json) as { ok: boolean; revision: string }; assert.equal(receipt.ok, true);
    writeFileSync(request, JSON.stringify({ items: [created.id], expectedTip: receipt.revision }));
    pm(["update", created.id, "--title", "Updated packed item", "--unset", "parent", "--unset", "sprint", "--unset", "release"]);
    const toon = pm(["vcs", "commit-tracker", "Packed TOON", "--input", request]); assert.match(toon, /ok: true/);
    const itemPath = join(project, `.agents/pm/tasks/${created.id}.toon`);
    writeFileSync(itemPath, readFileSync(itemPath, "utf8").replace("Updated packed item", "Torn packed item"));
    const retry = pm(["vcs", "commit-tracker", "Refused torn pair", "--input", request, "--json"]);
    assert.equal((JSON.parse(retry) as { code: string }).code, "tracker_capture_retry");
    assert.ok(Buffer.byteLength(json) < 1000 && Buffer.byteLength(toon) < 1000 && Buffer.byteLength(retry) < 1000);
    results.push({ mode, jsonBytes: Buffer.byteLength(json), toonBytes: Buffer.byteLength(toon), retryBytes: Buffer.byteLength(retry) });
    console.log(JSON.stringify({ mode, passed: true }));
  }
  console.log(JSON.stringify({ sha256: digest, modes: results }));
} finally { rmSync(root, { recursive: true, force: true }); }
