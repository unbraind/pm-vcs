import "./helpers/isolate-session.ts";
/** Session noise cannot alter real SDK provenance or leak through future test subprocesses. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript5";
import { testEnvironment, TEST_ENVIRONMENT_KEYS } from "./helpers/test-environment.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const session = {
  CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "synthetic-session", CLAUDE_CODE_FUTURE: "ambient-value",
  CODEX_CI: "1", CODEX_MODEL: "ambient-model", CODEX_HOME: "ambient-config", CODEX_FUTURE_SESSION: "ambient-value", AI_AGENT: "claude-code",
  PM_AGENT_NAME: "ambient-agent", PM_AGENT_HARNESS: "claude-code", PM_AGENT_MODEL: "ambient-model", PM_AGENT_PROBES: "1", PM_AGENT_FUTURE: "ambient-value",
};

test("child allowlist drops all ambient session namespaces and keeps only deliberate fixture identity", () => {
  const source = { ...session, PATH: "synthetic-bin", HOME: "synthetic-home", NODE_V8_COVERAGE: "ambient-coverage", NODE_OPTIONS: "ambient-preload", PM_PATH: "ambient-tracker", UNRELATED_SECRET: "private-value" };
  const env = testEnvironment({}, source);
  assert.equal(env.PATH, source.PATH); assert.equal(env.HOME, source.HOME); assert.equal(env.NODE_ENV, "test"); assert.equal(env.NODE_V8_COVERAGE, source.NODE_V8_COVERAGE); assert.equal(env.PM_AGENT_PROBES, "0");
  for (const key of Object.keys(session)) if (key !== "PM_AGENT_PROBES") assert.equal(env[key], undefined, key);
  for (const key of ["NODE_OPTIONS", "PM_PATH", "UNRELATED_SECRET"]) assert.equal(env[key], undefined, key);
  const fixture = testEnvironment({ CODEX_CI: "1", PM_AGENT_MODEL: "fixture-model", PM_AGENT_PROBES: "0" }, source);
  assert.equal(fixture.CODEX_CI, "1"); assert.equal(fixture.PM_AGENT_MODEL, "fixture-model"); assert.equal(fixture.CLAUDECODE, undefined); assert.equal(testEnvironment({ NODE_V8_COVERAGE: "" }, source).NODE_V8_COVERAGE, "");
  assert.ok(TEST_ENVIRONMENT_KEYS.every(key => !/^(?:CLAUDE|CODEX|AI_AGENT|PM_AGENT)/.test(key)));
});

test("parent isolation preserves owned V8 instrumentation while removing session state before module imports", () => {
  const dir = makeTempDir();
  try {
    const coverage = join(dir.root, "coverage"); const script = `import ${JSON.stringify(new URL("./helpers/isolate-session.ts", import.meta.url).href)};console.log(JSON.stringify({coverage:process.env.NODE_V8_COVERAGE,claude:process.env.CLAUDECODE,model:process.env.CODEX_MODEL,probes:process.env.PM_AGENT_PROBES,node:process.env.NODE_ENV}))`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: testEnvironment({ ...session, NODE_V8_COVERAGE: coverage }), encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { coverage, probes: "0", node: "test" }); assert.ok(readdirSync(coverage).some(file => file.endsWith(".json")));
  } finally { dir.cleanup(); }
});

test("allowlisted runner instrumentation reaches a real production tool while session state stays excluded", () => {
  const dir = makeTempDir();
  try {
    const coverage = join(dir.root, "coverage"); const source = join(dir.root, "source"); mkdirSync(source); writeFileSync(join(source, "index.ts"), "/** Native tool collection fixture. */\nexport const fixture = true;\n");
    const tool = new URL("../scripts/docstring-gate.ts", import.meta.url);
    const script = `import {testEnvironment} from ${JSON.stringify(new URL("./helpers/test-environment.ts", import.meta.url).href)};import {spawnSync} from "node:child_process";const result=spawnSync(process.execPath,process.argv.slice(1),{env:testEnvironment(),encoding:"utf8"});if(result.status!==0)throw Error(result.stderr);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, fileURLToPath(tool), source], { env: testEnvironment({ ...session, NODE_V8_COVERAGE: coverage }), encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const collected = readdirSync(coverage).flatMap(file => (JSON.parse(readFileSync(join(coverage, file), "utf8")) as { result: { url: string; functions: { ranges: { count: number }[] }[] }[] }).result);
    assert.ok(collected.some(script => script.url === tool.href && script.functions.some(fn => fn.ranges.some(range => range.count > 0))), "the production tool must contribute executed code to runner-owned coverage");
  } finally { dir.cleanup(); }
});

test("the three real annotation and bisect provenance regressions have identical clean and contaminated results", () => {
  const pattern = "fragmented PM history retains|native PM snapshots supply|tracked and root trackers keep";
  const receipts: { passed: number; failed: number }[] = [];
  for (const overrides of [{}, session]) {
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`, join(packageRoot, "test/annotate.test.ts"), join(packageRoot, "test/bisect.test.ts")], { cwd: packageRoot, env: testEnvironment(overrides), encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const passed = /(?:#|ℹ) pass (\d+)/.exec(result.stdout); const failed = /(?:#|ℹ) fail (\d+)/.exec(result.stdout); assert.ok(passed, result.stdout + result.stderr); assert.ok(failed, result.stdout + result.stderr);
    receipts.push({ passed: Number(passed[1]), failed: Number(failed[1]) });
  }
  assert.deepEqual(receipts, [{ passed: 3, failed: 0 }, { passed: 3, failed: 0 }]);
});

