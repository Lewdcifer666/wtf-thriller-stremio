import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wtf-integrity-'));
const write=(dir,file,value)=>{const f=path.join(dir,file);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(value)+'\n');};
function fixture(name){const dir=path.join(tmp,name);fs.mkdirSync(dir,{recursive:true});fs.cpSync(path.join(root,'scripts'),path.join(dir,'scripts'),{recursive:true});return dir;}
function run(dir,script,args=[],expected=0,env={}){const r=spawnSync(process.execPath,[path.join(dir,'scripts',script),...args],{cwd:dir,encoding:'utf8',env:{...process.env,...env}});assert.equal(r.status,expected,`${script}: ${r.stdout}\n${r.stderr}`);return r;}
const item={type:'movie',title:'Fixture',year:2026,imdb_id:'tt1234567',discovery_run_id:'run'};
const log=entry=>({run_id:'run',timestamp:'2026-09-26T08:00:00Z',searched:1,accepted:1,rejected:0,duplicates:0,accepted_items:[entry],rejection_summary:[]});
try{
  const dir=fixture('logs');write(dir,'data/discoveries/run.json',{run_id:'run',items:[item]});
  run(dir,'validate-run-logs.mjs',[],1);fs.mkdirSync(path.join(dir,'data/run-logs'));run(dir,'validate-run-logs.mjs',[],1);
  write(dir,'data/discovery-log.json',{runs:[log(item)]});run(dir,'validate-run-logs.mjs');
  write(dir,'data/run-logs/run.json',log({}));run(dir,'validate-run-logs.mjs',[],1);
  write(dir,'data/run-logs/run.json',log({...item,imdb_id:'tt7654321'}));run(dir,'validate-run-logs.mjs',[],1);
  write(dir,'data/run-logs/run.json',log(item));run(dir,'validate-run-logs.mjs');
  write(dir,'data/run-logs/run.json',log(item.imdb_id));run(dir,'validate-run-logs.mjs');
  const fallback={...item};delete fallback.imdb_id;
  write(dir,'data/library.json',{items:[fallback]});write(dir,'data/discoveries/run.json',{run_id:'run',items:[fallback]});write(dir,'data/run-logs/run.json',log(fallback));
  run(dir,'repair-push-duplicates.mjs',[],0,{ADDED_FILES:'["data/discoveries/run.json"]',MODIFIED_FILES:'[]'});
  run(dir,'validate-run-logs.mjs');const repaired=JSON.parse(fs.readFileSync(path.join(dir,'data/run-logs/run.json')));assert.equal(repaired.accepted,0);assert.deepEqual(repaired.accepted_items,[]);
  // Removing the second copy of an intra-run duplicate must retain the first.
  write(dir,'data/library.json',{items:[]});write(dir,'data/discoveries/run.json',{run_id:'run',items:[item,item]});write(dir,'data/run-logs/run.json',{...log(item),searched:2,accepted:2,accepted_items:[item,item]});
  run(dir,'repair-push-duplicates.mjs',[],0,{ADDED_FILES:'["data/discoveries/run.json"]',MODIFIED_FILES:'[]'});run(dir,'validate-run-logs.mjs');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'data/run-logs/run.json'))).accepted_items.length,1);
  if(fs.existsSync(path.join(root,'scripts/automation-preflight.mjs'))){
    const pre=fixture('preflight');fs.cpSync(path.join(root,'data'),path.join(pre,'data'),{recursive:true});fs.cpSync(path.join(root,'config'),path.join(pre,'config'),{recursive:true});
    write(pre,'candidate.json',[{}, {type:'other',imdb_id:'tt123'}, {type:'movie',title:'   ',year:2026}]);
    const result=JSON.parse(run(pre,'automation-preflight.mjs',['check-strict','candidate.json'],2).stdout);assert.equal(result.eligible_count,0);assert.equal(result.excluded_count,3);
  }
  // CI must enforce explicit user rejections for discoveries too.
  const rejected=fixture('rejected');fs.cpSync(path.join(root,'data'),path.join(rejected,'data'),{recursive:true});fs.cpSync(path.join(root,'config'),path.join(rejected,'config'),{recursive:true});
  const first=JSON.parse(fs.readFileSync(path.join(rejected,'data/library.json'))).items[0];
  if(first){write(rejected,'data/rejections.json',{items:[first]});const result=run(rejected,'validate.mjs',[],1);assert.match(result.stderr,/reject/i);}
}finally{
  assert.equal(path.dirname(path.resolve(tmp)),path.resolve(os.tmpdir()));assert.ok(path.basename(tmp).startsWith('wtf-integrity-'));fs.rmSync(tmp,{recursive:true,force:true});
}
console.log('Automation integrity regressions passed: orphan/malformed logs, legacy support, fallback/intra-run repair, malformed candidates and explicit rejections.');
