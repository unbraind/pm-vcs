/** Build one fresh artifact for installed tracker-admission acceptance without running pack hooks. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { testEnvironment } from "./test-environment.ts";

/** Build before packing, retaining the exact artifact and its digest for every install layout. */
export function trackerAdmissionArtifact(packageRoot: string, destination: string): { archive: string; digest: string } {
  const options = { cwd: packageRoot, env: testEnvironment({ NPM_CONFIG_USERCONFIG: process.platform === "win32" ? "NUL" : "/dev/null" }), encoding: "utf8" as const, timeout: 180000 };
  execFileSync("npm", ["run", "build"], options);
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], options);
  const archive = join(destination, readdirSync(destination).find(name => name.endsWith(".tgz"))!);
  return { archive, digest: createHash("sha256").update(readFileSync(archive)).digest("hex") };
}
