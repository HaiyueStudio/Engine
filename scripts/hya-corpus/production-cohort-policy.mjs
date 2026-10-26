import assert from 'node:assert/strict';
import {summarizeTimingSamples} from '../benchmark/timing-cohorts.mjs';
import {compareGpuRows,productionWorkloads,assessHyaPacing} from './production-policy.mjs';

export function productionCapturePlan(){
 const plan=[];for(let round=1;round<=3;round++)for(const workload of round===2?[...productionWorkloads].reverse():productionWorkloads)for(const candidate of round===2?['candidate','baseline']:['baseline','candidate'])plan.push({round,workload:{...workload},candidate,regional:false});for(let round=1;round<=3;round++)for(const workload of productionWorkloads.filter(w=>w.class==='normal'))plan.push({round,workload:{...workload},candidate:'candidate',regional:true});return plan;
}
export function assessProductionCapture(raw,job,budget){
 assert.deepEqual(raw.job,job);assert.equal(raw.status,'passed');assert.deepEqual(raw.errors,[]);assert.equal(raw.browserEvidence.nativeBackend,true);assert.equal(raw.browserEvidence.presentationMode,'visible-window');assert.equal(raw.adapter.vendor,budget.device.vendor);assert.equal(raw.adapter.architecture,budget.device.architecture);
 assert.deepEqual(raw.gpuSamples.map(r=>r.frame),Array.from({length:30},(_,n)=>n+12));assert.deepEqual(raw.gpuWarmup.map(r=>r.frame),Array.from({length:12},(_,n)=>n));assert.ok([...raw.gpuSamples,...raw.gpuWarmup].every(r=>Number.isFinite(r.gpuMs)&&r.gpuMs>0&&r.timestampScope.startsWith('All render/compute commands')));assert.equal(raw.cleanup.totals.resources,0);assert.equal(raw.gpuCleanup.totals.resources,0);
 const pacing=assessHyaPacing(raw,budget);return {pacing,failed:job.candidate==='candidate'&&job.workload.class==='normal'&&pacing.status!=='passed'};
}

/** The inherited contract pools all equal-sized cohorts before nearest-rank P95.
 * Per-round observations remain visible; they are not extra regression gates.
 */
export function compareProductionGpuCohorts(before,after,sampling,limit){
 if(sampling?.cohorts!==3||sampling.aggregation!=='pool-all-equal-sized-cohorts'||sampling.percentile!=='nearest-rank'||sampling.dropSlowSamples!==false||limit!==.05)throw Error('Inherited GPU aggregation or 5% budget changed');
 if(before?.length!==3||after?.length!==3)throw Error('Exactly three complete cohorts are required');
 const rounds=before.map((rows,index)=>({round:index+1,gate:false,classification:'investigation',...compareGpuRows(rows,after[index],limit)}));
 const baseline=summarizeTimingSamples(before.flatMap(rows=>rows.map(row=>row.gpuMs))),candidate=summarizeTimingSamples(after.flatMap(rows=>rows.map(row=>row.gpuMs)));
 return {status:candidate.p95<=baseline.p95*(1+limit)?'passed':'failed',aggregation:sampling.aggregation,percentile:sampling.percentile,cohorts:3,samplesPerCohort:30,samplesPerVariant:90,regressionLimit:limit,baseline,candidate,regression:candidate.p95/baseline.p95-1,roundInvestigations:rounds};
}
