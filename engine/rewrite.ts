// History rewriting, and the three-way tree merge rewriting shares with `merge`.
//
// Two responsibilities live here because they are one mechanism seen twice. A
// real merge and a rebase replay both ask: given a base tree and two sides, what
// is the combined tree, and where (if anywhere) did the two sides disagree? The
// tree merge below answers that, and the rewriting planners above it call it on
// every replayed commit.
//
// The defining property of every planner is that it touches no ref and no working
// tree. It builds every replacement object first — commits, trees and the blobs
// a merge synthesises — and returns a plan of ref moves. The caller (the
// `Repository` method) applies that plan in one operation-log entry, so a rewrite
// that discovers a conflict halfway through has changed no ref and no file. The
// objects it wrote along the way are unreferenced and therefore harmless: a
// content-addressed store never removes anything, so half-built history costs
// only disk and never correctness.
//
// Descendant rewriting is mandatory and is the hard part. Rewriting a commit that
// has descendants replays every descendant reachable from any branch or tag, and
// moves every branch and tag that pointed into the rewritten range to its
// rewritten counterpart. A rewrite that orphaned a branch would be a data-loss
// bug, which is why the descendant replay below is the same code path every
// operation routes through.

import { createHash } from "node:crypto";

import {
  type Commit,
  type FileId,
  type FileMode,
  type Signature,
  compareByteOrder,
  decodeRecord,
  effectiveChangeId,
  encodeRecord,
  identityWithoutChangeLine,
  readCommit,
  writeCommit,
} from "./model.ts";
import { type ObjectId, type ObjectStore, ObjectStoreError } from "./objects.ts";
import {
  type ConflictLabels,
  type ContentMergeResult,
  mergeContent,
  reachable,
} from "./merge.ts";
import { mergeRecords } from "./records.ts";
import { type RepositoryConfig, isRecordPath } from "./config.ts";
import { buildTree, flattenTree } from "./worktree.ts";
import { matchesGlob } from "./config.ts";

/** One path that could not be merged automatically. */
export interface MergeConflict {
  readonly path: string;
  /** Kind of disagreement requiring explicit user review. */
  readonly reason: "content" | "record" | "mode" | "identity";
  /** For a record conflict, the fields that disagreed. */
  readonly fields?: readonly string[];
}

/** Store access plus the per-repository record policy every merge needs. */
export interface RewriteContext {
  /** Object store holding and receiving every object the rewrite builds. */
  readonly store: ObjectStore;
  /** Which paths hold records and how their fields merge. */
  readonly config: RepositoryConfig;
  /** Signature applied to every rewritten or newly created commit's committer. */
  readonly committer: Signature;
}

/** One ref's value before and after a rewrite, for the operation-log entry. */
export interface RefMove {
  readonly ref: string;
  /** The ref's value before, or null when it did not exist. */
  readonly before: ObjectId | null;
  /** The ref's value after. */
  readonly after: ObjectId;
}

/** A ref paired with the commit it points at, the shape planning reads. */
export interface RefSnapshot {
  /** Full ref name, e.g. `refs/heads/main`. */
  readonly name: string;
  /** The commit the ref points at. */
  readonly target: ObjectId;
}

/** HEAD as planning sees it, to decide whether HEAD itself must move. */
export interface HeadSnapshot {
  /** `"branch"` when HEAD names a ref, `"detached"` when it names a commit. */
  readonly kind: "branch" | "detached";
  /** The ref HEAD names, when it names one. */
  readonly ref: string | null;
  /** The commit HEAD resolves to, or null on an unborn branch. */
  readonly target: ObjectId | null;
}

/** A fully-planned rewrite: objects written, refs ready to move in one entry. */
export interface RewritePlan {
  /** Operation-log command name, e.g. `describe` or `rebase`. */
  readonly command: string;
  /** Human-readable summary for the operation-log entry. */
  readonly summary: string;
  /** Every ref that moves, with before/after for reversal. */
  readonly moves: readonly RefMove[];
}

/**
 * Raised when a replayed commit's three-way merge disagrees, carrying the paths
 * (and, for records, the fields) so the caller can report exactly what could not
 * be reconciled. Thrown before any ref moves, so the repository is untouched.
 */
export class RewriteConflictError extends Error {
  /** Every path that conflicted, in the shape `merge` already uses. */
  readonly conflicts: readonly MergeConflict[];

  /**
   * @param conflicts - The conflicts that aborted the rewrite.
   */
  constructor(conflicts: readonly MergeConflict[]) {
    super(`The rewrite left ${conflicts.length} conflict(s).`);
    this.name = "RewriteConflictError";
    this.conflicts = conflicts;
  }
}

