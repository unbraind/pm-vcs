/**
 * Lightweight temporary directories for engine tests.
 *
 * The engine modules are filesystem code, so each test stands up a real
 * directory and tears it down afterwards. Nothing is mocked: mocking the
 * filesystem would assert against the mock, not against the store.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a fresh empty directory and returns a cleanup handle.
 *
 * @returns The absolute path and a removal function.
 */
export function makeTempDir(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-eng-"));
  return {
    root,
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
