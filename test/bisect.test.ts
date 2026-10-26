import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Linked-test-driven bisect sessions over real temporary repositories and trackers. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, afterEach, test } from "node:test";

import { PmClient, runTest, type TestRunResult } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";
import builtExtension from "../dist/index.js";
import { bisectTestSourceRef, classifyRuns, runCandidateTest, type BisectReport } from "../bisect-commands.ts";
import { bisectCandidates, bisectRemaining, bisectStepLimit, decodeBisectSession, bisectVerdict, bisectVerdicts, markBisectOutcome, readBisectSession, runBisect, selectBisectCandidate, writeBisectSession, withBisectLease, type BisectStep } from "../engine/bisect.ts";
import { effectiveChangeId, readCommit, writeCommit, type Signature } from "../engine/model.ts";
import { Repository } from "../engine/repo.ts";
import { ObjectStoreError } from "../engine/objects.ts";
import { cloneFrom } from "../engine/sync.ts";
import { buildTree, flattenTree } from "../engine/worktree.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { installPackedExtension, pmExecutable } from "../scripts/pm-environment.ts";

/** Every fixture directory created by this suite, torn down once at the end. */
const owned: ReturnType<typeof makeTempDir>[] = [];
/** Workspace roots pinned for linked-test execution, restored once at the end. */
const pinnedWorkspace: string[] = [];
const previousWorkspaceRoot = process.env.PM_SOURCE_WORKSPACE_ROOT;
/** SIGINT listeners present before any walk, so a leak is detectable per test. */
const baselineListeners = process.listenerCount("SIGINT");

after(() => {
  for (const dir of owned.splice(0)) dir.cleanup();
  for (const _ of pinnedWorkspace.splice(0)) {
    if (previousWorkspaceRoot === undefined) delete process.env.PM_SOURCE_WORKSPACE_ROOT;
    else process.env.PM_SOURCE_WORKSPACE_ROOT = previousWorkspaceRoot;
  }
});

/** Package manifest, read so the harness activates exactly the shipped capabilities. */
const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8")) as {
  capabilities: NonNullable<Parameters<typeof createExtensionTestHarness>[1]>["capabilities"];
};

/** Authorship fixture for every commit the suite creates. */
const author: Signature = { name: "fixture", email: "fixture@example.invalid", timestamp: 1_000, timezoneOffsetMinutes: 0 };

/** One prepared repository with a real PM tracker inside its root, untracked. */
interface Fixture {
  /** Repository working-tree root. */
  readonly root: string;
  /** Tracker storage root, inside the repository root. */
  readonly pmRoot: string;
  /** The real repository engine object, for building history. */
  readonly repository: Repository;
  /** A real PM client bound to the tracker. */
  readonly client: PmClient;
  /** The activated extension harness. */
  readonly harness: Awaited<ReturnType<typeof activate>>;
  /** Runs one `pm vcs bisect` invocation through the real host loader. */
  bisect(args: readonly string[], options?: Record<string, unknown>, global?: Record<string, unknown>): Promise<{ result: unknown; errorMessage: string | undefined }>;
}

/**
 * Activates the extension through the host's real loader.
 *
 * @returns The activated harness.
 */
async function activate(): Promise<ReturnType<typeof createExtensionTestHarness>> {
  return createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
}

/**
 * Creates a fresh repository, tracker and harness.
 *
 * The tracker sits inside the repository root but is never tracked, which is the
 * shape a real scratch project has and the one where recording milestones on PM
 * history is safe for the walk.
 *
 * @returns The prepared fixture.
 */
async function setup(clonedRoot?: string): Promise<Fixture> {
  const dir = makeTempDir();
  owned.push(dir);
  const root = clonedRoot ?? dir.root;
  const pmRoot = join(root, ".agents", "pm");
  const client = new PmClient({ pmRoot, cwd: root, noExtensions: true });
  await client.init("test", { defaults: true, author: "agent-a" });
  const repository = clonedRoot === undefined ? Repository.init(root, "main") : Repository.open(root);
  const harness = await activate();
  // Linked tests execute against the workspace root pm resolves; pinning it to
  // the fixture root makes the recorded command run against the switched tree
  // exactly the way a real host invocation from the repository root would.
  pinnedWorkspace.push(root);
  process.env.PM_SOURCE_WORKSPACE_ROOT = root;
  const harnessFixture = harness;
  return {
    root,
    pmRoot,
    repository,
    client,
    harness,
    bisect: (args, options = {}, global = { author: "bisector" }) => harnessFixture.runCommand({
      command: "vcs bisect", args, options: { full: true, ...options }, global, pmRoot,
    }) as Promise<{ result: unknown; errorMessage: string | undefined }>,
  };
}

/** Commits working-tree bytes, optionally associating PM items with the change. */
function edit(fixture: Fixture, path: string, text: string, message: string, items?: readonly string[]): string {
  writeFileSync(join(fixture.root, path), text);
  fixture.repository.stage([path]);
  return fixture.repository.commit({ message, author, ...(items === undefined ? {} : { items }) }, new Date());
}

/** Stages and commits explicitly named existing files, for fixture content. */
function commitFiles(fixture: Fixture, paths: readonly string[], message: string): string {
  fixture.repository.stage(paths);
  return fixture.repository.commit({ message, author }, new Date());
}

/** Stable expected change identity of a commit. */
function changeOf(fixture: Fixture, id: string): string {
  return effectiveChangeId(id, readCommit(fixture.repository.objects, id));
}

/** The commit HEAD resolves to, refusing an unborn fixture outright. */
function headCommit(fixture: Fixture): string {
  const target = fixture.repository.refs.resolveHead();
  assert.notEqual(target, null);
  return target as string;
}

/** The durable session state persisted in the repository's control directory. */
function storedSession(fixture: Fixture): ReturnType<typeof readBisectSession> {
  return readBisectSession(fixture.repository);
}

/** The comments recorded on an item, as text. */
async function comments(fixture: Fixture, item: string): Promise<string[]> {
  const read = await fixture.client.get(item, { full: true });
  return (read.item.comments ?? []).map((comment) => comment.text);
}

/** One probe line count: how many times the linked test executed. */
function runsRecorded(countFile: string): number {
  return existsSync(countFile) ? readFileSync(countFile, "utf8").trim().split("\n").filter((line) => line.length > 0).length : 0;
}

/** The tracked tree is clean; the untracked scratch tracker never counts against it. */
function trackedClean(fixture: Fixture): boolean {
  const status = fixture.repository.status();
  return status.staged.length === 0 && status.unstaged.length === 0;
}

/** The primary probe: reads state.txt and encodes each verdict the suite exercises. */
const PROBE = `const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
let state = "";
try { state = readFileSync("state.txt", "utf8").trim(); } catch {}
if (process.env.BISECT_COUNT_FILE) appendFileSync(process.env.BISECT_COUNT_FILE, "run\\n");
if (state.startsWith("hang") && process.env.BISECT_REPAIRED !== "1") process.kill(process.pid, "SIGINT");
else if (state.startsWith("slow")) setTimeout(() => process.exit(0), 1500);
else if (state.startsWith("untestable")) process.exit(125);
else if (state.startsWith("sideeffect")) { writeFileSync("extra.txt", "leftover\\n"); process.exit(0); }
else if (state.startsWith("broken")) process.exit(1);
`;

/** The repaired probe a walk resumes with after an interruption. */
const PROBE2 = `const { appendFileSync, readFileSync } = require("node:fs");
if (process.env.BISECT_COUNT_FILE) appendFileSync(process.env.BISECT_COUNT_FILE, "run\\n");
if (readFileSync("state.txt", "utf8").trim().startsWith("broken")) process.exit(1);
`;

/**
 * Creates an item whose one recorded linked test runs the committed probe.
 *
 * @param fixture - Fixture whose tracker receives the item.
 * @param title - Item title.
 * @param countFile - Absolute path the probe appends one line to per execution.
 * @returns The item id.
 */
async function linkedTestItem(fixture: Fixture, title: string, countFile: string): Promise<string> {
  // A stale counter from an earlier run would miscount this one's executions.
  rmSync(countFile, { force: true });
  const created = await fixture.client.create({ type: "Task", title, author: "agent-a" });
  const item = created.item.id;
  await runTest(item, {
    addJson: [JSON.stringify({ command: "node probe.js", timeout_seconds: 60, env_set: { BISECT_COUNT_FILE: countFile } })],
  }, { author: "agent-a", path: fixture.pmRoot });
  return item;
}

test("bisect identifies the first failing change of a 64-change linear history and restores the original state", async () => {
  const fixture = await setup();
  const countFile = join(fixture.root, "bisect-count-linear.txt");
  const item = await linkedTestItem(fixture, "Linear regression", countFile);
  const sideItem = (await fixture.client.create({ type: "Task", title: "Owns the broken file", author: "agent-a" })).item.id;
  await fixture.client.files(sideItem, { add: ["state.txt", "probe.js", "missing.txt"], author: "agent-a" });
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  const commits = [headCommit(fixture)];
  // The breakage persists from change 40 onward, the way a real regression does.
  for (let index = 1; index < 64; index += 1) {
    const broken = index >= 40;
    commits.push(edit(fixture, "state.txt", broken ? `broken ${index}` : `ok ${index}`, `change ${index}`, broken ? [item] : undefined));
  }
  const good = commits[0] as string;
  const bad = commits[commits.length - 1] as string;

  const started = await fixture.bisect(["start", good, bad], { item });
  const report = (started.result as { bisect: { session: string; remaining: number; next: { commit: string } | null; steps: { by: string }[] } }).bisect;
  // The declared bad boundary is already judged, so 62 candidates stay open.
  assert.equal(report.remaining, 62);
  assert.notEqual(report.next, null);
  assert.match(report.session, /^bisect-[0-9a-f]{12}$/);
  assert.equal(report.steps.filter((step) => step.by === "boundary").length, 2);

  const ran = await fixture.bisect(["run"]);
  const done = (ran.result as { bisect: { status: string; steps: { outcome: string; by: string }[]; verdict: { kind: string; change: string; commit: string; message: string; author: string; at: string; items: string[]; unresolved: unknown[] } } }).bisect;
  assert.equal(done.status, "done");
  assert.equal(done.verdict.kind, "first_bad");
  assert.equal(done.verdict.commit, commits[40]);
  assert.equal(done.verdict.change, changeOf(fixture, commits[40] as string));
  assert.equal(done.verdict.message, "change 40");
  assert.equal(done.verdict.author, "fixture <fixture@example.invalid>");
  assert.match(done.verdict.at, /^1970-01-01T/);
  // The failing change's PM association and the item linked to the file it broke.
  assert.ok(done.verdict.items.includes(item));
  assert.ok(done.verdict.items.includes(sideItem));
  assert.deepEqual(done.verdict.unresolved, []);
  const runs = done.steps.filter((step) => step.by === "run");
  assert.ok(runs.length > 1 && runs.length <= 7, `expected a logarithmic walk, got ${runs.length}`);
  assert.equal(runs.every((step) => step.outcome === "good" || step.outcome === "bad"), true);
  // Every probe execution is accounted for by a recorded step: no silent retesting.
  assert.equal(runsRecorded(countFile), runs.length);

  const head = fixture.repository.refs.readHead();
  assert.equal(head.kind, "branch");
  assert.equal(head.target, bad);
  assert.equal(trackedClean(fixture), true);
  const recorded = await comments(fixture, item);
  assert.equal(recorded.filter((text) => text.startsWith("pm-vcs bisect start ")).length, 1);
  const doneComment = recorded.find((text) => text.startsWith("pm-vcs bisect done "));
  assert.ok(doneComment !== undefined);
  assert.ok(doneComment.includes(commits[40] as string), doneComment);
  rmSync(countFile, { force: true });
});

test("bisect walks a merged history and finds a culprit introduced on the merged branch", async () => {
  const fixture = await setup();
  const countFile = join(fixture.root, "bisect-count-merge.txt");
  const item = await linkedTestItem(fixture, "Merged regression", countFile);
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  edit(fixture, "state.txt", "ok main", "main keeps passing");
  const branchPoint = headCommit(fixture);
  fixture.repository.createBranch("feature", branchPoint, new Date());
  fixture.repository.switchTo("feature", new Date());
  edit(fixture, "state.txt", "ok feature", "feature stays passing");
  const culprit = edit(fixture, "state.txt", "broken feature", "feature breaks");
  edit(fixture, "state.txt", "broken still", "feature stays broken");
  fixture.repository.switchTo("main", new Date());
  edit(fixture, "other.txt", "independent", "main keeps working");
  fixture.repository.merge("feature", { message: "Merge feature\n", author }, new Date());
  const bad = headCommit(fixture);

  const started = await fixture.bisect(["start", base, bad], { item });
  assert.equal((started.result as { bisect: { remaining: number } }).bisect.remaining, 6);
  const ran = await fixture.bisect(["run"]);
  const done = (ran.result as { bisect: { verdict: { kind: string; commit: string } } }).bisect;
  assert.equal(done.verdict.kind, "first_bad");
  assert.equal(done.verdict.commit, culprit);
  const head = fixture.repository.refs.readHead();
  assert.equal(head.kind, "branch");
  assert.equal(head.target, bad);
  rmSync(countFile, { force: true });
});

