import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wtf-build-state-'));
const generated=Date.parse('2026-09-25T12:00:00Z'), expiry=generated+72*3600000;
const item={type:'movie',imdb_id:'tt1234567',title:'Fixture',year:2026,status:'watch',dna:{mystery:7},dna_confidence:1,reason:'Test'};
const profile={dna_dimensions:{dimensions:[{id:'mystery'}]},dna_baseline:{weights:{mystery:1},archetypes:[],completeness_defaults:{min_known_dimensions:1,min_confidence:.5,required_known_dimensions:['mystery']}},dna_guardrails:{hard_exclusion:[],combination:[]},execution_preferences:{content_vs_execution:{content_fit:.8,execution_fit:.2}},automation_rules:{minimum_match_score:50,best_match_score:80}};
const catalogs={manifest:{id:'test.state',name:'Test',version:'1',description:'Test'},catalogs:[{id:'dna-match',name:'DNA Match',filter:'dna',sort:'dna',min_score:50,dna:{mode:'baseline_profile',archetype_bonus_max:0}}]};
function write(f,x){fs.mkdirSync(path.dirname(path.join(tmp,f)),{recursive:true});fs.writeFileSync(path.join(tmp,f),JSON.stringify(x)+'\n');}
function run(script,now,args=[],ok=true){
  const code=`Date.now=()=>${now};process.argv=[process.execPath,${JSON.stringify(script)},...${JSON.stringify(args)}];globalThis.fetch=async()=>({ok:true,json:async()=>({metas:[{id:'tt1234567',type:'movie',name:'Fixture',releaseInfo:'2026'}]})});await import(${JSON.stringify(pathToFileURL(path.join(tmp,'scripts',script)).href)});`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:tmp,encoding:'utf8'});
  if(ok)assert.equal(r.status,0,r.stderr);else assert.notEqual(r.status,0,'expected stale/tampered receipt rejection');
  return r;
}
const state=()=>JSON.parse(fs.readFileSync(path.join(tmp,'data/automation-state.json')));
const receipt=()=>JSON.parse(fs.readFileSync(path.join(tmp,'site/automation-state.json')));
try{
  fs.cpSync(path.join(root,'scripts'),path.join(tmp,'scripts'),{recursive:true});
  write('data/library.json',{items:[item]});write('data/taste-profile.json',profile);write('config/catalogs.json',catalogs);
  write('data/personalized-scores.json',{schema_version:1,generated_at:'2026-09-25T12:00:00Z',items:{tt1234567:{dna_match:100,execution_fit:100}}});
  const snapshotBytes=fs.readFileSync(path.join(tmp,'data/personalized-scores.json'));
  run('build-site.mjs',expiry);
  assert.match(fs.readFileSync(path.join(tmp,'site/catalog/movie/dna-match-movie.json'),'utf8'),/DNA Match 100\/100/);
  run('export-automation-state.mjs',expiry+1000,['data/automation-state.json','--from-build','site/automation-state.json']);
  const applied=state();assert.equal(applied.personalization_enabled,true);assert.deepEqual(applied,receipt().state,'state must describe the artifact despite later expiry');
  run('export-automation-state.mjs',expiry+1000);const stale=state();assert.equal(stale.personalization_status,'stale');assert.notEqual(stale.state_token,applied.state_token);
  run('export-automation-state.mjs',expiry+2000);assert.equal(state().state_token,stale.state_token,'stable state must not churn its token with time');
  if(fs.existsSync(path.join(tmp,'scripts/automation-preflight.mjs'))){const pre=JSON.parse(run('automation-preflight.mjs',expiry+2000,['snapshot']).stdout);assert.equal(pre.state_token,stale.state_token);}
  // A future-dated snapshot enters the accepted skew window without byte changes.
  run('export-automation-state.mjs',generated-3600001);const future=state();run('export-automation-state.mjs',generated-3600000);assert.equal(state().personalization_enabled,true);assert.notEqual(state().state_token,future.state_token);
  const unresolved={...item};delete unresolved.imdb_id;write('data/library.json',{items:[unresolved]});
  run('build-site.mjs',generated);assert.equal(receipt().state.personalization_enabled,true,'resolved IDs must count as applied');
  run('export-automation-state.mjs',generated);assert.deepEqual(state(),receipt().state,'standalone exporter must use the same resolver');
  const before=fs.readFileSync(path.join(tmp,'data/automation-state.json'));
  const seedFile=path.join(tmp,'scripts/known-ids.mjs'), seedBytes=fs.readFileSync(seedFile);
  fs.appendFileSync(seedFile,'\n// Changed resolver mapping input\n');
  run('export-automation-state.mjs',generated,['data/automation-state.json','--from-build','site/automation-state.json'],false);
  run('export-automation-state.mjs',generated);assert.notEqual(state().state_token,receipt().state.state_token,'resolver mappings must affect the token');
  fs.writeFileSync(seedFile,seedBytes);fs.writeFileSync(path.join(tmp,'data/automation-state.json'),before);
  write('data/library.json',{items:[{...item,title:'Changed source'}]});
  run('export-automation-state.mjs',generated,['data/automation-state.json','--from-build','site/automation-state.json'],false);
  assert.deepEqual(fs.readFileSync(path.join(tmp,'data/automation-state.json')),before,'rejected export preserves previous output');
  assert.deepEqual(fs.readFileSync(path.join(tmp,'data/personalized-scores.json')),snapshotBytes,'never rewrite the snapshot timestamp');
  fs.unlinkSync(path.join(tmp,'data/personalized-scores.json'));fs.mkdirSync(path.join(tmp,'data/personalized-scores.json'));
  run('build-site.mjs',generated);assert.equal(receipt().state.personalization_status,'unreadable');assert.equal(receipt().state.personalization_enabled,false);
  run('export-automation-state.mjs',generated);assert.deepEqual(state(),receipt().state,'unreadable optional snapshot must fall back to baseline');
  if(fs.existsSync(path.join(tmp,'scripts/automation-preflight.mjs'))){const pre=JSON.parse(run('automation-preflight.mjs',generated,['snapshot']).stdout);assert.equal(pre.personalization_enabled,false);}
}finally{
  assert.equal(path.dirname(path.resolve(tmp)),path.resolve(os.tmpdir()));assert.ok(path.basename(tmp).startsWith('wtf-build-state-'));fs.rmSync(tmp,{recursive:true,force:true});
}
console.log('Build-state regression checks passed: artifact agreement, both freshness transitions, token stability, resolved IDs, source changes and snapshot preservation.');
