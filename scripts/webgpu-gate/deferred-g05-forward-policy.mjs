import {G01_BASELINE_CASES,validateG01Baseline,validateG01CaseIdentity,assessG01Stability} from '../benchmark/lighting-g01-policy.mjs';
import {summarizeTimingSamples} from '../benchmark/timing-cohorts.mjs';
export const G05_FORWARD_CASES=Object.freeze(G01_BASELINE_CASES.filter(c=>['forward-small-1','forward-cap-8'].includes(c.id)));
export function parseG05ForwardOptions(args){
 const o={full:false};if(args.length>1||args.some(a=>a!=='--full'&&a!=='--plan'))throw Error('Use --plan or --full (no argument runs smoke)');
 o.full=args[0]==='--full';o.plan=args[0]==='--plan';return o;
}
export function createG05ForwardPlan(full=true){
 const jobs=[];for(let cohort=0;cohort<(full?3:1);cohort++)for(const preference of cohort%2?['low-power','high-performance']:['high-performance','low-power'])for(const c of cohort%2?[...G05_FORWARD_CASES].reverse():G05_FORWARD_CASES)jobs.push({cohort,caseId:c.id,preference,full,idleMs:full?120000:0});return jobs;
}
export function validateG05ForwardCapture(e,job){
 if(e.schemaVersion!==1||e.tier!==(job.full?'diagnostic-g05-forward-candidate':'diagnostic-g05-forward-smoke'))throw Error('Wrong Forward tier');
 for(const key of Object.keys(job))if(e.job?.[key]!==job[key])throw Error('Forward job mismatch');
 if(!/^[a-f0-9]{64}$/.test(e.inputs?.sha256)||!/^[a-f0-9]{64}$/.test(e.harness?.sha256)||!/^[a-f0-9]{40}$/.test(e.revision))throw Error('Unbound Forward inputs');
 if(job.full&&(!Number.isFinite(e.interCaseIdleMs)||e.interCaseIdleMs<120000))throw Error(`Insufficient Forward cooling interval: ${e.interCaseIdleMs} ms; requires 120000 ms`);
 if(job.full&&(e.hostSamples?.length!==2||e.hostSamples.some(s=>s.ready!==true||s.cpuSpeedLimit!==100||s.cpuSchedulerLimit!==100)))throw Error('Unqualified Forward host');
 const device={vendor:job.preference==='low-power'?'intel':'amd',architecture:job.preference==='low-power'?'gen-9':'rdna-1'};
 validateG05ForwardResult(e.result,job,device);
}
export function validateG05ForwardResult(r,job,device){
 const c=G05_FORWARD_CASES.find(c=>c.id===job.caseId);
 if(!c)throw Error('Unknown Forward case');
 const failures=validateG01Baseline(r,{samples:job.full?300:3});
 if(job.full)failures.push(...validateG01CaseIdentity(r,c,device));
 if(r.adapter?.vendor!==device.vendor||r.adapter?.architecture!==device.architecture)failures.push('Frozen Forward adapter mismatch');
 try{validateG05ForwardAllocation(r);}catch(error){failures.push(error.message);}
 if(failures.length)throw Error(failures.join('; '));
}
export function validateG05ForwardAllocation(r){
 const failures=[],a=r.g05Forward;
 if(r.renderer?.lightingStrategy!=='forward'||a?.schemaVersion!==1||a?.deferredCreated?.length!==0||!Array.isArray(a?.allocations)||a.allocations.length===0)failures.push('Missing Forward allocation audit or Deferred allocation');
 const methods=['createBuffer','createTexture','createShaderModule','createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync'];
 if(JSON.stringify(a?.observedMethods)!==JSON.stringify(methods))failures.push('Incomplete Forward allocation observation');
 if(a?.allocations?.some(x=>!methods.includes(x.method)||typeof x.label!=='string'||/deferred|TransientMRT:/i.test(x.label)))failures.push('Deferred resource/shader loaded by Forward');
 if(a?.cleanup?.liveGpuResources!==0||a?.cleanup?.ownerResidual!==0)failures.push('Forward cleanup residue');
 if(failures.length)throw Error(failures.join('; '));
}
export function evaluateG05ForwardBudgets(entries,baseline,config){
 const plan=createG05ForwardPlan();if(entries.length!==plan.length)throw Error('Incomplete Forward cohorts');
 if(config.contractId!=='engine-deferred-021-v1'||config.state!=='frozen'||config.sampling?.aggregation!=='pool-all-equal-sized-cohorts')throw Error('Unknown frozen Forward contract');
 let inputs,harness,revision;const checks=[],groups=new Map();
 for(const [i,{job,evidence}]of entries.entries()){
  for(const key of Object.keys(plan[i]))if(job?.[key]!==plan[i][key])throw Error('Forward captures reordered or replaced');
  validateG05ForwardCapture(evidence,job);inputs??=evidence.inputs.sha256;harness??=evidence.harness.sha256;revision??=evidence.revision;
  if(evidence.inputs.sha256!==inputs||evidence.harness.sha256!==harness||evidence.revision!==revision)throw Error('Mixed Forward inputs');
  const key=JSON.stringify([job.preference,job.caseId]),group=groups.get(key)??{job,reports:[]};group.reports.push(evidence.result);groups.set(key,group);
 }
 for(const {job,reports}of groups.values()){
  const base=baseline.filter(e=>e.caseId===job.caseId&&e.result?.adapter?.vendor===(job.preference==='low-power'?'intel':'amd'));
  if(base.length!==3||new Set(base.map(e=>e.cohort)).size!==3)throw Error('Missing frozen Forward baseline cohorts');
  for(const e of base){
   const c=G05_FORWARD_CASES.find(c=>c.id===job.caseId),d=config.devices.find(d=>d.powerPreference===job.preference);
   const errors=[...validateG01Baseline(e.result),...validateG01CaseIdentity(e.result,c,d)];
   if(e.sourceHash!==config.baselineEvidence.sourceHash||e.revision!==config.baselineEvidence.revision||e.validationErrors?.length!==0||e.hostSamples?.length!==2||e.hostSamples.some(s=>s.ready!==true||s.cpuSpeedLimit!==100||s.cpuSchedulerLimit!==100))errors.push('Invalid frozen baseline identity/host');
   if(errors.length)throw Error(errors.join('; '));
  }
  for(const metric of ['cpu','gpu']){
   const values=r=>metric==='cpu'?r.timing.rawSamples:r.gpuTimestamp.timing.rawSamples;
   const observed=summarizeTimingSamples(reports.flatMap(values)).p95,reference=summarizeTimingSamples(base.flatMap(e=>values(e.result))).p95;
   const stability=assessG01Stability(reports.map(r=>summarizeTimingSamples(values(r)).p95));
   const ratio=observed/reference,limit=1+config.relativeBudgets[metric==='cpu'?'smallSceneCpuP95RegressionRatio':'smallSceneGpuP95RegressionRatio'];
   if(!Number.isFinite(limit)||!Number.isFinite(ratio))throw Error('Missing Forward budget or samples');
   checks.push({caseId:job.caseId,preference:job.preference,metric,observedP95Ms:observed,baselineP95Ms:reference,ratio,limit,stability,passed:ratio<=limit&&stability.stable});
  }
 }
 return {status:checks.every(c=>c.passed)?'passed':'failed',checks,scope:'G01 same-workload default Forward regression only; cap-8 capacity remains legacy and is not a complete-light Deferred speedup oracle'};
}
