/** Real-process crash and contention probes against one shared non-git tracker. */
import { collectGarbage } from "../../engine/gc.ts";
import { Repository } from "../../engine/repo.ts";
import { join } from "node:path";
import { ObjectStore } from "../../engine/objects.ts";
import { packBoundary } from "../../engine/packs.ts";

const [requested, root, ordinal] = process.argv.slice(2);
const relative = requested.startsWith("relative-");
const action = relative ? requested.slice(9) : requested;
if (relative) process.chdir(root);
const repo = Repository.open(relative ? "." : root);
const store = relative ? new ObjectStore(".pmvcs/objects") : repo.objects;
if (action === "contend") {
  // Exercise the real transition and lease. A stepped clock makes a held-lease refusal immediate.
  let tick = 0; Object.defineProperty(performance, "now", { value: () => tick += 10_000 });
  try { repo.objects.compact(); process.exitCode = 7; }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "store_locked") throw error; }
} else {
  let step = 0;
  packBoundary.visit = () => { if (relative) process.chdir(join(root, "cwd-shadow")); if (++step === Number(ordinal)) process.kill(process.pid, "SIGKILL"); };
  if (action === "compact") { const report = store.compact(); if (relative) process.stdout.write(JSON.stringify({ status: report.destruction.status })); }
  else if (action === "unpack") { store.unpack(); if (relative) process.stdout.write(JSON.stringify({ status: "completed" })); }
  else if (action === "gc") { const report = collectGarbage(repo, true); if (relative) process.stdout.write(JSON.stringify({ status: report.destruction?.status })); }
  else repo.obliterate("asset", "erase-fixture", "fixture-cleanup", new Date(1));
}
