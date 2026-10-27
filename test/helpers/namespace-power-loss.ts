/** Native namespace persistence model: file flushes and directory-entry flushes are independent. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, basename, join, resolve, sep } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { makeTempDir } from "./tmp.ts";

const native = { open: fs.openSync, close: fs.closeSync, stat: fs.lstatSync, fstat: fs.fstatSync, read: fs.readFileSync, names: fs.readdirSync, mkdir: fs.mkdirSync, link: fs.linkSync, rename: fs.renameSync, unlink: fs.unlinkSync, rmdir: fs.rmdirSync, sync: fs.fsyncSync, write: fs.writeSync, writeFile: fs.writeFileSync, append: fs.appendFileSync, realpath: fs.realpathSync };
interface Node { kind: "file" | "directory" | "link"; backup: string; stamp: fs.BigIntStats; bytes?: Buffer; flushed?: fs.BigIntStats }
/** Retain one physical inode identity while independently rolling its directory names back. */
function identity(stat: fs.BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }

/** Real files remain native; only loss of unflushed namespace entries and inode data is simulated. */
export class NamespacePowerLoss {
  readonly trace: string[] = [];
  readonly recoveryCuts: number[] = [];
  private readonly images = new Set<string>();
  readonly failure = new Error("simulated power failure");
  private readonly archive = makeTempDir();
  private readonly nodes = new Map<string, Node>();
  private readonly volatile = new Map<string, Map<string, string>>();
  private readonly durable = new Map<string, Map<string, string>>();
  private readonly descriptors = new Map<number, string>();
  private readonly opened = new Map<number, string>();
  private readonly rootNames = new Map<string, Set<string>>();
  private crashed = false;
  private restoring = false;
  private durableRevision = 0;
  private cachedRevision = -1;
  private cachedSizes = "";
  private cachedImage = "";
  private visibleDirectories: string[] = [];
  private readonly cache: boolean;
  private readonly audit: boolean;
  private serial = 0;
  private cut = 0;
  private phase: "record" | "recover" = "record";
  private readonly roots: readonly string[];
  private readonly journals: readonly string[];

  /** Watch only explicitly owned fixture roots; never restore other entries in their shared parent. */
  constructor(roots: readonly string[], cut = 0, journals: readonly string[] = [], cache = true, audit = false) {
    this.roots = roots.map(path => resolve(path)); this.cut = cut; this.journals = journals; this.cache = cache; this.audit = audit;
    for (const root of this.roots) { const parent = dirname(root); let names = this.rootNames.get(parent); if (names === undefined) { names = new Set(); this.rootNames.set(parent, names); } names.add(basename(root)); }
    this.scan();
    for (const [id, entries] of this.volatile) this.durable.set(id, new Map(entries));
    for (const node of this.nodes.values()) if (node.kind === "file") { const bytes=native.read(node.backup);if(node.bytes===undefined||!node.bytes.equals(bytes)||node.flushed===undefined||node.flushed.mtimeNs!==node.stamp.mtimeNs||node.flushed.ctimeNs!==node.stamp.ctimeNs||node.flushed.mode!==node.stamp.mode)this.durableRevision++;node.bytes=bytes;node.flushed=node.stamp; }
  }

