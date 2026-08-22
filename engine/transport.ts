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
import { type ObjectId, type ObjectType, ObjectStoreError, hashObject } from "./objects.ts";
import { BRANCH_PREFIX, type RefEntry, TAG_PREFIX } from "./refs.ts";
import type { RepositoryConfig } from "./config.ts";
import { REPOSITORY_FORMAT, Repository } from "./repo.ts";

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
  /**
   * The repository format the remote reads and writes.
   *
   * Exchanged before any data moves because two repositories that disagree about
   * the object format cannot reason about each other's bytes at all: every id
   * the one sends is meaningless to the other, and a transfer between them would
   * corrupt both rather than fail cleanly.
   */
  readonly formatVersion: string;
  /** What the remote's transport can do, from {@link TRANSPORT_CAPABILITIES}. */
  readonly capabilities: readonly string[];
}

/** Capabilities this build's transports speak. */
export const TRANSPORT_CAPABILITIES = ["fetch", "push", "resumable-upload", "verified-arrival"] as const;

/** Capabilities a peer must offer before this build will transfer anything. */
export const REQUIRED_TRANSPORT_CAPABILITIES: readonly string[] = ["fetch", "push", "resumable-upload", "verified-arrival"];

/**
 * Refuses a peer whose format version or capabilities this build cannot work with.
 *
 * The check belongs at the handshake, before a single byte of history moves:
 * refusing after a transfer has begun would leave one side holding objects the
 * other will never publish to, and refusing after refs have moved would leave
 * the pair disagreeing about history that now exists on one side only.
 *
 * @param peer - What the remote said about itself in its advertisement.
 * @returns True when the peer is compatible; otherwise it throws.
 * @throws ObjectStoreError With code `incompatible_peer` when the peer's format
 *   version differs from {@link REPOSITORY_FORMAT} or it lacks any capability
 *   in {@link REQUIRED_TRANSPORT_CAPABILITIES}.
 */
