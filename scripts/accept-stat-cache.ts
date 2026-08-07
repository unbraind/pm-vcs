/**
 * Proves the installed pm CLI stops opening unchanged materialized file content.
 *
 * The acceptance creates and installs a disposable real project, switches to a
 * commit so the file begins without trusted cache metadata, and traces two aged
 * `pm vcs status` calls. The first must open the file to verify its bytes; after
 * that verified observation ages beyond the conservative timestamp window, the
 * second must use metadata only.
 *
 * @example
 * ```bash
 * npm run accept:stat-cache
 * ```
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RACY_WINDOW_NS } from "../engine/worktree.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const executable = join(packageRoot, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
const project = mkdtempSync(join(tmpdir(), "pm-vcs-stat-cache-"));
const statCacheRaceMarginMs = Number(RACY_WINDOW_NS / 1_000_000n) + 100;

/** Runs one installed PM command or preserves its actionable diagnostic. */
function runPm(arguments_: readonly string[]): void {
  const result = spawnSync(process.execPath, [executable, ...arguments_], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      PM_GLOBAL_PATH: undefined,
      PM_PATH: undefined,
      PM_SOURCE_PM_PATH: undefined,
      PM_SOURCE_WORKSPACE_ROOT: undefined,
    },
    timeout: 120_000,
  });
  if (result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
    throw new Error(`pm ${arguments_.join(" ")} failed${detail.length > 0 ? `: ${detail}` : "."}`);
  }
}

/** Traces one installed status call and returns its Linux openat events. */
function traceStatus(name: string): string {
  const trace = join(project, ".pmvcs", `${name}.strace`);
  const result = spawnSync("strace", [
    "-f",
    "-qq",
    "-e",
    "trace=openat",
    "-o",
    trace,
    process.execPath,
    executable,
    "vcs",
    "status",
  ], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      PM_GLOBAL_PATH: undefined,
      PM_PATH: undefined,
      PM_SOURCE_PM_PATH: undefined,
      PM_SOURCE_WORKSPACE_ROOT: undefined,
    },
    timeout: 120_000,
  });
  if (result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
    throw new Error(`straced pm vcs status failed${detail.length > 0 ? `: ${detail}` : "."}`);
  }
  return readFileSync(trace, "utf8");
}

try {
  if (process.platform !== "linux") {
    console.log("stat-cache strace acceptance skipped: Linux is required");
  } else {
    runPm(["init", "stat-cache-acceptance", "--yes", "--author", "acceptance", "--agent-guidance", "skip"]);
    runPm(["install", packageRoot, "--project"]);
    runPm(["vcs", "init"]);
    writeFileSync(join(project, "large.bin"), Buffer.alloc(4 * 1024 * 1024, 7));
    runPm(["vcs", "add", "large.bin"]);
    runPm(["vcs", "commit", "--message", "base"]);
    runPm(["vcs", "branch", "base"]);
    writeFileSync(join(project, "large.bin"), Buffer.alloc(4 * 1024 * 1024, 8));
    runPm(["vcs", "add", "large.bin"]);
    runPm(["vcs", "commit", "--message", "main"]);
    runPm(["vcs", "switch", "base"]);

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, statCacheRaceMarginMs);
    const warming = traceStatus("warming");
    if (!warming.includes("large.bin")) {
      throw new Error("the warming status did not open large.bin, so the acceptance did not exercise byte verification");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, statCacheRaceMarginMs);
    const cached = traceStatus("cached");
    if (cached.includes("large.bin")) {
      const matching = cached.split("\n").filter((line) => line.includes("large.bin")).join("\n");
      throw new Error(`the cached status still opened large.bin instead of using verified filesystem metadata:\n${matching}`);
    }
    console.log("installed-CLI stat-cache strace acceptance passed");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "stat-cache strace acceptance failed");
  process.exitCode = 1;
} finally {
  rmSync(project, { recursive: true, force: true });
}
