import fs from "node:fs";
import path from "node:path";

const DIR=path.join("data","run-logs");
const DISC=path.join("data","discoveries");
if (!fs.existsSync(DIR)) {
  console.log("Run-log validation OK: no immutable run logs yet.");
  process.exit(0);
}
const files=fs.readdirSync(DIR).filter(n=>n.toLowerCase().endsWith(".json")).sort();
const seen=new Set();
let errors=0;
const fail=m=>{console.error("run-logs: "+m); errors++;};
const idsOf=arr=>(arr||[]).map(x=>typeof x==="string"?x:x?.imdb_id).filter(Boolean).sort();

for(const name of files){
  let run;
  try { run=JSON.parse(fs.readFileSync(path.join(DIR,name),"utf8")); } catch(e){ fail(`${name}: invalid JSON (${e.message})`); continue; }
  if(!run || Array.isArray(run) || typeof run!=="object"){ fail(`${name}: expected one run object`); continue; }
  if(typeof run.run_id!=="string" || !/^[A-Za-z0-9._-]+$/.test(run.run_id)){ fail(`${name}: invalid run_id`); continue; }
  if(name!==`${run.run_id}.json`) fail(`${name}: filename must equal ${run.run_id}.json`);
  if(seen.has(run.run_id)) fail(`${name}: duplicate run_id ${run.run_id}`); else seen.add(run.run_id);
  if(!Number.isFinite(Date.parse(run.timestamp||""))) fail(`${name}: invalid timestamp`);
  for(const key of ["searched","accepted","rejected","duplicates"]) if(!Number.isInteger(run[key]) || run[key]<0) fail(`${name}: ${key} must be a non-negative integer`);
  if(!Array.isArray(run.accepted_items)) fail(`${name}: accepted_items must be an array`);
  if(Array.isArray(run.accepted_items) && Number.isInteger(run.accepted) && run.accepted_items.length!==run.accepted) fail(`${name}: accepted must equal accepted_items.length`);
  const summary=run.rejection_summary;
  const summaryIsStructured =
    typeof summary==="string" ||
    Array.isArray(summary) ||
    (summary!==null && typeof summary==="object");
  if(!summaryIsStructured) fail(`${name}: rejection_summary must be a string, array, or object`);

  const discoveryPath=path.join(DISC,`${run.run_id}.json`);
  if(run.accepted>0){
    if(!fs.existsSync(discoveryPath)){ fail(`${name}: accepted > 0 but ${discoveryPath} is missing`); continue; }
    try {
      const p=JSON.parse(fs.readFileSync(discoveryPath,"utf8"));
      const items=Array.isArray(p)?p:(p.items||[]);
      if(!Array.isArray(items)) fail(`${discoveryPath}: expected items array`);
      else {
        if(items.length!==run.accepted) fail(`${name}: accepted count does not match discovery item count`);
        const a=idsOf(run.accepted_items), b=idsOf(items);
        if(a.length && JSON.stringify(a)!==JSON.stringify(b)) fail(`${name}: accepted_items IMDb ids do not match discovery file`);
      }
    } catch(e){ fail(`${discoveryPath}: invalid JSON (${e.message})`); }
  } else if(fs.existsSync(discoveryPath)) {
    fail(`${name}: accepted is 0 but a same-run discovery file exists`);
  }
}
if(errors) process.exit(1);
console.log(`Run-log validation OK: ${files.length} immutable run log${files.length===1?"":"s"}.`);
