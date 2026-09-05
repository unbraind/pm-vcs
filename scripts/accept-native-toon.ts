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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { errorMessage, packageRoot, pmExecutable, runPm, setExitCodeWhenMain } from "./pm-environment.ts";

/** Runs the installed-CLI workflow and returns a process-compatible status. */
export function main(arguments_: readonly string[], executable = pmExecutable): number {
  const project = mkdtempSync(join(tmpdir(), "pm-vcs-native-toon-"));
  let status = 0;
  try {
    runPm(project, ["init", "toon-acceptance", "--yes", "--author", "acceptance", "--agent-guidance", "skip"], executable);
    if (arguments_.includes("--init-only")) {
      console.log("native TOON acceptance launcher passed");
    } else {
      runPm(project, ["package", "install", packageRoot, "--project"], executable);
      runPm(project, [
        "vcs", "init",
        "--record-path", ".agents/pm/**/*.toon",
        "--set-field", "tags:set,notes:sequence,updated_at:timestamp",
      ], executable);
      runPm(project, ["create", "Task", "Native TOON acceptance", "--author", "acceptance"], executable);
      runPm(project, ["vcs", "add"], executable);
      console.log("native TOON acceptance passed");
    }
  } catch (error) {
    console.error(errorMessage(error, "native TOON acceptance failed"));
    status = 1;
  }
  rmSync(project, { recursive: true, force: true });
  return status;
}

setExitCodeWhenMain(process.argv, import.meta.url, main, [process.argv.slice(2)]);
