import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {productionCapturePlan,compareProductionGpuCohorts} from './hya-corpus/production-cohort-policy.mjs';

export const G13_PRODUCTION_REPORT='artifacts/engine-0.2.2/g13/packages-handoff-compact/public-packages.json';
export const G13_PRODUCTION_REPORT_SHA256='4dda28853d2808ea0c5ea8d1edfc79dd35ead99b4f61e2f305f23c9b34f58527';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Pin the already qualified packages; a new release requires a new explicit handoff. */
export function g13ProductionPlan(root,id,read=path=>readFileSync(path)){
  return qualifiedProductionPlan(root,id,{path:G13_PRODUCTION_REPORT,sha256:G13_PRODUCTION_REPORT_SHA256},read);
}

/** Shared package-byte checks for an explicitly pinned later Windows candidate. */
export function qualifiedProductionPlan(root,id,binding,read=path=>readFileSync(path)){
  if(typeof id!=='string'||!/^\d{13}-[a-f0-9]{8}$/.test(id))throw Error('A fresh timestamp/random run identity is required');
  const bounded=path=>{if(typeof path!=='string'||!path.startsWith('artifacts/engine-0.2.2/g13/')||path.includes('\\')||path.split('/').some(s=>!s||s==='.'||s==='..'))throw Error('Candidate report must be a named G13 artifact');return resolve(root,path);};
  if(!/^[a-f0-9]{64}$/.test(binding?.sha256))throw Error('Qualified report digest required');
  const bytes=read(bounded(binding.path));
  if(sha(bytes)!==binding.sha256)throw Error('Qualified package report changed');
  const report=JSON.parse(bytes);
  if(report.gate?.status!=='passed'||report.packages?.length!==4)throw Error('Passing four-package qualification required');
  if(!/^[a-f0-9]{40}$/.test(report.sourceState?.revision)||report.sourceState.workingTreeDirty!==false)throw Error('Clean package source required');
  if(JSON.stringify(report.packages.map(p=>p.name).sort())!==JSON.stringify(['@haiyue/animation-spec','@haiyue/engine','@haiyue/extensions','@haiyue/shader-language'])||report.packages.some(p=>p.version!=='0.2.2'))throw Error('Exact four 0.2.2 packages required');
  for(const pkg of report.packages){
    const file=resolve(root,pkg.artifact),local=relative(root,file);
    if(!local||isAbsolute(local)||local==='..'||local.startsWith('../')||local.startsWith('..\\'))throw Error('Package path escapes repository');
    if(sha(read(file))!==pkg.sha256)throw Error('Qualified package bytes changed: '+pkg.name);
  }
  const output=`artifacts/engine-0.2.2/g12/g13-production-${id}`;
  return {candidateRevision:report.sourceState.revision,packageReport:{...binding},
    output,wrapperOutput:`artifacts/engine-0.2.2/g13/production-launch-${id}`,
    args:['scripts/hya-corpus/qualify-production.mjs','--packages',binding.path,'--baseline','artifacts/engine-0.2.2/g12/incremental-20261026/haiyue-extensions-0.2.2.tgz','--output',output],
    captures:30,originalGpuRegressionLimit:.05,baselinePromotion:false,releaseQualified:false};
}

export function g13WindowsCandidatePlan(root,id,read=path=>readFileSync(path)){
  if(typeof id!=='string'||!/^\d{13}-[a-f0-9]{8}$/.test(id))throw Error('A fresh timestamp/random run identity is required');
  const config=JSON.parse(read(resolve(root,'config/g13-windows-candidate.json')));
  if(config.schemaVersion!==1||config.version!=='0.2.2'||!/^[a-f0-9]{64}$/.test(config.runtimeFingerprintSha256))throw Error('Pinned Windows runtime fingerprint required');
  return {...qualifiedProductionPlan(root,id,config.packageReport,read),runtimeFingerprintSha256:config.runtimeFingerprintSha256};
}

/** Recompute all pooled GPU comparisons from the separately read capture files. */
export function auditG13ProductionGpu(report,rawCaptures,sampling){
  const plan=productionCapturePlan();assert.deepEqual(report.plan,plan);assert.equal(rawCaptures.length,plan.length);assert.equal(report.captures?.length,plan.length);assert.equal(report.gpuLimit,.05);
  for(const [index,raw]of rawCaptures.entries()){
    assert.deepEqual(raw.job,plan[index]);assert.deepEqual(report.captures[index].job,raw.job);assert.deepEqual(report.captures[index].gpu,raw.gpuSamples);
    assert.deepEqual(raw.gpuSamples?.map(row=>row.frame),Array.from({length:30},(_,n)=>n+12));
  }
  const workloads=[...new Map(plan.map(job=>[job.workload.id,job.workload])).values()],comparisons=workloads.map(workload=>{
    const cohorts=candidate=>[1,2,3].map(round=>rawCaptures.find(raw=>raw.job.round===round&&raw.job.workload.id===workload.id&&!raw.job.regional&&raw.job.candidate===candidate)?.gpuSamples);
    return {workload:workload.id,...compareProductionGpuCohorts(cohorts('baseline'),cohorts('candidate'),sampling,.05)};
  });
  assert.deepEqual(report.gpu,comparisons);assert.ok(comparisons.every(c=>c.status==='passed'),'Original pooled GPU 5% budget failed');return comparisons;
}

export function g13PhysicalCandidatePlan(root,id,profile,read=path=>readFileSync(path)){
  if(!['physical-gamepad','browser-real-ime'].includes(profile))throw Error('A named Windows physical input profile is required');
  const candidate=g13WindowsCandidatePlan(root,id,read),output='artifacts/engine-0.2.2/g13/'+(profile==='physical-gamepad'?'pad':'ime')+'-user-start-current-'+id;
  return {...candidate,profile,output,args:['scripts/hya-corpus/qualify-physical.mjs','--profile',profile,'--packages',candidate.packageReport.path,'--output',output],operatorConfirmation:'pending',physicalInputAccepted:false};
}