/** Enumerate only this package's bounded test tree, without requiring Git or external search tools. */
function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(join(root, entry.name)) : entry.name.endsWith(".ts") ? [join(root, entry.name)] : []);
}

test("all test entrypoints isolate sessions first and every child launch has an explicit nonambient environment", t => {
  let entries = 0; let launches = 0; let embedded = 0;
  /** Audit literal worker programs as well as module code; interpolation values cannot supply an implicit environment. */
  const audit = (name: string, body: string, worker = false): void => {
    if (worker) assert.equal(ts.transpileModule(body, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).diagnostics?.length ?? 0, 0, `${name} worker source must parse before auditing`);
    const source = ts.createSourceFile(name, body, ts.ScriptTarget.Latest, true); const aliases = new Map<string, string>(); const namespaces = new Set<string>();
    if (!worker && name.endsWith(".test.ts")) { const first = source.statements[0]; assert.ok(ts.isImportDeclaration(first) && ts.isStringLiteral(first.moduleSpecifier) && first.moduleSpecifier.text.endsWith("/isolate-session.ts"), `${name} must isolate before importing the SDK`); entries++; }
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "node:child_process" && statement.importClause) {
      const bindings = statement.importClause.namedBindings; if (statement.importClause.name) namespaces.add(statement.importClause.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) aliases.set(element.name.text, (element.propertyName ?? element.name).text);
    }
    /** Reject host-object forwarding independently of the environment builder's runtime implementation. */
    const visit = (node: ts.Node): void => {
      if (ts.isSpreadAssignment(node)) assert.notEqual(node.expression.getText(source), "process.env", `${name} forwards ambient environment`);
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || (ts.isPropertyAssignment(node) && node.name.getText(source) === "env")) && node.initializer) assert.notEqual(node.initializer.getText(source), "process.env", `${name} aliases ambient environment`);
      if (ts.isCallExpression(node)) {
        const kind = ts.isIdentifier(node.expression) ? aliases.get(node.expression.text) : ts.isPropertyAccessExpression(node.expression) && namespaces.has(node.expression.expression.getText(source)) ? node.expression.name.text : undefined;
        if (kind && /^(?:fork|exec|spawn|execFile|execSync|spawnSync|execFileSync)$/.test(kind)) {
          launches++; const index = /^exec(?:Sync)?$/.test(kind) ? 1 : node.arguments.length === 2 && ts.isObjectLiteralExpression(node.arguments[1]) ? 1 : 2; const options = node.arguments[index];
          assert.ok(options, `${name} has an implicit child environment`);
          if (ts.isObjectLiteralExpression(options)) assert.ok(options.properties.some(property => property.name?.getText(source) === "env"), `${name} omits child env`);
        }
      }
      if (!worker && (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))) {
        const program = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => '"fixture-interpolation"' + span.literal.text).join("") : node.text;
        if (/from\s*["']node:child_process["']/.test(program)) { embedded++; audit(`${name}:worker`, program, true); }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  for (const path of sourceFiles(join(packageRoot, "test"))) {
    const name = relative(packageRoot, path).replaceAll("\\", "/");
    if (!name.endsWith("helpers/test-environment.ts") && !name.endsWith("helpers/isolate-session.ts")) audit(name, readFileSync(path, "utf8"));
  }
  assert.ok(entries >= 90); assert.ok(launches >= 145); assert.ok(embedded >= 3); t.diagnostic(`${entries} isolated test entrypoints and ${launches} explicit child launch sites across ${embedded} embedded workers audited`);
});