export function assertCompatiblePeer(peer: Advertisement): boolean {
  if (peer.formatVersion !== REPOSITORY_FORMAT) {
    throw new ObjectStoreError(
      "incompatible_peer",
      `The peer speaks repository format "${peer.formatVersion}", this build speaks "${REPOSITORY_FORMAT}". `
        + "Neither side can interpret the other's objects, so nothing was transferred and no ref moved.",
    );
  }
  const missing = REQUIRED_TRANSPORT_CAPABILITIES.filter((capability) => !peer.capabilities.includes(capability));
  if (missing.length > 0) {
    throw new ObjectStoreError(
      "incompatible_peer",
      `The peer does not offer ${missing.join(", ")}, which this build requires before transferring history. `
        + "Nothing was transferred and no ref moved.",
    );
  }
  return true;
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

/** Authoritative receiver receipt listing ref movements and newly accepted objects after publication. */
export interface PushReceipt {
  /** Refs that moved, with the value each moved from. */
  readonly updated: readonly PushUpdate[];
  /** Objects the remote did not already hold and therefore stored. */
  readonly added: readonly ObjectId[];
}

/** One object crossing the wire during a resumable upload. */
export interface TransferObject {
  /** The id the sender claims the content hashes to. */
  readonly id: ObjectId;
  /** The object's kind. */
  readonly type: ObjectType;
  /** The object's raw content. */
  readonly payload: Buffer;
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

  /**
   * Asks the receiver which of the offered objects it still lacks.
   *
   * This is what makes an interrupted upload resumable: the sender asks before
   * sending and asks again after an interruption, and each answer names only
   * what is still missing, so a resumed transfer never resends an object the
   * receiver already verified and stored.
   *
   * @param ids - Object ids the sender intends to transfer.
   * @returns The subset the receiver does not hold, in the order offered.
   */
  missingObjects(ids: readonly ObjectId[]): readonly ObjectId[];

  /**
   * Streams objects into the receiver's store, each verified on arrival.
   *
   * Verification is the receiver's job, not the sender's: a sender-side check
   * is one a sender can skip. An object whose content does not hash to its
   * claimed id is refused and not stored, so nothing can enter the store under
   * a name that does not describe it.
   *
   * @param objects - The objects to transfer.
   * @throws ObjectStoreError When any object's content does not hash to its id.
   */
  uploadObjects(objects: readonly TransferObject[]): void;

  /**
   * Publishes ref moves after an object upload, refusing until the closure is complete.
   *
   * Publication is the one step that must not happen partially: every ref move
   * is a compare-and-swap against the value the sender observed, so a push that
   * lost a race fails without moving anything, and the failure is retryable —
   * re-read the advertisement and try again.
   *
   * @param updates - The ref moves being requested.
   * @param force - Whether to allow a move that discards commits the remote has.
   * @param now - Timestamp recorded in the remote's operation log.
   * @returns What moved and what was stored.
   * @throws ObjectStoreError With code `incomplete_closure` when the receiver
   *   could not verify every object a moved ref would name; with code
   *   `publication_race` when another writer moved a ref between the sender's
   *   observation and this publication; with the {@link Transport.push} refusal
   *   codes for non-fast-forward moves and unpushable refs.
   */
  publish(updates: readonly PushUpdate[], force: boolean, now: Date): PushReceipt;
}

/**
 * Translates a refused publication transaction into the error the sender sees.
 *
 * The transaction's compare-and-swap is the authority on races between the
 * pre-check in {@link FileTransport.publish} and the write itself: on a real
 * wire another writer can move a ref in exactly that window. Losing the swap
 * moves nothing anywhere — the winner's tip stands, the loser's history is
 * untouched — which is precisely the state a retry starts from, so the failure
 * is reported as the retryable `publication_race` rather than as a raw ref
 * mismatch. Every other refusal passes through unchanged.
 *
 * @param error - What the transaction threw.
 * @returns The error to propagate.
 */
export function translatePublicationRace(error: unknown): unknown {
  if (error instanceof ObjectStoreError && error.code === "ref_changed") {
    return new ObjectStoreError(
      "publication_race",
      `${error.message} Nothing was published by this attempt.`,
    );
  }
  return error;
}

/**
 * Refuses a publication or push that names a ref kind a push may not move.
 *
 * A push is defined over branches and tags. The ref name is otherwise only
 * checked for well-formedness, so without this a sender could move a
 * repository's `refs/remotes/other/main` — rewriting what it believes a third
 * party published — and the receiver would log it as an ordinary push. The
 * check belongs on the receiving side rather than in the caller for the same
 * reason the fast-forward check does: a sender-side check is one a sender can
 * skip, and `Transport` is a published interface that a privilege-crossing
 * implementation would inherit.
 *
 * @param update - The ref move being requested.
 * @throws ObjectStoreError When the ref is neither a branch nor a tag.
 */
function assertPushableRef(update: PushUpdate): void {
  if (!update.ref.startsWith(BRANCH_PREFIX) && !update.ref.startsWith(TAG_PREFIX)) {
    throw new ObjectStoreError(
      "unpushable_ref",
      `A push may only move branches and tags, and ${update.ref} is neither. `
      + `Push a ${BRANCH_PREFIX} or ${TAG_PREFIX} name instead.`,
    );
  }
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
   * Objects this connection verified on arrival that the receiver did not
   * already hold, reported by {@link FileTransport.publish} and cleared with it.
   */
  private readonly acceptedThisConnection: ObjectId[] = [];

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

  /** Read the receiver's public refs, attached branch, history-shaping record configuration, and peer description. */
  advertise(): Advertisement {
    const repository = this.open();
    const head = repository.refs.readHead();
    return {
      refs: [...repository.refs.list(BRANCH_PREFIX), ...repository.refs.list(TAG_PREFIX)],
      head: head.kind === "branch" ? head.ref : null,
      config: repository.config,
      formatVersion: REPOSITORY_FORMAT,
      capabilities: [...TRANSPORT_CAPABILITIES],
    };
  }

  /** Export requested reachable history while honoring only caller tips the receiver actually possesses. */
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

  /** Verify incoming closure and fast-forward policy before atomically publishing requested receiver refs. */
  push(bundle: Buffer, updates: readonly PushUpdate[], force: boolean, now: Date): PushReceipt {
    const repository = this.open();
    const { added } = importBundleObjects(repository.objects, bundle);
    for (const update of updates) {
      assertPushableRef(update);
      assertClosurePresent(repository.objects, update.ref, update.next);
      const current = repository.refs.read(update.ref);
      if (current === null || current === update.next) continue;
      if (!force && !isAncestor(repository.objects, current, update.next)) {
        // Name a spelling the caller can actually act on. A fetch writes a branch
        // to `refs/remotes/<remote>/<branch>`, which `resolve` accepts as the
        // `<remote>/<branch>` shorthand; a tag keeps its own name and has no
        // tracking ref, so the same sentence would send a tag pusher after a ref
        // that will never exist.
        const recovery = update.ref.startsWith(BRANCH_PREFIX)
          ? "Fetch first, then merge or rebase onto the tracking branch it writes — "
            + `<remote>/${update.ref.slice(BRANCH_PREFIX.length)}, which "pm vcs branch --remotes" lists — `
            + "or push with --force to discard them deliberately."
          : "Fetch first to see what it points at now, then move the tag deliberately, "
            + "or push with --force to discard them deliberately.";
        throw new ObjectStoreError(
          "non_fast_forward",
          `Pushing ${update.next.slice(0, 12)} to ${update.ref} would discard commits ${this.url} already has, `
          + `because its current ${current.slice(0, 12)} is not an ancestor of it. ${recovery}`,
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
    this.logPublication(repository, `Received ${updates.length} ref(s) from ${this.url}${force ? " (forced)" : ""}.`, updates, force, now);
    return { updated: updates, added };
  }

  /**
   * Logs a completed publication in the receiver's operation log.
   *
   * @param repository - The receiver, opened once by the calling publication.
   * @param summary - Human-readable line describing the transfer.
   * @param updates - The ref moves that were published.
   * @param force - Whether the moves overrode fast-forward policy.
   * @param now - Timestamp recorded in the log.
   */
  private logPublication(
    repository: Repository,
    summary: string,
    updates: readonly PushUpdate[],
    force: boolean,
    now: Date,
  ): void {
    repository.operations.append(
      "push",
      summary,
      updates.map((update) => ({ ref: update.ref, before: update.expected, after: update.next })),
      now,
    );
  }

  /** Report the offered ids the store does not hold yet, so a resume resends only those. */
  missingObjects(ids: readonly ObjectId[]): readonly ObjectId[] {
    const repository = this.open();
    return ids.filter((id) => !repository.objects.has(id));
  }

  /** Store each arriving object after verifying its content hashes to the id the sender claimed. */
  uploadObjects(objects: readonly TransferObject[]): void {
    const repository = this.open();
    for (const object of objects) {
      // The claim is checked before anything is written. Storing first and
      // hashing later would put tampered or corrupted bytes under an id that
      // does not describe them, and every later identity check in the
      // receiver's store would then reason about a lie.
      const actual = hashObject(object.type, object.payload);
      if (actual !== object.id) {
        throw new ObjectStoreError(
          "corrupt_object",
          `Upload claimed ${object.id} but its content hashes to ${actual}. `
            + "The object was refused and not stored.",
        );
      }
      // Counted before the write, which no-ops on an existing object: the
      // receipt names what this transfer delivered, not what the store holds.
      if (!repository.objects.has(object.id)) this.acceptedThisConnection.push(object.id);
      repository.objects.write(object.type, object.payload);
    }
  }

  /** Verify the uploaded closure, then publish every ref move as one compare-and-swap transaction. */
  publish(updates: readonly PushUpdate[], force: boolean, now: Date): PushReceipt {
    const repository = this.open();
    // Claimed at entry and cleared on every attempt, refused ones included:
    // an accumulator that survives a refusal would report this attempt's
    // arrivals again on a later successful publication, naming objects under
    // a receipt they did not belong to.
    const added = [...this.acceptedThisConnection];
    this.acceptedThisConnection.length = 0;
    for (const update of updates) {
      assertPushableRef(update);
      // Closure before policy: publication is what makes incomplete history
      // reachable, so it is refused until every object a moved ref names is
      // present and hash-valid. The objects were verified on arrival, so what
      // remains is presence of the whole closure — including any object this
      // receiver already held before the upload began.
      assertClosurePresent(repository.objects, update.ref, update.next);
      const current = repository.refs.read(update.ref);
      if (current === update.next) continue;
      // The fast-forward question is only meaningful while this sender's
      // observation is still current. When it is not, the compare-and-swap
      // below is the authority: it refuses the stale publication and the
      // refusal is translated into the retryable `publication_race`, which
      // leaves the winner's tip and this sender's history exactly where they
      // were.
      if (
        current === update.expected && !force && current !== null
        && !isAncestor(repository.objects, current, update.next)
      ) {
        throw new ObjectStoreError(
          "non_fast_forward",
          `Publishing ${update.next.slice(0, 12)} to ${update.ref} would discard commits ${this.url} already has, `
            + `because its current ${current.slice(0, 12)} is not an ancestor of it. Fetch first, or publish with force.`,
        );
      }
    }
    try {
      repository.refs.transaction(updates.map((update) => ({
        name: update.ref,
        expected: update.expected,
        next: update.next,
      })));
    } catch (caught) {
      throw translatePublicationRace(caught);
    }
    this.logPublication(repository, `Received ${updates.length} ref(s) from ${this.url}${force ? " (forced)" : ""}.`, updates, force, now);
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
