/** Native SIGKILL cuts exercise durable retirement before the successor exact set is published. */
import { join } from "node:path";
import { destructionBoundary, prepareDestruction } from "../../engine/destruction.ts";
import { durability } from "../../engine/durability.ts";
const [root, rawCut] = process.argv.slice(2); const cut = Number(rawCut); const trace: string[] = [];
destructionBoundary.visit = step => { trace.push(step); if (trace.length === cut) process.kill(process.pid,"SIGKILL"); };
const receipt=durability.scoped(join(root,".pmvcs"),()=>{
 const plan=prepareDestruction(join(root,".pmvcs"),"supersede",["b","c","new"].map(name=>({path:join(root,"data",name)})),false,undefined,false,"reachability_changed");
 for(const path of plan.paths)plan.remove(path);return plan.finish();
});
console.log(JSON.stringify({receipt,trace}));
