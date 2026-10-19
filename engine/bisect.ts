/** Durable bisect sessions over stable change identities, driven by a recorded PM test. */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { collectCommitObjects } from "./bundle.ts";
import { orderCommitsNewestFirst } from "./attribution.ts";
import { summarizeConflicts } from "./conflicts.ts";
import { reachable } from "./merge.ts";
import { effectiveChangeId, readCommit } from "./model.ts";
import { ObjectStoreError, type ObjectId, type ObjectStore } from "./objects.ts";
import { Repository } from "./repo.ts";

/** Verdict one candidate change received; never silently folded into good or bad. */
export type BisectOutcome = "good" | "bad" | "skip" | "untestable" | "conflicted";

/** How a verdict was established: declared boundaries, an automated run, or a manual mark. */
export type BisectBasis = "boundary" | "run" | "manual";

/** One tested candidate, recorded under its stable change identity. */
export interface BisectStep {
  /** Commit the verdict was observed at; a rewritten id carries the same change. */
  readonly commit: ObjectId;
  /** Stable identity the verdict is keyed by, so rebase and amend reuse it. */
  readonly changeId: ObjectId;
  readonly outcome: BisectOutcome;
  readonly by: BisectBasis;
  /** ISO timestamp of the observation. */
  readonly at: string;
  /** Author who recorded the verdict. */
  readonly author: string;
  /** Why an untestable, conflicted or interrupted verdict happened, when known. */
  readonly detail?: string;
  /** An interruption is logged but retried on resume. */
  readonly retry?: true;
}

/** Original checkout identity, retained for reporting; candidate execution never moves it. */
export interface BisectOriginalState {
  /** Branch HEAD was on, or null when it was detached. */
  readonly branch: string | null;
  readonly commit: ObjectId;
}

/** Conclusion of a completed walk: the first failing change, or its honest absence. */
export interface BisectVerdict {
  readonly kind: "first_bad" | "ambiguous" | "no_bad_change";
  readonly change?: ObjectId;
  readonly commit?: ObjectId;
  /** Verdicts that never resolved to good or bad, older than the first bad change. */
  readonly unresolved: readonly BisectStep[];
}

/** The resumable session state persisted in the worktree's private control directory. */
export interface BisectSession {
  readonly version: 1;
  /** Random identifier distinguishing concurrent sessions on one repository. */
  readonly id: string;
  /** PM item whose recorded linked test drives the walk. */
  readonly item: string;
  /** Boundary revisions as typed, re-resolved on every run so a moved branch is followed. */
  readonly good: string;
  readonly bad: string;
  readonly original: BisectOriginalState;
  /** ISO timestamp and author of the session's start. */
  readonly startedAt: string;
  readonly startedBy: string;
  readonly steps: readonly BisectStep[];
  readonly status: "active" | "done" | "abandoned";
  readonly verdict?: BisectVerdict;
  /** Why a run stopped without concluding, so the next run can say so. */
  readonly halted?: string;
  /** Persisted before execution; a crash leaves an explicit retry receipt. */
  readonly pending?: BisectCandidate;
}

/** One candidate change under test. */
export interface BisectCandidate {
  readonly commit: ObjectId;
  readonly changeId: ObjectId;
}

/** What a linked test run says about one candidate. */
export interface BisectRunOutcome {
  readonly outcome: "good" | "bad" | "skip" | "untestable";
  /** Failure category, exit code or conflict count, for the step log. */
  readonly detail?: string;
  /** The walk should stop and stay resumable rather than record a verdict. */
  readonly interrupted?: boolean;
}

/** Executes the linked PM test against an isolated materialization of the candidate. */
export type BisectRunner = (candidate: BisectCandidate, workspace: string) => Promise<BisectRunOutcome>;

/** Authorship and clock for steps recorded by a walk. */
export interface BisectRunOptions {
  readonly author: string;
  readonly now: () => Date;
  /** Append progress to authoritative PM history after durable local publication. */
  readonly progress?: (session: BisectSession) => Promise<void>;
}

