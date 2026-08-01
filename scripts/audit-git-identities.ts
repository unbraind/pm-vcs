/**
 * Audits every author and committer email in the physical Git object database.
 *
 * `cat-file --batch-all-objects` enumerates reachable and unreachable commits,
 * including ancestors hidden behind dangling tips. Replacement refs are disabled
 * for every subprocess so the audit reads raw objects rather than their overlays.
 * One batch process then returns every commit body, avoiding a process per object.
 *
 * @example
 * ```bash
 * node scripts/audit-git-identities.ts
 * ```
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultRepoRoot = resolve(import.meta.dirname, "..");
const gitOutputLimit = 256 * 1024 * 1024;
const gitEnvironment = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };

/** Runs Git and returns text output, refusing partial or replaced inventories. */
function runGit(root: string, arguments_: readonly string[]): string {
  const result = spawnSync("git", ["--no-replace-objects", ...arguments_], {
    cwd: root,
    encoding: "utf8",
    env: gitEnvironment,
    maxBuffer: gitOutputLimit,
  });
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? "";
    throw new Error(`git ${arguments_.join(" ")} failed${detail.length > 0 ? `: ${detail}` : "."}`);
  }
  return result.stdout ?? "";
}

/** Returns raw batch output for a newline-delimited set of object ids. */
function readCommitBatch(root: string, objectIds: readonly string[]): Buffer {
  const result = spawnSync("git", ["--no-replace-objects", "cat-file", "--batch"], {
    cwd: root,
    input: `${objectIds.join("\n")}\n`,
    env: gitEnvironment,
    maxBuffer: gitOutputLimit,
  });
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString("utf8").trim() ?? "";
    throw new Error(`git cat-file --batch failed${detail.length > 0 ? `: ${detail}` : "."}`);
  }
  return result.stdout;
}

/**
 * Inventories raw commit metadata from every physical commit object.
 *
 * @param root - Git repository whose object database is audited.
 * @returns Unique author and committer email addresses.
 */
export function collectGitIdentities(root: string): Set<string> {
  const objectIds = runGit(root, [
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype)",
  ])
    .split("\n")
    .flatMap((line) => {
      const match = /^([0-9a-f]+) commit$/.exec(line);
      return match ? [match[1]!] : [];
    });
  if (objectIds.length === 0) return new Set();
  const batch = readCommitBatch(root, objectIds);
  const addresses = new Set<string>();
  let offset = 0;
  for (const expectedId of objectIds) {
    const headerEnd = batch.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error("git cat-file returned a truncated batch header.");
    const header = batch.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]+) commit (\d+)$/.exec(header);
    if (!match || match[1] !== expectedId) throw new Error(`git cat-file returned an invalid header for ${expectedId}.`);
    const size = Number.parseInt(match[2]!, 10);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (!Number.isSafeInteger(size) || contentEnd >= batch.length) {
      throw new Error(`git cat-file returned truncated content for ${expectedId}.`);
    }
    const commit = batch.subarray(contentStart, contentEnd).toString("utf8");
    for (const field of ["author", "committer"] as const) {
      const identity = new RegExp(`^${field} .*<([^<>\\n]+)> \\d+ [+-]\\d+$`, "m").exec(commit);
      if (!identity) throw new Error(`Commit ${expectedId} has no well-formed ${field} identity.`);
      addresses.add(identity[1]!);
    }
    if (batch[contentEnd] !== 0x0a) throw new Error(`git cat-file omitted the separator for ${expectedId}.`);
    offset = contentEnd + 1;
  }
  if (offset !== batch.length) throw new Error("git cat-file returned unrequested trailing data.");
  return addresses;
}

/**
 * Refuses identities absent from a public-address allowlist.
 *
 * @param root - Git repository to audit.
 * @param allowlistPath - Text file containing one approved address per line.
 */
export function auditGitIdentities(root: string, allowlistPath: string): void {
  const approved = new Set(
    readFileSync(allowlistPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
  const addresses = collectGitIdentities(root);
  const rejected = [...addresses].filter((address) => !approved.has(address));
  if (rejected.length > 0) throw new Error(`git identity audit rejected ${rejected.length} non-public address(es).`);
  console.log(`git identity audit approved ${addresses.size} unique address(es).`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    auditGitIdentities(defaultRepoRoot, resolve(defaultRepoRoot, ".github/approved-git-identities.txt"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "git identity audit failed.");
    process.exitCode = 1;
  }
}
