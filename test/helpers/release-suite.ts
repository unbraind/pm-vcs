/** Keep ordinary file parallelism separate from matrices that already own the runner's cores. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
const packageRoot = process.cwd();
const files = readdirSync(join(packageRoot, "test")).filter(name => name.endsWith(".test.ts")).sort();
const serialNames = new Set(["erasure-accountability.test.ts", "erasure-lifecycle.test.ts", "erasure-storage.test.ts", "exact-gates.test.ts"]);
const ordinary = files.filter(name => !serialNames.has(name)); const serial = files.filter(name => serialNames.has(name));
assert.ok(files.length > 0, "the release suite must discover tests");
assert.deepEqual([...ordinary, ...serial].sort(), files, "every test file must run exactly once");
for (const [batch, concurrency] of [[ordinary, Math.min(4, availableParallelism())], [serial, 1]] as const) {
  if (batch.length === 0) continue;
  console.log(JSON.stringify({ releaseTestFiles: batch.length, concurrency }));
  const result = spawnSync(process.execPath, ["--expose-gc", "--no-concurrent-array-buffer-sweeping", "--test", `--test-concurrency=${concurrency}`, ...batch.map(name => join("test", name))], { cwd: packageRoot, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
