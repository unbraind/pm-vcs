// The boundary between "what distribution means" and "how the bytes travel".
//
// Fetch, push and clone are algorithms about reachability, fast-forwards and
// compare-and-swap ref updates. None of that is a property of the wire, so none of
// it is written against a filesystem path, a socket, or a URL. It is written
// against this interface, and the one implementation here reaches a repository
// through the filesystem — which is a real transport for the case that actually
// occurs today: several agents, several working trees, one host.
//
// The authoritative fast-forward check lives on the receiving side rather than in
// the caller. The repository being written to is the one with something to lose,
// and a check the sender performs is a check a sender can skip.

import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import { exportBundle, importBundleObjects, assertClosurePresent } from "./bundle.ts";
import { isAncestor } from "./merge.ts";
import { type ObjectId, ObjectStoreError } from "./objects.ts";
import { BRANCH_PREFIX, type RefEntry, TAG_PREFIX } from "./refs.ts";
import type { RepositoryConfig } from "./config.ts";
import { Repository } from "./repo.ts";

/** What a remote repository says about itself when first contacted. */
export interface Advertisement {
  /** Every branch and tag the remote publishes, with the commit each points at. */
  readonly refs: readonly RefEntry[];
  /**
   * The full ref name the remote's HEAD is attached to, or null when it is
   * detached or the branch is unborn. Clone uses it to decide which branch to
   * check out, so a remote with no answer clones to an empty working tree rather
   * than picking one arbitrarily.
   */
  readonly head: string | null;
  /**
   * The remote's record configuration.
   *
   * Advertised because a clone that does not adopt it stores the same paths as
   * blobs instead of records and merges them line by line — two repositories that
   * share commits but disagree about what those commits mean.
   */
  readonly config: RepositoryConfig;
}

/** One ref a push asks the remote to move. */
export interface PushUpdate {
  /** Full ref name on the remote. */
  readonly ref: string;
  /** The value the pusher observed, or null when it expects the ref to be absent. */
  readonly expected: ObjectId | null;
  /** The commit the ref should end up at. */
  readonly next: ObjectId;
}

/** What a remote did with a push. */
export interface PushReceipt {
  /** Refs that moved, with the value each moved from. */
  readonly updated: readonly PushUpdate[];
  /** Objects the remote did not already hold and therefore stored. */
  readonly added: readonly ObjectId[];
}

/**
 * A remote repository, reachable somehow.
 *
 * Implementations own the transfer. They do not own the policy: an implementation
 * that skipped the fast-forward refusal in {@link Transport.push} would be a
 * different product, not a different transport.
 */
export interface Transport {
  /** Where this transport points, as the remote was configured. */
  readonly url: string;

  /**
   * Asks the remote what it has.
   *
   * @returns Its refs, the branch its HEAD names, and its record configuration.
   */
  advertise(): Advertisement;

  /**
   * Asks the remote for the history behind some of its refs.
   *
   * @param refNames - Full ref names to transfer. Empty means every branch and tag.
   * @param haves - Commits the caller offers as already held. The remote keeps only
   *   the ones it actually has and excludes everything reachable from them, which
   *   is the whole of the negotiation.
   * @returns A bundle carrying the objects the caller is missing.
   */
  fetch(refNames: readonly string[], haves: readonly ObjectId[]): Buffer;

  /**
   * Sends history and asks the remote to move refs onto it.
   *
   * @param bundle - Objects the remote may be missing.
   * @param updates - The ref moves being requested.
   * @param force - Whether to allow a move that discards commits the remote has.
   * @param now - Timestamp recorded in the remote's operation log.
   * @returns What moved and what was stored.
   * @throws ObjectStoreError When a move is not a fast-forward and `force` is
   *   false, or when another writer changed a ref between observation and write.
   */
  push(bundle: Buffer, updates: readonly PushUpdate[], force: boolean, now: Date): PushReceipt;
}

/**
 * A remote repository on the same filesystem.
 */
export class FileTransport implements Transport {
  /** The URL this transport was opened from, kept for messages. */
  readonly url: string;

  /** Absolute path to the remote repository's working tree root. */
  private readonly path: string;

  /**
   * @param url - The location as configured, for error messages.
   * @param path - Absolute path to the remote repository's root.
   */
  constructor(url: string, path: string) {
    this.url = url;
    this.path = path;
  }

  /**
   * Opens the remote repository, reporting an unusable location as such.
   *
   * @returns The opened repository.
   * @throws ObjectStoreError When there is no repository at the configured path.
   */
  private open(): Repository {
    try {
      return Repository.open(this.path);
    } catch (error) {
      if (error instanceof ObjectStoreError && error.code === "not_a_repository") {
        throw new ObjectStoreError(
          "unreachable_remote",
          `${this.url} does not hold a repository. Check the remote's URL, or run init there first.`,
        );
      }
      throw error;
    }
  }

  /** @inheritdoc */
  advertise(): Advertisement {
    const repository = this.open();
    const head = repository.refs.readHead();
    return {
      refs: [...repository.refs.list(BRANCH_PREFIX), ...repository.refs.list(TAG_PREFIX)],
      head: head.kind === "branch" ? head.ref : null,
      config: repository.config,
    };
  }

