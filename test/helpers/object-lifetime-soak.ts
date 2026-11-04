/** Run the production streaming decoder repeatedly without an event-loop turn, under the caller's descriptor limit. */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { ObjectStore } from "../../engine/objects.ts";
import { objectFiles } from "../../engine/object-files.ts";
import { exercise, type ExitMode } from "./object-lifetime.ts";
const [root, id, mode] = process.argv.slice(2);
const store = new ObjectStore(root);
// Warm module/runtime bookkeeping before counting OS descriptors, without weakening per-operation equality.
assert.deepEqual(Buffer.concat([...store.readChunks(id,"blob")]),Buffer.from("line-a\nline-b\n"));
const baseline = readdirSync("/proc/self/fd").length;
let reads = 0;
for (let i = 0; i < 10_000; i++) {
  const result = exercise(() => store.readChunks(id,"blob"),mode as ExitMode); reads++;
  if (mode === "error" || mode === "abort") assert.ok(result.injected > 0, "The requested fault must actually run");
  assert.equal(readdirSync("/proc/self/fd").length,baseline,`descriptor leak after operation ${i}`);
  assert.equal(objectFiles.active.size,0,`owned handle leak after operation ${i}`);
}
console.log(JSON.stringify({ reads, mode, baseline, after: readdirSync("/proc/self/fd").length }));
