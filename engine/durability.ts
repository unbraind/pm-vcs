import { configureDestruction, retireNamespace, withDestructionScope, resolveNamespacePath, destructionBoundary, DestructionRefusal, type DestructionReceipt } from "./destruction.ts";
import { ObjectStoreError } from "./object-error.ts";
import { createHash, randomBytes } from "node:crypto";
import { objectFiles } from "./object-files.ts";
/** Platform-aware durability policy shared by native publication and retirement. */
import fs, { type RmOptions } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Forced capability seam for real-filesystem portability tests. @internal */
export const durabilityCapabilities = { directorySync: process.platform !== "win32" };

interface ProcessLease { readonly descriptor: number; readonly owner: fs.BigIntStats; verify(): void; release(): void }
const knownProcessOwners = new Map<string, { owner: string; identity: string }>();
const activeProcessOwners = new Map<string, string>();
/** Birth identity binds a process marker to an inode lifetime without persisting machine paths. */
function processBirth(stat: fs.BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }
/** Complete mutable stamps fence byte changes and reattached names while a process lease is active. */
function processStamp(stat: fs.BigIntStats): string { return `${processBirth(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }

/** Flush data before atomic publication; POSIX also flushes directory entries, Windows uses synchronous namespace acknowledgment. */
export const durability = {
  /** Publish one descriptor-owned process lease; known dead owners recover, foreign markers remain untouched. */
  claim: claimProcessLease,
  /** Flush an already opened regular file on every supported operating system. */
  file(fd: number): void { fs.fsyncSync(fd); },
  /** Flush namespace metadata and its complete ancestry on POSIX; Windows uses acknowledged synchronous mutations. */
  directory(path: string, _required = true, platform?: NodeJS.Platform): void {
    if (!(platform === undefined ? durabilityCapabilities.directorySync : platform !== "win32")) return;
    let directory = fs.realpathSync(path);
    for (;;) {
      const file = objectFiles.open(directory, "r");
      try { durability.file(file.fd); } finally { file.close(); }
      const parent = dirname(directory); if (parent === directory) break; directory = parent;
    }
  },
  /** Persist a newly written bootstrap/control file before publishing dependent metadata or releasing its owner. */
  persist(path: string): void {
    path = resolve(path); const file = objectFiles.open(path, "r+");
    try { durability.file(file.fd); } finally { file.close(); }
    durability.directory(dirname(path));
  },
  /** Flush the source file before replacing its name, then complete the platform namespace barriers. */
  rename(source: string, destination: string): DestructionReceipt {
    source = resolve(source); destination = resolve(destination);
    const file = objectFiles.open(source, "r+"); let expected: fs.BigIntStats;
    try { expected = fs.fstatSync(file.fd, { bigint: true }); durability.file(file.fd); } finally { file.close(); }
    return retireNamespace({ path: source, destination, expected });
  },
  /** Publish an already flushed immutable file exclusively, preserving EEXIST for peer-result comparison. */
  link(source: string, destination: string): void {
    source = resolve(source); destination = resolve(destination);
    durability.directory(dirname(source)); durability.directory(dirname(destination));
    const file = objectFiles.open(source, "r+");
    try {
      durability.file(file.fd); fs.linkSync(source, destination); durability.file(file.fd);
      const held = fs.fstatSync(file.fd, { bigint: true }); const linked = fs.lstatSync(destination, { bigint: true });
      if (processBirth(held) !== processBirth(linked) || held.size !== linked.size || held.mtimeNs !== linked.mtimeNs) throw new ObjectStoreError("worktree_path_changed", "An exclusive publication source changed; its foreign result was preserved.");
    } finally { file.close(); }
    durability.directory(dirname(destination));
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
  release(path: string, descriptor: number, expected?: fs.BigIntStats, close?: () => void): DestructionReceipt | { readonly released: false; readonly reason: "foreign_owner" | "absent" } {
    try {
      const owned = expected ?? fs.fstatSync(descriptor, { bigint: true }); const current = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (current === undefined) return { released: false, reason: "absent" };
      if (current.dev !== owned.dev || current.ino !== owned.ino || current.size !== owned.size || current.mtimeNs !== owned.mtimeNs) return { released: false, reason: "foreign_owner" };
      return durability.unlinkOwner(path, owned);
    } finally { if (close === undefined) fs.closeSync(descriptor); else close(); }
  },
  /** Preserve one explicit journal scope through nested synchronous writer callbacks. */
  scoped: withDestructionScope,

};

/** Synchronous filesystem leases use staged, flushed markers instead of unrecoverable empty lock files. */
function claimProcessLease(address: string, code: string): ProcessLease {
  address = resolve(address); let path = resolveNamespacePath(address); fs.mkdirSync(dirname(path), { recursive: true });
  path = join(fs.realpathSync(dirname(path)), basename(path));
  const existing = fs.lstatSync(path, { throwIfNoEntry: false }); if (existing?.isFile()) path = fs.realpathSync(path);
  const parent = processBirth(fs.lstatSync(dirname(path), { bigint: true })); const token = randomBytes(16).toString("hex");
  const temporary = join(dirname(path), `owner-${createHash("sha256").update(basename(path)).digest("hex").slice(0, 24)}-${process.pid}-${randomBytes(6).toString("hex")}.lock`);
  const file = objectFiles.open(temporary, "wx", 0o600); let original: fs.BigIntStats | undefined; let acquired = false; let transferred = false;
  /** Fail with a stable caller discriminator and an explicit safe recovery instruction. */
  const refuse = (detail: string): never => { throw new ObjectStoreError(code, `${detail} Wait for live owners; known dead process markers recover on retry. Inspect foreign markers before manual removal.`); };
  /** Remove only our own marker inode; a peer's replacement is never cleanup authority. */
  const cleanup = (target: string): void => { const current = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false }); if (current !== undefined && processBirth(current) === processBirth(fs.fstatSync(file.fd, { bigint: true }))) durability.unlinkOwner(target, current); };
  try {
    original = fs.fstatSync(file.fd, { bigint: true });
    fs.writeFileSync(file.fd, JSON.stringify({ format: "pm-vcs-process-lease-1", pid: process.pid, identity: processBirth(original), parent, name: basename(path), owner: token })); durability.file(file.fd);
    for (let attempt = 0; attempt < 8; attempt++) {
      try { durability.link(temporary, path); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const observed = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (observed === undefined) continue;
        if (!observed.isFile() || observed.size > 4096n) refuse("A foreign native lock was preserved.");
        let record: { format?: string; pid?: number; identity?: string; parent?: string; name?: string; owner?: string };
        const pinned = objectFiles.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const held = fs.fstatSync(pinned.fd, { bigint: true }); let parsed: unknown;
          try { parsed = JSON.parse(fs.readFileSync(pinned.fd, "utf8")); } catch { refuse("An unknown native lock was preserved."); }
          if (parsed === null || typeof parsed !== "object") refuse("An unknown native lock was preserved."); record = parsed as typeof record;
          const current = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
          if (current === undefined || processStamp(current) !== processStamp(observed) || processStamp(held) !== processStamp(observed) || processStamp(fs.fstatSync(pinned.fd, { bigint: true })) !== processStamp(observed)) continue;
        } finally { pinned.close(); }
        if (record!.format !== "pm-vcs-process-lease-1" || Object.keys(record!).sort().join(",") !== "format,identity,name,owner,parent,pid" || record!.identity !== processBirth(observed) || record!.parent !== parent || record!.name !== basename(path) || !/^[0-9a-f]{32}$/.test(record!.owner ?? "") || !Number.isSafeInteger(record!.pid) || record!.pid! < 1 || record!.pid! > 2_147_483_647) refuse("A foreign native process marker was preserved.");
        const known = knownProcessOwners.get(path); const abandoned = record!.pid === process.pid && known?.owner === record!.owner && known?.identity === record!.identity && activeProcessOwners.get(path) !== record!.owner;
        if (!abandoned) { try { process.kill(record!.pid!, 0); refuse("Another process owns this native lock."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
        try { durability.unlinkOwner(path, observed); } catch (error) { if (!(error instanceof DestructionRefusal) || error.code !== "destructive_target_changed") throw error; }
      }
    }
    if (!acquired) refuse("Native lock ownership changed through eight attempts.");
    knownProcessOwners.set(path, { owner: token, identity: processBirth(original) }); activeProcessOwners.set(path, token);
    destructionBoundary.visit("process-owner-published", path); cleanup(temporary); durability.file(file.fd);
    const owner = fs.fstatSync(file.fd, { bigint: true }); let released = false;
    /** Revalidate both the owner descriptor and the original operator namespace before protected mutation. */
    const verify = (): void => {
      const current = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (released || current === undefined || !current.isFile() || processStamp(current) !== processStamp(owner) || processStamp(fs.fstatSync(file.fd, { bigint: true })) !== processStamp(owner) || processBirth(fs.lstatSync(dirname(path), { bigint: true })) !== parent || fs.realpathSync(address) !== path) refuse("The native lease changed before its protected mutation.");
    };
    verify(); transferred = true;
    return { descriptor: file.fd, owner, verify,
      /** Release our token only, close last, and retain abandoned authority when native cleanup fails. */
      release() { if (released) return; released = true; let finished = false; try { durability.release(path, file.fd, owner, () => file.close()); finished = true; } finally { if (activeProcessOwners.get(path) === token) activeProcessOwners.delete(path); if (finished && knownProcessOwners.get(path)?.owner === token) knownProcessOwners.delete(path); } },
    };
  } finally {
    if (!transferred) {
      try { if (acquired) cleanup(path); }
      finally { try { if (original === undefined) original = fs.fstatSync(file.fd, { bigint: true }); durability.discardUnpublished(temporary, file.fd, original); }
        finally { if (activeProcessOwners.get(path) === token) activeProcessOwners.delete(path); file.close(); } }
    }
  }
}

/** Compare complete native stamps before replacing any journal namespace entry. */
function unchanged(before: fs.BigIntStats | undefined, current: fs.BigIntStats | undefined): boolean { return before === undefined ? current === undefined : current !== undefined && current.dev === before.dev && current.ino === before.ino && current.size === before.size && current.mtimeNs === before.mtimeNs && current.ctimeNs === before.ctimeNs; }

/** Bootstrap intent records and their mutex receipts use these same platform-aware namespace barriers. */
configureDestruction({
  file: durability.file,
  directory: durability.directory,
  write(path, bytes) {
    const previous = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (previous !== undefined && !previous.isFile()) throw new DestructionRefusal("foreign_destructive_intent", "A nonregular intent destination was preserved.");
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`; const file = objectFiles.open(temporary, "wx", 0o600); let owned: fs.BigIntStats;
    try { owned = fs.fstatSync(file.fd, { bigint: true }); destructionBoundary.visit("intent-temp-opened", temporary); fs.writeFileSync(file.fd, bytes); destructionBoundary.visit("intent-temp-written", temporary); durability.file(file.fd); owned = fs.fstatSync(file.fd, { bigint: true }); destructionBoundary.visit("intent-temp-flushed", temporary); } finally { file.close(); }
    try { const current = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (!unchanged(previous, current) || !unchanged(owned, fs.lstatSync(temporary, { bigint: true, throwIfNoEntry: false }))) throw new DestructionRefusal("destructive_intent_changed", "An intent destination changed before publication."); fs.renameSync(temporary, path); destructionBoundary.visit("intent-renamed", path); durability.directory(dirname(path)); destructionBoundary.visit("intent-directory-flushed", path); }
    finally { const current = fs.lstatSync(temporary, { bigint: true, throwIfNoEntry: false }); if (current !== undefined && current.dev === owned.dev && current.ino === owned.ino) { durability.directory(dirname(temporary)); fs.unlinkSync(temporary); durability.directory(dirname(temporary)); } }
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
  unlink(path) { durability.directory(dirname(path)); fs.unlinkSync(path); durability.directory(dirname(path)); },
  rmdir(path) { durability.directory(dirname(path)); fs.rmdirSync(path); durability.directory(dirname(path)); },
  rename(source, destination) { durability.directory(dirname(source)); if (dirname(source) !== dirname(destination)) durability.directory(dirname(destination)); fs.renameSync(source, destination); durability.directory(dirname(source)); if (dirname(source) !== dirname(destination)) durability.directory(dirname(destination)); },
});

export { inspectDestructions, DestructionRefusal, type DestructionInventory, type DestructionRefusalCode, type DestructionReceipt, type DestructionPlan } from "./destruction.ts";
