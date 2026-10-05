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

import { existsSync, readFileSync } from "node:fs";

import { relative, resolve } from "node:path";
import { getPmGitignoreBlock, getSettingsPath, resolveImplicitPmRoot, resolvePmRoot } from "@unbrained/pm-cli/sdk";

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

/** Ordered exclusion and re-inclusion patterns compiled from one repository ignore file. */
export interface IgnoreRules {
  /** Patterns from the project's ignore file, in file order. */
  readonly patterns: readonly string[];
  /** Patterns prefixed with `!`, which re-include a path an earlier pattern excluded. */
  readonly negations: readonly string[];
  /** SDK runtime fences, evaluated before project rules and never negatable. */
  readonly runtime?: readonly IgnoreRules[];
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
 * An *unreadable* file is a different matter and is re-raised. If the rules exist
 * but cannot be read — a permission denial, a directory where the file belongs —
 * returning an empty rule set would let `stage` add paths the project excluded and
 * let `materializeTree` write over them, silently, because both decide through
 * `isIgnored`. That is precisely the damage this module exists to prevent, so it
 * must fail loudly rather than degrade.
 *
 * @param root - Absolute repository root.
 * @param recordPaths - Record globs used to discover configured custom trackers.
 * @returns The compiled rules including non-negatable SDK runtime fences.
 * @throws Error The underlying I/O error, when an ignore file exists but cannot
 *   be read.
 */
export function readIgnoreRules(root: string, recordPaths: readonly string[] = []): IgnoreRules {
  const candidates = new Set([resolveImplicitPmRoot(root), resolvePmRoot(root)]);
  for (const pattern of recordPaths) {
    const prefix = pattern.split(/[*?[]/, 1)[0];
    let directory = resolve(root, prefix);
    // Record globs can start inside a type folder, so find the owning settings.
    while (directory !== resolve(root) && relative(root, directory) !== ".." && !relative(root, directory).startsWith("../")) {
      const tracker = resolvePmRoot(root, directory);
      if (existsSync(getSettingsPath(tracker))) { candidates.add(tracker); break; }
      directory = resolve(directory, "..");
    }
  }
  const runtime = [...candidates].flatMap((tracker) => {
    const path = relative(root, tracker).replaceAll("\\", "/");
    if (path === ".." || path.startsWith("../")) return [];
    const fence = parseIgnore(getPmGitignoreBlock(path || "."));
    // Git's trailing /* excludes matching directories and their descendants.
    return [{ ...fence, patterns: fence.patterns.map((pattern) => pattern.endsWith("/*") ? `${pattern}*` : pattern) }];
  });
  let rules: IgnoreRules;
  try {
    rules = parseIgnore(readFileSync(`${root}/${IGNORE_FILE}`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    rules = { patterns: [], negations: [] };
  }
  return { ...rules, runtime };
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
  if (isRuntimeIgnored(path, rules)) return true;
  for (const prefix of ALWAYS_IGNORED) {
    if (path === prefix || path.startsWith(`${prefix}/`) || path.includes(`/${prefix}/`)) return true;
  }
  return matchesPatterns(path, rules);
}

/** Match only one fence's patterns and exceptions, without the global ignored names. */
function matchesPatterns(path: string, rules: IgnoreRules): boolean {
  return rules.patterns.some((pattern) => matchesGlob(path, pattern))
    && !rules.negations.some((pattern) => matchesGlob(path, pattern));
}

/** Whether a path is excluded by an SDK runtime fence, independent of project rules. */
export function isRuntimeIgnored(path: string, rules: IgnoreRules): boolean {
  return rules.runtime?.some((fence) => matchesPatterns(path, fence)) ?? false;
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
