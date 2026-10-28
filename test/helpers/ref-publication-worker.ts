import "./isolate-session.ts";
/** Real process death around a ref's durable prepared and published boundaries. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { destructionBoundary } from "../../engine/destruction.ts";
import { Repository } from "../../engine/repo.ts";
const [root, name, expected, next, mode] = process.argv.slice(2);
const repo = Repository.open(root!);
destructionBoundary.visit = (step, path) => {
  if (mode === "prepared" && step === "before-delete") {
    try { if (readFileSync(resolve(repo.controlDirectory, path), "utf8") === `${next}\n`) process.kill(process.pid, "SIGKILL"); } catch { /* Other owned control leaves have no ref bytes. */ }
  }
  if ((mode === "replayed" && step === "deleted" || mode === "acknowledged" && step === "progress-persisted") && readFileSync(join(repo.controlDirectory, name!), "utf8").trim() === next) process.kill(process.pid, "SIGKILL");
};
repo.refs.compareAndSwap(name!, expected === "null" ? null : expected!, next!);
