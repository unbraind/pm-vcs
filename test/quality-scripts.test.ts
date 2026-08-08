/** Behavioral coverage for release-quality scripts that operate outside the extension host. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import {
  isExecutableFile,
  main as prepareMain,
  pmOnPath,
} from "../scripts/prepare-merge-driver.ts";

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

test("merge-driver preparation distinguishes absence, invalid candidates and an executable PM", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-prepare-"));
  try {
    const directory = join(root, "pm");
    mkdirSync(directory);
    assert.equal(isExecutableFile(directory, "linux"), false);
    assert.equal(isExecutableFile(join(root, "absent"), "linux"), false);
    const nonExecutable = executableFixture(root, "process.exit(0);", "not-pm");
    chmodSync(nonExecutable, 0o644);
    assert.equal(isExecutableFile(nonExecutable, "linux"), false);
    assert.equal(isExecutableFile(nonExecutable, "win32"), true);
    assert.equal(pmOnPath({ PATH: "" }, "win32"), null);
    assert.equal(pmOnPath({}, "linux"), null);
    assert.equal(pmOnPath({ PATH: '"' + root + '"', PATHEXT: ".CMD;.EXE" }, "win32"), null);
    assert.equal(prepareMain({ PATH: "" }, "linux"), false);

    rmSync(directory, { recursive: true });
    const marker = join(root, "called");
    executableFixture(root, `
if (process.argv.slice(2).join(" ") !== "merge install") process.exit(8);
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");`, "pm");
    const fixturePath = `${root}:${dirname(process.execPath)}`;
    assert.equal(pmOnPath({ PATH: fixturePath }, "linux"), join(root, "pm"));
    assert.equal(prepareMain({ PATH: fixturePath }, "linux"), true);

    const windowsShim = executableFixture(root, "process.exit(0);", "pm.CMD");
    const windowsEnvironment = { PATH: `"${root}"`, PATHEXT: ".CMD;.EXE" };
    assert.equal(
      pmOnPath(windowsEnvironment, "win32"),
      windowsShim,
    );
    let windowsShell = false;
    assert.equal(prepareMain(windowsEnvironment, "win32", (executable, arguments_, options) => {
      assert.equal(executable, windowsShim);
      assert.deepEqual(arguments_, ["merge", "install"]);
      windowsShell = options.shell;
    }), true);
    assert.equal(windowsShell, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
