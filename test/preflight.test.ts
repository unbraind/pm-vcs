import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  checkDriverExecutable,
  checkGitattributesCommitted,
  checkUncommittedTrackerChanges,
  runPreflight,
  spawnDriver,
} from "../preflight.ts";
import { type Sandbox, createSandbox, packageRoot } from "./helpers/sandbox.ts";

const sandboxes: Sandbox[] = [];

/**
 * Registers a sandbox for teardown and returns it.
 *
 * @param sandbox - Sandbox to track.
 * @returns The same sandbox.
 */
function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

after(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

/**
 * Finds one named check in a report, failing the test when it is absent.
 *
 * @param checks - Checks from a preflight report.
 * @param name - Check name to look up.
 * @returns The matching check.
 */
function find(
  checks: readonly { name: string; status: string; detail: string; remediation: string | null }[],
  name: string,
): { name: string; status: string; detail: string; remediation: string | null } {
  const found = checks.find((check) => check.name === name);
  assert.ok(found, `report should contain the ${name} check`);
  return found;
}

test("a clone with drivers installed and its fence committed passes every check", async () => {
  const sandbox = track(createSandbox());
  const report = await runPreflight({ repoRoot: sandbox.root, pmRoot: sandbox.pmRoot });

  assert.equal(report.ok, true, `expected a clean preflight, got: ${JSON.stringify(report.failed)}`);
  assert.deepEqual(report.failed, []);
  assert.equal(report.repo_root, sandbox.root);
  assert.equal(report.pm_root, sandbox.pmRoot);
  for (const check of report.checks) {
    assert.notEqual(check.status, "fail", `${check.name} should not fail: ${check.detail}`);
    if (check.status === "pass") assert.equal(check.remediation, null);
  }
  // Every non-passing check must tell the agent what to do about it.
  for (const check of report.checks) {
    if (check.status !== "pass") assert.ok(check.remediation, `${check.name} needs a remediation`);
  }
});

test("a fresh clone has no drivers and fails loudly, then passes after merge install", async () => {
  // This is the gap the package exists for, stated precisely. `.gitattributes`
  // is committed and therefore travels with the clone, but the drivers live in
  // git config, which `git clone` does NOT copy. So a fresh clone — what CI
  // does, and what every collaborator does — silently line-merges tracker data
  // until `pm merge install` runs in it.
  const origin = track(createSandbox());
  const clonePath = `${origin.root}-clone`;
  origin.git("clone", "-q", origin.root, clonePath);
  const clone = track({
    ...origin,
    root: clonePath,
    pmRoot: join(clonePath, ".agents", "pm"),
    cleanup: () => rmSync(clonePath, { recursive: true, force: true }),
  });

  const before = await runPreflight({ repoRoot: clone.root, pmRoot: clone.pmRoot });
  assert.equal(before.ok, false, "a driverless clone must not pass");
  assert.ok(
    before.failed.includes("merge_drivers_configured"),
    `expected the driver check to fail, got: ${JSON.stringify(before.failed)}`,
  );
  const drivers = find(before.checks, "merge_drivers_configured");
  assert.match(drivers.detail, /default line-based merge/);
  assert.match(drivers.remediation ?? "", /per-clone/);
  // The fence itself travelled with the clone, so that check still passes: the
  // two halves of the mechanism are reported independently, which is what makes
  // the finding actionable rather than one opaque failure.
  assert.equal(find(before.checks, "merge_fence_committed").status, "pass");

  execFileSync(join(packageRoot, "node_modules", ".bin", "pm"), ["merge", "install"], {
    cwd: clone.root,
    encoding: "utf8",
    // Override NODE_V8_COVERAGE to /dev/null so the spawned `pm` process does
    // not corrupt the test runner's coverage data (same reason as
    // test/helpers/sandbox.ts).
    env: { ...process.env, NODE_V8_COVERAGE: "/dev/null" },
  });
  const cured = await runPreflight({ repoRoot: clone.root, pmRoot: clone.pmRoot });
  assert.ok(
    !cured.failed.includes("merge_drivers_configured"),
    `merge install should clear the driver failure, still failing: ${JSON.stringify(cured.failed)}`,
  );
});

test("a linked worktree inherits the clone's drivers and passes", async () => {
  // Worth pinning, because it is the opposite of the intuition that every new
  // checkout needs its own install: `git worktree add` shares the repository's
  // config file, so the drivers configured in the main clone apply in the
  // worktree too. An agent spinning up a worktree for parallel work does not
  // need to re-run `pm merge install`; an agent cloning does.
  const sandbox = track(createSandbox());
  const worktree = `${sandbox.root}-wt`;
  sandbox.git("worktree", "add", "-q", "-b", "agent", worktree);

  const report = await runPreflight({
    repoRoot: worktree,
    pmRoot: join(worktree, ".agents", "pm"),
  });
  assert.ok(
    !report.failed.includes("merge_drivers_configured"),
    `a linked worktree should inherit drivers, failed: ${JSON.stringify(report.failed)}`,
  );
  assert.equal(find(report.checks, "merge_driver_runs").status, "pass");

  sandbox.git("worktree", "remove", "--force", worktree);
});

test("an uncommitted fence fails, because it protects only the local clone", () => {
  const sandbox = track(createSandbox({ commitFence: false }));
  const check = checkGitattributesCommitted(sandbox.root);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /No \.gitattributes is committed at HEAD/);
  assert.match(check.remediation ?? "", /commit \.gitattributes/);
});

