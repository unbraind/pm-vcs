import { prepareNamespaceDestruction } from "./destruction.ts";
import { durability } from "./durability.ts";
/** Durable bisect sessions over stable change identities, driven by a recorded PM test. */

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { collectCommitObjects } from "./bundle.ts";
import { orderCommitsNewestFirst } from "./attribution.ts";
import { summarizeConflicts } from "./conflicts.ts";
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
  /** Unresolved ancestors of the first bad change, or all unresolved steps if none is bad. */
  readonly unresolved: readonly BisectStep[];
}

/** The resumable session state persisted in the worktree's private control directory. */
export interface BisectSession {
  readonly version: 1;
  /** Random identifier distinguishing concurrent sessions on one repository. */
  readonly id: string;
  /** PM item whose recorded linked test drives the walk. */
  readonly item: string;
  /** Explicit command recorded on the item; otherwise all linked tests drive the walk. */
  readonly command?: string;
  /** Maximum candidates per run invocation; older sessions default to 128. */
  readonly maxSteps?: number;
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

/** Validate the positive candidate budget shared by CLI and engine callers. */
export function bisectStepLimit(value: unknown = 128): number {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ObjectStoreError("invalid_bisect_steps", "The bisect step limit must be a positive safe integer; pass --max-steps 128.");
  }
  return limit;
}

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
    durability.rename(temporary, target);
  } finally {
    durability.remove(temporary, { force: true });
  }
}

