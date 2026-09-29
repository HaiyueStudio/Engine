import {validateG05RoomCandidate} from './deferred-g05-cohort-policy.mjs';
import {validateG05CostResult} from './deferred-g05-cost-policy.mjs';
import {summarizeG05Room} from './deferred-g05-policy.mjs';
import {assessG01Stability} from '../benchmark/lighting-g01-policy.mjs';

// A mandatory bottleneck preflight, not a replacement for E/F/G and Forward.
export function createG05GpuFocusPlan(){
 const jobs=[];
 for(let cohort=0;cohort<3;cohort++)for(const preference of cohort%2?['low-power','high-performance']:['high-performance','low-power']){
  const workloads=[{caseId:'overlap-128',ao:'off',runner:'room'},{caseId:'1080p-128',ao:'gtao',runner:'cost'}];
  for(const workload of (cohort%2?[...workloads].reverse():workloads))for(const algorithm of (cohort+workloads.indexOf(workload))%2?['reference','tiled']:['tiled','reference'])jobs.push({cohort,preference,...workload,algorithm,moving:true,full:true,idleMs:120000});
 }
 return jobs;
}
export function validateG05GpuFocusCandidate(e,job,config){
 if(e.options?.ao!==(job.runner==='cost'?job.ao:undefined))throw Error('AO workload mismatch');
 if(e.tier!==(job.runner==='cost'?'diagnostic-g05-cost-candidate':'diagnostic-g05-performance-candidate'))throw Error('Full focus candidate required');
 // The cost fixture has the identical room population and structural contract.
 const summary=validateG05RoomCandidate({...e,tier:'diagnostic-g05-performance-candidate'},job);
 if(job.runner==='cost')validateG05CostResult(e.result,e.options,config);
 return summary;
}
export function evaluateG05GpuFocus(entries,config){
 if(config.contractId!=='engine-deferred-021-v1'||config.state!=='frozen'||config.sampling?.aggregation!=='pool-all-equal-sized-cohorts')throw Error('Unknown frozen focus contract');
 const plan=createG05GpuFocusPlan();if(entries.length!==plan.length)throw Error('Incomplete GPU focus cohorts');
 let inputs,revision;const harnesses=new Map(),groups=new Map();
 for(const [i,{job,evidence:e}]of entries.entries()){
  if(Object.keys(plan[i]).some(key=>job[key]!==plan[i][key]))throw Error('Focus jobs reordered or replaced');
  validateG05GpuFocusCandidate(e,job,config);
  inputs??=e.inputs.sha256;revision??=e.revision;
  if(inputs!==e.inputs.sha256||revision!==e.revision)throw Error('Mixed focus runtime');
  const h=harnesses.get(job.runner);if(h&&h!==e.harness.sha256)throw Error('Mixed focus harness');harnesses.set(job.runner,e.harness.sha256);
  const key=JSON.stringify([job.preference,job.caseId,job.algorithm]),g=groups.get(key)??{job,cpu:[],gpu:[],cohorts:[]};
  g.cpu.push(...e.result.cpu);g.gpu.push(...e.result.gpu);g.cohorts.push({cohort:job.cohort,...summarizeG05Room(e.result)});groups.set(key,g);
 }
 const rows=[...groups.values()].map(g=>{
  const device=config.devices.find(d=>d.powerPreference===g.job.preference),budget=config.cases.find(c=>c.id===g.job.caseId).absoluteBudgets.find(b=>b.deviceId===device.id);
  const summary=summarizeG05Room(g),stability=Object.fromEntries(['cpuP95Ms','gpuP95Ms','frameWallP95Ms'].map(k=>[k,assessG01Stability(g.cohorts.map(c=>c[k]))]));
  const p95=a=>a.toSorted((a,b)=>a-b)[Math.ceil(a.length*.95)-1];
  const labels=[...new Set(g.gpu.flatMap(s=>s.passes.map(p=>p.label)))];
  const passes=labels.map(label=>({label,p95Ms:p95(g.gpu.map(s=>s.passes.filter(p=>p.label===label).reduce((n,p)=>n+p.durationMs,0)))}));
  return {job:g.job,cohorts:g.cohorts,cpuSamples:g.cpu.length,gpuSamples:g.gpu.length,summary,stability,passes,
   checks:g.job.algorithm==='tiled'?['cpuP95Ms','gpuP95Ms','frameWallP95Ms'].map(metric=>({metric,observed:summary[metric],limit:budget[metric],passed:summary[metric]<=budget[metric],
    qualificationGate:g.job.runner==='room',note:g.job.runner==='cost'?'AO cost is compared to the existing resolution budget for attribution; it has no separate frozen AO FPS allowance.':'Frozen E absolute timing gate'})):[]};
 });
 const ratios=rows.filter(r=>r.job.runner==='room'&&r.job.algorithm==='tiled').map(r=>{
  const ref=rows.find(x=>x.job.caseId===r.job.caseId&&x.job.preference===r.job.preference&&x.job.algorithm==='reference');
  const observed=r.summary.gpuP95Ms/ref.summary.gpuP95Ms,limit=1+config.relativeBudgets.overlap128FrameGpuP95RegressionRatio;
  return {preference:r.job.preference,metric:'wholeGpuRatio',observed,limit,passed:observed<=limit};
 });
 return {status:rows.every(r=>r.checks.filter(c=>c.qualificationGate).every(c=>c.passed)&&Object.values(r.stability).every(s=>s.stable))&&ratios.every(r=>r.passed)?'passed':'failed',
  scope:'Three-cohort high-overlap and GTAO fallback preflight only. Full E/F/G, default Forward and remaining AO modes are still mandatory.',runtimeHash:inputs,rows,ratios,releaseQualified:false};
}
