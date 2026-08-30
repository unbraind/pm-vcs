/**
 * Shared entry-point guard for the executable scripts in this package.
 *
 * All three shipped scripts (the coverage gate, the docstring gate and the
 * merge-driver preparer) must behave identically when imported by their suites
 * versus executed as `main`, so the comparison lives in exactly one measured
 * module and can never drift between copies.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether this module's caller is the process entry point rather than a test
 * import.
 *
 * Both sides are canonicalised through `realpathSync` before comparison. A
 * launcher reaching a script through a symlink (an npm bin shim, a linked
 * workspace) would otherwise compare unequal and skip the gate silently.
 *
 * Resolving only `argv[1]` would be enough under Node's defaults, where the
 * ESM loader realpaths a module before recording `import.meta.url`. It is not
 * enough under `--preserve-symlinks`/`--preserve-symlinks-main`, which leave
 * `moduleUrl` holding the symlink while `realpathSync(entry)` resolves it.
 * The two would then compare unequal on a direct invocation and a gate would
 * exit 0 without scanning — the exact silent skip this function exists to
 * prevent, reintroduced by a runtime flag. Canonicalising both sides adds a
 * second `realpathSync` and removes the dependence on how Node was launched.
 *
 * An unresolvable `argv[1]` **propagates** rather than returning false. The two
 * outcomes are not equally safe: returning false means a release check exits 0
 * having scanned nothing, which is a required gate reporting success without
 * doing its job. Letting `realpathSync` throw turns that into a loud non-zero
 * exit. The case requires `argv[1]` to stop resolving after Node has already
 * loaded the script, so in practice it means the environment is broken, and a
 * broken environment must not silently satisfy a gate.
 *
 * A genuinely different entry path still returns false, which is how a test
 * importing a script declines to run its main wiring.
 *
 * @param argv - The process argv to inspect.
 * @param moduleUrl - The `import.meta.url` of the module that might be main.
 * @returns True when `argv[1]` and `moduleUrl` canonicalise to the same path,
 *          false when they canonicalise to different ones.
 * @throws Whatever `realpathSync` throws when either path cannot be resolved.
 */
export function isMainInvocation(argv: readonly string[], moduleUrl: string): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}