  /** Descriptor aliases resolve through the retained parent, while missing ordinary parents remain ordinary paths. */
  private physical(path: string): string { try { return join(native.realpath(dirname(resolve(path))), basename(path)); } catch { return resolve(path); } }
  /** Match complete path components instead of prefixes that could select a peer fixture. */
  private owned(path: string): boolean { return this.roots.some(root => path === root || path.startsWith(`${root}${sep}`)); }
  /** Capture a new inode before the engine can publish or retire its last ordinary name. */
  private capture(path: string): string {
    const stat = native.stat(path, { bigint: true }); const id = identity(stat);
    if (!this.nodes.has(id)) {
      const kind = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "link" : "file";
      const backup = kind === "directory" ? path : join(this.archive.root, `inode-${++this.serial}`);
      if (kind !== "directory") native.link(path, backup);
      this.nodes.set(id, { kind, backup, stamp: stat });
    }
    return id;
  }
  /** Refresh volatile directory entries without promoting them to durable state. */
  private scan(): void {
    const walk = (path: string): string => {
      const id = this.capture(path); const node = this.nodes.get(id)!;
      if (node.kind === "directory") { node.backup = path; const entries = new Map<string, string>(); for (const name of native.names(path)) entries.set(name, walk(join(path, name))); this.volatile.set(id, entries); }
      return id;
    };
    for (const root of this.roots) if (native.stat(root, { throwIfNoEntry: false }) !== undefined) walk(root);
    for (const [path, names] of this.rootNames) { const id = identity(native.stat(path, { bigint: true })); const entries = new Map<string, string>(); for (const name of names) { const child = join(path, name); if (native.stat(child, { throwIfNoEntry: false }) !== undefined) entries.set(name, this.capture(child)); } this.volatile.set(id, entries); }
  }
  /** Update exactly one changed parent; the optional oracle independently rescans the complete owned namespace. */
  private namespace(path: string, present = true, verify = true): void {
    if(this.phase!=="record")return;
    if(!this.cache){this.scan();return;}
    const parent=identity(native.stat(dirname(path),{bigint:true}));const names=this.volatile.get(parent);
    if(names===undefined){this.scan();return;}
    if(present){const stat=native.stat(path,{bigint:true,throwIfNoEntry:false});if(stat===undefined)return;if(stat.isDirectory()){this.scan();return;}names.set(basename(path),this.capture(path));}
    else names.delete(basename(path));
    if(this.audit&&verify){const expected=new Map([...this.volatile].map(([id,entries])=>[id,new Map(entries)]));this.scan();assert.deepEqual(this.volatile,expected,"incremental namespace equals the full native scan");}
  }
  /** Recovery authority must have both flushed bytes and a durable chain of directory names. */
  private authority(source: string, destination?: string): void {
    if (this.phase !== "record" || !this.owned(source)) return;
    const sourceStat = native.stat(source, { bigint: true, throwIfNoEntry: false }); if (sourceStat === undefined) return;
    const sourceId = identity(sourceStat); const node = this.nodes.get(sourceId)!;
    const journal = (path: string): boolean => this.journals.some(directory => path.startsWith(`${directory}${sep}`)) || this.roots.some(root => path.startsWith(`${join(root, ".pmvcs", "destruction")}${sep}`) || /^pm-vcs-namespace-[0-9a-f]{64}$/.test(basename(root)) && path.startsWith(`${join(root, "destruction")}${sep}`));
    if (journal(source) && destination !== undefined && journal(destination)) { assert.ok(node.bytes !== undefined, "journal replacement needs flushed recovery bytes"); return; }
    const visible = new Set<string>();
    const visit = (id: string): void => { if (visible.has(id)) return; visible.add(id); for (const child of this.durable.get(id)?.values() ?? []) visit(child); };
    for (const root of this.roots) { const parent = identity(native.stat(dirname(root), { bigint: true })); const id = this.durable.get(parent)?.get(basename(root)); if (id !== undefined) visit(id); }
    if (journal(source)) { assert.ok(visible.has(sourceId) && node.bytes !== undefined, "owner retirement needs its flushed recovery record and every ancestor"); return; }
    let authorized = false;
    for (const id of visible) {
      const bytes = this.nodes.get(id)?.bytes; if (bytes === undefined || bytes[0] !== 123) continue;
      let record: { format?: string; status?: string; root?: string; entries?: { path: string; destination?: string; identity: string; status: string }[] };
      try { record = JSON.parse(bytes.toString("utf8")) as typeof record; } catch { continue; }
      if (record.format !== "pm-vcs-destruction-1" || record.status !== "pending" || record.root === undefined || !Array.isArray(record.entries)) continue;
      if (record.entries.some(entry => entry.status === "planned" && resolve(record.root!, entry.path) === source && (entry.destination === undefined ? destination === undefined : resolve(record.root!, entry.destination) === destination) && entry.identity.startsWith(`${sourceId}:`))) { authorized = true; break; }
    }
    assert.ok(authorized, "every destructive namespace mutation needs a durable exact-set recovery record");
  }
  /** A crash rejects all later writes from finally blocks, as a terminated process would. */
  private writable(): void { if (this.crashed && !this.restoring) throw this.failure; }
  /** Canonicalize the complete post-power-loss namespace, data and engine-observable inode stamps. */
  private image(): string {
    const sizes = JSON.stringify(this.visibleDirectories.map(id => [id,native.stat(this.nodes.get(id)!.backup).size]));
    if (this.cache && this.cachedRevision === this.durableRevision && sizes === this.cachedSizes) return this.cachedImage;
    const hash = createHash("sha256"); const directories: string[] = [];
    const visit = (id: string, path: string): void => {
      const node = this.nodes.get(id)!; const stamp = node.flushed ?? node.stamp;
      hash.update(JSON.stringify([path,id,node.kind,stamp.birthtimeNs.toString(),stamp.mtimeNs.toString(),stamp.ctimeNs.toString(),stamp.mode.toString()]));
      if (node.kind === "directory") {
        directories.push(id); hash.update(String(native.stat(node.backup).size));
        for (const [name, child] of [...(this.durable.get(id) ?? [])].sort(([a],[b])=>a.localeCompare(b))) visit(child,`${path}/${name}`);
      } else if (node.kind === "file") { const bytes=node.bytes ?? Buffer.alloc(0);hash.update(String(bytes.length)+":");hash.update(bytes); }
      else hash.update(fs.readlinkSync(node.backup));
    };
    for (const root of this.roots) { const parent = identity(native.stat(dirname(root), { bigint: true })); const id = this.durable.get(parent)?.get(basename(root)); hash.update(root); if (id !== undefined) visit(id,root); }
    this.visibleDirectories = directories; this.cachedSizes = JSON.stringify(directories.map(id => [id,native.stat(this.nodes.get(id)!.backup).size])); this.cachedRevision = this.durableRevision; this.cachedImage = hash.digest("hex"); return this.cachedImage;
  }
  /** Check every native boundary; byte-identical crash images share one native recovery proof. */
  private step(kind: string): void {
    if (this.phase !== "record") return;
    this.trace.push(kind); const image = this.image(); if (!this.images.has(image)) { this.images.add(image); this.recoveryCuts.push(this.trace.length); }
    if (this.cut > 0 && this.trace.length === this.cut) this.interrupt();
  }
  /** Logical publication seams use the same sealed-write and kernel-closure crash protocol as native boundaries. */
  interrupt(): never { this.crashed = true; throw this.failure; }
  /** Crash-free convergence replays keep native I/O and identity overlays; dedicated recovery sequences retain full power accounting in record phase. */
  replay(): void { this.phase = "recover"; }
  /** Logical metadata survives rollback; restoration hardlinks must not fabricate a peer inode replacement. */
  private stamped<T extends fs.Stats | fs.BigIntStats>(stat: T, held: fs.BigIntStats): T {
    const node = this.nodes.get(identity(held)); if (node === undefined) return stat;
    const stamp = node.stamp;
    return new Proxy(stat, { get(target, key, receiver) {
      if (key === "ctimeNs" || key === "mtimeNs") return stamp[key];
      if (key === "ctimeMs" || key === "mtimeMs") return typeof target.dev === "bigint" ? stamp[key] : Number(stamp[key]);
      if (key === "ctime" || key === "mtime") return stamp[key];
      return Reflect.get(target, key, receiver);
    } });
  }
  /** Record actual writes while preserving the independent durable copy until fsync. */
  private touched(path: string): void { const stat = native.stat(path, { bigint: true, throwIfNoEntry: false }); if (stat !== undefined) { const node = this.nodes.get(identity(stat)); if (node !== undefined) { node.stamp = stat; if (node.flushed === undefined) this.durableRevision++; } } }

