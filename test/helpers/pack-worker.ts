/** Real-process crash and contention probes against one shared non-git tracker. */
import { collectGarbage } from "../../engine/gc.ts";
import { Repository } from "../../engine/repo.ts";
import { packBoundary } from "../../engine/packs.ts";

const [action, root, ordinal] = process.argv.slice(2);
const repo = Repository.open(root);
if (action === "contend") {
  // Exercise the real transition and lease. A stepped clock makes a held-lease refusal immediate.
  let tick = 0; Object.defineProperty(performance, "now", { value: () => tick += 10_000 });
  try { repo.objects.compact(); process.exitCode = 7; }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "store_locked") throw error; }
} else {
  let step = 0;
  packBoundary.visit = () => { if (++step === Number(ordinal)) process.kill(process.pid, "SIGKILL"); };
  if (action === "compact") repo.objects.compact();
  else if (action === "unpack") repo.objects.unpack();
  else if (action === "gc") collectGarbage(repo, true);
  else repo.obliterate("asset", "erase-fixture", "fixture-cleanup", new Date(1));
}