/** Final session plus what a follow-up run would do next. */
export interface BisectRunResult {
  readonly session: BisectSession;
  /** Candidates still lacking a verdict. */
  readonly remaining: number;
  /** The candidate a follow-up run would test first, when the walk is unfinished. */
  readonly next: BisectCandidate | null;
}

const STATE_FILE = "BISECT_STATE";

/** Absolute path of this worktree's private bisect session state. */
function statePath(repository: Repository): string {
  return join(repository.controlDirectory, STATE_FILE);
}

/** Parse local or PM-recorded state, rejecting syntactically valid JSON that is not a session. */
export function decodeBisectSession(raw: string): BisectSession {
  const parsed = JSON.parse(raw) as BisectSession;
  if (parsed?.version !== 1 || typeof parsed.id !== "string" || !Array.isArray(parsed.steps)) throw new Error("invalid bisect session");
  return parsed;
}

/**
 * Reads this worktree's bisect session.
 *
 * The state file lives in the worktree's private control directory rather than in
 * the shared one, so two linked instances of one repository each carry their own
 * session and cannot overwrite one another's walk.
 *
 * @param repository - Repository whose worktree state is read.
 * @returns The persisted session, or null when none is underway.
 * @throws ObjectStoreError When the state file is present but not valid session JSON.
 */
