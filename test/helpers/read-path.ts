import fs from "node:fs";
import { mock } from "node:test";

/** Match both a pathname read and a read from a live descriptor opened for that path. */
export function watchReadPath(path: string): (input: unknown) => boolean {
  const active = new Set<number>();
  const open = fs.openSync;
  const close = fs.closeSync;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (args[0] === path) active.add(fd);
    return fd;
  });
  mock.method(fs, "closeSync", (fd: number) => {
    active.delete(fd);
    close(fd);
  });
  return input => input === path || (typeof input === "number" && active.has(input));
}
