/** Real process controls for production coverage, lint policy and scan completeness. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

/** Run a repository-owned JavaScript or TypeScript tool in a disposable project. */
function tool(root: string, entry: string, args: readonly string[]): SpawnSyncReturns<string> {
  const env = { ...process.env };
  // A nested real test runner must start independently of the parent runner.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [join(packageRoot, entry), ...args], {
    cwd: root, encoding: "utf8", timeout: 60_000, env,
  });
}

/** Write a fixture source, creating only its containing directory. */
function source(root: string, path: string, body: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, body);
}

/** Require an actual child process to succeed, preserving its diagnostics. */
function passed(result: SpawnSyncReturns<string>): void {
  assert.equal(result.status, 0, `${result.error}\n${result.stdout}\n${result.stderr}`);
}

test("the repository coverage command measures root, src, engine and scripts and rejects omitted behaviour", () => {
  const fixture = makeTempDir();
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      scripts: { coverage: string };
    };
    // Execute the actual repository c8 command, including its scope, thresholds
    // and test runner, against files whose runtime behaviour is known.
    const command = manifest.scripts.coverage.split(" && ").at(-1);
    assert.ok(command);
    assert.ok(command.startsWith("c8 "));
    const args = command.slice(3).replaceAll("'", "").split(" ");
    source(fixture.root, "package.json", JSON.stringify({ type: "module" }));
    source(fixture.root, ".c8rc.json", JSON.stringify({ all: false, exclude: ["**/*.ts"], lines: 0, branches: 0, functions: 0, statements: 0 }));
    const paths = ["index.ts", "src/value.ts", "engine/value.ts", "scripts/value.ts"];
    for (const path of paths) source(fixture.root, path, "export const answer: number = 42;\n");
    source(fixture.root, "test/fixture.test.ts", `
import assert from "node:assert/strict";
import test from "node:test";
${paths.map((path, index) => `import { answer as answer${index} } from "../${path}";`).join("\n")}
test("computed fixture answers", () => {
  assert.deepEqual([answer0, answer1, answer2, answer3], [42, 42, 42, 42]);
});
`);
    passed(tool(fixture.root, "node_modules/c8/bin/c8.js", args));
    const lcov = readFileSync(join(fixture.root, "coverage/lcov.info"), "utf8");
    for (const path of paths) assert.ok(lcov.replaceAll("\\", "/").includes(path), path);

    for (const path of ["scripts/never-loaded.ts", "src/never-loaded.ts"]) {
      source(fixture.root, path, "export function normalize(value: string): string { return value.trim(); }\n");
      const omitted = tool(fixture.root, "node_modules/c8/bin/c8.js", args);
      assert.equal(omitted.status, 1, `${omitted.stdout}\n${omitted.stderr}`);
      assert.match(omitted.stderr, /Coverage for (?:lines|statements|functions).*does not meet/);
      assert.match(omitted.stdout, /never-loaded.ts/);
      rmSync(join(fixture.root, path));
    }
    source(fixture.root, "scripts/value.ts", `
export const answer = 42;
export function classify(value: number): string {
  if (value > 0) return "positive";
  return "nonpositive";
}
`);
    source(fixture.root, "test/branch.test.ts", `
import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "../scripts/value.ts";
test("positive classification", () => assert.equal(classify(1), "positive"));
`);
    const partial = tool(fixture.root, "node_modules/c8/bin/c8.js", args);
    assert.equal(partial.status, 1);
    assert.match(partial.stderr, /Coverage for branches.*does not meet/);
    source(fixture.root, "test/branch.test.ts", `
import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "../scripts/value.ts";
test("both classifications", () => {
  assert.equal(classify(1), "positive");
  assert.equal(classify(0), "nonpositive");
});
`);
    passed(tool(fixture.root, "node_modules/c8/bin/c8.js", args));
  } finally {
    fixture.cleanup();
  }
});

