import { durability } from "./engine/durability.ts";
/** Native CLI operations for linked-test-driven bisect sessions. */
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { orderCommitsNewestFirst, resolveFileId } from "./engine/attribution.ts";
import { changeProvenance } from "./engine/annotate.ts";
import {
  bisectCandidates,
  bisectRemaining,
  bisectStepLimit,
  bisectVerdict,
  bisectVerdicts,
  clearBisectSession,
  declareBoundaries,
  decodeBisectSession,
  type BisectCandidate,
  type BisectOutcome,
  type BisectRunOutcome,
  type BisectSession,
  type BisectStep,
  type BisectVerdict,
  markBisectOutcome,
  readBisectSession,
  recoverBisectWorker,
  runBisect,
  selectBisectCandidate,
  writeBisectSession,
  withBisectLease,
} from "./engine/bisect.ts";
import { reachable } from "./engine/merge.ts";
import { compareByteOrder, readCommit } from "./engine/model.ts";
import { BRANCH_PREFIX } from "./engine/refs.ts";
import type { Repository } from "./engine/repo.ts";
import { flattenTree } from "./engine/worktree.ts";
import { VcsError } from "./git.ts";
import {
  type CommandHandlerContext,
  type ExtensionApi,
  type ItemMetadata,
  type TestRunResult,
} from "@unbrained/pm-cli/sdk";

import { openRepository, optionalString, pmClient, requiredArgument } from "./vcs-commands.ts";

/** Prefix that marks a PM comment as a recorded bisect session milestone. */
const BISECT_MARKER = "pm-vcs bisect ";

/** Milestone kinds written to PM history, in the order a session reaches them. */
const BISECT_MILESTONES = ["start", "step", "halted", "done", "reset"] as const;

/** Which boundary a resolved revision is. */
interface BisectWalk {
  readonly candidates: readonly BisectCandidate[];
  readonly remaining: number;
  readonly next: BisectCandidate | null;
  readonly verdict: BisectVerdict | undefined;
}

/** Compact listing of a session another agent recorded on PM history. */
interface BisectSessionListing {
  readonly session: string;
  readonly item: string;
  readonly status: BisectSession["status"];
  readonly good: string;
  readonly bad: string;
  readonly startedAt: string;
  readonly startedBy: string;
  readonly steps: number;
  readonly halted?: string;
  readonly verdict?: { readonly kind: BisectVerdict["kind"]; readonly change?: string };
}

/** The report every bisect subcommand returns, rendered as TOON or JSON by the host. */
interface BisectReport {
  readonly session: string;
  readonly item: string;
  readonly command?: string;
  readonly maxSteps: number;
  readonly status: BisectSession["status"];
  readonly halted?: string;
  readonly boundaries: { readonly good: { readonly revision?: string; readonly commit: string }; readonly bad: { readonly revision?: string; readonly commit: string } };
  readonly original: { readonly branch: string | null; readonly commit: string };
  readonly steps: readonly BisectStep[];
  readonly stepsTaken: number;
  readonly stepsOmitted: number;
  readonly remaining: number;
  readonly next: { readonly commit: string; readonly changeId: string } | null;
  readonly verdict?: BisectVerdictReport;
}

/** The first failing change with everything an agent needs to act on it. */
interface BisectVerdictReport {
  readonly kind: BisectVerdict["kind"];
  readonly change?: string;
  readonly commit?: string;
  readonly message?: string;
  readonly author?: string;
  readonly at?: string;
  readonly items: readonly string[];
  readonly itemsBoundary?: "shallow";
  readonly agentHarness?: string;
  readonly agentModel?: string;
  readonly unresolved: readonly BisectStep[];
}

/** The invocation's author, attributed to steps and recorded on PM history. */
function invocationAuthor(context: CommandHandlerContext): string {
  const declared = context.global?.author?.trim();
  return declared !== undefined && declared.length > 0 ? declared : "pm-vcs";
}

