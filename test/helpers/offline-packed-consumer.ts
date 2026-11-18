import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, packageRoot } from "./tmp.ts";

/** Install the archive with a fresh cache that contains the locked runtime dependency. */
export function installOfflinePackedConsumer(archive: string, cwd: string, env: NodeJS.ProcessEnv): void {
  const lock = JSON.parse(readFileSync(join(packageRoot, "package-lock.json"), "utf8"));
  const pako = lock.packages["node_modules/pako"].version;
  const cache = makeTempDir();
  try {
    // A new consumer has no lockfile. npm needs the packument as well as the tarball.
    // Pako has no transitive dependencies, and the fixture supplies the SDK peer separately.
    const primed = spawnSync("npm", ["cache", "add", `pako@${pako}`, "--cache", cache.root, "--offline=false"], {
      cwd,
      env: { ...env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--network-family-autoselection-attempt-timeout=5000" },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(primed.status, 0, primed.error?.message ?? primed.stderr);

    const installed = spawnSync("npm", [
      "install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund",
      "--cache", cache.root, archive,
    ], { cwd, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(installed.status, 0, installed.error?.message ?? installed.stderr);
  } finally {
    cache.cleanup();
  }
}
