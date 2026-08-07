/**
 * Behavioural tests for the docstring coverage gate.
 *
 * Every case imports the gate's exported functions and runs them in-process
 * against a throwaway workspace, because the properties worth protecting are
 * exactly the ones a unit test of an internal helper would miss: that the gate
 * reads the directory it was pointed at, that it refuses to pass when it found
 * nothing, and that a declaration hidden in a string or a comment is not
 * mistaken for real code. In-process execution is what attributes coverage to
 * the script file - a subprocess run is never measured by the parent's coverage
 * report, so spawning the gate would leave it at zero percent.
 */
import { describe, it } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import {
  addsInformation,
  collectSourceFiles,
  DEFAULT_ROOTS,
  isMainInvocation,
  main,
  runGate,
  scanFile,
  toWords,
} from "../scripts/docstring-gate.ts";

/** Absolute path to the gate under test, used to build a `file://` module URL. */
const GATE_PATH = resolve(import.meta.dirname, "..", "scripts", "docstring-gate.ts");

/**
 * Build a temporary workspace from `files` and run the gate over it.
 *
 * Paths are relative to the workspace root, so a case can place sources under
 * `src/`, under `scripts/`, or nowhere at all. With `roots` omitted the gate is
 * pointed at exactly the directories the fixture created, which keeps each case
 * about the behaviour it names rather than about which default roots happen to
 * exist. Pass `[]` to invoke with no arguments and exercise the defaults
 * themselves. The workspace is removed even when the assertion that follows
 * fails.
 */
