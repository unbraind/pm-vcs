/** Align unique recorded identities before the shared merge/replay content algorithm. */
import { type FileId, compareByteOrder } from "./model.ts";
import { type flattenTree } from "./worktree.ts";

type FlatTree = ReturnType<typeof flattenTree>;

/** Index unique identities only; malformed duplicate claims stay on the conflict path. */
function identityPaths(tree: FlatTree): Map<FileId, string | null> {
  const result = new Map<FileId, string | null>();
  for (const [path, entry] of tree) {
    if (entry.fileId !== undefined) result.set(entry.fileId, result.has(entry.fileId) ? null : path);
  }
  return result;
}

/**
 * Re-key all three inputs to a single agreed move destination without changing payloads.
 * Conflicting destinations and occupied paths remain explicit identity conflicts; no
 * similarity heuristic is allowed to override a stored FileId during merge or replay.
 */
export function alignFileMoves(base: FlatTree, ours: FlatTree, theirs: FlatTree): string[] {
  const trees = [base, ours, theirs];
  const [bases, left, right] = trees.map(identityPaths);
  const conflicts: string[] = [];
  for (const [fileId, from] of bases) {
    const a = left.get(fileId); const b = right.get(fileId);
    if (from === null || a === undefined || a === null || b === undefined || b === null || (from === a && from === b)) continue;
    if (a !== b && a !== from && b !== from) { conflicts.push(a, b); continue; }
    const destination = a === from ? b : a;
    if (trees.some(tree => {
      const occupant = tree.get(destination);
      return occupant !== undefined && occupant.fileId !== fileId;
    })) { conflicts.push(destination); continue; }
    for (const [index, source] of [from, a, b].entries()) {
      const tree = trees[index]; const entry = tree.get(source)!;
      tree.delete(source); tree.set(destination, entry);
    }
  }
  return [...new Set(conflicts)].sort(compareByteOrder);
}
