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
    const fd = fs.openSync(path, "r");
    try { durability.file(fd); } finally { fs.closeSync(fd); }
  },
  /** Flush the source file before replacing its name, then complete the platform namespace barriers. */
  rename(source: string, destination: string): void {
    const fd = fs.openSync(source, "r+");
    try { durability.file(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(source, destination);
    durability.directory(dirname(source));
    if (dirname(source) !== dirname(destination)) durability.directory(dirname(destination));
  },
  /** Publish an already flushed immutable file exclusively, preserving EEXIST for peer-result comparison. */
  link(source: string, destination: string): void {
    fs.linkSync(source, destination); durability.directory(dirname(destination));
  },
  /** Unlink one owned leaf and acknowledge the namespace change without a platform refusal after deletion. */
  unlink(path: string): void { fs.unlinkSync(path); durability.directory(dirname(path)); },
  /** Remove a caller-owned temporary tree, retaining native force and error semantics. */
  remove(path: string, options?: RmOptions): void {
    fs.rmSync(path, options);
    const parent = dirname(path);
    if (fs.existsSync(parent)) durability.directory(parent);
  },
  /** Remove only an empty owned directory; ENOTEMPTY remains available to foreign-record preservation. */
  removeDirectory(path: string): void {
    fs.rmdirSync(path); durability.directory(dirname(path));
  },
};
