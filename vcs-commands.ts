// The `pm vcs` command surface over the engine.
//
// Three conventions hold across every command here, each of them a lesson the
// host contract teaches the hard way:
//
//   - No command declares a host-owned global flag (`--json`, `--quiet`,
//     `--path`, `--author`, `--lean`, `--id-only`, …). Declaring one aborts
//     registration *at that command* and silently drops every later sibling, so
//     one collision would take out most of this file.
//   - Multi-word flags arrive camel-cased (`--allow-empty` becomes `allowEmpty`).
//   - A handler can only exit non-zero by throwing. A returned payload exits 0
//     whatever it says, so any command that is meant to gate something throws.

import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { VcsError } from "./git.ts";
import {
  type ImportReport,
  exportBundle,
  importBundle,
  readBundle,
} from "./engine/bundle.ts";
import { DEFAULT_CONFIG, type RepositoryConfig } from "./engine/config.ts";
import { orderCommitsNewestFirst, resolveFileId, traceFile, type FileChangeTrace } from "./engine/attribution.ts";
import { reachable } from "./engine/merge.ts";
import { type Signature, compareByteOrder, decodeCommit, decodeTree, effectiveChangeId, readCommit } from "./engine/model.ts";
import { ObjectStoreError, type ObjectId } from "./engine/objects.ts";
import { type Operation } from "./engine/oplog.ts";
import { FIELD_STRATEGIES, type FieldStrategy } from "./engine/records.ts";
import {
  CONTROL_DIRECTORY,
  DEFAULT_BRANCH,
  type MergeReport,
  type ResetMode,
  Repository,
} from "./engine/repo.ts";
import { BRANCH_PREFIX, type RefEntry, TAG_PREFIX } from "./engine/refs.ts";
import type { Remote } from "./engine/remotes.ts";
import { type CloneReport, type FetchReport, type PushReport, cloneFrom, fetchFrom, pushTo } from "./engine/sync.ts";
import { resolveRemoteLocation } from "./engine/transport.ts";
import { type StatusReport, flattenTree } from "./engine/worktree.ts";
import type {
  CommandHandlerContext,
  ExtensionApi,
} from "@unbrained/pm-cli/sdk/authoring";
import { PmClient, type GetResult, type ItemMetadata, type LinkedFile } from "@unbrained/pm-cli/sdk";

/** Envelope every command returns, carrying an explicit verdict. */
interface VcsEnvelope {
  readonly ok: boolean;
}

/**
 * Resolves the source working root from the host's portable workspace coordinates.
 *
 * @param context - The host-supplied command context.
 * @returns The source repository/workspace root, with the tracker as a legacy fallback.
 */
export function sourceWorkingRoot(context: CommandHandlerContext): string {
  return resolve(context.repo_root ?? context.source_workspace_root ?? context.pm_root);
}

/**
 * Finds the repository root containing a directory.
 *
 * Walks upward looking for the control directory, so a command works from any
 * subdirectory the way every other version control tool does. Stops at the
 * filesystem root rather than at the caller's start, because a repository
 * legitimately sits above the working directory.
 *
 * @param start - Directory to search upward from.
 * @returns The repository root, or null when none is found.
 */
export function findRepositoryRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, CONTROL_DIRECTORY))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Opens the repository a command should act on.
 *
 * @param context - The host-supplied command context.
 * @returns The opened repository.
 * @throws VcsError When no repository contains the working directory.
 */
export function openRepository(context: CommandHandlerContext): Repository {
  const start = sourceWorkingRoot(context);
  const root = findRepositoryRoot(start);
  if (root === null) {
    throw new VcsError(
      "no_repository",
      `No pm-vcs repository contains ${start}.`,
      "Run `pm vcs init` to create one here, or run this command inside an existing repository.",
    );
  }
  return Repository.open(root);
}

/** Return the host-bound SDK client, with a tracker-bound fallback for test and legacy hosts. */
export function pmClient(context: CommandHandlerContext): PmClient {
  return context.sdk?.client ?? new PmClient({
    pmRoot: context.pm_root,
    cwd: sourceWorkingRoot(context),
    noExtensions: true,
  });
}

/** Normalize an SDK projection that legitimately omits the linked-artifact group. */
export function linkedFiles(result: GetResult): readonly LinkedFile[] {
  return result.linked?.files ?? [];
}

/**
 * Reads a string option, treating a blank value as absent.
 *
 * @param options - The context's option bag, if the host supplied one.
 * @param name - Camel-cased option name.
 * @returns The trimmed value, or undefined when unset or blank.
 */