/**
 * Merges one path's three blobs.
 *
 * Record objects take the per-field path; everything else takes diff3. The
 * distinction is made on the stored object's type rather than on the path's
 * extension, so what a file is called never decides how it merges.
 *
 * @param ctx - Store and record policy.
 * @param path - The path being merged, for conflict reporting.
 * @param baseId - Base blob, or null when the path was added on both sides.
 * @param ourId - Our blob.
 * @param theirId - Their blob.
 * @param labels - Names written into conflict markers.
 * @returns The merged blob's id and any conflict.
 */
export function mergePath(
  ctx: RewriteContext,
  path: string,
  baseId: ObjectId | null,
  ourId: ObjectId,
  theirId: ObjectId,
  labels?: ConflictLabels,
): { id: ObjectId; conflict?: MergeConflict } {
  const ourObject = ctx.store.read(ourId);
  const theirObject = ctx.store.read(theirId);
  if (ourObject.type === "record" && theirObject.type === "record") {
    const baseDocument = baseId === null ? {} : decodeRecord(ctx.store.readTyped(baseId, "record"));
    const result = mergeRecords(
      baseDocument,
      decodeRecord(ourObject.payload),
      decodeRecord(theirObject.payload),
      ctx.config.recordPolicy,
    );
    return {
      id: ctx.store.write("record", encodeRecord(result.document)),
      conflict: result.clean
        ? undefined
        : { path, reason: "record", fields: result.conflicts.map((conflict) => conflict.field) },
    };
  }
  const result: ContentMergeResult = mergeContent(
    baseId === null ? "" : ctx.store.readTyped(baseId, "blob").toString("utf8"),
    ourObject.payload.toString("utf8"),
    theirObject.payload.toString("utf8"),
    labels,
  );
  return {
    id: ctx.store.write("blob", Buffer.from(result.text, "utf8")),
    conflict: result.clean ? undefined : { path, reason: "content" },
  };
}

/**
 * Three-way merges two trees against a base tree and stores the result.
 *
 * A path only one side changed takes that side without any content being read.
 * A path both sides changed is merged by content — per field when both sides are
 * record objects, by diff3 otherwise. The merged tree is written and returned by
 * id, so both `merge` and a rebase replay receive one value rather than a path
 * map they then have to build themselves.
 *
 * Conflicts are returned, not thrown: `merge` writes them into the working tree
 * so a human can resolve them, while a rebase treats them as fatal. Returning the
 * same shape lets each caller decide without re-running the merge.
 *
 * @param ctx - Store and record policy.
 * @param baseTree - The base tree, or null when there is no common ancestor.
 * @param ourTree - Our side's tree.
 * @param theirTree - Their side's tree.
 * @param labels - Names written into conflict markers.
 * @returns The merged tree's id, which paths merged, and which conflicted.
 */
