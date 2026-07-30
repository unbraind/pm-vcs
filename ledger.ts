/**
 * The join between pm's ledger and git's.
 *
 * pm records who changed an item and when, in an append-only history stream.
 * Git records which commit changed which file, on which branch, by which author.
 * Nothing connects them, so two questions an agent asks constantly have no
 * answer:
 *
 * - *Which pm items does this commit range touch?* — what a PR description and
 *   release notes need, and what tells a reviewer which tracked work a branch
 *   actually represents.
 * - *Which commits changed this item?* — the inverse, which is how you find the
 *   code that a tracked decision produced.
 *
 * This module answers both from git alone. It stores nothing, so it introduces
 * no state that could itself become a merge conflict.
 */

import { type CommitRecord, readCommits } from "./git.ts";
import { isTrackerPath } from "./preview.ts";

/** How a commit range affected one item. */
export type ItemChangeKind =
  /** The item document first appeared in this range. */
  | "created"
  /** The item document changed but already existed before the range. */
  | "modified"
  /** The item document was removed in this range. */
  | "deleted";

/** One item a commit range touched. */
export interface RangeItem {
  /** Item id, derived from the document's filename. */
  readonly id: string;
  /** How the range affected it. */
  readonly kind: ItemChangeKind;
  /** Repository-relative POSIX path of the item document. */
  readonly path: string;
  /** Commits in the range that touched the item, newest first. */
  readonly commits: readonly RangeCommit[];
}

/** A commit that touched an item, reduced to what a changelog or PR body needs. */
export interface RangeCommit {
  /** Abbreviated object id. */
  readonly short: string;
  /** Author name. */
  readonly author: string;
  /** Author date in strict ISO 8601. */
  readonly date: string;
  /** First line of the commit message. */
  readonly subject: string;
}

/** Result of mapping a commit range onto items. */
export interface RangeReport {
  /** The revision range as given. */
  readonly range: string;
  /** Number of commits examined. */
  readonly commits: number;
  /** One entry per item, ordered by id. */
  readonly items: readonly RangeItem[];
  /** Counts by change kind, so a caller can branch without walking `items`. */
  readonly totals: {
    readonly created: number;
    readonly modified: number;
    readonly deleted: number;
  };
}

/** Inputs the range query needs, resolved by the caller from the command context. */
export interface RangeOptions {
  /** Revision range git accepts, for example `main..HEAD`. */
  readonly range: string;
  /** Absolute repository root. */
  readonly repoRoot: string;
  /** Tracker root as a repository-relative POSIX path (`""` when it is the root). */
  readonly trackerPrefix: string;
}

/**
 * Maps a revision range onto the pm items its commits created, modified or deleted.
 *
 * Only item *documents* are considered, not their history streams. A history
 * stream always changes alongside its document, so counting both would double
 * every entry, and the document is the artifact whose add/delete status carries
 * the item's lifecycle.
 *
 * @param options - Range plus the resolved repository and tracker roots.
 * @returns One entry per touched item, with the commits that touched it.
 * @throws VcsError When the range is not one git accepts.
 */
export function itemsInRange(options: RangeOptions): RangeReport {
  const { range, repoRoot, trackerPrefix } = options;
  const commits = readCommits([range], repoRoot);
  const byId = new Map<string, { path: string; kind: ItemChangeKind; commits: RangeCommit[] }>();

  // Git reports newest first. Walking oldest-first means the *earliest* change to
  // an item decides its kind, so an item added and then edited inside the range
  // reads as `created` rather than `modified`.
  for (const commit of [...commits].reverse()) {
    for (const change of commit.changes) {
      if (!isTrackerPath(change.path, trackerPrefix)) continue;
      const id = itemDocumentId(change.path, trackerPrefix);
      if (id === null) continue;
      const kind = changeKind(change.status);
      const existing = byId.get(id);
      if (existing === undefined) {
        byId.set(id, { path: change.path, kind, commits: [summarize(commit)] });
        continue;
      }
      existing.commits.push(summarize(commit));
      // A later deletion is the item's final state in the range and outranks the
      // kind an earlier commit set; any other later change leaves it alone.
      if (kind === "deleted") existing.kind = "deleted";
    }
  }

  const items: RangeItem[] = [...byId.entries()]
    .map(([id, entry]) => ({
      id,
      kind: entry.kind,
      path: entry.path,
      commits: [...entry.commits].reverse(),
    }))
    // Ordered by id so the output is stable across runs, which matters when it
    // feeds a PR body or release notes. Expressed arithmetically rather than with
    // a ternary on purpose: item ids carry a random token, so which arm of a
    // conditional comparator executes depends on the ids a run happens to
    // generate, and branch coverage of this line varied between runs while the
    // behaviour never did. Boolean-to-number subtraction yields the same total
    // order with no branch to cover.
    .sort((left, right) => Number(left.id > right.id) - Number(left.id < right.id));

  return {
    range,
    commits: commits.length,
    items,
    totals: {
      created: items.filter((item) => item.kind === "created").length,
      modified: items.filter((item) => item.kind === "modified").length,
      deleted: items.filter((item) => item.kind === "deleted").length,
    },
  };
}

/**
 * Extracts the item id from a path, if the path is an item document.
 *
 * Item documents are `<tracker>/<type-folder>/<id>.toon`: exactly one directory
 * level below the tracker root. That shape is what excludes `history/<id>.jsonl`
 * (a stream, counted through its document instead) and `settings.json` (not
 * item-scoped) without needing a list of type-folder names, which is schema
 * dependent and would go stale the moment a custom type is registered.
 *
 * @param path - Repository-relative POSIX path.
 * @param trackerPrefix - Tracker root relative to the repository root.
 * @returns The item id, or `null` when the path is not an item document.
 */
export function itemDocumentId(path: string, trackerPrefix: string): string | null {
  if (!path.endsWith(".toon")) return null;
  const relative = trackerPrefix === "" ? path : path.slice(trackerPrefix.length + 1);
  const segments = relative.split("/");
  if (segments.length !== 2) return null;
  const [folder, filename] = segments;
  if (folder === undefined || folder === "history" || filename === undefined) return null;
  const id = filename.slice(0, -".toon".length);
  return id === "" ? null : id;
}

/**
 * Maps a git status letter onto an item change kind.
 *
 * Renames and copies are reported as `created` for the destination path, which
 * is what the destination id's own history shows: before the commit, no item
 * document existed at that id.
 *
 * @param status - Git's status letter, possibly with a similarity score.
 * @returns The corresponding change kind.
 */
export function changeKind(status: string): ItemChangeKind {
  if (status.startsWith("A") || status.startsWith("R") || status.startsWith("C")) return "created";
  if (status.startsWith("D")) return "deleted";
  return "modified";
}

/**
 * Reduces a commit record to the fields a range report carries.
 *
 * @param commit - Full commit record from the git boundary.
 * @returns The changelog-shaped subset.
 */
function summarize(commit: CommitRecord): RangeCommit {
  return {
    short: commit.short,
    author: commit.author,
    date: commit.date,
    subject: commit.subject,
  };
}
