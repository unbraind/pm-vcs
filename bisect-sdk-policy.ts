/** Keep optional SDK Git discovery outside the native bisect worker's capabilities. */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { promisify } from "node:util";

/** Reject Git before a process can be created; SDK optional-discovery callers handle absence. */
function requireNativeExecutable(file: unknown): void {
  if (typeof file === "string" && /^git(?:\.exe)?$/i.test(basename(file))) {
    throw Object.assign(new Error("Git execution is unavailable inside a native bisect SDK worker."), { code: "ENOTSUP" });
  }
}

for (const name of ["execFile", "execFileSync", "spawn", "spawnSync"] as const) {
  const original = childProcess[name];
  /** Preserve the native process API for every executable except Git. */
  const guarded = (file: unknown, ...args: unknown[]): unknown => {
    requireNativeExecutable(file);
    return Reflect.apply(original, childProcess, [file, ...args]);
  };
  if (name === "execFile") {
    const asynchronous = promisify(childProcess.execFile);
    Object.defineProperty(guarded, promisify.custom, {
      /** Preserve execFile's stdout/stderr promise result without bypassing the policy. */
      value: (file: unknown, ...args: unknown[]): unknown => {
        requireNativeExecutable(file);
        return Reflect.apply(asynchronous, childProcess, [file, ...args]);
      },
    });
  }
  Object.defineProperty(childProcess, name, { value: guarded });
}
syncBuiltinESMExports();
