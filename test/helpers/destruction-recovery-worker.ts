/** Native recovery preflight crash worker; the request is identical on every retry. */
import { Repository } from "../../engine/repo.ts";
import { destructionBoundary } from "../../engine/destruction.ts";
const [root, fileId, rawCut] = process.argv.slice(2); const cut = Number(rawCut); const trace: string[] = [];
destructionBoundary.visit = step => { if (!step.startsWith("recovery-")) return; trace.push(step); if (trace.length === cut) process.kill(process.pid, "SIGKILL"); };
const receipt = Repository.open(root).obliterate(fileId, "erase-fixture", "incident", new Date(1), { purgeUnaccounted: true, recoverLock: true });
console.log(JSON.stringify({ trace, accountable: receipt.storage.accountable, destruction: receipt.destruction }));
