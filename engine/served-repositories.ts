// Repository discovery uses operator-owned filesystem entries, never request names.

import { existsSync, lstatSync, opendirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { isServedRepositoryName } from "./http-protocol.ts";
import { ObjectStoreError } from "./objects.ts";

/** Bounds on catalogue traversal and refresh work. */
export interface RepositoryDiscoveryLimits {
  /** Maximum directory entries examined by one scan. */
  readonly maxEntries: number;
  /** Maximum directory nesting below the root. */
  readonly maxDepth: number;
  /** Minimum milliseconds between scans prompted by missing names. */
  readonly refreshIntervalMs: number;
}

/** Default catalogue bounds, independent of client-provided request limits. */
export const DEFAULT_REPOSITORY_DISCOVERY_LIMITS: RepositoryDiscoveryLimits = {
  maxEntries: 10_000,
  maxDepth: 32,
  refreshIntervalMs: 1_000,
};

/**
 * Checks a catalogue directory without accepting repository or control aliases.
 *
 * @param directory - Canonical directory obtained from filesystem discovery.
 * @returns Whether the directory still owns an ordinary repository store.
 */
export function isServableRepositoryDirectory(directory: string): boolean {
  try {
    if (realpathSync(directory) !== directory) return false;
    const control = join(directory, ".pmvcs");
    const entry = lstatSync(control);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
    if (existsSync(join(control, "link.json"))) return false;
    for (const name of ["format", "config.json", "HEAD", "objects", "refs"]) {
      if (lstatSync(join(control, name)).isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** A repository catalogue whose values originate exclusively in filesystem enumeration. */
export class ServedRepositoryDirectories {
  /** Real served root, fixed by operator configuration. */
  private readonly root: string;
  /** Filesystem work bounds fixed at startup. */
  private readonly limits: RepositoryDiscoveryLimits;
  /** Clock used only to throttle refreshes. */
  private readonly clock: () => number;
  /** Canonical relative names to real repository directories. */
  private directories = new Map<string, string>();
  /** Earliest time a missing name may trigger another scan. */
  private nextRefresh = 0;

  /**
   * Builds the initial catalogue before any requests are accepted.
   *
   * @param root - Operator-configured served directory.
   * @param limits - Filesystem traversal and refresh bounds.
   * @param clock - Millisecond clock for refresh throttling.
   * @throws ObjectStoreError When a discovery bound is not a positive safe integer.
   */
  constructor(
    root: string,
    limits: RepositoryDiscoveryLimits = DEFAULT_REPOSITORY_DISCOVERY_LIMITS,
    clock: () => number = Date.now,
  ) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new ObjectStoreError("bad_limits", "Discovery limits must be positive safe integers.");
      }
    }
    this.limits = limits;
    this.clock = clock;
    this.root = realpathSync(root);
    this.refresh();
  }

  /**
   * Resolves a request name solely by exact lookup, rescanning on a bounded miss.
   *
   * @param name - Request-provided name, used only as a Map key.
   * @returns A filesystem-discovered path, or undefined for an unknown name.
   */
  lookup(name: string): string | undefined {
    let directory = this.directories.get(name);
    if (directory === undefined && this.clock() >= this.nextRefresh) {
      this.refresh();
      directory = this.directories.get(name);
    }
    return directory;
  }

  /** Replaces the catalogue using a bounded scan that receives no request text. */
  private refresh(): void {
    this.nextRefresh = this.clock() + this.limits.refreshIntervalMs;
    const directories = new Map<string, string>();
    const pending = [{ path: this.root, name: "", depth: 0 }];
    let examined = 0;
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const current = pending[cursor];
      try {
        const directory = realpathSync(current.path);
        // Reject all aliases, including symlinks escaping the root. Every
        // pending path was joined only from directory entries below this root.
        if (directory !== current.path) continue;
        if (isServableRepositoryDirectory(directory)) directories.set(current.name, directory);
        if (current.depth >= this.limits.maxDepth || examined >= this.limits.maxEntries) continue;
        const handle = opendirSync(directory);
        try {
          while (examined < this.limits.maxEntries) {
            const entry = handle.readSync();
            if (entry === null) break;
            examined += 1;
            const name = current.name === "" ? entry.name : `${current.name}/${entry.name}`;
            if ((entry.isDirectory() || entry.isSymbolicLink()) && isServedRepositoryName(name)) {
              pending.push({ path: join(directory, entry.name), name, depth: current.depth + 1 });
            }
          }
        } finally {
          handle.closeSync();
        }
      } catch {
        // Missing, unreadable or concurrently replaced entries are not served.
      }
    }
    this.directories = directories;
  }
}
