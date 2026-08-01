/**
 * Runs the release-blocking native PM TOON acceptance in a disposable project.
 *
 * The command intentionally exits non-zero until pm-vcs can stage the TOON item
 * produced by the installed pm CLI. It is independent from `release:check`, so
 * the record-codec blocker remains reproducible while the history identity gate
 * is also failing closed.
 *
 * @example
 * ```bash
 * npm run accept:native-toon
 * ```
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const executable = join(packageRoot, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
const project = mkdtempSync(join(tmpdir(), "pm-vcs-native-toon-"));
const initOnly = process.argv.includes("--init-only");

/** Runs one installed-CLI acceptance step or preserves its actionable failure. */
function run(arguments_: readonly string[]): void {
  const result = spawnSync(process.execPath, [executable, ...arguments_], {
    cwd: project,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
    throw new Error(`pm ${arguments_.join(" ")} failed${detail.length > 0 ? `: ${detail}` : "."}`);
  }
}

try {
  run(["init", "toon-acceptance", "--yes", "--author", "acceptance", "--agent-guidance", "skip"]);
  if (initOnly) {
    console.log("native TOON acceptance launcher passed");
  } else {
    run(["install", packageRoot, "--project"]);
    run(["vcs", "init", "--record-path", ".agents/pm/**/*.toon", "--set-field", "tags:set,history:sequence"]);
    run(["create", "Task", "Native TOON acceptance", "--author", "acceptance"]);
    run(["vcs", "add"]);
    console.log("native TOON acceptance passed");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "native TOON acceptance failed");
  process.exitCode = 1;
} finally {
  rmSync(project, { recursive: true, force: true });
}
