// Independently verify G01 captures without turning diagnostics into release evidence.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateG01HostSamples} from './benchmark/lighting-g01-host.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const requireFrozen=process.argv.includes('--require-frozen');
if(process.argv.slice(2).some(x=>x!=='--require-frozen')) throw new Error('Unknown option');
const read=p=>JSON.parse(readFileSync(resolve(root,p),'utf8'));
const {G01_BASELINE_CASES,poolG01Cohorts,validateDeferred021Contract,assessG01Stability,assessG01Readiness}=await import(`file://${root}/scripts/benchmark/lighting-g01-policy.mjs`);
const base='artifacts/engine-0.2.1/g01/baseline';
const summary=read(`${base}/summary.json`),inputs=read(`${base}/inputs.json`);
const failures=[];const drift=[];const hostFailures=[];
if(summary.status!=='passed'||summary.tier!=='diagnostic-baseline'||summary.files.length!==30) failures.push('incomplete three-cohort capture');
if(inputs.sourceHash!==summary.sourceHash) failures.push('input inventory mismatch');
const results=[];
for(const preference of ['high-performance','low-power']) for(const c of G01_BASELINE_CASES){
 const expected=Array.from({length:3},(_,i)=>`${preference}-${c.id}-${i+1}.json`);
 const wrappers=expected.map(f=>read(`${base}/${f}`));
 for(const [i,w] of wrappers.entries()){
  if(!summary.files.includes(expected[i])||w.caseId!==c.id||w.cohort!==i||w.sourceHash!==summary.sourceHash||w.revision!==summary.revision) failures.push(`${expected[i]} identity`);
  if(w.validationErrors.length) failures.push(`${expected[i]} validation`);
  hostFailures.push(...validateG01HostSamples(w.hostSamples).map(error=>`${expected[i]}: ${error}`));
  for(const f of w.result.httpProvenance.files){
   const path=f.sourcePath.startsWith('games/')?`scripts/fixtures/lighting-content/${f.sourcePath.slice(6)}`:f.sourcePath;
   const b=readFileSync(resolve(root,path));
   if(createHash('sha256').update(b).digest('hex')!==f.sha256||b.length!==f.byteLength)failures.push(`${path} served bytes changed`);
  }
 }
 const reports=wrappers.map(w=>w.result);const pool=poolG01Cohorts(reports);
 const instability={};
 for(const metric of ['cpu','gpu']){
  const values=reports.map(r=>metric==='cpu'?(c.fixture==='instances'?r.timing.cpuRecord:r.timing).p95:(c.fixture==='instances'?r.timing.gpuTimestamp.timing:r.gpuTimestamp.timing).p95);
  instability[metric]=assessG01Stability(values);
 }
 if(!instability.cpu.stable||!instability.gpu.stable)drift.push(`${preference}/${c.id}`);
 results.push({caseId:c.id,powerPreference:preference,adapter:pool.adapter,cpuMetric:c.fixture==='instances'?'cpuRecord':'runtimeFrame',cpuP95:pool.cpu.p95,gpuP95:pool.gpu.p95,instability});
}
const contract=read('config/lighting-performance-021.json');
failures.push(...validateDeferred021Contract(contract));
const frozenFailures=validateDeferred021Contract(contract,{requireFrozen:true});
const outcome={schemaVersion:1,...assessG01Readiness({failures,unstableCases:drift,contractFailures:frozenFailures,hostFailures}),sourceHash:summary.sourceHash,revision:summary.revision,failures,unstableCases:drift,contractFailures:frozenFailures,hostFailures,results,scope:'G01 diagnostic baseline integrity and stability; not product qualification'};
writeFileSync(resolve(root,'artifacts/engine-0.2.1/g01/completion-check.json'),JSON.stringify(outcome,null,2)+'\n');
console.log(JSON.stringify({captureIntegrity:outcome.captureIntegrity,budgetFreezeReadiness:outcome.budgetFreezeReadiness,unstableCases:drift,failures},null,2));
if(failures.length || (requireFrozen && outcome.budgetFreezeReadiness!=='ready'))process.exitCode=1;
