// One real child process for the instance-concurrency test.
//
// The test that spawns this file needs two working trees committing
// simultaneously against one shared object store; a mock could only assert
// against its own assumptions about interleaving. This worker opens its own
// linked instance, waits on a start barrier so both workers genuinely overlap
// in time, then commits a fixed number of revisions on its own branch — first
// one commit whose content is byte-identical across workers, so both race to
// write the same object, then per-worker revisions.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Repository } from "../../engine/repo.ts";

const [root, goFile, label, countText] = process.argv.slice(2);
if (root === undefined || goFile === undefined || label === undefined || countText === undefined) {
  console.error("usage: instance-worker.ts <instance-root> <go-file> <label> <count>");
  process.exit(2);
}
const count = Number(countText);

// Start barrier: spin until the parent signals, bounded so a lost signal fails
// the worker loudly instead of hanging the test run.
const deadline = Date.now() + 10_000;
while (!existsSync(goFile)) {
  if (Date.now() > deadline) {
    console.error(`instance-worker ${label}: start barrier timed out`);
    process.exit(3);
  }
}

const repository = Repository.open(root);
const author = { name: `Worker ${label}`, email: "worker@local", timestamp: 1_000, timezoneOffsetMinutes: 0 };
// Identical bytes from every worker: both compute one object id and both race
// to write it into the shared store, which must end with one intact object.
writeFileSync(join(root, "shared.txt"), "identical bytes from every worker\n");
repository.stage(["shared.txt"]);
repository.commit({ message: `shared ${label}\n`, author }, new Date(1_000));
for (let index = 0; index < count; index += 1) {
  writeFileSync(join(root, `${label}.txt`), `${label} revision ${index}\n`);
  repository.stage([`${label}.txt`]);
  repository.commit({ message: `${label} ${index}\n`, author }, new Date(2_000 + index));
}