export function mergeTrees(
  ctx: RewriteContext,
  baseTree: ObjectId | null,
  ourTree: ObjectId,
  theirTree: ObjectId | null,
  labels?: ConflictLabels,
): { tree: ObjectId; merged: string[]; conflicts: MergeConflict[] } {
  const base = flattenTree(ctx.store, baseTree);
  const ours = flattenTree(ctx.store, ourTree);
  const theirs = flattenTree(ctx.store, theirTree);
  const files = new Map<string, { id: ObjectId; mode: FileMode; fileId?: FileId; copiedFrom?: FileId }>();
  const merged: string[] = [];
  const conflicts: MergeConflict[] = [];

  /** Preserve compatible file identity and surface deterministic conflicts when both sides disagree. */
  const reconcileIdentity = (
    path: string,
    ourEntry: { fileId?: FileId; copiedFrom?: FileId },
    theirEntry: { fileId?: FileId; copiedFrom?: FileId },
  ): { fileId?: FileId; copiedFrom?: FileId } => {
    const fileIdsDiffer = ourEntry.fileId !== undefined && theirEntry.fileId !== undefined
      && ourEntry.fileId !== theirEntry.fileId;
    const provenanceDiffers = ourEntry.copiedFrom !== undefined && theirEntry.copiedFrom !== undefined
      && ourEntry.copiedFrom !== theirEntry.copiedFrom;
    if (fileIdsDiffer || provenanceDiffers) conflicts.push({ path, reason: "identity" });
    if (fileIdsDiffer) {
      const selected = compareByteOrder(ourEntry.fileId as FileId, theirEntry.fileId as FileId) <= 0
        ? ourEntry : theirEntry;
      return {
        ...(selected.fileId === undefined ? {} : { fileId: selected.fileId }),
        ...(selected.copiedFrom === undefined ? {} : { copiedFrom: selected.copiedFrom }),
      };
    }
    const fileId = ourEntry.fileId ?? theirEntry.fileId;
    const copiedFrom = provenanceDiffers
      ? ([ourEntry.copiedFrom, theirEntry.copiedFrom] as FileId[]).sort(compareByteOrder)[0]
      : ourEntry.copiedFrom ?? theirEntry.copiedFrom;
    return {
      ...(fileId === undefined ? {} : { fileId }),
      ...(copiedFrom === undefined ? {} : { copiedFrom }),
    };
  };

  for (const path of [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort(compareByteOrder)) {
    const baseEntry = base.get(path);
    const ourEntry = ours.get(path);
    const theirEntry = theirs.get(path);
    const ourChanged = (ourEntry?.id ?? null) !== (baseEntry?.id ?? null)
      || (ourEntry?.mode ?? null) !== (baseEntry?.mode ?? null)
      || ourEntry?.fileId !== baseEntry?.fileId
      || ourEntry?.copiedFrom !== baseEntry?.copiedFrom;
    const theirChanged = (theirEntry?.id ?? null) !== (baseEntry?.id ?? null)
      || (theirEntry?.mode ?? null) !== (baseEntry?.mode ?? null)
      || theirEntry?.fileId !== baseEntry?.fileId
      || theirEntry?.copiedFrom !== baseEntry?.copiedFrom;

    if (!theirChanged) {
      if (ourEntry) files.set(path, ourEntry);
      continue;
    }
    if (!ourChanged) {
      if (theirEntry) files.set(path, theirEntry);
      continue;
    }
    if (ourEntry?.id === theirEntry?.id && ourEntry?.mode === theirEntry?.mode) {
      if (ourEntry) files.set(path, {
        ...ourEntry,
        ...reconcileIdentity(path, ourEntry, theirEntry ?? {}),
      });
      continue;
    }
    // Both sides changed it. A delete on one side against an edit on the other
    // has no content to merge, so our side is kept and the clash is reported.
    if (!ourEntry || !theirEntry) {
      conflicts.push({ path, reason: "content" });
      if (ourEntry) files.set(path, ourEntry);
      continue;
    }
    if (ourEntry.mode !== theirEntry.mode) {
      conflicts.push({ path, reason: "mode" });
      files.set(path, ourEntry);
      continue;
    }
    const resolution = mergePath(ctx, path, baseEntry?.id ?? null, ourEntry.id, theirEntry.id, labels);
    files.set(path, {
      id: resolution.id,
      mode: ourEntry.mode,
      ...reconcileIdentity(path, ourEntry, theirEntry),
    });
    if (resolution.conflict) conflicts.push(resolution.conflict);
    else merged.push(path);
  }
  const identities = new Map<string, string>();
  for (const [path, entry] of files) {
    if (entry.fileId === undefined) continue;
    const previous = identities.get(entry.fileId);
    if (previous !== undefined && previous !== path) {
      conflicts.push({ path, reason: "identity" });
      const replacement = createHash("sha256")
        .update("pm-vcs-merge-identity\0").update(entry.fileId).update("\0").update(path)
        .digest("hex").slice(0, 32) as FileId;
      files.set(path, { ...entry, fileId: replacement, copiedFrom: entry.fileId });
      identities.set(replacement, path);
      continue;
    }
    identities.set(entry.fileId, path);
  }
  return { tree: buildTree(ctx.store, files), merged, conflicts };
}

/**
 * Sorts a set of commit ids so that every parent precedes its children.
 *
 * Depth-first from each root with an explicit stack rather than a repeated
 * scan-for-emittable-nodes pass. Two reasons, and the second is the one that
 * decided it: the DFS is linear in edges instead of quadratic in commits, and it
 * has no "made no progress this round" branch to guard. A cycle cannot occur —
 * a commit's parents are named by id, and an id is the hash of content that
 * already includes those names, so producing one would mean finding a hash
 * preimage — and a guard against it would therefore be a branch no input can
 * take, which is dead code in a gate that permits no exclusions.
 *
 * Iterative rather than recursive: a rewritten range can be long, and a
 * machine-generated history is exactly where a call stack runs out.
 *
 * @param store - Object store holding the commits.
 * @param ids - The commits to order.
 * @returns The commits, oldest first.
 */
function topoSort(store: ObjectStore, ids: readonly ObjectId[]): ObjectId[] {
  const set = new Set(ids);
  const order: ObjectId[] = [];
  // `queued` is what makes a diamond safe: an ancestor reachable by two paths is
  // pushed once, so it is emitted once. Deduplicating at pop time instead would need a
  // second check whose "already emitted" arm only fires for an ordering the pushes
  // already prevent.
  const queued = new Set<ObjectId>();
  for (const root of set) {
    if (queued.has(root)) continue;
    queued.add(root);
    // Each frame is a commit plus whether its parents have been queued, so one commit
    // is visited twice: once to queue its parents, once to emit it after them.
    const stack: Array<{ id: ObjectId; expanded: boolean }> = [{ id: root, expanded: false }];
    while (stack.length > 0) {
      const frame = stack.pop() as { id: ObjectId; expanded: boolean };
      if (frame.expanded) {
        order.push(frame.id);
        continue;
      }
      stack.push({ id: frame.id, expanded: true });
      for (const parent of readCommit(store, frame.id).parents) {
        if (!set.has(parent) || queued.has(parent)) continue;
        queued.add(parent);
        stack.push({ id: parent, expanded: false });
      }
    }
  }
  return order;
}

/**
 * Every commit reachable from `start` but not from `stop`, oldest first.
 *
 * The rebase range: the commits that exist on `start`'s side of the divergence
 * and need replaying onto `stop`.
 *
 * @param store - Object store holding the commits.
 * @param start - The tip whose side of the divergence is replayed.
 * @param stop - The tip whose history is already in place.
 * @returns The commits to replay, oldest first. Empty when `start` is within `stop`.
 */
export function rangeInOrder(store: ObjectStore, start: ObjectId, stop: ObjectId): ObjectId[] {
  const excluded = reachable(store, stop);
  const included = [...reachable(store, start)].filter((id) => !excluded.has(id));
  return topoSort(store, included);
}

/**
 * The first parent's tree of a commit, or null when the commit has no parent.
 *
 * A replay's base is the original commit's first parent: the state the change
 * was made against. Root commits have no such state, so their replay merges
 * against nothing — every path is an addition.
 *
 * @param store - Object store holding the commit.
 * @param commit - The commit whose first parent's tree is wanted.
 * @returns The first parent's tree id, or null for a root commit.
 */
function firstParentTree(store: ObjectStore, commit: Commit): ObjectId | null {
  return commit.parents.length === 0 ? null : readCommit(store, commit.parents[0]).tree;
}

/** Builds a replacement commit, recording the change identity a re-point keeps. */
function repointDescendant(
  store: ObjectStore,
  committer: Signature,
  originalId: ObjectId,
  original: Commit,
  rewrittenParents: readonly ObjectId[],
): ObjectId {
  return writeCommit(store, {
    tree: original.tree,
    parents: rewrittenParents,
    author: original.author,
    committer,
    message: original.message,
    items: original.items,
    // A descendant's content did not change; only its ancestry did. Keeping its
    // effective change id (its own when it predates change ids) is what lets log
    // speak of the same change before and after an ancestor was rewritten.
    changeId: effectiveChangeId(originalId, original),
  });
}

/**
 * Resolves an original commit id to its rewritten counterpart.
 *
 * A commit that was not rewritten resolves to itself. A rewritten commit
 * resolves to its last replacement (the tip of its split, or its single
 * successor). A dropped commit — one a squash removed — resolves to its own
 * rewritten first parent, which is how the dropped commit's children reparent to
 * the survivor rather than to a commit that no longer exists.
 *
 * @param oldId - The original commit id.
 * @param map - The rewrite mapping built so far.
 * @param store - Object store, used only to read a dropped commit's parent.
 * @returns The id the original should be replaced by.
 */
function resolveRewritten(
  oldId: ObjectId,
  map: ReadonlyMap<ObjectId, readonly ObjectId[]>,
  store: ObjectStore,
): ObjectId {
  const replacements = map.get(oldId);
  if (replacements === undefined) return oldId;
  if (replacements.length > 0) return replacements[replacements.length - 1];
  // Dropped: inherit the rewritten position of the dropped commit's first parent.
  // A dropped commit always has one (squash requires it), and topological order
  // guarantees that parent was processed first, so the recursion terminates.
  return resolveRewritten(readCommit(store, oldId).parents[0], map, store);
}

/**
 * The ref moves a rewrite requires, plus a detached-HEAD move when HEAD itself
 * pointed into the rewritten range.
 *
 * A ref that pointed at a rewritten commit moves to its replacement; a ref that
 * pointed at a dropped commit moves to the dropped commit's survivor, which is
 * what `resolveRewritten` already computes. Branches and tags are moved through
 * their own ref names; a detached HEAD is moved through the literal `HEAD`, the
 * same name `advanceHead` records a detached commit against.
 *
 * @param refs - Every branch and tag, as a snapshot taken before the rewrite.
 * @param map - The full old-to-new mapping the rewrite produced.
 * @param head - HEAD as it was before the rewrite.
 * @param store - Object store, forwarded to `resolveRewritten`.
 * @returns Every ref that moves.
 */
function computeMoves(
  refs: readonly RefSnapshot[],
  map: ReadonlyMap<ObjectId, readonly ObjectId[]>,
  head: HeadSnapshot,
  store: ObjectStore,
): RefMove[] {
  const moves: RefMove[] = [];
  for (const ref of refs) {
    if (!map.has(ref.target)) continue;
    moves.push({ ref: ref.name, before: ref.target, after: resolveRewritten(ref.target, map, store) });
  }
  // A detached HEAD that pointed at a rewritten commit is moved directly. HEAD on
  // a branch follows the branch move above, so it needs no entry of its own.
  if (head.kind === "detached" && head.target !== null && map.has(head.target)) {
    moves.push({ ref: "HEAD", before: head.target, after: resolveRewritten(head.target, map, store) });
  }
  return moves;
}

/**
 * A builder for one rewritten commit, given the rewritten ids of its parents.
 *
 * The builder writes its own replacement commit(s) and returns their ids, so a
 * split can chain a second commit off the first's freshly-written id, and a
 * rebase replay can derive a fresh change id from a commit whose parents were
 * only just decided. Returning ids rather than commits is what makes both work
 * without the replay having to know either operation's shape.
 *
 * A builder that returns no ids drops the commit, as squash does.
 */
type EditBuilder = (rewrittenParents: readonly ObjectId[]) => readonly ObjectId[];

/**
 * Applies a set of commit edits and replays every descendant reachable from a
 * ref, so rewriting a commit never leaves a branch pointing at a commit whose
 * ancestry no longer leads to it.
 *
 * `edits` maps an original commit to a builder. Every commit reachable from a ref
 * that passes through an edited commit is replayed unchanged except for rewritten
 * parents and a fresh committer — its tree, message, author and change id are
 * preserved, because only its ancestry moved, not its content. The replacement
 * commits are written here; no ref is touched.
 *
 * @param ctx - Store, record policy, and the committer for re-pointed descendants.
 * @param edits - The directly-rewritten commits and their builders.
 * @param refs - Every branch and tag, the tips descendant replay walks back from.
 * @returns The full old-to-new mapping, edits and descendants alike.
 */
function replayWithDescendants(
  ctx: RewriteContext,
  edits: ReadonlyMap<ObjectId, EditBuilder>,
  refs: readonly RefSnapshot[],
): ReadonlyMap<ObjectId, readonly ObjectId[]> {
  const store = ctx.store;
  const tips = refs.map((ref) => ref.target);

  // The relevant subgraph: everything reachable from any ref. Descendants of an
  // edited commit live here, and so do the edited commits themselves.
  const reachableFromTips = new Set<ObjectId>();
  const walk: ObjectId[] = [...tips];
  while (walk.length > 0) {
    const id = walk.pop() as ObjectId;
    if (reachableFromTips.has(id)) continue;
    reachableFromTips.add(id);
    walk.push(...readCommit(store, id).parents);
  }

  // Children within the subgraph, so a forward walk from an edited commit finds
  // its descendants without a second full traversal.
  const children = new Map<ObjectId, ObjectId[]>();
  for (const id of reachableFromTips) {
    for (const parent of readCommit(store, id).parents) {
      if (reachableFromTips.has(parent)) {
        const list = children.get(parent) ?? [];
        list.push(id);
        children.set(parent, list);
      }
    }
  }

  // Everything that must be rewritten: the edited commits plus their descendants.
  const toRewrite = new Set<ObjectId>(edits.keys());
  const frontier = [...edits.keys()];
  while (frontier.length > 0) {
    const id = frontier.pop() as ObjectId;
    for (const child of children.get(id) ?? []) {
      if (!toRewrite.has(child)) {
        toRewrite.add(child);
        frontier.push(child);
      }
    }
  }

  const order = topoSort(store, [...toRewrite]);
  const map = new Map<ObjectId, readonly ObjectId[]>();
  for (const id of order) {
    const original = readCommit(store, id);
    const rewrittenParents = original.parents.map((parent) => resolveRewritten(parent, map, store));
    const builder = edits.get(id);
    const replacements = builder === undefined
      ? [repointDescendant(store, ctx.committer, id, original, rewrittenParents)]
      : builder(rewrittenParents);
    map.set(id, replacements);
  }
  return map;
}

/**
 * Runs a descendant-replay rewrite and packages its ref moves as a plan.
 *
 * Shared by every operation whose effect is to rewrite existing commits
 * (describe, rebase, squash, split): each builds its `edits` and delegates here.
 *
 * @param ctx - Store, record policy, and committer.
 * @param edits - The directly-rewritten commits and their builders.
 * @param refs - Every branch and tag.
 * @param head - HEAD before the rewrite.
 * @param command - Operation-log command name.
 * @param summary - Operation-log summary.
 * @returns The plan: ref moves only, no ref yet moved.
 */
function planReplay(
  ctx: RewriteContext,
  edits: ReadonlyMap<ObjectId, EditBuilder>,
  refs: readonly RefSnapshot[],
  head: HeadSnapshot,
  command: string,
  summary: string,
): RewritePlan {
  const map = replayWithDescendants(ctx, edits, refs);
  return { command, summary, moves: computeMoves(refs, map, head, ctx.store) };
}

/**
 * Plans replacing one commit's message, preserving its change id.
 *
 * @param ctx - Store, record policy, and committer.
 * @param revision - The commit to describe.
 * @param message - The new message, verbatim.
 * @param refs - Every branch and tag.
 * @param head - HEAD before the rewrite.
 * @returns The plan.
 */
export function planDescribe(
  ctx: RewriteContext,
  revision: ObjectId,
  message: string,
  refs: readonly RefSnapshot[],
  head: HeadSnapshot,
): RewritePlan {
  const store = ctx.store;
  const original = readCommit(store, revision);
  const edits = new Map<ObjectId, EditBuilder>([
    [revision, (rewrittenParents) => {
      const replacement = writeCommit(store, {
        tree: original.tree,
        parents: rewrittenParents,
        author: original.author,
        committer: ctx.committer,
        message,
        items: original.items,
        // Describing a commit changes its message, not the change it records.
        changeId: effectiveChangeId(revision, original),
      });
      return [replacement];
    }],
  ]);
  return planReplay(ctx, edits, refs, head, "describe", `Described ${revision.slice(0, 12)}.`);
}

/**
 * Plans replaying `source`'s side of the divergence onto `onto`.
 *
 * Each replayed commit is a three-way merge with the original commit's first
 * parent as the base, the rewritten first parent as ours, and the original
 * commit's tree as theirs. The author and change id are preserved — a rebase
 * moves a change, it does not replace it — and the committer is fresh.
 *
 * @param ctx - Store, record policy, and committer.
 * @param source - The tip whose side of the divergence is replayed.
 * @param onto - The tip the range is replayed onto.
 * @param refs - Every branch and tag.
 * @param head - HEAD before the rewrite.
 * @returns The plan, empty when `source` is already within `onto`.
 */
export function planRebase(
  ctx: RewriteContext,
  source: ObjectId,
  onto: ObjectId,
  refs: readonly RefSnapshot[],
  head: HeadSnapshot,
): RewritePlan {
  const store = ctx.store;
  const range = rangeInOrder(store, source, onto);
  if (range.length === 0) {
    return { command: "rebase", summary: `Nothing to rebase: ${source.slice(0, 12)} is within ${onto.slice(0, 12)}.`, moves: [] };
  }
  const edits = new Map<ObjectId, EditBuilder>();
  const rangeSet = new Set(range);
  for (const id of range) {
    const original = readCommit(store, id);
    const baseTree = firstParentTree(store, original);
    edits.set(id, (rewrittenParents) => {
      // Parents inside the replay range keep their rewritten counterparts. A
      // parent outside it is part of the old base and is replaced by `onto`.
      // De-duplication handles a merge whose two external parents both collapse
      // to that same new base without inventing a duplicate parent edge.
      const parents = [...new Set(original.parents.length === 0
        ? [onto]
        : original.parents.map((parent, index) => (
            rangeSet.has(parent) ? rewrittenParents[index] as ObjectId : onto
          )))];
      const firstParent = parents[0] as ObjectId;
      const ourTree = readCommit(store, firstParent).tree;
      const { tree, conflicts } = mergeTrees(ctx, baseTree, ourTree, original.tree);
      if (conflicts.length > 0) throw new RewriteConflictError(conflicts);
      const replacement = writeCommit(store, {
        tree,
        parents,
        author: original.author,
        committer: ctx.committer,
        message: original.message,
        items: original.items,
        changeId: effectiveChangeId(id, original),
      });
      return [replacement];
    });
  }
  const tip = range[range.length - 1];
  return planReplay(ctx, edits, refs, head, "rebase", `Rebased ${range.length} commit(s) from ${source.slice(0, 12)} onto ${onto.slice(0, 12)}; ${tip.slice(0, 12)} moved.`);
}

/**
 * Plans folding `revision` into its first parent.
 *
 * The survivor replaces the parent: it carries the combined tree (the revision's,
 * which already includes the parent's changes), both messages joined by a blank
 * line, and the parent's change id. The revision itself is dropped, and its
 * descendants reparent to the survivor.
 *
 * @param ctx - Store, record policy, and committer.
 * @param revision - The commit to fold into its first parent.
 * @param refs - Every branch and tag.
 * @param head - HEAD before the rewrite.
 * @returns The plan.
 * @throws RewriteConflictError Never — squash moves trees whole, never merging —
 *   but the type documents that planning can fail.
 */
export function planSquash(
  ctx: RewriteContext,
  revision: ObjectId,
  refs: readonly RefSnapshot[],
  head: HeadSnapshot,
): RewritePlan {
  const store = ctx.store;
  const revisionCommit = readCommit(store, revision);
  if (revisionCommit.parents.length === 0) {
    throw new ObjectStoreError(
      "empty_squash",
      `${revision.slice(0, 12)} is a root commit, so it has no first parent to fold into. Squash a commit that has a parent instead.`,
    );
  }
  const parentId = revisionCommit.parents[0];
  const parentCommit = readCommit(store, parentId);
  const message = `${parentCommit.message.replace(/\n+$/, "")}\n\n${revisionCommit.message}`;
  const edits = new Map<ObjectId, EditBuilder>([
    [parentId, (rewrittenParents) => {
      const survivor = writeCommit(store, {
        tree: revisionCommit.tree,
        parents: rewrittenParents,
        author: parentCommit.author,
        committer: ctx.committer,
        message,
        items: [...new Set([...(parentCommit.items ?? []), ...(revisionCommit.items ?? [])])].sort(compareByteOrder),
        changeId: effectiveChangeId(parentId, parentCommit),
      });
      return [survivor];
    }],
    // The revision is dropped. Its descendants resolve to the survivor through
    // the dropped commit's rewritten parent.
    [revision, () => []],
  ]);
  return planReplay(ctx, edits, refs, head, "squash", `Squashed ${revision.slice(0, 12)} into ${parentId.slice(0, 12)}.`);
}

/**
 * Partitions a commit's changes into the paths that match `patterns` and the
 * rest, so a split can refuse when either side would be empty and name the side.
 *
 * @param store - Object store holding the trees.
 * @param revisionCommit - The commit being split.
 * @param patterns - Glob patterns selecting the first half's paths.
 * @returns The matching and remaining changed paths, and the first half's tree.
 */
function planSplitTrees(
  store: ObjectStore,
  revisionCommit: Commit,
  patterns: readonly string[],
): { matching: string[]; remaining: string[]; firstTree: ObjectId } {
  const base = flattenTree(store, firstParentTree(store, revisionCommit));
  const full = flattenTree(store, revisionCommit.tree);
  const matches = (path: string): boolean => patterns.some((pattern) => matchesGlob(path, pattern));
  const firstFiles = new Map(base);
  const matching: string[] = [];
  const remaining: string[] = [];
  for (const path of [...new Set([...base.keys(), ...full.keys()])].sort(compareByteOrder)) {
    const before = base.get(path);
    const after = full.get(path);
    // `path` comes from the union of both maps, so `before` and `after` cannot
    // both be absent. Spell that invariant into the comparison: optional mode
    // fallbacks would encode a both-absent arm that no caller can reach.
    const changed = before === undefined
      ? true
      : after === undefined || before.id !== after.id || before.mode !== after.mode;
    if (!changed) continue;
    if (matches(path)) {
      matching.push(path);
      if (after === undefined) firstFiles.delete(path);
      else firstFiles.set(path, after);
    } else {
      remaining.push(path);
    }
  }
  return { matching, remaining, firstTree: buildTree(store, firstFiles) };
}

/**
 * Plans replacing one commit with two: the first carrying only the changes to
 * `patterns`, the second the rest.
 *
 * The first keeps the original change id (it is the same change, narrowed); the
 * second gets a fresh one (it is a new change distilled out of the original).
 * Both inherit the original's author, message and a fresh committer. Refuses when
 * either side would be empty, naming the side, because an empty commit is never
 * what a split was asked for.
 *
 * @param ctx - Store, record policy, and committer.
 * @param revision - The commit to split.
 * @param patterns - Glob patterns selecting the first half's paths.
 * @param refs - Every branch and tag.
 * @param head - HEAD before the rewrite.
 * @returns The plan.
 * @throws ObjectStoreError When the split would leave a side empty. Not a conflict:
 *   nothing disagreed, the arguments simply do not describe a split. Reporting it as
 *   a conflict told the caller to "resolve the listed paths", which is advice they
 *   cannot act on for a path set that matched nothing.
 */
export function planSplit(
  ctx: RewriteContext,
  revision: ObjectId,
  patterns: readonly string[],
  refs: readonly RefSnapshot[],
  head: HeadSnapshot,
): RewritePlan {
  const store = ctx.store;
  const original = readCommit(store, revision);
  const { matching, remaining, firstTree } = planSplitTrees(store, original, patterns);
  const changed = [...matching, ...remaining];
  if (matching.length === 0) {
    throw new ObjectStoreError(
      "empty_split",
      `Splitting ${revision.slice(0, 12)} on ${patterns.join(", ") || "no patterns"} would leave the first commit empty: `
      + `that commit changes ${changed.join(", ")}. Name one of those paths instead.`,
    );
  }
  if (remaining.length === 0) {
    throw new ObjectStoreError(
      "empty_split",
      `Splitting ${revision.slice(0, 12)} on ${patterns.join(", ")} would leave the second commit empty, because those `
      + `patterns match every path the commit changes (${changed.join(", ")}). A split needs work left on both sides.`,
    );
  }
  const edits = new Map<ObjectId, EditBuilder>([
    [revision, (rewrittenParents) => {
      const firstId = writeCommit(store, {
        tree: firstTree,
        parents: rewrittenParents,
        author: original.author,
        committer: ctx.committer,
        message: original.message,
        items: original.items,
        changeId: effectiveChangeId(revision, original),
      });
      const secondBase = {
        tree: original.tree,
        parents: [firstId],
        author: original.author,
        committer: ctx.committer,
        message: original.message,
        items: original.items,
      };
      const secondId = writeCommit(store, { ...secondBase, changeId: identityWithoutChangeLine(secondBase) });
      return [firstId, secondId];
    }],
  ]);
  return planReplay(ctx, edits, refs, head, "split", `Split ${revision.slice(0, 12)} into two commits.`);
}

/**
 * Builds a cherry-pick: one commit's change applied onto HEAD as a new commit
 * with a new change id and the original's message preserved.
 *
 * A cherry-pick is a second, distinct change — the same edit made again — so it
 * gets a fresh change id rather than inheriting the original's. The author is the
 * original's (the change was theirs); the committer is the agent applying it.
 *
 * @param ctx - Store, record policy, and committer.
 * @param revision - The commit whose change is applied.
 * @param headTarget - The commit HEAD currently names.
 * @returns The new commit's id.
 * @throws RewriteConflictError When the change does not apply cleanly.
 */
export function planCherryPick(ctx: RewriteContext, revision: ObjectId, headTarget: ObjectId): ObjectId {
  const store = ctx.store;
  const original = readCommit(store, revision);
  const baseTree = firstParentTree(store, original);
  const ourTree = readCommit(store, headTarget).tree;
  const { tree, conflicts } = mergeTrees(ctx, baseTree, ourTree, original.tree);
  if (conflicts.length > 0) throw new RewriteConflictError(conflicts);
  const base = {
    tree,
    parents: [headTarget],
    author: original.author,
    committer: ctx.committer,
    message: original.message,
    items: original.items,
  };
  return writeCommit(store, { ...base, changeId: identityWithoutChangeLine(base) });
}

/**
 * Builds a revert: the inverse of one commit's change, applied onto HEAD.
 *
 * The three-way merge inverts the commit by swapping the base and one side: base
 * is the commit's tree (the after-state), theirs is its first parent's tree (the
 * before-state), so a path the commit changed is moved back while a path it left
 * alone stays as HEAD has it.
 *
 * @param ctx - Store, record policy, and committer.
 * @param revision - The commit to revert.
 * @param headTarget - The commit HEAD currently names.
 * @param message - The revert commit's message.
 * @returns The new commit's id.
 * @throws RewriteConflictError When the inverse does not apply cleanly.
 */
export function planRevert(ctx: RewriteContext, revision: ObjectId, headTarget: ObjectId, message: string): ObjectId {
  const store = ctx.store;
  const original = readCommit(store, revision);
  const baseTree = original.tree;
  const theirTree = firstParentTree(store, original);
  const ourTree = readCommit(store, headTarget).tree;
  const { tree, conflicts } = mergeTrees(ctx, baseTree, ourTree, theirTree);
  if (conflicts.length > 0) throw new RewriteConflictError(conflicts);
  const base = {
    tree,
    parents: [headTarget],
    author: ctx.committer,
    committer: ctx.committer,
    message,
    items: original.items,
  };
  return writeCommit(store, { ...base, changeId: identityWithoutChangeLine(base) });
}
