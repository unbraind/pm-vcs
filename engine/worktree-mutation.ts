/** Pinned or verified working-tree mutations; portable pathname checks cannot serialize a rename. */
import fs, { type BigIntStats } from "node:fs";
import { join } from "node:path";

import { isControlPath, isPrunableDirectory } from "./ignore.ts";
import { ObjectStoreError } from "./objects.ts";

/** Captured directory identity and address, with a retained descriptor on the pinned backend. */
interface Directory {
  readonly fd: number | undefined;
  readonly stat: BigIntStats;
  readonly address: string;
}

/** Injectable platform capabilities; portable callers never need to open directory descriptors. */
export const worktreeMutationCapabilities = {
  /** Procfs must exist before attempting the descriptor-pinned strategy. */
  descriptorPaths: (platform: NodeJS.Platform = process.platform): boolean => platform === "linux" && fs.existsSync("/proc/self/fd"),
  /** Windows has no O_NOFOLLOW; exclusive creation and leaf identity checks still apply. */
  noFollow: (constants: { readonly O_NOFOLLOW?: number } = fs.constants): number => constants.O_NOFOLLOW ?? 0,
};

/**
 * Pins the initial directory topology before any writes and addresses children through procfs.
 * Linux's descriptor paths provide the openat-equivalent anchor missing from Node's API.
 * Identity checks detect replacement; pinned parents prevent the remaining check/use gap
 * from redirecting a syscall through an ancestor symlink. Without descriptor paths, verify
 * the captured topology around each syscall; a final-check/use race remains on that backend.
 */
export class WorktreeMutation {
  private readonly directories = new Map<string, Directory>();
  private readonly root: string;
  private readonly controlDirectory: string;
  private pinned: boolean;

