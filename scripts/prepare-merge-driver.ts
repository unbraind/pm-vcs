/**
 * Installs pm's field-aware Git merge drivers when the CLI is on `PATH`.
 *
 * A missing CLI is a supported production-install state and skips cleanly. A
 * present but broken CLI fails loudly so package installation cannot pretend it
 * configured merge safety when it did not.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

import { invokeWhenMain } from "./pm-environment.ts";

/** Injectable process boundary used to verify Windows shim execution. */
type MergeInstaller = (
  executable: string,
  arguments_: string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv; shell: boolean },
) => unknown;

/** Returns true only for a regular executable path candidate. */
export function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform === "win32") return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the exact real `pm` launcher on the supplied process path. */
export function pmOnPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const directories = (environment.PATH ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => platform === "win32" && entry.startsWith('"') && entry.endsWith('"')
      ? entry.slice(1, -1)
      : entry)
    .map((entry) => entry === "" && platform !== "win32" ? "." : entry)
    .filter((entry) => entry !== "");
  const extensions = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((entry) => entry.trim()).filter(Boolean)
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `pm${extension}`);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/** Installs merge drivers when available and reports whether installation ran. */
export function main(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  install: MergeInstaller = execFileSync,
): boolean {
  const executable = pmOnPath(environment, platform);
  if (executable === null) return false;
  install(executable, ["merge", "install"], {
    stdio: "inherit",
    env: environment,
    // Node cannot launch .cmd shims through execFile on Windows. Discovery
    // validated this exact path before it crosses the command-shell boundary.
    shell: platform === "win32",
  });
  return true;
}

invokeWhenMain(process.argv, import.meta.url, main, [process.env, process.platform]);
