/**
 * The package's single git boundary.
 *
 * Every git invocation in pm-vcs goes through {@link runGit}, and every piece of
 * git output is turned into data by a pure parser in this module. Keeping the
 * process boundary in one place is what lets the rest of the package be plain
 * functions over plain data: `preflight`, `preview` and `ledger` never spawn
 * anything themselves.
 *
 * Two conventions matter for correctness and are applied consistently here:
 *
 * - **No shell.** Arguments are passed as an array to `spawnSync` with no shell,
 *   so a branch or path containing a space, quote or `$` cannot change the
 *   command that runs. Refs reach this module from user input.
 * - **NUL-delimited output wherever git offers it.** `-z` output for name
 *   listings, and a `%x00` field separator for log records. Git escapes and
 *   quotes paths containing newlines in its default output, which makes
 *   line-splitting silently lossy for exactly the paths hardest to notice.
 */

import { spawnSync } from "node:child_process";

/**
 * Wall-clock ceiling for a single git invocation.
 *
 * Every pm-vcs command is a short sequence of read-only git calls, so none of
 * them has a legitimate reason to take minutes. Without a ceiling a stuck
 * `index.lock`, an unreachable remote, or a credential helper that blocks would
 * hang the command an agent is waiting on, with no output and no way to tell a
 * hang from slow work.
 */
const GIT_TIMEOUT_MS = 120_000;

/** Outcome of one git invocation, with the exit status left for the caller to judge. */
export interface GitResult {
  /** Process exit status; `null` when the process was terminated by a signal. */
  readonly status: number | null;
  /** Captured stdout with no trailing-newline normalisation applied. */
  readonly stdout: string;
  /** Captured stderr, trimmed, suitable for embedding in an error message. */
  readonly stderr: string;
}

/**
 * A pm-vcs failure that carries a remediation, so every error an agent sees says
 * what to do next rather than only what went wrong.
 *
 * The remediation is deliberately folded into `message` as well as kept as its
 * own field. When an extension command handler throws, the host renders the
 * thrown `message` under "What happened" but replaces "What is required" with
 * its own generic line ("Adjust command input or tracker state and retry"), so a
 * remediation kept only in a separate field never reaches the caller. Appending
 * it to the message is the only way to get it in front of the agent that hit the
 * error. See unbraind/pm-cli#826.
 */
export class VcsError extends Error {
  /** Stable machine-readable reason code, safe to branch on. */
  readonly code: string;
  /** What the caller should do to make the command succeed. */
  readonly remediation: string;

  /**
   * @param code - Stable reason code, for example `not_a_git_repository`.
   * @param message - Human-readable description of what failed.
   * @param remediation - Concrete next step that resolves the failure.
   */
  constructor(code: string, message: string, remediation: string) {
    super(`${message} → ${remediation}`);
    this.name = "VcsError";
    this.code = code;
    this.remediation = remediation;
  }
}

/**
 * Runs git in `cwd` and captures its output without throwing.
 *
 * Used directly when a non-zero status is a meaningful answer rather than a
 * failure — `git rev-parse --verify` on a ref that may not exist, or
 * `git cat-file -e` on a blob that may be absent on one side of a merge. Use
 * {@link requireGit} when a non-zero status means the command cannot continue.
 *
 * @param args - Git arguments, passed with no shell interpretation.
 * @param cwd - Directory to run git in.
 * @param timeoutMs - Process ceiling; tests may lower it to exercise termination.
 * @returns The captured status, stdout and trimmed stderr.
 */
export function runGit(args: readonly string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): GitResult {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    // Tracker history streams and diff listings can be large; the default 1 MiB
    // ceiling truncates them into unparseable fragments, and spawnSync reports
    // that as an ENOBUFS error with empty output rather than as a short read.
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    // Keep git from consulting a pager or prompting for credentials: either
    // would hang a command an agent is waiting on.
    env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    // A timeout arrives as an ETIMEDOUT spawn error, which is a different
    // problem from git being absent and needs a different next step.
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new VcsError(
        "git_timed_out",
        `git ${args.join(" ")} did not finish within ${timeoutMs / 1000}s and was terminated.`,
        "Check for a stale .git/index.lock, an unreachable remote, or a credential helper waiting on input, then retry.",
      );
    }
    throw new VcsError(
      "git_unavailable",
      `Could not run git: ${result.error.message}`,
      "Install git and make sure it is on PATH.",
    );
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.trim() };
}

/**
 * Runs git and returns stdout, throwing a {@link VcsError} on a non-zero exit.
 *
 * @param args - Git arguments, passed with no shell interpretation.
 * @param cwd - Directory to run git in.
 * @param remediation - Next step offered to the caller if the command fails.
 * @returns Captured stdout.
 * @throws VcsError When git exits non-zero, with git's own stderr as the message.
 */
