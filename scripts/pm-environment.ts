import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** PM context variables that must not leak into disposable acceptance projects. */
const pmContextKeys = [
  "PM_GLOBAL_PATH",
  "PM_PATH",
  "PM_SOURCE_PM_PATH",
  "PM_SOURCE_WORKSPACE_ROOT",
] as const;

/**
 * Copies an environment without the parent invocation's PM tracker context.
 *
 * Disposable projects must discover their own tracker. Deleting the keys keeps
 * that contract explicit and avoids relying on child-process value coercion.
 *
 * @param environment - Parent environment to copy and sanitize.
 * @returns An independent environment with PM tracker discovery variables absent.
 */
export function withoutPmContext(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated = { ...environment };
  for (const key of pmContextKeys) delete isolated[key];
  return isolated;
}

/** Absolute package root shared by installed-CLI acceptance programs. */
export const packageRoot = resolve(import.meta.dirname, "..");

/** Installed PM CLI entrypoint used by acceptance programs. */
export const pmExecutable = join(packageRoot, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");

/** Converts a failed child result into one stable actionable diagnostic. */
export function processFailure(result: SpawnSyncReturns<string>, prefix: string, fallback: string): string {
  const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
  return `${prefix}${detail.length > 0 ? `: ${detail}` : fallback}`;
}

/** Preserves an Error diagnostic while giving non-Error throws a stable fallback. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Runs one installed PM command in an isolated disposable project. */
export function runPm(project: string, arguments_: readonly string[], executable = pmExecutable): void {
  const result = spawnSync(process.execPath, [executable, ...arguments_], {
    cwd: project,
    encoding: "utf8",
    env: withoutPmContext(process.env),
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(processFailure(result, `pm ${arguments_.join(" ")} failed`, "."));
  }
}

/** Returns whether Node directly invoked the supplied module URL. */
export function isMainInvocation(argv: readonly string[], moduleUrl: string): boolean {
  return argv[1] !== undefined && pathToFileURL(argv[1]).href === moduleUrl;
}

/** Runs a process-status action only for a module's direct invocation. */
export function setExitCodeWhenMain<TArguments extends readonly unknown[]>(
  argv: readonly string[],
  moduleUrl: string,
  action: (...arguments_: TArguments) => number,
  arguments_: TArguments,
): void {
  if (isMainInvocation(argv, moduleUrl)) process.exitCode = action(...arguments_);
}

/** Invokes a lifecycle action only when Node directly executed its module. */
export function invokeWhenMain<TArguments extends readonly unknown[]>(
  argv: readonly string[],
  moduleUrl: string,
  action: (...arguments_: TArguments) => unknown,
  arguments_: TArguments,
): void {
  if (isMainInvocation(argv, moduleUrl)) action(...arguments_);
}
