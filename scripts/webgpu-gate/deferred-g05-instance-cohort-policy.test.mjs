import test from 'node:test';
import assert from 'node:assert/strict';
import {createG05InstancePlan,validateG05InstanceCandidate} from './deferred-g05-instance-cohort-policy.mjs';
test('F plan retains all four variants for every count, view count, adapter and cohort',()=>{
 const plan=createG05InstancePlan();assert.equal(plan.length,96);
 for(let cohort=0;cohort<3;cohort++)for(const preference of ['low-power','high-performance'])for(const count of [1000,10000])for(const views of [1,4]){
  const rows=plan.filter(r=>r.cohort===cohort&&r.preference===preference&&r.count===count&&r.views===views);assert.equal(rows.length,4);
  assert.deepEqual(new Set(rows.map(r=>r.variant)),new Set(['lod-on','lod-off','frustum-visible','frustum-rejected']));assert.ok(rows.every(r=>r.full&&r.idleMs===120000));
 }
 assert.equal(plan[0].preference,'high-performance');assert.equal(plan[32].preference,'low-power');assert.equal(plan[32].variant,'frustum-rejected');
});
test('F qualification refuses smoke and throttled captures',()=>{
 const job=createG05InstancePlan()[0];assert.throws(()=>validateG05InstanceCandidate({},job),/Full/);
 assert.throws(()=>validateG05InstanceCandidate({schemaVersion:1,tier:'diagnostic-g05-instance-performance-candidate',options:job,interCaseIdleMs:120000,hostSamples:[{ready:false,cpuSpeedLimit:33,cpuSchedulerLimit:100}]},job),/host/);
});

import {readFileSync} from 'node:fs';
import {instanceEvidence} from './deferred-g05-instance-test-data.mjs';
import {validateG05InstanceCohortCoverage,evaluateG05InstanceBudgets} from './deferred-g05-instance-cohort-policy.mjs';
const config=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url)));
const entries=()=>createG05InstancePlan().map(job=>({job,evidence:instanceEvidence(job)}));
test('F coverage refuses incomplete, reordered, mixed, unbound or allocating populations',()=>{
 const all=entries();assert.equal(validateG05InstanceCohortCoverage(all).captures,96);
 assert.throws(()=>validateG05InstanceCohortCoverage(all.slice(1)),/Incomplete/);
 const reordered=[...all];[reordered[0],reordered[1]]=[reordered[1],reordered[0]];
 assert.throws(()=>validateG05InstanceCohortCoverage(reordered),/reordered/);
 const {job,evidence}=all[0];
 for(const mutate of [e=>e.revision='',e=>e.harness.sha256='',e=>e.result.paths[0].metrics.bindGroupsCreated=1,e=>e.result.paths[1].gpuMetrics.buffersCreated=1,e=>e.result.paths[0].resources.texture.created++,e=>e.result.adapter.vendor='other',e=>e.result.paths[0].cpu.pop(),e=>e.hostSamples[1].cpuSpeedLimit=99]){
  const e=structuredClone(evidence);mutate(e);assert.throws(()=>validateG05InstanceCandidate(e,job));
 }
 all[1].evidence.inputs.sha256='d'.repeat(64);all[1].evidence.build.inputs.sha256='d'.repeat(64);
 assert.throws(()=>validateG05InstanceCohortCoverage(all),/Mixed instance/);
});
test('F budgets pool all cohorts, retain slow tails, and separate reduced geometry from equal-quality ratios',()=>{
 const all=entries(),before=JSON.stringify(config),initial=evaluateG05InstanceBudgets(all,config);
 assert.equal(initial.status,'passed');assert.equal(initial.checks.length,96);assert.equal(initial.comparisons.length,32);
 assert.ok(initial.comparisons.every(c=>c.samplesPerPath===900&&!c.relativeTimingGate));
 assert.ok(initial.comparisons.every(c=>c.equalGeometryQuality===c.variant.startsWith('frustum-')));
 const row=all[0];for(let i=0;i<60;i++){row.evidence.result.paths[0].cpu[i].cpuRuntimeMs=5;row.evidence.result.paths[0].cpu[i].frameWallMs=100;row.evidence.result.paths[0].gpu[i].gpuSpanMs=13;}
 const report=evaluateG05InstanceBudgets(all,config);
 const checks=report.checks.filter(c=>c.deviceId==='mac-amd-rdna1'&&c.caseId==='instances-1000-1v'&&c.variant==='lod-on');
 assert.deepEqual(checks.map(c=>[c.metric,c.observed,c.limit,c.passed]),[['cpuP95Ms',5,4,false],['gpuP95Ms',13,12,false],['frameWallP95Ms',100,1000/60,false]]);
 assert.equal(report.status,'failed');assert.equal(JSON.stringify(config),before);
});
test('F reference timing is reported separately and missing budget cannot pass',()=>{
 const all=entries();for(const row of all)for(const s of row.evidence.result.paths[1].gpu)s.gpuSpanMs=1000;
 const report=evaluateG05InstanceBudgets(all,config);assert.equal(report.status,'passed');assert.ok(report.comparisons.every(c=>c.reference.gpuP95Ms===1000));
 const broken=structuredClone(config);broken.cases.find(c=>c.group==='F').absoluteBudgets=[];
 assert.throws(()=>evaluateG05InstanceBudgets(all,broken),/Missing frozen/);
});
