/** Descriptor-pinned working-tree mutations; pathname checks alone cannot serialize a rename. */
import fs, { type BigIntStats } from "node:fs";
import { join } from "node:path";

import { isControlPath, isPrunableDirectory } from "./ignore.ts";
import { ObjectStoreError } from "./objects.ts";

/** A directory held open for the entire mutation, with its original filesystem identity. */
interface Directory {
  readonly fd: number;
  readonly stat: BigIntStats;
  readonly address: string;
}

/**
 * Pins the initial directory topology before any writes and addresses children through procfs.
 * Linux's descriptor paths provide the openat-equivalent anchor missing from Node's API.
 * Identity checks detect replacement; pinned parents prevent the remaining check/use gap
 * from redirecting a syscall through an ancestor symlink. No unsafe pathname fallback exists.
 */
export class WorktreeMutation {
  private readonly directories = new Map<string, Directory>();
  private readonly root: string;
  private readonly controlDirectory: string;

  /** Snapshot ordinary directories without following links; release all descriptors on failure. */
  constructor(root: string, controlDirectory: string) {
    this.root = root;
    this.controlDirectory = controlDirectory;
    try {
      this.capture("", root);
      const anchor = this.directories.get("")!;
      let available = false;
      try {
        available = this.same(anchor.stat, fs.statSync(anchor.address, { bigint: true }));
      } catch {
        // A missing or restricted procfs must never select path-based mutation.
      }
      if (!available) {
        throw new ObjectStoreError("worktree_descriptor_unavailable", "Safe working-tree descriptor paths are unavailable.");
      }
      this.snapshot("");
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Compare exact device/inode identities rather than timestamps or path spellings. */
  private same(left: BigIntStats, right: BigIntStats | undefined): boolean {
    return right !== undefined && left.dev === right.dev && left.ino === right.ino;
  }

  /** Emit the stable typed refusal used for directory or leaf replacement at every boundary. */
  private changed(): never {
    throw new ObjectStoreError("worktree_path_changed", "Working-tree filesystem identity changed during mutation.");
  }

  /** Open one directory without following its final component and compare both observations. */
  private capture(path: string, address: string): void {
    const before = fs.lstatSync(address, { bigint: true, throwIfNoEntry: false });
    if (before === undefined || !before.isDirectory()) this.changed();
    let fd: number;
    try {
      fd = fs.openSync(address, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    } catch {
      this.changed();
    }
    // Register first so constructor cleanup also handles a failed fstat.
    this.directories.set(path, { fd, stat: before, address: `/proc/self/fd/${fd}` });
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!this.same(before, stat)) this.changed();
    this.verify(path);
  }

  /** Capture the initial ordinary-directory graph, excluding control and always-pruned subtrees. */
  private snapshot(path: string): void {
    const directory = this.directories.get(path)!;
    this.verify(path);
    for (const entry of fs.readdirSync(directory.address, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.toLowerCase() === this.controlDirectory.toLowerCase()
        || isPrunableDirectory(entry.name)) continue;
      const child = path === "" ? entry.name : `${path}/${entry.name}`;
      this.capture(child, join(directory.address, entry.name));
      this.snapshot(child);
    }
    this.verify(path);
  }

  /** Recheck every named ancestor through its already pinned parent, starting with the root. */
  private verify(path: string): void {
    let prefix = "";
    let address = this.root;
    for (const segment of ["", ...path.split("/").filter((part) => part !== "")]) {
      if (segment !== "") {
        address = join(this.directories.get(prefix)!.address, segment);
        prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      }
      const stat = fs.lstatSync(address, { bigint: true, throwIfNoEntry: false });
      if (stat === undefined || !stat.isDirectory() || !this.same(this.directories.get(prefix)!.stat, stat)) this.changed();
    }
  }

  /** Resolve a canonical leaf under pinned parents, exclusively creating each missing directory. */
  private parent(path: string, create: boolean): { path: string; address: string } | undefined {
    const segments = path.split("/");
    if (isControlPath(path) || segments.some((part) => part === "" || part === "." || part === ".." || part.includes("\0"))) {
      throw new ObjectStoreError("path_ignored", "Unsafe working-tree mutation path.");
    }
    let prefix = "";
    for (const segment of segments.slice(0, -1)) {
      this.verify(prefix);
      const address = join(this.directories.get(prefix)!.address, segment);
      const child = prefix === "" ? segment : `${prefix}/${segment}`;
      if (!this.directories.has(child)) {
        if (fs.lstatSync(address, { throwIfNoEntry: false }) !== undefined) this.changed();
        if (!create) return undefined;
        try {
          fs.mkdirSync(address);
        } catch {
          this.changed();
        }
        this.capture(child, address);
      }
      prefix = child;
    }
    this.verify(prefix);
    return { path: prefix, address: join(this.directories.get(prefix)!.address, segments.at(-1)!) };
  }

  /** Unlink under a pinned parent and turn concurrent disappearance/type replacement into refusal. */
  private unlink(parent: { path: string; address: string }): void {
    this.verify(parent.path);
    try {
      fs.unlinkSync(parent.address);
    } catch {
      this.changed();
    }
    this.verify(parent.path);
  }

  /** Replace a leaf without ever truncating a link or hardlink; write and chmod only its new fd. */
  write(path: string, content: Buffer, mode: number): void {
    const parent = this.parent(path, true)!;
    const before = fs.lstatSync(parent.address, { throwIfNoEntry: false });
    if (before !== undefined) {
      if (!before.isFile()) this.changed();
      this.unlink(parent);
    }
    this.verify(parent.path);
    let fd: number;
    try {
      fd = fs.openSync(parent.address, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    } catch {
      this.changed();
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      this.verify(parent.path);
      if (!this.same(stat, fs.lstatSync(parent.address, { bigint: true, throwIfNoEntry: false }))) this.changed();
      fs.writeFileSync(fd, content);
      fs.fchmodSync(fd, mode);
      this.verify(parent.path);
      if (!this.same(stat, fs.lstatSync(parent.address, { bigint: true, throwIfNoEntry: false }))) this.changed();
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Unlink a file name under pinned parents; directories are never recursively removed. */
  remove(path: string): void {
    const parent = this.parent(path, false);
    if (parent === undefined) return;
    const stat = fs.lstatSync(parent.address, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isDirectory()) {
      throw new ObjectStoreError("restore_directory_unsupported", "Restore accepts file paths, not directories.");
    }
    if (stat.isSymbolicLink()) this.changed();
    this.unlink(parent);
  }

  /** Prune only captured empty ordinary directories with non-recursive descriptor-anchored rmdir. */
  prune(directory: string = ""): boolean {
    if (!this.directories.has(directory)) this.changed();
    const paths = [...this.directories.keys()].filter((path) => path !== directory && (directory === "" || path.startsWith(`${directory}/`)))
      .sort((left, right) => right.split("/").length - left.split("/").length);
    for (const path of paths) {
      this.verify(path);
      if (fs.readdirSync(this.directories.get(path)!.address).length !== 0) continue;
      const slash = path.lastIndexOf("/");
      const parent = slash === -1 ? "" : path.slice(0, slash);
      const name = path.slice(slash + 1);
      this.verify(path);
      try {
        fs.rmdirSync(join(this.directories.get(parent)!.address, name));
      } catch {
        this.changed();
      }
      this.verify(parent);
      fs.closeSync(this.directories.get(path)!.fd);
      this.directories.delete(path);
    }
    this.verify(directory);
    return fs.readdirSync(this.directories.get(directory)!.address).length === 0;
  }

  /** Release every pinned directory, including when a later mutation refuses. */
  close(): void {
    for (const directory of this.directories.values()) fs.closeSync(directory.fd);
    this.directories.clear();
  }
}
