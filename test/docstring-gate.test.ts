/**
 * Behavioral coverage for this package's docstring gate launcher.
 *
 * The gate's RULES are not tested here. They live in the canonical analyzer
 * published as `pm-ops/docstrings`, together with a defeat-attempt suite
 * covering the ways a docstring can look present without being one. Re-asserting
 * those here would duplicate a suite that already exists and would drift from it.
 *
 * What this file proves is what the launcher itself adds: that it scans THIS
 * package by default and reports it as fully documented, that an undocumented
 * declaration is reported actionably and exits non-zero, that a clean scan exits
 * zero, and that the entry-point guard does not silently skip the gate.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { isMainInvocation, main, runGate } from "../scripts/docstring-gate.ts";

/** This package's own root, the default the CLI entry point scans. */
const packageRoot = resolve(import.meta.dirname, "..");

test("docstring gate runGate reports this package as fully documented", () => {
  const result = runGate(packageRoot);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^docstring-gate: \d+ file\(s\), \d+ declaration\(s\) documented\.$/);
});

test("docstring gate runGate reports an undocumented declaration and exits non-zero", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-docgate-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "sample.ts"), "export function undocumented(value: string): string {\n  return value;\n}\n");
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "", "a failing run writes nothing to stdout");
    assert.match(result.stderr, /1 violation\(s\)/);
    // Assert the LAYOUT runGate formats, not the reason wording, which pm-ops
    // owns: re-asserting the analyzer's strings here would re-couple this suite
    // to rules the header says live with the analyzer.
    assert.match(result.stderr, /sample\.ts:1\s+undocumented\s+-\s+\S/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docstring gate runGate passes a root whose every declaration is documented", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-docgate-clean-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "sample.ts"),
      "/** Return the value unchanged, so the identity case has a named home. */\nexport function identity(value: string): string {\n  return value;\n}\n",
    );
    const result = runGate(root);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docstring gate runGate throws rather than passing vacuously on a root with no TypeScript", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-docgate-empty-"));
  try {
    let thrown: unknown;
    try {
      runGate(root);
    } catch (error) {
      thrown = error;
    }
    // That it throws is the launcher's contract; the wording is pm-ops's.
    assert.ok(thrown instanceof Error, "scanning zero files must throw, not report a clean scan");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docstring gate main with no arguments scans this package and leaves the exit code at zero", () => {
  const previousExitCode = process.exitCode;
  const written: string[] = [];
  const restore = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  // Seeded to a failing value so the assertion below proves main drove it to 0,
  // rather than passing on whatever a previous test happened to leave behind.
  process.exitCode = 1;
  let observedExitCode: typeof process.exitCode;
  try {
    main([]);
    observedExitCode = process.exitCode;
  } finally {
    process.stdout.write = restore;
    process.exitCode = previousExitCode;
  }
  assert.equal(observedExitCode, 0, "a clean run must clear a non-zero exit code, not merely leave it");
  assert.equal(written.length, 1, "one stdout write, newline-terminated");
  assert.match(written[0]!, /documented\.\n$/, "main appends the trailing newline runGate omits");
});

test("docstring gate main with an explicit root writes the failure stream and sets a non-zero exit code", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-docgate-main-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "sample.ts"), "export function undocumented(value: string): string {\n  return value;\n}\n");
    const previousExitCode = process.exitCode;
    const written: string[] = [];
    const restore = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    // Seeded to 0 so the assertion cannot pass on state inherited from an
    // earlier failing test — it must be main that sets 1.
    process.exitCode = 0;
    let observedExitCode: typeof process.exitCode;
    try {
      main([root]);
      observedExitCode = process.exitCode;
    } finally {
      process.stderr.write = restore;
      process.exitCode = previousExitCode;
    }
    assert.equal(observedExitCode, 1, "a violating run sets process.exitCode rather than exiting");
    assert.equal(written.length, 1);
    assert.match(written[0]!, /1 violation\(s\)[\s\S]*\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docstring gate isMainInvocation recognizes a direct invocation and rejects a test import", () => {
  const gatePath = resolve(packageRoot, "scripts", "docstring-gate.ts");
  const gateUrl = pathToFileURL(gatePath).href;
  assert.equal(isMainInvocation(["node", gatePath], gateUrl), true, "a direct invocation runs the gate");
  assert.equal(isMainInvocation(["node", resolve(packageRoot, "package.json")], gateUrl), false, "another entry point does not");
  assert.equal(isMainInvocation(["node"], gateUrl), false, "a missing argv[1] does not");
});

test("docstring gate isMainInvocation resolves a symlinked entry path to the real module URL", () => {
  // Without this case the direct-invocation assertion is tautological: argv[1]
  // and moduleUrl are built from the same path through the same transformation,
  // so it passes even with realpathSync removed - and realpathSync is the whole
  // reason the guard exists. npm bin shims and linked workspaces reach a script
  // through a symlink, and a gate that silently declines to run is worse than
  // one that throws.
  const gatePath = resolve(packageRoot, "scripts", "docstring-gate.ts");
  const linkDir = mkdtempSync(join(tmpdir(), "pm-vcs-docgate-link-"));
  const link = join(linkDir, "docstring-gate.ts");
  try {
    symlinkSync(gatePath, link);
    assert.equal(
      isMainInvocation(["node", link], pathToFileURL(gatePath).href),
      true,
      "a symlinked entry path resolves to the real module and runs the gate",
    );
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }
});

test("docstring gate isMainInvocation returns false rather than throwing when argv[1] cannot be resolved", () => {
  const gateUrl = pathToFileURL(resolve(packageRoot, "scripts", "docstring-gate.ts")).href;
  // A release gate that crashes on an unresolvable argv is worse than one that
  // declines to self-invoke: the guard must fail closed, not propagate ENOENT.
  assert.equal(isMainInvocation(["node", resolve(packageRoot, "does-not-exist.ts")], gateUrl), false);
});
