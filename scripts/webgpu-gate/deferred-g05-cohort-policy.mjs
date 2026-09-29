import {validateG05RoomMemory} from './deferred-g05-memory-policy.mjs';
import {G05_ROOM_CASES,validateG05RoomResult,summarizeG05Room} from './deferred-g05-policy.mjs';
// Every row is mandatory; supplemental workloads close E's static/dynamic and 1-light axes.
export const G05_ROOM_WORKLOADS=Object.freeze([
 ...Object.keys(G05_ROOM_CASES).map(caseId=>Object.freeze({caseId,moving:true})),
 ...['single-1','small-8','sparse-128','sparse-256'].map(caseId=>Object.freeze({caseId,moving:false})),
]);
export function createG05RoomPlan(){
 const jobs=[];
 for(let cohort=0;cohort<3;cohort++){
  const preferences=cohort%2?['low-power','high-performance']:['high-performance','low-power'];
  const workloads=cohort%2?[...G05_ROOM_WORKLOADS].reverse():G05_ROOM_WORKLOADS;
  for(const preference of preferences)for(const [index,workload]of workloads.entries()){
   for(const algorithm of (cohort+index)%2?['reference','tiled']:['tiled','reference'])jobs.push({cohort,...workload,algorithm,preference,full:true,idleMs:120000});
  }
 }
 return jobs;
}
export function validateG05RoomCandidate(evidence,job){
 if(evidence.schemaVersion!==1||evidence.tier!=='diagnostic-g05-performance-candidate')throw Error('Full G05 candidate required');
 for(const key of ['caseId','moving','algorithm','preference','full','idleMs'])if(evidence.options?.[key]!==job[key])throw Error(`Candidate ${key} mismatch`);
 if(!Number.isFinite(evidence.interCaseIdleMs)||evidence.interCaseIdleMs<job.idleMs)throw Error('Insufficient cooling interval');
 if(evidence.hostSamples?.length!==2||evidence.hostSamples.some(s=>s.ready!==true||s.cpuSpeedLimit!==100||s.cpuSchedulerLimit!==100))throw Error('Host qualification missing');
 if(!/^[a-f0-9]{64}$/.test(evidence.inputs?.sha256)||evidence.build?.inputs?.sha256!==evidence.inputs.sha256||!/^[a-f0-9]{64}$/.test(evidence.harness?.sha256)||!/^[a-f0-9]{40}$/.test(evidence.revision))throw Error('Unbound candidate identity');
 validateG05RoomResult(evidence.result,job);
 const {result:r}=evidence;
 const adapter=job.preference==='high-performance'?{vendor:'amd',architecture:'rdna-1'}:{vendor:'intel',architecture:'gen-9'};
 if(r.adapter.vendor!==adapter.vendor||r.adapter.architecture!==adapter.architecture)throw Error('Frozen GPU class changed');
 for(const phase of ['cpu','gpu']){
  const m=r[`${phase}Metrics`];
  for(const field of ['renderPipelinesCreated','bindGroupsCreated','buffersCreated','bufferExpansions','bufferRetirements','poolMisses','hotObjectsCreated'])if(m[field]!==0)throw Error(`Unstable ${phase} ${field}`);
  for(const type of ['buffer','texture'])if(r.resources[phase][type].created!==r.resources.warm[type].created)throw Error(`Unstable ${phase} ${type} resources`);
  const uploads=r.sourceUploads?.[phase],before=uploads?.before?.sourceUploads,after=uploads?.after?.sourceUploads;
  if(!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||after-before!==(job.moving?r.samples:0))throw Error('Missing shared source upload conservation');
 }
 return summarizeG05Room(r);
}
// Requires exact coverage. A failed capture remains in the manifest and cannot be dropped.
export function validateG05RoomCohortCoverage(entries){
 const plan=createG05RoomPlan();if(entries.length!==plan.length)throw Error('Incomplete G05 room cohorts');
 let runtimeHash,harnessHash,revision;
 for(let i=0;i<plan.length;i++){
  const {job,evidence}=entries[i];
  for(const key of Object.keys(plan[i]))if(job?.[key]!==plan[i][key])throw Error(`G05 job ${i} reordered or replaced`);
  validateG05RoomCandidate(evidence,job);
  runtimeHash??=evidence.inputs.sha256;harnessHash??=evidence.harness.sha256;revision??=evidence.revision;
  if(evidence.inputs.sha256!==runtimeHash||evidence.harness.sha256!==harnessHash||evidence.revision!==revision)throw Error('Mixed runtime revisions');
 }
 return {captures:entries.length,cohorts:3,scope:'room E/G coverage only; budget evaluation and F/Forward qualification required'};
}

export function evaluateG05RoomBudgets(entries,config){
 validateG05RoomCohortCoverage(entries);
 if(config.contractId!=='engine-deferred-021-v1'||config.sampling?.aggregation!=='pool-all-equal-sized-cohorts')throw Error('Unknown frozen aggregation contract');
 const checks=[],memoryChecks=[],groups=new Map();
 for(const {job,evidence}of entries){
  memoryChecks.push({job,...validateG05RoomMemory(evidence.result,config)});
  const key=JSON.stringify([job.preference,job.caseId,job.moving,job.algorithm]);
  const group=groups.get(key)??{job,cpu:[],gpu:[]};group.cpu.push(...evidence.result.cpu);group.gpu.push(...evidence.result.gpu);groups.set(key,group);
 }
 const p95=values=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
 for(const group of groups.values()){
  const {job}=group;if(job.algorithm!=='tiled')continue;
  const reference=groups.get(JSON.stringify([job.preference,job.caseId,job.moving,'reference']));
  const device=config.devices.find(d=>d.powerPreference===job.preference),caseConfig=config.cases.find(c=>c.id===job.caseId);
  const budgets=caseConfig?.absoluteBudgets?.find(b=>b.deviceId===device.id);
  if(job.caseId!=='single-1'&&!caseConfig)throw Error(`Missing frozen case ${job.caseId}`);
  if(caseConfig?.group==='E'&&!budgets)throw Error(`Missing frozen budgets ${job.caseId}/${device.id}`);
  const values=summarizeG05Room(group);
  if(budgets)for(const key of ['cpuP95Ms','gpuP95Ms','frameWallP95Ms'])checks.push({deviceId:device.id,caseId:job.caseId,moving:job.moving,metric:key,observed:values[key],limit:budgets[key],passed:values[key]<=budgets[key]});
  if(job.caseId==='sparse-256'){
   const observed=p95(group.gpu.map(s=>s.cullMs+s.resolveMs))/p95(reference.gpu.map(s=>s.cullMs+s.resolveMs));
   const limit=1-config.relativeBudgets.sparse256CullLightingP95ImprovementRatio;
   checks.push({deviceId:device.id,caseId:job.caseId,moving:job.moving,metric:'cullLightingRatio',observed,limit,passed:observed<=limit});
  }
  if(job.caseId==='overlap-128'){
   const observed=values.gpuP95Ms/summarizeG05Room(reference).gpuP95Ms,limit=1+config.relativeBudgets.overlap128FrameGpuP95RegressionRatio;
   checks.push({deviceId:device.id,caseId:job.caseId,moving:job.moving,metric:'wholeGpuRatio',observed,limit,passed:observed<=limit});
  }
 }
 return {status:checks.every(c=>c.passed)&&memoryChecks.every(c=>c.status==='passed')?'passed':'failed',aggregation:config.sampling.aggregation,checks,memoryChecks,scope:'room timing only; F, Forward regression, memory attribution, package/cold/AO still required'};
}