test("bisect verdict excludes skipped siblings in both byte orders but retains skipped ancestors", async () => {
  for (const skippedFirst of [true, false]) {
    for (const skippedAncestor of [false, true]) {
      const fixture = await setup();
      const { repository } = fixture;
      const item = await linkedTestItem(fixture, "Sibling verdict", join(fixture.root, "count.txt"));
      const good = repository.commit({ message: "good", author, allowEmpty: true }, new Date());
      const tree = readCommit(repository.objects, good).tree;
      const ancestor = writeCommit(repository.objects, { tree, parents: [good], author, committer: author, message: "shared ancestor" });
      const parent = skippedAncestor ? ancestor : good;
      const siblings = ["A", "B"].map((message) => writeCommit(repository.objects, { tree, parents: [parent], author, committer: author, message }));
      const bad = writeCommit(repository.objects, { tree, parents: siblings, author, committer: author, message: "merge" });
      repository.refs.compareAndSwap("refs/heads/main", good, bad);
      await fixture.bisect(["start", good, bad], { item });
      const candidates = bisectCandidates(repository.objects, good, bad);
      const orderedSiblings = candidates.filter((candidate) => siblings.includes(candidate.commit));
      // Oldest-first topological ties reverse byte order. Exercise either sibling as bad.
      assert.ok(orderedSiblings[0].commit > orderedSiblings[1].commit);
      const skipped = orderedSiblings[skippedFirst ? 0 : 1];
      const culprit = orderedSiblings[skippedFirst ? 1 : 0];
      const session = storedSession(fixture)!;
      const marked = { ...session, steps: [...session.steps,
        ...(skippedAncestor ? [{ commit: ancestor, changeId: changeOf(fixture, ancestor), outcome: "skip" as const,
          by: "manual" as const, at: session.startedAt, author: "fixture" }] : []),
        { ...skipped, outcome: "skip" as const, by: "manual" as const, at: session.startedAt, author: "fixture" },
        { ...culprit, outcome: "bad" as const, by: "manual" as const, at: session.startedAt, author: "fixture" },
      ] };
      const verdict = bisectVerdict(repository.objects, candidates, bisectVerdicts(marked.steps));
      assert.equal(verdict.kind, skippedAncestor ? "ambiguous" : "first_bad");
      assert.equal(verdict.commit, culprit.commit);
      assert.deepEqual(verdict.unresolved.map((step) => step.commit), skippedAncestor ? [ancestor] : []);
      const result = await runBisect(repository, marked, async () => assert.fail("no open candidate should execute"),
        { author: "fixture", now: () => new Date() });
      assert.equal(result.session.status, "done");
      assert.equal(result.remaining, 0);
      assert.equal(result.next, null);
      assert.deepEqual(result.session.verdict, verdict);
    }
  }
});

test("bisect materialization copies four selected tree objects independent of history depth", async (context) => {
  for (const depth of [12, 64]) {
    const fixture = await setup();
    const item = await linkedTestItem(fixture, "Bounded materialization", join(fixture.root, "count.txt"));
    mkdirSync(join(fixture.root, "nested"));
    const history: string[] = [];
    for (let index = 0; index < depth; index++) {
      history.push(edit(fixture, "nested/state.txt", String(index), `state ${index}`));
    }
    const bad = history.at(-1)!;
    await fixture.bisect(["start", history[0], bad], { item });
    const copied: number[] = [];
    const culprit = Math.floor(depth / 2);
    const result = await runBisect(fixture.repository, storedSession(fixture)!, async (candidate, workspace) => {
      const scratch = Repository.open(workspace);
      const inventory = scratch.objects.inventory();
      copied.push(inventory.length);
      // One commit, root tree, nested tree and blob; no ancestor payload belongs here.
      assert.equal(inventory.length, 4, `copied objects at history depth ${depth}`);
      assert.deepEqual(inventory.filter((entry) => entry.object.type === "commit").map((entry) => entry.id), [candidate.commit]);
      assert.equal(scratch.refs.resolveHead(), candidate.commit);
      const index = history.indexOf(candidate.commit);
      assert.equal(readFileSync(join(workspace, "nested/state.txt"), "utf8"), String(index));
      assert.equal(trackedClean({ ...fixture, repository: scratch }), true);
      return { outcome: index >= culprit ? "bad" : "good" };
    }, { author: "fixture", now: () => new Date() });
    assert.equal(result.session.verdict?.kind, "first_bad");
    assert.equal(result.session.verdict.commit, history[culprit]);
    assert.ok(copied.length > 1);
    assert.equal(headCommit(fixture), bad);
    assert.equal(readFileSync(join(fixture.root, "nested/state.txt"), "utf8"), String(depth - 1));
    assert.equal(existsSync(join(fixture.repository.controlDirectory, "BISECT_WORKSPACE")), false);
    context.diagnostic(`${depth} commits: ${copied.length} candidates, ${copied.reduce((total, count) => total + count, 0)} copied objects, exactly 4 per candidate`);
  }
});

test("bisect reports skipped and untestable candidates as unresolved instead of guessing", async () => {
  const fixture = await setup();
  const countFile = join(fixture.root, "bisect-count-untestable.txt");
  const item = await linkedTestItem(fixture, "Untestable range", countFile);
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  const skipped = edit(fixture, "state.txt", "ok skipped", "skipped change");
  const untestable = edit(fixture, "state.txt", "untestable 1", "untestable change");
  edit(fixture, "state.txt", "untestable 2", "still untestable");
  const culprit = edit(fixture, "state.txt", "broken culprit", "breaks");
  edit(fixture, "state.txt", "broken stays", "stays broken");

  await fixture.bisect(["start", base, culprit], { item });
  // A manual skip of a middle candidate survives the automated walk.
  await fixture.bisect(["skip", skipped]);
  const ran = await fixture.bisect(["run"]);
  const done = (ran.result as { bisect: { verdict: { kind: string; commit: string; unresolved: { outcome: string; detail: string; commit: string }[] } } }).bisect;
  assert.equal(done.verdict.kind, "ambiguous");
  assert.equal(done.verdict.commit, culprit);
  const outcomes = done.verdict.unresolved.map((step) => step.outcome).sort();
  assert.deepEqual(outcomes, ["skip", "skip", "skip"]);
  assert.ok(done.verdict.unresolved.some((step) => step.detail === "exit 125"));
  assert.ok(done.verdict.unresolved.some((step) => step.commit === untestable));
  assert.equal(trackedClean(fixture), true);
  rmSync(countFile, { force: true });
});

test("bisect marks conflicted candidates without running the linked test", async () => {
  const fixture = await setup();
  const countFile = join(fixture.root, "bisect-count-conflicted.txt");
  const item = await linkedTestItem(fixture, "Conflicted candidate", countFile);
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  edit(fixture, "notes.txt", "shared\n", "first note");
  const branchPoint = headCommit(fixture);
  edit(fixture, "notes.txt", "main edit\n", "main edits the note");
  fixture.repository.createBranch("side", branchPoint, new Date());
  fixture.repository.switchTo("side", new Date());
  edit(fixture, "notes.txt", "side edit\n", "side edits the note");
  fixture.repository.switchTo("main", new Date());
  const merged = fixture.repository.merge("side", { message: "Merge side\n", author, recordConflicts: true }, new Date());
  assert.ok(!merged.clean, "the fixture merge must record a disagreement");
  const conflicted = headCommit(fixture);
  const culprit = edit(fixture, "state.txt", "broken conflicted", "breaks after the conflicted merge");
  edit(fixture, "state.txt", "broken stays", "stays broken");

  await fixture.bisect(["start", base, culprit], { item });
  const ran = await fixture.bisect(["run"]);
  const done = (ran.result as { bisect: { verdict: { kind: string; commit: string; unresolved: { outcome: string; commit: string }[] }; steps: { outcome: string; by: string; commit: string }[] } }).bisect;
  assert.equal(done.verdict.kind, "ambiguous");
  assert.equal(done.verdict.commit, culprit);
  assert.ok(done.verdict.unresolved.some((step) => step.outcome === "conflicted"));
  assert.equal(done.steps.find((step) => step.commit === conflicted)?.outcome, "conflicted");
  // The conflicted candidate never executed the linked test.
  assert.equal(done.steps.filter((step) => step.by === "run" && step.outcome !== "conflicted").length, runsRecorded(countFile));
  rmSync(countFile, { force: true });
});

test("an interrupted linked test halts the walk, stays resumable and finishes after the recorded test is repaired", async () => {
  const fixture = await setup();
  const countFile = join(fixture.root, "bisect-count-interrupt.txt");
  const item = await linkedTestItem(fixture, "Interrupted walk", countFile);
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  writeFileSync(join(fixture.root, "probe2.js"), PROBE2);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js", "probe2.js"], "base with both probes");
  for (let index = 0; index < 6; index += 1) edit(fixture, "state.txt", `hang ${index}`, `change ${index}`);
  const culprit = edit(fixture, "state.txt", "broken culprit", "breaks");
  edit(fixture, "state.txt", "broken stays", "stays broken");
  const bad = headCommit(fixture);

  await fixture.bisect(["start", base, bad], { item });
  const halted = await fixture.bisect(["run"]);
  const interrupted = (halted.result as { bisect: { status: string; halted: string; remaining: number; next: { commit: string } | null } }).bisect;
  assert.equal(interrupted.status, "active");
  assert.equal(interrupted.halted, "interrupted");
  assert.ok(interrupted.remaining > 0);
  assert.notEqual(interrupted.next, null);
  assert.equal(fixture.repository.refs.readHead().target, bad);
  assert.equal(trackedClean(fixture), true);
  assert.equal(storedSession(fixture)?.status, "active");
  const status = await fixture.bisect(["status"], { item });
  assert.equal((status.result as { sessions: { halted: string }[] }).sessions[0]?.halted, "interrupted");

  // Resuming with a repaired recorded test finishes the walk without retesting.
  await runTest(item, { updateIndex: "1", setJson: JSON.stringify({ env_set: { BISECT_REPAIRED: "1", BISECT_COUNT_FILE: countFile } }) }, { author: "agent-a", path: fixture.pmRoot });
  const resumed = await fixture.bisect(["run"]);
  const done = (resumed.result as { bisect: { status: string; verdict: { commit: string } } }).bisect;
  assert.equal(done.status, "done");
  assert.equal(done.verdict.commit, culprit);
  const runs = (done as unknown as { steps: { by: string }[] }).steps.filter((step) => step.by === "run");
  assert.equal(runsRecorded(countFile), runs.length);
  rmSync(countFile, { force: true });
});

test("a SIGINT between steps halts the walk, restores the original state and stays resumable", async () => {
  const fixture = await setup();
  const countFile = join(fixture.root, "bisect-count-signal.txt");
  const item = await linkedTestItem(fixture, "Signalled walk", countFile);
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  for (let index = 0; index < 8; index += 1) edit(fixture, "state.txt", `slow ${index}`, `change ${index}`);
  const culprit = edit(fixture, "state.txt", "broken culprit", "breaks");
  edit(fixture, "state.txt", "broken stays", "stays broken");
  const bad = headCommit(fixture);

  await fixture.bisect(["start", base, bad], { item });
  const walk = fixture.bisect(["run"]);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && runsRecorded(countFile) === 0) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  assert.ok(runsRecorded(countFile) > 0, "the linked test never started");
  process.kill(process.pid, "SIGINT");
  const halted = await walk;
  assert.equal((halted.result as { bisect: { halted: string } }).bisect.halted, "interrupted");
  const session = storedSession(fixture);
  assert.equal(session?.status, "active");
  assert.equal(fixture.repository.refs.readHead().target, bad);
  assert.equal(trackedClean(fixture), true);

  const resumed = await fixture.bisect(["run"]);
  const done = (resumed.result as { bisect: { status: string; verdict: { commit: string } } }).bisect;
  assert.equal(done.status, "done");
  assert.equal(done.verdict.commit, culprit);
  const runs = (done as unknown as { steps: { by: string }[] }).steps.filter((step) => step.by === "run");
  assert.equal(runsRecorded(countFile), runs.length);
  rmSync(countFile, { force: true });
});

