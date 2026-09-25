/** Behavioral coverage for release-quality scripts that operate outside the extension host. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import eslintConfig from "../scripts/eslint.config.ts";
import { main as nativeMain } from "../scripts/accept-native-toon.ts";
import {
  assertTraceBehavior,
  main as statMain,
  traceStatus,
} from "../scripts/accept-stat-cache.ts";
import {
  errorMessage,
  isMainInvocation,
  invokeWhenMain,
  pmExecutable,
  processFailure,
  runPm,
  setExitCodeWhenMain,
} from "../scripts/pm-environment.ts";

/** Creates an executable Node fixture and returns its path. */
function executableFixture(root: string, body: string, name = "fixture.ts"): string {
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("ESLint configuration applies every mandatory TypeScript syntax prohibition", () => {
  const configured = eslintConfig.find((entry) => entry.files?.includes("**/*.ts"));
  assert.ok(configured?.languageOptions?.parser);
  const restrictions = configured.rules?.["no-restricted-syntax"];
  assert.ok(Array.isArray(restrictions));
  const selectors = new Set(restrictions.slice(1).map((entry) =>
    typeof entry === "object" && entry !== null && "selector" in entry ? entry.selector : ""));
  assert.deepEqual(selectors, new Set([
    "TSAnyKeyword",
    "ImportExpression",
    "TSImportType",
    "TSParameterProperty",
    "TSEnumDeclaration",
    "TSModuleDeclaration",
    "TSImportEqualsDeclaration",
    "TSExportAssignment",
  ]));
});

test("installed PM process helpers preserve real success and failure diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-quality-process-"));
  try {
    const fixture = executableFixture(root, `
if (process.argv.includes("fail")) {
  console.error("fixture refused");
  process.exit(9);
}
console.log("fixture passed");`);
    assert.doesNotThrow(() => runPm(root, ["ok"], fixture));
    assert.throws(() => runPm(root, ["fail"], fixture), /pm fail failed: fixture refused/);

    const absent = spawnSync(join(root, "absent"), [], { encoding: "utf8" });
    assert.match(processFailure(absent, "spawn failed", "."), /^spawn failed:/);
    const silent = spawnSync(process.execPath, ["-e", "process.exit(2)"], { encoding: "utf8" });
    assert.equal(processFailure(silent, "silent failed", "."), "silent failed.");
    assert.equal(errorMessage(new Error("specific"), "fallback"), "specific");
    assert.equal(errorMessage("not an error", "fallback"), "fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native TOON acceptance runs both installed-CLI modes and reports a real launcher failure", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-native-failure-"));
  try {
    assert.equal(nativeMain(["--init-only"]), 0);
    assert.equal(nativeMain([]), 0);
    const refusal = executableFixture(root, "console.error('intentional refusal'); process.exit(4);");
    assert.equal(nativeMain([], refusal), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat-cache acceptance validates trace semantics, platform skip and real Linux behavior", () => {
  assert.doesNotThrow(() => assertTraceBehavior("openat large.bin", "openat other.bin"));
  assert.throws(() => assertTraceBehavior("openat other.bin", ""), /did not open large.bin/);
  assert.throws(
    () => assertTraceBehavior("openat large.bin", "first\nopenat large.bin\nlast"),
    /cached status still opened large.bin.*openat large.bin/s,
  );
  assert.equal(statMain("darwin"), 0);
  const straceAvailable = spawnSync("strace", ["--version"], { encoding: "utf8" }).status === 0;
  if (process.platform === "linux" && straceAvailable) assert.equal(statMain("linux"), 0);
  assert.equal(statMain("linux", join(tmpdir(), "missing-pm-vcs-cli")), 1);

  const root = mkdtempSync(join(tmpdir(), "pm-vcs-trace-failure-"));
  try {
    mkdirSync(join(root, ".pmvcs"));
    assert.throws(
      () => traceStatus(root, "missing", pmExecutable, join(root, "missing-strace")),
      /straced pm vcs status failed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared launcher detection invokes only a directly executed script and preserves its status", () => {
  const script = join(tmpdir(), "pm-vcs-launcher.ts");
  const url = pathToFileURL(script).href;
  const before = process.exitCode;
  try {
    assert.equal(isMainInvocation([process.execPath, script], url), true);
    assert.equal(isMainInvocation([process.execPath], url), false);
    setExitCodeWhenMain([process.execPath, join(tmpdir(), "elsewhere.ts")], url, () => 8, []);
    assert.equal(process.exitCode, before);
    setExitCodeWhenMain([process.execPath, script], url, (status: number) => status, [7]);
    assert.equal(process.exitCode, 7);
    let invoked = false;
    const action = (): void => { invoked = true; };
    invokeWhenMain([process.execPath, join(tmpdir(), "elsewhere.ts")], url, action, []);
    assert.equal(invoked, false);
    invokeWhenMain([process.execPath, script], url, action, []);
    assert.equal(invoked, true);
  } finally {
    process.exitCode = before;
  }
});

test("the release workflow has no unattested publish path", () => {
  // A fallback that published without --provenance used to sit at the end of
  // this workflow's retry loop. It emitted a ::warning:: and exited 0, so a run
  // that shipped an artifact nobody can trace to this workflow looked exactly
  // like a healthy release. An unattested version cannot be withdrawn and its
  // version number cannot be reused, so failing the release is the cheaper
  // outcome. This asserts the path stays gone.
  const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");
  // Join continuations first: a publish split across lines carries its flags on
  // a later line, so scanning raw lines would read the first fragment as an
  // invocation with no flags at all.
  const joined = workflow.replace(/\\\r?\n\s*/g, " ");
  const publishes = joined
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => /(^|[;&|(]\s*|\s)npm\s+publish(\s|$)/.test(line));
  assert.notEqual(publishes.length, 0, "the scan found no npm publish at all, so it is looking in the wrong place");
  for (const invocation of publishes) {
    assert.match(invocation, /--provenance(\s|$|=)/,
      `every publish must enable --provenance, but this one does not: ${invocation}`);
    assert.doesNotMatch(invocation, /--provenance=false/,
      `a publish must not disable provenance: ${invocation}`);
  }
});