/** Remove a process receipt only when its owner is provably dead; unknown owners refuse recovery. */
function recoverOwner(path: string): void {
  const observed = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (observed === undefined) return;
  if (!observed.isFile()) throw new ObjectStoreError("bisect_locked", "Unknown bisect lock owner; inspect its namespace entry before recovery.");
  const pid = Number(readFileSync(path, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new ObjectStoreError("bisect_locked", "Unknown bisect lock owner; inspect the private process receipt before recovery.");
  try {
    process.kill(pid, 0);
    throw new ObjectStoreError("bisect_locked", "Another bisect command or test worker owns this worktree; inspect bisect status and retry after it finishes.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  durability.unlinkOwner(path, observed);
}

/** Refuse to remove a candidate directory while an orphaned SDK test process still uses it. */
export function recoverBisectWorker(repository: Repository): void {
  recoverOwner(join(repository.controlDirectory, "BISECT_WORKER"));
}

/** Serialize asynchronous bisect mutations; only a proven dead process permits automatic recovery. */
export async function withBisectLease<T>(repository: Repository, action: () => Promise<T>): Promise<T> {
  const path = join(repository.controlDirectory, "BISECT_LOCK");
  const owned = repository.objects.withWriteLock(() => {
    recoverOwner(path);
    writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
    return lstatSync(path, { bigint: true });
  });
  try { return await action(); }
  finally {
    const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (current !== undefined && current.dev === owned.dev && current.ino === owned.ino && current.size === owned.size && current.mtimeNs === owned.mtimeNs) durability.unlinkOwner(path, current);
  }
}

/** Removes the session state, concluding or abandoning the walk. */
export function clearBisectSession(repository: Repository): void {
  recoverBisectWorker(repository);
  const plan = prepareNamespaceDestruction(statePath(repository), "bisect-reset", [{ path: statePath(repository) }, { path: join(repository.controlDirectory, "BISECT_WORKSPACE"), recursive: true }], false, "eligibility_changed");
  for (const path of plan.paths) plan.remove(path);
  plan.finish();
}

/** Ancestry is private to one candidate array and released with that walk. */
const walkAncestry = new WeakMap<readonly BisectCandidate[], ReadonlyMap<ObjectId, ReadonlySet<ObjectId>>>();

/** Build range-only closures once; ordered parents already have their closures. */
function ancestryOf(store: ObjectStore, candidates: readonly BisectCandidate[], read = (id: ObjectId) => readCommit(store, id)): ReadonlyMap<ObjectId, ReadonlySet<ObjectId>> {
  const cached = walkAncestry.get(candidates);
  if (cached !== undefined) return cached;
  const included = new Set(candidates.map((candidate) => candidate.commit));
  const closures = new Map<ObjectId, ReadonlySet<ObjectId>>();
  for (const candidate of candidates) {
    const closure = new Set([candidate.commit]);
    for (const parent of read(candidate.commit).parents) {
      if (included.has(parent)) for (const ancestor of closures.get(parent) as ReadonlySet<ObjectId>) closure.add(ancestor);
    }
    closures.set(candidate.commit, closure);
  }
  walkAncestry.set(candidates, closures);
  return closures;
}

/** Collect one boundary's ancestry, stopping before excluded ancestors are read. */
function boundaryAncestry(start: ObjectId, excluded: ReadonlySet<ObjectId>, read: (id: ObjectId) => ReturnType<typeof readCommit>, shallow: ReadonlySet<ObjectId>): Set<ObjectId> {
  const visited = new Set<ObjectId>();
  const pending = [start];
  while (pending.length > 0) {
    const id = pending.pop() as ObjectId;
    if (visited.has(id)) continue;
    visited.add(id);
    if (!excluded.has(id) && !shallow.has(id)) pending.push(...read(id).parents);
  }
  return visited;
}

/** Resolve a range with one immutable commit read per visited id, sharing ancestry across its steps. */
export function bisectCandidates(store: ObjectStore, good: ObjectId, bad: ObjectId): BisectCandidate[] {
  const commits = new Map<ObjectId, ReturnType<typeof readCommit>>();
  const read = (id: ObjectId): ReturnType<typeof readCommit> => {
    let commit = commits.get(id);
    if (commit === undefined) { commit = readCommit(store, id); commits.set(id, commit); }
    return commit;
  };
  const shallow = new Set(store.partialState()?.shallow ?? []);
  const excluded = boundaryAncestry(good, new Set(), read, shallow);
  const ancestry = boundaryAncestry(bad, excluded, read, shallow);
  const range = [...ancestry].filter((id) => !excluded.has(id));
  if (!ancestry.has(good) || range.length === 0) {
    throw new ObjectStoreError(
      "invalid_bisect_range",
      `No changes sit between the good boundary ${good.slice(0, 12)} and the bad boundary ${bad.slice(0, 12)}. `
      + "Pass a good revision that is an ancestor of the bad one.",
    );
  }
  const candidates = orderCommitsNewestFirst(store, range, read).reverse()
    .map((commitId) => ({ commit: commitId, changeId: effectiveChangeId(commitId, read(commitId)) }));
  ancestryOf(store, candidates, read);
  return candidates;
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
  const ancestry = ancestryOf(store, candidates);
  const current = new Map(candidates.map((candidate) => [candidate.changeId, candidate.commit]));
  const closures = (outcome: BisectOutcome): ReadonlySet<ObjectId>[] => [...verdicts.values()]
    .filter((step) => step.outcome === outcome && current.has(step.changeId))
    .map((step) => ancestry.get(current.get(step.changeId) as ObjectId) as ReadonlySet<ObjectId>);
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
  const ancestry = ancestryOf(store, candidates);
  const half = remaining.size / 2;
  let best = open[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of open) {
    const closure = ancestry.get(candidate.commit) as ReadonlySet<ObjectId>;
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
 * The oldest candidate marked bad is the first failing change. Its ancestors
 * that ended skip, untestable or conflicted are reported instead of assumed
 * good; unrelated branches cannot be the cause of this bad change.
 *
 * @param candidates - Ordered candidates of the current boundaries.
 * @param verdicts - Recorded verdicts by stable change identity.
 * @returns The verdict, including unresolved steps in the answer's ancestry.
 */
export function bisectVerdict(
  store: ObjectStore,
  candidates: readonly BisectCandidate[],
  verdicts: ReadonlyMap<ObjectId, BisectStep>,
): BisectVerdict {
  const unresolved: BisectStep[] = [];
  const ancestry = ancestryOf(store, candidates);
  const current = new Map(candidates.map((candidate) => [candidate.changeId, candidate.commit]));
  const goodClosures = [...verdicts.values()].filter((step) => step.outcome === "good" && current.has(step.changeId))
    .map((step) => ancestry.get(current.get(step.changeId) as ObjectId) as ReadonlySet<ObjectId>);
  const firstBad = candidates.find((candidate) => verdicts.get(candidate.changeId)?.outcome === "bad");
  const scope = firstBad === undefined ? undefined : ancestry.get(firstBad.commit) as ReadonlySet<ObjectId>;
  for (const candidate of candidates) {
    if (candidate === firstBad) break;
    const step = verdicts.get(candidate.changeId);
    if (step === undefined || step.outcome === "good") continue;
    if (scope !== undefined && !scope.has(candidate.commit)) continue;
    if (!goodClosures.some((closure) => closure.has(candidate.commit))) unresolved.push(step);
  }
  if (firstBad === undefined) return { kind: "no_bad_change", unresolved };
  return { kind: unresolved.length === 0 ? "first_bad" : "ambiguous", change: firstBad.changeId, commit: firstBad.commit, unresolved };
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
  const maxSteps = bisectStepLimit(session.maxSteps);
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
  let attempts = 0;
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
      if (attempts >= maxSteps) {
        current = { ...current, halted: "step_limit" };
        break;
      }
      attempts++;
      current = { ...current, pending: selected };
      writeBisectSession(repository, current);
      const workspaceRoot = join(repository.controlDirectory, "BISECT_WORKSPACE");
      durability.remove(workspaceRoot, { recursive: true, force: true });
      mkdirSync(workspaceRoot);
      const workspace = mkdtempSync(join(workspaceRoot, "candidate-"));
      let outcome: BisectRunOutcome | { readonly outcome: "conflicted"; readonly detail: string };
      try {
        const commit = readCommit(repository.objects, selected.commit);
        const conflicts = summarizeConflicts(repository.objects, commit.tree, selected.changeId);
        if (conflicts.length > 0) outcome = { outcome: "conflicted", detail: `${conflicts.length} unresolved conflict unit(s)` };
        else {
          let materializationError: string | undefined;
          try {
            const scratch = Repository.init(workspace);
            const closure = collectCommitObjects(repository.objects, [selected.commit]);
            scratch.objects.accept([...closure].map((id) => ({ id, ...repository.objects.read(id) })), false);
            scratch.switchTo(selected.commit, options.now());
          } catch (error) {
            if (!(error instanceof ObjectStoreError)) throw error;
            materializationError = `candidate could not be materialized: ${error.code}`;
          }
          outcome = materializationError === undefined ? await runner(selected, workspace) : { outcome: "untestable", detail: materializationError };
        }
      } finally {
        durability.remove(workspaceRoot, { recursive: true, force: true });
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
 * @throws ObjectStoreError When the revision is outside the range or contradicts its good boundary.
 */
export function markBisectOutcome(
  repository: Repository,
  session: BisectSession,
  revision: ObjectId,
  outcome: BisectOutcome,
  options: BisectRunOptions,
): BisectSession {
  const good = repository.resolve(session.good);
  const range = bisectCandidates(repository.objects, good, repository.resolve(session.bad));
  if (revision !== good && !range.some((candidate) => candidate.commit === revision)) {
    throw new ObjectStoreError("outside_bisect_range", "The marked revision is outside this session's range; pass a candidate from bisect status.");
  }
  if (revision === good && outcome !== "good") {
    throw new ObjectStoreError("good_boundary_verdict", "The good boundary bounds the range and cannot be marked bad or skipped; reset and start with an earlier good revision.");
  }
  const commit = readCommit(repository.objects, revision);
  return withStep(session, { commit: revision, changeId: effectiveChangeId(revision, commit), outcome,
    by: "manual", at: options.now().toISOString(), author: options.author });
}