test("a walk killed mid-flight resumes from the durable state without retesting judged changes", async () => {
  const fixture = await setup();
  const countFile = join(fixture.root, "bisect-count-crash.txt");
  const item = await linkedTestItem(fixture, "Crash resume", countFile);
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  for (let index = 0; index < 14; index += 1) edit(fixture, "state.txt", `slow ${index}`, `change ${index}`);
  const culprit = edit(fixture, "state.txt", "broken culprit", "breaks");
  edit(fixture, "state.txt", "broken stays", "stays broken");
  const bad = headCommit(fixture);
  await fixture.bisect(["start", base, bad], { item });

  installPackedExtension(fixture.root);
  const child = spawn(process.execPath, [pmExecutable, "vcs", "bisect", "run"], {
    cwd: fixture.root,
    stdio: "ignore",
    env: { ...testEnvironment(), ...discardChildCoverage(), PM_AUTHOR: "child-agent", PM_SOURCE_WORKSPACE_ROOT: fixture.root },
  });
  const statePath = join(fixture.root, ".pmvcs", "BISECT_STATE");
  const deadline = Date.now() + 120_000;
  let crashed = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    if (child.exitCode !== null) break;
    let steps = 0;
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { steps: { by: string }[]; pending?: unknown };
      steps = state.steps.length;
      if (state.pending === undefined || runsRecorded(countFile) <= state.steps.filter((step) => step.by === "run").length) continue;
    } catch {
      continue;
    }
    if (steps >= 3) {
      child.kill("SIGKILL");
      crashed = true;
      break;
    }
  }
  assert.ok(crashed, "the child never persisted a walk step");
  await new Promise((resolve) => { child.once("exit", resolve); });
  const abandoned = storedSession(fixture);
  assert.equal(abandoned?.status, "active");
  assert.ok((abandoned?.steps.length ?? 0) >= 3);
  const childRuns = (abandoned?.steps ?? []).filter((step) => step.by === "run").length;
  // Candidate workspaces never move the original checkout, even on SIGKILL.
  assert.equal(fixture.repository.refs.readHead().target, bad);

  const workerReceipt = join(fixture.root, ".pmvcs", "BISECT_WORKER");
  if (existsSync(workerReceipt)) {
    const refused = await fixture.bisect(["run"]);
    assert.match(refused.errorMessage ?? "", /Another bisect command or test worker/);
    const refusedReset = await fixture.bisect(["reset"]);
    assert.match(refusedReset.errorMessage ?? "", /Another bisect command or test worker/);
  }
  const workerDeadline = Date.now() + 60_000;
  while (existsSync(workerReceipt) && Date.now() < workerDeadline) await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(existsSync(workerReceipt), false, "orphaned SDK worker never finished");
  const resumed = await fixture.bisect(["run"]);
  const done = (resumed.result as { bisect: { status: string; verdict: { commit: string }; steps: { by: string }[] } }).bisect;
  assert.equal(done.status, "done");
  assert.equal(done.verdict.commit, culprit);
  const totalRuns = done.steps.filter((step) => step.by === "run").length;
  assert.ok(runsRecorded(countFile) <= totalRuns);
  assert.ok(totalRuns > childRuns, "the resume executed candidates of its own");
  assert.equal(fixture.repository.refs.readHead().target, bad);
  assert.equal(trackedClean(fixture), true);
  rmSync(countFile, { force: true });
});

test("a rewritten history reuses recorded results by stable change identity", async () => {
  const fixture = await setup();
  const countFile = join(fixture.root, "bisect-count-rewrite.txt");
  const item = await linkedTestItem(fixture, "Rewritten history", countFile);
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  const commits = [headCommit(fixture)];
  for (let index = 0; index < 6; index += 1) commits.push(edit(fixture, "state.txt", `ok ${index}`, `change ${index}`));
  const originalCulprit = edit(fixture, "state.txt", "broken culprit", "breaks");
  edit(fixture, "state.txt", "broken stays", "stays broken");
  const culpritChange = changeOf(fixture, originalCulprit);
  fixture.repository.refs.compareAndSwap("refs/tags/good-point", null, base);

  // Boundary revisions are names, so a rewritten branch keeps the session usable.
  await fixture.bisect(["start", "good-point", "main"], { item });
  const marked = (await fixture.bisect(["good", commits[3]])).result as { bisect: { steps: { changeId: string; by: string }[] } };
  const markedChange = changeOf(fixture, commits[3] as string);
  assert.equal(marked.bisect.steps.filter((step) => step.changeId === markedChange).length, 1);
  // A new bad tip and a reworded ancestor rewrite every candidate id.
  const movedTip = edit(fixture, "state.txt", "broken moved", "post-start commit");
  fixture.repository.describe(commits[1] as string, "reworded\n", author, new Date());
  const testedBeforeRewrite = runsRecorded(countFile);

  const resumed = await fixture.bisect(["run"]);
  const done = (resumed.result as { bisect: { status: string; verdict: { kind: string; change: string; commit: string }; steps: { by: string; changeId: string; outcome: string }[] } }).bisect;
  assert.equal(done.status, "done");
  assert.equal(done.verdict.kind, "first_bad");
  assert.equal(done.verdict.change, culpritChange);
  assert.notEqual(done.verdict.commit, originalCulprit);
  // The manually judged change was answered once, by identity, and never retested.
  assert.equal(done.steps.filter((step) => step.changeId === markedChange).length, 1);
  assert.equal(done.steps.find((step) => step.changeId === markedChange)?.by, "manual");
  // The moved bad boundary was re-declared under its new change identity.
  assert.ok(done.steps.some((step) => step.by === "boundary" && step.outcome === "bad" && step.changeId === changeOf(fixture, movedTip)));
  const runs = done.steps.filter((step) => step.by === "run");
  assert.equal(runsRecorded(countFile) - testedBeforeRewrite, runs.length);
  rmSync(countFile, { force: true });
});

test("manual verdicts conclude a walk and reset abandons it, recording both on PM history", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "Manual walk", author: "agent-a" })).item.id;
  await runTest(item, { add: ["command=node --version"] }, { author: "agent-a", path: fixture.pmRoot });
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  const first = edit(fixture, "state.txt", "ok first", "first interior change");
  const second = edit(fixture, "state.txt", "ok second", "second interior change");
  edit(fixture, "state.txt", "ok third", "third interior change");
  const bad = headCommit(fixture);

  await fixture.bisect(["start", base, bad], { item });
  const markedGood = await fixture.bisect(["good", first]);
  assert.equal((markedGood.result as { bisect: { remaining: number } }).bisect.remaining, 1);
  const markedBad = await fixture.bisect(["bad", second]);
  const done = (markedBad.result as { bisect: { status: string; verdict: { kind: string; commit: string; unresolved: unknown[] } } }).bisect;
  assert.equal(done.status, "done");
  assert.equal(done.verdict.kind, "first_bad");
  assert.equal(done.verdict.commit, second);
  assert.deepEqual(done.verdict.unresolved, []);

  const recorded = await comments(fixture, item);
  assert.ok(recorded.some((text) => text.startsWith("pm-vcs bisect done ")));
  for (const action of ["good", "run"]) {
    const refused = await fixture.bisect([action, first]);
    assert.match(refused.errorMessage ?? "", /is done/);
  }

  const reset = await fixture.bisect(["reset"]);
  assert.equal((reset.result as { reset: { session: string; restored: { commit: string } } }).reset.restored.commit, bad);
  assert.equal(storedSession(fixture), null);
  assert.equal(fixture.repository.refs.readHead().target, bad);
  const after = await comments(fixture, item);
  assert.ok(after.some((text) => text.startsWith("pm-vcs bisect reset ")));
});

test("bisect status reports the local session and skips malformed records from other agents", async () => {
  const fixture = await setup();
  const otherItem = (await fixture.client.create({ type: "Task", title: "Foreign malformed record", author: "agent-a" })).item.id;
  // A malformed milestone comment must not break the listing of every session.
  await fixture.client.comments(otherItem, { add: "pm-vcs bisect done {not json", author: "agent-a" });
  await fixture.client.comments(otherItem, { add: "pm-vcs bisect nonsense {}", author: "agent-a" });
  await fixture.client.comments(otherItem, { add: "pm-vcs bisect ", author: "agent-a" });
  const item = (await fixture.client.create({ type: "Task", title: "Status walk", author: "agent-a" })).item.id;
  await runTest(item, { add: ["command=node --version"] }, { author: "agent-a", path: fixture.pmRoot });
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  edit(fixture, "state.txt", "broken culprit", "breaks");
  const bad = headCommit(fixture);
  await fixture.client.comments(otherItem, { add: "pm-vcs bisect done {}", author: "agent-a" });

  const empty = await fixture.bisect(["status"]);
  assert.equal((empty.result as { bisect: unknown }).bisect, undefined);
  assert.deepEqual((empty.result as { sessions: unknown[] }).sessions, []);

  await fixture.bisect(["start", base, bad], { item });
  const listing = await fixture.bisect(["status"]);
  const reported = (listing.result as { bisect: { session: string }; sessions: { session: string; item: string; status: string; steps: number }[] });
  assert.equal(reported.bisect.session, storedSession(fixture)?.id);
  assert.equal(reported.sessions.length, 1);
  assert.equal(reported.sessions[0]?.item, item);
  assert.equal(reported.sessions[0]?.status, "active");
  assert.equal(reported.sessions[0]?.steps, 2);

  const filtered = await fixture.bisect(["status"], { item: otherItem });
  const other = (filtered.result as { bisect: unknown; sessions: unknown[] });
  assert.equal(other.bisect, undefined);
  assert.deepEqual(other.sessions, []);
});

test("bisect refuses every action it cannot take honestly, naming the recovery", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "Refusals", author: "agent-a" })).item.id;
  await runTest(item, { add: ["command=node --version"] }, { author: "agent-a", path: fixture.pmRoot });
  const noTestItem = (await fixture.client.create({ type: "Task", title: "No test", author: "agent-a" })).item.id;
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  edit(fixture, "state.txt", "ok first", "first change");
  edit(fixture, "state.txt", "broken culprit", "breaks");
  const bad = headCommit(fixture);

  const unknown = await fixture.bisect(["teleport"]);
  assert.match(unknown.errorMessage ?? "", /Unknown bisect action "teleport"/);
  const bare = await fixture.bisect([]);
  assert.match(bare.errorMessage ?? "", /Unknown bisect action/);

  for (const action of ["good", "bad", "skip", "run", "reset"]) {
    const missing = await fixture.bisect([action]);
    assert.match(missing.errorMessage ?? "", /needs an active bisect session/);
  }

  const noItem = await fixture.bisect(["start", base, bad]);
  assert.match(noItem.errorMessage ?? "", /needs the PM item/);
  const noTest = await fixture.bisect(["start", base, bad], { item: noTestItem });
  assert.match(noTest.errorMessage ?? "", /records no linked test/);
  const emptyRange = await fixture.bisect(["start", bad, bad], { item });
  assert.match(emptyRange.errorMessage ?? "", /No changes sit between/);
  const missingBoundaries = await fixture.bisect(["start", base], { item });
  assert.match(missingBoundaries.errorMessage ?? "", /requires a bad revision/);

  // A dirty tracked tree and a private layer refuse before starting anything.
  writeFileSync(join(fixture.root, "state.txt"), "uncommitted edit\n");
  const dirty = await fixture.bisect(["start", base, bad], { item });
  assert.match(dirty.errorMessage ?? "", /starts from a clean tracked tree/);
  fixture.repository.restore(["state.txt"], bad);
  fixture.repository.addLayer("overlay", new Map([["overlay.bin", { content: Buffer.from("private"), executable: false }]]));
  const layered = await fixture.bisect(["start", base, bad], { item });
  assert.match(layered.errorMessage ?? "", /Private layers cannot coexist/);
  fixture.repository.removeLayer("overlay");

  await fixture.bisect(["start", base, bad], { item });
  const outside = await fixture.bisect(["good", fixture.repository.commit({ message: "outside", author, allowEmpty: true }, new Date())]);
  assert.match(outside.errorMessage ?? "", /outside this session/);
  const again = await fixture.bisect(["start", base, bad], { item });
  assert.match(again.errorMessage ?? "", /already active/);

  // An unborn HEAD refuses before any boundary is even resolved.
  const unborn = await setup();
  const unbornItem = (await unborn.client.create({ type: "Task", title: "Unborn", author: "agent-a" })).item.id;
  await runTest(unbornItem, { add: ["command=node --version"] }, { author: "agent-a", path: unborn.pmRoot });
  const refused = await unborn.bisect(["start", "main", "main"], { item: unbornItem });
  assert.match(refused.errorMessage ?? "", /needs a repository with commits/);
});

test("runner failure leaves original bytes, index and HEAD unchanged and preserves a pending candidate", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Runner failure", join(fixture.root, "count.txt"));
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "probe");
  const culprit = edit(fixture, "state.txt", "broken culprit", "culprit");
  const bad = edit(fixture, "state.txt", "broken tip", "tip");
  await fixture.bisect(["start", base, bad], { item });
  const session = storedSession(fixture)!;
  const index = readFileSync(join(fixture.root, ".pmvcs", "index"));
  await assert.rejects(runBisect(fixture.repository, session, async (_candidate, workspace) => {
    writeFileSync(join(workspace, "state.txt"), "test side effect");
    throw new Error("runner failed");
  }, { author: "agent-a", now: () => new Date() }), /runner failed/);
  assert.ok(storedSession(fixture)?.pending);
  assert.equal(fixture.repository.refs.readHead().target, bad);
  assert.equal(readFileSync(join(fixture.root, "state.txt"), "utf8"), "broken tip");
  assert.deepEqual(readFileSync(join(fixture.root, ".pmvcs", "index")), index);
  const result = await fixture.bisect(["run"]);
  assert.equal((result.result as { bisect: { verdict: { commit: string } } }).bisect.verdict.commit, culprit);
  assert.ok(storedSession(fixture)?.steps.some((step) => step.retry && step.detail?.includes("previous process")));
});

