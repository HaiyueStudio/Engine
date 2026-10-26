import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compareProductionGpuCohorts,productionCapturePlan,assessProductionCapture} from './production-cohort-policy.mjs';
const sampling=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url))).sampling,rows=value=>Array.from({length:30},()=>({gpuMs:value}));
test('GPU admission uses the original pooled population and retains a failing round as investigation',()=>{
 const before=[rows(1),rows(1.1),rows(1.1)],after=[rows(1.06),rows(1.04),rows(1.04)],snapshot=JSON.stringify({before,after}),r=compareProductionGpuCohorts(before,after,sampling,.05);
 assert.equal(r.status,'passed');assert.equal(r.roundInvestigations[0].status,'failed');assert.equal(r.roundInvestigations[0].gate,false);assert.equal(r.baseline.p95,1.1);assert.equal(r.candidate.p95,1.06);assert.equal(r.baseline.rawSamples.length,90);assert.equal(r.candidate.rawSamples.length,90);assert.equal(JSON.stringify({before,after}),snapshot);
});
test('the full plan retains all workload variants and the reverse middle round',()=>{
 const plan=productionCapturePlan();assert.equal(plan.length,30);assert.deepEqual(plan.slice(0,2).map(x=>x.candidate),['baseline','candidate']);assert.deepEqual(plan.slice(8,10).map(x=>x.candidate),['candidate','baseline']);assert.equal(plan[8].workload.id,'multi-instance');assert.equal(plan.filter(x=>x.regional).length,6);assert.equal(plan.filter(x=>x.workload.nodes===10000).length,6);
});
test('capture validation rejects identity, GPU population, resources and normal pacing defects',()=>{
 const budget=JSON.parse(readFileSync(new URL('../../config/framegraph-production-021.json',import.meta.url))),job=productionCapturePlan()[1],row=frame=>({frame,gpuMs:1,timestampScope:'All render/compute commands between sentinels'});
 const raw={job,status:'passed',errors:[],browserEvidence:{nativeBackend:true,presentationMode:'visible-window'},adapter:{vendor:budget.device.vendor,architecture:budget.device.architecture},gpuSamples:Array.from({length:30},(_,i)=>row(i+12)),gpuWarmup:Array.from({length:12},(_,i)=>row(i)),cleanup:{totals:{resources:0}},gpuCleanup:{totals:{resources:0}},readyFrames:[{started:0,submitted:1,completed:2,visible:true,focused:true},{started:3,submitted:4,completed:5,visible:true,focused:true}],events:[],frames:Array.from({length:2401},(_,i)=>({time:100+i*1000/60,visible:true,focused:true}))};
 assert.equal(assessProductionCapture(raw,job,budget).failed,false);
 for(const mutate of [r=>r.gpuSamples[2].frame=0,r=>r.gpuSamples[2].gpuMs=0,r=>r.adapter.vendor='software',r=>r.cleanup.totals.resources=1,r=>r.errors.push('validation')]){const bad=structuredClone(raw);mutate(bad);assert.throws(()=>assessProductionCapture(bad,job,budget));}
 const hidden=structuredClone(raw);hidden.frames[20].focused=false;assert.equal(assessProductionCapture(hidden,job,budget).failed,true);
});
test('a slow cohort remains in the pooled tail and cannot be averaged away',()=>{
 const r=compareProductionGpuCohorts([rows(1),rows(1),rows(1)],[rows(1),rows(1),rows(1.051)],sampling,.05);assert.equal(r.status,'failed');assert.equal(r.candidate.p95,1.051);assert.equal(r.candidate.rawSamples.filter(x=>x===1.051).length,30);
});
test('missing cohorts, unequal populations, unavailable timings and changed contract cannot pass',()=>{
 const before=[rows(1),rows(1),rows(1)];for(const after of [[rows(1),rows(1)],[rows(1),rows(1),rows(1).slice(1)],[rows(1),rows(1),rows(0)]])assert.throws(()=>compareProductionGpuCohorts(before,after,sampling,.05));
 for(const changed of [{...sampling,aggregation:'mean-of-percentiles'},{...sampling,percentile:'linear'},{...sampling,dropSlowSamples:true}])assert.throws(()=>compareProductionGpuCohorts(before,before,changed,.05));assert.throws(()=>compareProductionGpuCohorts(before,before,sampling,.06));
});
