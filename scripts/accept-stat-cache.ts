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
import { join } from "node:path";
import { RACY_WINDOW_NS } from "../engine/worktree.ts";
import {
  errorMessage,
  packageRoot,
  pmExecutable,
  processFailure,
  runPm,
  setExitCodeWhenMain,
  withoutPmContext,
} from "./pm-environment.ts";

const statCacheRaceMarginMs = Number(RACY_WINDOW_NS / 1_000_000n) + 100;

/** Traces one installed status call and returns its Linux openat events. */
export function traceStatus(project: string, name: string, executable = pmExecutable, tracer = "strace"): string {
  const trace = join(project, ".pmvcs", `${name}.strace`);
  const result = spawnSync(tracer, [
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
    env: withoutPmContext(process.env),
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(processFailure(result, "straced pm vcs status failed", "."));
  }
  return readFileSync(trace, "utf8");
}

/** Requires the first status to read the file and the second to avoid it. */
export function assertTraceBehavior(warming: string, cached: string): void {
  if (!warming.includes("large.bin")) {
    throw new Error("the warming status did not open large.bin, so the acceptance did not exercise byte verification");
  }
  if (cached.includes("large.bin")) {
    const matching = cached.split("\n").filter((line) => line.includes("large.bin")).join("\n");
    throw new Error(`the cached status still opened large.bin instead of using verified filesystem metadata:\n${matching}`);
  }
}

/** Runs the Linux strace acceptance and returns a process-compatible status. */
export function main(platform: NodeJS.Platform, executable = pmExecutable, tracer = "strace"): number {
  const project = mkdtempSync(join(tmpdir(), "pm-vcs-stat-cache-"));
  let status = 0;
  try {
    if (platform !== "linux") {
      console.log("stat-cache strace acceptance skipped: Linux is required");
    } else {
      runPm(project, ["init", "stat-cache-acceptance", "--yes", "--author", "acceptance", "--agent-guidance", "skip"], executable);
      runPm(project, ["install", packageRoot, "--project"], executable);
      runPm(project, ["vcs", "init"], executable);
      writeFileSync(join(project, "large.bin"), Buffer.alloc(4 * 1024 * 1024, 7));
      runPm(project, ["vcs", "add", "large.bin"], executable);
      runPm(project, ["vcs", "commit", "--message", "base"], executable);
      runPm(project, ["vcs", "branch", "base"], executable);
      writeFileSync(join(project, "large.bin"), Buffer.alloc(4 * 1024 * 1024, 8));
      runPm(project, ["vcs", "add", "large.bin"], executable);
      runPm(project, ["vcs", "commit", "--message", "main"], executable);
      runPm(project, ["vcs", "switch", "base"], executable);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, statCacheRaceMarginMs);
      const warming = traceStatus(project, "warming", executable, tracer);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, statCacheRaceMarginMs);
      assertTraceBehavior(warming, traceStatus(project, "cached", executable, tracer));
      console.log("installed-CLI stat-cache strace acceptance passed");
    }
  } catch (error) {
    console.error(errorMessage(error, "stat-cache strace acceptance failed"));
    status = 1;
  }
  rmSync(project, { recursive: true, force: true });
  return status;
}

setExitCodeWhenMain(process.argv, import.meta.url, main, [process.platform]);
