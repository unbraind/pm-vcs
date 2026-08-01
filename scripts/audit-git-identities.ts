/**
 * Audits every author and committer email present in the local Git object database.
 *
 * Reachable refs and unreachable commit objects are both inspected so a history
 * rewrite cannot appear complete while the old identity remains recoverable from
 * the repository. The command fails closed when Git cannot enumerate either set
 * or when any address is absent from the tracked public-address allowlist.
 *
 * @example
 * ```bash
 * node scripts/audit-git-identities.ts
 * ```
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

/** Runs Git and returns its standard output, refusing incomplete inventories. */
function runGit(arguments_: readonly string[], acceptedStatuses: readonly number[] = [0]): string {
  const result = spawnSync("git", arguments_, { cwd: repoRoot, encoding: "utf8" });
  if (result.status === null || !acceptedStatuses.includes(result.status)) {
    const detail = result.stderr.trim();
    throw new Error(`git ${arguments_.join(" ")} failed${detail.length > 0 ? `: ${detail}` : "."}`);
  }
  return result.stdout;
}

const addresses = new Set(
  runGit(["log", "--all", "--format=%ae%n%ce"])
    .split("\n")
    .filter((address) => address.length > 0),
);

const fsck = spawnSync("git", ["fsck", "--full", "--no-reflogs", "--unreachable"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (fsck.status === null || fsck.status > 1) {
  const detail = fsck.stderr.trim();
  throw new Error(`git fsck failed${detail.length > 0 ? `: ${detail}` : "."}`);
}
for (const line of `${fsck.stdout}\n${fsck.stderr}`.split("\n")) {
  const match = /^(?:unreachable|dangling) commit ([0-9a-f]+)$/.exec(line);
  if (!match) continue;
  for (const address of runGit(["show", "-s", "--format=%ae%n%ce", match[1]!]).split("\n")) {
    if (address.length > 0) addresses.add(address);
  }
}

const approved = new Set(
  readFileSync(resolve(repoRoot, ".github/approved-git-identities.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#")),
);
const rejected = [...addresses].filter((address) => !approved.has(address)).sort();
if (rejected.length > 0) {
  console.error(`git identity audit rejected ${rejected.length} non-public address(es).`);
  process.exit(1);
}
console.log(`git identity audit approved ${addresses.size} unique address(es).`);
