// What the working tree is not.
//
// A working tree is not "the files in this directory". Without that distinction
// a repository created inside an existing checkout stages the other system's
// control directory, and the next switch materializes a tree over it — which is
// a working tree destroyed by a command whose whole job was to restore one.
//
// Two layers, and the split matters. `.pmvcsignore` is the project's list and can
// be edited or emptied. The always-ignored set cannot: it names directories whose
// contents are another tool's internal state, and no project has a legitimate
// reason to ask this system to own them.

import { readFileSync } from "node:fs";

import { matchesGlob } from "./config.ts";

/**
 * Path prefixes that are never tracked, whatever the project asks for.
 *
 * Every entry is the private state of a tool that will be running concurrently
 * with this one. `node_modules` is here for a different reason — it is
 * reconstructible from a lockfile and large enough that staging it by accident
 * is its own failure — but the effect is the same.
 */
export const ALWAYS_IGNORED = [".git", ".hg", ".svn", ".bzr", "_darcs", "CVS", "node_modules"] as const;

/** Name of the per-project ignore file, read from the repository root. */
export const IGNORE_FILE = ".pmvcsignore";

/** A compiled set of ignore rules. */
export interface IgnoreRules {
  /** Patterns from the project's ignore file, in file order. */
  readonly patterns: readonly string[];
  /** Patterns prefixed with `!`, which re-include a path an earlier pattern excluded. */
  readonly negations: readonly string[];
}

/**
 * Parses ignore-file text into rules.
 *
 * Blank lines and `#` comments are skipped. A pattern ending in `/` matches a
 * directory and everything under it. A pattern with no `/` at all matches by
 * basename at any depth, which is what makes `*.log` behave the way everyone
 * expects rather than only matching at the root.
 *
 * @param text - The ignore file's contents.
 * @returns The compiled rules.
 */
export function parseIgnore(text: string): IgnoreRules {
  const patterns: string[] = [];
  const negations: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const body = negated ? line.slice(1) : line;
    if (body.length === 0) continue;
    // Normalise to a form `matchesGlob` can answer with one anchored match.
    const expanded = body.endsWith("/")
      ? `${body}**`
      : body.includes("/") ? body : `**/${body}`;
    (negated ? negations : patterns).push(expanded.replace(/^\.\//, ""));
  }
  return { patterns, negations };
}

/**
 * Reads the repository's ignore file.
 *
 * An absent file is not an error: most repositories do not need one, and the
 * always-ignored set already covers the cases that would cause damage.
 *
 * @param root - Absolute repository root.
 * @returns The compiled rules, empty when there is no ignore file.
 */
export function readIgnoreRules(root: string): IgnoreRules {
  try {
    return parseIgnore(readFileSync(`${root}/${IGNORE_FILE}`, "utf8"));
  } catch {
    return { patterns: [], negations: [] };
  }
}

/**
 * Whether a path is excluded from tracking.
 *
 * The always-ignored set is checked first and cannot be negated. A project that
 * could `!.git` its way back into staging git's object store would be able to
 * reintroduce exactly the failure this module exists to prevent.
 *
 * @param path - Canonical slash-separated repository-relative path.
 * @param rules - The project's compiled rules.
 * @returns True when the path must not be tracked.
 */
export function isIgnored(path: string, rules: IgnoreRules): boolean {
  for (const prefix of ALWAYS_IGNORED) {
    if (path === prefix || path.startsWith(`${prefix}/`) || path.includes(`/${prefix}/`)) return true;
  }
  if (!rules.patterns.some((pattern) => matchesGlob(path, pattern))) return false;
  return !rules.negations.some((pattern) => matchesGlob(path, pattern));
}

/**
 * Whether a directory can be skipped entirely during a working-tree walk.
 *
 * Only the always-ignored names qualify. A project pattern can be negated by a
 * later rule, so pruning on one would hide a path the rules ultimately
 * re-include; these names cannot be negated, so pruning them is safe and turns
 * `node_modules` from the slowest part of a walk into no part of it.
 *
 * @param name - A single directory name, not a path.
 * @returns True when the walk should not descend into it.
 */
export function isPrunableDirectory(name: string): boolean {
  return (ALWAYS_IGNORED as readonly string[]).includes(name);
}
