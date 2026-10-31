/** Reader adapters shared by resource invariants; values remain actual filesystem-backed SDK objects. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { ObjectStore } from "../../engine/objects.ts";
import { PackStorage } from "../../engine/packs.ts";
import { SharedObjectStore } from "../../engine/instances.ts";
import { objectPayloadChunks } from "../../engine/object-stream.ts";
import { objectFiles } from "../../engine/object-files.ts";

/** Complete classified reader surface, including synchronous iterators and backend overrides. */
export const lifetimeReaders: Readonly<Record<string, (store: ObjectStore, id: string) => unknown>> = {
  has: (s,id) => s.has(id),
  read: (s,id) => s.read(id),
  readIfType: (s,id) => s.readIfType(id,"blob"),
  hasType: (s,id) => s.hasType(id,"blob"),
  readBoundedTyped: (s,id) => s.readBoundedTyped(id,"blob"),
  readLines: (s,id) => s.readLines(id,"blob"),
  readChunks: (s,id) => s.readChunks(id,"blob"),
  readTyped: (s,id) => s.readTyped(id,"blob"),
  state: (s,id) => s.state(id),
  hydrate: (s,id) => s.hydrate(id),
  inventory: (s) => s.inventory(),
  walkInventory: (s) => s.walkInventory(),
  walkLooseInventory: (s) => s.walkLooseInventory(),
  walkPackedInventory: (s) => s.walkPackedInventory(),
  readInventoryObject: (s,id) => s.readInventoryObject(id,join(s.storageRoot(),id.slice(0,2),id.slice(2))),
  "PackStorage.has": (s,id) => new PackStorage(s.storageRoot()).has(id),
  "PackStorage.type": (s,id) => new PackStorage(s.storageRoot()).type(id),
  "PackStorage.read": (s,id) => new PackStorage(s.storageRoot()).read(id),
  "PackStorage.readAt": (s,id) => new PackStorage(s.storageRoot()).readAt(id,join(s.storageRoot(),id.slice(0,2),id.slice(2))),
  "PackStorage.inventory": (s) => new PackStorage(s.storageRoot()).inventory(),
  "SharedObjectStore.read": (s,id) => new SharedObjectStore(s.storageRoot()).read(id),
  "SharedObjectStore.readBoundedTyped": (s,id) => new SharedObjectStore(s.storageRoot()).readBoundedTyped(id,"blob"),
  "SharedObjectStore.readLines": (s,id) => new SharedObjectStore(s.storageRoot()).readLines(id,"blob"),
  "SharedObjectStore.readChunks": (s,id) => new SharedObjectStore(s.storageRoot()).readChunks(id,"blob"),
  objectPayloadChunks: (s,id) => objectPayloadChunks(join(s.storageRoot(),id.slice(0,2),id.slice(2)),id,"blob"),
};
/** Exit modes include cancellation after a yielded chunk and cancellation after acquiring a descriptor. */
export type ExitMode = "complete" | "early" | "error" | "abort";
/** Recognize only actual iterators; eager buffer and inventory-array results are already settled. */
export function iterator(value: unknown): value is Generator<unknown,unknown,unknown> {
  return typeof value === "object" && value !== null && "next" in value;
}
/** Exercise one operation without yielding to the event loop; scalar operations have no consumer-stop boundary. */
export function exercise(read: () => unknown, mode: ExitMode): { injected: number; iterated: boolean } {
  let injected = 0; let iterated = false;
  const error = Object.assign(new Error("injected read failure"), { code: "EIO" });
  const abort = Object.assign(new Error("consumer aborted"), { name: "AbortError", code: "ABORT_ERR" });
  if (mode === "error" || mode === "abort") objectFiles.opened = () => { injected++; throw mode === "error" ? error : abort; };
  try {
    const value = read();
    if (iterator(value)) {
      iterated = true;
      if (mode === "early") { for (const _ of value) { if (mode === "early") break; } }
      else for (const _ of value) { /* complete real verification */ }
    }
  } catch (fault) { assert.ok(injected > 0 && (fault === error || fault === abort)); }
  finally { objectFiles.opened = () => {}; }
  return { injected, iterated };
}
