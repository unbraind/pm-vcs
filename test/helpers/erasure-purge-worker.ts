/** SIGKILL real purge publication and retirement native steps; no JavaScript cleanup runs. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { Repository } from "../../engine/repo.ts";
import { destructionBoundary } from "../../engine/destruction.ts";
const [root,id,ordinal]=process.argv.slice(2);const repo=Repository.open(root);const steps:string[]=[];const opened=new Map<number,string>();let active=false;let finishing=false;
const processPrefix=`owner-${createHash("sha256").update("oplog.jsonl.lock").digest("hex").slice(0,24)}-`;
if(ordinal==="owner-published")destructionBoundary.visit=(step,path)=>{if(step==="process-owner-published"&&path===join(repo.controlDirectory,"oplog.jsonl.lock"))process.kill(process.pid,"SIGKILL");};
/** Classify only the current purge journal, its barriers and this worker's selected foreign leaf. */
function kind(value:unknown):string|undefined{
 const path=typeof value==="number"?opened.get(value):typeof value==="string"?value:undefined;if(path===undefined)return undefined;
 if(ordinal==="stage-flushed"&&basename(path).startsWith(processPrefix))return"process-stage";
 if(ordinal==="log-flushed"&&path===join(repo.controlDirectory,"oplog.jsonl"))return"operation-log";
 if(basename(path)==="unaccounted-purge")return"leaf";
 if(/^erasure-purge\.json(?:\.[0-9a-f]{12}\.tmp)?$/.test(basename(path)))return"journal";
 if(active&&(path===repo.controlDirectory||path===repo.objects.storageRoot()))return"directory";
 return undefined;
}
for(const name of ["openSync","closeSync","writeFileSync","fsyncSync","renameSync","rmSync","unlinkSync"] as const){
 const original=fs[name];
 /** Stop on both sides of the real operation, so crashes cannot manufacture a successful receipt. */
 const wrapped=(...args:unknown[]):unknown=>{
  const label=kind(args[0]);if(label==="journal"&&name==="writeFileSync")active=true;
  if(label!==undefined){steps.push(`${label}:${name}:before`);if(steps.length===Number(ordinal))process.kill(process.pid,"SIGKILL");}
  const result:unknown=Reflect.apply(original,fs,args);
  if(name==="fsyncSync"&&(label==="process-stage"||label==="operation-log"))process.kill(process.pid,"SIGKILL");
  if(name==="openSync"&&typeof result==="number"&&typeof args[0]==="string")opened.set(result,args[0]);
  if(label!==undefined){steps.push(`${label}:${name}:after`);if(steps.length===Number(ordinal))process.kill(process.pid,"SIGKILL");}
  if((label==="journal"&&name==="rmSync")||(label==="leaf"&&name==="unlinkSync")){active=true;finishing=true;}
  if(name==="closeSync"){opened.delete(args[0] as number);if(label==="directory"&&finishing){active=false;finishing=false;}}
  return result;
 };
 Object.defineProperty(fs,name,{value:wrapped});
}
syncBuiltinESMExports();repo.obliterate(id,"erase-fixture","incident",new Date(1),{purgeUnaccounted:true});console.log(JSON.stringify(steps));
