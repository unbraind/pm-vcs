/** Measure live staging payloads and real deferred-read drift in an isolated OS process. */
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Repository } from "../../engine/repo.ts";
import { readWorkingFile } from "../../engine/worktree.ts";

const [root, mode] = process.argv.slice(2);
const repo = Repository.open(root);
const paths = Array.from({ length: 32 }, (_, i) => `payload-${i}`);
for (const path of paths) writeFileSync(join(root, path), Buffer.alloc(512 * 1024, 65));
assert.ok(global.gc); global.gc();
const baseline = process.memoryUsage().arrayBuffers;
const index = join(repo.controlDirectory, "index"); const before = readFileSync(index);
let peak = 0; let reads = 0; const visits = new Map<string, number>();
/** Observe live retained bytes, then inject drift only at a real post-plan reread. */
const read: typeof readWorkingFile = (workingRoot, path) => {
  global.gc!(); peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline); reads++;
  const count = (visits.get(path) ?? 0) + 1; visits.set(path, count);
  if (count > 1 && mode === "content") writeFileSync(join(root, path), "concurrent replacement\n");
  if (count > 1 && mode === "mode") chmodSync(join(root, path), 0o755);
  return readWorkingFile(workingRoot, path);
};
if (mode === "memory") { repo.stage(paths, read); assert.equal(repo.readIndex().length, paths.length); }
else { assert.throws(() => repo.stage(paths, read), { code: "source_changed" }); assert.deepEqual(readFileSync(index), before); }
process.stdout.write(JSON.stringify({ peak, reads, paths: paths.length }));
