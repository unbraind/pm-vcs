// Ref storage: branches, tags, and HEAD.
//
// The important property here is not where the files live, it is that every
// update is a compare-and-swap under an exclusive lock. Several agents share one
// repository in the workflows this package exists for, and a last-write-wins ref
// update is exactly how one agent's commit disappears with nothing reporting it:
// both read the same tip, both commit on top of it, both write their own commit
// as the new tip, and the second write silently discards the first.

import type { Dirent } from "node:fs";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, posix, sep } from "node:path";

import { compareByteOrder } from "./model.ts";
import { isObjectId, type ObjectId, ObjectStoreError } from "./objects.ts";

/** Prefix under which branch refs live. */
export const BRANCH_PREFIX = "refs/heads/";

/** Prefix under which tag refs live. */
export const TAG_PREFIX = "refs/tags/";

/** What HEAD currently points at. */
export type HeadState =
  /** HEAD names a branch, which may or may not exist yet (an unborn branch). */
  | { readonly kind: "branch"; readonly ref: string; readonly target: ObjectId | null }
  /** HEAD names a commit directly, so commits made here advance no branch. */
  | { readonly kind: "detached"; readonly target: ObjectId };

/** A ref name paired with the commit it points at. */
export interface RefEntry {
  /** Full ref name, e.g. `refs/heads/main`. */
  readonly name: string;
  /** The commit the ref points at. */
  readonly target: ObjectId;
}

/**
 * Rejects a ref name that is unsafe or ambiguous.
 *
 * Ref names become path segments, so traversal (`..`), absolute paths and
 * backslashes have to be refused before the name reaches the filesystem. The
 * remaining rules keep names unambiguous when they are printed and re-parsed.
 *
 * @param name - Full ref name, e.g. `refs/heads/feature`.
 * @throws ObjectStoreError When the name is empty, traverses, has an empty or
 *   dot-only segment, or contains whitespace or control characters.
 */
export function assertRefName(name: string): void {
  const reject = (reason: string): never => {
    throw new ObjectStoreError("invalid_ref_name", `Ref name "${name}" is invalid: ${reason}`);
  };
  if (name.length === 0) reject("it is empty");
  if (name.startsWith("/") || name.endsWith("/")) reject("it starts or ends with a slash");
  if (name.includes("\\")) reject("it contains a backslash");
  // Control characters, space and DEL cannot appear in a path segment safely;
  // the rest are reserved so a printed ref name can be re-parsed unambiguously.
  if (/[\u0000-\u0020\u007f~^:?*[\]]/.test(name)) {
    reject("it contains whitespace, a control character, or one of ~^:?*[]");
  }
  for (const segment of name.split("/")) {
    if (segment.length === 0) reject("it contains an empty path segment");
    if (segment === "." || segment === "..") reject("it contains a relative path segment");
    if (segment.endsWith(".lock")) reject("a segment ends with .lock");
  }
}

/**
 * Reads a file as UTF-8, returning null when it does not exist.
 *
 * @param path - File to read.
 * @returns The trimmed contents, or null when absent.
 */
function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Writes a file atomically: temp file, fsync, rename over the destination.
 *
 * @param path - Destination path.
 * @param contents - Text to write. A trailing newline is added.
 */
function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = openSync(temporary, "w");
  try {
    writeSync(handle, `${contents}\n`);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
}

/**
 * Branch, tag and HEAD storage for one repository.
 */
export class RefStore {
  /** Absolute path to the repository's control directory. */
  private readonly root: string;

  /**
   * @param root - The control directory (`.pmvcs`). Created on demand.
   */
  constructor(root: string) {
    this.root = root;
  }

  /**
   * Absolute path backing a ref.
   *
   * @param name - A ref name already validated by {@link assertRefName}.
   * @returns The path, which may or may not exist.
   */
  private pathFor(name: string): string {
    return join(this.root, ...name.split("/"));
  }

  /**
   * Reads a ref's target.
   *
   * @param name - Full ref name.
   * @returns The commit id, or null when the ref does not exist.
   * @throws ObjectStoreError When the name is invalid or the stored value is not
   *   an object id.
   */
  read(name: string): ObjectId | null {
    assertRefName(name);
    const value = readTrimmed(this.pathFor(name));
    if (value === null) return null;
    if (!isObjectId(value)) {
      throw new ObjectStoreError("corrupt_ref", `Ref ${name} holds "${value}", which is not an object id.`);
    }
    return value;
  }

