// The porcelain: init, stage, commit, branch, switch, merge, log, diff.
//
// Everything user-facing goes through this class, and it owns two invariants the
// lower layers cannot enforce on their own.
//
// First, no command mutates the working tree before it knows the operation will
// succeed. A switch that would overwrite an uncommitted edit refuses *before*
// writing anything, because a half-applied switch leaves an agent with a tree
// that matches no commit and no way to describe what it has.
//
// Second, every ref move is recorded in the operation log with its before value,
// so `undo` never has to reconstruct one.

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import {
  type Commit,
  type FileId,
  type FileMode,
  type RecordDocument,
  type Signature,
  compareByteOrder,
  decodeRecord,
  effectiveChangeId,
  encodeRecord,
  identityWithoutChangeLine,
  readCommit,
  writeCommit,
} from "./model.ts";
import { type ObjectId, ObjectStore, ObjectStoreError, hashObject, isObjectId } from "./objects.ts";
import type { StoredObject } from "./objects.ts";
import {
  type ConflictLabels,
  isAncestor,
  mergeBases,
  reachable,
} from "./merge.ts";
import {
  DEFAULT_CONFIG,
  type RepositoryConfig,
  isRecordPath,
  readConfig,
  writeConfig,
} from "./config.ts";
import { BRANCH_PREFIX, type HeadState, RefStore, TAG_PREFIX, assertRefName } from "./refs.ts";
import { OperationLog, type Operation, type RefTransition } from "./oplog.ts";
import { REMOTE_PREFIX, RemoteStore } from "./remotes.ts";
import {
  type IndexEntry,
  type StatusReport,
  buildTree,
  computeStatus,
  decodeIndex,
  encodeIndex,
  flattenTree,
  listWorkingTree,
  materializeTree,
  normalizeRepoPath,
  readWorkingFile,
  readWorkingStat,
  sameIndexStat,
} from "./worktree.ts";

/** Derive one migration-safe identity from a legacy index entry. */
function migratedFileId(entry: Pick<IndexEntry, "path" | "id">): FileId {
  return createHash("sha256")
    .update("pm-vcs legacy file identity\0", "utf8")
    .update(entry.path, "utf8")
    .update("\0", "utf8")
    .update(entry.id, "utf8")
    .digest("hex")
    .slice(0, 32);
}
import { splitLines, unifiedDiff } from "./diff.ts";
import { type IgnoreRules, isIgnored, readIgnoreRules } from "./ignore.ts";
import { parseWorkingRecord, renderWorkingRecord } from "./record-format.ts";
import {
  type HeadSnapshot,
  type MergeConflict,
  type RefSnapshot,
  type RewriteContext,
  type RewritePlan,
  RewriteConflictError,
  mergeTrees,
  planCherryPick,
  planDescribe,
  planRebase,
  planRevert,
  planSplit,
  planSquash,
} from "./rewrite.ts";

/** Name of the control directory inside a repository root. */
export const CONTROL_DIRECTORY = ".pmvcs";

/** Repository format this build writes and can read. */
export const REPOSITORY_FORMAT = "pmvcs-1";

/** Branch a fresh repository starts on. */
export const DEFAULT_BRANCH = "main";

/**
 * Matches a diff3 conflict-marker line anywhere in a file.
 *
 * `m` makes `^` match the start of every line, so a single test covers a whole
 * blob. The `=======` separator is matched alone on its line (the merge engine
 * emits it with nothing after it), while the labelled markers carry the
 * caller-supplied `ours` / `base` / `theirs` text. A line of seven `=` with
 * trailing content is not a separator, so a markdown underline that happens to
 * be exactly seven equals is the one residual false positive — the same one
 * `git diff --check` has, and the price of matching the markers the engine
 * actually writes.
 */
const CONFLICT_MARKER = /^(?:<{7} |\|{7} |={7}$|>{7} )/m;

/** Merge classification, resulting tip, bases, clean paths, and unresolved conflicts returned to callers. */
export interface MergeReport {
  /**
   * What the merge did: nothing, a fast-forward, a completed merge commit, or a
   * merge that stopped with conflict markers in the working tree. The last is
   * distinct from `merged` because no commit was recorded — HEAD did not move —
   * and the repository instead carries in-progress merge state for `--continue`
   * or `--abort` to act on.
   */
  readonly kind: "up_to_date" | "fast_forward" | "merged" | "conflicted";
  /** Commit HEAD ended up at. */
  readonly head: ObjectId;
  /** Merge bases used. More than one means a virtual base was built. */
  readonly bases: readonly ObjectId[];
  /** Paths that merged without a conflict. */
  readonly merged: readonly string[];
  /** Paths left with conflicts, and what conflicted. */
  readonly conflicts: readonly MergeConflict[];
  /** True when nothing conflicted. */
  readonly clean: boolean;
}

/**
 * Durable record of a merge that stopped with conflict markers in the tree.
 *
 * Written under the control directory so a later, separate command can see that
 * a resolution is owed: `status` reports it, `commit` refuses, and `merge
 * --continue` / `--abort` act on it. The fields are exactly what `--continue`
 * needs to build the merge commit the original merge refused to record — the
 * parent commits, the merge bases, the commit message and author, and which
 * paths conflicted — so completing the merge does not depend on the caller
 * passing any of that again.
 */
export interface MergeState {
  /** HEAD before the merge (the first parent of the would-be merge commit). */
  readonly ours: ObjectId;
  /** The commit being merged in (the second parent). */
  readonly theirs: ObjectId;
  /** The revision argument the caller passed, reused in messages and the oplog. */
  readonly revision: string;
  /** Merge bases the original merge computed, kept so `--continue` reports them. */
  readonly bases: readonly ObjectId[];
  /** Paths that merged cleanly before the conflict stopped the merge. */
  readonly merged: readonly string[];
  /** Paths left with conflicts, and what conflicted. */
  readonly conflicts: readonly MergeConflict[];
  /** Commit message for the would-be merge commit. */
  readonly message: string;
  /** Author signature for the would-be merge commit. */
  readonly author: Signature;
  /** Committer signature for the would-be merge commit. */
  readonly committer: Signature;
  /** Conflict-marker labels the original merge used, for consistent re-rendering. */
  readonly labels?: ConflictLabels;
}

/** One entry of `log` output. */
export interface LogEntry {
  readonly id: ObjectId;
  readonly commit: Commit;
  /** The change this commit records, stable across rewrites of this commit. */
  readonly changeId: ObjectId;
}

/** Message, signatures, emptiness policy, and PM attribution supplied when recording a commit. */
export interface CommitOptions {
  readonly message: string;
  readonly author: Signature;
  /** Defaults to the author, matching the common case of committing your own work. */
  readonly committer?: Signature;
  /** Allow a commit that changes nothing. Off by default so an empty commit is deliberate. */
  readonly allowEmpty?: boolean;
  /** PM items explicitly associated with the commit. */
  readonly items?: readonly string[];
}

/**
 * One repository: object store, refs, index, working tree and operation log.
 */
export class Repository {
  /** Absolute path to the working tree root. */
  readonly root: string;

  /** Absolute path to the control directory. */
  readonly controlDirectory: string;

  /** Immutable content-addressed storage shared by every repository operation. */
  readonly objects: ObjectStore;

  /** Ref storage with compare-and-swap protection for concurrent branch and tag writers. */
  readonly refs: RefStore;

  /** Append-only command receipts supporting audit and reversible ref movement. */
  readonly operations: OperationLog;

