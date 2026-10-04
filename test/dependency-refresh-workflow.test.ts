import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

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
