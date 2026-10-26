import { configureDestruction, retireNamespace, withDestructionScope, destructionBoundary, DestructionRefusal, type DestructionReceipt } from "./destruction.ts";
import { randomBytes } from "node:crypto";
import { objectFiles } from "./object-files.ts";
/** Platform-aware durability policy shared by native publication and retirement. */
import fs, { type RmOptions } from "node:fs";
import { dirname } from "node:path";

/** Forced capability seam for real-filesystem portability tests. @internal */
export const durabilityCapabilities = { directorySync: process.platform !== "win32" };

/** Flush data before atomic publication; POSIX also flushes directory entries, Windows uses synchronous namespace acknowledgment. */
export const durability = {
  /** Flush an already opened regular file on every supported operating system. */
  file(fd: number): void { fs.fsyncSync(fd); },
  /** Flush namespace metadata on POSIX; Windows has no Node directory-fsync operation and uses acknowledged synchronous mutations. */
  directory(path: string, _required = true, platform?: NodeJS.Platform): void {
    if (!(platform === undefined ? durabilityCapabilities.directorySync : platform !== "win32")) return;
    const file = objectFiles.open(path, "r");
    try { durability.file(file.fd); } finally { file.close(); }
  },
  /** Flush the source file before replacing its name, then complete the platform namespace barriers. */
  rename(source: string, destination: string): DestructionReceipt {
    const file = objectFiles.open(source, "r+");
    try { durability.file(file.fd); } finally { file.close(); }
    return retireNamespace({ path: source, destination });
  },
  /** Publish an already flushed immutable file exclusively, preserving EEXIST for peer-result comparison. */
  link(source: string, destination: string): void {
    fs.linkSync(source, destination); durability.directory(dirname(destination));
  },
  /** Unlink one owned leaf and acknowledge the namespace change without a platform refusal after deletion. */
  unlink(path: string, expected?: fs.BigIntStats): DestructionReceipt { return retireNamespace({ path, expected }); },
  /** A completed owner unlink stays historical when a peer immediately acquires the same lock name. */
  unlinkOwner(path: string, expected: fs.BigIntStats): DestructionReceipt { return retireNamespace({ path, expected }, true); },
  /** Remove a caller-owned temporary tree, retaining native force and error semantics. */
  remove(path: string, options?: Pick<RmOptions, "recursive" | "force">): DestructionReceipt {
    if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["recursive", "force"].includes(key)) || [options.recursive, options.force].some(value => value !== undefined && typeof value !== "boolean"))) throw new DestructionRefusal("conflicting_destructive_requests", "Deletion accepts only explicit recursive and force booleans.");
    return retireNamespace({ path, recursive: options?.recursive });
  },
  /** Remove only an empty owned directory; ENOTEMPTY remains available to foreign-record preservation. */
  removeDirectory(path: string): DestructionReceipt { return retireNamespace({ path, directory: true }); },
  /** An unpublished process-owner record is bootstrap state: retire only its exclusive descriptor's original inode. */
  discardUnpublished(path: string, descriptor: number, original: fs.BigIntStats): { readonly released: boolean; readonly reason: "owned_bootstrap" | "foreign_owner" | "absent" } {
    const current = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (current === undefined) return { released: false, reason: "absent" };
    const held = fs.fstatSync(descriptor, { bigint: true });
    if (held.dev !== original.dev || held.ino !== original.ino || held.birthtimeNs !== original.birthtimeNs || current.dev !== held.dev || current.ino !== held.ino || current.birthtimeNs !== held.birthtimeNs) return { released: false, reason: "foreign_owner" };
    fs.unlinkSync(path); durability.directory(dirname(path)); return { released: true, reason: "owned_bootstrap" };
  },
  /** Close a raw lock descriptor last and retire only its original inode and bytes; peer owners are preserved. */
  release(path: string, descriptor: number, expected?: fs.BigIntStats): DestructionReceipt | { readonly released: false; readonly reason: "foreign_owner" | "absent" } {
    try {
      const owned = expected ?? fs.fstatSync(descriptor, { bigint: true }); const current = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (current === undefined) return { released: false, reason: "absent" };
      if (current.dev !== owned.dev || current.ino !== owned.ino || current.size !== owned.size || current.mtimeNs !== owned.mtimeNs) return { released: false, reason: "foreign_owner" };
      return durability.unlinkOwner(path, owned);
    } finally { fs.closeSync(descriptor); }
  },
  /** Preserve one explicit journal scope through nested synchronous writer callbacks. */
  scoped: withDestructionScope,

};

/** Compare complete native stamps before replacing any journal namespace entry. */
function unchanged(before: fs.BigIntStats | undefined, current: fs.BigIntStats | undefined): boolean { return before === undefined ? current === undefined : current !== undefined && current.dev === before.dev && current.ino === before.ino && current.size === before.size && current.mtimeNs === before.mtimeNs && current.ctimeNs === before.ctimeNs; }

/** Bootstrap intent records and their mutex receipts use these same platform-aware namespace barriers. */
configureDestruction({
  file: durability.file,
  write(path, bytes) {
    const previous = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (previous !== undefined && !previous.isFile()) throw new DestructionRefusal("foreign_destructive_intent", "A nonregular intent destination was preserved.");
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`; const file = objectFiles.open(temporary, "wx", 0o600); let owned: fs.BigIntStats;
    try { owned = fs.fstatSync(file.fd, { bigint: true }); destructionBoundary.visit("intent-temp-opened", temporary); fs.writeFileSync(file.fd, bytes); destructionBoundary.visit("intent-temp-written", temporary); durability.file(file.fd); owned = fs.fstatSync(file.fd, { bigint: true }); destructionBoundary.visit("intent-temp-flushed", temporary); } finally { file.close(); }
    try { const current = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (!unchanged(previous, current) || !unchanged(owned, fs.lstatSync(temporary, { bigint: true, throwIfNoEntry: false }))) throw new DestructionRefusal("destructive_intent_changed", "An intent destination changed before publication."); fs.renameSync(temporary, path); destructionBoundary.visit("intent-renamed", path); durability.directory(dirname(path)); destructionBoundary.visit("intent-directory-flushed", path); }
    finally { const current = fs.lstatSync(temporary, { bigint: true, throwIfNoEntry: false }); if (current !== undefined && current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(temporary); }
  },
  update(path, offset, bytes, validate) {
    const before = fs.lstatSync(path, { bigint: true }); if (!before.isFile()) throw new Error("Progress is not a regular file.");
    const file = objectFiles.open(path, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(file.fd, { bigint: true }); if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Progress identity changed.");
      validate(file.fd); fs.writeSync(file.fd, bytes, 0, bytes.length, offset); destructionBoundary.visit("progress-byte-written", path); durability.file(file.fd); destructionBoundary.visit("progress-byte-flushed", path);
      const current = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (current === undefined || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("Progress name changed.");
    } finally { file.close(); }
  },
  link: durability.link,
  unlink(path) { fs.unlinkSync(path); durability.directory(dirname(path)); },
  rmdir(path) { fs.rmdirSync(path); durability.directory(dirname(path)); },
  rename(source, destination) { fs.renameSync(source, destination); durability.directory(dirname(source)); if (dirname(source) !== dirname(destination)) durability.directory(dirname(destination)); },
});

export { inspectDestructions, DestructionRefusal, type DestructionInventory, type DestructionRefusalCode, type DestructionReceipt, type DestructionPlan } from "./destruction.ts";