  /**
   * The other repositories this one knows how to exchange history with.
   *
   * Kept out of {@link Repository.config} deliberately: config shapes what the
   * history means and has to match in every clone, whereas the remote list is one
   * clone's local knowledge and differs between agents sharing a project.
   */
  readonly remotes: RemoteStore;

  /**
   * Which paths hold records, and how their fields merge.
   *
   * Read from the repository rather than taken per call, so every merge in one
   * repository resolves a given field the same way. A policy that varied by
   * caller would make the merge result depend on which command ran it.
   */
  readonly config: RepositoryConfig;

  /**
   * @param root - Absolute path to the working tree root.
   * @param config - Settings to use. Defaults to whatever the repository stores.
   */
  constructor(root: string, config?: RepositoryConfig) {
    this.root = root;
    this.controlDirectory = join(root, CONTROL_DIRECTORY);
    this.objects = new ObjectStore(join(this.controlDirectory, "objects"));
    this.refs = new RefStore(this.controlDirectory);
    this.operations = new OperationLog(join(this.controlDirectory, "oplog.jsonl"));
    this.remotes = new RemoteStore(join(this.controlDirectory, "remotes.json"));
    this.config = config ?? readConfig(join(this.controlDirectory, "config.json"));
  }

  /**
   * Creates a repository, or fails if one is already there.
   *
   * @param root - Absolute path to the working tree root.
   * @param branch - Name of the initial branch.
   * @param config - Settings to store for the repository.
   * @returns The initialised repository.
   * @throws ObjectStoreError When the directory already holds a repository.
   */
  static init(root: string, branch = DEFAULT_BRANCH, config: RepositoryConfig = DEFAULT_CONFIG): Repository {
    const repository = new Repository(root, config);
    const formatPath = join(repository.controlDirectory, "format");
    if (existsSync(formatPath)) {
      throw new ObjectStoreError("already_initialised", `${root} already holds a repository.`);
    }
    mkdirSync(join(repository.controlDirectory, "objects"), { recursive: true });
    mkdirSync(join(repository.controlDirectory, "refs", "heads"), { recursive: true });
    mkdirSync(join(repository.controlDirectory, "refs", "tags"), { recursive: true });
    writeFileSync(formatPath, `${REPOSITORY_FORMAT}\n`);
    writeFileSync(join(repository.controlDirectory, "index"), "");
    writeConfig(join(repository.controlDirectory, "config.json"), config);
    repository.refs.setHeadToRef(`${BRANCH_PREFIX}${branch}`);
    return repository;
  }

  /**
   * Opens an existing repository.
   *
   * @param root - Absolute path to the working tree root.
   * @returns The opened repository.
   * @throws ObjectStoreError When there is no repository, or its format is one
   *   this build does not understand.
   */
  static open(root: string): Repository {
    const repository = new Repository(root);
    let format: string;
    try {
      format = readFileSync(join(repository.controlDirectory, "format"), "utf8").trim();
    } catch {
      throw new ObjectStoreError("not_a_repository", `${root} does not hold a repository. Run init first.`);
    }
    if (format !== REPOSITORY_FORMAT) {
      throw new ObjectStoreError(
        "unsupported_format",
        `Repository format "${format}" is not ${REPOSITORY_FORMAT}, which this build writes.`,
      );
    }
    return repository;
  }

  /** Absolute path to the index file. */
  private get indexPath(): string {
    return join(this.controlDirectory, "index");
  }

  /**
   * Absolute path to the in-progress merge state file.
   *
   * A merge that stops with conflict markers writes this; `--continue` and
   * `--abort` remove it. Its presence is the single durable signal that a
   * resolution is owed, so every command that would move HEAD or rewrite the
   * working tree checks it before doing anything.
   */
  private get mergeStatePath(): string {
    return join(this.controlDirectory, "MERGE_STATE");
  }

  /**
   * Reads in-progress merge state, or null when no merge is underway.
   *
   * A malformed state file is a hard failure rather than a silent "no merge":
   * the file is only ever written by this engine, so a corrupt one means the
   * control directory was damaged mid-merge, and proceeding as if nothing were
   * owed would let a broken merge commit slip into history — the exact defect
   * the state exists to prevent.
   *
   * @returns The recorded merge state, or null.
   * @throws ObjectStoreError When the state file is present but not valid JSON.
   */
  readMergeState(): MergeState | null {
    let raw: string;
    try {
      raw = readFileSync(this.mergeStatePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return JSON.parse(raw) as MergeState;
    } catch {
      throw new ObjectStoreError(
        "corrupt_merge_state",
        `The in-progress merge state at ${this.mergeStatePath} is not valid JSON. `
        + "Remove it only if you are certain no merge is being resolved, or run `pm vcs merge --abort` after inspecting it.",
      );
    }
  }

  /**
   * Records in-progress merge state atomically.
   *
   * @param state - The merge state to persist.
   */
  private writeMergeState(state: MergeState): void {
    writeFileSync(this.mergeStatePath, JSON.stringify(state));
  }

  /** Removes the in-progress merge state, completing or abandoning the merge. */
  private clearMergeState(): void {
    rmSync(this.mergeStatePath, { force: true });
  }

  /**
   * Refuses any command that would move HEAD or rewrite the working tree while a
   * merge is waiting to be resolved or abandoned.
   *
   * The merge state is the one signal a downstream agent checks, so letting a
   * `commit`, `switch`, `reset` or `undo` run mid-merge would either commit the
   * markers (the original defect) or desync the working tree from the recorded
   * parents. `merge --continue` and `merge --abort` are the only ways past it.
   *
   * @throws ObjectStoreError When a merge is in progress.
   */
  private assertNoMergeInProgress(): void {
    const state = this.readMergeState();
    if (state === null) return;
    throw new ObjectStoreError(
      "merge_in_progress",
      `A merge of ${state.revision} is in progress with unresolved conflicts: ${
        state.conflicts.map((conflict) => conflict.path).join(", ")
      }. Resolve the conflicted paths and run \`pm vcs merge --continue\`, or run \`pm vcs merge --abort\` to abandon the merge.`,
    );
  }

  /**
   * Whether a stored blob carries diff3 conflict markers.
   *
   * Only blob content conflicts render markers; record, mode, identity and
   * delete/modify conflicts keep one side's content and report an advisory
   * conflict, so they do not put unbuildable bytes into a tree. This is the
   * precise distinction between a merge that must stop (markers would be
   * committed) and one that may complete (the conflict is advisory).
   *
   * @param id - Object id to inspect.
   * @returns True when the object is a blob whose text contains a marker line.
   */
  private blobHasConflictMarkers(id: ObjectId): boolean {
    const object = this.objects.read(id);
    if (object.type !== "blob") return false;
    return CONFLICT_MARKER.test(object.payload.toString("utf8"));
  }

  /** Reads the exact index bytes and their decoded entries as one snapshot. */
  private readIndexSnapshot(): { readonly contents: string; readonly entries: IndexEntry[] } {
    try {
      const contents = readFileSync(this.indexPath, "utf8");
      return { contents, entries: decodeIndex(contents) };
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contents: "", entries: [] };
      throw error;
    }
  }

  /**
   * Reads the index.
   *
   * @returns The staged entries.
   */
  readIndex(): IndexEntry[] {
    return this.readIndexSnapshot().entries;
  }

