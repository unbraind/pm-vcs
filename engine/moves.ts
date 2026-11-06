/** Explicit staging identity and deterministic refusal of ambiguous move inference. */
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { type FileId, compareByteOrder, isFileId, migratedFileId } from "./model.ts";
import { ObjectStoreError } from "./objects.ts";
import { type IndexEntry, normalizeRepoPath } from "./worktree.ts";

/** Bind an already moved working path to its recorded logical identity. */
export interface MoveIntent { readonly fileId: FileId; readonly path: string }
/** One possible source/destination identity pairing, never an automatic choice. */
export interface MoveCandidate extends MoveIntent { readonly source: string }

/** A caller must choose an identity when available move evidence ties. */
export class AmbiguousMoveError extends ObjectStoreError {
  readonly candidates: readonly MoveCandidate[];
  readonly remedy = "Stage each destination with `pm vcs add DEST --file-id FILE_ID` to choose its source identity.";
  /** Retain machine-readable candidates as well as the CLI error's actionable message. */
  constructor(candidates: readonly MoveCandidate[]) {
    const ordered = [...candidates].sort((a, b) => compareByteOrder(a.path, b.path) || compareByteOrder(a.source, b.source));
    super("ambiguous_move", `Ambiguous move candidates: ${JSON.stringify(ordered)}. Stage each destination with \`pm vcs add DEST --file-id FILE_ID\` to choose its source identity.`);
    this.candidates = ordered;
  }
}

/** Resolve every declaration before staging writes, preserving retry and erasure boundaries. */
export function resolveMoveIntents(root: string, entries: readonly IndexEntry[], targets: readonly string[], intents: readonly MoveIntent[], allowed: (entry: IndexEntry, path: string) => boolean): Map<string, IndexEntry> {
  const resolved = new Map<string, IndexEntry>();
  const identities = new Set<FileId>();
  for (const intent of intents) {
    const path = normalizeRepoPath(root, intent.path);
    const sources = entries.filter(entry => (entry.fileId ?? migratedFileId(entry)) === intent.fileId);
    const source = sources[0];
    const destination = entries.find(entry => entry.path === path);
    if (!isFileId(intent.fileId) || sources.length !== 1 || identities.has(intent.fileId) || resolved.has(path)
      || !targets.includes(path) || !allowed(source, path) || source.sparse === true
      || (destination !== undefined && destination !== source)
      || (source.path !== path && lstatSync(join(root, source.path), { throwIfNoEntry: false }) !== undefined)) {
      throw new ObjectStoreError("invalid_move_intent", "A move requires one live indexed FileId, an absent source and an allowed unoccupied destination; retry the already staged destination with the same FileId.");
    }
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stat === undefined || (!stat.isFile() && !stat.isSymbolicLink())) throw new ObjectStoreError("invalid_move_intent", "The declared move destination must be an existing working file.");
    identities.add(intent.fileId); resolved.set(path, source);
  }
  return resolved;
}

/** Select inference only when it does not compete with a declaration or another move. */
export function inferMoveSource(root: string, path: string, matches: readonly IndexEntry[], inferred: Map<FileId, MoveCandidate>): IndexEntry | undefined {
  const absent = matches.filter(entry => !existsSync(join(root, entry.path)));
  if (matches.length > 1 && absent.length > 0) throw new AmbiguousMoveError(matches.map(entry => ({ path, source: entry.path, fileId: entry.fileId ?? migratedFileId(entry) })));
  if (matches.length !== 1) return undefined;
  const source = matches[0];
  if (absent.length > 0) {
    const fileId = source.fileId ?? migratedFileId(source);
    const candidate = { path, source: source.path, fileId };
    const previous = inferred.get(fileId);
    if (previous !== undefined) throw new AmbiguousMoveError([previous, candidate]);
    inferred.set(fileId, candidate);
  }
  return source;
}
