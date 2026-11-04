/** Native crash/drainer worker: only a fully recorded set can change the shared non-git fixture. */
import { join, relative } from "node:path";
import { durability } from "../../engine/durability.ts";
import { destructionBoundary, prepareDestruction } from "../../engine/destruction.ts";
const [root, mode, rawCut = "0"] = process.argv.slice(2); const control = join(root, ".pmvcs"); const paths = ["a", "b", "c"].map(name => join(root, "data", name)); const cut = Number(rawCut); const trace: string[] = [];
destructionBoundary.visit = (step, path) => { trace.push(`${step}:${relative(root, path).replaceAll("\\", "/")}`); if (mode === "crash" && trace.length === cut) process.kill(process.pid, "SIGKILL"); if (mode === "dead-crash" && step === "dead-lock-checked") process.kill(process.pid, "SIGKILL"); };
try {
  const result = durability.scoped(control, () => { const plan = prepareDestruction(control, "shared-drain", paths.map(path => ({ path }))); for (const path of plan.paths) plan.remove(path); return { resumed: plan.resumed, receipt: plan.finish() }; });
  console.log(JSON.stringify({ ...result, trace }));
} catch (error) {
  if (mode !== "blocked") throw error;
  console.log(JSON.stringify({ code: (error as { code: string }).code }));
}
