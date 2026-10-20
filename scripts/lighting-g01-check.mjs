// Independently verify G01 captures without turning diagnostics into release evidence.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateG01HostSamples} from './benchmark/lighting-g01-host.mjs';
import {summarizeTimingSamples} from './benchmark/timing-cohorts.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const requireFrozen=process.argv.includes('--require-frozen');
if(process.argv.slice(2).some(x=>x!=='--require-frozen')) throw new Error('Unknown option');
const read=p=>JSON.parse(readFileSync(resolve(root,p),'utf8'));
const {G01_SAMPLING,G01_BASELINE_CASES,poolG01Cohorts,validateDeferred021Contract,assessG01Channel,assessG01Readiness,validateG01CaseIdentity,validateG01FrozenManifest}=await import(`file://${root}/scripts/benchmark/lighting-g01-policy.mjs`);
const contract=read('config/lighting-performance-021.json');
const base=contract.baselineEvidence?.rawDirectory??'artifacts/engine-0.2.1/g01/baseline';
const summary=read(`${base}/summary.json`),inputs=read(`${base}/inputs.json`);
const failures=validateDeferred021Contract(contract);const drift=[];const rejected=[];const acceptedCeilings=[];const hostFailures=[];
if(contract.state==='frozen') {
 const evidence=read(contract.baselineEvidence.summaryPath);
 const expectedFiles=['high-performance','low-power'].flatMap(p=>G01_BASELINE_CASES.flatMap(c=>[1,2,3].map(n=>`${p}-${c.id}-${n}.json`))).concat(['summary.json','inputs.json','contract-at-capture.json']);
 const fileHashes=Object.fromEntries(expectedFiles.map(file=>[file,createHash('sha256').update(readFileSync(resolve(root,base,file))).digest('hex')]));
 failures.push(...validateG01FrozenManifest({summary,evidence,expectedFiles,fileHashes,policyHash:createHash('sha256').update(readFileSync(resolve(root,'config/lighting-performance-021.json'))).digest('hex')}));
}
if(summary.status!=='passed'||summary.tier!=='diagnostic-baseline'||summary.files.length!==30) failures.push('incomplete three-cohort capture');
if(inputs.sourceHash!==summary.sourceHash) failures.push('input inventory mismatch');
if(Object.entries(G01_SAMPLING).some(([key,value])=>summary.settings?.[key]!==value)) failures.push('sampling protocol mismatch');
const results=[];
for(const preference of ['high-performance','low-power']) for(const c of G01_BASELINE_CASES){
 const device=contract.devices.find(d=>d.powerPreference===preference);
 if(!device) throw new Error(`Missing device policy for ${preference}`);
 const expected=Array.from({length:3},(_,i)=>`${preference}-${c.id}-${i+1}.json`);
 const wrappers=expected.map(f=>read(`${base}/${f}`));
 for(const [i,w] of wrappers.entries()){
  if(!summary.files.includes(expected[i])||w.caseId!==c.id||w.cohort!==i||w.sourceHash!==summary.sourceHash||w.revision!==summary.revision) failures.push(`${expected[i]} identity`);
  if(w.validationErrors.length) failures.push(`${expected[i]} validation`);
  failures.push(...validateG01CaseIdentity(w.result,c,device).map(error=>`${expected[i]}: ${error}`));
  if(!Number.isFinite(w.interCaseIdleMs)||w.interCaseIdleMs<G01_SAMPLING.interCaseIdleMs) failures.push(`${expected[i]} inter-case idle period`);
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
  const channel=metric==='gpu'?'gpuTimestamp':c.fixture==='instances'?'cpuRecord':'runtimeFrame';
  instability[metric]=assessG01Channel(values,{deviceId:device.id,caseId:c.id,channel,ceilings:contract.baselineVarianceCeilings?.limits??[]});
  if(instability[metric].acceptance==='approved-absolute-ceiling')acceptedCeilings.push({deviceId:device.id,caseId:c.id,channel,maxCohortP95Ms:instability[metric].absoluteCeilingMs});
 }
 if(!instability.cpu.stable||!instability.gpu.stable)drift.push(`${preference}/${c.id}`);
 if(!instability.cpu.accepted||!instability.gpu.accepted)rejected.push(`${preference}/${c.id}`);
 const frameWall=summarizeTimingSamples(reports.flatMap(r=>(c.fixture==='instances'?r.timing.frameWall:r.sampleWall).rawSamples));
 results.push({caseId:c.id,powerPreference:preference,adapter:pool.adapter,cpuMetric:c.fixture==='instances'?'cpuRecord':'runtimeFrame',cpuP95:pool.cpu.p95,gpuP95:pool.gpu.p95,frameWallP95:frameWall.p95,samplesPerChannel:pool.cpu.rawSamples.length,instability});
}
const frozenFailures=validateDeferred021Contract(contract,{requireFrozen:true});
const outcome={schemaVersion:1,...assessG01Readiness({failures,unstableCases:rejected,contractFailures:frozenFailures,hostFailures}),sourceHash:summary.sourceHash,revision:summary.revision,failures,unstableCases:drift,rejectedCases:rejected,acceptedUnderAbsoluteCeiling:acceptedCeilings,contractFailures:frozenFailures,hostFailures,results,scope:'G01 diagnostic baseline integrity and stability/approved ceilings; not product qualification'};
writeFileSync(resolve(root,'artifacts/engine-0.2.1/g01/completion-check.json'),JSON.stringify(outcome,null,2)+'\n');
console.log(JSON.stringify({captureIntegrity:outcome.captureIntegrity,budgetFreezeReadiness:outcome.budgetFreezeReadiness,unstableCases:drift,rejectedCases:rejected,acceptedUnderAbsoluteCeiling:acceptedCeilings,failures,hostFailures,contractFailures:frozenFailures},null,2));
if(failures.length || (requireFrozen && outcome.budgetFreezeReadiness!=='ready'))process.exitCode=1;
