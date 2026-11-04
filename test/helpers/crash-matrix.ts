/** Complete ordinal enumeration is an assertion, independent of scheduling and cut execution. */
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTempDir, packageRoot } from "./tmp.ts";
import { testEnvironment } from "./test-environment.ts";

/** Reject a missing, duplicate, reordered or out-of-range boundary before and after execution. */
export function assertCompleteCuts(steps: readonly string[], ordinals: readonly number[]): void {
  assert.deepEqual(ordinals, Array.from({ length: steps.length }, (_, index) => index + 1), "enumerated cuts must equal every recorded syscall boundary exactly once");
}
export interface CrashMatrixResult { count: number; workers: number; milliseconds: number; averages: Record<string, number>; guard: string }
export interface CutResult { ordinal: number; timing: Record<string, number> }
interface Reply extends Partial<CutResult> { ready?: boolean; steps?: string[]; error?: string }
/** A persistent fixture owner amortizes imports; each request still kills a distinct native writer. */
class CutOwner {
  readonly child: ChildProcess;
  private pending: { resolve: (value: Reply) => void; reject: (error: Error) => void } | undefined;
  readonly ready: Promise<Reply>;
  constructor(root: string, cache: string, scenario: string, entry: string, preloads: string[]) {
    this.ready = new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
    mkdirSync(root);
    this.child = fork(join(packageRoot, "test/helpers/lifecycle-cut-worker.ts"), [JSON.stringify({ root, cache, scenario, entry, preloads })], { env: testEnvironment({ TMPDIR: root, TMP: root, TEMP: root, CRASH_COMPILE_CACHE: cache }), execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    this.child.stderr!.on("data", chunk => { stderr += String(chunk); });
    this.child.on("message", (reply: Reply) => { const pending = this.pending; this.pending = undefined; if (reply.error !== undefined) pending?.reject(new Error(reply.error)); else pending?.resolve(reply); });
    this.child.on("error", error => this.pending?.reject(error));
    this.child.on("exit", (code, signal) => this.pending?.reject(new Error(`fixture owner exited ${code}/${signal}: ${stderr}`)));
  }
  /** Exactly one active cut per owner keeps all engine globals and directories isolated. */
  request(ordinal: number, steps?: string[]): Promise<Reply> {
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; this.child.send({ ordinal, steps }); });
  }
  /** Exit owners normally to flush coverage before removing their entire temporary namespaces. */
  async close(): Promise<void> { if (this.child.exitCode !== null || this.child.signalCode !== null) { assert.equal(this.child.exitCode, 0, "fixture owner must exit normally"); return; } const exited = new Promise<void>(resolve => { this.child.once("exit", () => resolve()); }); if (this.child.connected) this.child.send("close"); else this.child.kill(); await exited; assert.equal(this.child.exitCode, 0, "fixture owner must exit normally"); }
}
/** Prepare one entry point, retaining source execution when the optional local bundler is absent. */
export interface CrashEntry { entry: string; preloads: string[] }
/** Bundle preloads too: fatal children need no TypeScript loader or repeated compilation. */
export function prepareCrashEntry(root: string, source: string): CrashEntry {
  const entry = join(root, "publication.mjs");
  const bundle = spawnSync("bun", ["build", `./${source}`, "--target=node", "--format=esm", "--minify", "--keep-names", `--outfile=${entry}`], { cwd: packageRoot, env: testEnvironment({ NODE_V8_COVERAGE: "" }), encoding: "utf8", timeout: 30_000 });
  if ((bundle.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { entry: join(packageRoot, source), preloads: ["forbid-git.ts", "crash-child.ts"].map(name => pathToFileURL(join(packageRoot, "test/helpers", name)).href) };
  assert.equal(bundle.status, 0, `prepare the shared publication entry point: ${bundle.stderr}`);
  const preloads = spawnSync("bun", ["build", "./test/helpers/forbid-git.ts", "./test/helpers/crash-child.ts", "--target=node", "--format=esm", "--entry-naming=[name].mjs", `--outdir=${root}`], { cwd: packageRoot, env: testEnvironment({ NODE_V8_COVERAGE: "" }), encoding: "utf8", timeout: 30_000 });
  assert.equal(preloads.status, 0, `prepare shared publication preloads: ${preloads.stderr}`);
  return { entry, preloads: ["forbid-git.mjs", "crash-child.mjs"].map(name => pathToFileURL(join(root, name)).href) };
}
/** Schedule every recorded boundary on at most one persistent owner per available runner core. */
export async function lifecycleMatrix(scenario: string, execute: (name: string, run: () => Promise<void>) => Promise<unknown>, expectedSteps?: readonly string[]): Promise<CrashMatrixResult> {
  const scope = makeTempDir(process.env.PM_VCS_CRASH_TMPDIR); const owners: CutOwner[] = []; const started = performance.now();
  let result: CrashMatrixResult | undefined; let primary: Error | undefined;
  try {
    const { entry, preloads } = prepareCrashEntry(scope.root, "test/helpers/erasure-purge-worker.ts");
    const owner = new CutOwner(join(scope.root, "owner-0"), join(scope.root, "cache"), scenario, entry, preloads); owners.push(owner); await owner.ready;
    const { steps } = await owner.request(0); assert.ok(steps !== undefined && steps.length >= 20);
    if (expectedSteps !== undefined) assert.deepEqual(steps, expectedSteps, "isolated owners must preserve the original fixture source trace");
    const ordinals = Array.from({ length: steps.length }, (_, index) => index + 1); assertCompleteCuts(steps, ordinals);
    assert.throws(() => assertCompleteCuts(steps, ordinals.slice(1)), /enumerated cuts must equal/, "removing one actual recorded cut must fail the guard");
    for (let index = 1; index < Math.min(availableParallelism(), ordinals.length); index++) owners.push(new CutOwner(join(scope.root, `owner-${index}`), join(scope.root, "cache"), scenario, entry, preloads));
    await Promise.all(owners.map(item => item.ready));
    await Promise.all(owners.slice(1).map(async item => { const probe = await item.request(0); assert.deepEqual(probe.steps, steps, "every fixture owner must preserve the complete source enumeration"); }));
    let next = 0; const completed: number[] = []; const totals: Record<string, number> = {};
    await Promise.all(owners.map(async item => {
      while (next < ordinals.length) {
        const ordinal = ordinals[next++];
        await execute(`cut ${ordinal}: ${steps[ordinal - 1]}`, async () => {
          const result = await item.request(ordinal, steps); assert.equal(result.ordinal, ordinal);
          for (const [key, value] of Object.entries(result.timing!)) totals[key] = (totals[key] ?? 0) + value;
          completed.push(ordinal);
        });
      }
    }));
    assertCompleteCuts(steps, completed.sort((a, b) => a - b));
    result = { count: steps.length, workers: owners.length, guard: `${steps.length - 1}/${steps.length} removed-cut enumeration rejected; ${completed.length}/${steps.length} cuts verified`, milliseconds: performance.now() - started, averages: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / steps.length])) };
  } catch (cause) { primary = new Error("Native lifecycle matrix failed", { cause }); }
  const closed = await Promise.allSettled(owners.map(owner => owner.close()));
  try {
    if (primary !== undefined) throw primary;
    const failed = closed.find(outcome => outcome.status === "rejected");
    if (failed?.status === "rejected") throw new Error("Fixture owner shutdown failed", { cause: failed.reason });
    assert.ok(result !== undefined); return result;
  } finally { scope.cleanup(); }
}
