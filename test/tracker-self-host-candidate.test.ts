import "./helpers/isolate-session.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { testEnvironment } from "./helpers/test-environment.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { testTime } from "./support/depth.ts";

const manifest = readFileSync(join(packageRoot, "package.json"), "utf8");
const { version } = JSON.parse(manifest) as { version: string };

for (const [workflow, job, postScript] of [
  ["sync", "gated-sync", "post-import-script"],
  ["closeout", "gated-closeout", "post-closeout-script"],
]) {
  test(`the ${workflow} caller commits the bundle for the regenerated tracker and changelog`, { timeout: testTime(120_000) }, (t) => {
    const caller = parse(readFileSync(join(packageRoot, `.github/workflows/pm-github-${workflow}.yml`), "utf8")) as {
      jobs: Record<string, { with: Record<string, string> }>;
    };
    const inputs = caller.jobs[job].with;
    assert.ok(inputs, "the caller must configure generated output and a post-script");
    assert.equal(inputs["generated-paths"], "selfhost.bundle");
    assert.equal(inputs[postScript], "self-host:tracker-candidate");

    const { root, cleanup } = makeTempDir();
    t.after(cleanup);
    const environment = testEnvironment({
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      PM_AUTHOR: "fixture",
    });
    /** Run a real CLI in the isolated tracker and surface a failing candidate hook. */
    const run = (command: string, ...args: string[]): string =>
      execFileSync(command, args, { cwd: root, env: environment, encoding: "utf8" });

    mkdirSync(join(root, "scripts"));
    for (const path of ["scripts/self-host.ts", "scripts/main-invocation.ts", "self-host.json"]) {
      copyFileSync(join(packageRoot, path), join(root, path));
    }
    for (const path of ["engine", "node_modules"]) symlinkSync(join(packageRoot, path), join(root, path), "junction");
    writeFileSync(join(root, "package.json"), manifest);
    writeFileSync(join(root, "README.md"), "committed baseline\n");
    run("git", "init", "-q");
    const pm = join(root, "node_modules", ".bin", "pm");
    run(pm, "init", "candidate", "--defaults", "--preset", "minimal", "--agent-guidance", "skip", "--no-merge-fence");
    const issue = "candidate-review";
    /** Create the TOON item and its native history through the pinned pm CLI. */
    const createIssue = (...options: string[]): void => {
      run(pm, "create", "Issue", "Imported tracker witness", "--id", issue, "--create-mode", "progressive",
        "--no-inherit-focus", "--release", version, ...options);
    };
    if (workflow === "closeout") createIssue();

    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n");
    run("git", "add", "--", ".agents/pm", "README.md", "CHANGELOG.md", "self-host.json", "package.json");
    run("git", "commit", "-qm", "fixture baseline");
    const writer = join(root, "scripts/self-host.ts");
    run(process.execPath, writer, "--write");
    run("git", "add", "--", "selfhost.bundle");
    run("git", "commit", "-qm", "fixture bundle");

    const previousChangelog = readFileSync(join(root, "CHANGELOG.md"));
    if (workflow === "sync") createIssue("--status", "closed", "--close-reason", "Imported closed issue");
    else run(pm, "close", issue, "--reason", "Fixture closeout");
    // The reusable workflows stage only the changed tracker paths before running the hook.
    const trackerPaths = [`.agents/pm/issues/${issue}.toon`, `.agents/pm/history/${issue}.jsonl`];
    run("git", "add", "--", ...trackerPaths);
    writeFileSync(join(root, "README.md"), "out-of-scope working edit\n");

    const manager = process.versions.bun === undefined ? "npm" : "bun";
    run(manager, "run", inputs[postScript]);
    const changelog = readFileSync(join(root, "CHANGELOG.md"));
    assert.notDeepEqual(changelog, previousChangelog);
    assert.match(changelog.toString("utf8"), /Imported tracker witness/);
    assert.equal(run("git", "diff", "--name-only", "--", "CHANGELOG.md"), "");
    run("git", "add", "--", inputs["generated-paths"]);
    run("git", "commit", "--only", "-qm", "candidate", "--", ...trackerPaths, "CHANGELOG.md", inputs["generated-paths"]);
    assert.match(run(process.execPath, writer), /committed bundle.*byte-identical/);
    if (workflow !== "sync") return;
    run("npm", "run", "changelog:check");

    const bundle = join(root, inputs["generated-paths"]);
    utimesSync(bundle, 1, 1);
    run(manager, "run", inputs[postScript]);
    assert.equal(statSync(bundle).mtimeMs, 1000);
    assert.equal(run("git", "diff", "--name-only", "HEAD", "--", "CHANGELOG.md", inputs["generated-paths"]), "");
  });
}
