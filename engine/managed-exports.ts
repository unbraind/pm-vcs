/** Explicit local ownership for CLI-written native archives; caller-owned transport buffers are outside this registry. */
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseBundle } from "./bundle.ts";
import { writePrivateJson } from "./composition.ts";
import { hashObject, isObjectId, ObjectStoreError, readControlJson, type ObjectId } from "./objects.ts";
import { WorktreeMutation } from "./worktree-mutation.ts";
import type { Repository } from "./repo.ts";

/** One exact artifact with its native object inventory and byte ownership fence. */
export interface ManagedExport { readonly path: string; readonly id: ObjectId; readonly sha256: string; readonly objects: readonly ObjectId[] }

/** Read only the exact native registry shape; unknown metadata never grants deletion authority. */
export function managedExports(control: string, name = "exports.json"): ManagedExport[] {
  const raw = readControlJson(join(control, name), "unsupported_erasure_storage", "managed exports", []);
  if (!Array.isArray(raw)) throw new ObjectStoreError("unsupported_erasure_storage", "Unknown export ownership metadata.");
  const paths = new Set<string>();
  for (const value of raw as ManagedExport[]) {
    if (value === null || typeof value !== "object" || Object.keys(value).sort().join(",") !== "id,objects,path,sha256"
      || typeof value.path !== "string" || value.path.length === 0 || value.path.split("/").some(part => ["", ".", "..", ".pmvcs", ".git"].includes(part)) || value.path.includes("\\") || value.path.includes(":") || value.path.startsWith("/")
      || typeof value.id !== "string" || !isObjectId(value.id) || !isObjectId(value.sha256) || !Array.isArray(value.objects) || !value.objects.every(id => typeof id === "string" && isObjectId(id)) || paths.has(value.path)) {
      throw new ObjectStoreError("unsupported_erasure_storage", "Unknown export ownership metadata.");
    }
    paths.add(value.path);
  }
  return raw as ManagedExport[];
}

/** Register before writing so interruption cannot leave an unaccounted local archive; never follow repository links. */
export function writeBundleFile(repository: Repository, destination: string, produce: () => Buffer, sources?: () => readonly ObjectId[], exclusive = false): number {
  return repository.objects.withWriteLock(() => {
    const bytes = produce();
    const path = relative(repository.root, resolve(destination)).split(sep).join("/");
    if (path.startsWith("../") || path === "..") { writeFileSync(destination, bytes, exclusive ? { flag: "wx", mode: 0o600 } : undefined); return bytes.length; }
    const exports = managedExports(repository.controlDirectory);
    const mutation = new WorktreeMutation(repository.root, ".pmvcs", repository.objects);
    try {
      const old = exports.find(entry => entry.path === path);
      if (existsSync(destination) && old === undefined) throw new ObjectStoreError("export_path_owned", "Choose a new export path; existing user files are not managed exports.");
      if (exclusive && existsSync(destination)) throw new ObjectStoreError("export_path_owned", "Choose a new export path; existing files are never overwritten.");
      const objects = sources === undefined ? parseBundle(bytes).header.objects : sources();
      if (!objects.every(id => isObjectId(id))) throw new ObjectStoreError("unsupported_erasure_storage", "Native export sources must be object identities.");
      const record = { path, id: hashObject("blob", bytes), sha256: createHash("sha256").update(bytes).digest("hex"), objects };
      // Validate the path with the same pinned writer that will publish it.
      const current = mutation.inspectForErasure(path);
      if (old !== undefined && current !== undefined && createHash("sha256").update(current.content).digest("hex") !== old.sha256) throw new ObjectStoreError("worktree_path_changed", "A managed export was replaced; foreign bytes were preserved.");
      if (path.split("/").some(part => ["", ".", "..", ".pmvcs", ".git"].includes(part)) || path.includes("\\") || path.includes(":")) throw new ObjectStoreError("export_path_owned", "Use an ordinary repository-local export path.");
      writePrivateJson(join(repository.controlDirectory, "exports.json"), [...exports.filter(entry => entry.path !== path), record]);
      mutation.write(path, bytes, 0o600, { objects: objects.length === 0 ? [record.id] : objects });
      return bytes.length;
    } finally { mutation.close(); }
  });
}