test("bisect shallow boundaries retain both merge parents without reading their absent ancestors", async () => {
  const fixture = await setup();
  const store = fixture.repository.objects;
  const ancestor = edit(fixture, "state.txt", "old", "omitted ancestor");
  const good = edit(fixture, "state.txt", "good", "good boundary");
  const tree = readCommit(store, good).tree;
  const side = writeCommit(store, { tree, parents: [ancestor], author, committer: author, message: "side boundary" });
  const bad = writeCommit(store, { tree, parents: [good, side], author, committer: author, message: "merge" });
  fixture.repository.refs.compareAndSwap("refs/heads/main", good, bad);
  const destination = join(fixture.root, "shallow-clone");
  await cloneFrom(fixture.root, destination, new Date(), "origin", fixture.root, undefined, { depth: 2 });
  const clone = Repository.open(destination);
  assert.equal(clone.objects.has(ancestor), false);
  assert.deepEqual(new Set(clone.objects.partialState()!.shallow), new Set([good, side]));
  const candidates = bisectCandidates(clone.objects, good, bad);
  assert.deepEqual(candidates.map((candidate) => candidate.commit), [side, bad]);
  assert.equal(selectBisectCandidate(clone.objects, candidates, new Set([side]))?.commit, side);
  assert.equal(clone.objects.has(ancestor), false, "range decisions must not hydrate omitted history");
});

test("shallow culprit reports preserve explicit links after manual bad, run and status", async () => {
  for (const mode of ["bad", "run"]) {
    const source = await setup();
    const ancestor = edit(source, "state.txt", "old", "omitted ancestor");
    writeFileSync(join(source.root, "probe.js"), PROBE);
    const good = commitFiles(source, ["probe.js"], "good boundary");
    const broken = source.repository.objects.write("blob", Buffer.from("broken side"));
    const entries = new Map(flattenTree(source.repository.objects, readCommit(source.repository.objects, good).tree));
    entries.set("state.txt", { ...entries.get("state.txt")!, id: broken });
    const tree = buildTree(source.repository.objects, entries);
    const side = writeCommit(source.repository.objects, { tree, parents: [ancestor], author, committer: author, message: "shallow culprit", items: ["explicit-z", "explicit-a", "explicit-z"] });
    const bad = writeCommit(source.repository.objects, { tree, parents: [good, side], author, committer: author, message: "merge" });
    source.repository.refs.compareAndSwap("refs/heads/main", good, bad);
    const destination = join(source.root, "clone");
    await cloneFrom(source.root, destination, new Date(), "origin", source.root, undefined, { depth: 2 });
    const fixture = await setup(destination);
    const item = await linkedTestItem(fixture, "Shallow diagnosis", join(fixture.root, "count.txt"));
    const owner = (await fixture.client.create({ type: "Task", title: "Unproven file owner", author: "fixture" })).item.id;
    await fixture.client.files(owner, { add: ["state.txt"], author: "fixture" });
    assert.equal(fixture.repository.objects.has(ancestor), false);
    assert.equal((await fixture.bisect(["start", good, bad], { item })).errorMessage, undefined);
    for (const args of [mode === "bad" ? ["bad", side] : ["run"], ["status"]]) {
      const result = await fixture.bisect(args);
      assert.equal(result.errorMessage, undefined);
      const report = (result.result as { bisect: BisectReport }).bisect;
      assert.equal(report.status, "done");
      assert.equal(report.verdict!.commit, side);
      assert.deepEqual(report.verdict!.items, ["explicit-a", "explicit-z"]);
      assert.equal(report.verdict!.itemsBoundary, "shallow");
    }
    assert.equal(fixture.repository.objects.has(ancestor), false, "reporting must not hydrate omitted history");
    assert.equal(headCommit(fixture), bad);
    assert.equal((await fixture.bisect(["reset"])).errorMessage, undefined);
  }
});

test("bisect denied candidate checkout records untestable once and finishes without running its test", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Denied candidate", join(fixture.root, "count.txt"));
  const good = fixture.repository.commit({ message: "empty good", author, allowEmpty: true }, new Date());
  const denied = edit(fixture, "state.txt", "erased fixture payload", "denied candidate");
  const bad = fixture.repository.commit({ message: "bad tip", author, allowEmpty: true }, new Date());
  fixture.repository.setAuthority("fixture", "read-fixture", "erase-fixture");
  fixture.repository.obliterate("state.txt", "erase-fixture", "incident", new Date());
  assert.equal((await fixture.bisect(["start", good, bad], { item })).errorMessage, undefined);
  const index = readFileSync(join(fixture.repository.controlDirectory, "index"));
  let runs = 0;
  const runner = async () => { runs++; return { outcome: "good" as const }; };
  const result = await runBisect(fixture.repository, storedSession(fixture)!, runner, {
    author: "fixture", now: () => new Date(),
    progress: async (session) => { assert.deepEqual(storedSession(fixture), JSON.parse(JSON.stringify(session))); },
  });
  assert.equal(runs, 0);
  assert.equal(result.session.status, "done");
  assert.equal(result.session.pending, undefined);
  assert.equal(result.remaining, 0);
  assert.equal(result.next, null);
  assert.equal(result.session.verdict?.kind, "ambiguous");
  const step = result.session.steps.find((entry) => entry.commit === denied)!;
  assert.equal(step.outcome, "untestable");
  assert.equal(step.retry, undefined);
  assert.equal(step.detail, "candidate could not be materialized: object_not_found");
  assert.deepEqual(result.session.verdict?.unresolved, [step]);
  const repeated = await runBisect(fixture.repository, result.session, runner, { author: "fixture", now: () => new Date() });
  assert.deepEqual(repeated.session.steps, result.session.steps);
  assert.equal(runs, 0);
  assert.equal(headCommit(fixture), bad);
  assert.deepEqual(readFileSync(join(fixture.repository.controlDirectory, "index")), index);
  assert.equal(existsSync(join(fixture.root, "state.txt")), false);
  assert.equal(existsSync(join(fixture.repository.controlDirectory, "BISECT_WORKSPACE")), false);
});

test("bisect preserves retry behavior for unexpected checkout errors and typed runner errors", async (context) => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Retry failures", join(fixture.root, "count.txt"));
  const good = edit(fixture, "state.txt", "good", "good");
  const middle = edit(fixture, "state.txt", "middle", "middle");
  const bad = edit(fixture, "state.txt", "bad", "bad");
  await fixture.bisect(["start", good, bad], { item });
  const session = storedSession(fixture)!;
  const options = { author: "fixture", now: () => new Date() };
  const unexpected = new Error("unexpected checkout failure");
  const init = context.mock.method(Repository, "init", () => { throw unexpected; });
  try {
    await assert.rejects(runBisect(fixture.repository, session, async () => { assert.fail("checkout failed before runner"); }, options), (error) => error === unexpected);
  } finally { init.mock.restore(); }
  assert.equal(storedSession(fixture)?.pending?.commit, middle);
  const runnerError = new ObjectStoreError("fixture_runner", "typed runner failure");
  await assert.rejects(runBisect(fixture.repository, storedSession(fixture)!, async () => { throw runnerError; }, options), (error) => error === runnerError);
  assert.equal(storedSession(fixture)?.pending?.commit, middle);
  assert.ok(storedSession(fixture)?.steps.some((step) => step.retry));
  assert.equal(headCommit(fixture), bad);
  assert.equal(existsSync(join(fixture.repository.controlDirectory, "BISECT_WORKSPACE")), false);
});

test("tracked and root trackers keep authoritative history while candidate trees are disposable", async () => {
  // The entire current tracker is authoritative even when historical candidates carry it too.
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Tracked tracker", join(fixture.root, "bisect-count-tracked.txt"));
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  writeFileSync(join(fixture.pmRoot, "fixture.txt"), "tracker content that is tracked\n");
  const base = edit(fixture, "state.txt", "ok", "base");
  execFileSync(process.execPath, [pmExecutable, "--no-extensions", "update", item, "--description", "Historical provenance"], {
    cwd: fixture.root, env: { ...testEnvironment(), ...discardChildCoverage(), PM_AUTHOR: "fixture", CODEX_CI: "1", PM_AGENT_MODEL: "fixture-model", PM_AGENT_PROBES: "0" },
  });
  commitFiles(fixture, [], "base with the complete tracker tracked");
  edit(fixture, "state.txt", "ok interior", "interior");
  edit(fixture, "state.txt", "broken culprit", "breaks", [item]);
  const bad = headCommit(fixture);
  await fixture.bisect(["start", base, bad], { item });
  assert.equal((await comments(fixture, item)).length, 1);
  const trackedRun = await fixture.bisect(["run"]);
  assert.equal((trackedRun.result as { bisect: { status: string } }).bisect.status, "done");
  const provenance = (trackedRun.result as { bisect: { verdict: { agentHarness: string; agentModel: string } } }).bisect.verdict;
  assert.equal(provenance.agentHarness, "codex");
  assert.equal(provenance.agentModel, "fixture-model");
  const trackedComments = await comments(fixture, item);
  assert.equal(trackedComments.filter((text) => text.startsWith("pm-vcs bisect done ")).length, 1);
  rmSync(join(fixture.root, "bisect-count-tracked.txt"), { force: true });

  // A tracker rooted at the repository itself also retains every milestone.
  const rootTracker = await setup();
  const rootPm = new PmClient({ pmRoot: rootTracker.root, cwd: rootTracker.root, noExtensions: true });
  await rootPm.init("test", { defaults: true, author: "agent-a" });
  const rootItem = (await rootPm.create({ type: "Task", title: "Root tracker", author: "agent-a" })).item.id;
  await runTest(rootItem, { add: ["command=node --version"] }, { author: "agent-a", path: rootTracker.root });
  writeFileSync(join(rootTracker.root, "probe.js"), PROBE);
  const rootBase = edit(rootTracker, "state.txt", "ok", "base");
  commitFiles(rootTracker, ["probe.js"], "base with probe");
  edit(rootTracker, "state.txt", "broken", "breaks");
  const rootBad = headCommit(rootTracker);
  const run = async (args: readonly string[], options: Record<string, unknown> = {}, global: Record<string, unknown> = {}) => rootTracker.harness.runCommand({
    command: "vcs bisect", args, options, global, pmRoot: rootTracker.root,
  }) as Promise<{ result: unknown; errorMessage: string | undefined }>;
  const rootStarted = await run(["start", rootBase, rootBad], { item: rootItem }, { author: "root-agent" });
  assert.equal(rootStarted.errorMessage, undefined);
  assert.equal((await rootPm.comments(rootItem, { limit: "50" })).comments.length, 1);
  const rootRun = await run(["run"], {}, { author: "root-agent" });
  assert.equal((rootRun.result as { bisect: { status: string } }).bisect.status, "done");
  assert.ok((await rootPm.comments(rootItem, { limit: "50" })).comments.length >= 3);
  const unauthored = await run(["status"]);
  assert.equal((unauthored.result as { sessions: { startedBy: string }[] }).sessions[0]?.startedBy, "root-agent");
});

test("engine primitives handle empty candidate sets and unknown ranges", async () => {
  const fixture = await setup();
  const repository = fixture.repository;
  const base = repository.commit({ message: "base", author, allowEmpty: true }, new Date());
  const next = repository.commit({ message: "next", author, allowEmpty: true }, new Date());
  assert.throws(() => bisectCandidates(repository.objects, next, base), /No changes sit between/);
  assert.throws(() => bisectCandidates(repository.objects, base, base), /No changes sit between/);
  assert.deepEqual(bisectCandidates(repository.objects, base, next).map((candidate) => candidate.commit), [next]);
  assert.equal(selectBisectCandidate(repository.objects, [], new Set()), null);
  assert.deepEqual(bisectVerdict(repository.objects, [{ commit: next, changeId: changeOf(fixture, next) }], bisectVerdicts([])), { kind: "no_bad_change", unresolved: [] });
});

test("a corrupt session state refuses honestly", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "Corrupt state", author: "agent-a" })).item.id;
  await runTest(item, { add: ["command=node --version"] }, { author: "agent-a", path: fixture.pmRoot });
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  edit(fixture, "state.txt", "broken culprit", "breaks");
  const bad = headCommit(fixture);
  writeFileSync(join(fixture.root, ".pmvcs", "BISECT_STATE"), "{not json");
  const refused = await fixture.bisect(["status"]);
  assert.match(refused.errorMessage ?? "", /not valid JSON/);
});

test("verdict folding distinguishes assertion failures from every way a test could not run", () => {
  const run = (patch: Partial<TestRunResult>): TestRunResult => ({ status: "failed", ...patch }) as TestRunResult;
  assert.deepEqual(classifyRuns([run({ exit_code: 126 })]), { outcome: "untestable", detail: "exit 126" });
  assert.deepEqual(classifyRuns([run({ exit_code: 127 })]), { outcome: "untestable", detail: "exit 127" });
  assert.deepEqual(classifyRuns([run({ exit_code: undefined })]), { outcome: "untestable", detail: "assertion_failure without an exit code" });
  assert.deepEqual(classifyRuns([]), { outcome: "untestable", detail: "the linked test selected nothing to run" });
  assert.deepEqual(classifyRuns([run({ status: "passed", exit_code: 0 })]), { outcome: "good" });
  assert.deepEqual(classifyRuns([run({ status: "failed", exit_code: 1, failure_category: "assertion_failure" })]), { outcome: "bad", detail: "exit 1" });
  assert.deepEqual(classifyRuns([run({ status: "failed", exit_code: 1 })]), { outcome: "bad", detail: "exit 1" });
  assert.deepEqual(classifyRuns([run({ status: "failed", exit_code: 125, failure_category: "assertion_failure" })]), { outcome: "skip", detail: "exit 125" });
  assert.deepEqual(classifyRuns([run({ status: "failed", exit_code: 130, failure_category: "assertion_failure" })]),
    { outcome: "untestable", detail: "assertion_failure (exit 130)", interrupted: true });
  assert.deepEqual(classifyRuns([run({ status: "failed", exit_code: null, failure_category: "spawn_error" })]), { outcome: "untestable", detail: "spawn_error without an exit code" });
  assert.deepEqual(classifyRuns([run({ status: "failed", exit_code: 1, failure_category: "timeout" })]), { outcome: "untestable", detail: "timeout" });
  assert.deepEqual(classifyRuns([run({ status: "refused" })]), { outcome: "untestable", detail: "refused" });
  assert.deepEqual(classifyRuns([run({ status: "skipped", error: "filtered" })]), { outcome: "untestable", detail: "skipped: filtered" });
  assert.deepEqual(classifyRuns([run({ status: "failed", exit_code: 1, failure_category: "assertion_failure" }), run({ status: "refused" })]),
    { outcome: "bad", detail: "exit 1" });
  assert.deepEqual(classifyRuns([run({ status: "refused" }), run({ status: "failed", exit_code: 130, failure_category: "assertion_failure" })]),
    { outcome: "untestable", detail: "assertion_failure (exit 130)", interrupted: true });
  assert.deepEqual(classifyRuns([run({ status: "passed", exit_code: 0 }), run({ status: "refused" })]), { outcome: "untestable", detail: "refused" });
});

