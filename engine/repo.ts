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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type Commit,
  type FileMode,
  type RecordDocument,
  type Signature,
  compareByteOrder,
  decodeRecord,
  encodeRecord,
  readCommit,
  writeCommit,
} from "./model.ts";
import { type ObjectId, ObjectStore, ObjectStoreError, hashObject, isObjectId } from "./objects.ts";
import {
  type ContentMergeResult,
  type ConflictLabels,
  isAncestor,
  mergeBases,
  mergeContent,
  reachable,
} from "./merge.ts";
import { mergeRecords } from "./records.ts";
import {
  DEFAULT_CONFIG,
  type RepositoryConfig,
  isRecordPath,
  readConfig,
  writeConfig,
} from "./config.ts";
import { BRANCH_PREFIX, type HeadState, RefStore, TAG_PREFIX, assertRefName } from "./refs.ts";
import { OperationLog, type Operation, type RefTransition } from "./oplog.ts";
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
} from "./worktree.ts";
import { splitLines, unifiedDiff } from "./diff.ts";
import { type IgnoreRules, isIgnored, readIgnoreRules } from "./ignore.ts";

/** Name of the control directory inside a repository root. */
export const CONTROL_DIRECTORY = ".pmvcs";

/** Repository format this build writes and can read. */
export const REPOSITORY_FORMAT = "pmvcs-1";

/** Branch a fresh repository starts on. */
export const DEFAULT_BRANCH = "main";

/** How a merge turned out. */
export interface MergeReport {
  /** What the merge did: nothing, a fast-forward, or a real merge commit. */
  readonly kind: "up_to_date" | "fast_forward" | "merged";
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

/** One path that could not be merged automatically. */
export interface MergeConflict {
  readonly path: string;
  /** `content` for text, `record` for a structured document, `mode` for a permission clash. */
  readonly reason: "content" | "record" | "mode";
  /** For a record conflict, the fields that disagreed. */
  readonly fields?: readonly string[];
}

/** One entry of `log` output. */
export interface LogEntry {
  readonly id: ObjectId;
  readonly commit: Commit;
}

/** Options that vary per commit. */
export interface CommitOptions {
  readonly message: string;
  readonly author: Signature;
  /** Defaults to the author, matching the common case of committing your own work. */
  readonly committer?: Signature;
  /** Allow a commit that changes nothing. Off by default so an empty commit is deliberate. */
  readonly allowEmpty?: boolean;
}

/**
 * One repository: object store, refs, index, working tree and operation log.
 */
export class Repository {
  /** Absolute path to the working tree root. */
  readonly root: string;

  /** Absolute path to the control directory. */
  readonly controlDirectory: string;

  readonly objects: ObjectStore;

  readonly refs: RefStore;

  readonly operations: OperationLog;

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
   * Reads the index.
   *
   * @returns The staged entries.
   */
  readIndex(): IndexEntry[] {
    try {
      return decodeIndex(readFileSync(this.indexPath, "utf8"));
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error;
      return [];
    }
  }

  /**
   * Replaces the index.
   *
   * @param entries - The staged entries to record.
   */
  writeIndex(entries: readonly IndexEntry[]): void {
    writeFileSync(this.indexPath, encodeIndex(entries));
  }

