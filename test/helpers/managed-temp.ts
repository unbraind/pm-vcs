/** Test-owned tasks and handles settle before asynchronous, retry-bounded fixture removal. */
import { type ChildProcess } from "node:child_process";
import { type FSWatcher } from "node:fs";
import { rm } from "node:fs/promises";
import { makeTempDir } from "./tmp.ts";

/** A fixture owns only explicitly registered tasks, children and watchers. */
export function makeManagedTempDir() {
  const { root } = makeTempDir();
  const resources: { stop?: () => void; done: Promise<unknown> }[] = [];
  /** Observe early rejection immediately while preserving the original failure for teardown. */
  const own = (done: Promise<unknown>, stop?: () => void): void => { void done.catch(() => {}); resources.push({ done, stop }); };
  return {
    root,
    /** Register asynchronous fixture work at creation, before beginning teardown. */
    task<T>(work: Promise<T>): Promise<T> { own(work); return work; },
    /** Child close follows exit and pipe closure; a synchronous-looking exit alone is insufficient. */
    child(child: ChildProcess): ChildProcess {
      const done = new Promise<void>((resolve, reject) => { let failure: Error | undefined; child.once("error", error => { failure = error; }); child.once("close", () => { if (failure === undefined) resolve(); else reject(failure); }); });
      own(done); return child;
    },
    /** Stop every owned watcher, then wait for its close event before removing watched directories. */
    watcher(watcher: FSWatcher): FSWatcher {
      const done = new Promise<void>((resolve, reject) => { let failure: Error | undefined; watcher.once("error", error => { failure = error; }); watcher.once("close", () => { if (failure === undefined) resolve(); else reject(failure); }); });
      own(done, () => watcher.close()); return watcher;
    },
    /** Drain all registered work, including resources registered by a settling callback; retain every failure. */
    async cleanup(): Promise<void> {
      const failures: unknown[] = []; let drained = 0;
      while (drained < resources.length) {
        const batch = resources.slice(drained); drained += batch.length;
        for (const resource of batch) try { resource.stop?.(); } catch (error) { failures.push(error); }
        for (const result of await Promise.allSettled(batch.map(resource => resource.done))) if (result.status === "rejected") failures.push(result.reason);
      }
      try { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); } catch (error) { failures.push(error); }
      if (failures.length > 0) throw new AggregateError(failures, "Fixture teardown failed after settling owned resources.");
    },
  };
}
