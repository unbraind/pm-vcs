/** Deterministic ownership for every descriptor opened by object storage and durability. */
import fs from "node:fs";

/** A transferred file must be closed by its consumer in the same synchronous scope or iterator finally. @internal */
export interface ObjectFile {
  readonly fd: number;
  /** Close once, synchronously; a second cleanup cannot close a subsequently reused descriptor. */
  close(): void;
}

/** Registered ownership and fault seam for resource-lifetime invariant tests. @internal */
export const objectFiles = {
  active: new Set<ObjectFile>(),
  /** Synchronous publication may reuse only a live, descriptor-verified store owner; journal scope is not ownership. */
  storageOwners: new Map<string, () => boolean>(),
  /** Verified closures belong to one live writer, never another acquisition of the same path. */
  publicationClosures: new Map<string, { owner: () => boolean; roots: ReadonlySet<string>; policy: string }>(),
  /** Open and register before exposing the descriptor; even a failing registration observer releases it. */
  open(path: string, flags: string | number, mode?: number): ObjectFile {
    const fd = fs.openSync(path, flags, mode);
    let closed = false;
    const file: ObjectFile = { fd,
      /** Retire ownership before the native close, preventing double closure on error paths. */
      close() { if (closed) return; closed = true; objectFiles.active.delete(file); fs.closeSync(fd); },
    };
    objectFiles.active.add(file);
    try { objectFiles.opened(file, path); return file; } catch (error) { file.close(); throw error; }
  },
  /** Observe only registered, owned descriptors; production does not install an observer. */
  opened(_file: ObjectFile, _path: string): void {},
};
