import { compareByteOrder, effectiveChangeId, type FileId, isFileId, readCommit } from "./model.ts";
import type { ObjectId, ObjectStore } from "./objects.ts";
import { flattenTree } from "./worktree.ts";

type FlattenedTree = ReturnType<typeof flattenTree>;

/** Read each immutable tree at most once during one attribution query. */
function flattened(
  store: ObjectStore,
  tree: ObjectId | null,
  cache: Map<ObjectId | null, FlattenedTree>,
): FlattenedTree {
  const cached = cache.get(tree);
  if (cached !== undefined) return cached;
  const value = flattenTree(store, tree);
  cache.set(tree, value);
  return value;
}

/** Order a commit set so every child precedes its parents, independent of wall clocks. */
export function orderCommitsNewestFirst(store: ObjectStore, commits: readonly ObjectId[]): ObjectId[] {
  const included = new Set(commits);
  const remainingChildren = new Map<ObjectId, number>(commits.map((commit) => [commit, 0]));
  for (const commitId of commits) {
    for (const parent of readCommit(store, commitId).parents) {
      if (included.has(parent)) remainingChildren.set(parent, (remainingChildren.get(parent) as number) + 1);
    }
  }
  const ready = commits.filter((commit) => remainingChildren.get(commit) === 0).sort(compareByteOrder);
  const ordered: ObjectId[] = [];
  while (ready.length > 0) {
    const commitId = ready.shift() as ObjectId;
    ordered.push(commitId);
    for (const parent of readCommit(store, commitId).parents) {
      if (!included.has(parent)) continue;
      const count = (remainingChildren.get(parent) as number) - 1;
      remainingChildren.set(parent, count);
      if (count === 0) {
        ready.push(parent);
        ready.sort(compareByteOrder);
      }
    }
  }
  return ordered;
}

/** One immutable change to a logical file. */
export interface FileChangeTrace {
  readonly commit: ObjectId;
  readonly changeId: ObjectId;
  readonly fileId: FileId;
  readonly paths: readonly string[];
  readonly kind: "added" | "modified" | "moved" | "deleted";
  readonly copiedFrom?: FileId;
  readonly items: readonly string[];
}

/** Resolve a path or identity against a history, newest commits first. */
export function resolveFileId(
  store: ObjectStore,
  commitsNewestFirst: readonly ObjectId[],
  selector: string,
  treeCache: Map<ObjectId | null, FlattenedTree> = new Map(),
): FileId | null {
  if (isFileId(selector)) return selector;
  for (const commitId of commitsNewestFirst) {
    const entry = flattened(store, readCommit(store, commitId).tree, treeCache).get(selector);
    if (entry?.fileId !== undefined) return entry.fileId;
  }
  return null;
}

/** Derive a file's complete change trace from immutable trees and commits. */
export function traceFile(
  store: ObjectStore,
  commitsNewestFirst: readonly ObjectId[],
  fileId: FileId,
  treeCache: Map<ObjectId | null, FlattenedTree> = new Map(),
): FileChangeTrace[] {
  const traces: FileChangeTrace[] = [];
  for (const commitId of commitsNewestFirst) {
    const commit = readCommit(store, commitId);
    const current = [...flattened(store, commit.tree, treeCache)].filter(([, entry]) => entry.fileId === fileId);
    const parentTree = commit.parents[0] === undefined ? null : readCommit(store, commit.parents[0]).tree;
    const before = [...flattened(store, parentTree, treeCache)].filter(([, entry]) => entry.fileId === fileId);
    const currentPaths = current.map(([path]) => path).sort(compareByteOrder);
    const beforePaths = before.map(([path]) => path).sort(compareByteOrder);
    const currentEntry = current[0]?.[1];
    const beforeEntry = before[0]?.[1];
    const samePaths = currentPaths.length === beforePaths.length
      && currentPaths.every((path, index) => path === beforePaths[index]);
    const unchanged = samePaths && currentEntry?.id === beforeEntry?.id && currentEntry?.mode === beforeEntry?.mode;
    if (unchanged || (currentEntry === undefined && beforeEntry === undefined)) continue;
    const kind = currentEntry === undefined ? "deleted"
      : beforeEntry === undefined ? "added"
      : samePaths ? "modified" : "moved";
    traces.push({
      commit: commitId,
      changeId: effectiveChangeId(commitId, commit),
      fileId,
      paths: currentEntry === undefined ? beforePaths : currentPaths,
      kind,
      ...(currentEntry?.copiedFrom === undefined ? {} : { copiedFrom: currentEntry.copiedFrom }),
      items: commit.items ?? [],
    });
  }
  return traces;
}