export function readBisectSession(repository: Repository): BisectSession | null {
  let raw: string;
  try {
    raw = readFileSync(statePath(repository), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return decodeBisectSession(raw);
  } catch {
    throw new ObjectStoreError(
      "corrupt_bisect_state",
      `BISECT_STATE is not valid JSON or session data. `
      + "Resume with `pm vcs bisect reset` only after inspecting it, or remove the file if no walk is underway.",
    );
  }
}

/**
 * Persists the session atomically.
 *
 * A temporary file is written and renamed, so a crash mid-write leaves the previous
 * complete state rather than a truncated one — the state is what makes a walk
 * resumable after an interruption, and an unparseable state would end it.
 *
 * @param repository - Repository whose worktree state is written.
 * @param session - Session to persist.
 */
export function writeBisectSession(repository: Repository, session: BisectSession): void {
  const target = statePath(repository);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(session)}\n`, { flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Remove a process receipt only when its owner is provably dead; unknown owners refuse recovery. */
function recoverOwner(path: string): void {
  if (!existsSync(path)) return;
  const pid = Number(readFileSync(path, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new ObjectStoreError("bisect_locked", "Unknown bisect lock owner; inspect the private process receipt before recovery.");
  try {
    process.kill(pid, 0);
    throw new ObjectStoreError("bisect_locked", "Another bisect command or test worker owns this worktree; inspect bisect status and retry after it finishes.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  rmSync(path);
}

/** Refuse to remove a candidate directory while an orphaned SDK test process still uses it. */
export function recoverBisectWorker(repository: Repository): void {
  recoverOwner(join(repository.controlDirectory, "BISECT_WORKER"));
}

/** Serialize asynchronous bisect mutations; only a proven dead process permits automatic recovery. */
export async function withBisectLease<T>(repository: Repository, action: () => Promise<T>): Promise<T> {
  const path = join(repository.controlDirectory, "BISECT_LOCK");
  repository.objects.withWriteLock(() => {
    recoverOwner(path);
    writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  });
  try { return await action(); }
  finally { rmSync(path); }
}

/** Removes the session state, concluding or abandoning the walk. */
export function clearBisectSession(repository: Repository): void {
  recoverBisectWorker(repository);
  rmSync(statePath(repository), { force: true });
  rmSync(join(repository.controlDirectory, "BISECT_WORKSPACE"), { recursive: true, force: true });
}

/**
 * Lists the candidate changes between the boundaries, oldest first.
 *
 * The order is a reversed topological walk, so every ancestor precedes its
 * descendants and "first" has one meaning even when the range crosses a merge.
 * The bad boundary is itself a candidate; the good boundary is not.
 *
 * @param store - Object store holding the boundary ancestry.
 * @param good - Exclusive good boundary.
 * @param bad - Inclusive bad boundary.
 * @returns The candidates, oldest first, with each commit's stable change identity.
 * @throws ObjectStoreError When the boundaries do not bound any changes.
 */
export function bisectCandidates(store: ObjectStore, good: ObjectId, bad: ObjectId): BisectCandidate[] {
  const excluded = reachable(store, good);
  const range = [...reachable(store, bad)].filter((id) => !excluded.has(id));
  if (!reachable(store, bad).has(good) || range.length === 0) {
    throw new ObjectStoreError(
      "invalid_bisect_range",
      `No changes sit between the good boundary ${good.slice(0, 12)} and the bad boundary ${bad.slice(0, 12)}. `
      + "Pass a good revision that is an ancestor of the bad one.",
    );
  }
  return orderCommitsNewestFirst(store, range).reverse()
    .map((commitId) => ({ commit: commitId, changeId: effectiveChangeId(commitId, readCommit(store, commitId)) }));
}

/**
 * Derives the candidate verdicts one walk relies on, keyed by stable change identity.
 *
 * A later step for the same change overrides an earlier one, so a manual mark can
 * correct an automated verdict, and a rewritten commit reuses the newest result
 * its change already has.
 *
 * @param steps - Recorded steps, in observation order.
 * @returns Each change's newest step.
 */
export function bisectVerdicts(steps: readonly BisectStep[]): ReadonlyMap<ObjectId, BisectStep> {
  return new Map(steps.filter((step) => step.retry !== true).map((step) => [step.changeId, step]));
}

/**
 * Computes which candidates still need a verdict.
 *
 * Monotonicity does the narrowing, the way git bisect does it: a good candidate
 * also answers for every change it descends from, and a bad candidate keeps only
 * its own ancestry in question — the first failing change is the oldest bad one,
 * so everything a bad candidate descends from stays open and everything else does
 * not. Candidates whose change already has a verdict are excluded, which is what
 * makes a rewritten commit reuse a recorded result instead of retesting it.
 *
 * @param store - Object store holding candidate ancestry.
 * @param candidates - Ordered candidates of the current boundaries.
 * @param verdicts - Recorded verdicts by stable change identity.
 * @returns The commit ids still open, in candidate order.
 */
export function bisectRemaining(
  store: ObjectStore,
  candidates: readonly BisectCandidate[],
  verdicts: ReadonlyMap<ObjectId, BisectStep>,
): ReadonlySet<ObjectId> {
  const current = new Map(candidates.map((candidate) => [candidate.changeId, candidate.commit]));
  const closures = (outcome: BisectOutcome): Set<ObjectId>[] => [...verdicts.values()]
    .filter((step) => step.outcome === outcome && current.has(step.changeId))
    .map((step) => reachable(store, current.get(step.changeId) as ObjectId));
  const good = closures("good");
  const bad = closures("bad");
  const covered = (id: ObjectId): boolean => good.some((closure) => closure.has(id));
  const implicated = (id: ObjectId): boolean => bad.every((closure) => closure.has(id));
  return new Set(candidates.filter((candidate) => verdicts.get(candidate.changeId) === undefined
    && !covered(candidate.commit) && implicated(candidate.commit)).map((candidate) => candidate.commit));
}

/**
 * Selects the candidate whose ancestry best splits the open set in half.
 *
 * Halving the reachable side is what makes the walk logarithmic in the number of
 * candidates: a good or bad verdict answers for half of the open ancestry at once, and choosing deterministically on ties keeps repeated runs of one
 * session reproducible.
 *
 * @param store - Object store holding candidate ancestry.
 * @param candidates - Ordered candidates of the current boundaries.
 * @param remaining - Open candidates, in candidate order.
 * @returns The candidate to test next, or null when none remains.
 */
export function selectBisectCandidate(
  store: ObjectStore,
  candidates: readonly BisectCandidate[],
  remaining: ReadonlySet<ObjectId>,
): BisectCandidate | null {
  const open = candidates.filter((candidate) => remaining.has(candidate.commit));
  if (open.length === 0) return null;
  const half = remaining.size / 2;
  let best = open[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of open) {
    const closure = reachable(store, candidate.commit);
    const distance = Math.abs([...remaining].filter((id) => closure.has(id)).length - half);
    if (distance < bestDistance || (distance === bestDistance && candidate.commit < best.commit)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Concludes a completed walk: the first failing stable change, honestly.
 *
 * The oldest candidate marked bad is the first failing change. Candidates before
 * it that ended skip, untestable or conflicted are reported instead of assumed
 * good, because a walk that could not test a change must not claim it passed.
 *
 * @param candidates - Ordered candidates of the current boundaries.
 * @param verdicts - Recorded verdicts by stable change identity.
 * @returns The verdict, including every unresolved step that precedes the answer.
 */
export function bisectVerdict(
  store: ObjectStore,
  candidates: readonly BisectCandidate[],
  verdicts: ReadonlyMap<ObjectId, BisectStep>,
): BisectVerdict {
  const unresolved: BisectStep[] = [];
  const current = new Map(candidates.map((candidate) => [candidate.changeId, candidate.commit]));
  const goodClosures = [...verdicts.values()].filter((step) => step.outcome === "good" && current.has(step.changeId))
    .map((step) => reachable(store, current.get(step.changeId) as ObjectId));
  for (const candidate of candidates) {
    const step = verdicts.get(candidate.changeId);
    if (step === undefined) continue;
    if (step.outcome === "bad") {
      return { kind: unresolved.length === 0 ? "first_bad" : "ambiguous", change: candidate.changeId, commit: candidate.commit, unresolved };
    }
    if (step.outcome !== "good" && !goodClosures.some((closure) => closure.has(candidate.commit))) unresolved.push(step);
  }
  return { kind: "no_bad_change", unresolved };
}

/** Records a step on a session, persisting nothing: callers own durability. */
function withStep(session: BisectSession, step: BisectStep): BisectSession {
  return { ...session, steps: [...session.steps, step] };
}

/**
 * Ensures the freshly resolved boundaries carry declared verdicts.
 *
 * Boundaries are declared, not tested, and a branch can move between runs of one
 * session. Re-declaring only what is missing keeps the walk correct after a
 * rebase or a new bad tip without overwriting a manual mark.
 *
 * @param repository - Repository holding the boundary commits.
 * @param session - Session whose steps are extended.
 * @param good - Currently resolved good boundary.
 * @param bad - Currently resolved bad boundary.
 * @param options - Authorship and clock for the declared steps.
 * @returns The session with any missing boundary verdicts appended.
 */
export function declareBoundaries(repository: Repository, session: BisectSession, good: ObjectId, bad: ObjectId, options: BisectRunOptions): BisectSession {
  const verdicts = bisectVerdicts(session.steps);
  let extended = session;
  const at = options.now().toISOString();
  for (const boundary of [[session.good, good, "good"], [session.bad, bad, "bad"]] as const) {
    const [revision, commit, outcome] = boundary;
    const changeId = effectiveChangeId(commit, readCommit(repository.objects, commit));
    if (verdicts.has(changeId)) continue;
    extended = withStep(extended, { commit, changeId, outcome, by: "boundary", at, author: options.author,
      detail: `declared boundary ${revision}` });
  }
  return extended;
}

/**
 * Runs candidates in disposable native repositories, leaving the caller's tree, index and HEAD untouched.
 * Local state is published before execution and after every verdict; a pending candidate is retried after a crash.
 * PM history receives every completed step through the caller's progress callback.
 * @param repository - Authoritative source repository.
 * @param session - Durable session to continue.
 * @param runner - Recorded linked-test executor bound to the disposable workspace.
 * @param options - Author, clock and progress publisher.
 * @returns Durable conclusion or interrupted session.
 */
export async function runBisect(
  repository: Repository,
  session: BisectSession,
  runner: BisectRunner,
  options: BisectRunOptions,
): Promise<BisectRunResult> {
  recoverBisectWorker(repository);
  const good = repository.resolve(session.good);
  const bad = repository.resolve(session.bad);
  const candidates = bisectCandidates(repository.objects, good, bad);
  let current = declareBoundaries(repository, { ...session, halted: undefined }, good, bad, options);
  if (current.pending !== undefined) {
    current = withStep(current, { ...current.pending, outcome: "untestable", by: "run", retry: true,
      at: options.now().toISOString(), author: options.author, detail: "previous process stopped during this candidate; retrying" });
    current = { ...current, pending: undefined };
  }
  let signalled = false;
  const onSignal = (): void => { signalled = true; };
  process.on("SIGINT", onSignal);
  try {
    for (;;) {
      const verdicts = bisectVerdicts(current.steps);
      const remaining = bisectRemaining(repository.objects, candidates, verdicts);
      if (signalled) {
        current = { ...current, halted: "interrupted" };
        break;
      }
      const selected = selectBisectCandidate(repository.objects, candidates, remaining);
      if (selected === null) {
        current = { ...current, status: "done", verdict: bisectVerdict(repository.objects, candidates, verdicts) };
        break;
      }
      current = { ...current, pending: selected };
      writeBisectSession(repository, current);
      const workspaceRoot = join(repository.controlDirectory, "BISECT_WORKSPACE");
      rmSync(workspaceRoot, { recursive: true, force: true });
      mkdirSync(workspaceRoot);
      const workspace = mkdtempSync(join(workspaceRoot, "candidate-"));
      let outcome: BisectRunOutcome | { readonly outcome: "conflicted"; readonly detail: string };
      try {
        const commit = readCommit(repository.objects, selected.commit);
        const conflicts = summarizeConflicts(repository.objects, commit.tree, selected.changeId);
        if (conflicts.length > 0) outcome = { outcome: "conflicted", detail: `${conflicts.length} unresolved conflict unit(s)` };
        else {
          const scratch = Repository.init(workspace);
          const closure = collectCommitObjects(repository.objects, [...reachable(repository.objects, selected.commit)]);
          scratch.objects.accept([...closure].map((id) => ({ id, ...repository.objects.read(id) })), false);
          scratch.switchTo(selected.commit, options.now());
          outcome = await runner(selected, workspace);
        }
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
      const interrupted = signalled || ("interrupted" in outcome && outcome.interrupted === true);
      current = withStep({ ...current, pending: undefined }, { ...selected, outcome: interrupted ? "untestable" : outcome.outcome,
        by: "run", at: options.now().toISOString(), author: options.author,
        ...(interrupted ? { retry: true as const } : {}),
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) });
      writeBisectSession(repository, current);
      await options.progress?.(current);
      if (interrupted) { current = { ...current, halted: "interrupted" }; break; }
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    writeBisectSession(repository, current);
  }
  const remaining = bisectRemaining(repository.objects, candidates, bisectVerdicts(current.steps));
  return { session: current, remaining: remaining.size, next: selectBisectCandidate(repository.objects, candidates, remaining) };
}

/**
 * Records one manual verdict on an active session.
 *
 * Manual marks let an agent supply a verdict the recorded test cannot, such as
 * skipping a change whose build is known broken. The verdict is keyed by the
 * marked commit's stable change identity, so it also answers for rewritten ids.
 *
 * @param repository - Repository holding the marked commit.
 * @param session - Active session to extend.
 * @param revision - Commit the verdict applies to.
 * @param outcome - Verdict being recorded.
 * @param options - Authorship and clock for the step.
 * @returns The extended session.
 */
export function markBisectOutcome(
  repository: Repository,
  session: BisectSession,
  revision: ObjectId,
  outcome: BisectOutcome,
  options: BisectRunOptions,
): BisectSession {
  const range = bisectCandidates(repository.objects, repository.resolve(session.good), repository.resolve(session.bad));
  if (revision !== repository.resolve(session.good) && !range.some((candidate) => candidate.commit === revision)) {
    throw new ObjectStoreError("outside_bisect_range", "The marked revision is outside this session's range; pass a candidate from bisect status.");
  }
  const commit = readCommit(repository.objects, revision);
  return withStep(session, { commit: revision, changeId: effectiveChangeId(revision, commit), outcome,
    by: "manual", at: options.now().toISOString(), author: options.author });
}