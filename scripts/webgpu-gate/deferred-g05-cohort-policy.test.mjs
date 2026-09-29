import test from 'node:test';
import assert from 'node:assert/strict';
import {createG05RoomPlan,G05_ROOM_WORKLOADS,validateG05RoomCandidate,validateG05RoomCohortCoverage,evaluateG05RoomBudgets} from './deferred-g05-cohort-policy.mjs';
test('G05 room plan retains every E/G case, static supplements and three counterbalanced native cohorts',()=>{
 const jobs=createG05RoomPlan();assert.equal(G05_ROOM_WORKLOADS.length,13);assert.equal(jobs.length,156);
 for(const preference of ['high-performance','low-power'])for(let cohort=0;cohort<3;cohort++)for(const row of G05_ROOM_WORKLOADS){
  const pair=jobs.filter(j=>j.preference===preference&&j.cohort===cohort&&j.caseId===row.caseId&&j.moving===row.moving);
  assert.equal(pair.length,2);assert.deepEqual(new Set(pair.map(j=>j.algorithm)),new Set(['reference','tiled']));
  assert.ok(pair.every(j=>j.full&&j.idleMs===120000));
 }
 assert.equal(jobs[0].preference,'high-performance');assert.equal(jobs[52].preference,'low-power');
 assert.notEqual(jobs[0].algorithm,jobs[2].algorithm);
});
test('G05 qualification refuses short, throttled, stale and incomplete captures',()=>{
 const job=createG05RoomPlan()[0];
 const evidence={schemaVersion:1,tier:'diagnostic-g05-performance-candidate',options:job,interCaseIdleMs:120001,hostSamples:[{ready:true,cpuSpeedLimit:100,cpuSchedulerLimit:100},{ready:true,cpuSpeedLimit:100,cpuSchedulerLimit:100}],inputs:{sha256:'a'.repeat(64)},build:{inputs:{sha256:'a'.repeat(64)}},harness:{sha256:'b'.repeat(64)},revision:'c'.repeat(40),result:{status:'failed'}};
 assert.throws(()=>validateG05RoomCandidate(evidence,job),/room failed/);
 for(const [mutate,pattern]of [[e=>e.tier='smoke',/Full/],[e=>e.interCaseIdleMs=119999,/cooling/],[e=>e.hostSamples[1].cpuSpeedLimit=99,/Host/],[e=>e.build.inputs.sha256='d'.repeat(64),/identity/],[e=>e.options.algorithm='reference',/mismatch/]]){
  const e=structuredClone(evidence);mutate(e);assert.throws(()=>validateG05RoomCandidate(e,job),pattern);
 }
 assert.throws(()=>validateG05RoomCohortCoverage([]),/Incomplete/);
});

import {readFileSync} from 'node:fs';
import {valid} from './deferred-g05-test-data.mjs';
const config=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url)));
function entries(){return createG05RoomPlan().map(job=>{
 const result=valid(job);if(job.preference==='low-power')result.adapter={vendor:'intel',architecture:'gen-9',isFallbackAdapter:false};
 return {job,evidence:{schemaVersion:1,tier:'diagnostic-g05-performance-candidate',options:job,interCaseIdleMs:120001,hostSamples:Array.from({length:2},()=>({ready:true,cpuSpeedLimit:100,cpuSchedulerLimit:100})),
  inputs:{sha256:'a'.repeat(64)},build:{inputs:{sha256:'a'.repeat(64)}},harness:{sha256:'b'.repeat(64)},revision:'c'.repeat(40),result}};
});}
test('G05 full qualification rejects source upload duplication, allocations and mixed runtimes',()=>{
 const all=entries();assert.equal(validateG05RoomCohortCoverage(all).captures,156);
 const {job,evidence}=all[0];
 for(const mutate of [e=>e.result.cpuMetrics.buffersCreated=1,e=>e.result.resources.cpu.texture.created++,e=>e.result.sourceUploads.cpu.after.sourceUploads++,e=>e.result.adapter.vendor='other']){
  const e=structuredClone(evidence);mutate(e);assert.throws(()=>validateG05RoomCandidate(e,job));
 }
 all[1].evidence.inputs.sha256='d'.repeat(64);all[1].evidence.build.inputs.sha256='d'.repeat(64);
 assert.throws(()=>validateG05RoomCohortCoverage(all),/Mixed runtime/);
});
test('G05 budget evaluation keeps pooled slow samples, frozen limits and stress exclusions',()=>{
 const all=entries(),before=JSON.stringify(config);
 const initial=evaluateG05RoomBudgets(all,config);
 assert.equal(initial.status,'failed'); // Equal synthetic sparse times cannot prove 20% improvement.
 assert.ok(initial.checks.some(c=>c.metric==='cullLightingRatio'&&!c.passed));
 assert.ok(initial.checks.every(c=>!c.caseId.startsWith('stress-')));
 const row=all.find(e=>e.job.caseId==='overlap-128'&&e.job.algorithm==='tiled'&&e.job.preference==='high-performance');
 for(let i=0;i<60;i++)row.evidence.result.cpu[i].frameWallMs=100;
 const result=evaluateG05RoomBudgets(all,config),wall=result.checks.find(c=>c.caseId==='overlap-128'&&c.deviceId==='mac-amd-rdna1'&&c.metric==='frameWallP95Ms');
 assert.equal(wall.observed,100);assert.equal(wall.passed,false);assert.equal(wall.limit,1000/60);
 assert.equal(JSON.stringify(config),before);
});