test("a committed fence that declares no pm drivers fails", () => {
  const sandbox = track(createSandbox({ mergeInstall: false }));
  writeFileSync(join(sandbox.root, ".gitattributes"), "*.md text\n");
  sandbox.commit("Commit an unrelated .gitattributes");

  const check = checkGitattributesCommitted(sandbox.root);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /declares no pm merge drivers/);
});

test("a driver command pointing at a path that does not resolve fails", () => {
  const sandbox = track(createSandbox());
  // The realistic form of this failure: a driver installed from a local
  // devDependency in a checkout where dependencies were never installed.
  sandbox.git("config", "merge.pm-history.driver", "./node_modules/.bin/absent-driver %O %A %B");

  const check = checkDriverExecutable(sandbox.root);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /could not run/);
  assert.match(check.remediation ?? "", /npm install/);
});

test("no configured driver at all leaves nothing to execute", () => {
  const sandbox = track(createSandbox());
  for (const driver of ["pm-history", "pm-relationship", "pm-json", "pm-item-toon"]) {
    sandbox.git("config", "--unset", `merge.${driver}.driver`);
  }

  const check = checkDriverExecutable(sandbox.root);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /No pm merge driver command is configured/);
});

test("a broken item driver fails the check even when the history driver works", () => {
  // The gap this closes: probing only one driver meant a broken
  // merge.pm-item-toon.driver read as harmless config *drift*, the history probe
  // passed, and preflight stayed green while every .toon item merge would fail at
  // merge time.
  const sandbox = track(createSandbox());
  sandbox.git("config", "merge.pm-item-toon.driver", "./node_modules/.bin/absent-driver %O %A %B");

  const check = checkDriverExecutable(sandbox.root);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /merge\.pm-item-toon\.driver/);
  assert.match(check.detail, /could not run/);
});

test("every configured driver is probed, each with content its own parser accepts", () => {
  // A fixture the parser rejects would report a driver failure that is really a
  // fixture failure, so the pass here is also evidence the fixtures are valid for
  // all four artifact classes — including the item document, which must come from
  // the SDK serializer because hand-written TOON is rejected outright.
  const sandbox = track(createSandbox());
  const check = checkDriverExecutable(sandbox.root);
  assert.equal(check.status, "pass", check.detail);
  assert.match(check.detail, /All 4 configured merge driver command\(s\) executed successfully/);
});

test("driver-command substitution reports failure detail from the command itself", () => {
  const sandbox = track(createSandbox());
  const paths = {
    base: join(sandbox.root, "base"),
    ours: join(sandbox.root, "ours"),
    theirs: join(sandbox.root, "theirs"),
  };
  for (const path of Object.values(paths)) writeFileSync(path, "");

  // A command that succeeds only when every placeholder was substituted proves
  // the substitution happens, not merely that some command ran.
  const ok = spawnDriver('test -f "%O" && test -f "%A" && test -f "%B"', paths, sandbox.root);
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, "");

  const failed = spawnDriver('echo "boom" >&2; exit 3', paths, sandbox.root);
  assert.equal(failed.ok, false);
  assert.equal(failed.detail, "boom");

  // A command that fails silently still has to produce attributable detail.
  const silent = spawnDriver("exit 4", paths, sandbox.root);
  assert.equal(silent.ok, false);
  assert.equal(silent.detail, "exit 4");
});

