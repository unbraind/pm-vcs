import { compareByteOrder, effectiveChangeId, type FileId, isFileId, readCommit } from "./model.ts";
import type { ObjectId, ObjectStore } from "./objects.ts";
import { flattenTree } from "./worktree.ts";

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
  commits: readonly ObjectId[],
  selector: string,
): FileId | null {
  if (isFileId(selector)) return selector;
  for (const commitId of commits) {
    const entry = flattenTree(store, readCommit(store, commitId).tree).get(selector);
    if (entry?.fileId !== undefined) return entry.fileId;
  }
  return null;
}

/** Derive a file's complete change trace from immutable trees and commits. */
export function traceFile(
  store: ObjectStore,
  commits: readonly ObjectId[],
  fileId: FileId,
): FileChangeTrace[] {
  const traces: FileChangeTrace[] = [];
  for (const commitId of commits) {
    const commit = readCommit(store, commitId);
    const current = [...flattenTree(store, commit.tree)].filter(([, entry]) => entry.fileId === fileId);
    const parentTree = commit.parents[0] === undefined ? null : readCommit(store, commit.parents[0]).tree;
    const before = [...flattenTree(store, parentTree)].filter(([, entry]) => entry.fileId === fileId);
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
