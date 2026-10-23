/**
 * Frozen v1 bootstrap: copy unchanged once; behavior lives in pm-ops.
 * Keep dependency-free absence checks here so omit-dev installs can succeed.
 * Changes require a new launcher version and retention of this hash.
 */
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

if (process.env.npm_command === "pack" || process.env.npm_command === "publish") {
  console.error(`npm ${process.env.npm_command}: skipping merge-driver install during artifact creation`);
} else {
  const resolver = createRequire(join(process.cwd(), "package.json"));
  let installer: string | undefined;
  try {
    installer = resolver.resolve("pm-ops/merge-driver/prepare");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    // Metadata also detects self-references; physical entries include broken links.
    let present = true;
    try {
      resolver.resolve("pm-ops/package.json");
    } catch (probe) {
      present = (probe as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND" ||
        resolver.resolve.paths("pm-ops/package.json")!.some((directory) => {
          try {
            return lstatSync(join(directory, "pm-ops"), { throwIfNoEntry: false }) !== undefined;
          } catch {
            return true;
          }
        });
    }
    if (present) throw error;
  }
  if (installer === undefined) {
    console.error("pm-ops is not installed (omit-dev install); skipping merge-driver install");
  } else {
    process.exitCode = spawnSync(process.execPath, [installer], { stdio: "inherit" }).status ?? 1;
  }
}
