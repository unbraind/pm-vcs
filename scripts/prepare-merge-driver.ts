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
 *
 * Canonical copy: `pm-ops/templates/prepare-merge-driver.ts`. Copy it
 * unchanged to `scripts/prepare-merge-driver.ts`.
 */

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

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
  // directory or a dangling link) with no package.json, which fails the probe
  // the same way, so an entry there also counts as present.
  let packagePresent = true;
  try {
    resolver.resolve("pm-ops/package.json");
  } catch (probe) {
    packagePresent =
      !(probe instanceof Error && "code" in probe && probe.code === "MODULE_NOT_FOUND") ||
      lstatSync(join(process.cwd(), "node_modules", "pm-ops"), { throwIfNoEntry: false }) !== undefined;
  }
  if (packagePresent) throw error;
}
if (installer === undefined) {
  console.error("pm-ops is not installed (omit-dev install); skipping merge-driver install");
} else {
  process.exitCode = spawnSync(process.execPath, [installer], { stdio: "inherit" }).status ?? 1;
}
