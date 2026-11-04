/** Independent raw filesystem writer intentionally leaves the engine generation and writer lock unchanged. */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
const plan=JSON.parse(readFileSync(process.argv[2],"utf8")) as {loose:{path:string;bytes:string}[];packs:string[]};
// The parent fixture owns these exact sources; unrelated files are never enumerated or deleted.
for(const entry of plan.loose) {
  if(existsSync(entry.path)) unlinkSync(entry.path);
  mkdirSync(dirname(entry.path),{recursive:true}); writeFileSync(entry.path,Buffer.from(entry.bytes,"base64"),{flag:"wx"});
}
for(const path of plan.packs) if(existsSync(path)) unlinkSync(path);