test("a session whose bad boundary is judged good concludes with no bad change", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "Inverted walk", author: "agent-a" })).item.id;
  await runTest(item, { add: ["command=node --version"] }, { author: "agent-a", path: fixture.pmRoot });
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "base with probe");
  edit(fixture, "state.txt", "ok interior", "interior");
  const bad = headCommit(fixture);
  await fixture.bisect(["start", base, bad], { item });
  const inverted = await fixture.bisect(["good", "HEAD"]);
  const done = (inverted.result as { bisect: { status: string; verdict: { kind: string; items: string[]; unresolved: unknown[] } } }).bisect;
  assert.equal(done.status, "done");
  assert.equal(done.verdict.kind, "no_bad_change");
  assert.deepEqual(done.verdict.items, []);
  assert.deepEqual(done.verdict.unresolved, []);
  const status = await fixture.bisect(["status"]);
  assert.equal((status.result as { sessions: { verdict: { kind: string } }[] }).sessions[0]?.verdict.kind, "no_bad_change");
});

afterEach(() => {
  assert.equal(process.listenerCount("SIGINT"), baselineListeners, "the bisect walk left a SIGINT listener installed");
});
test("bisect leases reject live and unknown owners and recover a dead owner", async () => {
  const fixture = await setup();
  const path = join(fixture.root, ".pmvcs", "BISECT_LOCK");
  await withBisectLease(fixture.repository, async () => {
    await assert.rejects(withBisectLease(fixture.repository, async () => true), /Another bisect command/);
  });
  writeFileSync(path, "unknown");
  await assert.rejects(withBisectLease(fixture.repository, async () => true), /Unknown bisect lock/);
  writeFileSync(path, "0");
  await assert.rejects(withBisectLease(fixture.repository, async () => true), /Unknown bisect lock/);
  writeFileSync(path, "9007199254740991");
  await assert.rejects(withBisectLease(fixture.repository, async () => true), /range|integer|pid/i);
  const child = spawn(process.execPath, ["-e", ""], { env: testEnvironment(), stdio: "ignore" });
  await new Promise<void>((resolve) => { child.once("exit", () => { resolve(); }); });
  writeFileSync(path, String(child.pid));
  assert.equal(await withBisectLease(fixture.repository, async () => "recovered"), "recovered");
  assert.equal(existsSync(path), false);
});

test("two linked instances retain independent sessions visible in shared PM history", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Shared diagnosis", join(fixture.root, "count.txt"));
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "probe");
  edit(fixture, "state.txt", "ok middle", "middle");
  const culprit = edit(fixture, "state.txt", "broken culprit", "culprit");
  const bad = edit(fixture, "state.txt", "broken tip", "tip");
  const second = makeTempDir();
  owned.push(second);
  fixture.repository.linkInstance("agent-b", second.root);
  const other = Repository.open(second.root);
  const otherHarness = await activate();
  const invoke = async (args: readonly string[], options = {}) => {
    process.env.PM_SOURCE_WORKSPACE_ROOT = second.root;
    const handler = otherHarness.activation.commands.handlers.find((entry) => entry.command === "vcs bisect")!;
    const result = await handler.run({ command: "vcs bisect", args: [...args], options: { full: true, ...options }, pm_root: fixture.pmRoot,
      source_workspace_root: second.root, repo_root: second.root, global: { author: "agent-b" } });
    return { result };
  };
  const first = await fixture.bisect(["start", base, bad], { item }, { author: "agent-a" });
  const firstId = (first.result as { bisect: { session: string } }).bisect.session;
  const next = await invoke(["start", base, bad], { item });
  const secondId = (next.result as { bisect: { session: string } }).bisect.session;
  assert.notEqual(firstId, secondId);
  const listing = await invoke(["status"]);
  const sessions = (listing.result as { sessions: { session: string; startedBy: string }[] }).sessions;
  assert.equal(sessions.length, 2);
  assert.deepEqual(new Set(sessions.map((session) => session.startedBy)), new Set(["agent-a", "agent-b"]));
  const done = await invoke(["run"]);
  assert.equal((done.result as { bisect: { verdict: { commit: string } } }).bisect.verdict.commit, culprit);
  assert.equal(readBisectSession(other)?.status, "done");
  assert.equal(storedSession(fixture)?.status, "active");
  const retained = readFileSync(join(fixture.root, ".pmvcs", "BISECT_STATE"), "utf8");
  await invoke(["reset"]);
  assert.equal(readBisectSession(other), null);
  assert.equal(readFileSync(join(fixture.root, ".pmvcs", "BISECT_STATE"), "utf8"), retained);
  process.env.PM_SOURCE_WORKSPACE_ROOT = fixture.root;
  const firstDone = await fixture.bisect(["run"]);
  assert.equal((firstDone.result as { bisect: { verdict: { commit: string } } }).bisect.verdict.commit, culprit);
  const complete = await fixture.bisect(["status"]);
  const final = (complete.result as { sessions: { session: string; status: string }[] }).sessions;
  assert.equal(final.find((session) => session.session === firstId)?.status, "done");
  assert.equal(final.find((session) => session.session === secondId)?.status, "abandoned");
});

test("installed CLI emits complete JSON and budgeted TOON reports for the linked test", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Installed contract", join(fixture.root, "count.txt"));
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "probe");
  const culprit = edit(fixture, "state.txt", "broken culprit", "culprit", [item]);
  edit(fixture, "state.txt", "broken tip", "tip");
  installPackedExtension(fixture.root);
  const run = (args: string[]) => execFileSync(process.execPath, [pmExecutable, ...args], {
    cwd: fixture.root, encoding: "utf8", env: { ...testEnvironment(), PM_AUTHOR: "installed-agent" },
  });
  run(["vcs", "bisect", "start", base, "main", "--item", item, "--json"]);
  const result = JSON.parse(run(["vcs", "bisect", "run", "--json", "--full"])) as { bisect: { verdict: { commit: string; items: string[] } } };
  assert.equal(result.bisect.verdict.commit, culprit);
  assert.ok(result.bisect.verdict.items.includes(item));
  const compact = JSON.parse(run(["vcs", "bisect", "status", "--json"])) as { bisect: BisectReport };
  assert.equal(compact.bisect.verdict!.commit, culprit.slice(0, 12));
  const toon = run(["vcs", "bisect", "status", "--budget", "1600"]);
  assert.match(toon, /bisect:/);
  assert.match(toon, /first_bad/);
  run(["vcs", "bisect", "reset", "--json"]);
});

test("a linked test whose PM item disappeared is explicitly untestable and never bad", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Unavailable test", join(fixture.root, "count.txt"));
  const base = edit(fixture, "state.txt", "ok", "base");
  edit(fixture, "state.txt", "middle", "middle");
  const bad = edit(fixture, "state.txt", "bad", "bad");
  await fixture.bisect(["start", base, bad], { item }, {});
  // The real tracker still exists, but the previously linked item is unavailable.
  rmSync(join(fixture.pmRoot, "tasks", `${item}.toon`));
  const session = storedSession(fixture)!;
  // Progress publishing also fails, retaining the explicit local outcome for inspection.
  await assert.rejects(fixture.bisect(["run"]), /not found/);
  const state = storedSession(fixture)!;
  assert.equal(state.steps[0]?.author, "pm-vcs");
  assert.equal(state.steps.filter((step) => step.by === "run").length, 1);
  assert.equal(state.steps.at(-1)?.outcome, "untestable");
  assert.match(state.steps.at(-1)?.detail ?? "", /test runner exited/);
  assert.equal(fixture.repository.refs.resolveHead(), bad);
  assert.equal(session.status, "active");
});

test("state decoding, read errors and a signal during progress preserve recoverability", async () => {
  for (const text of ["null", "{}", '{"version":1}', '{"version":1,"id":"bisect-id"}']) assert.throws(() => decodeBisectSession(text), /invalid bisect session/);
  const fixture = await setup();
  const path = join(fixture.root, ".pmvcs", "BISECT_STATE");
  mkdirSync(path);
  assert.throws(() => readBisectSession(fixture.repository), /EISDIR/);
  rmSync(path, { recursive: true });
  const item = await linkedTestItem(fixture, "Signal between candidates", join(fixture.root, "count.txt"));
  const base = edit(fixture, "state.txt", "ok", "base");
  edit(fixture, "state.txt", "ok next", "next");
  edit(fixture, "state.txt", "ok later", "later");
  edit(fixture, "state.txt", "bad", "tip");
  const started = await fixture.bisect(["start", base, "main"], { item });
  assert.equal(started.errorMessage, undefined);
  const state = storedSession(fixture)!;
  const halted = await runBisect(fixture.repository, state, async (_candidate, workspace) => {
    assert.match(readFileSync(join(workspace, "state.txt"), "utf8"), /ok/);
    return { outcome: "good" };
  }, { author: "unit", now: () => new Date(), progress: async () => { process.emit("SIGINT"); } });
  assert.equal(halted.session.halted, "interrupted");
  const resumed = await runBisect(fixture.repository, halted.session, async () => ({ outcome: "good" }), { author: "unit", now: () => new Date() });
  assert.equal(resumed.session.status, "done");
  assert.equal(fixture.repository.refs.resolveHead(), state.original.commit);
});

test("detached sessions and simultaneous historical milestones have deterministic status", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Detached diagnosis", join(fixture.root, "count.txt"));
  const base = edit(fixture, "state.txt", "ok", "base");
  edit(fixture, "state.txt", "next", "next");
  const bad = edit(fixture, "state.txt", "tip", "tip");
  fixture.repository.switchTo(bad, new Date());
  await fixture.bisect(["start", base, bad], { item });
  assert.equal(storedSession(fixture)?.original.branch, null);
  await fixture.bisect(["good", base]);
  const state = storedSession(fixture)!;
  for (const id of ["bisect-b", "bisect-a"]) await fixture.client.comments(item, { add: `pm-vcs bisect start ${JSON.stringify({ ...state, id, startedAt: "2000-01-01T00:00:00.000Z" })}`, author: "other" });
  const status = await fixture.bisect(["status"], { item });
  const sessions = (status.result as { sessions: { session: string }[] }).sessions;
  assert.deepEqual(sessions.slice(0, 2).map((session) => session.session), ["bisect-a", "bisect-b"]);
  await fixture.bisect(["reset"]);
  assert.equal(fixture.repository.refs.readHead().kind, "detached");
});

test("budgeted reports expose log omissions while retaining complete durable observations", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Budgeted history", join(fixture.root, "count.txt"));
  const base = edit(fixture, "state.txt", "ok", "base");
  const middle = edit(fixture, "state.txt", "next", "next");
  const bad = fixture.repository.commit({ message: "empty known-bad change", author, allowEmpty: true }, new Date());
  const invalid = await fixture.bisect(["start", base, bad], { item, budget: 1 });
  assert.match(invalid.errorMessage ?? "", /at least 256/);
  const nonnumeric = await fixture.bisect(["status"], { budget: "invalid" });
  assert.match(nonnumeric.errorMessage ?? "", /at least 256/);
  assert.equal(storedSession(fixture), null);
  await fixture.bisect(["start", base, bad], { item });
  await fixture.bisect(["skip", middle]);
  const status = await fixture.bisect(["status"], { budget: 256 });
  const report = (status.result as { bisect: { steps: unknown[]; stepsOmitted: number; stepsTaken: number } }).bisect;
  assert.ok(report.stepsOmitted > 0);
  assert.equal(report.stepsTaken, storedSession(fixture)?.steps.length);
  assert.equal(report.steps.length + report.stepsOmitted, report.stepsTaken);
  const full = await fixture.bisect(["status"], { budget: 16000 });
  assert.equal((full.result as { bisect: { stepsOmitted: number } }).bisect.stepsOmitted, 0);
});