  /**
   * Stages working-tree paths, or every tracked and untracked path.
   *
   * A path that no longer exists is removed from the index rather than failing,
   * so `add` after a delete stages the deletion — the alternative is a separate
   * remove command whose only job is to say what `add` already knows.
   *
   * @param paths - Paths to stage, or an empty array for everything.
   * @returns The paths whose staged state changed.
   */
  stage(paths: readonly string[]): string[] {
    const index = new Map(this.readIndex().map((entry) => [entry.path, entry]));
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
      try {
        ({ content, executable } = readWorkingFile(this.root, path));
      } catch {
        if (index.delete(path)) changed.push(path);
        continue;
      }
      const id = this.stageContent(path, content);
      const mode = executable ? "100755" : "100644";
      const existing = index.get(path);
      if (existing && existing.id === id && existing.mode === mode) continue;
      index.set(path, { path, id, mode });
      changed.push(path);
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
    return this.objects.write("record", encodeRecord(decodeRecord(content)));
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
   * @returns What is staged, what is not, and what is untracked.
   */
  status(): StatusReport {
    return computeStatus(
      this.objects,
      this.root,
      this.headTree(),
      this.readIndex(),
      CONTROL_DIRECTORY,
      this.ignoreRules(),
      (path, content) => (
        isRecordPath(path, this.config)
          ? hashObject("record", encodeRecord(decodeRecord(content)))
          : hashObject("blob", content)
      ),
    );
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
   * @param options - Message, author, and whether an empty commit is allowed.
   * @param now - Timestamp for the operation log entry.
   * @returns The new commit's id.
   * @throws ObjectStoreError When nothing is staged and `allowEmpty` is not set.
   */
  commit(options: CommitOptions, now: Date): ObjectId {
    const head = this.refs.readHead();
    const parent = head.target;
    const tree = buildTree(
      this.objects,
      new Map(this.readIndex().map((entry) => [entry.path, { id: entry.id, mode: entry.mode as FileMode }])),
    );
    if (!options.allowEmpty && parent !== null && readCommit(this.objects, parent).tree === tree) {
      throw new ObjectStoreError(
        "empty_commit",
        "Nothing staged differs from HEAD. Stage a change, or pass allowEmpty to record one anyway.",
      );
    }
    const id = writeCommit(this.objects, {
      tree,
      parents: parent === null ? [] : [parent],
      author: options.author,
      committer: options.committer ?? options.author,
      message: options.message,
    });
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
   * prefix, and `HEAD`.
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
    for (const candidate of [revision, `${BRANCH_PREFIX}${revision}`, `${TAG_PREFIX}${revision}`]) {
      let target: ObjectId | null;
      try {
        target = this.refs.read(candidate);
      } catch {
        continue;
      }
      if (target !== null) return target;
    }
    throw new ObjectStoreError("unknown_revision", `"${revision}" is not a known commit, branch or tag.`);
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
    this.writeIndex(materializeTree(this.objects, this.root, targetTree, CONTROL_DIRECTORY, this.ignoreRules()));
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
      entries.push({ id: cursor, commit });
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
      // Two paths bound to the same object id are byte-identical by construction,
      // so there is nothing to read and nothing to diff.
      if (before?.id === after?.id) continue;
      output.push(unifiedDiff(
        this.diffText(before?.id ?? null),
        this.diffText(after?.id ?? null),
        before ? `a/${path}` : "/dev/null",
        after ? `b/${path}` : "/dev/null",
      ));
    }
    return output.join("");
  }

  /**
   * Merges another revision into HEAD.
   *
   * Three outcomes. If HEAD already contains the other side, nothing happens. If
   * the other side contains HEAD, HEAD moves forward with no merge commit — there
   * is no third version to reconcile, so inventing a merge commit would only add
   * a node that says nothing. Otherwise every path is merged three-way and a
   * merge commit records both parents.
   *
   * Conflicts are written into the working tree and staged as they are, so the
   * repository state after a conflicted merge is inspectable with the same
   * commands as any other state.
   *
   * @param revision - The revision to merge in.
   * @param options - Message and author for the merge commit.
   * @param now - Timestamp for the operation log entry.
   * @param labels - Names written into conflict markers.
   * @returns What the merge did and what conflicted.
   * @throws ObjectStoreError When HEAD is unborn, the working tree is dirty, or
   *   the two sides share no history.
   */
  merge(revision: string, options: CommitOptions, now: Date, labels?: ConflictLabels): MergeReport {
    const head = this.refs.readHead();
    const ours = head.target;
    if (ours === null) {
      throw new ObjectStoreError("unborn_head", "HEAD has no commit yet, so there is nothing to merge into.");
    }
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
      this.writeIndex(materializeTree(this.objects, this.root, tree, CONTROL_DIRECTORY, this.ignoreRules()));
      return { kind: "fast_forward", head: theirs, bases: [ours], merged: [], conflicts: [], clean: true };
    }

    const bases = mergeBases(this.objects, ours, theirs);
    if (bases.length === 0) {
      throw new ObjectStoreError(
        "unrelated_histories",
        `${revision} and HEAD share no common ancestor, so there is no base to merge against.`,
      );
    }
    const baseTree = this.virtualBaseTree(bases);
    const { files, merged, conflicts } = this.mergeTrees(
      baseTree,
      readCommit(this.objects, ours).tree,
      readCommit(this.objects, theirs).tree,
      labels,
    );
    const tree = buildTree(this.objects, files);
    const id = writeCommit(this.objects, {
      tree,
      parents: [ours, theirs],
      author: options.author,
      committer: options.committer ?? options.author,
      message: options.message,
    });
    // Same ordering as the fast-forward above, for the same reason.
    this.advanceHead(head, ours, id, "merge", `Merged ${revision} as ${id.slice(0, 12)}.`, now);
    this.writeIndex(materializeTree(this.objects, this.root, tree, CONTROL_DIRECTORY, this.ignoreRules()));
    return { kind: "merged", head: id, bases, merged, conflicts, clean: conflicts.length === 0 };
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
  private virtualBaseTree(bases: readonly ObjectId[]): ObjectId {
    let tree = readCommit(this.objects, bases[0]).tree;
    for (const other of bases.slice(1)) {
      const otherTree = readCommit(this.objects, other).tree;
      const nested = mergeBases(this.objects, bases[0], other);
      const nestedBase = nested.length > 0 ? readCommit(this.objects, nested[0]).tree : null;
      // Conflicts between two bases are resolved by keeping the first base's
      // side. A virtual base is a heuristic, not a snapshot anyone committed, and
      // recording markers in it would push them into the real merge's output.
      const { files } = this.mergeTrees(nestedBase, tree, otherTree);
      tree = buildTree(this.objects, files);
    }
    return tree;
  }

  /**
   * Three-way merges two trees against a base tree.
   *
   * A path only one side changed takes that side without any content being read.
   * A path both sides changed is merged by content — per field when both sides
   * are record objects, by diff3 otherwise.
   *
   * @param baseTree - The base tree, or null when there is no common ancestor.
   * @param ourTree - Our side's tree.
   * @param theirTree - Their side's tree.
   * @param labels - Names written into conflict markers.
   * @returns The merged path map, which paths merged, and which conflicted.
   */
  private mergeTrees(
    baseTree: ObjectId | null,
    ourTree: ObjectId,
    theirTree: ObjectId,
    labels?: ConflictLabels,
  ): {
    files: Map<string, { id: ObjectId; mode: FileMode }>;
    merged: string[];
    conflicts: MergeConflict[];
  } {
    const base = flattenTree(this.objects, baseTree);
    const ours = flattenTree(this.objects, ourTree);
    const theirs = flattenTree(this.objects, theirTree);
    const files = new Map<string, { id: ObjectId; mode: FileMode }>();
    const merged: string[] = [];
    const conflicts: MergeConflict[] = [];

    for (const path of [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort(compareByteOrder)) {
      const baseEntry = base.get(path);
      const ourEntry = ours.get(path);
      const theirEntry = theirs.get(path);
      const ourChanged = (ourEntry?.id ?? null) !== (baseEntry?.id ?? null)
        || (ourEntry?.mode ?? null) !== (baseEntry?.mode ?? null);
      const theirChanged = (theirEntry?.id ?? null) !== (baseEntry?.id ?? null)
        || (theirEntry?.mode ?? null) !== (baseEntry?.mode ?? null);

      if (!theirChanged) {
        if (ourEntry) files.set(path, ourEntry);
        continue;
      }
      if (!ourChanged) {
        if (theirEntry) files.set(path, theirEntry);
        continue;
      }
      if (ourEntry?.id === theirEntry?.id && ourEntry?.mode === theirEntry?.mode) {
        if (ourEntry) files.set(path, ourEntry);
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
      const resolution = this.mergePath(path, baseEntry?.id ?? null, ourEntry.id, theirEntry.id, labels);
      files.set(path, { id: resolution.id, mode: ourEntry.mode });
      if (resolution.conflict) conflicts.push(resolution.conflict);
      else merged.push(path);
    }
    return { files, merged, conflicts };
  }

  /**
   * Merges one path's three blobs.
   *
   * Record objects take the per-field path; everything else takes diff3. The
   * distinction is made on the stored object's type rather than on the path's
   * extension, so what a file is called never decides how it merges.
   *
   * @param path - The path being merged, for conflict reporting.
   * @param baseId - Base blob, or null when the path was added on both sides.
   * @param ourId - Our blob.
   * @param theirId - Their blob.
   * @param labels - Names written into conflict markers.
   * @returns The merged blob's id and any conflict.
   */
  private mergePath(
    path: string,
    baseId: ObjectId | null,
    ourId: ObjectId,
    theirId: ObjectId,
    labels?: ConflictLabels,
  ): { id: ObjectId; conflict?: MergeConflict } {
    const ourObject = this.objects.read(ourId);
    const theirObject = this.objects.read(theirId);
    if (ourObject.type === "record" && theirObject.type === "record") {
      const baseDocument: RecordDocument = baseId === null ? {} : decodeRecord(this.objects.readTyped(baseId, "record"));
      const result = mergeRecords(
        baseDocument,
        decodeRecord(ourObject.payload),
        decodeRecord(theirObject.payload),
        this.config.recordPolicy,
      );
      return {
        id: this.objects.write("record", encodeRecord(result.document)),
        conflict: result.clean
          ? undefined
          : { path, reason: "record", fields: result.conflicts.map((conflict) => conflict.field) },
      };
    }
    const result: ContentMergeResult = mergeContent(
      baseId === null ? "" : this.objects.readTyped(baseId, "blob").toString("utf8"),
      ourObject.payload.toString("utf8"),
      theirObject.payload.toString("utf8"),
      labels,
    );
    return {
      id: this.objects.write("blob", Buffer.from(result.text, "utf8")),
      conflict: result.clean ? undefined : { path, reason: "content" },
    };
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
    const operation = this.operations.undo(this.refs, sequence, now);
    const head = this.refs.resolveHead();
    this.writeIndex(materializeTree(
      this.objects,
      this.root,
      head === null ? null : readCommit(this.objects, head).tree,
      CONTROL_DIRECTORY,
      this.ignoreRules(),
    ));
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

}


