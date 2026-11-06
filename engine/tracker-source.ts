/** Confined SDK reads: provenance belongs to the opened objects, never a later pathname check. */
import { constants, fstatSync, lstatSync, readlinkSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isControlPath } from "./ignore.ts";
import { objectFiles, type ObjectFile } from "./object-files.ts";
import { ObjectStoreError } from "./objects.ts";
import { worktreeMutationCapabilities } from "./worktree-mutation.ts";

/** Synchronous scheduling seam; tests mutate real files from a separate OS process. @internal */
export const trackerSourceBoundary: { visit(step: string, path: string): void } = { visit() {} };

/** Retained source identity, addressed only through its pinned parent (or the root anchor). */
interface Source {
  readonly address: string;
  readonly stat: BigIntStats;
  readonly file?: ObjectFile;
}

/** Device and inode bind a descriptor to the object checked before open. */
function sameIdentity(expected: BigIntStats, actual: BigIntStats | undefined): boolean {
  return actual !== undefined && expected.dev === actual.dev && expected.ino === actual.ino;
}

/** Content and link changes invalidate the read even when the inode remains the same. */
function sameContent(expected: BigIntStats, actual: BigIntStats): boolean {
  return [expected.size, expected.mtimeNs, expected.ctimeNs, expected.mode, expected.nlink].join(":")
    === [actual.size, actual.mtimeNs, actual.ctimeNs, actual.mode, actual.nlink].join(":");
}

/** Refuse a changed source before any captured buffer reaches native object storage. */
function changed(): never { throw new ObjectStoreError("tracker_source_changed", "Tracker source identity changed during capture; retry the pair."); }

/** Preserve the existing refusal for external, chained, control or ancestor links. */
function ignored(): never { throw new ObjectStoreError("path_ignored", "Captured tracker paths must be visible, permitted, workspace-local files."); }

/** Run the existing SDK reader against a confined file descriptor and certify its exact source.
 * Direct leaf links to ordinary workspace files retain their existing dereferenced semantics.
 * Every ancestor and target is opened with O_NOFOLLOW under a retained directory descriptor.
 * Checks bracket the SDK read, including its asynchronous hooks; immutable verified bytes can
 * then outlive their live paths. Without descriptor addressing, fail closed rather than use a
 * pathname-only fallback whose ancestor ABA race cannot be certified by Node's filesystem API.
 */
export async function readTrackerSource<T>(root: string, path: string, read: (address: string) => Promise<T>): Promise<T> {
  if (!worktreeMutationCapabilities.descriptorPaths()) throw new ObjectStoreError("tracker_source_unsupported", "Tracker capture requires confined descriptor paths on this platform.");
  const sources: Source[] = [];
  const canonicalRoot = realpathSync(root);
  /** Register ownership before checking fstat so every failure closes all acquired handles. */
  const open = (address: string, stat: BigIntStats, directory: boolean, coordinate: string): ObjectFile => {
    trackerSourceBoundary.visit("checked", coordinate);
    const file = objectFiles.open(address, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : constants.O_NONBLOCK));
    sources.push({ address, stat, file });
    const held = fstatSync(file.fd, { bigint: true });
    if (!sameIdentity(stat, held)) changed();
    return file;
  };
  /** Validate the entire retained topology, then the file/link content stamps. */
  const verify = (): void => {
    for (const source of sources) {
      const named = lstatSync(source.address, { bigint: true, throwIfNoEntry: false });
      const held = source.file === undefined ? source.stat : fstatSync(source.file.fd, { bigint: true });
      for (const observed of [named, held]) {
        if (!sameIdentity(source.stat, observed) || (!source.stat.isDirectory() && !sameContent(source.stat, observed!))) changed();
      }
    }
  };
  try {
    const rootStat = lstatSync(canonicalRoot, { bigint: true });
    if (!rootStat.isDirectory()) changed();
    const anchor = open(canonicalRoot, rootStat, true, "");
    /** Resolve a canonical coordinate using only pinned parent descriptors; at most one leaf link. */
    const locate = (coordinate: string, allowLink: boolean): ObjectFile => {
      if (isAbsolute(coordinate) || coordinate.split(sep).some(part => ["", ".", ".."].includes(part)) || isControlPath(coordinate.split(sep).join("/"))) ignored();
      let parent = anchor;
      const parts = coordinate.split(sep);
      for (const [index, part] of parts.entries()) {
        const address = join(`/proc/self/fd/${parent.fd}`, part);
        const stat = lstatSync(address, { bigint: true });
        const leaf = index === parts.length - 1;
        if (stat.isSymbolicLink()) {
          if (!leaf || !allowLink) ignored();
          sources.push({ address, stat });
          const target = relative(canonicalRoot, resolve(canonicalRoot, dirname(coordinate), readlinkSync(address)));
          return locate(target, false);
        }
        if (leaf ? !stat.isFile() : !stat.isDirectory()) changed();
        parent = open(address, stat, !leaf, parts.slice(0, index + 1).join("/"));
      }
      return parent;
    };
    const file = locate(path.split("/").join(sep), true);
    verify();
    trackerSourceBoundary.visit("opened", path);
    verify();
    const result = await read(`/proc/self/fd/${file.fd}`);
    trackerSourceBoundary.visit("read", path);
    verify();
    return result;
  } finally { for (const source of sources.reverse()) source.file?.close(); }
}
