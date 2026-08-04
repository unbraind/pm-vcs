/**
 * Real repositories for the test suite.
 *
 * Every fixture here is an actual git repository holding an actual pm tracker,
 * created by running the real `pm` binary and real `git`. Nothing is mocked and
 * no api double is constructed: the package's whole claim is that it predicts
 * what git and the shipped merge drivers do, and a fake of either would make the
 * suite assert against its own assumptions instead of against the behaviour.
 *
 * Sandboxes live under the OS temp directory and are removed by the caller.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Package root, so the local `pm` binary and built output can be located. */
export const packageRoot = resolve(import.meta.dirname, "..", "..");

/** The `pm` executable from this package's own devDependency. */
const pmBin = join(packageRoot, "node_modules", ".bin", "pm");

/** A prepared sandbox repository. */
export interface Sandbox {
  /** Absolute repository root. */
  readonly root: string;
  /** Absolute tracker root. */
  readonly pmRoot: string;
  /** Runs git in the sandbox and returns trimmed stdout. */
  git(...args: string[]): string;
  /** Runs the local `pm` binary against this sandbox's tracker. */
  pm(...args: string[]): string;
  /** Stages everything and commits with `message`. */
  commit(message: string): string;
  /** Creates an item of `type` with `title` and returns its id. */
  createItem(type: string, title: string): string;
  /** Removes the sandbox from disk. */
  cleanup(): void;
}

/**
 * Environment that stops a spawned Node process writing V8 coverage into the
 * parent test run's report.
 *
 * The Node test runner sets `NODE_V8_COVERAGE` and **re-injects it into child
 * processes even when it is deleted from `env`**, so this suite's real `pm` and
 * `git` children were dropping coverage files into the parent's directory. The
 * lcov reporter then intermittently produced an empty file and the coverage gate
 * failed with "source file(s) never loaded" — on a suite that had just reported
 * 100%. That is the long-standing nondeterminism in this package's coverage.
 *
 * Disables collection in the child rather than redirecting it. Node treats a
 * non-empty value as a *directory*, so `/dev/null` creates a `dev\null` folder
 * on Windows and writes into it — the opposite of discarding, on a package with
 * Windows CI — and any real directory accumulates one coverage JSON per child
 * exit. An empty value collects nothing at all, which is the only form with no
 * output to place, bound, or clean up.
 *
 * @returns Environment overrides to merge into a child process's `env`.
 */
export function discardChildCoverage(): Record<string, string> {
  // An empty value disables collection in the child outright, so nothing is
  // written anywhere and there is nothing to clean up.
  //
  // Redirecting to a directory was the wrong shape, in two escalating ways. A
  // fresh `mkdtemp` per call left 1,980 directories and 658 MB after one sweep,
  // because `run()` is called for every `git` and `pm` invocation. Collapsing
  // that to a single shared directory bounded the directory *count* at one but
  // not the disk: Node still writes a coverage JSON per instrumented child exit,
  // so one run still accumulated 236 files and 232 MB in it. Redirection was
  // always going to leak, because the children were still being asked to
  // produce output nobody wanted.
  return { NODE_V8_COVERAGE: "" };
}

/**
 * Runs a command, returning trimmed stdout and surfacing failures loudly.
 *
 * @param file - Executable to run.
 * @param args - Arguments passed with no shell interpretation.
 * @param cwd - Directory to run in.
 * @returns Trimmed stdout.
 */
function run(file: string, args: readonly string[], cwd: string): string {
  return execFileSync(file, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // A stuck `pm` or `git` should fail one test rather than stall the whole CI
    // job with no output.
    timeout: 120_000,
    env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", ...discardChildCoverage() },
  }).trim();
}

/**
 * Creates a git repository with an initialized pm tracker.
 *
 * @param options.mergeInstall - Run `pm merge install` (default true). Pass false
 *   to model the fresh-clone-with-no-drivers state preflight exists to catch.
 * @param options.commitFence - Commit the resulting `.gitattributes` (default
 *   true). Pass false to model a fence that protects only the local clone.
 * @returns A ready sandbox.
 */
export function createSandbox(
  options: { mergeInstall?: boolean; commitFence?: boolean } = {},
): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-test-"));
  const pmRoot = join(root, ".agents", "pm");

  const sandbox: Sandbox = {
    root,
    pmRoot,
    git: (...args: string[]) => run("git", args, root),
    pm: (...args: string[]) => run(pmBin, [...args, "--pm-path", pmRoot], root),
    commit(message: string) {
      run("git", ["add", "-A"], root);
      run("git", ["commit", "-q", "-m", message], root);
      return run("git", ["rev-parse", "HEAD"], root);
    },
    createItem(type: string, title: string) {
      const raw = sandbox.pm("create", type, "--title", title, "--json");
      const parsed: unknown = JSON.parse(raw);
      // `pm create --json` returns `{ id, status, changed_field_count }`, but has
      // also shipped an `{ item: { id } }` envelope, so accept both rather than
      // breaking on a shape change.
      const record = parsed as { id?: string; item?: { id?: string } };
      const id = record.item?.id ?? record.id;
      if (id === undefined) throw new Error(`pm create returned no id: ${raw}`);
      return id;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };

  sandbox.git("init", "-q", "-b", "main");
  // Identity and signing are set per-sandbox so the suite never depends on, and
  // never writes to, the machine's global git configuration.
  sandbox.git("config", "user.email", "harness@example.invalid");
  sandbox.git("config", "user.name", "pm-vcs harness");
  sandbox.git("config", "commit.gpgsign", "false");

  sandbox.pm("init", "sbx", "--yes");
  if (options.mergeInstall !== false) sandbox.pm("merge", "install");
  if (options.commitFence !== false) sandbox.commit("Initialize tracker");

  return sandbox;
}

/**
 * Creates a sandbox with one item and two branches that both changed it.
 *
 * `agent-a` raises the item's priority and appends a note; `agent-b` lowers the
 * same priority and appends a different note. That is the canonical multi-agent
 * divergence: one scalar both sides changed (a genuine conflict) alongside one
 * commutative collection both sides appended to (a lossless union), so a single
 * fixture exercises both resolution paths and the history stream union.
 *
 * HEAD is left on `agent-a`.
 *
 * @returns The sandbox, the item id, and the merge-base commit.
 */
export function createDivergedSandbox(): { sandbox: Sandbox; itemId: string; base: string } {
  const sandbox = createSandbox();
  const itemId = sandbox.createItem("Task", "Shared item both agents edit");
  const base = sandbox.commit("Add the shared item");

  sandbox.git("checkout", "-q", "-b", "agent-a");
  sandbox.pm("update", itemId, "--priority", "1");
  sandbox.pm("notes", itemId, "--add", "Note written by agent A");
  sandbox.commit("Agent A: raise priority and add a note");

  sandbox.git("checkout", "-q", "-b", "agent-b", base);
  sandbox.pm("update", itemId, "--priority", "3");
  sandbox.pm("notes", itemId, "--add", "Note written by agent B");
  sandbox.commit("Agent B: lower priority and add a note");

  sandbox.git("checkout", "-q", "agent-a");
  return { sandbox, itemId, base };
}