/** Resolve SDK trust provenance from hosted refs or files, without executing git. @internal */
export function bisectTestSourceRef(repository: Repository): string {
  const hosted = process.env.GITHUB_HEAD_REF?.trim() || process.env.GITHUB_REF_NAME?.trim();
  if (hosted && hosted !== "merge") return hosted;
  const native = `pm-vcs:${repository.identity()}`;
  const ceilings = process.env.GIT_CEILING_DIRECTORIES?.split(delimiter).map((path) => resolve(path)) ?? [];
  let directory = repository.root;
  for (;;) {
    try {
      const marker = join(directory, ".git");
      let gitDirectory = marker;
      if (!lstatSync(marker).isDirectory()) {
        const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(marker, "utf8"));
        if (pointer === null) return native;
        gitDirectory = resolve(directory, pointer[1]);
      }
      const head = /^ref: refs\/heads\/([^\r\n]+)\r?\n?$/.exec(readFileSync(join(gitDirectory, "HEAD"), "utf8"));
      return head?.[1] ?? native;
    } catch {
      // Missing or unreadable optional Git metadata cannot establish trust.
    }
    const parent = dirname(directory);
    if (parent === directory || ceilings.includes(parent)) return native;
    directory = parent;
  }
}

/**
 * Reads the active session, refusing the subcommands that need one.
 *
 * @param repository - Repository whose worktree state is read.
 * @param action - Subcommand being refused, for the message.
 * @returns The active session.
 * @throws VcsError When no session is underway or the stored one already concluded.
 */
function requireSession(repository: Repository, action: string): BisectSession {
  const session = readBisectSession(repository);
  if (session === null) {
    throw new VcsError(
      "no_bisect_session",
      `pm vcs bisect ${action} needs an active bisect session.`,
      "Start one with `pm vcs bisect start <good> <bad> --item <pm-item>`.",
    );
  }
  return session;
}

/**
 * Derives the walk a session currently implies: candidates, what is open, and the verdict when complete.
 *
 * Boundaries are re-resolved every time, so a session started against branch
 * names keeps working after the branch moves; a session pinned to commit ids
 * keeps its exact range.
 *
 * @param repository - Repository holding the boundary ancestry.
 * @param session - Session to derive the walk from.
 * @returns The walk, with a verdict only when nothing remains open.
 * @throws ObjectStoreError When a boundary no longer resolves or bounds no changes.
 */
function walkOf(repository: Repository, session: BisectSession): BisectWalk {
  const candidates = bisectCandidates(repository.objects, repository.resolve(session.good), repository.resolve(session.bad));
  const verdicts = bisectVerdicts(session.steps);
  const remaining = bisectRemaining(repository.objects, candidates, verdicts);
  return {
    candidates,
    remaining: remaining.size,
    next: remaining.size === 0 ? null : selectBisectCandidate(repository.objects, candidates, remaining),
    verdict: remaining.size === 0 ? session.verdict ?? bisectVerdict(repository.objects, candidates, verdicts) : undefined,
  };
}

/**
 * Resolves the PM items linked to the first failing change, explicit and file-derived.
 *
 * Explicit associations come from the change itself; an item whose linked file
 * identity changed in that change is reported too, because that is how the
 * culprit's owning item is discovered when nobody recorded the association.
 *
 * @param context - Host-supplied command context carrying the PM client.
 * @param repository - Repository holding the change.
 * @param commitId - The first failing change's commit.
 * @param explicit - Items explicitly associated with the change.
 * @returns The linked item ids, sorted.
 */
