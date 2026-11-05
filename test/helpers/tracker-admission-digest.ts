/** Hash source tracker bytes without derived directories directly under the tracker root. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Keep nested custom item folders even when their names match root runtime directories. */
export function trackerAdmissionDigest(pmRoot: string, path = pmRoot): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (path === pmRoot && entry.isDirectory() && ["runtime", "search", "locks", "extensions"].includes(entry.name)) continue;
    hash.update(entry.name); hash.update(entry.isDirectory() ? trackerAdmissionDigest(pmRoot, join(path, entry.name)) : readFileSync(join(path, entry.name)));
  }
  return hash.digest("hex");
}
