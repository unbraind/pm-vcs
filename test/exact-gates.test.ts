/** Real process controls for production coverage, lint policy and scan completeness. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

/** Run a repository-owned JavaScript or TypeScript tool in a disposable project. */
function tool(root: string, entry: string, args: readonly string[], environment: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
  const env = { ...environment };
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
    // A nested c8 process must retain earlier data in an inherited parent
    // collection directory, even though c8 cleans its own directory on startup.
    const parentCoverage = join(fixture.root, "parent-coverage");
    source(fixture.root, "parent-coverage/marker.txt", "Earlier parent data must survive.\n");
    passed(tool(fixture.root, "node_modules/c8/bin/c8.js", args, { ...process.env, NODE_V8_COVERAGE: parentCoverage }));
    assert.equal(readFileSync(join(parentCoverage, "marker.txt"), "utf8"), "Earlier parent data must survive.\n");
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
    const archive = readFileSync(join(packageRoot, "selfhost.bundle"));
    const selfHost = tool(fixture.root, "scripts/self-host.ts", []);
    passed(selfHost);
    assert.match(selfHost.stdout, /committed bundle.*byte-identical/);
    assert.deepEqual(readFileSync(join(packageRoot, "selfhost.bundle")), archive, "verification must not repair a stale archive");
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

test("the identity gate runs through a symlinked checkout and rejects a seeded violation", () => {
  const fixture = makeTempDir();
  try {
    const checkout = join(fixture.root, "checkout");
    source(checkout, "package.json", JSON.stringify({ type: "module" }));
    source(checkout, ".github/approved-git-identities.txt", "public@example.test\n");
    mkdirSync(join(checkout, "scripts"));
    for (const script of ["audit-git-identities.ts", "main-invocation.ts"]) {
      copyFileSync(join(packageRoot, "scripts", script), join(checkout, "scripts", script));
    }
    // The actual gate reads a real Git object database in a disposable copy.
    // No launcher or guard is replaced by a test fixture.
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
    delete env.NODE_TEST_CONTEXT;
    /** Run a real Git fixture command with global and system configuration disabled. */
    const git = (args: readonly string[]): void => {
      passed(spawnSync("git", args, { cwd: checkout, encoding: "utf8", env }));
    };
    git(["init", "-q"]);
    git(["-c", "user.name=Public", "-c", "user.email=public@example.test", "commit", "--allow-empty", "-qm", "public fixture"]);
    const alias = join(fixture.root, "symlinked checkout with spaces");
    symlinkSync(checkout, alias, "dir");
    const entry = join(alias, "scripts/audit-git-identities.ts");
    for (const flags of [[], ["--preserve-symlinks", "--preserve-symlinks-main"]]) {
      const result = spawnSync(process.execPath, [...flags, entry], { cwd: alias, encoding: "utf8", timeout: 60_000, env });
      passed(result);
      assert.match(result.stdout, /git identity audit approved 1 unique address/);
    }
    git(["-c", "user.name=Public", "-c", "user.email=unapproved@example.test", "commit", "--allow-empty", "-qm", "unapproved fixture"]);
    for (const flags of [[], ["--preserve-symlinks", "--preserve-symlinks-main"]]) {
      const result = spawnSync(process.execPath, [...flags, entry], { cwd: alias, encoding: "utf8", timeout: 60_000, env });
      assert.equal(result.status, 1, `${result.error}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /git identity audit rejected 1 non-public address/);
    }
  } finally {
    fixture.cleanup();
  }
});


test("the direct self-host entry point accepts action bumps but requires committed snapshots for test changes", () => {
  const fixture = makeTempDir();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
  delete env.NODE_TEST_CONTEXT;
  /** Run a real isolated Git command without relying on the caller identity. */
  const git = (args: readonly string[]): void => {
    passed(spawnSync("git", args, { cwd: fixture.root, encoding: "utf8", env }));
  };
  /** Execute the copied, unchanged production launcher against its own repository. */
  const audit = (args: readonly string[] = []): SpawnSyncReturns<string> => spawnSync(
    process.execPath, [join(fixture.root, "scripts/self-host.ts"), ...args],
    { cwd: fixture.root, encoding: "utf8", timeout: 60_000, env },
  );
  try {
    for (const script of ["self-host.ts", "main-invocation.ts"]) {
      source(fixture.root, `scripts/${script}`, readFileSync(join(packageRoot, "scripts", script), "utf8"));
    }
    symlinkSync(join(packageRoot, "engine"), join(fixture.root, "engine"), "dir");
    symlinkSync(join(packageRoot, "node_modules"), join(fixture.root, "node_modules"), "dir");
    source(fixture.root, "package.json", JSON.stringify({ type: "module" }));
    source(fixture.root, "self-host.json", JSON.stringify({ bundle: "selfhost.bundle", ref: "refs/heads/self-host", exclude: ["selfhost.bundle"] }));
    source(fixture.root, "index.ts", "export const answer = 42;\n");
    const acceptancePath = "test/prepare-merge-driver.test.ts";
    source(fixture.root, acceptancePath, "// Original merge-driver acceptance.\n");
    const actions = ["github/codeql-action/init", "actions/setup-node", "actions/upload-artifact"];
    const workflow = "jobs:\n  test:\n    steps:\n" + actions.map((action) => `      - uses: ${action}@${"a".repeat(40)} # v7.0.0`).join("\n") + "\n";
    source(fixture.root, ".github/workflows/ci.yml", workflow);
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Public Fixture"]);
    git(["config", "user.email", "public@example.test"]);
    git(["add", "scripts", "package.json", "self-host.json", "index.ts", acceptancePath, ".github/workflows/ci.yml"]);
    git(["commit", "-qm", "fixture source"]);
    passed(audit(["--write"]));
    git(["add", "selfhost.bundle"]);
    git(["commit", "-qm", "fixture archive"]);
    const bundle = readFileSync(join(fixture.root, "selfhost.bundle"));
    passed(audit());
    for (const action of actions) {
      source(fixture.root, ".github/workflows/ci.yml", workflow.replace(`${action}@${"a".repeat(40)} # v7.0.0`, `${action}@${"b".repeat(40)} # v7.1.0`));
      git(["add", ".github/workflows/ci.yml"]);
      git(["commit", "-qm", "action revision update"]);
      passed(audit());
      assert.deepEqual(readFileSync(join(fixture.root, "selfhost.bundle")), bundle, "verification must never regenerate the archive");
    }
    for (const body of [workflow + "permissions: write-all\n", workflow.replace("a".repeat(40), "main")]) {
      source(fixture.root, ".github/workflows/ci.yml", body);
      git(["add", ".github/workflows/ci.yml"]);
      git(["commit", "-qm", "operational change"]);
      const rejected = audit();
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /content differs/);
    }
    source(fixture.root, ".github/workflows/ci.yml", workflow);
    source(fixture.root, acceptancePath, "// Accept Git's built-in text driver without local registration.\n");
    git(["add", ".github/workflows/ci.yml", acceptancePath]);
    git(["commit", "-qm", "update merge-driver acceptance"]);
    const stale = audit();
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /test\/prepare-merge-driver\.test\.ts: content differs/);
    assert.deepEqual(readFileSync(join(fixture.root, "selfhost.bundle")), bundle);

    passed(audit(["--write"]));
    const refreshed = readFileSync(join(fixture.root, "selfhost.bundle"));
    assert.notDeepEqual(refreshed, bundle);
    const uncommitted = audit();
    assert.equal(uncommitted.status, 1, uncommitted.stderr);
    assert.match(uncommitted.stderr, /test\/prepare-merge-driver\.test\.ts: content differs/);
    git(["add", "selfhost.bundle"]);
    git(["commit", "-qm", "refresh acceptance snapshot"]);
    passed(audit());
    assert.deepEqual(readFileSync(join(fixture.root, "selfhost.bundle")), refreshed);
  } finally {
    fixture.cleanup();
  }
});