test("a drifted driver command warns rather than failing", async () => {
  const sandbox = track(createSandbox());
  // A driver command that differs from this CLI's own path is the normal state
  // for a repo that installed drivers from a local devDependency. It still runs,
  // so grading it as a failure would keep preflight permanently red there.
  sandbox.git("config", "merge.pm-item-toon.driver", "sh -c 'exit 0' %O %A %B");

  const report = await runPreflight({ repoRoot: sandbox.root, pmRoot: sandbox.pmRoot });
  const drivers = find(report.checks, "merge_drivers_configured");
  assert.equal(drivers.status, "warn");
  assert.match(drivers.detail, /differ from this CLI's own paths/);
  assert.ok(
    !report.failed.includes("merge_drivers_configured"),
    "drift must not fail the preflight",
  );
});

test("a fence missing a pattern the schema requires fails", async () => {
  const sandbox = track(createSandbox());
  const fencePath = join(sandbox.root, ".gitattributes");
  const fence = readFileSync(fencePath, "utf8");
  // Drop one item-type folder from the fence: items of that type would merge
  // under git's default text driver while every other item stays safe.
  const withoutTasks = fence
    .split("\n")
    .filter((line) => !line.includes("/tasks/"))
    .join("\n");
  writeFileSync(fencePath, withoutTasks);
  sandbox.commit("Drop the tasks patterns from the fence");

  const report = await runPreflight({ repoRoot: sandbox.root, pmRoot: sandbox.pmRoot });
  const coverage = find(report.checks, "merge_fence_coverage");
  assert.equal(coverage.status, "fail");
  assert.match(coverage.detail, /no longer matches the active schema/);
  assert.match(coverage.detail, /the active schema requires are absent/);
  assert.ok(report.failed.includes("merge_fence_coverage"));
});

test("a fence carrying a pattern the schema no longer produces fails", async () => {
  const sandbox = track(createSandbox());
  const fencePath = join(sandbox.root, ".gitattributes");
  const fence = readFileSync(fencePath, "utf8");
  writeFileSync(
    fencePath,
    fence.replace(
      "# pm-cli:merge-drivers:end",
      '".agents/pm/retired/*.toon" merge=pm-item-toon\n# pm-cli:merge-drivers:end',
    ),
  );
  sandbox.commit("Add a stale pattern to the fence");

  const report = await runPreflight({ repoRoot: sandbox.root, pmRoot: sandbox.pmRoot });
  const coverage = find(report.checks, "merge_fence_coverage");
  assert.equal(coverage.status, "fail");
  assert.match(coverage.detail, /no longer produced/);
});

test("a repository with no committed .gitattributes has no fence coverage", async () => {
  const sandbox = track(createSandbox({ mergeInstall: false, commitFence: false }));
  writeFileSync(join(sandbox.root, "seed.txt"), "seed\n");
  sandbox.git("add", "seed.txt");
  sandbox.git("commit", "-q", "-m", "Commit without the fence");

  const report = await runPreflight({ repoRoot: sandbox.root, pmRoot: sandbox.pmRoot });
  const coverage = find(report.checks, "merge_fence_coverage");
  assert.equal(coverage.status, "fail");
  assert.match(coverage.detail, /No \.gitattributes is committed at HEAD/);
});

test("a committed file with no pm fence block has no fence coverage", async () => {
  const sandbox = track(createSandbox({ mergeInstall: false }));
  writeFileSync(join(sandbox.root, ".gitattributes"), "*.md text\n");
  sandbox.commit("Commit an unrelated .gitattributes");

  const report = await runPreflight({ repoRoot: sandbox.root, pmRoot: sandbox.pmRoot });
  const coverage = find(report.checks, "merge_fence_coverage");
  assert.equal(coverage.status, "fail");
  assert.match(coverage.detail, /no pm merge-driver fence block/);
});

test("an uncommitted fence fix does not make coverage pass for other clones", async () => {
  // The hole this closes: auditing the working tree let a local, uncommitted
  // fence update turn coverage green while HEAD still lacked the patterns — so
  // preflight reported a safe repository while every other clone merged those
  // items unprotected. Coverage is now read from HEAD, so only a committed fence
  // can clear it.
  const sandbox = track(createSandbox());
  const fencePath = join(sandbox.root, ".gitattributes");
  const complete = readFileSync(fencePath, "utf8");

  // Commit a fence missing the tasks patterns...
  writeFileSync(
    fencePath,
    complete.split("\n").filter((line) => !line.includes("/tasks/")).join("\n"),
  );
  sandbox.commit("Commit a fence missing the tasks patterns");
  // ...then restore the complete fence in the working tree only.
  writeFileSync(fencePath, complete);

  const report = await runPreflight({ repoRoot: sandbox.root, pmRoot: sandbox.pmRoot });
  const coverage = find(report.checks, "merge_fence_coverage");
  assert.equal(
    coverage.status,
    "fail",
    "an uncommitted local fence must not clear coverage for other clones",
  );
  assert.match(coverage.detail, /absent from HEAD/);
});

test("uncommitted tracker changes warn without failing the preflight", () => {
  const sandbox = track(createSandbox());
  const itemId = sandbox.createItem("Task", "An item to leave dirty");
  sandbox.commit("Add an item");

  const clean = checkUncommittedTrackerChanges(sandbox.root, sandbox.pmRoot);
  assert.equal(clean.status, "pass");
  assert.equal(clean.remediation, null);

  appendFileSync(join(sandbox.pmRoot, "history", `${itemId}.jsonl`), "");
  sandbox.pm("notes", itemId, "--add", "An uncommitted note");
  const dirty = checkUncommittedTrackerChanges(sandbox.root, sandbox.pmRoot);
  assert.equal(dirty.status, "warn");
  assert.match(dirty.detail, /uncommitted changes/);
  assert.match(dirty.remediation ?? "", /Commit or stash/);
});
