// pm-vcs — branch-aware merge safety for pm trackers
//
// Capabilities (see manifest.json):
//   commands — `pm vcs preflight`, `pm vcs preview <ref>`, `pm vcs items <range>`
//
// The package composes what pm-cli already ships rather than reimplementing it:
// the merge-configuration audits and the field-aware three-way merge primitives
// both come from `@unbrained/pm-cli/sdk/merge`, so a preview cannot drift from
// what a real merge does, and preflight's verdict matches what a merge would
// actually find in this clone.
//
// Design rules this file holds to:
//   - No persistent state of its own. Everything is derived from git and the
//     tracker, so pm-vcs can never itself become a merge conflict.
//   - Read-only. No command writes to the working tree or the index.
//   - Handlers return bare objects. `api.registerRenderer` is silently no-oped
//     by the CLI, so shaping output here is the only thing that works.
//   - No command declares a host-owned global flag (`--json`, `--lean`,
//     `--quiet`, `--path`, `--pm-path`, `--author`, `--id-only`,
//     `--no-changed-fields`, `--full-changed-fields`). Declaring one aborts
//     registration at that command and silently drops every later sibling.

import type {
  CommandHandlerContext,
  ExtensionApi,
  ExtensionModule,
} from "@unbrained/pm-cli/sdk/authoring";
import { relative, resolve } from "node:path";

import { VcsError, resolveRepoRoot } from "./git.ts";
import { itemsInRange, type RangeReport } from "./ledger.ts";
import { type PreviewReport, previewMerge } from "./preview.ts";
import { type PreflightReport, runPreflight } from "./preflight.ts";

/** Resolved roots every command needs before it can read anything. */
interface ResolvedRoots {
  /** Absolute repository root. */
  readonly repoRoot: string;
  /** Absolute tracker root. */
  readonly pmRoot: string;
  /** Tracker root relative to the repository root, POSIX, `""` when identical. */
  readonly trackerPrefix: string;
}

/**
 * Resolves the repository and tracker roots for one invocation.
 *
 * `context.repo_root` is populated by the host when it can resolve one, but a
 * command may also run from a tracker that sits outside any repository, so the
 * lookup falls back to asking git from the tracker root and fails with a
 * remediation rather than proceeding with a guess.
 *
 * @param context - The host-supplied command context.
 * @returns Both absolute roots plus the tracker's repository-relative prefix.
 * @throws VcsError When the tracker is not inside a git repository.
 */
export function resolveRoots(context: CommandHandlerContext): ResolvedRoots {
  const pmRoot = resolve(context.pm_root);
  const repoRoot = context.repo_root ?? resolveRepoRoot(pmRoot);
  if (repoRoot === null) {
    throw new VcsError(
      "not_a_git_repository",
      `The tracker at ${pmRoot} is not inside a git repository, so there is no branch or merge to reason about.`,
      "Run this command from a git working tree, or run `git init` if this project is not yet under version control.",
    );
  }
  const absoluteRepoRoot = resolve(repoRoot);
  const prefix = relative(absoluteRepoRoot, pmRoot).split("\\").join("/");
  return { repoRoot: absoluteRepoRoot, pmRoot, trackerPrefix: prefix === "" ? "" : prefix };
}

/** Envelope returned by every pm-vcs command, carrying an explicit verdict. */
interface CommandEnvelope {
  /** Whether the command's own criterion was satisfied. */
  readonly ok: boolean;
  /** Non-zero when the caller should treat the run as a failure. */
  readonly exit_code: number;
}

/** `pm vcs preflight` result. */
type PreflightEnvelope = CommandEnvelope & { readonly preflight: PreflightReport };

/** `pm vcs preview` result. */
type PreviewEnvelope = CommandEnvelope & { readonly preview: PreviewReport };

/** `pm vcs items` result. */
type ItemsEnvelope = CommandEnvelope & { readonly items: RangeReport };

