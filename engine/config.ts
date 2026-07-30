// Repository configuration.
//
// Two settings, and both are per-repository rather than per-command on purpose:
// which paths hold structured records, and how a record's fields merge. If either
// were a flag, two agents in one repository could stage the same file as
// different object kinds, or merge one field by two rules — and the resulting
// history would be internally inconsistent in a way no later command could
// detect, let alone repair.

import { readFileSync, writeFileSync } from "node:fs";

import { ObjectStoreError } from "./objects.ts";
import type { FieldStrategy, MergePolicy } from "./records.ts";

/** Settings that shape how a repository stores and merges content. */
export interface RepositoryConfig {
  /**
   * Glob patterns for paths whose content is a structured record.
   *
   * A matching path is stored as a `record` object and merged field by field;
   * everything else is a `blob` and merged by diff3. Declaring this rather than
   * sniffing content is deliberate: a JSON file that is genuinely a document
   * (a lockfile, a fixture) should keep line-merge semantics, and only the
   * repository's owner knows which is which.
   */
  readonly recordPaths: readonly string[];
  /** Per-field merge strategies applied to every record in the repository. */
  readonly recordPolicy: MergePolicy;
}

/** Configuration a repository starts with: no record paths, no field overrides. */
export const DEFAULT_CONFIG: RepositoryConfig = { recordPaths: [], recordPolicy: {} };

/**
 * Whether a canonical repository path matches a glob pattern.
 *
 * Supports `*` for any run of characters within one path segment, `**` for any
 * run across segments, and `?` for a single character within a segment.
 * Everything else is literal.
 *
 * Implemented by translating to a regular expression rather than by walking
 * segments, so the semantics are those of one anchored match instead of a set of
 * special cases that accumulate corners.
 *
 * @param path - Canonical slash-separated repository-relative path.
 * @param pattern - The glob to test against.
 * @returns True when the pattern matches the whole path.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  let expression = "";
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 2;
        // `a/**/b` should also match `a/b`, so an immediately following slash is
        // absorbed into the wildcard rather than required.
        if (pattern[index] === "/") index += 1;
        continue;
      }
      expression += "[^/]*";
      index += 1;
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      index += 1;
      continue;
    }
    expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`^${expression}$`).test(path);
}

/**
 * Whether a path should be stored as a record.
 *
 * @param path - Canonical repository-relative path.
 * @param config - The repository's configuration.
 * @returns True when any record pattern matches.
 */
export function isRecordPath(path: string, config: RepositoryConfig): boolean {
  return config.recordPaths.some((pattern) => matchesGlob(path, pattern));
}

/** Field strategies this build understands. */
const STRATEGIES: readonly FieldStrategy[] = ["scalar", "set", "sequence"];

/**
 * Parses configuration, rejecting anything it does not understand.
 *
 * Unknown strategies are refused rather than ignored. Silently falling back to
 * `scalar` for a field someone declared as a `set` would turn every concurrent
 * edit of that field into a conflict, and the config file would still read as
 * though it were in effect.
 *
 * @param raw - Parsed JSON from the config file.
 * @returns Validated configuration.
 * @throws ObjectStoreError When a field is of the wrong shape or names an unknown
 *   strategy.
 */
export function parseConfig(raw: unknown): RepositoryConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ObjectStoreError("bad_config", "Repository config is not a JSON object.");
  }
  const source = raw as Record<string, unknown>;
  const recordPaths = source.recordPaths ?? [];
  if (!Array.isArray(recordPaths) || recordPaths.some((entry) => typeof entry !== "string")) {
    throw new ObjectStoreError("bad_config", "Repository config recordPaths must be an array of strings.");
  }
  const policySource = source.recordPolicy ?? {};
  if (policySource === null || typeof policySource !== "object" || Array.isArray(policySource)) {
    throw new ObjectStoreError("bad_config", "Repository config recordPolicy must be an object.");
  }
  const policyRecord = policySource as Record<string, unknown>;
  const fieldsSource = policyRecord.fields ?? {};
  if (fieldsSource === null || typeof fieldsSource !== "object" || Array.isArray(fieldsSource)) {
    throw new ObjectStoreError("bad_config", "Repository config recordPolicy.fields must be an object.");
  }
  const fields: Record<string, FieldStrategy> = {};
  for (const [field, strategy] of Object.entries(fieldsSource as Record<string, unknown>)) {
    if (typeof strategy !== "string" || !(STRATEGIES as readonly string[]).includes(strategy)) {
      throw new ObjectStoreError(
        "bad_config",
        `Field "${field}" declares strategy "${String(strategy)}", which is not one of ${STRATEGIES.join(", ")}.`,
      );
    }
    fields[field] = strategy as FieldStrategy;
  }
  const fallback = policyRecord.fallback;
  if (fallback !== undefined && (typeof fallback !== "string" || !(STRATEGIES as readonly string[]).includes(fallback))) {
    throw new ObjectStoreError(
      "bad_config",
      `Fallback strategy "${String(fallback)}" is not one of ${STRATEGIES.join(", ")}.`,
    );
  }
  return {
    recordPaths: recordPaths as string[],
    recordPolicy: fallback === undefined
      ? { fields }
      : { fields, fallback: fallback as FieldStrategy },
  };
}

/**
 * Reads a repository's configuration.
 *
 * An absent file yields the defaults, so a repository created by an older build
 * stays readable.
 *
 * @param path - Config file path.
 * @returns The validated configuration.
 * @throws ObjectStoreError When the file exists but is not valid configuration.
 */
export function readConfig(path: string): RepositoryConfig {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return DEFAULT_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new ObjectStoreError("bad_config", `Repository config at ${path} is not valid JSON.`);
  }
  return parseConfig(parsed);
}

/**
 * Writes a repository's configuration.
 *
 * @param path - Config file path.
 * @param config - The configuration to store.
 */
export function writeConfig(path: string, config: RepositoryConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
