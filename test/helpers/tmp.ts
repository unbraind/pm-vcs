/**
 * Lightweight temporary directories for engine tests.
 *
 * The engine modules are filesystem code, so each test stands up a real
 * directory and tears it down afterwards. Nothing is mocked: mocking the
 * filesystem would assert against the mock, not against the store.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Own the entire temporary namespace, including ledgers created outside fixture roots.
// Descendants inherit this scope; a fatal publication child cannot strand its ledgers.
// Ordinary workers must retain the inherited location of recovery ledgers.
if (process.argv[1]?.endsWith(".test.ts")) {
  // Packed CLI semantics keep every native call while avoiding unrelated host
  // writeback contention inside their unchanged command deadlines.
  const parent = ["first-class-conflicts.test.ts", "tracker-admission.test.ts"].includes(basename(process.argv[1])) ? process.env.PM_VCS_CRASH_TMPDIR ?? tmpdir() : tmpdir();
  const scope = realpathSync(mkdtempSync(join(parent, "pm-vcs-suite-")));
  process.env.TMPDIR = scope; process.env.TEMP = scope; process.env.TMP = scope;
  const removeScope = rmSync;
  process.once("exit", () => removeScope(scope, { recursive: true, force: true }));
}

/**
 * Creates a fresh empty directory and returns a cleanup handle.
 *
 * @returns The absolute path and a removal function.
 */
export function makeTempDir(parent = tmpdir()): { root: string; cleanup(): void } {
  // Canonicalized, because the engine's containment checks use `resolve`/`relative`
  // rather than a filesystem canonicalization, and a temp root that is a symlink —
  // `/var/folders/...` for `/private/var/folders/...` on macOS — would make a path
  // inside the repository look like a path outside it.
  const root = realpathSync(mkdtempSync(join(parent, "pm-vcs-eng-")));
  return {
    root,
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Package root, so tests and workers can locate the manifest and helpers. */
export const packageRoot = resolve(import.meta.dirname, "..", "..");
