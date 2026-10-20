import {assessG01Stability} from '../benchmark/lighting-g01-policy.mjs';
import {validateG05InstanceCohortCoverage} from './deferred-g05-instance-cohort-policy.mjs';
import {validateG05RoomCohortCoverage} from './deferred-g05-cohort-policy.mjs';
const p95=values=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
/** Independent final audit; complete capture and timing budgets do not excuse cohort drift. */
export function evaluateG05Stability(entries,scope){
 if(scope==='instances')validateG05InstanceCohortCoverage(entries);
 else if(scope==='rooms')validateG05RoomCohortCoverage(entries);
 else throw Error('Unknown G05 stability scope');
 const groups=new Map();
 for(const {job,evidence}of entries){
  const paths=scope==='instances'?evidence.result.paths:[{path:job.algorithm,cpu:evidence.result.cpu,gpu:evidence.result.gpu}];
  for(const path of paths){
   const identity=scope==='instances'?{preference:job.preference,count:job.count,views:job.views,variant:job.variant,path:path.path}:{preference:job.preference,caseId:job.caseId,moving:job.moving,path:path.path};
   const channels={cpuRuntimeMs:path.cpu.map(s=>s.cpuRuntimeMs),gpuSpanMs:path.gpu.map(s=>s.gpuSpanMs),frameWallMs:path.cpu.map(s=>s.frameWallMs)};
   for(const [channel,values]of Object.entries(channels)){
    const key=JSON.stringify({...identity,channel}),group=groups.get(key)??{...identity,channel,cohorts:[]};
    group.cohorts.push({cohort:job.cohort,p95Ms:p95(values)});groups.set(key,group);
   }
  }
 }
 const checks=[...groups.values()].map(group=>{
  const stats=assessG01Stability(group.cohorts.toSorted((a,b)=>a.cohort-b.cohort).map(c=>c.p95Ms));
  return {...group,...stats,passed:stats.stable};
 });
 return {status:checks.every(c=>c.passed)?'passed':'failed',scope,checks,exceptionsApplied:[],contract:'G01 relative spread <= 0.20 and CV <= 0.10; no G01 fixture-specific absolute-ceiling exceptions'};
}
export function parseG05AuditOptions(args){
 if(args.length!==1)throw Error('Use --instances=<cohort-manifest.json> or --rooms=<cohort-manifest.json>');
 const match=/^--(instances|rooms)=(.+\.json)$/.exec(args[0]);
 if(!match)throw Error('Invalid G05 audit option');return {scope:match[1],manifest:match[2]};
}