test("legacy commits without file identities still report explicit PM associations", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Legacy regression", join(fixture.root, "count.txt"));
  const base = fixture.repository.commit({ message: "base", author, allowEmpty: true }, new Date());
  const blob = fixture.repository.objects.write("blob", Buffer.from("legacy contents"));
  const tree = buildTree(fixture.repository.objects, new Map([["legacy.txt", { id: blob, mode: "100644" as const }]]));
  const bad = writeCommit(fixture.repository.objects, { tree, parents: [base], author, committer: author, message: "legacy regression", items: [item] });
  fixture.repository.refs.compareAndSwap("refs/heads/main", base, bad);
  fixture.repository.materialize(tree);
  await fixture.bisect(["start", base, bad], { item });
  const result = await fixture.bisect(["run"]);
  const verdict = (result.result as { bisect: { verdict: { commit: string; items: string[] } } }).bisect.verdict;
  assert.equal(verdict.commit, bad);
  assert.deepEqual(verdict.items, [item]);
});

test("a worker cannot run before its owner receipt is published", async () => {
  const fixture = await setup();
  const count = join(fixture.root, "count.txt");
  const item = await linkedTestItem(fixture, "Unauthorized worker", count);
  const failure = await runCandidateTest(item, "agent", fixture.pmRoot, fixture.root, join(fixture.root, "missing-control"));
  assert.equal(failure.outcome, "untestable");
  assert.match(failure.detail ?? "", /ENOENT/);
  assert.equal(runsRecorded(count), 0);
  assert.throws(() => execFileSync(process.execPath, [join(packageRoot, "bisect-test-runner.ts"), item, "agent", fixture.pmRoot, join(fixture.root, "receipt")],
    { input: "", stdio: ["pipe", "pipe", "pipe"], env: { ...testEnvironment(), PM_SOURCE_WORKSPACE_ROOT: fixture.root } }), /not authorized/);
});

test("an early worker exit with a broken stdin pipe is untestable without crashing the parent", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Early exit", join(fixture.root, "count.txt"));
  // Run in a separate parent so an uncaught EPIPE is observed as a process failure.
  // The worker exits during preload, and receipt publication waits for that exit
  // before writing authorization to the real pipe. No SDK behavior is mocked.
  const script = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { runCandidateTest } from ${JSON.stringify(new URL("../bisect-commands.ts", import.meta.url).href)};
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = (...args) => {
      if (String(args[0]).endsWith("BISECT_WORKER")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      return originalWrite(...args);
    };
    syncBuiltinESMExports();
    process.env.NODE_OPTIONS = "--import=data:text/javascript,process.exit(42)";
    console.log(JSON.stringify(await runCandidateTest(...process.argv.slice(1))));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, item, "fixture", fixture.pmRoot, fixture.root, fixture.repository.controlDirectory], { env: testEnvironment(),
    cwd: fixture.root, encoding: "utf8", timeout: 30_000,
  });
  const result = JSON.parse(output) as { outcome: string; detail: string };
  assert.equal(result.outcome, "untestable");
  assert.match(result.detail, /Linked PM test runner exited 42/);
  assert.equal(existsSync(join(fixture.repository.controlDirectory, "BISECT_WORKER")), false);
  assert.equal(runsRecorded(join(fixture.root, "count.txt")), 0);
});

test("the compiled command runs the linked SDK worker with the same contract", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Compiled diagnosis", join(fixture.root, "count.txt"));
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "probe");
  const culprit = edit(fixture, "state.txt", "broken", "culprit");
  edit(fixture, "state.txt", "broken tip", "tip");
  const harness = await createExtensionTestHarness(builtExtension, { capabilities: manifest.capabilities });
  const handler = harness.activation.commands.handlers.find((entry) => entry.command === "vcs bisect")!;
  const invoke = async (args: string[], options = {}) => handler.run({ command: "vcs bisect", args, options: { full: true, ...options }, pm_root: fixture.pmRoot,
    source_workspace_root: fixture.root, repo_root: fixture.root, global: { author: "compiled-agent" } });
  await invoke(["start", base, "main"], { item });
  const result = await invoke(["run"]) as { bisect: { verdict: { commit: string } } };
  assert.equal(result.bisect.verdict.commit, culprit);
});

test("deleting a linked file reports its owning PM item", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Deleted file diagnosis", join(fixture.root, "count.txt"));
  const owner = (await fixture.client.create({ type: "Task", title: "Deleted file owner", author: "owner" })).item.id;
  await fixture.client.files(owner, { add: ["state.txt"], author: "owner" });
  writeFileSync(join(fixture.root, "probe.js"), 'const { existsSync } = require("node:fs"); process.exit(existsSync("state.txt") ? 0 : 1);\n');
  const base = edit(fixture, "state.txt", "ok", "base");
  commitFiles(fixture, ["probe.js"], "probe");
  rmSync(join(fixture.root, "state.txt"));
  const culprit = commitFiles(fixture, ["state.txt"], "delete linked file");
  const bad = fixture.repository.commit({ message: "later", author, allowEmpty: true }, new Date());
  await fixture.bisect(["start", base, bad], { item });
  const result = await fixture.bisect(["run"]);
  const verdict = (result.result as { bisect: { verdict: { commit: string; items: string[] } } }).bisect.verdict;
  assert.equal(verdict.commit, culprit);
  assert.ok(verdict.items.includes(owner));
});

test("root commits from unrelated merged history report file-derived and explicit linked items", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Root diagnosis", join(fixture.root, "count.txt"));
  const owner = (await fixture.client.create({ type: "Task", title: "Root file owner", author: "fixture" })).item.id;
  await fixture.client.files(owner, { add: ["root.txt"], author: "fixture" });
  const good = fixture.repository.commit({ message: "good root", author, allowEmpty: true }, new Date());
  const blob = fixture.repository.objects.write("blob", Buffer.from("bad root contents"));
  const tree = buildTree(fixture.repository.objects, new Map([["root.txt", { id: blob, mode: "100644" as const, fileId: "a".repeat(32) }]]));
  const root = writeCommit(fixture.repository.objects, { tree, parents: [], author, committer: author, message: "unrelated bad root", items: [item] });
  const bad = writeCommit(fixture.repository.objects, { tree, parents: [good, root], author, committer: author, message: "merge unrelated root" });
  fixture.repository.refs.compareAndSwap("refs/heads/main", good, bad);
  fixture.repository.materialize(tree);
  await fixture.bisect(["start", good, bad], { item });
  const marked = await fixture.bisect(["bad", root]);
  assert.equal(marked.errorMessage, undefined);
  const verdict = (marked.result as { bisect: { verdict: { commit: string; items: string[] } } }).bisect.verdict;
  assert.equal(verdict.commit, root);
  assert.deepEqual(new Set(verdict.items), new Set([item, owner]));
});

test("manual good bad and skip default to the next candidate while HEAD stays at the bad boundary", async () => {
  for (const outcome of ["good", "bad", "skip"]) {
    const fixture = await setup();
    const item = await linkedTestItem(fixture, "Manual candidate", join(fixture.root, "count.txt"));
    const good = edit(fixture, "state.txt", "good", "good");
    for (let index = 0; index < 5; index++) edit(fixture, "state.txt", String(index), `change ${index}`);
    const bad = headCommit(fixture);
    const started = await fixture.bisect(["start", good, bad], { item });
    const next = (started.result as { bisect: { next: { commit: string } } }).bisect.next.commit;
    assert.notEqual(next, bad);
    await fixture.bisect([outcome]);
    const step = storedSession(fixture)!.steps.at(-1)!;
    assert.equal(step.commit, next);
    assert.equal(step.outcome, outcome);
    assert.equal(step.by, "manual");
    assert.equal(headCommit(fixture), bad);
    await fixture.bisect(["reset"]);
  }
});

test("manual engine verdicts reject every non-good outcome on the good boundary", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Good boundary contract", join(fixture.root, "count.txt"));
  const good = edit(fixture, "state.txt", "good", "good");
  const middle = edit(fixture, "state.txt", "middle", "middle");
  const bad = edit(fixture, "state.txt", "bad", "bad");
  await fixture.bisect(["start", good, bad], { item });
  const session = storedSession(fixture)!;
  const original = JSON.stringify(session);
  const options = { author: "fixture", now: () => new Date(1_000) };
  for (const outcome of ["bad", "skip", "untestable", "conflicted"] as const) {
    assert.throws(() => markBisectOutcome(fixture.repository, session, good, outcome, options),
      (error: unknown) => error instanceof ObjectStoreError && error.code === "good_boundary_verdict"
        && /reset and start with an earlier good revision/.test(error.message), outcome);
    assert.equal(JSON.stringify(session), original);
    assert.deepEqual(storedSession(fixture), session);
    assert.equal(readFileSync(join(fixture.root, "state.txt"), "utf8"), "bad");
  }
  assert.equal(markBisectOutcome(fixture.repository, session, good, "good", options).steps.at(-1)?.outcome, "good");
  for (const outcome of ["good", "bad", "skip", "untestable", "conflicted"] as const) {
    assert.equal(markBisectOutcome(fixture.repository, session, middle, outcome, options).steps.at(-1)?.outcome, outcome);
  }
  const outside = writeCommit(fixture.repository.objects, {
    tree: readCommit(fixture.repository.objects, good).tree, parents: [], author, committer: author, message: "unrelated",
  });
  assert.throws(() => markBisectOutcome(fixture.repository, session, outside, "good", options),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "outside_bisect_range");
});

test("manual CLI verdicts refuse bad and skip on the good boundary without publishing history", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Good boundary refusal", join(fixture.root, "count.txt"));
  const good = edit(fixture, "state.txt", "good", "good");
  edit(fixture, "state.txt", "middle", "middle");
  const bad = edit(fixture, "state.txt", "bad", "bad");
  await fixture.bisect(["start", good, bad], { item });
  const session = storedSession(fixture);
  const milestones = await comments(fixture, item);
  for (const outcome of ["bad", "skip"]) {
    const refused = await fixture.bisect([outcome, good]);
    assert.match(refused.errorMessage ?? "", /good boundary/);
    assert.match(refused.errorMessage ?? "", /reset and start with an earlier good revision/);
    assert.deepEqual(storedSession(fixture), session);
    assert.deepEqual(await comments(fixture, item), milestones);
    const status = await fixture.bisect(["status"]);
    assert.equal(status.errorMessage, undefined);
    assert.equal((status.result as { bisect: BisectReport }).bisect.remaining, 1);
    assert.equal(headCommit(fixture), bad);
    assert.equal(trackedClean(fixture), true);
  }
  assert.equal((await fixture.bisect(["good", good])).errorMessage, undefined);
  assert.equal(storedSession(fixture)!.steps.at(-1)?.outcome, "good");
  const corrected = await fixture.bisect(["good", bad]);
  assert.equal(corrected.errorMessage, undefined);
  assert.equal((corrected.result as { bisect: BisectReport }).bisect.verdict?.kind, "no_bad_change");
});

test("manual marks without an open candidate refuse with an explicit revision remedy", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "No manual candidate", join(fixture.root, "count.txt"));
  const good = edit(fixture, "state.txt", "good", "good");
  const bad = edit(fixture, "state.txt", "bad", "bad");
  await fixture.bisect(["start", good, bad], { item });
  const refused = await fixture.bisect(["skip"]);
  assert.match(refused.errorMessage ?? "", /no next candidate/i);
  assert.match(refused.errorMessage ?? "", /explicit revision/);
  assert.equal(storedSession(fixture)!.steps.length, 2);
  assert.equal((await fixture.bisect(["good", bad])).errorMessage, undefined);
});

test("reset clears local state before a missing linked item can reject its milestone", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Lost reset item", join(fixture.root, "count.txt"));
  const good = edit(fixture, "state.txt", "good", "good");
  edit(fixture, "state.txt", "middle", "middle");
  const bad = edit(fixture, "state.txt", "bad", "bad");
  await fixture.bisect(["start", good, bad], { item });
  mkdirSync(join(fixture.repository.controlDirectory, "BISECT_WORKSPACE"));
  rmSync(join(fixture.pmRoot, "tasks", `${item}.toon`));
  const reset = (await fixture.bisect(["reset"], { full: false })).result as { ok: boolean; reset: { restored: { commit: string }; warning: string } };
  assert.equal(reset.ok, true);
  assert.match(reset.reset.warning, /Local session cleared; reset milestone could not be recorded:.*not found/);
  assert.equal(reset.reset.restored.commit, bad.slice(0, 12));
  assert.equal(storedSession(fixture), null);
  assert.equal(existsSync(join(fixture.repository.controlDirectory, "BISECT_WORKSPACE")), false);
  const replacement = await linkedTestItem(fixture, "Replacement item", join(fixture.root, "count.txt"));
  assert.equal((await fixture.bisect(["start", good, bad], { item: replacement })).errorMessage, undefined);
});

