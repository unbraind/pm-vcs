import fs, { type BigIntStats, constants } from "node:fs";
import { ObjectStoreError } from "./object-error.ts";

/** Open for descriptor validation. Bitwise OR treats flags absent on this platform as zero. */
export const regularReadFlags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/** Open a regular leaf and retain the inode identity when the caller already observed it. */
export function openRegularFile(path: string, expected?: Pick<BigIntStats, "dev" | "ino">): { fd: number; stat: BigIntStats } {
  const fd = fs.openSync(path, regularReadFlags);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || (expected !== undefined && (stat.dev !== expected.dev || stat.ino !== expected.ino))) {
      throw new ObjectStoreError("worktree_path_changed", "File changed while it was being read.");
    }
    return { fd, stat };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** Read bytes and metadata from one validated regular descriptor. */
export function readRegularFile(path: string, expected?: BigIntStats): { content: Buffer; stat: BigIntStats } {
  const { fd, stat } = openRegularFile(path, expected);
  try {
    return { content: fs.readFileSync(fd), stat };
  } finally {
    fs.closeSync(fd);
  }
}

/** Decode a UTF-8 control record after validating the opened regular leaf. */
export function readRegularText(path: string, expected?: BigIntStats): string {
  const { fd } = openRegularFile(path, expected);
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}
