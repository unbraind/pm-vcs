/** Hash source tracker bytes without derived directories directly under the tracker root. */
import { createHash, type Hash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getActiveExtensionRegistrations, readSettings, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";

/** Frame every entry so paths, payloads, entry types and adjacent files cannot share hash input. */
function hashEntry(hash: Hash, type: "file" | "directory", path: string, content: Buffer): void {
  const name = Buffer.from(path, "utf8");
  hash.update(`${type}:${name.length}:`); hash.update(name);
  hash.update(`${content.length}:`); hash.update(content);
}

/** Preserve SDK item folders even under runtime roots, hashing only native item documents there. */
export async function trackerAdmissionDigest(pmRoot: string): Promise<string> {
  const settings = await readSettings(pmRoot);
  const folders = [...new Set(Object.values(resolveItemTypeRegistry(settings, getActiveExtensionRegistrations()).type_to_folder))].sort();
  /** Hash ordinary source directories recursively; special roots expose only owned source files. */
  function digest(path: string): Buffer {
    const hash = createHash("sha256");
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (path === pmRoot && entry.isDirectory() && ["runtime", "search", "locks", "extensions"].includes(entry.name)) {
        const files = new Set<string>();
        for (const folder of folders.filter(folder => folder === entry.name || folder.startsWith(`${entry.name}/`))) {
          if (!existsSync(join(pmRoot, folder))) continue;
          for (const item of readdirSync(join(pmRoot, folder), { withFileTypes: true })) {
            if (item.isFile() && /\.(toon|md)$/.test(item.name)) files.add(`${folder}/${item.name}`);
          }
        }
        const manifest = "extensions/.managed-extensions.json";
        if (entry.name === "extensions" && existsSync(join(pmRoot, manifest))) files.add(manifest);
        for (const file of [...files].sort()) hashEntry(hash, "file", file, readFileSync(join(pmRoot, file)));
        continue;
      }
      const child = join(path, entry.name);
      hashEntry(hash, entry.isDirectory() ? "directory" : "file", entry.name, entry.isDirectory() ? digest(child) : readFileSync(child));
    }
    return hash.digest();
  }
  return digest(pmRoot).toString("hex");
}
