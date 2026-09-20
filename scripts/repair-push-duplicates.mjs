import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { identityKey } from "./identity.mjs";
import { normalizeTitle } from "./cinemeta.mjs";

function parseJsonArrayEnv(name){const raw=process.env[name];if(!raw)return[];try{const v=JSON.parse(raw);return Array.isArray(v)?v.filter(x=>typeof x==="string"):[]}catch{return[]}}
function gitChangedDiscoveryFiles(){try{return execFileSync("git",["diff","--name-only","HEAD^","HEAD","--","data/discoveries"],{encoding:"utf8"}).split(/\r?\n/).map(x=>x.trim()).filter(Boolean)}catch{return[]}}
const itemKey=item=>identityKey(item,normalizeTitle);
const itemLabel=(item,key)=>{const t=typeof item?.title==="string"&&item.title.trim()?item.title.trim():key;return item?.imdb_id?`${t} (${item.imdb_id})`:t};
const touched=new Set([...parseJsonArrayEnv("ADDED_FILES"),...parseJsonArrayEnv("MODIFIED_FILES"),...gitChangedDiscoveryFiles()]);
const targetPaths=[...touched].filter(f=>/^data\/discoveries\/[^/]+\.json$/i.test(f)).filter(f=>fs.existsSync(f)).sort();
if(!targetPaths.length){console.log("Duplicate repair: this push did not add or modify a discovery JSON file.");process.exit(0)}

const library=JSON.parse(fs.readFileSync("data/library.json","utf8"));
const seen=new Set((library.items||[]).map(itemKey));
const targetSet=new Set(targetPaths.map(f=>path.normalize(f)));
const discoveryDir=path.join("data","discoveries");
if(fs.existsSync(discoveryDir))for(const name of fs.readdirSync(discoveryDir).filter(x=>x.toLowerCase().endsWith(".json")).sort()){const file=path.join(discoveryDir,name);if(targetSet.has(path.normalize(file)))continue;const p=JSON.parse(fs.readFileSync(file,"utf8"));const items=Array.isArray(p)?p:p.items;if(Array.isArray(items))for(const item of items)seen.add(itemKey(item))}

const removedByRun=new Map(),survivorsByRun=new Map();let totalRemoved=0;
for(const file of targetPaths){
 const payload=JSON.parse(fs.readFileSync(file,"utf8")); const items=Array.isArray(payload)?payload:payload.items;
 if(!Array.isArray(items))throw new Error(`${file}: expected an items array; leaving validation to fail closed.`);
 const survivors=[],removed=[];
 for(const item of items){const key=itemKey(item);if(seen.has(key))removed.push({item,key});else{seen.add(key);survivors.push(item)}}
 const runId=Array.isArray(payload)?(survivors[0]?.discovery_run_id||removed[0]?.item?.discovery_run_id):payload.run_id;
 if(runId)survivorsByRun.set(runId,survivors);
 if(!removed.length)continue;
 totalRemoved+=removed.length;if(runId)removedByRun.set(runId,[...(removedByRun.get(runId)||[]),...removed]);
 if(!survivors.length){fs.unlinkSync(file);console.log(`Duplicate repair: removed empty discovery file ${file}.`)}
 else fs.writeFileSync(file,JSON.stringify(Array.isArray(payload)?survivors:{...payload,items:survivors},null,2)+"\n");
 for(const e of removed)console.log(`Duplicate repair: removed ${itemLabel(e.item,e.key)} because ${e.key} already exists.`);
}
if(!totalRemoved){console.log("Duplicate repair: no duplicates introduced by this push.");process.exit(0)}

function updateRunObject(run,removed,survivors){
 const removedIds=new Set(removed.map(x=>x.item?.imdb_id).filter(Boolean));
 run.duplicates=(Number.isInteger(run.duplicates)?run.duplicates:0)+removed.length;
 run.accepted=survivors.length;
 if(Array.isArray(run.accepted_items)) run.accepted_items=run.accepted_items.filter(x=>!removedIds.has(typeof x==="string"?x:x?.imdb_id));
 else run.accepted_items=survivors.map(item=>({imdb_id:item.imdb_id,type:item.type,title:item.title,match_score:item.match_score})).filter(x=>x.imdb_id);
 const labels=removed.map(x=>itemLabel(x.item,x.key)).join(", ");
 const base=typeof run.rejection_summary==="string"?run.rejection_summary.trim():"";
 const sentence=`Automatic duplicate repair removed ${labels} because ${removed.length===1?"its public identity already exists":"their public identities already exist"}; this supersedes any earlier duplicate-count statement for this run.`;
 run.rejection_summary=base?`${base} ${sentence}`:sentence;
}

let legacy=null,legacyChanged=false;
for(const [runId,removed] of removedByRun){
 const survivors=survivorsByRun.get(runId)||[];
 const runPath=path.join("data","run-logs",`${runId}.json`);
 if(fs.existsSync(runPath)){
   const run=JSON.parse(fs.readFileSync(runPath,"utf8")); updateRunObject(run,removed,survivors); fs.writeFileSync(runPath,JSON.stringify(run,null,2)+"\n"); continue;
 }
 if(!legacy){
   const legacyPath="data/discovery-log.json";
   if(!fs.existsSync(legacyPath))throw new Error(`Duplicate repair removed public items but no immutable run log or legacy discovery log exists for ${runId}.`);
   legacy=JSON.parse(fs.readFileSync(legacyPath,"utf8"));
   if(!Array.isArray(legacy.runs))throw new Error("data/discovery-log.json: expected runs array.");
 }
 const run=legacy.runs.find(x=>x?.run_id===runId);
 if(!run)throw new Error(`Duplicate repair could not find run metadata for ${runId}.`);
 updateRunObject(run,removed,survivors); legacyChanged=true;
}
if(legacyChanged)fs.writeFileSync("data/discovery-log.json",JSON.stringify(legacy)+"\n");
console.log(`Duplicate repair complete: removed ${totalRemoved} duplicate item${totalRemoved===1?"":"s"} before validation.`);
