/**
 * Clone readiness: can *this* checkout merge tracker data field-aware?
 *
 * The gap this closes is the one that costs the most and shows the least.
 * `pm merge install` writes the `merge.pm-*.driver` definitions into **git
 * config**. `.gitattributes` is committed and therefore travels with the
 * repository — but `.gitattributes` alone is inert. Without the driver
 * definitions in config, git silently falls back to its default line-based merge
 * on `.toon` item documents and on append-only history JSONL.
 *
 * That failure mode has no signal. The agent gets a line-merged or conflicted
 * item file and nothing anywhere says the field-aware driver never ran.
 *
 * Which checkouts actually have the hole is worth stating precisely, because the
 * intuitive answer is wrong and the suite pins both halves:
 *
 * - **A fresh clone does.** `git clone` copies the committed `.gitattributes`
 *   but not git config, so every collaborator's clone and every CI checkout
 *   starts with the fence installed and no drivers behind it.
 * - **A linked worktree does not.** `git worktree add` shares the repository's
 *   config file, so the drivers configured in the main clone already apply
 *   there. An agent spinning up a worktree for parallel work does not need to
 *   re-run `pm merge install`; an agent cloning does.
 *
 * So this module runs the checks an agent should run as the first thing it does
 * in a new checkout, and reports each one with a remediation. It is read-only:
 * every check either reads git config, reads the filesystem, or runs the driver
 * against synthetic inputs in a temporary directory.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditMergeAttributeFence,
  auditMergeDriverConfiguration,
  resolveProjectMergeTypeFolders,
} from "@unbrained/pm-cli/sdk/merge";
import { readSettings } from "@unbrained/pm-cli/sdk";

import { runGit } from "./git.ts";

/** Severity of a single preflight finding. */
export type CheckStatus =
  /** The invariant holds. */
  | "pass"
  /** The invariant is broken; tracker merges in this clone are unsafe. */
  | "fail"
  /** Worth knowing, but not a reason to refuse to work. */
  | "warn";

/** One preflight finding. */
export interface PreflightCheck {
  /** Stable machine-readable check name. */
  readonly name: string;
  /** Outcome for this check. */
  readonly status: CheckStatus;
  /** What was observed, in one sentence. */
  readonly detail: string;
  /** Concrete next step, present whenever the status is not `pass`. */
  readonly remediation: string | null;
}

/** Full preflight result. */
export interface PreflightReport {
  /** True only when no check failed; warnings do not clear it. */
  readonly ok: boolean;
  /** Absolute repository root that was checked. */
  readonly repo_root: string;
  /** Absolute tracker root that was checked. */
  readonly pm_root: string;
  /** Every check, in execution order. */
  readonly checks: readonly PreflightCheck[];
  /** Names of the checks that failed, so a caller can branch without filtering. */
  readonly failed: readonly string[];
}

/** Inputs preflight needs, resolved by the caller from the command context. */
export interface PreflightOptions {
  /** Absolute repository root. */
  readonly repoRoot: string;
  /** Absolute tracker root. */
  readonly pmRoot: string;
}

/**
 * Runs every readiness check against one clone or worktree.
 *
 * @param options - Resolved repository and tracker roots.
 * @returns Every finding, plus an `ok` verdict that ignores warnings.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const { repoRoot, pmRoot } = options;
  const checks: PreflightCheck[] = [
    checkGitattributesCommitted(repoRoot),
    await checkDriverConfiguration(repoRoot),
    await checkFenceCoverage(pmRoot),
    checkDriverExecutable(repoRoot),
    checkUncommittedTrackerChanges(repoRoot, pmRoot),
  ];
  const failed = checks.filter((check) => check.status === "fail").map((check) => check.name);
  return { ok: failed.length === 0, repo_root: repoRoot, pm_root: pmRoot, checks, failed };
}

/**
 * Verifies the merge fence is committed, not merely present in the working tree.
 *
 * An uncommitted `.gitattributes` protects the clone that holds it and no other.
 * Because the fence is the shared half of the mechanism, a fence that exists
 * only locally means every collaborator and every CI checkout merges tracker
 * data unprotected while the author's own clone looks fine.
 *
 * @param repoRoot - Absolute repository root.
 * @returns The finding for this check.
 */
