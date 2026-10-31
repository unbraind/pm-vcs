import { configureDestruction, retireNamespace, withDestructionScope, resolveNamespacePath, resumeNamespaceDirectory, resumeNamespacePublication, prepareNamespaceDestruction, destructionBoundary, DestructionRefusal, type DestructionReceipt } from "./destruction.ts";
import { withNativePublication, validateNativePublication } from "./publication-gate.ts";
import { ObjectStoreError, assertVerificationBound, verificationLimits } from "./object-error.ts";
import { createHash, randomBytes } from "node:crypto";
import { objectFiles } from "./object-files.ts";
/** Platform-aware durability policy shared by native publication and retirement. */
import fs, { type RmOptions } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Forced capability seam for real-filesystem portability tests. @internal */
export const durabilityCapabilities = { directorySync: process.platform !== "win32" };

interface ProcessLease { readonly descriptor: number; readonly owner: fs.BigIntStats; verify(): void; release(): void }
interface ProcessMarker { readonly format: "pm-vcs-process-lease-1"; readonly pid: number; readonly identity: string; readonly parent: string; readonly name: string; readonly owner: string }
const knownProcessOwners = new Map<string, { owner: string; identity: string }>();
const activeProcessOwners = new Map<string, string>();
const knownProcessStages = new Map<string, { owner: string; identity: string }>();
const activeProcessStages = new Set<string>();
/** Birth identity binds a process marker to an inode lifetime without persisting machine paths. */
function processBirth(stat: fs.BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }
/** Complete mutable stamps fence byte changes and reattached names while a process lease is active. */
function processStamp(stat: fs.BigIntStats): string { return `${processBirth(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }

/** Flush data before atomic publication; POSIX also flushes directory entries, Windows uses synchronous namespace acknowledgment. */
export const durability = {
  /** Publish one descriptor-owned process lease; known dead owners recover, foreign markers remain untouched. */
  claim: claimProcessLease,
  /** Recognize only complete inode-bound native owner records for one explicit process-lease destination. */
  processMarker(path: string, destination: string): boolean { return observeProcessMarker(path, destination) !== undefined; },
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
  rename(source: string, destination: string, validate?: () => void): DestructionReceipt {
    source = resolve(source); destination = resolve(destination);
    return withNativePublication(destination, () => {
    validateNativePublication(source, destination);
    if (validate !== undefined) { resumeNamespacePublication(destination); validate(); }
    const file = objectFiles.open(source, "r+"); let expected: fs.BigIntStats;
    try { expected = fs.fstatSync(file.fd, { bigint: true }); durability.file(file.fd); } finally { file.close(); }
    return retireNamespace({ path: source, destination, expected }, false, validate);
    });
  },
  /** Recover durable prior publications under the store lease before a new semantic state is observed. */
  recoverPublication(destination: string): void { withNativePublication(destination, () => resumeNamespacePublication(destination)); },
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
  /** Recover only an existing exact directory retirement; unknown and replaced entries remain foreign. */
  resumeDirectory: resumeNamespaceDirectory,
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

/** Share the exact native marker schema between acquisition, read-only accounting and orphan recovery. */
function validProcessMarker(value: unknown, observed: fs.BigIntStats, parent: string, name: string): value is ProcessMarker {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ProcessMarker>;
  return record.format === "pm-vcs-process-lease-1" && Object.keys(record).sort().join(",") === "format,identity,name,owner,parent,pid" && record.identity === processBirth(observed) && record.parent === parent && record.name === name && /^[0-9a-f]{32}$/.test(record.owner ?? "") && Number.isSafeInteger(record.pid) && record.pid! >= 1 && record.pid! <= 2_147_483_647;
}

/** Pin a narrowly named native marker; copied, renamed, partial, changed and foreign records confer no authority. */
function observeProcessMarker(address: string, destination: string): { readonly record: ProcessMarker; readonly stat: fs.BigIntStats } | undefined {
  address = resolve(address); destination = resolve(destination);
  if (dirname(address) !== dirname(destination)) return undefined;
  const prefix = createHash("sha256").update(basename(destination)).digest("hex").slice(0, 24);
  const staged = new RegExp(`^owner-${prefix}-([1-9][0-9]*)-[0-9a-f]{12}\\.lock$`).exec(basename(address));
  if (basename(address) !== basename(destination) && staged === null) return undefined;
  const before = fs.lstatSync(address, { bigint: true, throwIfNoEntry: false });
  if (!before?.isFile() || before.size > 4096n) return undefined;
  let file: ReturnType<typeof objectFiles.open>;
  try { file = objectFiles.open(address, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
  try {
    const held = fs.fstatSync(file.fd, { bigint: true }); let record: unknown;
    if (processStamp(before) !== processStamp(held)) return undefined;
    const bytes = Buffer.alloc(Number(held.size)); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(file.fd, bytes, { offset, length: bytes.length - offset, position: offset }); if (count === 0) return undefined; offset += count; }
    try { record = JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
    const parent = fs.lstatSync(dirname(address), { bigint: true }); const current = fs.lstatSync(address, { bigint: true, throwIfNoEntry: false });
    if (current === undefined || processStamp(current) !== processStamp(held) || processStamp(fs.fstatSync(file.fd, { bigint: true })) !== processStamp(held) || !validProcessMarker(record, held, processBirth(parent), basename(destination)) || staged !== null && Number(staged[1]) !== record.pid) return undefined;
    return { record, stat: held };
  } finally { file.close(); }
}

/** Under the new final lease, capture and durably retire only complete markers whose old process is dead. */
function recoverProcessStages(path: string, temporary: string, verify: () => void): void {
  const prefix = `owner-${createHash("sha256").update(basename(path)).digest("hex").slice(0, 24)}-`;
  const candidates: { path: string; expected: fs.BigIntStats }[] = []; const started = performance.now(); let work = 0;
  for (const name of fs.readdirSync(dirname(path))) {
    const candidate = join(dirname(path), name); if (candidate === temporary || !name.startsWith(prefix)) continue;
    assertVerificationBound("receipts", "record_count", ++work, verificationLimits.receiptRecords); assertVerificationBound("receipts", "time_ms", performance.now() - started, verificationLimits.receiptMs);
    const marker = observeProcessMarker(candidate, path); if (marker === undefined) continue;
    const abandoned = knownProcessStages.get(candidate);
    const self = marker.record.pid === process.pid && abandoned?.owner === marker.record.owner && abandoned.identity === marker.record.identity && !activeProcessStages.has(candidate);
    if (!self) { try { process.kill(marker.record.pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    candidates.push({ path: candidate, expected: marker.stat });
  }
  verify(); if (candidates.length === 0) return;
  destructionBoundary.visit("process-stages-captured", path); verify();
  const plan = prepareNamespaceDestruction(path, `process-stage-recovery:${basename(path)}`, candidates, false, "eligibility_changed");
  for (const candidate of plan.paths) { verify(); plan.remove(candidate); knownProcessStages.delete(candidate); }
  plan.finish(); destructionBoundary.visit("process-stages-completed", path); verify();
}

/** Synchronous filesystem leases use staged, flushed markers instead of unrecoverable empty lock files. */
function claimProcessLease(address: string, code: string): ProcessLease {
  address = resolve(address); let path = resolveNamespacePath(address); fs.mkdirSync(dirname(path), { recursive: true });
  path = join(fs.realpathSync(dirname(path)), basename(path));
  const existing = fs.lstatSync(path, { throwIfNoEntry: false }); if (existing?.isFile()) path = fs.realpathSync(path);
  const parent = processBirth(fs.lstatSync(dirname(path), { bigint: true })); const token = randomBytes(16).toString("hex");
  const temporary = join(dirname(path), `owner-${createHash("sha256").update(basename(path)).digest("hex").slice(0, 24)}-${process.pid}-${randomBytes(6).toString("hex")}.lock`);
  const file = objectFiles.open(temporary, "wx", 0o600); let original: fs.BigIntStats | undefined; let acquired = false; let transferred = false;
  /** Fail with a stable caller discriminator and an explicit safe recovery instruction. */
  const refuse = (detail: string): never => { throw new ObjectStoreError(code, `${code === "bisect_locked" ? (detail.startsWith("Another") ? "Another bisect command or test worker owns this worktree. " : "Unknown bisect lock owner; inspect its process pid. ") : ""}${detail} Wait for live owners; known dead process markers recover on retry. Inspect foreign markers before manual removal.`); };
  /** Remove only our own marker inode; a peer's replacement is never cleanup authority. */
  const cleanup = (target: string): void => { const current = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false }); if (current !== undefined && processBirth(current) === processBirth(fs.fstatSync(file.fd, { bigint: true }))) durability.unlinkOwner(target, current); if (knownProcessStages.get(target)?.owner === token) knownProcessStages.delete(target); };
  try {
    original = fs.fstatSync(file.fd, { bigint: true });
    fs.writeFileSync(file.fd, JSON.stringify({ format: "pm-vcs-process-lease-1", pid: process.pid, identity: processBirth(original), parent, name: basename(path), owner: token })); durability.file(file.fd);
    knownProcessStages.set(temporary, { owner: token, identity: processBirth(original) });
    activeProcessStages.add(temporary);
    for (let attempt = 0; attempt < 8; attempt++) {
      try { durability.link(temporary, path); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const observed = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (observed === undefined) continue;
        if (!observed.isFile() || observed.size > 4096n) refuse("A foreign native lock was preserved.");
        const marker = observeProcessMarker(path, path);
        if (marker === undefined) {
          const current = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
          if (current === undefined || processStamp(current) !== processStamp(observed)) continue;
          refuse("A foreign native process marker was preserved.");
        }
        if (processStamp(marker!.stat) !== processStamp(observed)) continue;
        const record = marker!.record;
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
    recoverProcessStages(path, temporary, verify); verify(); transferred = true;
    return { descriptor: file.fd, owner, verify,
      /** Release our token only, close last, and retain abandoned authority when native cleanup fails. */
      release() { if (released) return; released = true; let finished = false; try { durability.release(path, file.fd, owner, () => file.close()); finished = true; } finally { if (activeProcessOwners.get(path) === token) activeProcessOwners.delete(path); if (finished && knownProcessOwners.get(path)?.owner === token) knownProcessOwners.delete(path); } },
    };
  } finally {
    activeProcessStages.delete(temporary);
    if (!transferred) {
      try { if (acquired) cleanup(path); }
      finally { try { if (original === undefined) original = fs.fstatSync(file.fd, { bigint: true }); durability.discardUnpublished(temporary, file.fd, original); if (knownProcessStages.get(temporary)?.owner === token) knownProcessStages.delete(temporary); }
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
  rename(source, destination) { withNativePublication(destination, () => { validateNativePublication(source, destination); durability.directory(dirname(source)); if (dirname(source) !== dirname(destination)) durability.directory(dirname(destination)); fs.renameSync(source, destination); durability.directory(dirname(source)); if (dirname(source) !== dirname(destination)) durability.directory(dirname(destination)); }); },
});

export { inspectDestructions, DestructionRefusal, type DestructionInventory, type DestructionRefusalCode, type DestructionReceipt, type DestructionPlan, type DestructionCancellation } from "./destruction.ts";
