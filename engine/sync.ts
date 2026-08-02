// Fetch, push and clone.
//
// Everything here is stated in terms of reachability and ref identity, never in
// terms of where the other repository is. That is not tidiness for its own sake:
// the properties these operations have to hold — that a fetch cannot move a local
// branch, that a push cannot discard a commit the remote has, that a clone means
// the same thing as its source — are properties of the algorithm, and writing them
// against a transport keeps them true for whatever transport arrives later.

import { mkdirSync } from "node:fs";

import { assertClosurePresent, exportBundle, importBundleObjects } from "./bundle.ts";
import type { ObjectId } from "./objects.ts";
import { ObjectStoreError } from "./objects.ts";
import type { RefTransition } from "./oplog.ts";
import { BRANCH_PREFIX, TAG_PREFIX } from "./refs.ts";
import { REMOTE_PREFIX, trackingRef } from "./remotes.ts";
import { DEFAULT_BRANCH, Repository } from "./repo.ts";
import { type PushUpdate, type Transport, openTransport } from "./transport.ts";

/** What a fetch did. */
export interface FetchReport {
  /** The remote that was contacted. */
  readonly remote: string;
  /** Where it lives. */
  readonly url: string;
  /** Tracking refs and tags that moved. */
  readonly updated: readonly RefTransition[];
  /**
   * Tags the remote publishes at a value the local repository already uses that
   * name for. Reported rather than moved: a tag is meant to name one immutable
   * point, and re-pointing one silently would change what every existing reference
   * to it resolves to.
   */
  readonly conflictingTags: readonly string[];
  /** Objects transferred and stored. */
  readonly added: readonly ObjectId[];
  /** True when the remote had nothing the local repository lacked. */
  readonly upToDate: boolean;
}

/** What a push did. */
export interface PushReport {
  /** The remote that was written to. */
  readonly remote: string;
  /** Where it lives. */
  readonly url: string;
  /** Refs that moved on the remote. */
  readonly updated: readonly RefTransition[];
  /** Objects the remote did not hold and therefore stored. */
  readonly added: readonly ObjectId[];
  /** True when every named branch was already at the pushed commit. */
  readonly upToDate: boolean;
}

/** What a clone produced. */
export interface CloneReport {
  /** Absolute path to the new working tree. */
  readonly root: string;
  /** Where it was cloned from. */
  readonly url: string;
  /** The branch checked out, or null when the source had no branch to check out. */
  readonly branch: string | null;
  /** What the clone's initial fetch transferred. */
  readonly fetched: FetchReport;
}

/**
 * Every commit the local repository can offer a remote as already held.
 *
 * Branches, tags and the tracking refs of every remote, because history arrives
 * from all three and any of them can be the boundary that makes a transfer small.
 * A repository that has fetched a large branch from one remote and is now fetching
 * an overlapping branch from another should send the first remote's tip as a
 * candidate; without tracking refs in this set it would re-download history it
 * already has under a name it simply did not think to mention.
 *
 * @param repository - The repository doing the fetching.
 * @returns Candidate commit ids, deduplicated.
 */
function localTips(repository: Repository): ObjectId[] {
  const tips = new Set<ObjectId>();
  for (const prefix of [BRANCH_PREFIX, TAG_PREFIX, REMOTE_PREFIX]) {
    for (const entry of repository.refs.list(prefix)) tips.add(entry.target);
  }
  return [...tips];
}

/**
 * Where a remote's ref should land locally.
 *
 * Branches land under `refs/remotes/`, never in the local branch namespace. Tags
 * keep their own name because a tag identifies a point in history rather than one
 * repository's opinion about a line of work.
 *
 * @param remote - The remote's name.
 * @param name - Full ref name as the remote publishes it.
 * @returns The local ref name, or null for a ref kind that is not fetched.
 */
function localNameFor(remote: string, name: string): string | null {
  if (name.startsWith(BRANCH_PREFIX)) return trackingRef(remote, name.slice(BRANCH_PREFIX.length));
  if (name.startsWith(TAG_PREFIX)) return name;
  return null;
}

