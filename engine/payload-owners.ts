/** Durable identity-only provenance for native FileId payload writes, including unpublished objects. */
import { objectFiles } from "./object-files.ts";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { durability } from "./durability.ts";
import { ObjectStoreError, type ObjectId } from "./objects.ts";

/** A native publication edge contains no recoverable content bytes. */
export interface PayloadOwner { readonly id: ObjectId; readonly fileId: string }

/** Classify the entire provenance namespace without following links or adopting nonempty foreign files. */
export function payloadOwners(control: string): PayloadOwner[] {
  const path = join(control, "payload-owners"); const original = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (original === undefined) return [];
  if (!original.isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Payload provenance must occupy a real directory.");
  const entries = readdirSync(path, { withFileTypes: true }); const result: PayloadOwner[] = [];
  for (const entry of entries) {
    const match = /^([0-9a-f]{64})\.([0-9a-f]{32})$/.exec(entry.name);
    if (match === null || !entry.isFile()) throw new ObjectStoreError("unsupported_erasure_storage", "Unknown payload provenance storage was preserved.");
    const address = join(path, entry.name); const file = objectFiles.open(address, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = fstatSync(file.fd, { bigint: true }); const named = lstatSync(address, { bigint: true });
      if (!held.isFile() || !named.isFile() || held.size !== 0n || named.size !== 0n || held.dev !== named.dev || held.ino !== named.ino || held.mtimeNs !== named.mtimeNs || held.ctimeNs !== named.ctimeNs) throw new ObjectStoreError("unsupported_erasure_storage", "Changed payload provenance was preserved.");
    } finally { file.close(); }
    result.push({ id: match[1], fileId: match[2] });
  }
  const current = lstatSync(path, { bigint: true });
  if (original.dev !== current.dev || original.ino !== current.ino || original.mtimeNs !== current.mtimeNs || original.ctimeNs !== current.ctimeNs || JSON.stringify(entries.map(entry => entry.name).sort()) !== JSON.stringify(readdirSync(path).sort())) throw new ObjectStoreError("unsupported_erasure_storage", "Payload provenance changed during classification.");
  return result;
}

/** Persist one native ownership edge before any payload bytes, under the caller's shared store lease. */
export function recordPayloadOwner(control: string, id: ObjectId, fileId: string): void {
  if (!/^[0-9a-f]{32}$/.test(fileId)) throw new ObjectStoreError("invalid_file_id", "Payload ownership requires a canonical FileId.");
  const directory = join(control, "payload-owners");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new ObjectStoreError("unsupported_erasure_storage", "Payload provenance cannot follow links.");
  const path = join(directory, `${id}.${fileId}`);
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size !== 0) throw new ObjectStoreError("unsupported_erasure_storage", "Foreign provenance bytes were preserved.");
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  }
  try {
    const held = fstatSync(fd); const current = lstatSync(path);
    if (!current.isFile() || held.dev !== current.dev || held.ino !== current.ino) throw new ObjectStoreError("unsupported_erasure_storage", "Payload ownership changed during publication.");
    durability.file(fd); durability.directory(directory);
  } finally { closeSync(fd); }
}
