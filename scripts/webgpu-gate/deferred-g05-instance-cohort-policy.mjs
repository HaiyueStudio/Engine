import {G05_INSTANCE_VARIANTS,validateG05InstanceResult} from './deferred-g05-instance-policy.mjs';
export function createG05InstancePlan(){
 const cases=[1000,10000].flatMap(count=>[1,4].flatMap(views=>G05_INSTANCE_VARIANTS.map(variant=>({count,views,variant}))));
 const jobs=[];for(let cohort=0;cohort<3;cohort++)for(const preference of cohort%2?['low-power','high-performance']:['high-performance','low-power'])for(const workload of cohort%2?[...cases].reverse():cases)jobs.push({cohort,...workload,preference,full:true,idleMs:120000});
 return jobs;
}
export function validateG05InstanceCandidate(e,job){
 if(e.schemaVersion!==1||e.tier!=='diagnostic-g05-instance-performance-candidate')throw Error('Full instance candidate required');
 for(const key of ['count','views','variant','preference','full','idleMs'])if(e.options?.[key]!==job[key])throw Error(`Instance ${key} mismatch`);
 if(e.interCaseIdleMs<120000||!Number.isFinite(e.interCaseIdleMs)||e.hostSamples?.length!==2||e.hostSamples.some(s=>s.ready!==true||s.cpuSpeedLimit!==100||s.cpuSchedulerLimit!==100))throw Error('Unqualified instance host');
 if(!/^[a-f0-9]{40}$/.test(e.revision)||!/^[a-f0-9]{64}$/.test(e.inputs?.sha256)||e.build?.inputs?.sha256!==e.inputs.sha256||!/^[a-f0-9]{64}$/.test(e.harness?.sha256))throw Error('Unbound instance source');
 validateG05InstanceResult(e.result,job);
 const expected=job.preference==='high-performance'?['amd','rdna-1']:['intel','gen-9'];
 if(e.result.adapter.vendor!==expected[0]||e.result.adapter.architecture!==expected[1])throw Error('Frozen instance GPU class changed');
 for(const p of e.result.paths){
  for(const m of [p.metrics,p.gpuMetrics])for(const k of ['bindGroupsCreated','buffersCreated','renderPipelinesCreated'])if(m[k]!==0)throw Error(`Unstable instance ${p.path} ${k}`);
  for(const type of ['buffer','texture'])if(p.resources[type].created!==p.resourcesBefore[type].created)throw Error(`Unstable instance ${type}`);
 }
}

export function validateG05InstanceCohortCoverage(entries){
 const plan=createG05InstancePlan();
 if(entries.length!==plan.length)throw Error('Incomplete G05 instance cohorts');
 let runtimeHash,harnessHash,revision;
 for(const [i,expected]of plan.entries()){
  const {job,evidence}=entries[i];
  for(const key of Object.keys(expected))if(job?.[key]!==expected[key])throw Error(`Instance job ${i} reordered or replaced`);
  validateG05InstanceCandidate(evidence,job);
  runtimeHash??=evidence.inputs.sha256;harnessHash??=evidence.harness.sha256;revision??=evidence.revision;
  if(runtimeHash!==evidence.inputs.sha256||harnessHash!==evidence.harness.sha256||revision!==evidence.revision)throw Error('Mixed instance runtime revisions');
 }
 return {captures:entries.length,cohorts:3};
}
const p95=values=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
function summarize(path){return {cpuP95Ms:p95(path.cpu.map(s=>s.cpuRuntimeMs)),gpuP95Ms:p95(path.gpu.map(s=>s.gpuSpanMs)),frameWallP95Ms:p95(path.cpu.map(s=>s.frameWallMs)),cpuRecordP95Ms:p95(path.cpu.map(s=>s.cpuRecordMs)),queueWaitP95Ms:p95(path.cpu.map(s=>s.queueWaitMs))};}
export function evaluateG05InstanceBudgets(entries,config){
 validateG05InstanceCohortCoverage(entries);
 if(config.contractId!=='engine-deferred-021-v1'||config.state!=='frozen'||config.sampling?.aggregation!=='pool-all-equal-sized-cohorts'||config.sampling.cohorts!==3||config.sampling.samplesPerCohort!==300||config.sampling.percentile!=='nearest-rank')throw Error('Unknown frozen instance aggregation contract');
 const groups=new Map(),checks=[],comparisons=[];
 for(const {job,evidence}of entries){
  const key=JSON.stringify([job.preference,job.count,job.views,job.variant]);
  const group=groups.get(key)??{job,paths:['candidate','reference'].map(path=>({path,cpu:[],gpu:[]}))};
  evidence.result.paths.forEach((p,i)=>{group.paths[i].cpu.push(...p.cpu);group.paths[i].gpu.push(...p.gpu);});groups.set(key,group);
 }
 for(const {job,paths}of groups.values()){
  const caseId=`instances-${job.count}-${job.views}v`,device=config.devices.find(d=>d.powerPreference===job.preference),caseConfig=config.cases.find(c=>c.id===caseId);
  const budget=caseConfig?.absoluteBudgets?.find(b=>b.deviceId===device?.id);
  if(!device||caseConfig?.group!=='F'||!caseConfig.variants.includes(job.variant)||!budget)throw Error(`Missing frozen instance budget ${caseId}/${job.preference}`);
  const [candidate,reference]=paths.map(summarize),identity={deviceId:device.id,caseId,variant:job.variant};
  for(const metric of ['cpuP95Ms','gpuP95Ms','frameWallP95Ms']){
   if(!Number.isFinite(budget[metric])||budget[metric]<=0)throw Error(`Missing frozen instance ${metric}`);
   checks.push({...identity,metric,observed:candidate[metric],limit:budget[metric],passed:candidate[metric]<=budget[metric]});
  }
  comparisons.push({...identity,samplesPerPath:paths[0].cpu.length,candidate,reference,
   gpuP95Ratio:candidate.gpuP95Ms/reference.gpuP95Ms,
   equalGeometryQuality:job.variant.startsWith('frustum-'),
   quality:job.variant.startsWith('frustum-')?'same 144-triangle geometry; GPU visibility versus unculled reference':job.variant==='lod-on'?'GPU 144/64/16-triangle LOD versus 144-triangle reference':'144-triangle candidate versus GPU 144/64/16-triangle LOD reference',
   relativeTimingGate:false});
 }
 return {status:checks.every(c=>c.passed)?'passed':'failed',aggregation:config.sampling.aggregation,checks,comparisons,scope:'F timing and capture correctness only; E/G, default Forward regression, memory/cold/AO and final audit remain separate'};
}