/**
 * Fetches from a named remote onto tracking refs.
 *
 * No local branch is touched. That is the entire reason fetch does not simply
 * import the bundle the remote sends: a bundle names refs as the sender knows
 * them, and importing one would move the receiver's `main` onto the sender's
 * `main` — discarding the receiving agent's commits with nothing in the output
 * saying it happened.
 *
 * @param repository - Repository to fetch into.
 * @param remoteName - Which configured remote to contact.
 * @param now - Timestamp for the operation log entry.
 * @param transport - Transport to use. Defaults to one opened from the remote's URL.
 * @returns What moved and what was transferred.
 * @throws ObjectStoreError When the remote is not configured or cannot be reached.
 */
export function fetchFrom(
  repository: Repository,
  remoteName: string,
  now: Date,
  transport?: Transport,
): FetchReport {
  const remote = repository.remotes.require(remoteName);
  const wire = transport ?? openTransport(remote.url, repository.root);
  const advertisement = wire.advertise();

  const wanted: { remoteRef: string; localRef: string; target: ObjectId; before: ObjectId | null }[] = [];
  const conflictingTags: string[] = [];
  for (const entry of advertisement.refs) {
    const localRef = localNameFor(remoteName, entry.name);
    if (localRef === null) continue;
    const before = repository.refs.read(localRef);
    if (before === entry.target) continue;
    if (before !== null && entry.name.startsWith(TAG_PREFIX)) {
      conflictingTags.push(entry.name.slice(TAG_PREFIX.length));
      continue;
    }
    wanted.push({ remoteRef: entry.name, localRef, target: entry.target, before });
  }

  if (wanted.length === 0) {
    return { remote: remoteName, url: remote.url, updated: [], conflictingTags, added: [], upToDate: true };
  }

  const bundle = wire.fetch(wanted.map((item) => item.remoteRef), localTips(repository));
  const { added } = importBundleObjects(repository.objects, bundle);
  for (const item of wanted) assertClosurePresent(repository.objects, item.localRef, item.target);

  repository.refs.transaction(wanted.map((item) => ({
    name: item.localRef,
    expected: item.before,
    next: item.target,
  })));
  const updated: RefTransition[] = wanted.map((item) => ({
    ref: item.localRef,
    before: item.before,
    after: item.target,
  }));
  repository.operations.append(
    "fetch",
    `Fetched ${updated.length} ref(s) from ${remoteName}.`,
    updated,
    now,
  );
  return { remote: remoteName, url: remote.url, updated, conflictingTags, added, upToDate: false };
}

/**
 * Pushes local branches to a named remote.
 *
 * The remote decides whether each move is allowed; this side's job is to send
 * enough history for the decision to be answerable and to report the value it
 * observed so a concurrent pusher cannot be overwritten. Tracking refs are
 * advanced only after the remote has accepted, so a refused push leaves no local
 * trace suggesting it landed.
 *
 * @param repository - Repository to push from.
 * @param remoteName - Which configured remote to write to.
 * @param branches - Branch names to push. Empty pushes the branch HEAD is on.
 * @param force - Whether to allow discarding commits the remote has.
 * @param now - Timestamp for the operation log entries.
 * @param transport - Transport to use. Defaults to one opened from the remote's URL.
 * @returns What moved on the remote and what was transferred.
 * @throws ObjectStoreError When a named branch does not exist, HEAD is detached and
 *   no branch was named, or the remote refuses a move.
 */