test("2000-commit bisect reads each commit once and performs zero additional commit reads per decision step", async (context) => {
  const fixture = await setup();
  const store = fixture.repository.objects;
  const tree = buildTree(store, new Map());
  const history: string[] = [];
  for (let index = 0; index < 2000; index++) {
    history.push(writeCommit(store, { tree, parents: history.slice(-1), author, committer: author, message: `commit ${index}` }));
  }
  const reads = new Map<string, number>();
  const originalRead = store.read.bind(store);
  let count = 0;
  let limit = 2000;
  store.read = (id) => {
    assert.ok(++count <= limit, `commit read bound exceeded: ${count} > ${limit}`);
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return originalRead(id);
  };
  try {
    const candidates = bisectCandidates(store, history[399], history[1999]);
    assert.equal(candidates.length, 1600);
    assert.equal([...reads.values()].reduce((total, count) => total + count, 0), 2000);
    assert.ok([...reads.values()].every((count) => count === 1));
    reads.clear();
    count = 0;
    limit = 0;
    const steps: BisectStep[] = [{ ...candidates.at(-1)!, outcome: "bad" as const, by: "boundary" as const, at: "2000-01-01T00:00:00Z", author: "fixture" }];
    let decisions = 0;
    for (;;) {
      const verdicts = bisectVerdicts(steps);
      const remaining = bisectRemaining(store, candidates, verdicts);
      const selected = selectBisectCandidate(store, candidates, remaining);
      if (selected === null) {
        assert.equal(bisectVerdict(store, candidates, verdicts).commit, history[1200]);
        break;
      }
      steps.push({ ...selected, outcome: history.indexOf(selected.commit) >= 1200 ? "bad" : "good", by: "boundary", at: "2000-01-01T00:00:00Z", author: "fixture" });
      decisions++;
      assert.equal(reads.size, 0, `decision ${decisions} reread commit metadata`);
    }
    assert.ok(decisions <= 11, `expected at most 11 decisions, got ${decisions}`);
    assert.equal(reads.size, 0);
    context.diagnostic(`2000 total commits, 1600 candidates: 2000 setup reads, ${decisions} decisions, 0 commit reads per decision and final verdict`);
  } finally { store.read = originalRead; }
});

test("reports compact every object id by default and --full preserves complete ids and useful detail", async () => {
  const fixture = await setup();
  const item = await linkedTestItem(fixture, "Compact report", join(fixture.root, "count.txt"));
  const good = edit(fixture, "state.txt", "good", "good");
  const middle = edit(fixture, "state.txt", "middle", "middle");
  const bad = edit(fixture, "state.txt", "bad", "bad");
  await fixture.bisect(["start", good, "main"], { item });
  const state = storedSession(fixture)!;
  writeBisectSession(fixture.repository, { ...state, steps: [
    { ...state.steps[0], detail: "additional boundary evidence" }, state.steps[1],
    { commit: middle, changeId: changeOf(fixture, middle), outcome: "untestable", by: "run", at: state.startedAt, author: "fixture", detail: "exit 127" }] });
  const compact = await fixture.bisect(["status"], { full: false, budget: 16000 });
  const full = await fixture.bisect(["status"], { full: true, budget: 16000 });
  type Output = { bisect: BisectReport; sessions: { good: string; bad: string; verdict?: { change: string } }[] };
  const short = compact.result as Output;
  const long = full.result as Output;
  assert.equal(short.bisect.boundaries.good.commit, good.slice(0, 12));
  assert.equal(short.bisect.boundaries.good.revision, undefined);
  assert.equal(short.bisect.boundaries.bad.revision, "main");
  assert.equal(short.bisect.boundaries.bad.commit, bad.slice(0, 12));
  assert.equal(short.bisect.original.commit, bad.slice(0, 12));
  assert.ok(short.bisect.steps.every((step) => step.commit.length === 12 && step.changeId.length === 12));
  assert.equal(short.bisect.steps[0].detail, "additional boundary evidence");
  assert.equal(short.bisect.steps[1].detail, undefined);
  assert.equal(short.bisect.steps[2].detail, "exit 127");
  assert.equal(short.bisect.verdict!.commit, bad.slice(0, 12));
  assert.equal(short.bisect.verdict!.change!.length, 12);
  assert.equal(short.bisect.verdict!.unresolved[0].commit, middle.slice(0, 12));
  assert.equal(short.sessions[0].good, good.slice(0, 12));
  assert.equal(short.sessions[0].bad, "main");
  assert.equal(long.bisect.boundaries.good.commit, good);
  assert.equal(long.bisect.original.commit, bad);
  assert.equal(long.bisect.verdict!.unresolved[0].commit, middle);
  assert.ok(long.bisect.steps.every((step) => step.commit.length === 64 && step.changeId.length === 64));
  assert.equal(long.sessions[0].good, good);
  assert.ok(JSON.stringify(short).length < JSON.stringify(long).length);
  await fixture.bisect(["bad", middle]);
  const done = (await fixture.bisect(["status"], { full: false })).result as Output;
  assert.equal(done.sessions[0].verdict!.change.length, 12);
  await fixture.bisect(["reset"]);
  await fixture.bisect(["start", good, bad], { item });
  const next = (await fixture.bisect(["status"], { full: false })).result as Output;
  assert.equal(next.bisect.next!.commit, middle.slice(0, 12));
  assert.equal(next.bisect.next!.changeId.length, 12);
});

test("explicit bisect commands select only their linked test and resume at a persisted step limit", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "Bounded explicit diagnosis", author: "agent-a" })).item.id;
  await runTest(item, { add: ['command=node -e "process.exit(1)"'] }, { author: "agent-a", path: fixture.pmRoot });
  writeFileSync(join(fixture.root, "probe.js"), PROBE);
  edit(fixture, "state.txt", "ok", "initial state");
  const good = commitFiles(fixture, ["probe.js"], "probe");
  const commits = [good];
  for (let index = 1; index < 32; index++) commits.push(edit(fixture, "state.txt", index >= 20 ? `broken ${index}` : `ok ${index}`, `revision ${index}`));
  const bad = commits.at(-1)!;
  const started = await fixture.bisect(["start", good, bad], { item, command: "node probe.js", maxSteps: 1 });
  assert.equal(started.errorMessage, undefined);
  assert.equal(storedSession(fixture)?.command, "node probe.js");
  const linked = await runTest(item, { list: true }, { path: fixture.pmRoot });
  assert.deepEqual(linked.tests.map((entry) => entry.command), ['node -e "process.exit(1)"', "node probe.js"]);
  const run = (await fixture.bisect(["run"])).result as { bisect: BisectReport };
  assert.equal(run.bisect.halted, "step_limit");
  assert.equal(run.bisect.status, "active");
  assert.equal(run.bisect.maxSteps, 1);
  assert.equal(run.bisect.command, "node probe.js");
  assert.equal(run.bisect.steps.filter((step) => step.by === "run").length, 1);
  const first = storedSession(fixture)!.steps.at(-1)!;
  assert.equal(first.outcome, "good", "the unrelated failing linked test must not run");
  assert.equal(first.commit, run.bisect.steps.at(-1)!.commit);
  const again = (await fixture.bisect(["run"])).result as { bisect: BisectReport };
  assert.equal(again.bisect.halted, "step_limit");
  assert.equal(again.bisect.steps.filter((step) => step.by === "run").length, 2);
  const finished = (await fixture.bisect(["run"], { maxSteps: 128 })).result as { bisect: BisectReport };
  assert.equal(finished.bisect.status, "done");
  assert.equal(finished.bisect.halted, undefined);
  assert.equal(finished.bisect.verdict?.kind, "first_bad");
  assert.equal(finished.bisect.verdict?.commit, commits[20]);
  assert.equal(finished.bisect.verdict?.change, changeOf(fixture, commits[20]));
  assert.equal(storedSession(fixture)?.maxSteps, 128);
  assert.equal(storedSession(fixture)!.steps.filter((step) => step.commit === first.commit).length, 1);
  assert.equal(headCommit(fixture), bad);
  const evidence = await comments(fixture, item);
  assert.ok(evidence.some((comment) => comment.startsWith("pm-vcs bisect halted ") && comment.includes('"halted":"step_limit"')));
  assert.ok(evidence.some((comment) => comment.startsWith("pm-vcs bisect done ") && comment.includes(commits[20])));
});

test("bounded all-skip bisect retains every unresolved candidate and never claims a first bad change", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "All skipped diagnosis", author: "agent-a" })).item.id;
  const good = edit(fixture, "state.txt", "ok", "good");
  const skipped = [];
  for (let index = 0; index < 4; index++) skipped.push(edit(fixture, "state.txt", `unbuildable ${index}`, `skip ${index}`));
  const bad = edit(fixture, "state.txt", "broken", "declared bad");
  await fixture.bisect(["start", good, bad], { item, command: 'node -e "process.exit(125)"', maxSteps: 1 });
  for (let index = 0; index < skipped.length; index++) {
    const ran = (await fixture.bisect(["run"])).result as { bisect: BisectReport };
    assert.equal(ran.bisect.steps.filter((step) => step.by === "run").length, index + 1);
    assert.equal(ran.bisect.status, index === skipped.length - 1 ? "done" : "active");
  }
  const final = storedSession(fixture)!;
  assert.equal(final.verdict?.kind, "ambiguous");
  assert.equal(final.verdict?.commit, bad);
  assert.deepEqual(new Set(final.verdict?.unresolved.map((step) => step.commit)), new Set(skipped));
  assert.ok(final.verdict!.unresolved.every((step) => step.outcome === "skip" && step.detail === "exit 125"));
  assert.equal(headCommit(fixture), bad);
});

test("bisect validates step bounds and explicit predicates before changing state", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "Validate bounded diagnosis", author: "agent-a" })).item.id;
  const good = edit(fixture, "state.txt", "ok", "good");
  edit(fixture, "state.txt", "ok later", "interior");
  const bad = edit(fixture, "state.txt", "broken", "bad");
  for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.throws(() => bisectStepLimit(limit), /positive safe integer/);
    const refused = await fixture.bisect(["start", good, bad], { item, command: "node --version", maxSteps: limit });
    assert.match(refused.errorMessage ?? "", /positive safe integer/);
    assert.equal(storedSession(fixture), null);
  }
  const empty = await fixture.bisect(["start", good, bad], { item, command: " " });
  assert.match(empty.errorMessage ?? "", /nonempty --command/);
  const invalid = await fixture.bisect(["start", bad, good], { item, command: "node --version" });
  assert.match(invalid.errorMessage ?? "", /No changes/);
  assert.equal((await runTest(item, { list: true }, { path: fixture.pmRoot })).tests.length, 0);
  assert.equal((await fixture.bisect(["start", good, bad], { item, command: "node --version" })).errorMessage, undefined);
  assert.equal(storedSession(fixture)?.maxSteps, 128);
  const changed = await fixture.bisect(["run"], { command: "node -e process.exit(1)" });
  assert.match(changed.errorMessage ?? "", /only by bisect start/);
  await runTest(item, { remove: ["command=node --version"] }, { author: "agent-a", path: fixture.pmRoot });
  const missing = await fixture.bisect(["run"]);
  assert.equal(missing.errorMessage, undefined);
  const state = storedSession(fixture)!;
  assert.equal(state.verdict?.kind, "ambiguous");
  assert.match(state.steps.find((step) => step.by === "run")?.detail ?? "", /no longer linked/);
});

test("installed bisect runs linked and explicit predicates without git and resumes after interruption", async () => {
  const savedHead = process.env.GITHUB_HEAD_REF;
  const savedRef = process.env.GITHUB_REF_NAME;
  delete process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_REF_NAME;
  try {
  for (const mode of ["linked", "explicit", "git-linked"]) {
    const explicit = mode === "explicit";
    const git = mode === "git-linked";
    const fixture = await setup();
    const item = (await fixture.client.create({ type: "Task", title: "Plain directory diagnosis", author: "agent-a" })).item.id;
    if (git) execFileSync("git", ["init", "-q", "-b", "fixture-main", fixture.root], { env: testEnvironment() });
    if (!explicit) await runTest(item, { addJson: [JSON.stringify({ command: "node probe.js", ...(git ? { env_set: { GITHUB_HEAD_REF: "configured-for-test" } } : {}) })] }, { author: "agent-a", path: fixture.pmRoot });
    const environmentCheck = git
      ? 'if (process.env.GITHUB_HEAD_REF !== "configured-for-test") throw new Error("linked environment changed");\n'
      : 'if ("GITHUB_HEAD_REF" in process.env) throw new Error("SDK context leaked into predicate");\n';
    writeFileSync(join(fixture.root, "probe.js"), environmentCheck + PROBE);
    edit(fixture, "state.txt", "ok", "initial");
    const good = commitFiles(fixture, ["probe.js"], "probe");
    for (let index = 0; index < 4; index++) edit(fixture, "state.txt", `hang ${index}`, `interior ${index}`);
    const culprit = edit(fixture, "state.txt", "broken", "culprit");
    const bad = edit(fixture, "state.txt", "broken tip", "bad");
    installPackedExtension(fixture.root);
    const bin = join(fixture.root, "tools");
    mkdirSync(bin);
    copyFileSync(process.execPath, join(bin, process.platform === "win32" ? "node.exe" : "node"));
    const environment = { ...testEnvironment(), ...discardChildCoverage(), PATH: bin,
      GIT_CEILING_DIRECTORIES: dirname(fixture.root), PM_AUTHOR: "bisector",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./helpers/forbid-git.ts", import.meta.url).href}`,
    };
    /** Execute the shipped CLI with only Node available on PATH. */
    const invoke = (args: readonly string[], repaired = false): BisectReport => {
      const output = execFileSync(process.execPath, [pmExecutable, "vcs", "bisect", ...args, "--json", "--full"], {
        cwd: fixture.root, encoding: "utf8", timeout: 300_000,
        env: { ...environment, ...(repaired ? { BISECT_REPAIRED: "1" } : {}) },
      });
      return (JSON.parse(output) as { bisect: BisectReport }).bisect;
    };
    assert.equal(existsSync(join(fixture.root, ".git")), git);
    const help = execFileSync(process.execPath, [pmExecutable, "vcs", "bisect", "--help"], { cwd: fixture.root, encoding: "utf8", env: environment });
    assert.match(help, /--max-steps/);
    assert.match(help, /--command/);
    const start = invoke(["start", good, bad, "--item", item, "--max-steps", "2", ...(explicit ? ["--command", "node probe.js"] : [])]);
    assert.equal(start.maxSteps, 2);
    assert.equal(start.command, explicit ? "node probe.js" : undefined);
    const halted = invoke(["run"]);
    assert.equal(halted.halted, "interrupted");
    assert.equal(halted.status, "active");
    assert.ok(halted.steps.some((step) => step.retry));
    assert.equal(invoke(["status"]).session, start.session);
    const resumed = invoke(["run", "--max-steps", "128"], true);
    assert.equal(resumed.status, "done");
    assert.equal(resumed.verdict?.kind, "first_bad");
    assert.equal(resumed.verdict?.commit, culprit);
    assert.equal(resumed.verdict?.change, changeOf(fixture, culprit));
    assert.equal(headCommit(fixture), bad);
    assert.equal(existsSync(join(fixture.root, ".git")), git);
    const evidence = await comments(fixture, item);
    assert.ok(evidence.some((comment) => comment.startsWith("pm-vcs bisect step ") && comment.includes('"retry":true')));
    assert.ok(evidence.some((comment) => comment.startsWith("pm-vcs bisect done ") && comment.includes(culprit)));
  }
  } finally {
    if (savedHead === undefined) delete process.env.GITHUB_HEAD_REF; else process.env.GITHUB_HEAD_REF = savedHead;
    if (savedRef === undefined) delete process.env.GITHUB_REF_NAME; else process.env.GITHUB_REF_NAME = savedRef;
  }
});

