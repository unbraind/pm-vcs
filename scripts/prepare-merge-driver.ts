/**
 * npm `prepare` hook that registers pm's field-aware Git merge drivers.
 *
 * Git never clones `.git/config`, so every clone must register the drivers
 * `.gitattributes` declares. The installer lives in the devDependency pm-ops,
 * which an `npm install --omit=dev` checkout does not have. This launcher
 * therefore imports nothing from pm-ops: it resolves the installer entry from
 * the package root and runs it in a child process. Only a missing pm-ops package skips, with one
 * notice; any other resolution failure (for example a pm-ops too old to export
 * the entry, or a `pm-ops` directory whose package.json is gone) and any
 * installer failure fail the install.
 * Artifact-time prepare (`npm pack` or `npm publish`) instead exits with one
 * notice before resolving pm-ops, preserving the packing clone's Git config.
 *
 * Canonical copy: `pm-ops/templates/prepare-merge-driver.ts`. Copy it
 * unchanged to `scripts/prepare-merge-driver.ts`.
 */

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// npm also runs prepare while creating artifacts. Git configuration belongs
// to clone installation, so artifact creation must stop before resolution or
// spawning the installer. Keep the install/ci broken-package checks intact.
if (process.env.npm_command === "pack" || process.env.npm_command === "publish") {
  console.error(`npm ${process.env.npm_command}: skipping merge-driver install during artifact creation`);
} else {
  // npm runs `prepare` from the package root, so pm-ops is resolved from there.
  const resolver = createRequire(join(process.cwd(), "package.json"));
  let installer: string | undefined;
  try {
    installer = resolver.resolve("pm-ops/merge-driver/prepare");
  } catch (error) {
    // Only an absent pm-ops package may skip. Probing its package.json tells that
    // apart from an installed pm-ops that cannot serve the entry (exports without
    // it, no exports map, a missing file): those resolve or fail differently, and
    // the original error is rethrown. A probe that finds no package.json is not
    // yet proof of absence: a broken install can leave `node_modules/pm-ops` (a
    // directory or a dangling link) with no package.json in any ancestor Node
    // searches. Such an entry also counts as present. Keep Node's global paths
    // too: the installer resolution above can use them, so an absent local
    // package alone cannot prove absence. An unreadable or malformed lookup path
    // leaves presence uncertain and must fail closed with the original error.
    // Node returns null paths only for built-in modules; pm-ops/package.json is
    // a package specifier.
    let packagePresent = true;
    try {
      resolver.resolve("pm-ops/package.json");
    } catch (probe) {
      packagePresent =
        !(probe instanceof Error && "code" in probe && probe.code === "MODULE_NOT_FOUND") ||
        resolver.resolve.paths("pm-ops/package.json")!.some(
          (directory) => {
            try {
              return lstatSync(join(directory, "pm-ops"), { throwIfNoEntry: false }) !== undefined;
            } catch {
              // throwIfNoEntry:false only suppresses ENOENT, not EACCES, EPERM,
              // ENOTDIR, or ELOOP. Do not replace the installer diagnostic or
              // treat an inconclusive presence check as an omit-dev install.
              return true;
            }
          },
        );
    }
    if (packagePresent) throw error;
  }
  if (installer === undefined) {
    console.error("pm-ops is not installed (omit-dev install); skipping merge-driver install");
  } else {
    process.exitCode = spawnSync(process.execPath, [installer], { stdio: "inherit" }).status ?? 1;
  }
}