async function linkedItems(context: CommandHandlerContext, repository: Repository, commitId: string, explicit: readonly string[]): Promise<string[]> {
  const commit = readCommit(repository.objects, commitId);
  // A shallow boundary has no trustworthy parent delta; retain explicit links.
  if (commit.parents.length > 0 && repository.objects.partialState()?.shallow.includes(commitId)) return [...new Set(explicit)].sort(compareByteOrder);
  const current = flattenTree(repository.objects, commit.tree);
  const parent = flattenTree(repository.objects, commit.parents[0] === undefined ? null : readCommit(repository.objects, commit.parents[0]).tree);
  const changed = new Set([...current, ...parent].filter(([path, entry]) => entry.fileId !== undefined && current.get(path)?.id !== parent.get(path)?.id).map(([, entry]) => entry.fileId as string));
  const items = new Set(explicit);
  if (changed.size > 0) {
    const listed = await pmClient(context).list({ status: "all", compact: false, full: true, noTruncate: true, strictRead: true });
    const cache = new Map<string | null, ReturnType<typeof flattenTree>>();
    const history = orderCommitsNewestFirst(repository.objects, [...reachable(repository.objects, commitId)]);
    for (const item of listed.items as ItemMetadata[]) {
      for (const linked of item.files ?? []) {
        const fileId = resolveFileId(repository.objects, history, linked.path.replace(/^\.\//, ""), cache);
        if (fileId !== null && changed.has(fileId)) items.add(item.id);
      }
    }
  }
  return [...items].sort(compareByteOrder);
}

/**
 * Builds the verdict an agent acts on: the change, its provenance and its linked items.
 *
 * @param context - Host-supplied command context carrying the PM client.
 * @param repository - Repository holding the change.
 * @param verdict - The walk's raw verdict.
 * @returns The enriched verdict, with absent agent fields omitted rather than invented.
 */
async function verdictReport(context: CommandHandlerContext, repository: Repository, verdict: BisectVerdict): Promise<BisectVerdictReport> {
  if (verdict.commit === undefined) {
    return { kind: verdict.kind, items: [], unresolved: verdict.unresolved };
  }
  const commit = readCommit(repository.objects, verdict.commit);
  const provenance = changeProvenance(repository.objects, verdict.commit);
  return {
    kind: verdict.kind,
    change: verdict.change,
    commit: verdict.commit,
    message: commit.message.trimEnd().split("\n")[0],
    author: `${commit.author.name} <${commit.author.email}>`,
    at: new Date(commit.author.timestamp).toISOString(),
    items: await linkedItems(context, repository, verdict.commit, provenance.items),
    ...(commit.parents.length > 0 && repository.objects.partialState()?.shallow.includes(verdict.commit) ? { itemsBoundary: "shallow" as const } : {}),
    ...(provenance.agentHarness === undefined ? {} : { agentHarness: provenance.agentHarness }),
    ...(provenance.agentModel === undefined ? {} : { agentModel: provenance.agentModel }),
    unresolved: verdict.unresolved,
  };
}

/** Render immutable ids at the requested precision without changing durable state. */
function reportId(id: string, full: boolean): string {
  return full ? id : id.slice(0, 12);
}

/** Shorten only hexadecimal revision ids; named refs retain their spelling. */
function reportRevision(revision: string, full: boolean): string {
  return /^[0-9a-f]{64}$/.test(revision) ? reportId(revision, full) : revision;
}

/** Drop boundary detail already represented by the boundaries and compact step ids. */
function reportStep(step: BisectStep, full: boolean): BisectStep {
  const { detail, ...rest } = step;
  return { ...rest, commit: reportId(step.commit, full), changeId: reportId(step.changeId, full),
    ...(detail === undefined || (step.by === "boundary" && detail.startsWith("declared boundary ")) ? {} : { detail }) };
}

/** Keep a named revision only when it adds information to its resolved commit. */
function reportBoundary(repository: Repository, revision: string, full: boolean): { revision?: string; commit: string } {
  const commit = repository.resolve(revision);
  return { ...(revision === commit ? {} : { revision: reportRevision(revision, full) }), commit: reportId(commit, full) };
}

/** Compact verdict ids and unresolved observations without dropping provenance. */
function compactVerdict(verdict: BisectVerdictReport, full: boolean): BisectVerdictReport {
  return { ...verdict,
    ...(verdict.change === undefined ? {} : { change: reportId(verdict.change, full) }),
    ...(verdict.commit === undefined ? {} : { commit: reportId(verdict.commit, full) }),
    unresolved: verdict.unresolved.map((step) => reportStep(step, full)) };
}

/**
 * Builds the report for one session.
 *
 * @param context - Host-supplied command context carrying the PM client.
 * @param repository - Repository the session walks.
 * @param session - Session to report.
 * @param budget - Approximate candidate-log token budget; verdict metadata is retained.
 * @returns The report, with the verdict only when the walk concluded.
 */
async function reportOf(context: CommandHandlerContext, repository: Repository, session: BisectSession, budget: number): Promise<BisectReport> {
  const walk = walkOf(repository, session);
  const full = context.options.full === true;
  const report: BisectReport = {
    session: session.id,
    item: session.item,
    ...(session.command === undefined ? {} : { command: session.command }),
    maxSteps: bisectStepLimit(session.maxSteps),
    status: session.status,
    ...(session.halted === undefined ? {} : { halted: session.halted }),
    boundaries: {
      good: reportBoundary(repository, session.good, full),
      bad: reportBoundary(repository, session.bad, full),
    },
    original: { ...session.original, commit: reportId(session.original.commit, full) },
    steps: session.steps.map((step) => reportStep(step, full)),
    stepsTaken: session.steps.length,
    stepsOmitted: 0,
    remaining: walk.remaining,
    next: walk.next === null ? null : { commit: reportId(walk.next.commit, full), changeId: reportId(walk.next.changeId, full) },
    ...(walk.verdict === undefined ? {} : { verdict: compactVerdict(await verdictReport(context, repository, walk.verdict), full) }),
  };
  let projected = report;
  while (projected.steps.length > 0 && JSON.stringify(projected).length > budget * 4) {
    projected = { ...projected, steps: projected.steps.slice(1), stepsOmitted: projected.stepsOmitted + 1 };
  }
  return projected;
}

/**
 * Appends one session milestone to PM history on the linked item.
 *
 * PM history is append-only, so concurrent agents recording sessions on the same
 * repository extend each other's record rather than overwriting it — that is
 * what makes a second agent's `bisect status` able to see the first's state.
 *
 * @param context - Host-supplied command context carrying the PM client.
 * @param session - Session being recorded.
 * @param kind - Milestone being reached.
 * @throws Error When the tracker write fails, so the caller never reports success silently.
 */
async function recordMilestone(context: CommandHandlerContext, session: BisectSession, kind: (typeof BISECT_MILESTONES)[number]): Promise<void> {
  const author = invocationAuthor(context);
  await pmClient(context).comments(session.item, {
    add: `${BISECT_MARKER}${kind} ${JSON.stringify({ ...session })}`,
    author,
  });
}

/**
 * Compacts a recorded session for the cross-agent listing.
 *
 * @param session - Session recorded on PM history.
 * @returns The listing without the per-candidate step log.
 */
function listSession(session: BisectSession, full: boolean): BisectSessionListing {
  return {
    session: session.id,
    item: session.item,
    status: session.status,
    good: reportRevision(session.good, full),
    bad: reportRevision(session.bad, full),
    startedAt: session.startedAt,
    startedBy: session.startedBy,
    steps: session.steps.length,
    ...(session.halted === undefined ? {} : { halted: session.halted }),
    ...(session.verdict === undefined ? {}
      : { verdict: { kind: session.verdict.kind, ...(session.verdict.change === undefined ? {} : { change: reportId(session.verdict.change, full) }) } }),
  };
}

/**
 * Parses a recorded session milestone out of a PM comment.
 *
 * @param text - The comment text.
 * @returns The recorded session, or null when the comment is not a milestone.
 */
function parseMilestone(text: string): BisectSession | null {
  if (!text.startsWith(BISECT_MARKER)) return null;
  const rest = text.slice(BISECT_MARKER.length);
  const space = rest.indexOf(" ");
  if (space === -1 || !(BISECT_MILESTONES as readonly string[]).includes(rest.slice(0, space))) return null;
  try {
    return decodeBisectSession(rest.slice(space + 1));
  } catch {
    // A comment nobody can parse is reported by `status` as absent rather than
    // blocking every session the tracker holds.
    return null;
  }
}

/**
 * Lists the sessions this tracker's PM history knows about, newest milestone per session.
 *
 * @param context - Host-supplied command context carrying the PM client.
 * @param item - Restrict the listing to one PM item when given.
 * @returns The recorded sessions in first-recorded order.
 */
async function trackerSessions(context: CommandHandlerContext, item: string | undefined): Promise<BisectSession[]> {
  const listed = await pmClient(context).list({ status: "all", compact: false, full: true, noTruncate: true, strictRead: true });
  const found = new Map<string, BisectSession>();
  for (const listedItem of listed.items as ItemMetadata[]) {
    if (item !== undefined && listedItem.id !== item) continue;
    for (const comment of listedItem.comments ?? []) {
      const session = parseMilestone(comment.text);
      if (session !== null) found.set(session.id, session);
    }
  }
  return [...found.values()].sort((left, right) => compareByteOrder(left.startedAt, right.startedAt) || compareByteOrder(left.id, right.id));
}

/**
 * Translates one linked PM test execution into a bisect verdict contribution.
 *
 * pm reports the recorded command's own exit status; a verdict of good or bad is
 * reserved for a test that genuinely ran and concluded. Exit 125 follows git's
 * skip convention, a signal death (128 and above in shell reporting) means the
 * walk itself was interrupted, and every other recognized failure to run —
 * timeout, lost buffer, spawn error — is untestable rather than bad.
 *
 * @param run - One linked test execution result.
 * @returns The verdict contribution for the candidate.
 */
function classifyRun(run: TestRunResult): BisectRunOutcome {
  if (run.status === "passed") return { outcome: "good" };
  if (run.status !== "failed") return { outcome: "untestable", detail: `${run.status}${run.error === undefined ? "" : `: ${run.error}` }` };
  const category = run.failure_category ?? "assertion_failure";
  const exit = run.exit_code;
  if (exit === null || exit === undefined) return { outcome: "untestable", detail: `${category} without an exit code` };
  if (exit === 125) return { outcome: "skip", detail: "exit 125" };
  if (exit === 126 || exit === 127) return { outcome: "untestable", detail: `exit ${exit}` };
  if (exit >= 128) return { outcome: "untestable", detail: `${category} (exit ${exit})`, interrupted: true };
  if (category !== "assertion_failure") return { outcome: "untestable", detail: category };
  return { outcome: "bad", detail: `exit ${exit}` };
}

/**
 * Folds every linked test execution of one candidate into a single verdict.
 *
 * An interruption halts the walk; otherwise a genuine failure marks the candidate bad.
 * Unrunnable tests remain explicit, and only tests that all passed call it good.
 *
 * @param runs - The linked test executions for one candidate.
 * @returns The candidate's verdict.
 */
function classifyRuns(runs: readonly TestRunResult[]): BisectRunOutcome {
  if (runs.length === 0) return { outcome: "untestable", detail: "the linked test selected nothing to run" };
  const classified = runs.map(classifyRun);
  const interrupted = classified.find((run) => run.interrupted === true);
  if (interrupted !== undefined) return interrupted;
  const bad = classified.find((run) => run.outcome === "bad");
  if (bad !== undefined) return { outcome: "bad", detail: bad.detail };
  const untestable = classified.find((run) => run.outcome === "untestable" || run.outcome === "skip");
  if (untestable !== undefined) {
    return untestable;
  }
  return { outcome: "good" };
}

/** Run the recorded SDK test in a child with independent workspace coordinates. @internal */
export async function runCandidateTest(item: string, author: string, pmRoot: string, workspace: string, control: string, command?: string, sourceRef?: string, recordOnly = false): Promise<BisectRunOutcome> {
  const runner = fileURLToPath(new URL(`./bisect-test-runner${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  const policy = new URL(`./bisect-sdk-policy${extname(fileURLToPath(import.meta.url))}`, import.meta.url).href;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const receipt = join(control, "BISECT_WORKER");
      const request = { command, recordOnly, bridge: sourceRef !== undefined, githubHead: process.env.GITHUB_HEAD_REF ?? null };
      const child = spawn(process.execPath, ["--import", policy, runner, item, author, pmRoot, receipt, JSON.stringify(request)], {
        cwd: workspace, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PM_SOURCE_WORKSPACE_ROOT: workspace, ...(sourceRef === undefined ? {} : { GITHUB_HEAD_REF: sourceRef }) },
      });
      let output = "";
      let errors = "";
      let ownsReceipt = false;
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
      // An early worker exit can close stdin before authorization is written.
      // The child error/close handlers classify that failure as untestable.
      child.stdin.on("error", () => {});
      child.on("error", reject);
      child.on("close", (code) => {
        if (ownsReceipt) durability.remove(receipt, { force: true });
        if (code === 0) resolve(output);
        else reject(new Error(`Linked PM test runner exited ${code}: ${errors.trim()}`));
      });
      // The child waits for EOF before running: a crash before this durable
      // owner receipt closes stdin without authorization, so it cannot race resume.
      try {
        writeFileSync(receipt, String(child.pid), { flag: "wx", mode: 0o600 });
        ownsReceipt = true;
        child.stdin.end("run");
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    const runs = JSON.parse(output) as TestRunResult[];
    return recordOnly ? { outcome: "good" } : classifyRuns(runs);
  } catch (error) {
    return { outcome: "untestable", detail: String(error) };
  }
}

/**
 * Registers the `pm vcs bisect` command surface.
 *
 * @param api - The host-supplied extension API.
 */
export function registerBisectCommands(api: ExtensionApi): void {
  api.registerCommand({
    name: "vcs bisect",
    description:
      "Find the first failing stable change in the native change graph using linked PM tests or start --command <command> (recorded on --item). Run pauses at --max-steps (default 128); run again to resume after a limit or interruption. Exit 125 skips a candidate. Stable change identities preserve results across rewrites; skipped and untestable ancestors produce an ambiguous verdict. Each result and verdict is PM evidence. Works without git and keeps the original working state in place.",
    arguments: [
      { name: "action", description: "start, good, bad, skip, run, status or reset", required: true },
      { name: "revision", description: "Marked revision for good/bad/skip; the good boundary for start", required: false },
      { name: "bad", description: "The bad boundary for start", required: false },
    ],
    flags: [
      { long: "--full", description: "Print complete commit and change ids instead of 12-character ids", value_type: "boolean" },
      { long: "--budget", value_name: "tokens", description: "Approximate candidate-log token budget (default 1600, minimum 256); verdict metadata is always retained", value_type: "number" },
      { long: "--item", value_name: "pm-item", description: "PM item whose recorded linked test drives the bisect (required for start; filters status)", value_type: "string" },
      { long: "--command", value_name: "command", description: "For start: record this command as a linked test on --item and run only that test", value_type: "string" },
      { long: "--max-steps", value_name: "count", description: "Positive candidate limit per run (default 128); start saves it and run can override it for subsequent runs", value_type: "number" },
    ],
    async run(context: CommandHandlerContext): Promise<{ ok: boolean; bisect?: BisectReport; sessions?: readonly BisectSessionListing[]; reset?: { session: string; restored: BisectSession["original"]; warning?: string } }> {
      const repository = openRepository(context);
      const action = context.args[0]?.trim();
      const author = invocationAuthor(context);
      const now = (): Date => new Date();
      const budget = Number(context.options.budget ?? 1600);
      if (!Number.isSafeInteger(budget) || budget < 256) throw new VcsError("invalid_bisect_budget", "The bisect report budget must be an integer of at least 256 tokens.", "Pass --budget 1600 or a larger value for a longer candidate log.");
      const requestedSteps = context.options.maxSteps;
      if (requestedSteps !== undefined) bisectStepLimit(requestedSteps);
      const command = optionalString(context.options, "command");
      if (context.options.command !== undefined && (action !== "start" || command === undefined)) {
        throw new VcsError("invalid_bisect_command", "A nonempty --command is accepted only by bisect start.", "Reset and start a new session to change the predicate.");
      }


      const execute = async () => {
        if (action === "start") {
          const existing = readBisectSession(repository);
          if (existing !== null) {
            throw new VcsError(
              "bisect_in_progress",
              `A bisect session is already ${existing.status} in this worktree.`,
              "Finish it with `pm vcs bisect run` or `pm vcs bisect status`, or abandon it with `pm vcs bisect reset`.",
            );
          }
          recoverBisectWorker(repository);
          if (repository.layers().length > 0) {
            throw new VcsError(
              "layer_bisect_conflict",
              "Private layers cannot coexist with a bisect walk.",
              "Remove the layers with `pm vcs layer <name> local --remove` before starting a bisect.",
            );
          }
          const head = repository.refs.readHead();
          if (head.target === null) {
            throw new VcsError("unborn_head", "pm vcs bisect needs a repository with commits.", "Commit something before bisecting.");
          }
          const status = repository.status();
          // Untracked files are allowed: a scratch tracker is untracked by nature, and
          // a candidate whose tree carries an untracked path is refused at the switch
          // with its own remedy. Staged or unstaged edits are not allowed, because
          // the walk rewrites tracked content between every candidate.
          const dirty = [...status.staged, ...status.unstaged].map((change) => change.path);
          if (dirty.length > 0) {
            throw new VcsError(
              "dirty_worktree",
              "pm vcs bisect starts from a clean tracked tree.",
              `Commit or discard the changes to ${dirty.join(", ")} first.`,
            );
          }
          const good = requiredArgument(context, 1, "good revision", "Pass the known-good ancestor first, for example `pm vcs bisect start HEAD~10 HEAD`.");
          const bad = requiredArgument(context, 2, "bad revision", "Pass the known-bad revision second, for example `pm vcs bisect start HEAD~10 HEAD`.");
          const item = optionalString(context.options, "item");
          if (item === undefined) {
            throw new VcsError("missing_argument", "pm vcs bisect start needs the PM item whose linked test drives the walk.", "Pass --item <pm-item>.");
          }
          const read = await pmClient(context).get(item, { full: true });
          // Full SDK reads include the linked arrays, even when no tests are recorded.
          if (command === undefined && read.linked!.tests.length === 0) {
            throw new VcsError(
              "no_linked_test",
              `The item ${item} records no linked test.`,
              `Record the failing test first: pm test ${item} --add command="<exact test command>".`,
            );
          }
          const goodId = repository.resolve(good);
          const badId = repository.resolve(bad);
          const session: BisectSession = declareBoundaries(repository, {
            version: 1,
            id: `bisect-${randomBytes(6).toString("hex")}`,
            item,
            ...(command === undefined ? {} : { command }),
            maxSteps: bisectStepLimit(requestedSteps),
            good,
            bad,
            original: { branch: head.kind === "branch" ? head.ref.slice(BRANCH_PREFIX.length) : null, commit: head.target },
            startedAt: new Date().toISOString(),
            startedBy: author,
            steps: [],
            status: "active",
          }, goodId, badId, { author, now });
          bisectCandidates(repository.objects, goodId, badId);
          if (command !== undefined) {
            const recorded = await runCandidateTest(item, author, context.pm_root, repository.root, repository.controlDirectory, command, bisectTestSourceRef(repository), true);
            if (recorded.outcome !== "good") throw new VcsError("bisect_test_registration", "The explicit bisect test could not be recorded.", String(recorded.detail));
          }
          writeBisectSession(repository, session);
          await recordMilestone(context, session, "start");
          return { ok: true, bisect: await reportOf(context, repository, session, budget) };
        }

        if (action === "good" || action === "bad" || action === "skip") {
          const session = requireSession(repository, action);
          if (session.status !== "active") {
            throw new VcsError(
              "bisect_concluded",
              `The bisect session ${session.id} is ${session.status}.`,
              "Inspect it with `pm vcs bisect status`, or abandon it with `pm vcs bisect reset`.",
            );
          }
          const requested = context.args[1]?.trim();
          const next = requested ? null : walkOf(repository, session).next;
          if (!requested && next === null) {
            throw new VcsError("no_bisect_candidate", "There is no next candidate to mark.",
              "Pass an explicit revision to good/bad/skip, or inspect `pm vcs bisect status` and reset the session.");
          }
          const revision = requested ? repository.resolve(requested) : (next as BisectCandidate).commit;
          const marked = markBisectOutcome(repository, session, revision, action as BisectOutcome, { author, now });
          const walk = walkOf(repository, marked);
          const concluded = walk.remaining === 0
            ? { ...marked, status: "done" as const, verdict: walk.verdict, halted: undefined }
            : marked;
          writeBisectSession(repository, concluded);
          await recordMilestone(context, concluded, concluded.status === "done" ? "done" : "step");
          return { ok: true, bisect: await reportOf(context, repository, concluded, budget) };
        }

        if (action === "run") {
          const session = requireSession(repository, action);
          if (session.status !== "active") {
            throw new VcsError(
              "bisect_concluded",
              `The bisect session ${session.id} is ${session.status}.`,
              "Inspect it with `pm vcs bisect status`, or abandon it with `pm vcs bisect reset`.",
            );
          }
          const bounded = requestedSteps === undefined ? session : { ...session, maxSteps: bisectStepLimit(requestedSteps) };
          const sourceRef = bisectTestSourceRef(repository);
          const driven = await runBisect(repository, bounded, (_candidate, workspace) => runCandidateTest(session.item, author, context.pm_root, workspace, repository.controlDirectory, session.command, sourceRef),
            { author, now, progress: (state) => recordMilestone(context, state, "step") });
          await recordMilestone(context, driven.session, driven.session.status === "done" ? "done" : "halted");
          return { ok: true, bisect: await reportOf(context, repository, driven.session, budget) };
        }

        if (action === "status") {
          const item = optionalString(context.options, "item");
          const local = readBisectSession(repository);
          const sessions = (await trackerSessions(context, item)).map((session) => listSession(session, context.options.full === true));
          const bisect = local === null || (item !== undefined && local.item !== item) ? null : await reportOf(context, repository, local, budget);
          return { ok: true, ...(bisect === null ? {} : { bisect }), sessions };
        }

        if (action === "reset") {
          const session = requireSession(repository, action);
          clearBisectSession(repository);
          let warning: string | undefined;
          try { await recordMilestone(context, { ...session, status: "abandoned" }, "reset"); }
          catch (error) { warning = `Local session cleared; reset milestone could not be recorded: ${String(error)}`; }
          return { ok: true, reset: { session: session.id,
            restored: { ...session.original, commit: reportId(session.original.commit, context.options.full === true) },
            ...(warning === undefined ? {} : { warning }) } };
        }

        throw new VcsError(
          "invalid_bisect_action",
          `Unknown bisect action${action === undefined ? "" : ` "${action}"`}.`,
          "Use start, good, bad, skip, run, status or reset.",
        );
      };
      return action === "status" ? execute() : withBisectLease(repository, execute);
    },
  });
}

/** Exported for the command-contract tests: the report shape every subcommand returns. */
export type { BisectReport, BisectVerdictReport };

/** Re-exported so tests can observe linked-test verdict folding without a repository. */
export { classifyRuns };