  /** Install native fault seams after creating one real SDK tracker; no SDK method is mocked. */
  install(): void {
    mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      const path = this.physical(String(args[0])); const mutation = typeof args[1] === "string" ? /[wax]/.test(args[1]) : (args[1] & (fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0; if (mutation) this.writable();
      const fd = native.open(...args); this.descriptors.set(fd, path); this.opened.set(fd, identity(native.fstat(fd, { bigint: true })));
      if (mutation && this.owned(path)) { if(this.phase === "record")this.namespace(path);else this.touched(path); this.step("file-opened"); } return fd;
    });
    mock.method(fs, "closeSync", (fd: number) => { this.descriptors.delete(fd); this.opened.delete(fd); return native.close(fd); });
    mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => { const value = native.stat(...args); if(value===undefined)return value;const held=typeof value.dev==="bigint"?value as fs.BigIntStats:native.stat(args[0],{bigint:true,throwIfNoEntry:false});return held===undefined?value:this.stamped(value,held); });
    mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {const value=native.fstat(...args);return this.stamped(value,typeof value.dev==="bigint"?value as fs.BigIntStats:native.fstat(args[0],{bigint:true}));});
    mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => { this.writable(); const path = this.physical(String(args[0]));const previous=native.stat(path,{bigint:true,throwIfNoEntry:false});const result = native.mkdir(...args); if (this.owned(path)) { if(this.phase === "record"&&(!this.cache||previous===undefined||!this.nodes.has(identity(previous))))this.scan(); this.step("directory-created"); } return result; });
    mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => { this.writable(); const result = native.write(...args); const path = this.descriptors.get(args[0]); if (path !== undefined && this.owned(path)) { this.touched(path); this.step("file-written"); } return result; });
    mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => { this.writable(); const result = native.writeFile(...args); const path = typeof args[0] === "number" ? this.descriptors.get(args[0]) : this.physical(String(args[0])); if (path !== undefined && this.owned(path)) { if(this.phase === "record")this.namespace(path); this.touched(path); this.step("file-written"); } return result; });
    mock.method(fs, "appendFileSync", (...args: Parameters<typeof fs.appendFileSync>) => { this.writable(); const result = native.append(...args); const path = typeof args[0] === "number" ? this.descriptors.get(args[0]) : this.physical(String(args[0])); if (path !== undefined && this.owned(path)) { if(this.phase === "record")this.namespace(path); this.touched(path); this.step("file-appended"); } return result; });
    mock.method(fs, "fsyncSync", (fd: number) => {
      // Power is simulated: the modeled fsync promotes exactly this inode/entry set.
      // Actual host flushes add no evidence because crash() restores this model explicitly.
      this.writable(); const stat = native.fstat(fd, { bigint: true }); if(this.phase !== "record")return; const id = identity(stat);
      if (stat.isDirectory()) { const entries = this.volatile.get(id); if (entries !== undefined) { const previous=this.durable.get(id);if(previous===undefined||previous.size!==entries.size||[...entries].some(([name,child])=>previous.get(name)!==child)){this.durable.set(id,new Map(entries));this.durableRevision++;} } }
      else { const node = this.nodes.get(id); if (node !== undefined) { const bytes=native.read(node.backup);if(node.bytes===undefined||!node.bytes.equals(bytes)||node.flushed===undefined||node.flushed.mtimeNs!==node.stamp.mtimeNs||node.flushed.ctimeNs!==node.stamp.ctimeNs||node.flushed.mode!==node.stamp.mode)this.durableRevision++;node.bytes=bytes;node.flushed=node.stamp; } }
      const path = this.descriptors.get(fd); if (path !== undefined) this.step(stat.isDirectory() ? "directory-flushed" : "file-flushed");
    });
    mock.method(fs, "linkSync", (...args: Parameters<typeof fs.linkSync>) => { this.writable(); const result = native.link(...args); const source = this.physical(String(args[0])); const target = this.physical(String(args[1])); if (this.owned(target)) { if(this.phase === "record")this.namespace(target); this.touched(source); this.step("file-linked"); } return result; });
    mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => { this.writable(); const source = this.physical(String(args[0])); const target = this.physical(String(args[1])); this.authority(source, target); const result = native.rename(...args); if (this.owned(source) || this.owned(target)) { if(this.phase === "record"){this.namespace(source,false,false);this.namespace(target);} this.touched(target); this.step("file-renamed"); } return result; });
    mock.method(fs, "unlinkSync", (...args: Parameters<typeof fs.unlinkSync>) => { this.writable(); const path = this.physical(String(args[0])); this.authority(path); const before = native.stat(path, { bigint: true }); const result = native.unlink(...args); const retained = this.nodes.get(identity(before)); if (retained !== undefined) {retained.stamp = native.stat(retained.backup, { bigint: true });if(retained.flushed===undefined)this.durableRevision++;} if (this.owned(path)) { if(this.phase === "record")this.namespace(path,false); this.step("file-unlinked"); } return result; });
    mock.method(fs, "rmdirSync", (...args: Parameters<typeof fs.rmdirSync>) => { this.writable(); const path = this.physical(String(args[0])); if (this.phase !== "record" || !this.owned(path)) return native.rmdir(...args); this.authority(path); assert.equal(native.names(path).length, 0); const id = this.capture(path); const backup = join(this.archive.root, `directory-${++this.serial}`); native.rename(path, backup); this.nodes.get(id)!.backup = backup; this.namespace(path,false); this.step("directory-unlinked"); });
    const kill = process.kill;
    mock.method(process, "kill", (...args: Parameters<typeof process.kill>) => { if (this.phase === "recover" && args[0] === process.pid && args[1] === 0) throw Object.assign(new Error("modeled pre-crash process ended"), { code: "ESRCH" }); return kill(...args); });
    syncBuiltinESMExports();
  }

  /** A successful return is also a crash boundary: acknowledged state must already be durable. */
  crashAfterReturn(): void { this.crashed = true; this.crash(); }

  /** Rebuild exactly the namespace acknowledged by directory fsync, preserving original inode identities. */
  crash(): void {
    assert.equal(this.crashed, true, "the selected native boundary must actually interrupt execution");
    this.restoring = true; this.phase = "recover";
    for (const [fd, path] of this.descriptors) { try { if (this.owned(path) && identity(native.fstat(fd, { bigint: true })) === this.opened.get(fd)) native.close(fd); } catch { /* The simulated kernel closes an owned descriptor whose open was interrupted before registration. */ } }
    this.descriptors.clear(); this.opened.clear();
    const detached = new Map<string, string>();
    const detach = (path: string): void => {
      const stat = native.stat(path, { bigint: true }); const id = identity(stat);
      if (stat.isDirectory()) for (const name of native.names(path)) detach(join(path, name));
      const backup = join(this.archive.root, `detached-${++this.serial}`); native.rename(path, backup); detached.set(id, backup);
    };
    for (const root of this.roots) if (native.stat(root, { throwIfNoEntry: false }) !== undefined) detach(root);
    const attach = (id: string, path: string): void => {
      const node = this.nodes.get(id)!;
      if (node.kind === "directory") { native.rename(detached.get(id) ?? node.backup, path); for (const [name, child] of this.durable.get(id) ?? []) attach(child, join(path, name)); }
      else { native.link(node.backup, path); if (node.kind === "file") { native.writeFile(path, node.bytes ?? Buffer.alloc(0)); node.stamp = node.flushed ?? node.stamp; } }
    };
    for (const root of this.roots) { const parent = identity(native.stat(dirname(root), { bigint: true })); const id = this.durable.get(parent)?.get(basename(root)); if (id !== undefined) attach(id, root); }
    this.crashed = false; this.restoring = false; this.scan();
  }
  /** Release all test hooks before native removal of the explicitly owned private inode archive. */
  close(): void { mock.reset(); syncBuiltinESMExports(); this.archive.cleanup(); }
}