export function checkGitattributesCommitted(repoRoot: string): PreflightCheck {
  const name = "merge_fence_committed";
  const tracked = runGit(["cat-file", "-e", "HEAD:.gitattributes"], repoRoot);
  if (tracked.status !== 0) {
    return {
      name,
      status: "fail",
      detail: "No .gitattributes is committed at HEAD, so no branch carries the merge fence.",
      remediation: "Run `pm merge install`, then commit .gitattributes so every branch and clone inherits it.",
    };
  }
  const content = runGit(["show", "HEAD:.gitattributes"], repoRoot);
  if (!content.stdout.includes("merge=pm-")) {
    return {
      name,
      status: "fail",
      detail: "The committed .gitattributes declares no pm merge drivers.",
      remediation: "Run `pm merge install` and commit the resulting .gitattributes fence.",
    };
  }
  return {
    name,
    status: "pass",
    detail: "The committed .gitattributes carries the pm merge fence.",
    remediation: null,
  };
}

/**
 * Verifies this clone's git config defines the drivers the fence names.
 *
 * This is the check the package exists for. `auditMergeDriverConfiguration` is
 * the host's own audit, so the answer matches what a merge would actually find.
 *
 * `missing` and `drift` are deliberately graded differently. Missing keys mean
 * git has no driver to call and will line-merge tracker data — an unambiguous
 * failure. Drift means the configured command differs from the one this CLI
 * would write, which is the expected state for a repository that installed its
 * drivers from a local devDependency rather than a global install; the driver
 * still runs. Grading drift as a failure would make preflight permanently red
 * in exactly the repositories that took the more portable route.
 *
 * @param repoRoot - Absolute repository root.
 * @returns The finding for this check.
 */
export async function checkDriverConfiguration(repoRoot: string): Promise<PreflightCheck> {
  const name = "merge_drivers_configured";
  const audit = await auditMergeDriverConfiguration(repoRoot);
  if (audit.status === "missing") {
    return {
      name,
      status: "fail",
      detail: `This clone defines no driver for ${audit.missing_keys.length} required git config key(s): ${audit.missing_keys.join(", ")}. Git would fall back to its default line-based merge for tracker data.`,
      remediation: "Run `pm merge install` in this clone or worktree. git config is per-clone, so it is needed once per checkout.",
    };
  }
  if (audit.status === "drift") {
    return {
      name,
      status: "warn",
      detail: `Driver commands differ from this CLI's own paths for: ${audit.drifted_keys.join(", ")}. The drivers are defined and will run; this is the normal state when they were installed from a local devDependency.`,
      remediation: "Re-run `pm merge install` if the configured commands no longer resolve in this checkout.",
    };
  }
  return {
    name,
    status: "pass",
    detail: "Every merge driver the fence names is defined in this clone's git config.",
    remediation: null,
  };
}

/**
 * Verifies the committed fence still covers every item type the schema declares.
 *
 * A type added with `pm schema add-type` writes items into a folder that a fence
 * installed earlier does not name, so exactly those items merge unprotected
 * while every other item is safe.
 *
 * @param pmRoot - Absolute tracker root.
 * @returns The finding for this check.
 */
export async function checkFenceCoverage(pmRoot: string): Promise<PreflightCheck> {
  const name = "merge_fence_coverage";
  const settings = await readSettings(pmRoot);
  const audit = await auditMergeAttributeFence(pmRoot, resolveProjectMergeTypeFolders(settings));
  if (audit.status === "not_installed") {
    return {
      name,
      status: "fail",
      detail: "No merge fence was found for this tracker.",
      remediation: "Run `pm merge install`.",
    };
  }
  if (audit.status === "drift") {
    const parts: string[] = [];
    if (audit.missing_patterns.length > 0) {
      parts.push(`${audit.missing_patterns.length} pattern(s) the active schema requires are absent`);
    }
    if (audit.stale_patterns.length > 0) {
      parts.push(`${audit.stale_patterns.length} committed pattern(s) are no longer produced`);
    }
    return {
      name,
      status: "fail",
      detail: `The committed fence no longer matches the active schema: ${parts.join("; ")}. Items in an uncovered type folder merge under git's default text driver.`,
      remediation: "Run `pm merge install` to refresh the fence, then commit .gitattributes.",
    };
  }
  return {
    name,
    status: "pass",
    detail: "The committed fence covers every item type folder the active schema declares.",
    remediation: null,
  };
}

/**
 * Proves a configured driver actually runs, by merging synthetic inputs with it.
 *
 * Configuration presence is not the same as a working driver. A driver command
 * that points into `node_modules` resolves in the clone it was installed from
 * and fails in a fresh worktree that has not run `npm install` — and it fails
 * *during* a merge, when the working tree is already rewritten. So this check
 * asks git to run the real driver, on three throwaway blobs, in a temporary
 * directory, and looks at the exit status.
 *
 * The inputs are trivially mergeable, so a non-zero exit means the driver could
 * not run at all rather than that the content was hard to merge.
 *
 * @param repoRoot - Absolute repository root, used to read the driver command.
 * @returns The finding for this check.
 */