export function pushTo(
  repository: Repository,
  remoteName: string,
  branches: readonly string[],
  force: boolean,
  now: Date,
  transport?: Transport,
): PushReport {
  const remote = repository.remotes.require(remoteName);
  const wire = transport ?? openTransport(remote.url, repository.root);

  let names = [...branches];
  if (names.length === 0) {
    const head = repository.refs.readHead();
    if (head.kind !== "branch") {
      throw new ObjectStoreError(
        "detached_head",
        "HEAD is not on a branch, so there is no branch to push. Name the branches to push, or switch to one.",
      );
    }
    names = [head.ref.slice(BRANCH_PREFIX.length)];
  }

  const advertisement = wire.advertise();
  const remoteRefs = new Map(advertisement.refs.map((entry) => [entry.name, entry.target]));
  const updates: PushUpdate[] = [];
  for (const name of names) {
    const localRef = `${BRANCH_PREFIX}${name}`;
    const target = repository.refs.read(localRef);
    if (target === null) throw new ObjectStoreError("unknown_branch", `No branch named ${name} to push.`);
    const expected = remoteRefs.get(localRef) ?? null;
    if (expected === target) continue;
    updates.push({ ref: localRef, expected, next: target });
  }

  if (updates.length === 0) {
    return { remote: remoteName, url: remote.url, updated: [], added: [], upToDate: true };
  }

  // Everything the remote already advertises and this repository can walk is an
  // exclusion boundary. A tip the remote has and this side does not is skipped
  // rather than sent as a boundary: `exportBundle` walks from each boundary, so
  // naming an absent commit fails the export outright.
  const since = [...remoteRefs.values()].filter((id) => repository.objects.has(id));
  const bundle = exportBundle(repository.objects, repository.refs, updates.map((update) => update.ref), since);
  const receipt = wire.push(bundle, updates, force, now);

  // The remote accepted, so its branches are now where this side just put them and
  // the tracking refs can say so without another round trip.
  const tracking = updates.map((update) => ({
    name: trackingRef(remoteName, update.ref.slice(BRANCH_PREFIX.length)),
    expected: repository.refs.read(trackingRef(remoteName, update.ref.slice(BRANCH_PREFIX.length))),
    next: update.next,
  }));
  repository.refs.transaction(tracking);
  const updated: RefTransition[] = updates.map((update) => ({
    ref: update.ref,
    before: update.expected,
    after: update.next,
  }));
  repository.operations.append(
    "push",
    `Pushed ${updated.length} branch(es) to ${remoteName}${force ? " (forced)" : ""}.`,
    tracking.map((entry) => ({ ref: entry.name, before: entry.expected, after: entry.next })),
    now,
  );
  return { remote: remoteName, url: remote.url, updated, added: receipt.added, upToDate: false };
}

/**
 * Creates a repository from a remote one.
 *
 * The source's record configuration is adopted before any object is written. A
 * clone that started from the defaults would store the same paths as blobs rather
 * than records and merge them by line, so the two repositories would share commit
 * ids while disagreeing about what those commits contain — a divergence no later
 * command could detect, because both would be internally consistent.
 *
 * @param url - Where to clone from.
 * @param root - Absolute path for the new working tree.
 * @param now - Timestamp for the operation log entries.
 * @param remoteName - Name to register the source under.
 * @param transport - Transport to use. Defaults to one opened from `url`.
 * @returns The new repository's location, the branch checked out, and the fetch.
 * @throws ObjectStoreError When `root` already holds a repository, or the source
 *   cannot be reached.
 */
export function cloneFrom(
  url: string,
  root: string,
  now: Date,
  remoteName = "origin",
  transport?: Transport,
): CloneReport {
  const wire = transport ?? openTransport(url, process.cwd());
  const advertisement = wire.advertise();
  const branch = advertisement.head === null || !advertisement.head.startsWith(BRANCH_PREFIX)
    ? null
    : advertisement.head.slice(BRANCH_PREFIX.length);
  mkdirSync(root, { recursive: true });
  const repository = Repository.init(root, branch ?? DEFAULT_BRANCH, advertisement.config);
  repository.remotes.add(remoteName, url);
  const fetched = fetchFrom(repository, remoteName, now, wire);

  if (branch === null) return { root, url, branch: null, fetched };
  const tracked = repository.refs.read(trackingRef(remoteName, branch));
  // A source whose HEAD names a branch that has no commits yet is a legitimate
  // state — `init` then nothing. The clone reproduces it as an unborn branch
  // rather than failing, so cloning an empty repository is how you start working
  // in one rather than an error to work around.
  if (tracked === null) return { root, url, branch: null, fetched };
  repository.createBranch(branch, tracked, now);
  // HEAD already names this branch, so the switch is a materialization rather than
  // a move. It goes through `switchTo` anyway to keep one code path responsible for
  // writing a tree into a working directory.
  repository.switchTo(branch, now);
  return { root, url, branch, fetched };
}