/**
 * Reads a string option, treating a blank value as absent.
 *
 * Multi-word flags reach a handler camel-cased (`--fail-on` arrives as
 * `failOn`), which is the single most common source of a silently ignored
 * option in a pm extension, so every read goes through this helper with the
 * camel-cased name.
 *
 * The bag is accepted as possibly absent. `CommandHandlerContext` types it as
 * always present, but pm-cli#825 is a standing demonstration that these types
 * can promise more than the runtime delivers, and a `TypeError` from indexing
 * `undefined` would surface as an opaque handler failure rather than as a
 * missing option.
 *
 * @param options - The context's option bag, if the host supplied one.
 * @param name - Camel-cased option name.
 * @returns The trimmed value, or `undefined` when unset or blank.
 */
export function readStringOption(
  options: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const raw = options?.[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Decides the exit code for a preview under a `--fail-on` threshold.
 *
 * `conflict` gates only on genuinely unresolvable scalar collisions.
 * `unprotected` additionally gates on tracker artifacts no driver covers, which
 * is the stricter and more useful setting for a CI job guarding multi-agent
 * branches: an unprotected artifact is a silent line-merge waiting to happen,
 * and it will not show up as a conflict.
 *
 * @param report - The preview to judge.
 * @param failOn - Threshold, or `undefined` to always succeed.
 * @returns Zero when the threshold is not breached, otherwise 1.
 * @throws VcsError When `failOn` is not a recognised threshold.
 */
export function previewExitCode(report: PreviewReport, failOn: string | undefined): number {
  if (failOn === undefined) return 0;
  // delete/modify counts as a conflict for gating: git leaves it unresolved in
  // the working tree, so a branch carrying one is no more mergeable than one
  // carrying a field collision.
  const blocking = report.totals.conflict + report.totals.delete_modify;
  if (failOn === "conflict") return blocking > 0 ? 1 : 0;
  if (failOn === "unprotected") return blocking + report.totals.unprotected > 0 ? 1 : 0;
  throw new VcsError(
    "invalid_fail_on",
    `--fail-on accepts "conflict" or "unprotected", not "${failOn}".`,
    'Pass --fail-on conflict to gate on unresolvable field collisions, or --fail-on unprotected to also gate on tracker artifacts no merge driver covers.',
  );
}

/**
 * Turns a failed preflight into a thrown error, so the command exits non-zero.
 *
 * Every failed check's detail and remediation is folded into the message. The
 * host renders a thrown handler error's message but discards any structured
 * payload, so a summary that omitted the specifics would leave the agent with a
 * red exit and nothing to act on.
 *
 * @param report - The preflight report to judge.
 * @throws VcsError When any check failed.
 */
export function assertPreflightPassed(report: PreflightReport): void {
  if (report.ok) return;
  const failures = report.checks.filter((check) => check.status === "fail");
  throw new VcsError(
    "preflight_failed",
    `This checkout is not ready for multi-agent tracker work: ${failures
      .map((check) => `[${check.name}] ${check.detail}`)
      .join(" ")}`,
    failures
      .map((check) => check.remediation)
      .filter((remediation): remediation is string => remediation !== null)
      .join(" "),
  );
}

/**
 * Turns a breached `--fail-on` threshold into a thrown error.
 *
 * Unlike preflight this is opt-in, so the default run keeps the full structured
 * report and only an explicit gate request converts a finding into a non-zero
 * exit.
 *
 * @param report - The preview to judge.
 * @param failOn - Threshold the caller asked to gate on.
 * @throws VcsError When the threshold is breached.
 */
export function assertPreviewWithinThreshold(
  report: PreviewReport,
  failOn: string | undefined,
): void {
  if (previewExitCode(report, failOn) === 0) return;
  const conflicted = report.entries.filter((entry) => entry.resolution === "conflict");
  const deleted = report.entries.filter((entry) => entry.resolution === "delete_modify");
  const unprotected = report.entries.filter((entry) => entry.resolution === "unprotected");
  const parts = [
    ...conflicted.map(
      (entry) => `${entry.path} conflicts on ${entry.conflict_fields.join(", ")}`,
    ),
    ...deleted.map(
      (entry) => `${entry.path} is deleted on one side and changed on the other`,
    ),
    ...(failOn === "unprotected"
      ? unprotected.map((entry) => `${entry.path} is covered by no merge driver`)
      : []),
  ];
  throw new VcsError(
    "preview_threshold_breached",
    `Merging ${report.ref} into HEAD would not be clean: ${parts.join("; ")}.`,
    unprotected.length > 0 && failOn === "unprotected"
      ? "Run `pm merge install` in this checkout to cover the unprotected artifacts, and resolve the conflicting fields on one branch before merging."
      : "Resolve the conflicting fields on one branch before merging, or merge the other direction first.",
  );
}

/**
 * Registers the package's commands.
 *
 * @param api - The host-supplied extension API.
 */
function setupCommands(api: ExtensionApi): void {
  api.registerCommand({
    name: "vcs preflight",
    description:
      "Verify this clone or worktree can merge tracker data field-aware: committed merge fence, per-clone driver configuration, fence coverage for every schema type, a driver that actually executes, and a clean tracker worktree.",
    async run(context: CommandHandlerContext): Promise<PreflightEnvelope> {
      const roots = resolveRoots(context);
      const preflight = await runPreflight({ repoRoot: roots.repoRoot, pmRoot: roots.pmRoot });
      // Preflight is a gate: an agent runs it to decide whether this checkout is
      // safe to work in, and a green exit on a broken clone would defeat it.
      // Throwing is the only way an extension command can exit non-zero — a
      // returned payload always exits 0 whatever it contains — so the verdict is
      // carried in a thrown error rather than only in the report body.
      assertPreflightPassed(preflight);
      return { ok: true, exit_code: 0, preflight };
    },
  });

  api.registerCommand({
    name: "vcs preview",
    description:
      "Predict what merging <ref> into HEAD would do to tracker data, per item and per field, without touching the working tree. Runs the shipped merge primitives against blobs read from git, so the prediction matches the real merge.",
    arguments: [{ name: "ref", description: "Ref to preview merging into HEAD", required: true }],
    flags: [
      {
        // `long` / `value_name` / `value_type`, not `name` / `type`.
        // FlagDefinition carries an `[key: string]: unknown` index signature, so
        // a misnamed field type-checks cleanly and is then rejected at
        // activation — which aborts registration at this command and silently
        // drops every later sibling. See unbraind/pm-cli#825.
        long: "--fail-on",
        value_name: "threshold",
        description:
          "Exit non-zero when the preview finds problems: 'conflict' for unresolvable field collisions, 'unprotected' to also fail on tracker artifacts no merge driver covers",
        value_type: "string",
      },
    ],
    run(context: CommandHandlerContext): PreviewEnvelope {
      const roots = resolveRoots(context);
      const ref = context.args[0];
      if (ref === undefined || ref.trim() === "") {
        throw new VcsError(
          "missing_ref",
          "pm vcs preview requires a ref to preview.",
          "Pass the branch or commit you intend to merge, for example `pm vcs preview origin/main`.",
        );
      }
      const preview = previewMerge({
        ref: ref.trim(),
        repoRoot: roots.repoRoot,
        trackerPrefix: roots.trackerPrefix,
      });
      assertPreviewWithinThreshold(preview, readStringOption(context.options, "failOn"));
      return { ok: true, exit_code: 0, preview };
    },
  });

  api.registerCommand({
    name: "vcs items",
    description:
      "List the pm items a revision range created, modified or deleted, with the commits that touched each one. Directly consumable by a PR description or release notes.",
    arguments: [
      { name: "range", description: "Revision range, for example main..HEAD", required: true },
    ],
    run(context: CommandHandlerContext): ItemsEnvelope {
      const roots = resolveRoots(context);
      const range = context.args[0];
      if (range === undefined || range.trim() === "") {
        throw new VcsError(
          "missing_range",
          "pm vcs items requires a revision range.",
          "Pass a range git accepts, for example `pm vcs items main..HEAD`.",
        );
      }
      const items = itemsInRange({
        range: range.trim(),
        repoRoot: roots.repoRoot,
        trackerPrefix: roots.trackerPrefix,
      });
      return { ok: true, exit_code: 0, items };
    },
  });
}

/**
 * Identity helper that preserves the module's literal type through the default
 * export, so a typo in a capability name is a compile error rather than a
 * silently inactive registration.
 *
 * @param module - The extension module to export.
 * @returns The same module, with its literal type retained.
 */
const defineExtension = <TModule extends ExtensionModule>(module: TModule): TModule => module;

export default defineExtension({
  name: "pm-vcs",
  version: "2026.7.30",

  activate(api: ExtensionApi) {
    setupCommands(api);
  },
});
