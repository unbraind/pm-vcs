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
import { join, relative } from "node:path";

import {
  PM_GITATTRIBUTES_END,
  PM_GITATTRIBUTES_START,
  auditMergeDriverConfiguration,
  buildMergeAttributePatterns,
  resolveProjectMergeTypeFolders,
} from "@unbrained/pm-cli/sdk/merge";
import { readSettings, serializeItemDocument } from "@unbrained/pm-cli/sdk";
import type { ItemDocument } from "@unbrained/pm-cli/sdk";

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
    await checkFenceCoverage(repoRoot, pmRoot),
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
 * Verifies the **committed** fence covers every item type the schema declares.
 *
 * A type added with `pm schema add-type` writes items into a folder that a fence
 * installed earlier does not name, so exactly those items merge unprotected
 * while every other item is safe.
 *
 * This reads the fence out of `HEAD` rather than off disk, which matters more
 * than it looks. The fence is the *shared* half of the mechanism: what protects
 * other clones is what is committed. Auditing the working tree would let an
 * uncommitted local fence update turn this check green while `HEAD` still lacks
 * the patterns — preflight would report a safe repository while every other
 * clone merged those items unprotected. The expected pattern set comes from the
 * SDK's own `buildMergeAttributePatterns`, so it cannot drift from what
 * `pm merge install` writes.
 *
 * @param repoRoot - Absolute repository root.
 * @param pmRoot - Absolute tracker root.
 * @returns The finding for this check.
 */
export async function checkFenceCoverage(
  repoRoot: string,
  pmRoot: string,
): Promise<PreflightCheck> {
  const name = "merge_fence_coverage";
  const committed = runGit(["show", "HEAD:.gitattributes"], repoRoot);
  if (committed.status !== 0) {
    return {
      name,
      status: "fail",
      detail: "No .gitattributes is committed at HEAD, so no fence covers any item type for other clones.",
      remediation: "Run `pm merge install`, then commit .gitattributes.",
    };
  }

  const fenced = fencedPatterns(committed.stdout);
  if (fenced === null) {
    return {
      name,
      status: "fail",
      detail: "The committed .gitattributes contains no pm merge-driver fence block.",
      remediation: "Run `pm merge install` and commit the resulting .gitattributes fence.",
    };
  }

  const settings = await readSettings(pmRoot);
  const trackerPrefix = relative(repoRoot, pmRoot).split("\\").join("/");
  const expected = buildMergeAttributePatterns(
    trackerPrefix,
    resolveProjectMergeTypeFolders(settings),
  );
  const missing = expected.filter((pattern) => !fenced.includes(pattern));
  const stale = fenced.filter((pattern) => !expected.includes(pattern));
  if (missing.length > 0 || stale.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`${missing.length} pattern(s) the active schema requires are absent from HEAD`);
    }
    if (stale.length > 0) {
      parts.push(`${stale.length} committed pattern(s) are no longer produced`);
    }
    return {
      name,
      status: "fail",
      detail: `The committed fence no longer matches the active schema: ${parts.join("; ")}. Items in an uncovered type folder merge under git's default text driver in every clone.`,
      remediation: "Run `pm merge install` to refresh the fence, then commit .gitattributes.",
    };
  }
  return {
    name,
    status: "pass",
    detail: "The fence committed at HEAD covers every item type folder the active schema declares.",
    remediation: null,
  };
}

/**
 * Extracts the pm-owned attribute lines from a `.gitattributes` body.
 *
 * @param body - Full `.gitattributes` contents.
 * @returns The fenced pattern lines, or `null` when no fence block is present.
 */
export function fencedPatterns(body: string): string[] | null {
  const lines = body.split(/\r?\n/);
  const start = lines.indexOf(PM_GITATTRIBUTES_START);
  const end = lines.indexOf(PM_GITATTRIBUTES_END);
  if (start === -1 || end === -1 || end < start) return null;
  return lines.slice(start + 1, end).map((line) => line.trim()).filter((line) => line !== "");
}

/**
 * The pm merge drivers, each with a fixture its artifact class can actually parse.
 *
 * Probing only one driver was not enough: if `merge.pm-item-toon.driver` pointed
 * at a missing executable, its configuration read as harmless *drift*, a probe of
 * the history driver passed, and preflight stayed green while every `.toon` item
 * merge would fail at merge time. Each driver therefore gets its own probe, with
 * content its own parser accepts, so a failure is attributable to the driver
 * command rather than to a fixture the parser rejected.
 *
 * `ours` and `theirs` deliberately differ from `base` in a way the field-aware
 * merge resolves cleanly, so a healthy driver exits zero.
 */
