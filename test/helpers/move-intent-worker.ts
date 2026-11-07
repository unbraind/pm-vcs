/** Separate OS writer used for contention and fatal staging publication cuts. */
import { Repository } from "../../engine/repo.ts";
import { type MoveIntent } from "../../engine/moves.ts";
const [root, encoded, cut] = process.argv.slice(2);
const intents = JSON.parse(encoded) as MoveIntent[];
const repo = Repository.open(root);
const write = repo.writeIndex.bind(repo);
if (cut !== "none") repo.writeIndex = entries => {
  if (cut === "after") write(entries);
  process.kill(process.pid, "SIGKILL");
};
process.send!("ready");
process.once("message", () => {
  try { repo.stage(intents.map(intent => intent.path), undefined, intents); process.send!({ ok: true }); }
  catch (error) { process.send!({ code: (error as { code?: string }).code, message: String(error) }); }
  process.disconnect!();
});
