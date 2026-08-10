#!/usr/bin/env node
/**
 * Enforce meaningful docstrings across pm-vcs source declarations.
 *
 * Thin launcher over the canonical analyzer published as `pm-ops/docstrings`,
 * so the fleet enforces one lexer-backed policy rather than a vendored copy per
 * repository. Every rule lives in the analyzer: every exported declaration,
 * every public member of an exported class, and every substantial private
 * function needs a JSDoc block that contributes information beyond its
 * identifier. This file only chooses the root, maps the report onto the process
 * streams, and sets the exit code.
 *
 * The analyzer has no ignore list and treats unknown declaration forms as
 * violations, so a new syntax form fails closed rather than passing vacuously,
 * and its defeat-attempt suite lives with the analyzer where the policy is
 * implemented.
 *
 * @example
 * ```bash
 * node scripts/docstring-gate.ts          # scan this package
 * node scripts/docstring-gate.ts ../other # scan another repository root
 * ```
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { analyzeDocstringCoverage } from "pm-ops/docstrings";

/** Outcome of one gate run, held as plain strings so a test can inspect it. */
interface GateResult {
  /** Exit code the run would produce: 0 when every declaration is documented. */
  readonly exitCode: number;
  /** Bytes the run would write to stdout, newline-free so a test can match exactly. */
  readonly stdout: string;
  /** Bytes the run would write to stderr, newline-free so a test can match exactly. */
  readonly stderr: string;
}

/** This package's root, resolved from this file rather than the caller's cwd. */
const defaultRoot = resolve(import.meta.dirname, "..");

/**
 * Analyze one repository root and return what the gate would write.
 *
 * Pure by design: it touches neither the process streams nor `process.exit`, so
 * a test imports it and asserts on the returned strings. That shape is also what
 * keeps this file fully branch-coverable - an injectable-boundary design
 * (`options.log ?? console.log`) leaves one side of every fallback unreachable
 * from an in-process test, which is the kind of permanently-uncovered branch
 * that invites someone to weaken the coverage gate rather than the code.
 *
 * Every violation is reported with its file, line and reason, so a failing gate
 * is actionable from CI output alone. The analyzer refuses to pass vacuously on
 * a root holding no TypeScript, so a mistyped root throws here rather than
 * reporting a clean scan of nothing.
 *
 * @param root - Absolute repository root to scan.
 * @returns The exit code and the newline-free stdout/stderr content; {@link main}
 *          appends the trailing newline when it writes them.
 */
export function runGate(root: string): GateResult {
  const report = analyzeDocstringCoverage({ root });

  if (report.violations.length > 0) {
    const lines = report.violations.map(
      (violation) => `  ${violation.file}:${violation.line}  ${violation.symbol} - ${violation.reason}`,
    );
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `docstring-gate: ${report.violations.length} violation(s) across ${report.files_scanned} file(s):\n\n` +
        `${lines.join("\n")}\n\n` +
        "Every exported declaration, every public member of an exported class, and every\n" +
        "non-exported function with a body over the threshold needs a JSDoc block that adds\n" +
        "information the identifier does not.",
    };
  }

  return {
    exitCode: 0,
    stdout: `docstring-gate: ${report.files_scanned} file(s), ${report.declarations_checked} declaration(s) documented.`,
    stderr: "",
  };
}

/**
 * CLI entry point: resolve the root from argv, run the gate and emit its result.
 *
 * Takes the argv slice rather than an already-resolved root so the default-root
 * decision is made INSIDE a function a test can call both ways. At module level
 * that choice would be a branch no in-process test can take twice, since a test
 * run always imports with the same argv - the kind of permanently-uncovered
 * branch that ends with someone lowering the coverage threshold.
 *
 * Appends a trailing newline to each non-empty stream so the next `release:check`
 * step starts on its own line, while {@link runGate}'s returned strings stay
 * newline-free so a test can assert on them exactly. Sets `process.exitCode`
 * rather than calling `process.exit`, so a test can invoke this in-process,
 * observe the streams, and restore the code afterwards.
 *
 * @param args - The argv slice after the script path; empty selects this package.
 */
export function main(args: readonly string[]): void {
  const result = runGate(args[0] === undefined ? defaultRoot : resolve(args[0]));
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

/**
 * Whether this module is the process entry point rather than a test import.
 *
 * Both sides are canonicalised through `realpathSync` before comparison. A
 * launcher reaching this file through a symlink (an npm bin shim, a linked
 * workspace) would otherwise compare unequal and skip the gate silently.
 *
 * Resolving only `argv[1]` would be enough under Node's defaults, where the
 * ESM loader realpaths a module before recording `import.meta.url`. It is not
 * enough under `--preserve-symlinks`/`--preserve-symlinks-main`, which leave
 * `moduleUrl` holding the symlink while `realpathSync(entry)` resolves it.
 * The two would then compare unequal on a direct invocation and the gate would
 * exit 0 without scanning — the exact silent skip this function exists to
 * prevent, reintroduced by a runtime flag. Canonicalising both sides adds a
 * second `realpathSync` and removes the dependence on how Node was launched.
 *
 * An unresolvable `argv[1]` **propagates** rather than returning false. The two
 * outcomes are not equally safe: returning false means `npm run docstring`
 * exits 0 having scanned nothing, which is a required release check reporting
 * success without doing its job — the one failure this gate exists to prevent.
 * Letting `realpathSync` throw turns that into a loud non-zero exit. The case
 * requires `argv[1]` to stop resolving after Node has already loaded this file,
 * so in practice it means the environment is broken, and a broken environment
 * must not silently satisfy a gate.
 *
 * A genuinely different entry path still returns false, which is how a test
 * importing this module declines to run the gate.
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

// Run only when invoked directly, not when imported by the test suite. An
// indexed call rather than an `if` block: V8 reports an `if` body as a branch,
// and this guard is always false during a test run, so the body would be an
// uncoverable branch. The placeholder takes the same argument as `main` so
// element 0 - the one a test-run import invokes - is a covered function call
// rather than an unused expression.
[(_args: readonly string[]): void => {}, main][Number(isMainInvocation(process.argv, import.meta.url))](
  process.argv.slice(2),
);
