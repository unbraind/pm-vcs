/** Interrupt every native step of the package's atomic verification and denial writes on one tracker. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { Repository } from "../../engine/repo.ts";
const [root,id,ordinal]=process.argv.slice(2);const steps:string[]=[];const opened=new Map<number,string>();
/** Classify only package-written proof and denial filenames; other storage is never intercepted. */
function owned(value:unknown):string|undefined {
  const path=typeof value==="number"?opened.get(value):typeof value==="string"?value:undefined;
  return path!==undefined&&/^(?:erasure-verification|denials)\.json(?:\.[0-9a-f]{12}\.tmp)?$/.test(basename(path))?basename(path).startsWith("erasure")?"proof":"denial":undefined;
}
for(const name of ["openSync","closeSync","writeFileSync","fsyncSync","renameSync","rmSync"] as const) {
  const original=fs[name];
  /** Stop immediately before or after the real native operation, preserving actual durable intermediates. */
  const wrapped=(...args:unknown[]):unknown=>{
    const kind=owned(args[0]);
    if(kind!==undefined){steps.push(`${kind}:${name}:before`);if(steps.length===Number(ordinal))process.kill(process.pid,"SIGKILL");}
    const result:unknown=Reflect.apply(original,fs,args);
    if(name==="openSync"&&typeof result==="number"&&typeof args[0]==="string")opened.set(result,args[0]);
    if(kind!==undefined){steps.push(`${kind}:${name}:after`);if(steps.length===Number(ordinal))process.kill(process.pid,"SIGKILL");}
    if(name==="closeSync")opened.delete(args[0] as number);
    return result;
  };
  Object.defineProperty(fs,name,{value:wrapped});
}
syncBuiltinESMExports();Repository.open(root).obliterate(id,"erase-fixture","incident",new Date(1));console.log(JSON.stringify(steps));