  /**
   * Updates a ref only if it still holds the value the caller last saw.
   *
   * Held under an exclusive lock file so the read-compare-write is not
   * interleaved with another process doing the same. `openSync(..., "wx")` fails
   * if the lock exists, which is the atomic test-and-set this relies on.
   *
   * @param name - Full ref name.
   * @param expected - The value the caller believes the ref holds, or null to
   *   require that it does not exist.
   * @param next - The value to store, or null to delete the ref.
   * @throws ObjectStoreError When the ref no longer holds `expected`, or when
   *   another process holds the lock.
   */
  compareAndSwap(name: string, expected: ObjectId | null, next: ObjectId | null): void {
    assertRefName(name);
    const path = this.pathFor(name);
    const lockPath = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true });
    let lock: number;
    try {
      lock = openSync(lockPath, "wx");
    } catch {
      throw new ObjectStoreError("ref_locked", `Ref ${name} is locked by another process (${lockPath}).`);
    }
    try {
      const current = readTrimmed(path);
      if (current !== expected) {
        throw new ObjectStoreError(
          "ref_changed",
          `Ref ${name} holds ${current ?? "nothing"} but the update expected ${expected ?? "nothing"}. `
          + "Re-read the ref and retry: another agent advanced it.",
        );
      }
      if (next === null) rmSync(path, { force: true });
      else writeAtomic(path, next);
    } finally {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }

  /**
   * Lists every ref under a prefix, sorted by name.
   *
   * @param prefix - Ref prefix, e.g. {@link BRANCH_PREFIX}.
   * @returns The matching refs and their targets.
   */
  list(prefix: string): RefEntry[] {
    const base = join(this.root, ...prefix.split("/").filter(Boolean));
    const found: RefEntry[] = [];
    const walk = (directory: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (entry.name.endsWith(".lock") || entry.name.endsWith(".tmp")) continue;
        const value = readTrimmed(path);
        if (value === null || !isObjectId(value)) continue;
        const relative = path.slice(base.length + 1).split(sep).join(posix.sep);
        found.push({ name: `${prefix}${relative}`, target: value });
      }
    };
    walk(base);
    return found.sort((left, right) => compareByteOrder(left.name, right.name));
  }

  /**
   * Reads HEAD.
   *
   * An unborn branch — HEAD naming a ref that does not exist yet — is a real and
   * expected state, not an error: it is what a freshly initialised repository
   * looks like before its first commit.
   *
   * @returns What HEAD points at.
   * @throws ObjectStoreError When HEAD is absent or holds neither a symbolic ref
   *   nor an object id.
   */
  readHead(): HeadState {
    const raw = readTrimmed(join(this.root, "HEAD"));
    if (raw === null) {
      throw new ObjectStoreError("corrupt_head", "HEAD is missing. This directory is not an initialised repository.");
    }
    if (raw.startsWith("ref: ")) {
      const ref = raw.slice(5).trim();
      assertRefName(ref);
      return { kind: "branch", ref, target: this.read(ref) };
    }
    if (!isObjectId(raw)) {
      throw new ObjectStoreError("corrupt_head", `HEAD holds "${raw}", which is neither a symbolic ref nor an object id.`);
    }
    return { kind: "detached", target: raw };
  }

  /**
   * Points HEAD at a branch, whether or not that branch exists yet.
   *
   * @param ref - Full branch ref name.
   */
  setHeadToRef(ref: string): void {
    assertRefName(ref);
    writeAtomic(join(this.root, "HEAD"), `ref: ${ref}`);
  }

  /**
   * Points HEAD directly at a commit, detaching it from any branch.
   *
   * @param target - The commit id.
   * @throws ObjectStoreError When the id is malformed.
   */
  setHeadDetached(target: ObjectId): void {
    if (!isObjectId(target)) {
      throw new ObjectStoreError("invalid_object_id", `"${target}" is not a valid object id.`);
    }
    writeAtomic(join(this.root, "HEAD"), target);
  }

  /**
   * Resolves HEAD to a commit.
   *
   * @returns The commit HEAD names, or null on an unborn branch.
   */
  resolveHead(): ObjectId | null {
    return this.readHead().target;
  }
}