export function requireGit(args: readonly string[], cwd: string, remediation: string): string {
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    throw new VcsError(
      "git_command_failed",
      `git ${args.join(" ")} failed: ${result.stderr || `exit ${String(result.status)}`}`,
      remediation,
    );
  }
  return result.stdout;
}

/**
 * Resolves the root of the git working tree containing `cwd`.
 *
 * @param cwd - Directory to resolve from.
 * @returns The absolute working-tree root, or `null` outside a git repository.
 */
export function resolveRepoRoot(cwd: string): string | null {
  const result = runGit(["rev-parse", "--show-toplevel"], cwd);
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Resolves a ref to a commit object id.
 *
 * @param ref - Any revision git accepts (branch, tag, sha, `HEAD~2`).
 * @param cwd - Directory to run git in.
 * @returns The 40-character object id, or `null` when the ref does not resolve.
 */
export function resolveCommit(ref: string, cwd: string): string | null {
  // `--verify --quiet` distinguishes "no such ref" (exit 1, no output) from a
  // usage error, and `^{commit}` rejects a ref that resolves to a tree or tag
  // object, which would otherwise fail later inside a diff with a worse message.
  const result = runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Reads a blob's contents at a commit.
 *
 * A path absent at that commit is a normal, expected condition — it is how a
 * file added on only one side of a merge presents — so it returns `null` rather
 * than throwing.
 *
 * @param commit - Commit to read from.
 * @param repoRelativePath - POSIX path relative to the repository root.
 * @param cwd - Directory to run git in.
 * @returns The blob's contents, or `null` when the path does not exist there.
 */
export function readBlob(commit: string, repoRelativePath: string, cwd: string): string | null {
  const result = runGit(["show", `${commit}:${repoRelativePath}`], cwd);
  return result.status === 0 ? result.stdout : null;
}

/**
 * Lists the paths that differ between two commits.
 *
 * @param from - Base commit.
 * @param to - Target commit.
 * @param cwd - Directory to run git in.
 * @returns Repository-relative POSIX paths, in git's order.
 */
export function changedPaths(from: string, to: string, cwd: string): string[] {
  const raw = requireGit(
    ["diff", "--name-only", "-z", `${from}..${to}`],
    cwd,
    "Check that both commits exist in this repository.",
  );
  return splitNulList(raw);
}

/**
 * Splits git's `-z` NUL-delimited output into entries.
 *
 * @param raw - Raw stdout from a git command invoked with `-z`.
 * @returns Non-empty entries, with the trailing delimiter discarded.
 */
export function splitNulList(raw: string): string[] {
  return raw.split("\0").filter((entry) => entry !== "");
}

/** The merge driver git would apply to a path, as reported by `git check-attr`. */
export interface PathMergeAttribute {
  /** Repository-relative POSIX path that was queried. */
  readonly path: string;
  /**
   * Driver name from the `merge` attribute, or `null` when the path has none.
   *
   * `null` is the finding that matters: it means git would fall back to its
   * default line-based merge for a tracker artifact.
   */
  readonly driver: string | null;
}

/**
 * Asks git which merge driver it would apply to each path.
 *
 * This delegates `.gitattributes` pattern matching to git itself rather than
 * reimplementing it. Attribute resolution has real subtleties — precedence
 * between overlapping patterns, per-directory `.gitattributes` files,
 * `info/attributes` — and a second implementation would drift from the one that
 * actually decides the merge. The whole point of the preview and preflight
 * commands is to predict git's behaviour, so the prediction has to come from
 * git's own answer.
 *
 * @param paths - Repository-relative POSIX paths to query.
 * @param cwd - Directory to run git in.
 * @returns One entry per input path, in input order.
 */
export function mergeAttributes(paths: readonly string[], cwd: string): PathMergeAttribute[] {
  if (paths.length === 0) return [];
  const raw = requireGit(
    ["check-attr", "-z", "merge", "--", ...paths],
    cwd,
    "Check that the paths are inside this repository.",
  );
  return parseCheckAttr(raw, paths);
}

/**
 * Parses `git check-attr -z` output into per-path driver names.
 *
 * The `-z` form emits a flat NUL-delimited stream of `path, attribute, value`
 * triples. Values are the literal strings `unspecified`, `unset`, `set`, or a
 * driver name; only a driver name means a driver is configured for the path.
 *
 * @param raw - Raw stdout from `git check-attr -z merge -- <paths>`.
 * @param paths - The queried paths, used to preserve input order in the result.
 * @returns One entry per queried path.
 */
export function parseCheckAttr(raw: string, paths: readonly string[]): PathMergeAttribute[] {
  const fields = splitNulList(raw);
  const drivers = new Map<string, string>();
  for (let index = 0; index + 3 <= fields.length; index += 3) {
    const [path, , value] = fields.slice(index, index + 3);
    if (value !== "unspecified" && value !== "unset" && value !== "set") {
      drivers.set(path, value);
    }
  }
  return paths.map((path) => ({ path, driver: drivers.get(path) ?? null }));
}

/** One commit, as read from `git log`. */
export interface CommitRecord {
  /** Full commit object id. */
  readonly sha: string;
  /** Abbreviated object id, as git chose to abbreviate it. */
  readonly short: string;
  /** Author name. */
  readonly author: string;
  /** Author date in strict ISO 8601. */
  readonly date: string;
  /** First line of the commit message. */
  readonly subject: string;
  /** Repository-relative POSIX paths this commit changed, with change letters. */
  readonly changes: PathChange[];
}

/** One path a commit touched, with git's change letter. */
export interface PathChange {
  /** Git's status letter: `A` added, `M` modified, `D` deleted, `R`/`C` with a score. */
  readonly status: string;
  /** Repository-relative POSIX path. */
  readonly path: string;
}

/**
 * Field separator for log records.
 *
 * A literal NUL between fields, so no field value can contain the separator.
 * Commit subjects routinely contain every printable character, which rules out
 * the usual `|` or tab separators.
 */
const LOG_FIELD_SEPARATOR = "%x00";

/** `--format` argument shared by every log read, matching {@link parseLogRecords}. */
const LOG_FORMAT = ["%H", "%h", "%an", "%aI", "%s"].join(LOG_FIELD_SEPARATOR);

/**
 * Reads commits, with the paths each one changed.
 *
 * @param revisions - Revision arguments (`["main..HEAD"]`, `["--all"]`, ...).
 * @param cwd - Directory to run git in.
 * @returns Commits in git's order (newest first for a plain range).
 */
export function readCommits(revisions: readonly string[], cwd: string): CommitRecord[] {
  const args = [
    "log",
    `--format=%x01${LOG_FORMAT}`,
    "--name-status",
    // Report the change letters against the first parent for a merge commit
    // instead of collapsing to nothing, so a merge that carried item changes is
    // attributed rather than silently dropped from an item's history.
    "--first-parent",
    "-z",
    ...revisions,
  ];
  const raw = requireGit(args, cwd, "Check that the revision range and paths are valid.");
  return parseLogRecords(raw);
}

/**
 * Parses the NUL-delimited `git log --name-status -z` stream.
 *
 * Records are introduced by a `\x01` sentinel emitted at the start of the
 * format string, which is what makes the boundary between one commit's path
 * list and the next commit's header unambiguous in a flat NUL stream.
 *
 * @param raw - Raw stdout from {@link readCommits}'s log invocation.
 * @returns One record per commit, in stream order.
 */
export function parseLogRecords(raw: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const chunk of raw.split("\x01")) {
    if (chunk === "") continue;
    const fields = chunk.split("\0");
    // A truncated read (a killed pager, a full pipe) can end mid-record; a
    // partial record is skipped rather than reported with blank fields.
    if (fields.length < 5) continue;
    const [sha, short, author, date, subject] = fields;
    records.push({
      sha,
      short,
      author,
      date,
      subject,
      changes: parsePathChanges(fields.slice(5)),
    });
  }
  return records;
}

/**
 * Turns the tail of a `-z` log record into path changes.
 *
 * In `-z` mode git emits a status letter and its path as two separate entries,
 * except for renames and copies (`R100`, `C75`), which emit the letter followed
 * by *two* paths (source then destination). The destination is the one that
 * exists after the commit, so that is what is reported.
 *
 * Status entries are trimmed because git separates a record's formatted header
 * from its first name-status entry with a **newline**, not a NUL. Without the
 * trim the first changed path of every commit carries a status of `"\nA"`, which
 * fails a `startsWith("A")` test and silently reports a newly added file as
 * modified — a wrong answer rather than an error, in exactly the field a
 * changelog reads.
 *
 * @param entries - NUL-split entries following a record's formatted fields.
 * @returns One change per path, skipping the empty trailing entry.
 */
export function parsePathChanges(entries: readonly string[]): PathChange[] {
  const changes: PathChange[] = [];
  let index = 0;
  while (index < entries.length) {
    const status = entries[index]?.trim();
    if (status === undefined || status === "") {
      index += 1;
      continue;
    }
    const renameLike = status.startsWith("R") || status.startsWith("C");
    const pathIndex = renameLike ? index + 2 : index + 1;
    const path = entries[pathIndex];
    if (path === undefined) break;
    changes.push({ status, path });
    index = pathIndex + 1;
  }
  return changes;
}