  /** Snapshot ordinary directories without following links; release all descriptors on failure. */
  constructor(root: string, controlDirectory: string) {
    this.root = root;
    this.controlDirectory = controlDirectory;
    this.pinned = worktreeMutationCapabilities.descriptorPaths();
    try {
      this.capture("", root);
      const anchor = this.directories.get("")!;
      if (this.pinned) {
        let available = false;
        try {
          available = this.same(anchor.stat, fs.statSync(anchor.address, { bigint: true }));
        } catch {
          // Missing or restricted descriptor paths select the verified portable strategy.
        }
        if (!available) {
          this.close();
          this.pinned = false;
          this.capture("", root);
          if (!this.same(anchor.stat, this.directories.get("")!.stat)) this.changed();
        }
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

  /** Capture a no-follow directory identity; retain a matching descriptor when procfs is usable. */
  private capture(path: string, address: string): void {
    const before = fs.lstatSync(address, { bigint: true, throwIfNoEntry: false });
    if (before === undefined || !before.isDirectory()) this.changed();
    if (!this.pinned) {
      this.directories.set(path, { fd: undefined, stat: before, address });
      this.verify(path);
      return;
    }
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

  /** Recheck every named ancestor through its selected parent address, starting with the root. */
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

  /** Resolve a canonical leaf under captured parents, exclusively creating each missing directory. */
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
        this.verify(prefix);
        this.capture(child, address);
      }
      prefix = child;
    }
    this.verify(prefix);
    return { path: prefix, address: join(this.directories.get(prefix)!.address, segments.at(-1)!) };
  }

  /** Unlink under a pinned parent and turn concurrent disappearance/type replacement into refusal. */
  private unlink(parent: { path: string; address: string }, stat: BigIntStats, erasure = false): void {
    this.verifyLeaf(parent, stat, erasure);
    try {
      fs.unlinkSync(parent.address);
    } catch {
      this.changed();
    }
    this.verify(parent.path);
    if (fs.lstatSync(parent.address, { throwIfNoEntry: false }) !== undefined) this.changed();
  }

  /** Verify all ancestors and the leaf's no-follow identity around descriptor operations. */
  private verifyLeaf(parent: { path: string; address: string }, expected: BigIntStats, erasure = false): void {
    this.verify(parent.path);
    const observed = fs.lstatSync(parent.address, { bigint: true, throwIfNoEntry: false });
    if (observed === undefined || (!erasure && observed.isSymbolicLink()) || !this.same(expected, observed)) this.changed();
  }

  /** Replace a leaf without ever truncating a link or hardlink; write and chmod only its new fd. */
  write(path: string, content: Buffer, mode: number): void {
    const parent = this.parent(path, true)!;
    const before = fs.lstatSync(parent.address, { bigint: true, throwIfNoEntry: false });
    if (before !== undefined) {
      if (!before.isFile()) this.changed();
      this.unlink(parent, before);
    }
    this.verify(parent.path);
    if (fs.lstatSync(parent.address, { throwIfNoEntry: false }) !== undefined) this.changed();
    let fd: number;
    try {
      fd = fs.openSync(parent.address, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | worktreeMutationCapabilities.noFollow(), mode);
    } catch {
      this.changed();
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      this.verifyLeaf(parent, stat);
      fs.writeFileSync(fd, content);
      this.verifyLeaf(parent, stat);
      fs.fchmodSync(fd, mode);
      this.verifyLeaf(parent, stat);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Unlink a file name under pinned parents; directories are never recursively removed. */
  remove(path: string): void {
    const parent = this.parent(path, false);
    if (parent === undefined) return;
    const stat = fs.lstatSync(parent.address, { bigint: true, throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isDirectory()) {
      throw new ObjectStoreError("restore_directory_unsupported", "Restore accepts file paths, not directories.");
    }
    if (stat.isSymbolicLink()) this.changed();
    this.unlink(parent, stat);
  }

  /** Inspect an erasure leaf through pinned parents; a link contributes only its target text. */
  inspectForErasure(path: string): { readonly stat: BigIntStats; readonly content: Buffer } | undefined {
    const parent = this.parent(path, false);
    if (parent === undefined) return undefined;
    const stat = fs.lstatSync(parent.address, { bigint: true, throwIfNoEntry: false });
    if (stat === undefined) return undefined;
    if (!stat.isFile() && !stat.isSymbolicLink()) this.changed();
    this.verifyLeaf(parent, stat, true);
    let content: Buffer;
    if (stat.isSymbolicLink()) content = fs.readlinkSync(parent.address, { encoding: "buffer" });
    else {
      let fd: number;
      try { fd = fs.openSync(parent.address, fs.constants.O_RDONLY | worktreeMutationCapabilities.noFollow()); }
      catch { this.changed(); }
      try {
        if (!this.same(stat, fs.fstatSync(fd, { bigint: true }))) this.changed();
        content = fs.readFileSync(fd);
      } finally { fs.closeSync(fd); }
    }
    this.verifyLeaf(parent, stat, true);
    return { stat, content };
  }

  /** Erasure alone may unlink a leaf link; require the exact identity inspected before denial. */
  removeForErasure(path: string, expected: BigIntStats): void {
    const parent = this.parent(path, false);
    if (parent === undefined || (!expected.isFile() && !expected.isSymbolicLink())) this.changed();
    this.unlink(parent, expected, true);
  }

  /** Prune only captured empty ordinary directories with non-recursive, verified rmdir. */
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
      if (fs.lstatSync(join(this.directories.get(parent)!.address, name), { throwIfNoEntry: false }) !== undefined) this.changed();
      const fd = this.directories.get(path)!.fd;
      if (fd !== undefined) fs.closeSync(fd);
      this.directories.delete(path);
    }
    this.verify(directory);
    return fs.readdirSync(this.directories.get(directory)!.address).length === 0;
  }

  /** Release every pinned directory, including when a later mutation refuses. */
  close(): void {
    for (const directory of this.directories.values()) {
      if (directory.fd !== undefined) fs.closeSync(directory.fd);
    }
    this.directories.clear();
  }
}