  /** @inheritdoc */
  fetch(refNames: readonly string[], haves: readonly ObjectId[]): Buffer {
    const repository = this.open();
    // The offer is filtered rather than trusted. A caller's tips include commits
    // this repository has never seen — its own local work, and the tips of other
    // remotes it fetched from — and using one as an exclusion boundary would walk
    // history that is not here and fail the whole fetch with a missing-object error
    // that names an object the caller does have.
    const common = haves.filter((id) => repository.objects.has(id));
    return exportBundle(repository.objects, repository.refs, refNames, common);
  }

  /** @inheritdoc */
  push(bundle: Buffer, updates: readonly PushUpdate[], force: boolean, now: Date): PushReceipt {
    const repository = this.open();
    const { added } = importBundleObjects(repository.objects, bundle);
    for (const update of updates) {
      // A push is defined over branches and tags. The ref name is otherwise only
      // checked for well-formedness, so without this a sender could move the
      // receiver's `refs/remotes/other/main` — rewriting what this repository
      // believes a third party published — and the receiver would log it as an
      // ordinary push. The check belongs here rather than in the caller for the
      // same reason the fast-forward check does: a sender-side check is one a
      // sender can skip, and `Transport` is a published interface that a
      // privilege-crossing implementation would inherit.
      if (!update.ref.startsWith(BRANCH_PREFIX) && !update.ref.startsWith(TAG_PREFIX)) {
        throw new ObjectStoreError(
          "unpushable_ref",
          `A push may only move branches and tags, and ${update.ref} is neither. `
          + `Push a ${BRANCH_PREFIX} or ${TAG_PREFIX} name instead.`,
        );
      }
      assertClosurePresent(repository.objects, update.ref, update.next);
      const current = repository.refs.read(update.ref);
      if (current === null || current === update.next) continue;
      if (!force && !isAncestor(repository.objects, current, update.next)) {
        throw new ObjectStoreError(
          "non_fast_forward",
          `Pushing ${update.next.slice(0, 12)} to ${update.ref} would discard commits ${this.url} already has, `
          + `because its current ${current.slice(0, 12)} is not an ancestor of it. `
          + "Fetch and merge or rebase first, or push with --force to discard them deliberately.",
        );
      }
    }
    // One transaction for every ref, and every entry a compare-and-swap against the
    // value the pusher observed. Two agents pushing the same branch concurrently
    // both pass the fast-forward check above against the same old tip; without the
    // swap the second write would land on top of the first and the first agent's
    // commit would be reachable from nothing.
    repository.refs.transaction(updates.map((update) => ({
      name: update.ref,
      expected: update.expected,
      next: update.next,
    })));
    repository.operations.append(
      "push",
      `Received ${updates.length} ref(s) from ${this.url}${force ? " (forced)" : ""}.`,
      updates.map((update) => ({ ref: update.ref, before: update.expected, after: update.next })),
      now,
    );
    return { updated: updates, added };
  }
}

/**
 * Resolves a configured remote location to an absolute filesystem path.
 *
 * A URL naming a scheme this build cannot serve is refused by name. Falling
 * through to the filesystem instead would resolve `https://example.com/repo` as a
 * directory and report that it does not hold a repository — which reads as "the
 * remote is empty" rather than "this build cannot speak that protocol", and sends
 * the agent looking in the wrong place entirely.
 *
 * Callers that persist a remote store the resolved value rather than the one the
 * agent typed. A relative location means different directories depending on where
 * it is read from, so the repository that recorded it and the repository that
 * later fetches from it would disagree about where the remote is.
 *
 * @param url - The remote's configured location: a path, or a `file:` URL.
 * @param base - Directory a relative path is resolved against.
 * @returns An absolute path to the remote repository's root.
 * @throws ObjectStoreError When the URL names an unsupported scheme, or is a
 *   `file:` URL that names no local path.
 */
export function resolveRemoteLocation(url: string, base: string): string {
  // Two or more characters before the colon, so a Windows drive letter is a path
  // and not a scheme called "c".
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]+):/.exec(url);
  if (scheme === null) return isAbsolute(url) ? url : resolve(base, url);
  if (scheme[1].toLowerCase() !== "file") {
    throw new ObjectStoreError(
      "unsupported_transport",
      `This build cannot reach a remote over "${scheme[1]}". `
      + "Supported locations are filesystem paths and file: URLs.",
    );
  }
  try {
    return fileURLToPath(url);
  } catch {
    // `file://host/repo` and `file:///a%2Fb` parse as URLs but name no local path.
    // Node reports that as a raw TypeError, which reads as a crash rather than as
    // a remote this build cannot reach.
    throw new ObjectStoreError(
      "unsupported_transport",
      `${url} is a file: URL that names no local path. `
      + "Use a host-less URL over an unescaped path, for example file:///srv/project.",
    );
  }
}

/**
 * Opens a transport for a configured remote URL.
 *
 * @param url - The remote's configured location: a path, or a `file:` URL.
 * @param base - Directory a relative path is resolved against.
 * @returns A transport for it.
 * @throws ObjectStoreError When the URL cannot be resolved to a local repository.
 */
export function openTransport(url: string, base: string): Transport {
  return new FileTransport(url, resolveRemoteLocation(url, base));
}
