/** Interrupt the real erasure implementation, leaving only its durable state for an authorized retry. */
import { Repository } from "../../engine/repo.ts";
import { erasureScanBoundary } from "../../engine/erasure-scan.ts";
const [root,id,ordinal]=process.argv.slice(2); let count=0;
erasureScanBoundary.visit=()=>{if(++count===Number(ordinal))process.kill(process.pid,"SIGKILL");};
Repository.open(root).obliterate(id,"erase-fixture","incident",new Date(1));