test("explicit bisect commands preserve metadata-like commas as literal command text", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "Literal command diagnosis", author: "agent-a" })).item.id;
  const path = "probe.js,scope=global";
  const command = `node ${path}`;
  writeFileSync(join(fixture.root, path), PROBE);
  edit(fixture, "state.txt", "ok", "initial state");
  const good = commitFiles(fixture, [path], "literal probe");
  edit(fixture, "state.txt", "ok later", "interior");
  const culprit = edit(fixture, "state.txt", "broken", "culprit");
  const bad = edit(fixture, "state.txt", "broken tip", "bad");
  const started = await fixture.bisect(["start", good, bad], { item, command });
  assert.equal(started.errorMessage, undefined);
  const linked = await runTest(item, { list: true }, { path: fixture.pmRoot });
  assert.equal(linked.tests.length, 1);
  assert.equal(linked.tests[0].command, command);
  assert.equal(linked.tests[0].scope, "project");
  const ran = (await fixture.bisect(["run"])).result as { bisect: BisectReport };
  assert.equal(ran.bisect.status, "done");
  assert.equal(ran.bisect.verdict?.kind, "first_bad");
  assert.equal(ran.bisect.verdict?.commit, culprit);
  assert.equal(headCommit(fixture), bad);
});

test("bisect SDK source refs use hosted context or read real Git metadata without a process", async () => {
  const fixture = await setup();
  const keys = ["GITHUB_HEAD_REF", "GITHUB_REF_NAME", "GIT_CEILING_DIRECTORIES"] as const;
  const saved = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
  try {
    const native = `pm-vcs:${fixture.repository.identity()}`;
    assert.equal(bisectTestSourceRef(fixture.repository), native);
    process.env.GITHUB_HEAD_REF = " hosted-branch ";
    assert.equal(bisectTestSourceRef(fixture.repository), "hosted-branch");
    process.env.GITHUB_HEAD_REF = "";
    process.env.GITHUB_REF_NAME = "hosted-tag";
    assert.equal(bisectTestSourceRef(fixture.repository), "hosted-tag");
    process.env.GITHUB_REF_NAME = "merge";
    assert.equal(bisectTestSourceRef(fixture.repository), native);
    delete process.env.GITHUB_REF_NAME;
    execFileSync("git", ["init", "-q", "-b", "fixture-main", fixture.root], { env: testEnvironment() });
    assert.equal(bisectTestSourceRef(fixture.repository), "fixture-main");
    const nested = Repository.init(join(fixture.root, "nested"));
    assert.equal(bisectTestSourceRef(nested), "fixture-main");
    process.env.GIT_CEILING_DIRECTORIES = fixture.root;
    assert.equal(bisectTestSourceRef(nested), `pm-vcs:${nested.identity()}`);
    delete process.env.GIT_CEILING_DIRECTORIES;
    execFileSync("git", ["-C", fixture.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-q", "-m", "fixture"], { env: testEnvironment() });
    const linked = join(fixture.root, "linked-git");
    execFileSync("git", ["-C", fixture.root, "worktree", "add", "-q", "-b", "fixture-linked", linked], { env: testEnvironment() });
    const linkedNative = Repository.init(linked);
    assert.equal(bisectTestSourceRef(linkedNative), "fixture-linked");
    writeFileSync(join(linked, ".git"), "invalid pointer\n");
    assert.equal(bisectTestSourceRef(linkedNative), `pm-vcs:${linkedNative.identity()}`);
    writeFileSync(join(fixture.root, ".git", "HEAD"), "a".repeat(40) + "\n");
    assert.equal(bisectTestSourceRef(fixture.repository), native);
    rmSync(join(fixture.root, ".git", "HEAD"));
    assert.equal(bisectTestSourceRef(fixture.repository), native);
  } finally {
    for (const [index, key] of keys.entries()) {
      if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
    }
  }
});

test("bisect SDK workers restore absent and configured hosted variables without changing linked directives", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "Worker environment", author: "agent-a" })).item.id;
  const saved = process.env.GITHUB_HEAD_REF;
  const savedRef = process.env.GITHUB_REF_NAME;
  delete process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_REF_NAME;
  try {
    writeFileSync(join(fixture.root, "environment.js"), 'const expected = process.argv[2]; if (expected === "absent" ? "GITHUB_HEAD_REF" in process.env : process.env.GITHUB_HEAD_REF !== expected) process.exit(7);');
    await runTest(item, { addJson: [
      JSON.stringify({ command: "node environment.js absent" }),
      JSON.stringify({ command: "node environment.js declared", env_set: { GITHUB_HEAD_REF: "declared" } }),
    ] }, { author: "agent-a", path: fixture.pmRoot });
    const ran = await runCandidateTest(item, "agent-a", fixture.pmRoot, fixture.root, fixture.repository.controlDirectory, undefined, `pm-vcs:${fixture.repository.identity()}`);
    assert.deepEqual(ran, { outcome: "good" });
    await runTest(item, { addJson: [JSON.stringify({ command: 'node environment.js ""' }), JSON.stringify({ command: "node environment.js hosted-source" })] }, { author: "agent-a", path: fixture.pmRoot });
    process.env.GITHUB_HEAD_REF = "";
    assert.deepEqual(await runCandidateTest(item, "agent-a", fixture.pmRoot, fixture.root, fixture.repository.controlDirectory, 'node environment.js ""', `pm-vcs:${fixture.repository.identity()}`), { outcome: "good" });
    process.env.GITHUB_HEAD_REF = "hosted-source";
    assert.deepEqual(await runCandidateTest(item, "agent-a", fixture.pmRoot, fixture.root, fixture.repository.controlDirectory, "node environment.js hosted-source", "hosted-source"), { outcome: "good" });
  } finally {
    if (saved === undefined) delete process.env.GITHUB_HEAD_REF; else process.env.GITHUB_HEAD_REF = saved;
    if (savedRef === undefined) delete process.env.GITHUB_REF_NAME; else process.env.GITHUB_REF_NAME = savedRef;
  }
});

test("bisect explicit registration refuses an existing SDK worker receipt without starting a session", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "Registration ownership", author: "agent-a" })).item.id;
  const good = edit(fixture, "state.txt", "ok", "good");
  const bad = edit(fixture, "state.txt", "broken", "bad");
  const receipt = join(fixture.repository.controlDirectory, "BISECT_WORKER");
  writeFileSync(receipt, String(process.pid));
  const refused = await fixture.bisect(["start", good, bad], { item, command: "node --version" });
  assert.match(refused.errorMessage ?? "", /Another bisect command or test worker/);
  assert.equal(storedSession(fixture), null);
  assert.equal(readFileSync(receipt, "utf8"), String(process.pid));
  assert.equal((await runTest(item, { list: true }, { path: fixture.pmRoot })).tests.length, 0);
});

test("bisect explicit registration survives a real early worker exit and can be retried", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "Registration failure", author: "agent-a" })).item.id;
  const good = edit(fixture, "state.txt", "ok", "good");
  const bad = edit(fixture, "state.txt", "broken", "bad");
  const options = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--import=data:text/javascript,process.exit(42)";
  try {
    const refused = await fixture.bisect(["start", good, bad], { item, command: "node --version" });
    assert.match(refused.errorMessage ?? "", /explicit bisect test could not be recorded/);
    assert.equal(storedSession(fixture), null);
    assert.equal(existsSync(join(fixture.repository.controlDirectory, "BISECT_WORKER")), false);
    assert.equal((await runTest(item, { list: true }, { path: fixture.pmRoot })).tests.length, 0);
  } finally {
    if (options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = options;
  }
  assert.equal((await fixture.bisect(["start", good, bad], { item, command: "node --version" })).errorMessage, undefined);
});

test("bisect SDK process policy blocks Git and preserves real callback promise and spawn behavior", () => {
  const script = `
    import { testEnvironment } from ${JSON.stringify(new URL("./helpers/test-environment.ts", import.meta.url).href)};
    import assert from "node:assert/strict";
    import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
    import { promisify } from "node:util";
    for (const method of [execFile, execFileSync, spawn, spawnSync]) {
      assert.throws(() => method("git", ["status"], {env:testEnvironment()}), {code:"ENOTSUP"});
      assert.throws(() => method("git.exe", ["status"], {env:testEnvironment()}), {code:"ENOTSUP"});
    }
    assert.throws(() => execFile(null, [], {env:testEnvironment()}), {code:"ERR_INVALID_ARG_TYPE"});
    await assert.rejects(async () => promisify(execFile)("git", ["status"], {env:testEnvironment()}), {code:"ENOTSUP"});
    const program = 'process.stdout.write("out");process.stderr.write("err")';
    const callback = await new Promise((resolve, reject) => execFile(process.execPath, ["-e",program], {env:testEnvironment()}, (error, stdout, stderr) => error ? reject(error) : resolve({stdout,stderr})));
    assert.deepEqual(callback,{stdout:"out",stderr:"err"});
    assert.deepEqual(await promisify(execFile)(process.execPath,["-e",program],{env:testEnvironment()}),{stdout:"out",stderr:"err"});
    assert.equal(execFileSync(process.execPath,["-e",program],{env:testEnvironment(),encoding:"utf8",stdio:["ignore","pipe","ignore"]}),"out");
    assert.equal(spawnSync(process.execPath,["-e",program],{env:testEnvironment(),encoding:"utf8"}).stdout,"out");
    const child = spawn(process.execPath,["-e",program],{env:testEnvironment()});
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    await new Promise((resolve,reject) => {child.on("error",reject);child.on("close",resolve);});
    assert.equal(output,"out");
    console.log("worker policy passed");
  `;
  const result = execFileSync(process.execPath, ["--import", new URL("../bisect-sdk-policy.ts", import.meta.url).href, "--input-type=module", "-e", script], { env: testEnvironment(), encoding: "utf8", timeout: 30_000 });
  assert.match(result, /worker policy passed/);
});

test("bisect SDK linked commands share one PM sandbox per candidate without a false bad change", async () => {
  const fixture = await setup();
  const item = (await fixture.client.create({ type: "Task", title: "Shared batch context", author: "agent-a" })).item.id;
  writeFileSync(join(fixture.root, "prepare.js"), 'require("node:fs").writeFileSync(require("node:path").join(process.env.PM_PATH,"shared-probe"),"ready");');
  writeFileSync(join(fixture.root, "check.js"), 'const fs=require("node:fs");if(fs.readFileSync(require("node:path").join(process.env.PM_PATH,"shared-probe"),"utf8")!=="ready")throw new Error("missing preparation");process.exit(fs.readFileSync("state.txt","utf8").startsWith("broken")?1:0);');
  await runTest(item, { addJson: [JSON.stringify({ command: "node prepare.js" }), JSON.stringify({ command: "node check.js" })] }, { author: "agent-a", path: fixture.pmRoot });
  edit(fixture, "state.txt", "ok", "initial");
  const good = commitFiles(fixture, ["prepare.js", "check.js"], "batch predicate");
  const passing = edit(fixture, "state.txt", "ok later", "passing candidate");
  const culprit = edit(fixture, "state.txt", "broken", "culprit");
  const bad = edit(fixture, "state.txt", "broken tip", "bad");
  assert.equal((await fixture.bisect(["start", good, bad], { item })).errorMessage, undefined);
  const result = (await fixture.bisect(["run"])).result as { bisect: BisectReport };
  assert.equal(result.bisect.verdict?.kind, "first_bad");
  assert.equal(result.bisect.verdict?.commit, culprit);
  assert.ok(result.bisect.steps.some((step) => step.commit === passing && step.outcome === "good"));
  assert.equal(headCommit(fixture), bad);
});
