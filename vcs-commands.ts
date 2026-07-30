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
import { dirname, join, resolve } from "node:path";

import { VcsError } from "./git.ts";
import {
  type ImportReport,
  exportBundle,
  importBundle,
  readBundle,
} from "./engine/bundle.ts";
import { DEFAULT_CONFIG, type RepositoryConfig } from "./engine/config.ts";
import { type Signature } from "./engine/model.ts";
import { ObjectStoreError, type ObjectId } from "./engine/objects.ts";
import { type Operation } from "./engine/oplog.ts";
import {
  CONTROL_DIRECTORY,
  DEFAULT_BRANCH,
  type MergeReport,
  Repository,
} from "./engine/repo.ts";
import { BRANCH_PREFIX, type RefEntry, TAG_PREFIX } from "./engine/refs.ts";
import { type StatusReport } from "./engine/worktree.ts";
import type {
  CommandHandlerContext,
  ExtensionApi,
} from "@unbrained/pm-cli/sdk/authoring";

/** Envelope every command returns, carrying an explicit verdict. */
interface VcsEnvelope {
  readonly ok: boolean;
  readonly exit_code: number;
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
  const start = context.repo_root ?? context.pm_root;
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
        description: "Comma-separated field:strategy pairs controlling how record fields merge; strategy is scalar, set or sequence",
        value_type: "string",
      },
    ],
    run(context: CommandHandlerContext): VcsEnvelope & { repository: { root: string; branch: string; config: RepositoryConfig } } {
      const root = resolve(context.repo_root ?? context.pm_root);
      const branch = optionalString(context.options, "branch") ?? DEFAULT_BRANCH;
      const fields: Record<string, "scalar" | "set" | "sequence"> = {};
      for (const pair of commaSeparated(context.options, "setField")) {
        const colon = pair.lastIndexOf(":");
        const strategy = colon === -1 ? "" : pair.slice(colon + 1);
        if (strategy !== "scalar" && strategy !== "set" && strategy !== "sequence") {
          throw new VcsError(
            "invalid_option",
            `--set-field entry "${pair}" does not name a strategy.`,
            "Use field:strategy, where strategy is scalar, set or sequence.",
          );
        }
        fields[pair.slice(0, colon)] = strategy;
      }
      const recordPaths = commaSeparated(context.options, "recordPath");
      const config: RepositoryConfig = recordPaths.length === 0 && Object.keys(fields).length === 0
        ? DEFAULT_CONFIG
        : { recordPaths, recordPolicy: { fields } };
      const repository = Repository.init(root, branch, config);
      return { ok: true, exit_code: 0, repository: { root: repository.root, branch, config: repository.config } };
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
        exit_code: 0,
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
      return { ok: true, exit_code: 0, staged: repository.stage(context.args) };
    },
  });

  api.registerCommand({
    name: "vcs commit",
    description: "Record the index as a commit on the current branch.",
    flags: [
      { long: "--message", value_name: "text", description: "Commit message", value_type: "string" },
      { long: "--allow-empty", description: "Record a commit even when nothing staged differs from HEAD", value_type: "boolean" },
    ],
    run(context: CommandHandlerContext): VcsEnvelope & { commit: ObjectId } {
      const repository = openRepository(context);
      const message = optionalString(context.options, "message");
      if (message === undefined) {
        throw new VcsError(
          "missing_message",
          "pm vcs commit requires a message.",
          "Pass --message \"what changed and why\".",
        );
      }
      const now = new Date();
      const commit = repository.commit({
        message: message.endsWith("\n") ? message : `${message}\n`,
        author: signatureFor(context, now),
        allowEmpty: context.options?.allowEmpty === true,
      }, now);
      return { ok: true, exit_code: 0, commit };
    },
  });

  api.registerCommand({
    name: "vcs log",
    description:
      "Walk first-parent history from a revision, newest first, so the output reads as the changes that landed on this branch rather than as every branch interleaved.",
    arguments: [{ name: "revision", description: "Where to start (default HEAD)", required: false }],
    flags: [{ long: "--limit", value_name: "count", description: "Maximum commits to report (default 20)", value_type: "string" }],
    run(context: CommandHandlerContext): VcsEnvelope & {
      commits: ReadonlyArray<{ id: ObjectId; message: string; author: string; at: string; parents: readonly ObjectId[] }>;
    } {
      const repository = openRepository(context);
      const entries = repository.log(context.args[0]?.trim() || "HEAD", positiveInteger(context.options, "limit", 20));
      return {
        ok: true,
        exit_code: 0,
        commits: entries.map((entry) => ({
          id: entry.id,
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
      const to = context.args[1]?.trim() || context.args[0]?.trim() || "HEAD";
      const from = context.args[1] === undefined
        ? repository.log(to, 2)[1]?.id ?? to
        : (context.args[0] as string).trim();
      return { ok: true, exit_code: 0, diff: repository.diff(from, to) };
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
          exit_code: 0,
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
        return { ok: true, exit_code: 0, deleted: name };
      }
      return {
        ok: true,
        exit_code: 0,
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
      return { ok: true, exit_code: 0, head: repository.switchTo(revision, new Date()) };
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
        message: message.endsWith("\n") ? message : `${message}\n`,
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
      return { ok: merge.clean, exit_code: 0, merge };
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
        exit_code: 0,
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
      return { ok: true, exit_code: 0, operations: repository.operations.read().reverse().slice(0, limit) };
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
      return { ok: true, exit_code: 0, bundle: { file, bytes: bytes.length } };
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
      return { ok: true, exit_code: 0, import: importBundle(repository.objects, repository.refs, readBundle(file)) };
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
        return { ok: true, exit_code: 0, tags: listing(repository.refs.list(TAG_PREFIX), TAG_PREFIX, null) };
      }
      const target = repository.resolve(optionalString(context.options, "at") ?? "HEAD");
      repository.refs.compareAndSwap(`${TAG_PREFIX}${name}`, null, target);
      return { ok: true, exit_code: 0, created: target };
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
      for (const id of repository.allReachable()) {
        try {
          repository.objects.read(id);
          verified += 1;
        } catch (error) {
          corrupt.push(`${id}: ${error instanceof ObjectStoreError ? error.code : "unreadable"}`);
        }
      }
      if (corrupt.length > 0) {
        throw new VcsError(
          "corrupt_objects",
          `${corrupt.length} of ${corrupt.length + verified} reachable objects did not verify: ${corrupt.join("; ")}.`,
          "Re-import the affected history from a bundle or another copy of the repository.",
        );
      }
      return { ok: true, exit_code: 0, verified, corrupt };
    },
  });
}

