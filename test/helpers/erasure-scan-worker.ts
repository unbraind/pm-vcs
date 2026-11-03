/** Interrupt the real erasure implementation, leaving only its durable state for an authorized retry. */
import fs from "node:fs";
import { Repository } from "../../engine/repo.ts";
import { erasureScanBoundary } from "../../engine/erasure-scan.ts";
if(process.env.CRASH_TIMING==="1")fs.writeSync(3,`${performance.timeOrigin+performance.now()}\n`);
const [root,id,ordinal]=process.argv.slice(2);const steps:string[]=[];
erasureScanBoundary.visit=step=>{steps.push(step);if(steps.length===Number(ordinal)){if(process.env.CRASH_TIMING==="1")fs.writeSync(3,`${JSON.stringify({at:performance.timeOrigin+performance.now(),steps})}\n`);process.kill(process.pid,"SIGKILL");}};
Repository.open(root).obliterate(id,"erase-fixture","incident",new Date(1));
console.log(JSON.stringify(steps));
