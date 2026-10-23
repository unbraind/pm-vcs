import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discardChildCoverage } from "./helpers/sandbox.ts";

/** Check optional witness tools without making them prerequisites for Node tests. */
function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}

/** Execute the actual PR-creation shell block with disposable Git/GitHub doubles. */
function runCreationStep(failPr: boolean): { status: number | null; calls: string[][]; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-refresh-workflow-"));
  try {
    const workflow = readFileSync(new URL("../.github/workflows/dependency-refresh.yml", import.meta.url), "utf8");
    const step = workflow.slice(workflow.indexOf("      - name: Create dependency refresh PR"));
    const marker = "        run: |\n";
    assert.ok(step.includes(marker), "PR creation must contain a shell block");
    const script = step.slice(step.indexOf(marker) + marker.length).split("\n")
      .map((line) => line.replace(/^          /u, "")).join("\n");
    const log = join(root, "calls.jsonl");
    writeFileSync(join(root, "git"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(root, "date"), "#!/bin/sh\nprintf '%s\\n' '2026-10-04'\n");
    writeFileSync(join(root, "gh"), `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.CALL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nif (process.argv[2] === "pr" && process.env.FAIL_PR === "yes") process.exit(17);\n`);
    for (const name of ["git", "date", "gh"]) chmodSync(join(root, name), 0o755);
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: "unbraind/pm-vcs",
        GITHUB_RUN_ID: "123",
        CALL_LOG: log,
        FAIL_PR: failPr ? "yes" : "no",
      },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    return { status: result.status, calls, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("token-created refresh PR dispatches CI on its actual collision-safe head", () => {
  const result = runCreationStep(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 2, "PR creation must be followed by an explicit CI dispatch");
  const [create, dispatch] = result.calls;
  assert.ok(create && dispatch);
  assert.deepEqual(create.slice(0, 2), ["pr", "create"]);
  const branch = create[create.indexOf("--head") + 1];
  assert.equal(branch, "dependency-refresh/2026-10-04-run-123");
  assert.deepEqual(dispatch, ["workflow", "run", "ci.yml", "-R", "unbraind/pm-vcs", "--ref", branch]);
});

test("failed PR creation cannot dispatch CI and retains its failure status", () => {
  const result = runCreationStep(true);
  assert.equal(result.status, 17, result.stderr);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0]?.slice(0, 2), ["pr", "create"]);
});

test("manual CI dispatch preserves all four required check names", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const refresh = readFileSync(new URL("../.github/workflows/dependency-refresh.yml", import.meta.url), "utf8");
  assert.match(ci.slice(0, ci.indexOf("jobs:")), /^  workflow_dispatch:/mu);
  assert.match(refresh.slice(0, refresh.indexOf("concurrency:")), /^  actions: write$/mu);
  const jobs = ci.slice(ci.indexOf("jobs:\n") + "jobs:\n".length);
  const names = [...jobs.matchAll(/^  ([\w-]+):\n[\s\S]*?node-version: \[([^\]]+)\]/gmu)]
    .flatMap((match) => match[2]!.split(",").map((version) => `${match[1]} (${version.trim()})`));
  assert.deepEqual(names, ["test (22)", "test (26)", "windows-acceptance-launcher (22)", "windows-acceptance-launcher (26)"]);
});

test("dependency refresh provisions the CI-pinned Bun runtime before release checks", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const refresh = readFileSync(new URL("../.github/workflows/dependency-refresh.yml", import.meta.url), "utf8");
  const pin = ci.match(/uses: (oven-sh\/setup-bun@[a-f0-9]{40} #[^\n]+)[\s\S]*?bun-version: "([^"]+)"/u);
  assert.ok(pin, "CI must declare an immutable Bun action and runtime version");
  const setup = refresh.indexOf(`uses: ${pin[1]}`);
  assert.ok(setup >= 0, "refresh must use the same pinned Bun action as CI");
  const gate = refresh.indexOf("      - name: Run release checks");
  assert.ok(setup < gate, "Bun must be provisioned before the release gate");
  assert.match(refresh.slice(setup, gate), new RegExp(`bun-version: "${pin[2]!.replaceAll(".", "\\.")}"`, "u"));
  assert.match(refresh.slice(gate), /run: npm run release:check/u);
});

test("Bun CI gate executes tracker lens tests in the Bun runtime", {
  skip: !commandAvailable("bash") || !commandAvailable("bun"),
}, () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const tail = ci.slice(ci.indexOf("      - name: Full Bun release gate"));
  const step = tail.slice(0, tail.indexOf("\n\n"));
  const script = step.slice(step.indexOf("        run: |\n") + "        run: |\n".length)
    .split("\n").filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-bun-workflow-"));
  try {
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "release:check": "node -e \"require('node:fs').writeFileSync('gate-ran', 'yes')\"" } }));
    writeFileSync(join(root, "test/tracker-lenses.test.ts"), `import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
test("runtime witness", () => { assert.ok(process.versions.bun); writeFileSync("bun-ran", process.versions.bun); });
`);
    const result = spawnSync("bash", ["-e", "-c", script], { cwd: root, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, "gate-ran"), "utf8"), "yes");
    assert.ok(readFileSync(join(root, "bun-ran"), "utf8"), "workflow must execute tests under Bun");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Bun witness skips when either optional tool is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-optional-tools-"));
  try {
    for (const available of ["bash", "bun"]) {
      const bin = join(root, available);
      mkdirSync(bin);
      // A version-only executable proves discovery succeeds for one tool while
      // the isolated PATH makes the other unavailable. Executing the gate fails.
      const tool = join(bin, available);
      writeFileSync(tool, `#!${process.execPath}\nprocess.exit(process.argv[2] === "--version" ? 0 : 17);\n`);
      chmodSync(tool, 0o755);
      const env: NodeJS.ProcessEnv = { ...process.env, ...discardChildCoverage(), PATH: bin };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [
        "--test", "--test-reporter=tap",
        "--test-name-pattern=^Bun CI gate executes tracker lens tests in the Bun runtime$",
        fileURLToPath(import.meta.url),
      ], { encoding: "utf8", env, timeout: 120_000 });
      assert.equal(result.status, 0, `${available} only: ${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /ok \d+ - Bun CI gate executes tracker lens tests in the Bun runtime[^\n]*# SKIP/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
