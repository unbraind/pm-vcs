/** A competing process uses the real writer lease and reports only its actual erasure outcome. */
import { Repository } from "../../engine/repo.ts";
const [root,id,mode]=process.argv.slice(2);
if(mode==="blocked") {let tick=0;Object.defineProperty(performance,"now",{value:()=>tick+=10_000});}
try { const receipt=Repository.open(root).obliterate(id,"erase-fixture","incident",new Date(1)); if(mode==="blocked")process.exitCode=7;else console.log(JSON.stringify(receipt)); }
catch(error){if(mode!=="blocked"||!(error instanceof Error)||!("code" in error)||error.code!=="store_locked")throw error;console.log("store_locked");}
