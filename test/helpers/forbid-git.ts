/** Fail installed no-git regressions if a process boundary receives a Git execution request. */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { promisify } from "node:util";

/** Make a Git request observable as a real worker failure instead of SDK fallback. */
function forbidGit(file: unknown): void {
  if (typeof file === "string" && /^git(?:\.exe)?$/i.test(basename(file))) {
    process.stderr.write("A native bisect operation attempted to execute git.\n");
    process.exit(92);
  }
}

for (const name of ["execFile", "execFileSync", "spawn", "spawnSync"] as const) {
  const original = childProcess[name];
  /** Preserve actual process execution for all permitted commands. */
  const guarded = (file: unknown, ...args: unknown[]): unknown => {
    forbidGit(file);
    return Reflect.apply(original, childProcess, [file, ...args]);
  };
  if (name === "execFile") {
    const asynchronous = promisify(childProcess.execFile);
    Object.defineProperty(guarded, promisify.custom, {
      /** Retain execFile's real stdout/stderr promise contract. */
      value: (file: unknown, ...args: unknown[]): unknown => {
        forbidGit(file);
        return Reflect.apply(asynchronous, childProcess, [file, ...args]);
      },
    });
  }
  Object.defineProperty(childProcess, name, { value: guarded });
}
syncBuiltinESMExports();