function runGateOver(files: Record<string, string>, roots?: string[]): {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "docstring-gate-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    const derived = [
      ...new Set(
        Object.keys(files)
          .map((name) => name.split("/")[0])
          .filter((top) => Object.keys(files).some((n) => n.startsWith(`${top}/`))),
      ),
    ].sort();
    // An empty `roots` argument mirrors invoking the CLI with no arguments, so
    // the gate's default roots apply; `undefined` derives roots from the fixture.
    const effective = roots === undefined ? derived : roots.length === 0 ? DEFAULT_ROOTS : roots;
    return runGate(effective, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A docstring that carries real information about a `parseConfig` function. */
const GOOD_DOC = "/** Load and validate the YAML settings file from disk. */\n";

describe("docstring-gate: what counts as documented", () => {
  it("passes an exported function carrying an informative docstring", () => {
    const run = runGateOver({ "src/a.ts": `${GOOD_DOC}export function parseConfig(): void {}` });
    equal(run.exitCode, 0, run.stderr);
    match(run.stdout, /documented surface complete/);
  });

  it("fails an exported function with no docstring, naming file, line and symbol", () => {
    const run = runGateOver({ "src/a.ts": "export function parseConfig(): void {}" });
    equal(run.exitCode, 1);
    match(run.stderr, /src\/a\.ts:1\s+parseConfig - no docstring/);
  });

  it("rejects a docstring that only restates the identifier", () => {
    // Long enough to clear the word-count floor, so this exercises the
    // name-echo check rather than the length check.
    const run = runGateOver({
      "src/a.ts":
        "/** Parse the workspace config file. */\nexport function parseWorkspaceConfigFile(): void {}",
    });
    equal(run.exitCode, 1);
    match(run.stderr, /restates the identifier/);
  });

  it("rejects a docstring too short to say anything", () => {
    const run = runGateOver({ "src/a.ts": "/** Reads it. */\nexport const TIMEOUT = 5;" });
    equal(run.exitCode, 1);
    match(run.stderr, /under 4 meaningful words/);
  });

  it("requires a docstring on every exported declaration kind", () => {
    const run = runGateOver({
      "src/a.ts": [
        "export interface Config { name: string }",
        "export type Json = string | number;",
        "export const API_URL = 'https://example.com';",
        "export class Loader {}",
        "export enum Mode { On }",
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    for (const symbol of ["Config", "Json", "API_URL", "Loader", "Mode"]) {
      match(run.stderr, new RegExp(`${symbol} - no docstring`));
    }
  });
});

describe("docstring-gate: defeat attempts", () => {
  it("does not accept a JSDoc that only exists inside a string literal", () => {
    const run = runGateOver({
      "src/a.ts": "export const MSG = '/** Load and validate settings from disk. */';",
    });
    equal(run.exitCode, 1);
    match(run.stderr, /MSG - no docstring/);
  });

  it("does not accept a JSDoc attached to a commented-out declaration", () => {
    const run = runGateOver({
      "src/a.ts": [
        "// /** Load and validate settings from disk. */",
        "// export function deadCode(): void {}",
        "export function liveCode(): void {}",
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /liveCode - no docstring/);
    ok(!run.stderr.includes("deadCode"), "a commented-out declaration is not a declaration");
  });

  it("does not let a line comment or a bare block comment stand in for JSDoc", () => {
    const run = runGateOver({
      "src/a.ts": [
        "// Load and validate the settings file from disk.",
        "export function parseConfig(): void {}",
        "/* Load and validate the settings file from disk. */",
        "export function readConfig(): void {}",
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /parseConfig - no docstring/);
    match(run.stderr, /readConfig - no docstring/);
  });

  it("does not let an unrelated banner comment document the declaration below it", () => {
    const run = runGateOver({
      "src/a.ts": [
        "/** Shared helpers for reading workspace settings from disk. */",
        "",
        "// section divider",
        "export function parseConfig(): void {}",
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /parseConfig - no docstring/);
  });

  it("discovers files added after the fact, including in nested directories", () => {
    const run = runGateOver({
      "src/a.ts": `${GOOD_DOC}export function parseConfig(): void {}`,
      "src/nested/deep/b.ts": "export function hidden(): void {}",
    });
    equal(run.exitCode, 1);
    match(run.stderr, /nested\/deep\/b\.ts/);
  });

  it("refuses to pass vacuously when a root holds no TypeScript at all", () => {
    const run = runGateOver({ "src/NOTES.md": "# nothing to scan" });
    equal(run.exitCode, 1);
    match(run.stderr, /no source files found under src - refusing to pass vacuously/);
  });

  it("refuses a requested root that does not exist", () => {
    const run = runGateOver({ "src/a.ts": `${GOOD_DOC}export function parseConfig(): void {}` }, ["nope"]);
    equal(run.exitCode, 1);
    match(run.stderr, /root\(s\) missing or not a directory: nope/);
  });

  it("the default repository root discovers root-level and nested sources", () => {
    const run = runGateOver(
      {
        "index.ts": `${GOOD_DOC}export function parseConfig(): void {}`,
        "engine/deep.ts": "export function hidden(): void {}",
      },
      [],
    );
    equal(run.exitCode, 1);
    match(run.stderr, /engine\/deep\.ts/);
  });

  it("refuses a root that exists but is a file", () => {
    const run = runGateOver({ "src": "not a directory" }, ["src"]);
    equal(run.exitCode, 1);
    match(run.stderr, /missing or not a directory: src/);
  });
});

describe("docstring-gate: parsing real TypeScript", () => {
  it("survives template literals and regular expressions", () => {
    // A hand-driven lexer stalls on the `#` inside this template and mis-lexes
    // the regex as division; a real parse handles both.
    const run = runGateOver({
      "src/a.ts": [
        "const heading = (t: string): string => `# ${t} - ${t}`;",
        "const RELEASE = /^##\\s+(.+)$/gm;",
        "export function parseConfig(): void { void heading; void RELEASE; }",
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /parseConfig - no docstring/);
  });

  it("checks non-private members of an exported class, and skips private ones", () => {
    const run = runGateOver({
      "src/a.ts": [
        "/** Reads workspace settings and caches parsed results. */",
        "export class Loader {",
        "  private cache = new Map<string, string>();",
        "  #secret = 1;",
        "  protected hidden(): void {}",
        "  constructor() {}",
        "  load(): void {}",
        "  static create(): void {}",
        "  get size(): number { return 0; }",
        "  set size(next: number) { void next; }",
        "}",
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    for (const symbol of ["constructor", "load", "create", "size"]) {
      match(run.stderr, new RegExp(`Loader\\.${symbol} - no docstring`));
    }
    // Assert the qualified symbol, not a bare substring: a path or an unrelated
    // word in the report would otherwise satisfy the negative.
    for (const skipped of ["cache", "secret", "hidden"]) {
      ok(
        !run.stderr.includes(`Loader.${skipped}`),
        `Loader.${skipped} is outside the documented surface`,
      );
    }
  });

  it("requires a docstring on an abstract member, whose declaration is the contract", () => {
    const run = runGateOver({
      "src/a.ts": [
        "/** Reads workspace settings and caches parsed results. */",
        "export abstract class Loader {",
        "  abstract load(key: string): string;",
        "}",
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /Loader\.load - no docstring/);
  });

  it("requires a docstring on an anonymous default-exported function", () => {
    const run = runGateOver({ "src/a.ts": "export default function () {}" });
    equal(run.exitCode, 1);
    match(run.stderr, /default - no docstring/);
  });

  it("does not let a documented outer function satisfy an undocumented nested one", () => {
    const run = runGateOver({
      "src/a.ts": [
        "/** Load and validate the YAML settings file from disk. */",
        "export function parseConfig(): number {",
        "  function helper(): number {",
        "    const a = 1;",
        "    const b = 2;",
        "    const c = 3;",
        "    const d = 4;",
        "    return a + b + c + d;",
        "  }",
        "  return helper();",
        "}",
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /helper - no docstring/);
  });

  it("does not scan declaration files, whose surface is documented at its source", () => {
    const run = runGateOver({
      "src/a.ts": `${GOOD_DOC}export function parseConfig(): void {}`,
      "src/legacy.d.ts": "export declare function undocumentedAmbient(): void;",
    });
    equal(run.exitCode, 0, run.stderr);
  });

  it("holds a long internal function to the rule but leaves a short one alone", () => {
    const run = runGateOver({
      "src/a.ts": [
        "function tiny(): number { return 1; }",
        "function long(): number {",
        "  const a = 1;",
        "  const b = 2;",
        "  const c = 3;",
        "  const d = 4;",
        "  const e = 5;",
        "  return a + b + c + d + e;",
        "}",
        `${GOOD_DOC}export function parseConfig(): number { return tiny() + long(); }`,
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /\blong - no docstring/);
    ok(!run.stderr.includes("tiny - no docstring"), "a short internal helper needs no docstring");
  });

  it("does not let one statement-level docstring cover several bindings", () => {
    const run = runGateOver({
      "src/a.ts": "/** Default timeout and retry budget for outbound calls. */\nexport const TIMEOUT = 5000, RETRIES = 3;",
    });
    equal(run.exitCode, 1);
    match(run.stderr, /TIMEOUT - no docstring/);
    match(run.stderr, /RETRIES - no docstring/);
  });

  it("accepts per-declarator docstrings on a multiple-binding statement", () => {
    const run = runGateOver({
      "src/a.ts": [
        "export const",
        "  /** Milliseconds before an outbound call is abandoned. */",
        "  TIMEOUT = 5000,",
        "  /** How many times an abandoned call is retried. */",
        "  RETRIES = 3;",
      ].join("\n"),
    });
    equal(run.exitCode, 0, run.stderr);
  });

  it("holds an oversized arrow bound to a variable to the size rule", () => {
    const run = runGateOver({
      "src/a.ts": [
        "const wide = (): number => {",
        "  const a = 1;",
        "  const b = 2;",
        "  const c = 3;",
        "  const d = 4;",
        "  return a + b + c + d;",
        "};",
        "const narrow = (): number => 1;",
        `${GOOD_DOC}export function parseConfig(): number { return wide() + narrow(); }`,
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /\bwide - no docstring/);
    ok(!run.stderr.includes("narrow - no docstring"), "a one-line arrow needs no docstring");
  });

  it("leaves an anonymous inline callback out of the size rule", () => {
    const run = runGateOver({
      "src/a.ts": [
        "/** Keep the values that survive a multi-line predicate. */",
        "export function parseConfig(values: number[]): number[] {",
        "  return values.filter((value) => {",
        "    const a = value + 1;",
        "    const b = a + 2;",
        "    const c = b + 3;",
        "    const d = c + 4;",
        "    return d > 0;",
        "  });",
        "}",
      ].join("\n"),
    });
    equal(run.exitCode, 0, run.stderr);
  });

  it("accepts an overload set documented on its first signature", () => {
    const run = runGateOver({
      "src/a.ts": [
        "/** Reads workspace settings and caches parsed results. */",
        "export class Loader {",
        "  /** Fetch one stored entry, or every entry when no key is given. */",
        "  load(key: string): string;",
        "  load(): string[];",
        "  load(key?: string): string | string[] { return key ?? []; }",
        "}",
      ].join("\n"),
    });
    equal(run.exitCode, 0, run.stderr);
  });

  it("accepts an overload set documented on the implementation instead", () => {
    // Exercises the sibling scan rather than the direct-JSDoc fast path.
    const run = runGateOver({
      "src/a.ts": [
        "/** Reads workspace settings and caches parsed results. */",
        "export class Loader {",
        "  load(key: string): string;",
        "  load(): string[];",
        "  /** Fetch one stored entry, or every entry when no key is given. */",
        "  load(key?: string): string | string[] { return key ?? []; }",
        "}",
      ].join("\n"),
    });
    equal(run.exitCode, 0, run.stderr);
  });

  it("fails an overload set where no signature or implementation is documented", () => {
    const run = runGateOver({
      "src/a.ts": [
        "/** Reads workspace settings and caches parsed results. */",
        "export class Loader {",
        "  load(key: string): string;",
        "  load(): string[];",
        "  load(key?: string): string | string[] { return key ?? []; }",
        "}",
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /Loader\.load - no docstring/);
  });

  it("does not demand a docstring on a re-export or a destructured binding", () => {
    const run = runGateOver({
      "src/dep.ts": `${GOOD_DOC}export function parseConfig(): void {}`,
      "src/a.ts": [
        "import { parseConfig } from './dep.ts';",
        "export { parseConfig };",
        "export * from './dep.ts';",
        "const pair = { left: 1, right: 2 };",
        "export const { left, right } = pair;",
      ].join("\n"),
    });
    equal(run.exitCode, 0, run.stderr);
  });

  it("scans the scripts root as well as src", () => {
    const run = runGateOver({
      "src/a.ts": `${GOOD_DOC}export function parseConfig(): void {}`,
      "scripts/tool.ts": "export function undocumentedTool(): void {}",
    });
    equal(run.exitCode, 1);
    match(run.stderr, /scripts\/tool\.ts/);
  });

  it("scans only the roots it was asked for", () => {
    const run = runGateOver(
      {
        "src/a.ts": `${GOOD_DOC}export function parseConfig(): void {}`,
        "scripts/tool.ts": "export function undocumentedTool(): void {}",
      },
      ["src"],
    );
    equal(run.exitCode, 0, run.stderr);
  });
});

describe("docstring-gate: rarely-hit branches", () => {
  it("looks for an overload sibling across a namespace (ModuleBlock) body", () => {
    // A function declaration inside a namespace has a ModuleBlock parent, so
    // effectiveDoc's sibling scan takes the `ts.isModuleBlock` arm. The inner
    // function is oversized and undocumented, so it is reported.
    const run = runGateOver({
      "src/a.ts": [
        "namespace NS {",
        "  function oversized(): number {",
        "    const a = 1;",
        "    const b = 2;",
        "    const c = 3;",
        "    const d = 4;",
        "    const e = 5;",
        "    return a + b + c + d + e;",
        "  }",
        "}",
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /\boversized - no docstring/);
  });

  it("returns no siblings for a function whose parent is neither block nor module", () => {
    // A function declaration directly inside a switch case clause has a
    // CaseClause parent, which is none of class/sourcefile/block/moduleblock,
    // so the sibling-list ternary takes its `: []` arm and the undocumented
    // oversized function is reported.
    const run = runGateOver({
      "src/a.ts": [
        "export function parseConfig(x: number): void {",
        "  switch (x) {",
        "    case 1: function oversized(): number {",
        "      const a = 1;",
        "      const b = 2;",
        "      const c = 3;",
        "      const d = 4;",
        "      const e = 5;",
        "      return a + b + c + d + e;",
        "    }",
        "  }",
        "}",
        GOOD_DOC,
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /\boversized - no docstring/);
  });

  it("reports an anonymous default-exported class and its members", () => {
    // `export default class {}` has no name, so the class symbol and its
    // members fall back to the `"default"` reporting name.
    const run = runGateOver({
      "src/a.ts": "export default class { method(): void {} }" });
    equal(run.exitCode, 1);
    match(run.stderr, /default - no docstring/);
    match(run.stderr, /default\.method - no docstring/);
  });

  it("reports a class member with a computed name under its source text", () => {
    // `[Symbol.iterator]` is a ComputedPropertyName: declaredName returns
    // undefined, so the reporting name falls back to the name's source text.
    const run = runGateOver({
      "src/a.ts": [
        "/** Iterates the workspace entries lazily. */",
        "export class Loader {",
        "  [Symbol.iterator](): Iterator<number> { return (function* () {})(); }",
        "}",
      ].join("\n"),
    });
    equal(run.exitCode, 1);
    match(run.stderr, /Loader\.\[Symbol\.iterator\] - no docstring/);
  });

  it("skips a bodyless constructor overload signature, documenting the impl", () => {
    // The bodyless `constructor(input: string);` is an overload signature: the
    // bodyless-non-abstract `continue` path applies to constructors too, so it
    // is skipped and the documented implementation satisfies the set.
    const run = runGateOver({
      "src/a.ts": [
        "/** Reads workspace settings and caches parsed results. */",
        "export class Loader {",
        "  /** Construct a loader from a parsed descriptor. */",
        "  constructor(input: string);",
        "  constructor(input: { name: string });",
        "  constructor(input: string | { name: string }) { void input; }",
        "}",
      ].join("\n"),
    });
    equal(run.exitCode, 0, run.stderr);
  });

  it("skips members that are not methods, properties, accessors, or constructors", () => {
    // An index signature is a class member of none of the documented kinds, so
    // the kind-filter `continue` skips it and the documented surface passes.
    const run = runGateOver({
      "src/a.ts": [
        "/** Reads workspace settings and caches parsed results. */",
        "export class Loader {",
        "  [key: string]: unknown;",
        "  /** Load one entry by key from the workspace cache. */",
        "  load(key: string): string { return \"\"; }",
        "}",
      ].join("\n"),
    });
    equal(run.exitCode, 0, run.stderr);
  });
});

describe("docstring-gate: main default roots", () => {
  it("applies the repository root when invoked with no arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "docstring-main-defaults-"));
    try {
      writeFileSync(join(dir, "index.ts"), `${GOOD_DOC}export function parseConfig(): void {}\n`, "utf8");
      const originalExitCode = process.exitCode;
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      const originalStderrWrite = process.stderr.write.bind(process.stderr);
      let stdout = "";
      let stderr = "";
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        stdout += chunk.toString();
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderr += chunk.toString();
        return true;
      }) as typeof process.stderr.write;
      process.exitCode = undefined;
      let observedExitCode: number | string | undefined;
      try {
        main([], dir);
      } finally {
        observedExitCode = process.exitCode;
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
        process.exitCode = originalExitCode;
      }
      equal(observedExitCode, 0);
      match(stdout, /documented surface complete/);
      equal(stderr, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("docstring-gate: helpers and CLI entry", () => {
  it("toWords splits camelCase and strips filler", () => {
    // "getName" → ["get", "name"] but "get" is filler, so only "name" survives;
    // a docstring of just "gets the name" therefore has no novel words.
    equal(addsInformation("gets the name", "getName"), false);
    equal(addsInformation("Load and validate the YAML settings file from disk", "parseConfig"), true);
    deepEqual(toWords("parseWorkspaceConfigFile"), ["parse", "workspace", "config", "file"]);
  });

  it("collectSourceFiles walks recursively and skips declarations", () => {
    const dir = mkdtempSync(join(tmpdir(), "docstring-collect-"));
    try {
      mkdirSync(join(dir, "src", "nested"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "");
      writeFileSync(join(dir, "src", "nested", "b.ts"), "");
      writeFileSync(join(dir, "src", "legacy.d.ts"), "");
      const found = collectSourceFiles(join(dir, "src")).sort();
      deepEqual(found, [
        join(dir, "src", "a.ts"),
        join(dir, "src", "nested", "b.ts"),
      ].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collectSourceFiles prunes non-production directories from a repository root", () => {
    const dir = mkdtempSync(join(tmpdir(), "docstring-prune-"));
    try {
      for (const skipped of ["test", "node_modules", ".agents"]) {
        mkdirSync(join(dir, skipped), { recursive: true });
        writeFileSync(join(dir, skipped, "ignored.ts"), "export const ignored = true;\n");
      }
      writeFileSync(join(dir, "index.ts"), "");
      deepEqual(collectSourceFiles(dir), [join(dir, "index.ts")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collectSourceFiles ignores dangling and cyclic directory symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "docstring-symlink-"));
    try {
      writeFileSync(join(dir, "index.ts"), "");
      symlinkSync(join(dir, "missing"), join(dir, "0-dangling"));
      symlinkSync(dir, join(dir, "1-cycle"));
      deepEqual(collectSourceFiles(dir), [join(dir, "index.ts")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declaredName returns constructor for constructors and undefined for computed names", () => {
    const dir = mkdtempSync(join(tmpdir(), "docstring-name-"));
    try {
      const file = join(dir, "a.ts");
      writeFileSync(
        file,
        [
          "export class C { constructor() {} [Symbol.iterator]() {} }",
          "const x = 1;",
        ].join("\n"),
      );
      // Exercises declaredName's branches through scanFile. The computed-member
      // fallback now reports the name's source text, not a `<computed>`
      // placeholder, so assert both member names this case claims to cover —
      // a bare `startsWith("C.")` would pass even if one branch stopped
      // reporting entirely.
      const violations = scanFile(file, dir);
      const symbols = violations.map((v) => v.symbol);
      ok(symbols.includes("C.constructor"), `constructor reported, got ${symbols.join(", ")}`);
      ok(
        symbols.includes("C.[Symbol.iterator]"),
        `computed member reported by source text, got ${symbols.join(", ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("jsdocFor returns empty for a node with no leading comment", () => {
    const dir = mkdtempSync(join(tmpdir(), "docstring-jsdoc-"));
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "export const X = 1;\n");
      const violations = scanFile(file, dir);
      // X has no docstring, so jsdocFor returns "" and a violation is raised.
      ok(violations.some((v) => v.symbol === "X" && v.reason === "no docstring"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isExported and effectiveDoc are exercised through scanFile", () => {
    // Covered implicitly by the export-success and overload-sibling cases above;
    // this case asserts the helpers are reachable on a non-exported, documented
    // sibling to exercise the `parent` branch of effectiveDoc for a Block.
    const dir = mkdtempSync(join(tmpdir(), "docstring-effective-"));
    try {
      const file = join(dir, "a.ts");
      writeFileSync(
        file,
        [
          "/** Load and validate the YAML settings file from disk. */",
          "export function parseConfig(): void {",
          "  /** Documented helper inside a block. */",
          "  function inner(): void {}",
          "  inner();",
          "}",
        ].join("\n"),
      );
      const violations = scanFile(file, dir);
      // inner is short and not exported, so no violation for it; parseConfig is
      // documented, so the only path exercised is the documented-sibling scan.
      ok(violations.every((v) => v.symbol !== "inner"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main writes the run result to the streams and sets the exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "docstring-main-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "export function undocumented(): void {}\n");
      const originalExitCode = process.exitCode;
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      const originalStderrWrite = process.stderr.write.bind(process.stderr);
      let stdout = "";
      let stderr = "";
      // Capture without mutating the real streams.
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        stdout += chunk.toString();
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderr += chunk.toString();
        return true;
      }) as typeof process.stderr.write;
      process.exitCode = undefined;
      // Same capture-and-restore discipline as the missing-roots case above.
      let observedExitCode: number | string | undefined;
      try {
        main(["src"], dir);
      } finally {
        observedExitCode = process.exitCode;
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
        process.exitCode = originalExitCode;
      }
      equal(observedExitCode, 1);
      equal(stdout, "");
      match(stderr, /undocumented - no docstring/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isMainInvocation is true for the module's own path and false otherwise", () => {
    const url = pathToFileURL(GATE_PATH).href;
    equal(isMainInvocation(["node", GATE_PATH], url), true);
    equal(isMainInvocation(["node", "/tmp/other.ts"], url), false);
    equal(isMainInvocation(["node"], url), false);
  });
});
