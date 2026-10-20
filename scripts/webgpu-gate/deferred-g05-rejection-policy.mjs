import {validateG05RoomCandidate} from './deferred-g05-cohort-policy.mjs';

/** Filling every missing nonnegative timing with zero gives the smallest possible pooled P95.
 * This can prove failure early. It can NEVER establish a passing or stable qualification. */
export function minimumPossiblePooledP95(observed,total){
 if(!Number.isSafeInteger(total)||total<1||!Array.isArray(observed)||observed.length>total||observed.some(v=>!Number.isFinite(v)||v<0))throw Error('Invalid nonnegative timing population');
 const missing=total-observed.length,rank=Math.ceil(total*.95);
 return rank<=missing?0:observed.toSorted((a,b)=>a-b)[rank-missing-1];
}
export function assessG05RoomRejection(evidence,job,config){
 const sampling=config.sampling;
 if(config.contractId!=='engine-deferred-021-v1'||config.state!=='frozen'||sampling?.samplesPerCohort!==300||sampling.cohorts!==3||sampling.percentile!=='nearest-rank'||sampling.aggregation!=='pool-all-equal-sized-cohorts'||sampling.dropSlowSamples!==false)throw Error('Unknown frozen timing contract');
 if(job.algorithm!=='tiled')throw Error('Only the optimized path has the absolute performance requirement');
 validateG05RoomCandidate(evidence,job);
 const device=config.devices.find(d=>d.powerPreference===job.preference),budget=config.cases.find(c=>c.id===job.caseId)?.absoluteBudgets?.find(b=>b.deviceId===device?.id);
 if(!budget)throw Error('No frozen absolute budget for this workload');
 const r=evidence.result,total=sampling.samplesPerCohort*sampling.cohorts;
 const channels={cpuP95Ms:r.cpu.map(s=>s.cpuRuntimeMs),gpuP95Ms:r.gpu.map(s=>s.gpuSpanMs),frameWallP95Ms:r.cpu.map(s=>s.frameWallMs)};
 const checks=Object.entries(channels).map(([metric,values])=>{
  const lowerBoundMs=minimumPossiblePooledP95(values,total),limitMs=budget[metric];
  if(!Number.isFinite(limitMs)||limitMs<=0)throw Error('Invalid absolute budget');
  return {metric,observedSamples:values.length,requiredSamples:total,unmeasuredSamples:total-values.length,lowerBoundMs,limitMs,irrecoverableFailure:lowerBoundMs>limitMs};
 });
 return {status:checks.some(c=>c.irrecoverableFailure)?'failed':'inconclusive',checks,deviceId:device.id,caseId:job.caseId,
  scope:'Failure witness only; incomplete cohorts can never pass full coverage, stability or release qualification.',
  construction:'For a 900-sample nearest-rank P95, replace the 600 missing samples with zero: rank 855 becomes rank 255 of the observed 300 samples. Any real nonnegative completion has an equal or larger P95.',
  releaseQualified:false};
}