  /**
   * Replaces the index atomically while holding its shared writer lock.
   *
   * @param entries - Complete next index state.
   * @param expectedContents - Exact bytes the caller planned from, or null for
   *   an unconditional writer that already owns the latest staged state.
   * @returns False only when a compare-and-swap observed a newer index.
   */
  private replaceIndex(entries: readonly IndexEntry[], expectedContents: string | null): boolean {
    const lockPath = `${this.indexPath}.lock`;
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, "wx");
    } catch (error) {
      if (expectedContents !== null && (error as NodeJS.ErrnoException).code === "EEXIST") return false;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new ObjectStoreError(
        "index_locked",
        `The index is locked by another process (${lockPath}); retry after that pm-vcs command completes.`,
      );
    }
    let temporary: string | null = null;
    try {
      if (expectedContents !== null && readFileSync(this.indexPath, "utf8") !== expectedContents) return false;
      temporary = `${this.indexPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(temporary, encodeIndex(entries), { flag: "wx" });
      renameSync(temporary, this.indexPath);
      temporary = null;
      return true;
    } finally {
      if (temporary !== null) rmSync(temporary, { force: true });
      closeSync(descriptor);
      rmSync(lockPath, { force: true });
    }
  }

  /**
   * Replaces the index.
   *
   * @param entries - The staged entries to record.
   */
  writeIndex(entries: readonly IndexEntry[]): void {
    this.replaceIndex(entries, null);
  }

  /**
   * Stages working-tree paths, or every tracked and untracked path.
   *
   * A path that no longer exists is removed from the index rather than failing,
   * so `add` after a delete stages the deletion — the alternative is a separate
   * remove command whose only job is to say what `add` already knows.
   *
   * @param paths - Paths to stage, or an empty array for everything.
   * @param read - Working-file reader; injectable so the cache bypass remains
   *   directly testable without relying on elapsed-time benchmarks.
   * @returns The paths whose staged state changed.
   */
  stage(paths: readonly string[], read: typeof readWorkingFile = readWorkingFile): string[] {
    const originalEntries = this.readIndex();
    const index = new Map(originalEntries.map((entry) => [entry.path, entry]));
    const rules = this.ignoreRules();
    const targets = paths.length === 0
      ? [...new Set([...listWorkingTree(this.root, CONTROL_DIRECTORY, rules), ...index.keys()])]
      : paths.map((path) => normalizeRepoPath(this.root, path));
    const changed: string[] = [];
    for (const path of targets) {
      // An explicitly named ignored path is refused rather than silently
      // skipped: the caller asked for something specific, and staging nothing
      // while reporting success is how a commit ends up missing a file.
      if (isIgnored(path, rules)) {
        if (paths.length === 0) continue;
        throw new ObjectStoreError(
          "path_ignored",
          `"${path}" is ignored, so it cannot be staged. `
          + "Remove the rule from .pmvcsignore, or stage a path the rules allow.",
        );
      }
      let content: Buffer;
      let executable: boolean;
      let stat: IndexEntry["stat"];
      try {
        const observed = readWorkingStat(this.root, path);
        const existing = index.get(path);
        const observedMode = observed.executable ? "100755" : "100644";
        if (existing?.fileId !== undefined && existing.mode === observedMode && sameIndexStat(existing.stat, observed.stat)) continue;
        ({ content, executable, stat } = read(this.root, path));
      } catch {
        if (index.delete(path)) changed.push(path);
        continue;
      }
      const id = this.stageContent(path, content);
      const mode = executable ? "100755" : "100644";
      const existing = index.get(path);
      let fileId = existing === undefined ? undefined : existing.fileId ?? migratedFileId(existing);
      let copiedFrom = existing?.copiedFrom;
      if (fileId === undefined) {
        const identityMatches = stat === undefined ? [] : originalEntries.filter((entry) => entry.path !== path
          && entry.stat?.dev === stat.dev && entry.stat.ino === stat.ino);
        const contentMatches = originalEntries.filter((entry) => entry.path !== path && entry.id === id
          && entry.mode === mode);
        const matches = identityMatches.length === 1 ? identityMatches : contentMatches;
        if (matches.length === 1) {
          const source = matches[0];
          const sourceFileId = source.fileId ?? migratedFileId(source);
          if (!existsSync(join(this.root, ...source.path.split("/")))) {
            fileId = sourceFileId;
            copiedFrom = source.copiedFrom;
            if (index.delete(source.path)) changed.push(source.path);
          } else {
            fileId = randomBytes(16).toString("hex");
            copiedFrom = sourceFileId;
          }
        } else {
          fileId = randomBytes(16).toString("hex");
        }
      }
      index.set(path, { path, id, mode, fileId, ...(copiedFrom === undefined ? {} : { copiedFrom }),
        ...(stat === undefined ? {} : { stat }) });
      if (!existing || existing.id !== id || existing.mode !== mode || existing.fileId !== fileId) changed.push(path);
    }
    this.writeIndex([...index.values()]);
    return changed.sort(compareByteOrder);
  }

  /**
   * Stores one path's working-tree bytes as the object kind its path implies.
   *
   * A configured record path is parsed and re-encoded canonically, which is what
   * makes the per-field merge possible at all: two agents whose editors disagree
   * about key order or indentation produce one object id, so the file does not
   * register as changed when only its formatting moved.
   *
   * @param path - Canonical repository-relative path.
   * @param content - The file's bytes.
   * @returns The stored object's id.
   * @throws ObjectStoreError When a configured record path does not hold a JSON
   *   object — storing it as a blob instead would silently drop it out of
   *   field-aware merging for the rest of its history.
   */
  private stageContent(path: string, content: Buffer): ObjectId {
    if (!isRecordPath(path, this.config)) return this.objects.write("blob", content);
    return this.objects.write("record", encodeRecord(parseWorkingRecord(path, content)));
  }

  /**
   * The repository's current ignore rules.
   *
   * Read on each use rather than cached: `.pmvcsignore` is itself a tracked file,
   * so switching branches or merging can change it, and a cached copy would
   * quietly apply the previous branch's rules to the new tree.
   *
   * @returns The compiled rules.
   */
  private ignoreRules(): IgnoreRules {
    return readIgnoreRules(this.root);
  }

  /**
   * Compares HEAD, the index and the working tree.
   *
   * When an in-progress merge is recorded, the worktree is by construction not
   * clean — a resolution is owed — and the conflicted paths are surfaced on the
   * report so a downstream agent that only reads `status` can see them. That is
   * the signal that survives the merge command's own return value, which is the
   * third defect the merge-state work fixes.
   *
   * @param read - Working-file reader; injectable for race and cache tests.
   * @returns What is staged, what is not, what is untracked, and any in-progress
   *   merge with its conflicted paths.
   */
  status(read: typeof readWorkingFile = readWorkingFile): StatusReport {
    const snapshot = this.readIndexSnapshot();
    const refreshed = new Map<string, IndexEntry["stat"]>();
    const report = computeStatus(
      this.objects,
      this.root,
      this.headTree(),
      snapshot.entries,
      CONTROL_DIRECTORY,
      this.ignoreRules(),
      (path, content) => (
        isRecordPath(path, this.config)
          ? hashObject("record", encodeRecord(parseWorkingRecord(path, content)))
          : hashObject("blob", content)
      ),
      read,
      (path, stat) => refreshed.set(path, stat),
    );
    if (refreshed.size > 0) {
      this.replaceIndex(snapshot.entries.map((entry) => {
        const stat = refreshed.get(entry.path);
        return stat === undefined ? entry : { ...entry, stat };
      }), snapshot.contents);
    }
    const merge = this.readMergeState();
    if (merge === null) return report;
    // The merge state is authoritative for `clean`: even if HEAD, index and
    // working tree momentarily agree, the repository is not in a settled state
    // until the merge is completed or aborted.
    return {
      ...report,
      clean: false,
      merge: {
        revision: merge.revision,
        theirs: merge.theirs,
        conflicts: merge.conflicts.map((conflict) => conflict.path),
      },
    };
  }

  /**
   * Converts one stored object to the bytes its working-tree path promises.
   *
   * @param path - Canonical repository-relative path.
   * @param object - Stored object at that path.
   * @returns Native PM TOON for item records, or the object's raw bytes otherwise.
   */
  private workingContent(path: string, object: StoredObject): Buffer {
    return object.type === "record" ? renderWorkingRecord(path, decodeRecord(object.payload)) : object.payload;
  }

  /** Materializes a tree with record-aware working-tree serialization. */
  private materialize(tree: ObjectId | null): void {
    const removablePaths = new Set(this.readIndex().map((entry) => entry.path));
    this.writeIndex(materializeTree(
      this.objects,
      this.root,
      tree,
      CONTROL_DIRECTORY,
      this.ignoreRules(),
      (path, object) => this.workingContent(path, object),
      removablePaths,
    ));
  }

  /**
   * HEAD's root tree.
   *
   * @returns The tree id, or null on an unborn branch.
   */
  headTree(): ObjectId | null {
    const head = this.refs.resolveHead();
    return head === null ? null : readCommit(this.objects, head).tree;
  }

  /**
   * Commits the index.
   *
   * Refuses while an in-progress merge is recorded: the merge's conflicted paths
   * must be resolved and completed with `merge --continue` (or abandoned with
   * `--abort`), not committed as an ordinary single-parent commit. Letting a
   * plain `commit` through would either record the markers as a normal commit or
   * discard the second parent, in both cases losing the signal that the merge
   * never finished.
   *
   * @param options - Message, author, and whether an empty commit is allowed.
   * @param now - Timestamp for the operation log entry.
   * @returns The new commit's id.
   * @throws ObjectStoreError When a merge is in progress, or nothing is staged
   *   and `allowEmpty` is not set.
   */
  commit(options: CommitOptions, now: Date): ObjectId {
    this.assertNoMergeInProgress();
    const head = this.refs.readHead();
    const parent = head.target;
    const tree = buildTree(
      this.objects,
      new Map(this.readIndex().map((entry) => [entry.path, {
        id: entry.id,
        mode: entry.mode as FileMode,
        fileId: entry.fileId,
        copiedFrom: entry.copiedFrom,
      }])),
    );
    if (!options.allowEmpty && parent !== null && readCommit(this.objects, parent).tree === tree) {
      throw new ObjectStoreError(
        "empty_commit",
        "Nothing staged differs from HEAD. Stage a change, or pass allowEmpty to record one anyway.",
      );
    }
    const base = {
      tree,
      parents: parent === null ? [] : [parent],
      author: options.author,
      committer: options.committer ?? options.author,
      message: options.message,
      ...(options.items === undefined ? {} : { items: options.items }),
    };
    // A new commit's change id is the id it would have with no change line, so
    // the identity is a function of the content the commit describes rather than
    // of the metadata rewriting later changes. Deriving it here, before the
    // commit is stored, is what keeps the property deterministic with no seed.
    const id = writeCommit(this.objects, { ...base, changeId: identityWithoutChangeLine(base) });
    this.advanceHead(head, parent, id, "commit", `Committed ${id.slice(0, 12)}: ${splitLines(options.message)[0] ?? ""}`, now);
    return id;
  }

  /**
   * Moves HEAD forward, updating the branch it names when it names one.
   *
   * @param head - HEAD as it was read before the operation.
   * @param expected - The value HEAD resolved to before the operation.
   * @param next - The commit HEAD should end up at.
   * @param command - Command name for the operation log.
   * @param summary - Human-readable summary for the operation log.
   * @param now - Timestamp for the operation log entry.
   */
  private advanceHead(
    head: HeadState,
    expected: ObjectId | null,
    next: ObjectId,
    command: string,
    summary: string,
    now: Date,
  ): void {
    if (head.kind === "branch") {
      this.refs.compareAndSwap(head.ref, expected, next);
      this.operations.append(command, summary, [{ ref: head.ref, before: expected, after: next }], now);
      return;
    }
    // Detached HEAD advances HEAD itself. Recorded as a transition on the literal
    // name "HEAD" so undo has something to compare and swap against.
    this.refs.setHeadDetached(next);
    this.operations.append(command, summary, [{ ref: "HEAD", before: expected, after: next }], now);
  }

  /**
   * Resolves a revision name to a commit.
   *
   * Accepts a full object id, a branch or tag name with or without its `refs/`
   * prefix, a remote-tracking shorthand such as `origin/main`, and `HEAD`.
   *
   * The remote-tracking namespace is searched last, so a local branch always
   * wins a shorthand both could answer. That ordering is what makes the
   * shorthand safe to add to an existing repository: a branch literally named
   * `origin/main` keeps resolving to itself, and only a name no local branch or
   * tag claims can reach a tracking ref. A remote's name cannot contain a slash
   * (see {@link assertRemoteName}), so `<remote>/<branch>` never splits two ways.
   *
   * @param revision - The name to resolve.
   * @returns The commit id.
   * @throws ObjectStoreError When nothing by that name exists.
   */
  resolve(revision: string): ObjectId {
    if (revision === "HEAD") {
      const head = this.refs.resolveHead();
      if (head === null) throw new ObjectStoreError("unborn_head", "HEAD has no commit yet.");
      return head;
    }
    if (isObjectId(revision) && this.objects.has(revision)) return revision;
    const candidates = [
      revision,
      `${BRANCH_PREFIX}${revision}`,
      `${TAG_PREFIX}${revision}`,
      `${REMOTE_PREFIX}${revision}`,
    ];
    for (const candidate of candidates) {
      let target: ObjectId | null;
      try {
        target = this.refs.read(candidate);
      } catch {
        continue;
      }
      if (target !== null) return target;
    }
    throw new ObjectStoreError(
      "unknown_revision",
      `"${revision}" is not a known commit, branch, tag or remote-tracking branch.`,
    );
  }

  /**
   * Creates a branch at a revision.
   *
   * @param name - Branch name, without the `refs/heads/` prefix.
   * @param revision - Where it should point. Defaults to HEAD.
   * @param now - Timestamp for the operation log entry.
   * @returns The commit the branch points at.
   * @throws ObjectStoreError When the branch already exists.
   */
  createBranch(name: string, revision: string, now: Date): ObjectId {
    const ref = `${BRANCH_PREFIX}${name}`;
    assertRefName(ref);
    const target = this.resolve(revision);
    this.refs.compareAndSwap(ref, null, target);
    this.operations.append("branch", `Created ${name} at ${target.slice(0, 12)}.`, [
      { ref, before: null, after: target },
    ], now);
    return target;
  }

  /**
   * Deletes a branch.
   *
   * @param name - Branch name, without the prefix.
   * @param now - Timestamp for the operation log entry.
   * @throws ObjectStoreError When the branch does not exist or HEAD is on it.
   */
  deleteBranch(name: string, now: Date): void {
    const ref = `${BRANCH_PREFIX}${name}`;
    const head = this.refs.readHead();
    if (head.kind === "branch" && head.ref === ref) {
      throw new ObjectStoreError("branch_checked_out", `Cannot delete ${name}: HEAD is on it. Switch away first.`);
    }
    const target = this.refs.read(ref);
    if (target === null) throw new ObjectStoreError("unknown_branch", `No branch named ${name}.`);
    this.refs.compareAndSwap(ref, target, null);
    this.operations.append("branch", `Deleted ${name}.`, [{ ref, before: target, after: null }], now);
  }

  /**
   * Switches HEAD to a branch or, detached, to any revision.
   *
   * Refuses before touching the working tree when applying the switch would
   * destroy work no commit holds. That covers two cases, not one: a tracked path
   * with uncommitted changes that differs between the two trees, and an
   * **untracked** file the target tree would write over. `materializeTree` also
   * removes working-tree paths the target tree does not carry, so an untracked file
   * would otherwise be deleted by a switch — content that exists in no object and
   * cannot be recovered by any undo.
   *
   * The switch records HEAD's before and after contents in the operation log, which
   * is what makes it undoable. Recording nothing left `undo` iterating an empty
   * transition list and reporting success without moving HEAD.
   *
   * @param revision - Branch name, or any revision for a detached switch.
   * @param now - Timestamp for the operation log entry.
   * @returns The commit HEAD ended up at.
   * @throws ObjectStoreError When uncommitted or untracked work would be lost.
   */
  switchTo(revision: string, now: Date): ObjectId {
    this.assertNoMergeInProgress();
    const target = this.resolve(revision);
    const targetTree = readCommit(this.objects, target).tree;
    const current = flattenTree(this.objects, this.headTree());
    const next = flattenTree(this.objects, targetTree);
    const status = this.status();
    const dirty = new Set([
      ...status.unstaged.map((change) => change.path),
      ...status.staged.map((change) => change.path),
    ]);
    const wouldOverwrite = [...dirty].filter((path) => (
      (current.get(path)?.id ?? null) !== (next.get(path)?.id ?? null)
    )).sort(compareByteOrder);
    if (wouldOverwrite.length > 0) {
      throw new ObjectStoreError(
        "switch_would_overwrite",
        `Switching to ${revision} would overwrite uncommitted changes to ${wouldOverwrite.join(", ")}. `
        + "Commit or discard them first.",
      );
    }
    const untrackedLoss = status.untracked.filter((path) => next.has(path)).sort(compareByteOrder);
    if (untrackedLoss.length > 0) {
      throw new ObjectStoreError(
        "switch_would_overwrite",
        `Switching to ${revision} would overwrite untracked ${untrackedLoss.join(", ")}, which no commit holds. `
        + "Stage and commit them, move them aside, or delete them first.",
      );
    }
    const branchRef = `${BRANCH_PREFIX}${revision}`;
    let exists = false;
    try {
      exists = this.refs.read(branchRef) !== null;
    } catch {
      exists = false;
    }
    const before = this.refs.readHead();
    const beforeTarget = before.kind === "branch" ? before.ref : before.target;
    const rawBefore = this.refs.rawHead();
    if (exists) this.refs.setHeadToRef(branchRef);
    else this.refs.setHeadDetached(target);
    this.materialize(targetTree);
    this.operations.append(
      "switch",
      `Switched from ${beforeTarget} to ${exists ? revision : target.slice(0, 12)}.`,
      [],
      now,
      { before: rawBefore, after: this.refs.rawHead() },
    );
    return target;
  }

  /**
   * Walks first-parent history from a revision.
   *
   * First-parent only, so the output reads as the sequence of changes that
   * landed on this branch rather than as an interleaving of every branch ever
   * merged into it.
   *
   * @param revision - Where to start.
   * @param limit - Maximum entries to return.
   * @returns The commits, newest first.
   */
  log(revision: string, limit = 50): LogEntry[] {
    const entries: LogEntry[] = [];
    let cursor: ObjectId | undefined = this.resolve(revision);
    while (cursor !== undefined && entries.length < limit) {
      const commit = readCommit(this.objects, cursor);
      entries.push({ id: cursor, commit, changeId: effectiveChangeId(cursor, commit) });
      cursor = commit.parents[0];
    }
    return entries;
  }

  /**
   * Reads a tree entry's object as the text a diff should compare.
   *
   * Dispatches on the **stored** kind rather than assuming a blob. A configured
   * record path is staged as a `record` object, so demanding a blob here made
   * `diff` throw `object_type_mismatch` for every repository that configured one —
   * that is, for every repository using the feature the package exists for.
   *
   * A record is rendered one field per line rather than as its canonical
   * single-line bytes, because a per-field merge engine whose diff reports a
   * one-field change as a whole-line replacement tells the reader nothing about
   * what changed. The rendering is for display only and is never hashed.
   *
   * @param id - Object the path is bound to, or null when the path is absent on
   *   that side.
   * @returns The text to diff, empty for an absent path.
   */
  private diffText(id: ObjectId | null): string {
    if (id === null) return "";
    const object = this.objects.read(id);
    if (object.type !== "record") return object.payload.toString("utf8");
    const document = decodeRecord(object.payload);
    return `${Object.keys(document)
      .sort(compareByteOrder)
      .map((field) => `${JSON.stringify(field)}: ${JSON.stringify(document[field])}`)
      .join("\n")}\n`;
  }

  /**
   * Unified diff between two revisions' trees.
   *
   * @param fromRevision - The left side.
   * @param toRevision - The right side.
   * @returns The unified diff, empty when the trees are identical.
   */
  diff(fromRevision: string, toRevision: string): string {
    const left = flattenTree(this.objects, readCommit(this.objects, this.resolve(fromRevision)).tree);
    const right = flattenTree(this.objects, readCommit(this.objects, this.resolve(toRevision)).tree);
    const output: string[] = [];
    for (const path of [...new Set([...left.keys(), ...right.keys()])].sort(compareByteOrder)) {
      const before = left.get(path);
      const after = right.get(path);
      if (before?.id === after?.id && before?.mode === after?.mode) continue;
      if (before !== undefined && after !== undefined && before.mode !== after.mode) {
        output.push(`old mode ${before.mode}\nnew mode ${after.mode}\n`);
      }
      if (before?.id !== after?.id) {
        output.push(unifiedDiff(
          this.diffText(before?.id ?? null),
          this.diffText(after?.id ?? null),
          before ? `a/${path}` : "/dev/null",
          after ? `b/${path}` : "/dev/null",
        ));
      }
    }
    return output.join("");
  }

  /**
   * Merges another revision into HEAD.
   *
   * Four outcomes. If HEAD already contains the other side, nothing happens. If
   * the other side contains HEAD, HEAD fast-forwards with no merge commit — there
   * is no third version to reconcile, so inventing a merge commit would only add
   * a node that says nothing. If every path merges cleanly (or only with the
   * advisory conflicts that keep one side's content — identity, mode, delete vs.
   * modify), a merge commit records both parents. If any path's merged blob
   * carries diff3 conflict markers, the merge stops: no commit is recorded, the
   * merged tree is written into the working tree and index so the markers are
   * visible, and in-progress merge state is persisted for `merge --continue` and
   * `merge --abort` to act on. Stopping is what keeps an unbuildable revision out
   * of history; the state is what lets a later command see that a resolution is
   * owed.
   *
   * Refuses if a merge is already in progress, before the dirty-worktree check,
   * so the message names the real problem rather than a symptom of it.
   *
   * @param revision - The revision to merge in.
   * @param options - Message and author for the merge commit.
   * @param now - Timestamp for the operation log entry.
   * @param labels - Names written into conflict markers.
   * @returns What the merge did and what conflicted.
   * @throws ObjectStoreError When a merge is already in progress, HEAD is
   *   unborn, the working tree is dirty, or the two sides share no history.
   */
  merge(revision: string, options: CommitOptions, now: Date, labels?: ConflictLabels): MergeReport {
    const head = this.refs.readHead();
    const ours = head.target;
    if (ours === null) {
      throw new ObjectStoreError("unborn_head", "HEAD has no commit yet, so there is nothing to merge into.");
    }
    // A merge in progress is refused before the dirty check: the in-progress
    // state makes the worktree dirty by design, so the dirty check would fire
    // and report a symptom instead of the cause.
    this.assertNoMergeInProgress();
    const theirs = this.resolve(revision);
    if (isAncestor(this.objects, theirs, ours)) {
      return { kind: "up_to_date", head: ours, bases: [theirs], merged: [], conflicts: [], clean: true };
    }
    if (!this.status().clean) {
      throw new ObjectStoreError(
        "dirty_worktree",
        "The working tree has changes that are not committed. Merging would mix them into the result.",
      );
    }
    if (isAncestor(this.objects, ours, theirs)) {
      const tree = readCommit(this.objects, theirs).tree;
      // Ref first, working tree second. `advanceHead` compare-and-swaps, so it can
      // refuse — and materializing before that refusal would leave the index and
      // working tree holding a result HEAD does not name, with nothing in the
      // operation log describing it. That is the one state this engine promises
      // cannot happen. Object writes before the ref update are harmless: they are
      // content-addressed and simply unreferenced if the update fails.
      this.advanceHead(head, ours, theirs, "merge", `Fast-forwarded to ${theirs.slice(0, 12)}.`, now);
      this.materialize(tree);
      return { kind: "fast_forward", head: theirs, bases: [ours], merged: [], conflicts: [], clean: true };
    }

    const bases = mergeBases(this.objects, ours, theirs);
    if (bases.length === 0) {
      throw new ObjectStoreError(
        "unrelated_histories",
        `${revision} and HEAD share no common ancestor, so there is no base to merge against.`,
      );
    }
    const baseTree = this.virtualBaseTree(bases, options.committer ?? options.author);
    const { tree, merged, conflicts } = mergeTrees(
      this.rewriteContext(options.committer ?? options.author),
      baseTree,
      readCommit(this.objects, ours).tree,
      readCommit(this.objects, theirs).tree,
      labels,
    );
    const markerConflicts = conflicts.filter((conflict) => {
      const entry = flattenTree(this.objects, tree).get(conflict.path);
      return entry === undefined ? false : this.blobHasConflictMarkers(entry.id);
    });
    if (markerConflicts.length > 0) {
      // No commit: the merged tree carries conflict markers, and recording it
      // would put an unbuildable revision into history. The working tree and
      // index still receive the merged tree so the markers and the cleanly
      // merged paths are visible and `add` can stage resolutions; the merge
      // state persists everything `--continue` needs to finish the commit
      // without the caller re-supplying it.
      this.materialize(tree);
      this.writeMergeState({
        ours,
        theirs,
        revision,
        bases,
        merged,
        conflicts,
        message: options.message,
        author: options.author,
        committer: options.committer ?? options.author,
        ...(labels === undefined ? {} : { labels }),
      });
      return { kind: "conflicted", head: ours, bases, merged, conflicts, clean: false };
    }
    const draft = {
      tree,
      parents: [ours, theirs],
      author: options.author,
      committer: options.committer ?? options.author,
      message: options.message,
    };
    const id = writeCommit(this.objects, { ...draft, changeId: identityWithoutChangeLine(draft) });
    // Ref before working tree, as in the fast-forward above and for the same reason.
    this.advanceHead(head, ours, id, "merge", `Merged ${revision} as ${id.slice(0, 12)}.`, now);
    this.materialize(tree);
    return { kind: "merged", head: id, bases, merged, conflicts, clean: conflicts.length === 0 };
  }

  /**
   * Completes a merge that stopped with conflict markers, after the caller has
   * resolved and staged the paths.
   *
   * Builds the merge commit the original merge refused to record, using the
   * parents, bases, message and author persisted in the merge state, so the
   * caller does not re-supply any of it. The commit's tree is the current index:
   * the user stages their resolution with `add`, and the cleanly merged paths are
   * already staged from the stopped merge. Refuses while any staged blob still
   * carries conflict markers — that is the one check that keeps an unbuildable
   * revision out of history, and it is authoritative because the index is what
   * gets committed.
   *
   * @param now - Timestamp for the operation log entry.
   * @returns The completed merge report.
   * @throws ObjectStoreError When no merge is in progress, or a staged path still
   *   carries conflict markers.
   */
  mergeContinue(now: Date): MergeReport {
    const state = this.readMergeState();
    if (state === null) {
      throw new ObjectStoreError(
        "no_merge_in_progress",
        "There is no merge in progress to continue. Run `pm vcs merge <revision>` to start one.",
      );
    }
    const index = this.readIndex();
    const marked = index
      .filter((entry) => this.blobHasConflictMarkers(entry.id))
      .map((entry) => entry.path)
      .sort(compareByteOrder);
    if (marked.length > 0) {
      throw new ObjectStoreError(
        "merge_conflicts_not_resolved",
        `Cannot complete the merge: ${marked.join(", ")} still contain conflict markers. Edit the listed paths to remove the markers, stage them with \`pm vcs add\`, then run \`pm vcs merge --continue\` again.`,
      );
    }
    const tree = buildTree(
      this.objects,
      new Map(index.map((entry) => [entry.path, {
        id: entry.id,
        mode: entry.mode as FileMode,
        fileId: entry.fileId,
        copiedFrom: entry.copiedFrom,
      }])),
    );
    const draft = {
      tree,
      parents: [state.ours, state.theirs],
      author: state.author,
      committer: state.committer,
      message: state.message,
    };
    const id = writeCommit(this.objects, { ...draft, changeId: identityWithoutChangeLine(draft) });
    const head = this.refs.readHead();
    // The merge state recorded `ours` as the expected HEAD; a concurrent move
    // would have cleared or changed it, so the compare-and-swap in `advanceHead`
    // refuses rather than committing over a moved branch.
    this.advanceHead(head, state.ours, id, "merge", `Merged ${state.revision} as ${id.slice(0, 12)}.`, now);
    this.clearMergeState();
    return { kind: "merged", head: id, bases: state.bases, merged: state.merged, conflicts: [], clean: true };
  }

  /**
   * Abandons an in-progress merge, restoring the working tree and index to the
   * commit HEAD pointed at before the merge stopped.
   *
   * No ref moves — the stopped merge never moved one — and no operation-log entry
   * is recorded, because there is nothing to undo: the merge left only working
   * tree and merge state, both of which this removes. Objects written by the
   * stopped merge remain in the store, unreferenced and harmless.
   *
   * @param now - Unused; kept for symmetry with the merge family so the command
   *   handler does not special-case the call.
   * @returns The abandoned merge's ours and theirs commits.
   * @throws ObjectStoreError When no merge is in progress.
   */
  mergeAbort(now: Date): { ours: ObjectId; theirs: ObjectId; revision: string } {
    void now;
    const state = this.readMergeState();
    if (state === null) {
      throw new ObjectStoreError(
        "no_merge_in_progress",
        "There is no merge in progress to abort. Run `pm vcs merge <revision>` to start one.",
      );
    }
    this.materialize(readCommit(this.objects, state.ours).tree);
    this.clearMergeState();
    return { ours: state.ours, theirs: state.theirs, revision: state.revision };
  }

  /**
   * Reduces several merge bases to one tree to merge against.
   *
   * With a single base this is that base's tree. With several — a criss-cross
   * history — the bases are merged into each other to produce a tree that is not
   * any commit's snapshot but does contain the changes all of them agree on.
   * Picking one base arbitrarily instead is what makes a criss-cross merge
   * reintroduce a change that was already reverted, silently.
   *
   * @param bases - The minimal common ancestors.
   * @returns The tree to use as the merge base.
   */
  private virtualBaseTree(bases: readonly ObjectId[], committer: Signature): ObjectId {
    let tree = readCommit(this.objects, bases[0]).tree;
    for (const other of bases.slice(1)) {
      const otherTree = readCommit(this.objects, other).tree;
      const nested = mergeBases(this.objects, bases[0], other);
      const nestedBase = nested.length > 0 ? readCommit(this.objects, nested[0]).tree : null;
      // Conflicts between two bases are resolved by keeping the first base's
      // side. A virtual base is a heuristic, not a snapshot anyone committed, and
      // recording markers in it would push them into the real merge's output.
      const { tree: merged } = mergeTrees(this.rewriteContext(committer), nestedBase, tree, otherTree);
      tree = merged;
    }
    return tree;
  }

  /**
   * Reverses an operation.
   *
   * The working tree is re-materialized from wherever HEAD ends up, so the tree
   * and the refs never disagree after an undo.
   *
   * @param sequence - Which operation to reverse, or null for the most recent.
   * @param now - Timestamp for the undo's own log entry.
   * @returns The undo operation that was recorded.
   */
  undo(sequence: number | null, now: Date): Operation {
    this.assertNoMergeInProgress();
    const operation = this.operations.undo(this.refs, sequence, now);
    const head = this.refs.resolveHead();
    this.materialize(head === null ? null : readCommit(this.objects, head).tree);
    return operation;
  }

  /**
   * Every commit reachable from any branch or tag.
   *
   * @returns The reachable commit ids, sorted.
   */
  allReachable(): ObjectId[] {
    const found = new Set<ObjectId>();
    for (const ref of [...this.refs.list(BRANCH_PREFIX), ...this.refs.list(TAG_PREFIX)]) {
      for (const id of reachable(this.objects, ref.target)) found.add(id);
    }
    return [...found].sort(compareByteOrder);
  }

  /**
   * The store and policy every tree merge needs, bound to a committer.
   *
   * @param committer - Signature applied to rewritten commits.
   * @returns The context planning functions take.
   */
  private rewriteContext(committer: Signature): RewriteContext {
    return { store: this.objects, config: this.config, committer };
  }

  /**
   * Every branch and tag as a snapshot, the tips descendant replay walks from.
   *
   * @returns Each ref paired with its target.
   */
  private refSnapshots(): RefSnapshot[] {
    return [...this.refs.list(BRANCH_PREFIX), ...this.refs.list(TAG_PREFIX)]
      .map((entry) => ({ name: entry.name, target: entry.target }));
  }

  /**
   * HEAD as planning reads it.
   *
   * @returns HEAD's kind, ref and target.
   */
  private headSnapshot(): HeadSnapshot {
    const head = this.refs.readHead();
    return head.kind === "branch"
      ? { kind: "branch", ref: head.ref, target: head.target }
      : { kind: "detached", ref: null, target: head.target };
  }

  /**
   * Refuses a rewrite on a dirty tree before any object is written.
   *
   * A rewrite re-materialises the working tree from the new HEAD, so uncommitted
   * changes would be overwritten. Checking first is what keeps the overwrite
   * from happening — the whole point of the engine's transactional discipline.
   *
   * @throws ObjectStoreError When the working tree has uncommitted changes.
   */
  private assertCleanWorktree(): void {
    if (!this.status().clean) {
      throw new ObjectStoreError(
        "dirty_worktree",
        "The working tree has changes that are not committed. Commit or undo them before rewriting history.",
      );
    }
  }

  /**
   * Turns a planning conflict into a repository error naming every path.
   *
   * @param error - The conflict planning raised.
   * @returns The repository error to throw.
   */
  private rewriteConflictError(error: RewriteConflictError): ObjectStoreError {
    const described = error.conflicts
      .map((conflict) => (conflict.fields ? `${conflict.path} (${conflict.fields.join(", ")})` : conflict.path))
      .join(", ");
    return new ObjectStoreError(
      "rewrite_conflict",
      `The rewrite left ${error.conflicts.length} conflict(s): ${described}. `
        + "Resolve the listed paths on one side first, or rewrite a range that does not span them.",
    );
  }

  /**
   * Runs a planner, translating a conflict into a message a caller can act on.
   *
   * One site rather than one per operation. Only a rewrite that *replays* a
   * descendant against a changed tree can conflict — a rebase, or a squash that moves
   * content between commits — so `describe`, `split`, `reset` and `restore` each
   * carried a copy of this translation that no input could reach. Six copies of an
   * arm that four of them cannot take is worse than one copy that all of them share:
   * the duplicates read as though every operation can conflict, which is the opposite
   * of what the design guarantees.
   *
   * `cherryPick` and `revert` do use it for real: both apply a change onto HEAD, so
   * both can genuinely conflict. They return a commit id rather than a plan, hence the
   * type parameter.
   *
   * @param plan - Thunk producing the value, so the throw happens inside this method.
   * @returns Whatever the thunk produced.
   * @throws ObjectStoreError When planning found conflicts, naming each path and, for
   *   a record, the fields that disagreed.
   */
  private planned<T>(plan: () => T): T {
    try {
      return plan();
    } catch (error) {
      if (error instanceof RewriteConflictError) throw this.rewriteConflictError(error);
      throw error;
    }
  }

  /**
   * Applies a rewrite plan in one operation-log entry, then re-materialises.
   *
   * Every ref move is a compare-and-swap against the value planning read, and all
   * of them are recorded in a single operation-log entry, so `undo` reverses the
   * whole rewrite at once. The working tree is re-materialised from wherever
   * HEAD lands, so the tree and the refs never disagree after a rewrite.
   *
   * @param plan - The plan planning produced.
   * @param now - Timestamp for the operation-log entry.
   * @returns The commit HEAD ends up at, or null on an unborn branch.
   */
  private applyRewrite(plan: RewritePlan, now: Date): ObjectId | null {
    this.refs.transaction(plan.moves.map((move) => ({
      name: move.ref,
      expected: move.before,
      next: move.after,
    })));
    this.operations.append(plan.command, plan.summary, plan.moves, now);
    const head = this.refs.resolveHead();
    this.materialize(head === null ? null : readCommit(this.objects, head).tree);
    return head;
  }

  /**
   * Replaces one commit's message, preserving its change id.
   *
   * @param revision - The commit to describe.
   * @param message - The new message, verbatim.
   * @param committer - Signature for the rewritten commit.
   * @param now - Timestamp for the operation-log entry.
   * @returns The commit HEAD ends up at.
   */
  describe(revision: string, message: string, committer: Signature, now: Date): ObjectId | null {
    this.assertCleanWorktree();
    const id = this.resolve(revision);
    const plan = this.planned(() => (
        planDescribe(this.rewriteContext(committer), id, message, this.refSnapshots(), this.headSnapshot())
    ));
    return this.applyRewrite(plan, now);
  }

  /**
   * Rebases `source`'s side of the divergence onto `onto`.
   *
   * @param source - The tip whose commits are replayed.
   * @param onto - The tip they are replayed onto.
   * @param committer - Signature for the replayed commits.
   * @param now - Timestamp for the operation-log entry.
   * @returns The commit HEAD ends up at.
   */
  rebase(source: string, onto: string, committer: Signature, now: Date): ObjectId | null {
    this.assertCleanWorktree();
    const plan = this.planned(() => (
        planRebase(
          this.rewriteContext(committer),
          this.resolve(source),
          this.resolve(onto),
          this.refSnapshots(),
          this.headSnapshot(),
        )
    ));
    return this.applyRewrite(plan, now);
  }

  /**
   * Folds `revision` into its first parent.
   *
   * @param revision - The commit to squash.
   * @param committer - Signature for the surviving commit.
   * @param now - Timestamp for the operation-log entry.
   * @returns The commit HEAD ends up at.
   */
  squash(revision: string, committer: Signature, now: Date): ObjectId | null {
    this.assertCleanWorktree();
    const plan = this.planned(() => (
        planSquash(this.rewriteContext(committer), this.resolve(revision), this.refSnapshots(), this.headSnapshot())
    ));
    return this.applyRewrite(plan, now);
  }

  /**
   * Splits `revision` into two commits: the named paths, then the rest.
   *
   * @param revision - The commit to split.
   * @param patterns - Glob patterns selecting the first half's paths.
   * @param committer - Signature for both new commits.
   * @param now - Timestamp for the operation-log entry.
   * @returns The commit HEAD ends up at.
   */
  split(revision: string, patterns: readonly string[], committer: Signature, now: Date): ObjectId | null {
    this.assertCleanWorktree();
    const plan = this.planned(() => (
        planSplit(this.rewriteContext(committer), this.resolve(revision), patterns, this.refSnapshots(), this.headSnapshot())
    ));
    return this.applyRewrite(plan, now);
  }

  /**
   * Applies one commit's change onto HEAD as a new commit.
   *
   * @param revision - The commit whose change is applied.
   * @param committer - Signature for the new commit.
   * @param now - Timestamp for the operation-log entry.
   * @returns The new commit's id.
   */
  cherryPick(revision: string, committer: Signature, now: Date): ObjectId {
    this.assertCleanWorktree();
    const head = this.refs.readHead();
    const ours = head.target;
    if (ours === null) throw new ObjectStoreError("unborn_head", "HEAD has no commit yet to cherry-pick onto.");
    const commit = this.planned(() => planCherryPick(this.rewriteContext(committer), this.resolve(revision), ours));
    this.advanceHead(head, ours, commit, "cherry-pick", `Cherry-picked ${revision} as ${commit.slice(0, 12)}.`, now);
    this.materialize(readCommit(this.objects, commit).tree);
    return commit;
  }

  /**
   * Reverts one commit's change onto HEAD.
   *
   * @param revision - The commit to revert.
   * @param message - The revert commit's message.
   * @param committer - Signature for the new commit.
   * @param now - Timestamp for the operation-log entry.
   * @returns The new commit's id.
   */
  revert(revision: string, message: string, committer: Signature, now: Date): ObjectId {
    this.assertCleanWorktree();
    const head = this.refs.readHead();
    const ours = head.target;
    if (ours === null) throw new ObjectStoreError("unborn_head", "HEAD has no commit yet to revert onto.");
    const commit = this.planned(() => planRevert(this.rewriteContext(committer), this.resolve(revision), ours, message));
    this.advanceHead(head, ours, commit, "revert", `Reverted ${revision} as ${commit.slice(0, 12)}.`, now);
    this.materialize(readCommit(this.objects, commit).tree);
    return commit;
  }

  /**
   * Moves HEAD to a revision, and optionally the index and working tree.
   *
   * `soft` moves only the branch; `mixed` also rewrites the index to the
   * revision's tree; `hard` also rewrites tracked working-tree content. The
   * explicit hard mode permits discarding tracked edits, but refuses when any
   * untracked path would be deleted because no object or undo can recover it.
   *
   * @param revision - Where HEAD should move.
   * @param mode - How much to reset.
   * @param now - Timestamp for the operation-log entry.
   * @returns The commit HEAD moves to.
   */
  reset(revision: string, mode: ResetMode, now: Date): ObjectId {
    this.assertNoMergeInProgress();
    const head = this.refs.readHead();
    if (head.target === null) throw new ObjectStoreError("unborn_head", "HEAD has no commit yet to reset.");
    const target = this.resolve(revision);
    const targetTree = readCommit(this.objects, target).tree;
    if (mode === "hard") {
      const untracked = [...this.status().untracked].sort(compareByteOrder);
      if (untracked.length > 0) {
        throw new ObjectStoreError(
          "reset_would_discard_untracked",
          `A hard reset would delete untracked ${untracked.join(", ")}, which no commit holds. `
          + "Stage and commit them, move them aside, or delete them first.",
        );
      }
    }
    this.advanceHead(head, head.target, target, "reset", `Reset to ${target.slice(0, 12)} (${mode}).`, now);
    if (mode === "soft") return target;
    if (mode === "mixed") {
      this.writeIndex(this.indexEntriesForTree(targetTree));
      return target;
    }
    this.materialize(targetTree);
    return target;
  }

  /**
   * Restores named paths in the index and working tree from a revision.
   *
   * Unlike a rewrite, restore moves no ref: it copies the named paths' content
   * from the revision's tree into the index and the working tree, the way
   * `stage` copies working-tree content into the index. A path absent from the
   * revision is removed.
   *
   * @param paths - Canonical or working-tree paths to restore.
   * @param revision - The revision to restore from.
   * @returns The paths that were restored.
   */
  restore(paths: readonly string[], revision: string): string[] {
    const source = flattenTree(this.objects, readCommit(this.objects, this.resolve(revision)).tree);
    const index = new Map(this.readIndex().map((entry) => [entry.path, entry]));
    const restored: string[] = [];
    for (const candidate of paths) {
      const path = normalizeRepoPath(this.root, candidate);
      const entry = source.get(path);
      const absolute = join(this.root, ...path.split("/"));
      if (entry === undefined) {
        if (existsSync(absolute) && statSync(absolute).isDirectory()) {
          throw new ObjectStoreError(
            "restore_directory_unsupported",
            `Restore path ${path} is a directory, but restore accepts file paths. Name the files to restore instead.`,
          );
        }
        index.delete(path);
        rmSync(absolute, { force: true });
      } else {
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, this.workingContent(path, this.objects.read(entry.id)));
        chmodSync(absolute, entry.mode === "100755" ? 0o755 : 0o644);
        index.set(path, { path, id: entry.id, mode: entry.mode === "100755" ? "100755" : "100644" });
      }
      restored.push(path);
    }
    this.writeIndex([...index.values()]);
    return restored.sort();
  }

  /**
   * The index entries a tree implies, for a mixed reset.
   *
   * @param tree - The tree to turn into index entries, or null for empty.
   * @returns One index entry per file in the tree.
   */
  private indexEntriesForTree(tree: ObjectId | null): IndexEntry[] {
    return [...flattenTree(this.objects, tree)].map(([path, value]) => ({
      path,
      id: value.id,
      mode: value.mode === "100755" ? "100755" : "100644",
    }));
  }

}

/** How far a reset reaches: the ref, the index, or the working tree. */
export type ResetMode = "soft" | "mixed" | "hard";