const DRIVER_PROBES: readonly {
  readonly key: string;
  readonly extension: string;
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}[] = [
  {
    key: "merge.pm-history.driver",
    extension: "jsonl",
    base: "",
    ours: `${JSON.stringify({ op: "add", field: "a", value: 1 })}\n`,
    theirs: `${JSON.stringify({ op: "add", field: "b", value: 2 })}\n`,
  },
  {
    key: "merge.pm-relationship.driver",
    extension: "jsonl",
    base: "",
    ours: `${JSON.stringify({ sequence: 1, eventId: "ours", at: "2026-01-01T00:00:00.000Z" })}\n`,
    theirs: `${JSON.stringify({ sequence: 1, eventId: "theirs", at: "2026-01-01T00:00:01.000Z" })}\n`,
  },
  {
    key: "merge.pm-json.driver",
    extension: "json",
    base: `${JSON.stringify({ probe: {} }, null, 2)}\n`,
    ours: `${JSON.stringify({ probe: { ours: true } }, null, 2)}\n`,
    theirs: `${JSON.stringify({ probe: { theirs: true } }, null, 2)}\n`,
  },
  {
    key: "merge.pm-item-toon.driver",
    extension: "toon",
    // A real item document, produced by the SDK's own serializer so the item
    // parser accepts it. Hand-written TOON is rejected as "not a readable item
    // document", which would make this probe report a driver failure that is
    // really a fixture failure.
    base: serializeItemDocument(probeItemDocument(2)),
    ours: serializeItemDocument(probeItemDocument(1)),
    theirs: serializeItemDocument(probeItemDocument(2, "A note only theirs has")),
  },
];

/**
 * Builds a valid item document for the driver probe.
 *
 * `ItemDocument` is `{ metadata, body }`, and the serializer requires the
 * metadata fields the parser then demands, so the shape is spelled out rather
 * than cast — a cast here would compile and produce a document the item parser
 * rejects, which is exactly the failure this fixture exists to avoid.
 *
 * @param priority - Priority to set, so two variants differ on a scalar.
 * @param note - Optional note, so a variant also differs on a union collection.
 * @returns An item document the shipped serializer and parser both accept.
 */
function probeItemDocument(priority: 1 | 2, note?: string): ItemDocument {
  const stamp = "2026-01-01T00:00:00.000Z";
  return {
    metadata: {
      id: "probe-0000",
      title: "pm-vcs preflight driver probe",
      description: "",
      type: "Task",
      status: "open",
      priority,
      tags: [],
      created_at: stamp,
      updated_at: stamp,
      ...(note === undefined
        ? {}
        : { notes: [{ text: note, created_at: stamp, author: "pm-vcs-preflight" }] }),
    },
    body: "",
  };
}

/**
 * Proves every configured driver actually runs, by merging synthetic inputs.
 *
 * Configuration presence is not the same as a working driver. A driver command
 * that points into `node_modules` resolves in the clone it was installed from and
 * fails in a fresh worktree that has not run `npm install` — and it fails
 * *during* a merge, when the working tree is already rewritten. So this asks each
 * configured driver to merge three throwaway blobs in a temporary directory and
 * looks at the exit status.
 *
 * A driver key that is not configured at all is reported by
 * {@link checkDriverConfiguration} rather than here, so this check stays about
 * executability and does not double-report the same problem.
 *
 * @param repoRoot - Absolute repository root, used to read the driver commands.
 * @returns The finding for this check.
 */
export function checkDriverExecutable(repoRoot: string): PreflightCheck {
  const name = "merge_driver_runs";
  const configured = DRIVER_PROBES.map((probe) => ({
    probe,
    command: runGit(["config", "--get", probe.key], repoRoot),
  })).filter(({ command }) => command.status === 0 && command.stdout.trim() !== "");

  if (configured.length === 0) {
    return {
      name,
      status: "fail",
      detail: "No pm merge driver command is configured, so there is nothing to execute.",
      remediation: "Run `pm merge install` in this clone or worktree.",
    };
  }

  const scratch = mkdtempSync(join(tmpdir(), "pm-vcs-preflight-"));
  try {
    const failures: string[] = [];
    for (const { probe, command } of configured) {
      const paths = {
        base: join(scratch, `base.${probe.extension}`),
        ours: join(scratch, `ours.${probe.extension}`),
        theirs: join(scratch, `theirs.${probe.extension}`),
      };
      writeFileSync(paths.base, probe.base);
      writeFileSync(paths.ours, probe.ours);
      writeFileSync(paths.theirs, probe.theirs);
      const result = spawnDriver(command.stdout.trim(), paths, scratch);
      if (!result.ok) failures.push(`${probe.key}: ${result.detail}`);
    }
    if (failures.length > 0) {
      return {
        name,
        status: "fail",
        detail: `${failures.length} of ${configured.length} configured merge driver command(s) could not run: ${failures.join("; ")}. Git would report a merge failure only once the working tree had already been rewritten.`,
        remediation: "Run `npm install` if the drivers resolve through a local devDependency, then re-run `pm merge install` in this checkout.",
      };
    }
    return {
      name,
      status: "pass",
      detail: `All ${configured.length} configured merge driver command(s) executed successfully against synthetic three-way inputs.`,
      remediation: null,
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
    // A driver command that never returns would hang preflight itself, which is
    // the command an agent runs to find out whether it can safely proceed.
    timeout: 30_000,
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