test("fleet lint rejects forbidden syntax throughout production and tests while ignoring ambient Babel config", () => {
  const fixture = makeTempDir();
  try {
    source(fixture.root, "package.json", JSON.stringify({ type: "module" }));
    source(fixture.root, ".babelrc", JSON.stringify({ plugins: ["a-plugin-that-does-not-exist"] }));
    source(fixture.root, "src/valid.ts", "export const answer: number = 42;\n");
    const args = ["--config", join(packageRoot, "scripts/eslint.config.ts"), "--max-warnings=0", "."];
    passed(tool(fixture.root, "node_modules/eslint/bin/eslint.js", args));
    const invalid = {
      "src/explicit.ts": "export const value: any = 1;\n",
      "engine/dynamic.ts": "export const value = import('./other.ts');\n",
      "scripts/inline.ts": "export type Value = import('./other.ts').Value;\n",
      "test/enum.ts": "export enum State { Ready, Done }\n",
      "scripts/parameter.ts": "export class Value { constructor(public value: number) {} }\n",
      "src/namespace.ts": "export namespace Values { export const answer = 42; }\n",
      "engine/import-equals.ts": "import Value = require('./other');\n",
      "scripts/export-equals.ts": "const answer = 42; export = answer;\n",
      "test/conventions.ts": "var value = 1; if (value == '1') console.log(value);\n",
    };
    for (const [path, body] of Object.entries(invalid)) source(fixture.root, path, body);
    const rejected = tool(fixture.root, "node_modules/eslint/bin/eslint.js", args);
    assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
    for (const path of Object.keys(invalid)) assert.ok(rejected.stdout.replaceAll("\\", "/").includes(path), path);
    for (const reason of ["explicit any", "Dynamic imports", "Inline type imports", "Enums", "Parameter properties", "Namespaces", "Import-equals", "Export-equals", "no-var", "eqeqeq"]) {
      assert.ok(rejected.stdout.includes(reason), reason);
    }
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /Cannot find.*a-plugin/);
  } finally {
    fixture.cleanup();
  }
});

test("jscpd 5 scans short sources and rejects empty scopes, clones and missing policy despite hostile configuration", () => {
  const fixture = makeTempDir();
  try {
    const manifest = { type: "module", duplicationGate: { threshold: 0, minTokens: 50 } };
    source(fixture.root, "package.json", JSON.stringify(manifest));
    const args = [fixture.root];
    const empty = tool(fixture.root, "scripts/duplication-gate.ts", args);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /at least one source glob/);
    source(fixture.root, "scripts/short.ts", "export const ready = true;\n");
    const clean = tool(fixture.root, "scripts/duplication-gate.ts", args);
    passed(clean);
    assert.match(clean.stdout, /1 source\(s\), 0 clone pair\(s\)/);
    // A two-line clone exceeds the token floor but cannot satisfy the former
    // CLI's default five-line floor. Use a real binary, never a fake report.
    const clone = `export function total(values: readonly number[]): number {\n const sum = values.reduce((result, value) => result + value * value + value * 2 + 1, 0); const average = sum / Math.max(values.length, 1); return Math.round(average * 100) / 100; }\n`;
    source(fixture.root, "engine/first.ts", clone);
    source(fixture.root, "src/second.ts", clone);
    source(fixture.root, ".jscpd.json", JSON.stringify({ threshold: 100, minTokens: 999999, ignore: ["**/*"], format: ["javascript"] }));
    const duplicated = tool(fixture.root, "scripts/duplication-gate.ts", args);
    assert.equal(duplicated.status, 1);
    assert.match(duplicated.stderr, /exceeds the configured 0% threshold/);
    assert.match(duplicated.stdout, /3 source\(s\), 1 clone pair\(s\)/);
    assert.match(duplicated.stdout, /engine\/first.ts/);
    assert.match(duplicated.stdout, /src\/second.ts/);
    rmSync(join(fixture.root, "package.json"));
    const missing = tool(fixture.root, "scripts/duplication-gate.ts", args);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /could not read package.json/);
    // Default invocation scans the package even from this hostile caller cwd.
    const anchored = tool(fixture.root, "scripts/duplication-gate.ts", []);
    passed(anchored);
    assert.match(anchored.stdout, /0 clone pair\(s\)/);
  } finally {
    fixture.cleanup();
  }
});

test("operational entry points enforce real audits through direct CLI processes", () => {
  const fixture = makeTempDir();
  try {
    const selfHost = tool(fixture.root, "scripts/self-host.ts", []);
    passed(selfHost);
    assert.match(selfHost.stdout, /committed bundle.*byte-identical/);
    const identities = tool(fixture.root, "scripts/audit-git-identities.ts", []);
    passed(identities);
    assert.match(identities.stdout, /git identity audit approved/);
    source(fixture.root, "index.ts", "export function undocumented(value: number): number { return value + 1; }\n");
    const docstrings = tool(fixture.root, "scripts/docstring-gate.ts", [fixture.root]);
    assert.equal(docstrings.status, 1);
    assert.match(docstrings.stderr, /docstring-gate:.*violation/);
    assert.match(docstrings.stderr, /undocumented/);
  } finally {
    fixture.cleanup();
  }
});
