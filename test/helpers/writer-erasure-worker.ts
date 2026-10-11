/** A real preloaded erasure process for complete-call writer exclusion tests. */
import { existsSync, writeFileSync } from "node:fs";
import { Repository } from "../../engine/repo.ts";

const [root, signal, attempted, result] = process.argv.slice(2);
const repo = Repository.open(root!);
process.stdout.write("ready\n");
const sleeper = new Int32Array(new SharedArrayBuffer(4)); const deadline = performance.now() + 5000;
while (!existsSync(signal!) && performance.now() < deadline) Atomics.wait(sleeper, 0, 0, 5);
if (!existsSync(signal!)) throw new Error("Writer never signaled the waiting erasure.");
writeFileSync(attempted!, "attempted");
repo.obliterate("selected.bin", "erase-fixture", "incident", new Date(2000));
writeFileSync(result!, JSON.stringify({ erased: true }));