export function optionalString(options: Record<string, unknown> | undefined, name: string): string | undefined {
  const raw = options?.[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Reads a positive integer option.
 *
 * @param options - The context's option bag.
 * @param name - Camel-cased option name.
 * @param fallback - Value to use when the option is absent.
 * @returns The parsed value.
 * @throws VcsError When the option is present but not a positive integer.
 */
export function positiveInteger(
  options: Record<string, unknown> | undefined,
  name: string,
  fallback: number,
): number {
  const raw = optionalString(options, name);
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new VcsError(
      "invalid_option",
      `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a positive integer, not "${raw}".`,
      "Pass a whole number greater than zero.",
    );
  }
  return Number(raw);
}

/**
 * Splits a comma-separated option into trimmed, non-empty parts.
 *
 * Comma-separated rather than a repeated flag because a repeated flag's arrival
 * shape is not something the host contract pins down, and a value silently
 * collapsing to its last occurrence is worse than an explicit separator.
 *
 * @param options - The context's option bag.
 * @param name - Camel-cased option name.
 * @returns The parts, empty when the option is absent.
 */
export function commaSeparated(options: Record<string, unknown> | undefined, name: string): string[] {
  const raw = optionalString(options, name);
  return raw === undefined ? [] : raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Builds the signature to record for a commit.
 *
 * The author comes from the host's invocation-wide `--author` when it set one,
 * which is what makes a commit attributable to the agent that made it rather
 * than to whichever process happened to run. `--author` is host-owned, so it
 * arrives on `context.global`, never on `context.options`.
 *
 * @param context - The host-supplied command context.
 * @param now - Timestamp to record.
 * @returns The signature.
 */
export function signatureFor(context: CommandHandlerContext, now: Date): Signature {
  const declared = context.global?.author?.trim();
  const identity = declared && declared.length > 0 ? declared : "pm-vcs";
  // `Name <email>` when the author supplied one, otherwise a synthetic address
  // that still round-trips through the signature encoder.
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(identity);
  return {
    name: match ? match[1] : identity,
    email: match ? match[2] : `${identity.replace(/[^A-Za-z0-9._-]+/g, "-")}@pm-vcs.local`,
    timestamp: now.getTime(),
    timezoneOffsetMinutes: -now.getTimezoneOffset(),
  };
}

/**
 * Requires a positional argument.
 *
 * @param context - The host-supplied command context.
 * @param index - Zero-based position.
 * @param name - Argument name, for the error message.
 * @param remediation - What the caller should do instead.
 * @returns The trimmed value.
 * @throws VcsError When the argument is absent or blank.
 */
function requiredArgument(
  context: CommandHandlerContext,
  index: number,
  name: string,
  remediation: string,
): string {
  const raw = context.args[index];
  if (raw === undefined || raw.trim() === "") {
    throw new VcsError("missing_argument", `${context.command} requires a ${name}.`, remediation);
  }
  return raw.trim();
}

/** Shape a ref list is reported in. */
interface BranchListing {
  readonly name: string;
  readonly target: ObjectId;
  readonly current: boolean;
}

/**
 * Renders refs for output, marking which one HEAD is on.
 *
 * @param refs - The refs to render.
 * @param prefix - Prefix to strip from each name.
 * @param currentRef - The ref HEAD points at, when it points at one.
 * @returns The listing.
 */
function listing(refs: readonly RefEntry[], prefix: string, currentRef: string | null): BranchListing[] {
  return refs.map((ref) => ({
    name: ref.name.slice(prefix.length),
    target: ref.target,
    current: ref.name === currentRef,
  }));
}

/**
 * Registers every `pm vcs` command that operates on a pm-vcs repository.
 *
 * @param api - The host-supplied extension API.
 */
export function registerVcsCommands(api: ExtensionApi): void {
  api.registerCommand({
    name: "vcs init",
    description:
      "Create a pm-vcs repository in the current project: a content-addressed object store, refs, an index and an operation log. Declares which paths hold structured records, so those merge field by field instead of line by line.",
    flags: [
      { long: "--branch", value_name: "name", description: `Name of the initial branch (default ${DEFAULT_BRANCH})`, value_type: "string" },
      {
        long: "--record-path",
        value_name: "globs",
        description: "Comma-separated globs for paths whose content is a structured record, for example '.agents/pm/**/*.toon'",
        value_type: "string",
      },
      {
        long: "--set-field",
        value_name: "pairs",
        description: `Comma-separated field:strategy pairs controlling how record fields merge; strategy is ${FIELD_STRATEGIES.join(", ")}`,
        value_type: "string",
      },
    ],
    run(context: CommandHandlerContext): VcsEnvelope & { repository: { root: string; branch: string; config: RepositoryConfig } } {
      const root = sourceWorkingRoot(context);
      const branch = optionalString(context.options, "branch") ?? DEFAULT_BRANCH;
      const fields: Record<string, FieldStrategy> = {};
      for (const pair of commaSeparated(context.options, "setField")) {
        const colon = pair.lastIndexOf(":");
        const strategy = colon === -1 ? "" : pair.slice(colon + 1);
        if (!(FIELD_STRATEGIES as readonly string[]).includes(strategy)) {
          throw new VcsError(
            "invalid_option",
            `--set-field entry "${pair}" does not name a strategy.`,
            `Use field:strategy, where strategy is ${FIELD_STRATEGIES.join(", ")}.`,
          );
        }
        const field = pair.slice(0, colon);
        if (field.length === 0) {
          throw new VcsError(
            "invalid_option",
            `--set-field entry "${pair}" names no field.`,
            "Use field:strategy, where field is the record field the strategy applies to.",
          );
        }
        fields[field] = strategy as FieldStrategy;
      }
      const recordPaths = commaSeparated(context.options, "recordPath");
      const config: RepositoryConfig = recordPaths.length === 0 && Object.keys(fields).length === 0
        ? DEFAULT_CONFIG
        : { recordPaths, recordPolicy: { fields } };
      const repository = Repository.init(root, branch, config);
      return { ok: true, repository: { root: repository.root, branch, config: repository.config } };
    },
  });

  api.registerCommand({
    name: "vcs status",
    description:
      "Report what is staged, what is changed but not staged, and what is untracked, as the three-way difference between HEAD, the index and the working tree.",
    run(context: CommandHandlerContext): VcsEnvelope & { status: StatusReport; head: string | null; branch: string | null } {
      const repository = openRepository(context);
      const head = repository.refs.readHead();
      return {
        ok: true,
        status: repository.status(),
        head: head.target,
        branch: head.kind === "branch" ? head.ref.slice(BRANCH_PREFIX.length) : null,
      };
    },
  });

  api.registerCommand({
    name: "vcs add",
    description:
      "Stage working-tree paths, or everything when no path is given. A path that no longer exists is staged as a deletion.",
    arguments: [{ name: "paths", description: "Paths to stage; omit to stage everything", required: false, variadic: true }],
    run(context: CommandHandlerContext): VcsEnvelope & { staged: readonly string[] } {
      const repository = openRepository(context);
      return { ok: true, staged: repository.stage(context.args) };
    },
  });

  api.registerCommand({
    name: "vcs commit",
    description: "Record the index as a commit on the current branch.",
    flags: [
      { long: "--message", value_name: "text", description: "Commit message", value_type: "string" },
      { long: "--allow-empty", description: "Record a commit even when nothing staged differs from HEAD", value_type: "boolean" },
      { long: "--item", value_name: "ids", description: "Comma-separated PM item ids to associate with this immutable change", value_type: "string" },
    ],
    async run(context: CommandHandlerContext): Promise<VcsEnvelope & { commit: ObjectId; items: readonly string[] }> {
      const repository = openRepository(context);
      const message = optionalString(context.options, "message");
      if (message === undefined) {
        throw new VcsError(
          "missing_message",
          "pm vcs commit requires a message.",
          "Pass --message \"what changed and why\".",
        );
      }
      const items = commaSeparated(context.options, "item");
      for (const item of items) await pmClient(context).get(item, { fields: "id" });
      const now = new Date();
      const commit = repository.commit({
        // `optionalString` trims, so the message never arrives newline-terminated
        // and the terminator is always ours to add.
        message: `${message}\n`,
        author: signatureFor(context, now),
        allowEmpty: context.options?.allowEmpty === true,
        items,
      }, now);
      return { ok: true, commit, items };
    },
  });

  api.registerCommand({
    name: "vcs trace",
    description: "Trace a logical file across moves, copies, edits and deletion using immutable file and change identities.",
    arguments: [{ name: "path-or-file-id", description: "Current or historical path, or a 32-hex FileId", required: true }],
    run(context: CommandHandlerContext): VcsEnvelope & { fileId: string; changes: readonly FileChangeTrace[] } {
      const repository = openRepository(context);
      const selector = requiredArgument(context, 0, "path-or-file-id", "Pass a repository-relative path or FileId.");
      const commitsNewestFirst = orderCommitsNewestFirst(repository.objects, repository.allReachable());
      const treeCache = new Map<ObjectId | null, ReturnType<typeof flattenTree>>();
      const fileId = resolveFileId(repository.objects, commitsNewestFirst, selector, treeCache);
      if (fileId === null) {
        throw new VcsError("unknown_file", `No identity is recorded for ${selector}.`, "Stage and commit the file with this pm-vcs version, or pass a known FileId.");
      }
      return { ok: true, fileId, changes: traceFile(repository.objects, commitsNewestFirst, fileId, treeCache) };
    },
  });

  api.registerCommand({
    name: "vcs items",
    description: "Resolve a native revision range to PM items explicitly associated with its commits or linked to files it changed.",
    arguments: [{ name: "from..to", description: "Native revision range (default: every commit reachable from HEAD)", required: false }],
    async run(context: CommandHandlerContext): Promise<VcsEnvelope & { commits: readonly ObjectId[]; items: readonly string[] }> {
      const repository = openRepository(context);
      const range = context.args[0]?.trim();
      let history: Set<ObjectId>;
      let commits: Set<ObjectId>;
      if (range === undefined) {
        history = reachable(repository.objects, repository.resolve("HEAD"));
        commits = history;
      } else {
        const match = /^(.+)\.\.(.+)$/.exec(range);
        if (match === null) {
          throw new VcsError("invalid_range", `Native revision range ${range} is invalid.`, "Pass revisions as <from>..<to>, for example main..feature.");
        }
        history = reachable(repository.objects, repository.resolve(match[2] as string));
        const excluded = reachable(repository.objects, repository.resolve(match[1] as string));
        commits = new Set([...history].filter((commit) => !excluded.has(commit)));
      }
      const historyNewestFirst = orderCommitsNewestFirst(repository.objects, [...history]);
      const items = new Set<string>();
      for (const commitId of commits) {
        for (const item of readCommit(repository.objects, commitId).items ?? []) items.add(item);
      }
      const client = pmClient(context);
      const listed = await client.list({ status: "all", compact: false, full: true, noTruncate: true, strictRead: true });
      const treeCache = new Map<ObjectId | null, ReturnType<typeof flattenTree>>();
      for (const listedItem of listed.items as ItemMetadata[]) {
        for (const linked of listedItem.files ?? []) {
          const fileId = resolveFileId(repository.objects, historyNewestFirst, linked.path.replace(/^\.\//, ""), treeCache);
          if (fileId === null) continue;
          if (traceFile(repository.objects, historyNewestFirst, fileId, treeCache).some((trace) => commits.has(trace.commit))) {
            items.add(listedItem.id);
          }
        }
      }
      return {
        ok: true,
        commits: [...commits].sort(compareByteOrder),
        items: [...items].sort(compareByteOrder),
      };
    },
  });

  api.registerCommand({
    name: "vcs files",
    description: "Resolve a PM item's linked arbitrary files to stable identities and native pm-vcs changes.",
    arguments: [{ name: "item-id", description: "PM item whose linked files should be traced", required: true }],
    async run(context: CommandHandlerContext): Promise<VcsEnvelope & { item: string; files: ReadonlyArray<{ path: string; fileId: string | null; changes: readonly FileChangeTrace[] }> }> {
      const repository = openRepository(context);
      const item = requiredArgument(context, 0, "item-id", "Pass the PM item whose file history you need.");
      const result = await pmClient(context).get(item, { full: true });
      const commitsNewestFirst = orderCommitsNewestFirst(repository.objects, repository.allReachable());
      const treeCache = new Map<ObjectId | null, ReturnType<typeof flattenTree>>();
      const files = linkedFiles(result).map((linked) => {
        const path = linked.path.replace(/^\.\//, "");
        const fileId = resolveFileId(repository.objects, commitsNewestFirst, path, treeCache);
        return { path, fileId, changes: fileId === null ? [] : traceFile(repository.objects, commitsNewestFirst, fileId, treeCache) };
      });
      return { ok: true, item, files };
    },
  });

  api.registerCommand({
    name: "vcs changes",
    description: "Report stable native change identities explicitly associated with a PM item or touching its linked files.",
    arguments: [{ name: "item-id", description: "PM item to resolve", required: true }],
    async run(context: CommandHandlerContext): Promise<VcsEnvelope & { item: string; changes: readonly ObjectId[] }> {
      const repository = openRepository(context);
      const item = requiredArgument(context, 0, "item-id", "Pass the PM item whose changes you need.");
      const result = await pmClient(context).get(item, { full: true });
      const commitsNewestFirst = orderCommitsNewestFirst(repository.objects, repository.allReachable());
      const changes = new Set<ObjectId>();
      for (const commitId of commitsNewestFirst) {
        const commit = readCommit(repository.objects, commitId);
        if (commit.items?.includes(item) === true) changes.add(effectiveChangeId(commitId, commit));
      }
      const treeCache = new Map<ObjectId | null, ReturnType<typeof flattenTree>>();
      for (const linked of linkedFiles(result)) {
        const fileId = resolveFileId(repository.objects, commitsNewestFirst, linked.path.replace(/^\.\//, ""), treeCache);
        if (fileId !== null) for (const trace of traceFile(repository.objects, commitsNewestFirst, fileId, treeCache)) changes.add(trace.changeId);
      }
      return { ok: true, item, changes: [...changes].sort(compareByteOrder) };
    },
  });

  api.registerCommand({
    name: "vcs log",
    description:
      "Walk first-parent history from a revision, newest first, so the output reads as the changes that landed on this branch rather than as every branch interleaved.",
    arguments: [{ name: "revision", description: "Where to start (default HEAD)", required: false }],
    flags: [
      { long: "--limit", value_name: "count", description: "Maximum commits to report (default 20)", value_type: "string" },
      { long: "--change-ids", description: "Include each commit's stable change id in the output", value_type: "boolean" },
    ],
    run(context: CommandHandlerContext): VcsEnvelope & {
      commits: ReadonlyArray<{ id: ObjectId; changeId?: ObjectId; message: string; author: string; at: string; parents: readonly ObjectId[] }>;
    } {
      const repository = openRepository(context);
      const includeChangeIds = context.options?.changeIds === true;
      const entries = repository.log(context.args[0]?.trim() || "HEAD", positiveInteger(context.options, "limit", 20));
      return {
        ok: true,
        commits: entries.map((entry) => ({
          id: entry.id,
          // The change id is the stable identity a rebase or squash preserves;
          // including it only on request keeps the default output focused on
          // what landed and when.
          ...(includeChangeIds ? { changeId: entry.changeId } : {}),
          message: entry.commit.message.trimEnd(),
          author: `${entry.commit.author.name} <${entry.commit.author.email}>`,
          at: new Date(entry.commit.author.timestamp).toISOString(),
          parents: entry.commit.parents,
        })),
      };
    },
  });

  api.registerCommand({
    name: "vcs diff",
    description: "Unified diff between two revisions' trees. Defaults to comparing HEAD's parent with HEAD.",
    arguments: [
      { name: "from", description: "Left revision (default HEAD~ equivalent: HEAD's first parent)", required: false },
      { name: "to", description: "Right revision (default HEAD)", required: false },
    ],
    run(context: CommandHandlerContext): VcsEnvelope & { diff: string } {
      const repository = openRepository(context);
      // Positional order follows the declared arguments, `[from] [to]`. One
      // argument therefore means "this revision against HEAD" — reading a lone
      // argument as the *right* side instead would make `pm vcs diff main` show
      // main against its own parent, which is neither what the argument is named
      // nor what anyone would expect.
      // A blank argument is treated as absent, matching `vcs log`: a caller that
      // interpolated an empty variable meant "no revision", and resolving "" would
      // fail with a message about an unknown revision named nothing.
      const from = context.args[0]?.trim() || undefined;
      const to = context.args[1]?.trim() || "HEAD";
      // With no arguments at all there is no left side to name, so it defaults to
      // HEAD's first parent. A root commit has none; comparing HEAD with itself
      // yields an empty diff, which is the honest answer to "what changed here".
      const left = from ?? repository.log(to, 2)[1]?.id ?? to;
      return { ok: true, diff: repository.diff(left, to) };
    },
  });

  api.registerCommand({
    name: "vcs branch",
    description: "List branches, or create one at a revision, or delete one.",
    arguments: [{ name: "name", description: "Branch to create or delete; omit to list", required: false }],
    flags: [
      { long: "--at", value_name: "revision", description: "Where a created branch should point (default HEAD)", value_type: "string" },
      { long: "--delete", description: "Delete the named branch instead of creating it", value_type: "boolean" },
    ],
    run(context: CommandHandlerContext): VcsEnvelope & { branches?: BranchListing[]; created?: ObjectId; deleted?: string } {
      const repository = openRepository(context);
      const name = context.args[0]?.trim();
      const head = repository.refs.readHead();
      if (name === undefined || name === "") {
        return {
          ok: true,
          branches: listing(
            repository.refs.list(BRANCH_PREFIX),
            BRANCH_PREFIX,
            head.kind === "branch" ? head.ref : null,
          ),
        };
      }
      const now = new Date();
      if (context.options?.delete === true) {
        repository.deleteBranch(name, now);
        return { ok: true, deleted: name };
      }
      return {
        ok: true,
        created: repository.createBranch(name, optionalString(context.options, "at") ?? "HEAD", now),
      };
    },
  });

  api.registerCommand({
    name: "vcs switch",
    description:
      "Move HEAD to a branch, or to any revision with HEAD detached, and update the working tree. Refuses before writing anything when the switch would overwrite uncommitted changes.",
    arguments: [{ name: "revision", description: "Branch or revision to switch to", required: true }],
    run(context: CommandHandlerContext): VcsEnvelope & { head: ObjectId } {
      const repository = openRepository(context);
      const revision = requiredArgument(context, 0, "revision", "Pass a branch name or a commit id.");
      return { ok: true, head: repository.switchTo(revision, new Date()) };
    },
  });

  api.registerCommand({
    name: "vcs merge",
    description:
      "Merge a revision into HEAD. Fast-forwards when there is nothing to reconcile; otherwise merges every path three-way against a correctly computed merge base, per field for record paths and by diff3 for everything else.",
    arguments: [{ name: "revision", description: "Revision to merge into HEAD", required: true }],
    flags: [
      { long: "--message", value_name: "text", description: "Message for the merge commit", value_type: "string" },
      { long: "--fail-on-conflict", description: "Exit non-zero when the merge leaves any conflict", value_type: "boolean" },
    ],
    run(context: CommandHandlerContext): VcsEnvelope & { merge: MergeReport } {
      const repository = openRepository(context);
      const revision = requiredArgument(context, 0, "revision", "Pass the branch or commit you intend to merge.");
      const now = new Date();
      const message = optionalString(context.options, "message") ?? `Merge ${revision}`;
      const merge = repository.merge(revision, {
        // `optionalString` trims and the default is a literal, so the message
        // never arrives newline-terminated.
        message: `${message}\n`,
        author: signatureFor(context, now),
      }, now);
      // The merge itself has already been recorded, conflicts and all, so the
      // gate throws only after the repository is in a consistent state — an
      // agent can inspect and resolve exactly what a clean run would have left.
      if (!merge.clean && context.options?.failOnConflict === true) {
        throw new VcsError(
          "merge_conflicts",
          `Merging ${revision} left ${merge.conflicts.length} conflict(s): `
          + merge.conflicts.map((conflict) => (
            conflict.fields ? `${conflict.path} (${conflict.fields.join(", ")})` : conflict.path
          )).join(", "),
          "Resolve the listed paths, stage them, and commit; or run `pm vcs undo` to abandon the merge.",
        );
      }
      return { ok: merge.clean, merge };
    },
  });

  api.registerCommand({
    name: "vcs undo",
    description:
      "Reverse a recorded operation, restoring every ref it moved and re-materializing the working tree. Objects are never removed, so any operation stays reversible.",
    flags: [{ long: "--operation", value_name: "number", description: "Which operation to reverse (default the most recent)", value_type: "string" }],
    run(context: CommandHandlerContext): VcsEnvelope & { undo: Operation } {
      const repository = openRepository(context);
      const requested = optionalString(context.options, "operation");
      return {
        ok: true,
        undo: repository.undo(requested === undefined ? null : positiveInteger(context.options, "operation", 1), new Date()),
      };
    },
  });

  api.registerCommand({
    name: "vcs oplog",
    description: "List recorded operations, newest first, with the refs each one moved and where they moved from.",
    flags: [{ long: "--limit", value_name: "count", description: "Maximum operations to report (default 20)", value_type: "string" }],
    run(context: CommandHandlerContext): VcsEnvelope & { operations: readonly Operation[] } {
      const repository = openRepository(context);
      const limit = positiveInteger(context.options, "limit", 20);
      return { ok: true, operations: repository.operations.read().reverse().slice(0, limit) };
    },
  });

  api.registerCommand({
    name: "vcs export",
    description:
      "Write refs and their history to a bundle file: one text file carrying every object the refs reach, which another repository can import to reproduce identical commit ids.",
    arguments: [{ name: "file", description: "Bundle file to write", required: true }],
    flags: [
      { long: "--ref", value_name: "names", description: "Comma-separated full ref names to export (default every branch and tag)", value_type: "string" },
      { long: "--since", value_name: "revisions", description: "Comma-separated revisions the receiver already has, excluded from the bundle and recorded as prerequisites", value_type: "string" },
    ],
    run(context: CommandHandlerContext): VcsEnvelope & { bundle: { file: string; bytes: number } } {
      const repository = openRepository(context);
      const file = resolve(requiredArgument(context, 0, "file", "Pass the path to write the bundle to."));
      const bytes = exportBundle(
        repository.objects,
        repository.refs,
        commaSeparated(context.options, "ref"),
        commaSeparated(context.options, "since").map((revision) => repository.resolve(revision)),
      );
      writeFileSync(file, bytes);
      return { ok: true, bundle: { file, bytes: bytes.length } };
    },
  });

  api.registerCommand({
    name: "vcs import",
    description:
      "Import a bundle. Every object is verified against its own id before being stored, and a bundle depending on absent history fails whole rather than leaving commits whose parents are missing.",
    arguments: [{ name: "file", description: "Bundle file to import", required: true }],
    run(context: CommandHandlerContext): VcsEnvelope & { import: ImportReport } {
      const repository = openRepository(context);
      const file = resolve(requiredArgument(context, 0, "file", "Pass the path of the bundle to import."));
      return { ok: true, import: importBundle(repository.objects, repository.refs, readBundle(file)) };
    },
  });

  api.registerCommand({
    name: "vcs remote",
    description:
      "List the repositories this one exchanges history with, add one, or remove one. A remote is local knowledge, not part of the history, so adding one changes nothing another clone will ever see.",
    arguments: [
      { name: "name", description: "Remote to add or remove; omit to list", required: false },
      { name: "url", description: "Where it lives: a filesystem path or a file: URL", required: false },
    ],
    flags: [{ long: "--remove", description: "Remove the named remote instead of adding one", value_type: "boolean" }],
    run(context: CommandHandlerContext): VcsEnvelope & { remotes?: readonly Remote[]; added?: Remote; removed?: string } {
      const repository = openRepository(context);
      const name = context.args[0]?.trim();
      if (name === undefined || name === "") return { ok: true, remotes: repository.remotes.list() };
      if (context.options?.remove === true) {
        repository.remotes.remove(name);
        return { ok: true, removed: name };
      }
      const url = context.args[1]?.trim();
      if (url === undefined || url === "") {
        throw new VcsError(
          "missing_remote_url",
          `Adding the remote ${name} needs a location.`,
          "Pass a filesystem path or file: URL as the second argument, or add --remove to delete the remote.",
        );
      }
      // Resolved before it is stored, for the same reason `clone` resolves: the
      // value persists, and a relative one names a different directory depending
      // on where it is read from. `fetch` would later resolve it against the
      // repository root while the agent typed it against the working root. This
      // is also where an unsupported scheme is refused -- otherwise `https://…`
      // is accepted here and fails at the first fetch, naming the fetch.
      return { ok: true, added: repository.remotes.add(name, resolveRemoteLocation(url, sourceWorkingRoot(context))) };
    },
  });

  api.registerCommand({
    name: "vcs fetch",
    description:
      "Bring a remote's branches onto tracking refs under refs/remotes/, transferring only the objects this repository is missing. No local branch is touched, so a fetch can never discard work that has not been pushed.",
    arguments: [{ name: "remote", description: "Remote to fetch from (default origin)", required: false }],
    run(context: CommandHandlerContext): VcsEnvelope & { fetch: FetchReport } {
      const repository = openRepository(context);
      const remote = context.args[0]?.trim();
      return { ok: true, fetch: fetchFrom(repository, remote === undefined || remote === "" ? "origin" : remote, new Date()) };
    },
  });

  api.registerCommand({
    name: "vcs push",
    description:
      "Send local branches to a remote. A move that is not a fast-forward is refused, because it would discard commits the remote has and this repository has not seen; every ref lands as a compare-and-swap so a concurrent pusher cannot be overwritten.",
    arguments: [{ name: "remote", description: "Remote to push to (default origin)", required: false }],
    flags: [
      { long: "--branch", value_name: "names", description: "Comma-separated branches to push (default the branch HEAD is on)", value_type: "string" },
      { long: "--force", description: "Allow a push that discards commits the remote has", value_type: "boolean" },
    ],
    run(context: CommandHandlerContext): VcsEnvelope & { push: PushReport } {
      const repository = openRepository(context);
      const remote = context.args[0]?.trim();
      return {
        ok: true,
        push: pushTo(
          repository,
          remote === undefined || remote === "" ? "origin" : remote,
          commaSeparated(context.options, "branch"),
          context.options?.force === true,
          new Date(),
        ),
      };
    },
  });

  api.registerCommand({
    name: "vcs clone",
    description:
      "Create a repository from another one: adopt its record configuration, fetch every branch onto tracking refs, and check out the branch its HEAD names. The configuration is adopted first, so the clone stores and merges the same paths the same way rather than treating records as plain text.",
    arguments: [
      { name: "url", description: "Where to clone from: a filesystem path or a file: URL", required: true },
      { name: "directory", description: "Where to put the clone (default a directory named after the source)", required: false },
    ],
    flags: [{ long: "--remote", value_name: "name", description: "Name to register the source under (default origin)", value_type: "string" }],
    run(context: CommandHandlerContext): VcsEnvelope & { clone: CloneReport } {
      const url = requiredArgument(context, 0, "url", "Pass the path or file: URL of the repository to clone.");
      const requested = context.args[1]?.trim();
      // One base for both sides of the command. Resolving the destination against
      // the working root while the source resolved against `process.cwd()` would
      // read `../source` and write `./clone` from two different directories
      // whenever the two differ, which is exactly when `--path` was passed.
      const workingRoot = sourceWorkingRoot(context);
      const destination = requested === undefined || requested === ""
        ? resolve(workingRoot, basename(url.replace(/\/+$/, "")))
        : resolve(workingRoot, requested);
      return {
        ok: true,
        clone: cloneFrom(url, destination, new Date(), optionalString(context.options, "remote") ?? "origin", workingRoot),
      };
    },
  });

  api.registerCommand({
    name: "vcs tag",
    description: "List tags, or create one at a revision.",
    arguments: [{ name: "name", description: "Tag to create; omit to list", required: false }],
    flags: [{ long: "--at", value_name: "revision", description: "Where the tag should point (default HEAD)", value_type: "string" }],
    run(context: CommandHandlerContext): VcsEnvelope & { tags?: BranchListing[]; created?: ObjectId } {
      const repository = openRepository(context);
      const name = context.args[0]?.trim();
      if (name === undefined || name === "") {
        return { ok: true, tags: listing(repository.refs.list(TAG_PREFIX), TAG_PREFIX, null) };
      }
      const target = repository.resolve(optionalString(context.options, "at") ?? "HEAD");
      repository.refs.compareAndSwap(`${TAG_PREFIX}${name}`, null, target);
      return { ok: true, created: target };
    },
  });

  api.registerCommand({
    name: "vcs describe",
    description: "Replace one commit's message, preserving its change id and replaying every descendant so no branch is orphaned.",
    arguments: [{ name: "revision", description: "The commit to reword", required: true }],
    flags: [{ long: "--message", value_name: "text", description: "The new commit message", value_type: "string" }],
    run(context: CommandHandlerContext): VcsEnvelope & { head: ObjectId | null } {
      const repository = openRepository(context);
      const revision = requiredArgument(context, 0, "revision", "Pass the commit to describe, for example HEAD or a commit id.");
      const message = optionalString(context.options, "message");
      if (message === undefined) {
        throw new VcsError("missing_message", "pm vcs describe requires a message.", 'Pass --message "the new message".');
      }
      const now = new Date();
      return { ok: true, head: repository.describe(revision, `${message}\n`, signatureFor(context, now), now) };
    },
  });

  api.registerCommand({
    name: "vcs rebase",
    description: "Replay source's side of the divergence onto another revision, merging per field for records and preserving change ids across the replay.",
    arguments: [{ name: "source", description: "The tip whose commits are replayed", required: true }],
    flags: [{ long: "--onto", value_name: "revision", description: "The tip the range is replayed onto", value_type: "string" }],
    run(context: CommandHandlerContext): VcsEnvelope & { head: ObjectId | null } {
      const repository = openRepository(context);
      const source = requiredArgument(context, 0, "source", "Pass the branch or commit whose commits should be replayed.");
      const onto = optionalString(context.options, "onto");
      if (onto === undefined) {
        throw new VcsError("missing_argument", "pm vcs rebase requires --onto.", "Pass --onto <revision> naming where the range should land.");
      }
      const now = new Date();
      return { ok: true, head: repository.rebase(source, onto, signatureFor(context, now), now) };
    },
  });

  api.registerCommand({
    name: "vcs squash",
    description: "Fold a commit into its first parent. The survivor carries the combined tree and both messages joined by a blank line, and keeps the parent's change id.",
    arguments: [{ name: "revision", description: "The commit to fold into its first parent", required: true }],
    run(context: CommandHandlerContext): VcsEnvelope & { head: ObjectId | null } {
      const repository = openRepository(context);
      const revision = requiredArgument(context, 0, "revision", "Pass the commit to squash into its first parent.");
      const now = new Date();
      return { ok: true, head: repository.squash(revision, signatureFor(context, now), now) };
    },
  });

  api.registerCommand({
    name: "vcs split",
    description: "Replace one commit with two: the first carrying only the changes to the named paths, the second the rest. Refuses when either side would be empty.",
    arguments: [
      { name: "revision", description: "The commit to split", required: true },
      { name: "paths", description: "Glob patterns for the paths the first half should carry", required: false, variadic: true },
    ],
    run(context: CommandHandlerContext): VcsEnvelope & { head: ObjectId | null } {
      const repository = openRepository(context);
      const revision = requiredArgument(context, 0, "revision", "Pass the commit to split.");
      const patterns = context.args.slice(1).map((arg) => arg.trim()).filter((arg) => arg.length > 0);
      if (patterns.length === 0) {
        throw new VcsError("missing_argument", "pm vcs split needs at least one path.", "Pass the paths the first half should carry, e.g. `pm vcs split HEAD src/**`.");
      }
      const now = new Date();
      return { ok: true, head: repository.split(revision, patterns, signatureFor(context, now), now) };
    },
  });

  api.registerCommand({
    name: "vcs cherry-pick",
    description: "Apply one commit's change onto HEAD as a new commit with a new change id and the original's message preserved.",
    arguments: [{ name: "revision", description: "The commit whose change to apply", required: true }],
    run(context: CommandHandlerContext): VcsEnvelope & { commit: ObjectId } {
      const repository = openRepository(context);
      const revision = requiredArgument(context, 0, "revision", "Pass the commit whose change should be applied.");
      const now = new Date();
      return { ok: true, commit: repository.cherryPick(revision, signatureFor(context, now), now) };
    },
  });

  api.registerCommand({
    name: "vcs revert",
    description: "Apply the inverse of one commit's change onto HEAD as a new commit, refusing cleanly when the inverse does not apply.",
    arguments: [{ name: "revision", description: "The commit to revert", required: true }],
    flags: [{ long: "--message", value_name: "text", description: "Message for the revert commit (default a generated one)", value_type: "string" }],
    run(context: CommandHandlerContext): VcsEnvelope & { commit: ObjectId } {
      const repository = openRepository(context);
      const revision = requiredArgument(context, 0, "revision", "Pass the commit to revert.");
      const now = new Date();
      const id = repository.resolve(revision);
      const firstLine = readCommit(repository.objects, id).message.trimEnd().split("\n")[0];
      const message = optionalString(context.options, "message") ?? `Revert ${id.slice(0, 12)}: ${firstLine}`;
      return { ok: true, commit: repository.revert(revision, `${message}\n`, signatureFor(context, now), now) };
    },
  });

  api.registerCommand({
    name: "vcs reset",
    description: "Move HEAD to a revision. --mode soft moves only the branch; mixed also rewrites the index; hard also rewrites the working tree. Objects are never deleted, so undo recovers.",
    arguments: [{ name: "revision", description: "Where HEAD should move", required: true }],
    flags: [{ long: "--mode", value_name: "mode", description: "How far to reset: soft, mixed or hard (default mixed)", value_type: "string" }],
    run(context: CommandHandlerContext): VcsEnvelope & { head: ObjectId } {
      const repository = openRepository(context);
      const revision = requiredArgument(context, 0, "revision", "Pass the revision to reset to.");
      const requested = optionalString(context.options, "mode");
      const mode: ResetMode = requested === "soft" || requested === "hard" ? requested : "mixed";
      if (requested !== undefined && mode !== requested) {
        throw new VcsError("invalid_option", `--mode accepts soft, mixed or hard, not "${requested}".`, "Pass --mode soft, --mode mixed or --mode hard.");
      }
      const now = new Date();
      return { ok: true, head: repository.reset(revision, mode, now) };
    },
  });

  api.registerCommand({
    name: "vcs restore",
    description: "Restore named paths in the index and working tree from a revision. A path absent from the revision is removed.",
    arguments: [
      { name: "revision", description: "The revision to restore from", required: true },
      { name: "paths", description: "Paths to restore; omit to restore everything the revision carries", required: false, variadic: true },
    ],
    run(context: CommandHandlerContext): VcsEnvelope & { restored: readonly string[] } {
      const repository = openRepository(context);
      const revision = requiredArgument(context, 0, "revision", "Pass the revision to restore from.");
      const explicit = context.args.slice(1).map((arg) => arg.trim()).filter((arg) => arg.length > 0);
      // No paths means every path the revision carries, so `restore <rev>` returns
      // the whole working tree to that revision's content for tracked files.
      const paths = explicit.length > 0
        ? explicit
        : [...flattenTree(repository.objects, readCommit(repository.objects, repository.resolve(revision)).tree).keys()].sort();
      return { ok: true, restored: repository.restore(paths, revision) };
    },
  });

  api.registerCommand({
    name: "vcs show",
    description: "Show a commit's metadata, including its change id, and the unified diff of its change against its first parent.",
    arguments: [{ name: "revision", description: "The commit to show (default HEAD)", required: false }],
    run(context: CommandHandlerContext): VcsEnvelope & {
      commit: {
        id: ObjectId;
        changeId: ObjectId;
        tree: ObjectId;
        parents: readonly ObjectId[];
        author: string;
        committer: string;
        at: string;
        message: string;
      };
      diff: string;
    } {
      const repository = openRepository(context);
      const revision = context.args[0]?.trim() || "HEAD";
      const id = repository.resolve(revision);
      const commit = readCommit(repository.objects, id);
      const parent = commit.parents[0];
      return {
        ok: true,
        commit: {
          id,
          changeId: effectiveChangeId(id, commit),
          tree: commit.tree,
          parents: commit.parents,
          author: `${commit.author.name} <${commit.author.email}>`,
          committer: `${commit.committer.name} <${commit.committer.email}>`,
          at: new Date(commit.author.timestamp).toISOString(),
          message: commit.message.trimEnd(),
        },
        diff: parent === undefined ? "" : repository.diff(parent, id),
      };
    },
  });

  api.registerCommand({
    name: "vcs verify",
    description:
      "Re-read every object reachable from any ref and check it against its own id. A content-addressed store's one unacceptable failure is returning altered content silently, so this makes that detectable on demand.",
    run(context: CommandHandlerContext): VcsEnvelope & { verified: number; corrupt: readonly string[] } {
      const repository = openRepository(context);
      const corrupt: string[] = [];
      let verified = 0;
      // Walk the full object closure from every ref, not only the commits: a
      // corrupted blob or tree is the corruption most likely to occur in
      // practice, and reading only commits (what allReachable yields) would miss
      // it entirely. Reading each object re-hashes it, which is the check.
      const seen = new Set<string>();
      const queue: string[] = [
        ...repository.refs.list(BRANCH_PREFIX),
        ...repository.refs.list(TAG_PREFIX),
      ].map((entry) => entry.target);
      while (queue.length > 0) {
        const id = queue.pop() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          const object = repository.objects.read(id);
          verified += 1;
          if (object.type === "commit") {
            const commit = decodeCommit(object.payload);
            queue.push(commit.tree, ...commit.parents);
          } else if (object.type === "tree") {
            for (const entry of decodeTree(object.payload)) queue.push(entry.id);
          }
        } catch (error) {
          // Only ObjectStoreError is caught. `read` raises nothing else, and
          // labelling an unexpected failure "unreadable" would report a bug in
          // this process as corruption in the user's repository.
          if (!(error instanceof ObjectStoreError)) throw error;
          corrupt.push(`${id}: ${error.code}`);
        }
      }
      if (corrupt.length > 0) {
        throw new VcsError(
          "corrupt_objects",
          `${corrupt.length} of ${corrupt.length + verified} reachable objects did not verify: ${corrupt.join("; ")}.`,
          "Re-import the affected history from a bundle or another copy of the repository.",
        );
      }
      return { ok: true, verified, corrupt };
    },
  });
}