export function checkDriverExecutable(repoRoot: string): PreflightCheck {
  const name = "merge_driver_runs";
  // Probe the history driver specifically, because the fixture below is an
  // append-only JSONL stream. Probing the item driver would mean feeding TOON
  // documents to it, and a failure there could not be told apart from a fixture
  // the tracker schema rejected.
  const configured = runGit(["config", "--get", "merge.pm-history.driver"], repoRoot);
  if (configured.status !== 0 || configured.stdout.trim() === "") {
    return {
      name,
      status: "fail",
      detail: "No merge.pm-history.driver command is configured, so there is nothing to execute.",
      remediation: "Run `pm merge install` in this clone or worktree.",
    };
  }

  const scratch = mkdtempSync(join(tmpdir(), "pm-vcs-preflight-"));
  try {
    // `base` empty with one distinct appended entry on each side: the union case
    // the driver must handle, valid without any tracker schema, so a failure is
    // attributable to the driver command rather than to the fixture.
    const paths = {
      base: join(scratch, "base.jsonl"),
      ours: join(scratch, "ours.jsonl"),
      theirs: join(scratch, "theirs.jsonl"),
    };
    writeFileSync(paths.base, "");
    writeFileSync(paths.ours, `${JSON.stringify({ op: "add", field: "a", value: 1 })}\n`);
    writeFileSync(paths.theirs, `${JSON.stringify({ op: "add", field: "b", value: 2 })}\n`);

    const result = spawnDriver(configured.stdout.trim(), paths, scratch);
    if (result.ok) {
      return {
        name,
        status: "pass",
        detail: "The configured merge driver executed successfully against a synthetic three-way input.",
        remediation: null,
      };
    }
    return {
      name,
      status: "fail",
      detail: `The configured merge driver command could not run: ${result.detail}. Git would report a merge failure only once the working tree had already been rewritten.`,
      remediation: "Run `npm install` if the driver resolves through a local devDependency, then re-run `pm merge install` in this checkout.",
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Outcome of executing a driver command template. */
interface DriverRun {
  /** Whether the driver exited zero. */
  readonly ok: boolean;
  /** Failure detail, empty when `ok`. */
  readonly detail: string;
}

/**
 * Runs a git merge-driver command template against three files.
 *
 * Git substitutes `%O`, `%A`, `%B` and `%P` into the configured command before
 * handing it to a shell, so reproducing the driver's real invocation means doing
 * the same substitution. The substituted values are paths this function created
 * inside a temporary directory it owns — never caller-supplied — so no untrusted
 * text enters the command line.
 *
 * @param template - Configured driver command, with git's `%` placeholders.
 * @param paths - Absolute paths for the base, ours and theirs blobs.
 * @param cwd - Directory to run the driver in.
 * @returns Whether the driver ran, with detail on failure.
 */
export function spawnDriver(
  template: string,
  paths: { base: string; ours: string; theirs: string },
  cwd: string,
): DriverRun {
  const command = template
    .replaceAll("%O", paths.base)
    .replaceAll("%A", paths.ours)
    .replaceAll("%B", paths.theirs)
    .replaceAll("%P", "preflight-probe.jsonl")
    .replaceAll("%L", "7");
  // Git hands a merge-driver command to the platform shell, so the probe does
  // the same: a driver command is a shell string (it contains redirections and
  // quoted paths in practice), not an argv array. The only interpolated values
  // are paths this module created under its own mkdtemp directory.
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status === 0) return { ok: true, detail: "" };
  const stderr = result.stderr.trim();
  return {
    ok: false,
    detail: stderr === "" ? `exit ${String(result.status)}` : stderr,
  };
}

/**
 * Verifies no tracker mutation is sitting uncommitted.
 *
 * A merge that has to write an item file git considers dirty either refuses to
 * start or overwrites work that was never recorded. This is a warning rather
 * than a failure: an agent mid-edit is a normal state, and it is the agent's
 * call whether to commit before merging.
 *
 * @param repoRoot - Absolute repository root.
 * @param pmRoot - Absolute tracker root, used as the pathspec.
 * @returns The finding for this check.
 */
export function checkUncommittedTrackerChanges(repoRoot: string, pmRoot: string): PreflightCheck {
  const name = "tracker_worktree_clean";
  const status = runGit(["status", "--porcelain", "-z", "--", pmRoot], repoRoot);
  const dirty = status.stdout.split("\0").filter((entry) => entry.trim() !== "");
  if (dirty.length > 0) {
    return {
      name,
      status: "warn",
      detail: `${dirty.length} tracker path(s) have uncommitted changes; a merge would either refuse to start or overwrite them.`,
      remediation: "Commit or stash the tracker changes before merging.",
    };
  }
  return {
    name,
    status: "pass",
    detail: "No uncommitted tracker changes.",
    remediation: null,
  };
}
