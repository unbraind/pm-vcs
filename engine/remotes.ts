// Named remotes, and the tracking refs that remember where they were.
//
// Remotes deliberately do not live in config.json. That file holds the settings
// that shape history itself — which paths are records, how their fields merge —
// and every repository sharing a history has to agree on them or the same commits
// mean different things in different clones. The set of remotes is the opposite
// kind of fact: it is local to one clone, it differs between agents working on the
// same project, and nothing about it belongs in the history they share. Storing
// the two together would make every `remote add` look like a change to how the
// repository merges.

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { ObjectStoreError } from "./objects.ts";
import { compareByteOrder } from "./model.ts";

/** Prefix under which remote-tracking refs live. */
export const REMOTE_PREFIX = "refs/remotes/";

/** Clone-local name and transport location for another repository. */
export interface Remote {
  /** The name the local repository refers to it by, e.g. `origin`. */
  readonly name: string;
  /** Where it lives, in a form {@link openTransport} understands. */
  readonly url: string;
}

/**
 * Rejects a remote name that cannot safely become part of a ref name.
 *
 * A remote's name is interpolated into `refs/remotes/<name>/<branch>`, so a name
 * containing a slash would silently re-parent every tracking ref it owns: a remote
 * called `a/b` and a remote called `a` with a branch `b` produce colliding ref
 * names, and a later fetch on one would overwrite the other's tracking state with
 * nothing reporting it. Empty and dot-only names are refused for the same reason —
 * they resolve to a directory that is not the one the name reads as.
 *
 * @param name - Candidate remote name.
 * @throws ObjectStoreError When the name is empty, dot-only, or contains a path
 *   separator, whitespace, or a character reserved in ref names.
 */
export function assertRemoteName(name: string): void {
  const reject = (reason: string): never => {
    throw new ObjectStoreError("invalid_remote_name", `Remote name "${name}" is invalid: ${reason}`);
  };
  if (name.length === 0) reject("it is empty");
  if (name === "." || name === "..") reject("it is a relative path segment");
  if (name.includes("/") || name.includes("\\")) reject("it contains a path separator");
  if (/[\u0000-\u0020\u007f~^:?*[\]]/.test(name)) {
    reject("it contains whitespace, a control character, or one of ~^:?*[]");
  }
}

/**
 * Full tracking ref name for a branch on a remote.
 *
 * @param remote - Remote name, already validated.
 * @param branch - Branch name as the remote knows it, without any prefix.
 * @returns The local ref name that remembers the remote's value for that branch.
 */
export function trackingRef(remote: string, branch: string): string {
  return `${REMOTE_PREFIX}${remote}/${branch}`;
}

/**
 * Validates one parsed remote entry.
 *
 * @param name - The key the entry was filed under.
 * @param url - The value stored for it.
 * @returns The validated remote.
 * @throws ObjectStoreError When the name is unusable or the URL is not a string.
 */
function parseRemote(name: string, url: unknown): Remote {
  assertRemoteName(name);
  if (typeof url !== "string" || url.length === 0) {
    throw new ObjectStoreError(
      "bad_remotes",
      `Remote "${name}" is stored with "${String(url)}", which is not a location.`,
    );
  }
  return { name, url };
}

/**
 * The remotes one repository knows about, backed by a single JSON file.
 */
export class RemoteStore {
  /** Absolute path to the JSON file holding the remotes. */
  private readonly path: string;

  /**
   * @param path - File the remotes are stored in. Need not exist yet.
   */
  constructor(path: string) {
    this.path = path;
  }

  /**
   * Reads every configured remote, ordered by name.
   *
   * An absent file means no remotes, which is the ordinary state of a repository
   * created by `init`. A file that exists and will not parse is fatal instead:
   * reporting a corrupt remotes file as "no remotes" would make `push` answer that
   * the remote does not exist, sending an agent to re-add a remote that is already
   * there and whose URL it would then have to guess.
   *
   * @returns The remotes, sorted by name.
   * @throws ObjectStoreError When the file exists but is not a valid remote map.
   */
  list(): Remote[] {
    let contents: string;
    try {
      contents = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new ObjectStoreError("bad_remotes", `The remotes file at ${this.path} is not valid JSON.`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ObjectStoreError("bad_remotes", `The remotes file at ${this.path} is not a JSON object.`);
    }
    return Object.entries(parsed as Record<string, unknown>)
      .map(([name, url]) => parseRemote(name, url))
      .sort((left, right) => compareByteOrder(left.name, right.name));
  }

  /**
   * Looks a remote up by name.
   *
   * @param name - Remote name.
   * @returns The remote, or null when none is configured under that name.
   */
  read(name: string): Remote | null {
    return this.list().find((remote) => remote.name === name) ?? null;
  }

  /**
   * Looks a remote up and fails when it is absent.
   *
   * @param name - Remote name.
   * @returns The remote.
   * @throws ObjectStoreError When no remote is configured under that name.
   */
  require(name: string): Remote {
    const remote = this.read(name);
    if (remote === null) {
      const known = this.list().map((entry) => entry.name);
      throw new ObjectStoreError(
        "unknown_remote",
        `No remote named ${name}. `
        + (known.length === 0 ? "This repository has no remotes." : `Configured remotes: ${known.join(", ")}.`),
      );
    }
    return remote;
  }

  /**
   * Registers a new remote.
   *
   * Refuses a name already in use rather than replacing its URL. Silently
   * repointing `origin` would send the next push to a different repository than
   * the one the agent believes it is pushing to, and nothing in the output of the
   * push would say so.
   *
   * @param name - Name to register.
   * @param url - Where the remote lives.
   * @returns The stored remote.
   * @throws ObjectStoreError When the name is unusable or already registered.
   */
  add(name: string, url: string): Remote {
    assertRemoteName(name);
    const remotes = this.list();
    if (remotes.some((remote) => remote.name === name)) {
      throw new ObjectStoreError(
        "remote_exists",
        `A remote named ${name} is already configured. Remove it first, or choose another name.`,
      );
    }
    const remote = parseRemote(name, url);
    this.write([...remotes, remote]);
    return remote;
  }

  /**
   * Removes a remote.
   *
   * Tracking refs are left in place on purpose: they are the only local record of
   * what that remote had, and deleting them alongside the name would discard
   * history the repository may be the last holder of.
   *
   * @param name - Remote to remove.
   * @throws ObjectStoreError When no remote is configured under that name.
   */
  remove(name: string): void {
    const remotes = this.list();
    if (!remotes.some((remote) => remote.name === name)) {
      throw new ObjectStoreError("unknown_remote", `No remote named ${name} to remove.`);
    }
    this.write(remotes.filter((remote) => remote.name !== name));
  }

  /**
   * Replaces the whole remote map on disk, atomically.
   *
   * Written to a temporary file and renamed over the destination, the way every
   * other durable file in this engine is written. A direct write truncates first,
   * so a crash mid-write leaves a file that no longer parses — and since every
   * `fetch`, `push` and `remote` reads this map, all three then fail with
   * `bad_remotes` until an agent repairs it by hand.
   *
   * @param remotes - The remotes to store.
   * @throws Error When the file cannot be written or renamed into place.
   */
  private write(remotes: readonly Remote[]): void {
    const map: Record<string, string> = {};
    for (const remote of [...remotes].sort((left, right) => compareByteOrder(left.name, right.name))) {
      map[remote.name] = remote.url;
    }
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(map, null, 2)}\n`, { flag: "wx" });
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
