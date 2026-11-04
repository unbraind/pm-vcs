/** Bounded fatal children with synchronous, isolated native preparation and recovery in the covered parent. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative } from "node:path";
import type { Readable } from "node:stream";
import { Repository } from "../../engine/repo.ts";
import { objectFiles } from "../../engine/object-files.ts";
import { assertCompleteCuts, prepareCrashEntry } from "./crash-matrix.ts";
import { makeTempDir } from "./tmp.ts";
import { testEnvironment } from "./test-environment.ts";
import { discardChildCoverage } from "./sandbox.ts";
interface Fixture { dir: ReturnType<typeof makeTempDir>; repo: Repository }
interface ChildResult { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; trace: string }
/** Synchronous turns cannot relocate another cut's recovery ledgers across an await. */
function inNamespace<T>(root: string, run: () => T): T {
  const keys = ["TMPDIR", "TMP", "TEMP"] as const; const previous = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = root;
  try { return run(); } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
}
/** Resolve only after close, so cleanup cannot race a still-running native child. */
function runChild(entry: string, preloads: string[], args: readonly string[], root: string, cache: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...preloads.flatMap(path => ["--import", path]), entry, ...args], { env: { ...testEnvironment(), ...discardChildCoverage(), TMPDIR: root, TMP: root, TEMP: root, CRASH_COMPILE_CACHE: cache, CRASH_TIMING: "1", GIT_CEILING_DIRECTORIES: root }, stdio: ["ignore", "pipe", "pipe", "pipe"], timeout: 30_000 });
    let stdout = ""; let stderr = ""; let trace = ""; let failure: Error | undefined;
    child.stdout?.on("data", value => { stdout += String(value); }); child.stderr?.on("data", value => { stderr += String(value); });
    (child.stdio[3] as Readable | null)?.on("data", value => { trace += String(value); });
    child.on("error", error => { failure = error; });
    child.on("close", (status, signal) => { if (failure !== undefined) reject(failure); else resolve({ status, signal, stdout, stderr, trace }); });
  });
}
/** Every original payload and assertion runs; only completed initialization and child compilation are shared. */
export async function fixtureCrashMatrix<T extends Fixture>(options: { steps: readonly string[]; source: string; prepare(): Promise<T>; args(fixture: T): string[]; verify(fixture: T): void }): Promise<{ count: number; workers: number; milliseconds: number; averages: Record<string, number>; guard: string }> {
  const start = performance.now(); const cuts = options.steps.map((_, index) => index + 1); const completed: number[] = []; const errors: unknown[] = []; const totals: Record<string, number> = {};
  assert.ok(cuts.length > 0); assertCompleteCuts(options.steps, cuts); assert.throws(() => assertCompleteCuts(options.steps, cuts.slice(1)), /enumerated cuts must equal/);
  const scope = makeTempDir(process.env.PM_VCS_CRASH_TMPDIR);
  try {
    const { entry, preloads } = prepareCrashEntry(scope.root, options.source); const cache = join(scope.root, "cache");
    /** Preparation executes synchronously when the initialized base is cached; preserve its promise for callers. */
    const prepare = async () => { const root = mkdtempSync(join(scope.root, "cut-")); try { const fixture = await inNamespace(root, () => options.prepare()); return { root, fixture }; } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; } };
    const first = await prepare();
    const probeDir = inNamespace(first.root, () => makeTempDir()); cpSync(first.fixture.dir.root, probeDir.root, { recursive: true });
    const probe = { ...first.fixture, dir: probeDir, repo: Repository.open(join(probeDir.root, relative(first.fixture.dir.root, first.fixture.repo.root))) };
    const listed = await runChild(entry, preloads, [...options.args(probe), "0"], first.root, cache); assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), options.steps, "prepared entry point must preserve every original source boundary");
    let next = 0; const workers = Math.min(availableParallelism(), cuts.length);
    const lanes = await Promise.allSettled(Array.from({ length: workers }, async () => {
      while (next < cuts.length) {
        const ordinal = cuts[next++]; let current: Awaited<ReturnType<typeof prepare>> | undefined;
        try {
          const started = performance.now(); current = ordinal === 1 ? first : await prepare(); const prepared = performance.now();
          const childStart = performance.timeOrigin + prepared; const child = await runChild(entry, preloads, [...options.args(current.fixture), String(ordinal)], current.root, cache); const killed = performance.now();
          assert.equal(child.signal, "SIGKILL", `${ordinal}/${options.steps[ordinal - 1]}: ${child.stderr}`);
          inNamespace(current.root, () => options.verify(current!.fixture)); assert.equal(objectFiles.active.size, 0); const verified = performance.now();
          const [ready, fatal] = child.trace.trim().split("\n"); const timing = JSON.parse(fatal) as { at: number; steps: string[] };
          assert.deepEqual(timing.steps, options.steps.slice(0, ordinal), "the killed child must reach the complete recorded prefix");
          for (const [key, value] of Object.entries({ fixture: prepared - started, spawn: Number(ready) - childStart, preCut: timing.at - Number(ready), kill: performance.timeOrigin + killed - timing.at, recoveryAndVerification: verified - killed })) totals[key] = (totals[key] ?? 0) + value;
          completed.push(ordinal);
          if (completed.length % 25 === 0 || completed.length === cuts.length) console.log(JSON.stringify({ matrix: options.source, completed: completed.length, count: cuts.length }));
        } catch (error) { errors.push(new Error(`native cut ${ordinal}/${options.steps[ordinal - 1]}`, { cause: error })); }
        finally { if (current !== undefined) rmSync(current.root, { recursive: true, force: true }); }
      }
    }));
    for (const result of lanes) if (result.status === "rejected") errors.push(result.reason);
    try { assertCompleteCuts(options.steps, completed.sort((a, b) => a - b)); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, "Native crash matrix failed");
    return { count: cuts.length, workers, milliseconds: performance.now() - start, guard: `${cuts.length - 1}/${cuts.length} removed-cut enumeration rejected; ${completed.length}/${cuts.length} cuts verified`, averages: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / cuts.length])) };
  } finally { rmSync(scope.root, { recursive: true, force: true }); }
}
