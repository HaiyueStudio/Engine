import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {g13ProductionPlan,g13WindowsCandidatePlan,qualifiedProductionPlan,auditG13ProductionGpu} from './g13-production-candidate-policy.mjs';
import {productionCapturePlan,compareProductionGpuCohorts} from './hya-corpus/production-cohort-policy.mjs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {createReleaseGateChecks} from './release-gate-policy.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
test('run identities cannot escape or reuse arbitrary artifact paths',()=>{
  for(const id of ['','../other','1793059045652-ABCD1234','1793059045652-1234abcd/old'])assert.throws(()=>g13ProductionPlan(root,id,()=>{throw Error('must not read')}),/identity/);
});
test('changed qualified report fails before invoking a sampler',()=>{
  assert.throws(()=>g13ProductionPlan(root,'1793059045652-1234abcd',()=>Buffer.from('{}')),/report changed/);
});
test('independent terminal uses installed Windows PowerShell and the shared bounded wait',()=>{
  const cmd=readFileSync(new URL('start-g13-production-70187df.cmd',import.meta.url),'utf8'),ps=readFileSync(new URL('start-g13-production.ps1',import.meta.url),'utf8');
  assert.match(cmd,/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);assert.doesNotMatch(cmd,/pwsh|Get-FileHash/);assert.match(cmd,/pause/);
  assert.match(ps,/framegraph-background-policy\.ps1/);assert.match(ps,/Wait-G09GpuDiagnosticStart -TimeoutSeconds 300/);
  assert.ok(ps.indexOf('Wait-G09GpuDiagnosticStart -TimeoutSeconds 300')<ps.indexOf('scripts/run-g13-production-candidate.mjs --run'));
  assert.doesNotMatch(ps,/Stop-Process|Stop-Service|Set-ItemProperty|Start-G09Power/);
});
test('the independent production run grants no global or publication qualification',()=>{
  const worker=readFileSync(new URL('run-g13-production-candidate.mjs',import.meta.url),'utf8');
  assert.match(worker,/raw\.diagnostic!==false/);assert.match(worker,/raw\.captures\?\.length!==30/);
  assert.match(worker,/git\(\['status','--porcelain'\]\)/);assert.match(worker,/finally\{closeSync/);
  assert.match(worker,/Assert-G09GpuDiagnosticReady/);
  assert.match(worker,/assessProductionCapture\(original,raw\.plan\[index\],budget\)/);
  assert.match(worker,/assert\.deepEqual\(raw\.plan,productionCapturePlan\(\)\)/);
  assert.ok(worker.indexOf('Assert-G09GpuDiagnosticReady')<worker.indexOf('spawnSync(process.execPath'));
  assert.ok(createReleaseGateChecks('global').some(args=>args.includes('release:render:evidence:check')));
});

test('a later Windows candidate pins clean four-package bytes and its runtime without changing the legacy handoff',()=>{
 const sha=b=>createHash('sha256').update(b).digest('hex'),contents=new Map(),names=['engine','animation-spec','extensions','shader-language'];
 const packages=names.map(name=>{const artifact='artifacts/engine-0.2.2/g13/new/npm/'+name+'.tgz',bytes=Buffer.from(name);contents.set(resolve(root,artifact),bytes);return{name:'@haiyue/'+name,version:'0.2.2',artifact,sha256:sha(bytes)};});
 const report={gate:{status:'passed'},sourceState:{revision:'b'.repeat(40),workingTreeDirty:false},packages},bytes=Buffer.from(JSON.stringify(report)),path='artifacts/engine-0.2.2/g13/new/public-packages.json';contents.set(resolve(root,path),bytes);
 const config={schemaVersion:1,version:'0.2.2',runtimeFingerprintSha256:'c'.repeat(64),packageReport:{path,sha256:sha(bytes)}};
 const read=p=>p===resolve(root,'config/g13-windows-candidate.json')?Buffer.from(JSON.stringify(config)):contents.get(p);
 const plan=g13WindowsCandidatePlan(root,'1793059045652-1234abcd',read);assert.equal(plan.candidateRevision,'b'.repeat(40));assert.equal(plan.runtimeFingerprintSha256,'c'.repeat(64));assert.equal(plan.captures,30);assert.equal(plan.originalGpuRegressionLimit,.05);assert.ok(plan.args.includes(path));
 for(const change of [c=>c.runtimeFingerprintSha256='bad',c=>c.schemaVersion=2,c=>c.packageReport.path='../escape',c=>c.packageReport.sha256='0'.repeat(64)]){const saved=structuredClone(config);change(config);assert.throws(()=>g13WindowsCandidatePlan(root,'1793059045652-1234abcd',read));Object.assign(config,saved);}
 contents.set(resolve(root,packages[0].artifact),Buffer.from('changed'));assert.throws(()=>g13WindowsCandidatePlan(root,'1793059045652-1234abcd',read),/package bytes changed/);
 for(const change of [r=>r.sourceState.workingTreeDirty=true,r=>r.packages[0].version='0.2.1',r=>r.packages[0].name=r.packages[1].name]){const r=structuredClone(report);change(r);const raw=Buffer.from(JSON.stringify(r));assert.throws(()=>qualifiedProductionPlan(root,'1793059045652-1234abcd',{path,sha256:sha(raw)},p=>p===resolve(root,path)?raw:Buffer.from('engine')));}
});

test('GPU qualification re-reads every full cohort and rejects changed, missing or over-budget samples',()=>{
 const plan=productionCapturePlan(),sampling={cohorts:3,aggregation:'pool-all-equal-sized-cohorts',percentile:'nearest-rank',dropSlowSamples:false};
 const records=plan.map(job=>({job,gpuSamples:Array.from({length:30},(_,n)=>({frame:n+12,gpuMs:job.candidate==='baseline'?2:2.02}))}));
 const gpu=[...new Set(plan.map(j=>j.workload.id))].map(workload=>{const cohorts=candidate=>[1,2,3].map(round=>records.find(r=>r.job.round===round&&r.job.workload.id===workload&&!r.job.regional&&r.job.candidate===candidate).gpuSamples);return {workload,...compareProductionGpuCohorts(cohorts('baseline'),cohorts('candidate'),sampling,.05)};});
 const report={plan,gpuLimit:.05,captures:records.map(r=>({job:r.job,gpu:r.gpuSamples})),gpu};assert.equal(auditG13ProductionGpu(report,records,sampling).length,4);
 const changed=structuredClone(records);changed[0].gpuSamples[0].gpuMs=3;assert.throws(()=>auditG13ProductionGpu(report,changed,sampling));
 assert.throws(()=>auditG13ProductionGpu(report,records.slice(1),sampling));
 const shortened=structuredClone(records);shortened[0].gpuSamples.pop();assert.throws(()=>auditG13ProductionGpu(report,shortened,sampling));
 const forged=structuredClone(report);forged.gpu[0].candidate.p95=0;assert.throws(()=>auditG13ProductionGpu(forged,records,sampling));
});
