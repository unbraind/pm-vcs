/** Measure live staging payloads and real deferred-read drift in an isolated OS process. */
import assert from "node:assert/strict";
import { chmodSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Repository } from "../../engine/repo.ts";
import { readWorkingFile } from "../../engine/worktree.ts";

const [root, mode] = process.argv.slice(2);
const repo = Repository.open(root);
const paths = Array.from({ length: 32 }, (_, i) => `payload-${i}`);
for (const path of paths) writeFileSync(join(root, path), Buffer.alloc(512 * 1024, 65));
if (mode === "mode") {
  const path = join(root, paths[0]); const originalMode = lstatSync(path).mode & 0o777;
  let supported: boolean;
  try { chmodSync(path, 0o755); supported = readWorkingFile(root, paths[0]).executable; }
  finally { chmodSync(path, originalMode); }
  if (!supported) { process.stdout.write(JSON.stringify({ peak: 0, reads: 0, paths: paths.length, skippedMode: true })); process.exit(0); }
}
const preserved = Buffer.from("pre-existing immutable payload"); const preservedId = repo.objects.write("blob", preserved, "f".repeat(32));
const objectsBefore = repo.objects.inventory().map(entry => entry.id);
const ownersBefore = readdirSync(join(repo.controlDirectory, "payload-owners")).sort();
const derivationsBefore = readdirSync(join(repo.controlDirectory, "derivations")).sort().map(name => [name, readFileSync(join(repo.controlDirectory, "derivations", name), "utf8")]);
const headBefore = repo.refs.resolveHead();
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
let retainedObjects: number | undefined;
if (mode === "memory") { repo.stage(paths, read); assert.equal(repo.readIndex().length, paths.length); }
else {
  assert.throws(() => repo.stage(paths, read), { code: "source_changed" }); assert.deepEqual(readFileSync(index), before);
  assert.equal(repo.refs.resolveHead(), headBefore); assert.deepEqual(repo.objects.read(preservedId).payload, preserved);
  assert.deepEqual(repo.objects.inventory().map(entry => entry.id), objectsBefore);
  assert.deepEqual(readdirSync(join(repo.controlDirectory, "payload-owners")).sort(), ownersBefore);
  assert.deepEqual(readdirSync(join(repo.controlDirectory, "derivations")).sort().map(name => [name, readFileSync(join(repo.controlDirectory, "derivations", name), "utf8")]), derivationsBefore);
  assert.deepEqual(readdirSync(repo.controlDirectory).filter(name => name.startsWith("stage-")), []);
  retainedObjects = 0;
  repo.stage(paths); assert.equal(repo.readIndex().length, paths.length);
  for (const entry of repo.readIndex()) assert.deepEqual(repo.objects.read(entry.id).payload, readFileSync(join(root, entry.path)));
}
process.stdout.write(JSON.stringify({ peak, reads, paths: paths.length, retainedObjects }));
