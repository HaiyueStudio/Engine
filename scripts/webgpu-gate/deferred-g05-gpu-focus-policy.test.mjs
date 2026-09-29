import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createG05GpuFocusPlan,validateG05GpuFocusCandidate,evaluateG05GpuFocus} from './deferred-g05-gpu-focus-policy.mjs';
import {valid as room} from './deferred-g05-test-data.mjs';
import {summarizeG05ResourceRecords} from './deferred-g05-memory-policy.mjs';
const config=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url)));
function entries(){return createG05GpuFocusPlan().map(job=>{
 const options={caseId:job.caseId,algorithm:job.algorithm,preference:job.preference,moving:true,full:true,idleMs:120000,...(job.runner==='cost'?{ao:job.ao}:{})};
 const r=room(options);if(job.preference==='low-power')r.adapter={vendor:'intel',architecture:'gen-9',isFallbackAdapter:false};
 if(job.runner==='cost'){
  r.creationCosts={schemaVersion:1,ao:job.ao,settings:{radius:2,intensity:3,resolutionScale:1,quality:'high'},scope:'not isolated driver compiler time',counts:{cold:2,warm:2,cpu:2,gpu:2},records:[{method:'createShaderModule',stage:'profile',status:'passed',bytes:32,sha256:'d'.repeat(64),callMs:1},{method:'createRenderPipeline',stage:'first-frame',status:'passed',shaderIds:[0],callMs:1}]};
  for(const phase of ['warm','cpu','gpu']){
   const s=r.resourceAttribution[phase];s.records.push({id:5,type:'buffer',label:'DeferredAO.neutral',estimatedBytes:260},{id:6,type:'buffer',label:'DeferredAO.neutral',estimatedBytes:260},{id:7,type:'buffer',label:'DeferredAO.visibility',estimatedBytes:256+Math.ceil(r.width*2/256)*256*r.height},{id:8,type:'texture',label:'DeferredAO.visibility:0',estimatedBytes:2*r.width*r.height});Object.assign(s,summarizeG05ResourceRecords(s.records));
   for(const type of ['buffer','texture']){const rows=s.records.filter(r=>r.type===type);Object.assign(r.resources[phase][type],{current:rows.length,created:rows.length,estimatedBytes:rows.reduce((n,r)=>n+r.estimatedBytes,0)});}
  }
  r.allocationBudget={limitBytes:536870912,reservedBytes:65000000,peakReservedBytes:65000000};r.cleanup.allocationBudgetReservedBytes=0;
  r.tilePlan={tileCount:8160,storedTiles:0,fullListTiles:8160,memoryLimitedTiles:8160,viewBytes:65000000};
 }
 return {job,evidence:{schemaVersion:1,tier:job.runner==='cost'?'diagnostic-g05-cost-candidate':'diagnostic-g05-performance-candidate',options,interCaseIdleMs:120001,hostSamples:Array.from({length:2},()=>({ready:true,cpuSpeedLimit:100,cpuSchedulerLimit:100})),inputs:{sha256:'a'.repeat(64)},build:{inputs:{sha256:'a'.repeat(64)}},harness:{sha256:(job.runner==='cost'?'e':'b').repeat(64)},revision:'c'.repeat(40),result:r}};
});}
test('focus plan preserves paired algorithms, both adapters, three complete cohorts and fixed idle',()=>{
 const p=createG05GpuFocusPlan();assert.equal(p.length,24);
 for(let cohort=0;cohort<3;cohort++)for(const preference of ['high-performance','low-power'])for(const runner of ['room','cost'])assert.deepEqual(new Set(p.filter(j=>j.cohort===cohort&&j.preference===preference&&j.runner===runner).map(j=>j.algorithm)),new Set(['tiled','reference']));
 assert.ok(p.every(j=>j.full&&j.idleMs===120000));
});
test('complete focus audits retain 900 CPU and GPU samples, pass costs and separate scope',()=>{
 const a=evaluateG05GpuFocus(entries(),config);assert.equal(a.status,'passed');assert.equal(a.rows.length,8);assert.equal(a.releaseQualified,false);assert.ok(a.rows.every(r=>r.cpuSamples===900&&r.gpuSamples===900&&r.passes.length));
 assert.ok(a.rows.filter(r=>r.job.runner==='cost').every(r=>r.checks.every(c=>!c.qualificationGate)));
});
test('focus refuses short, reordered, mixed, throttled and altered AO evidence',()=>{
 const all=entries();assert.throws(()=>evaluateG05GpuFocus(all.slice(1),config),/Incomplete/);
 for(const mutate of [a=>a.reverse(),a=>a[1].evidence.inputs.sha256='f'.repeat(64),a=>a[0].evidence.hostSamples[1].cpuSpeedLimit=99,a=>a[2].evidence.options.ao='off',a=>a[2].evidence.result.creationCosts.settings.quality='low',a=>a[0].evidence.result.cpu.pop(),a=>a[0].evidence.interCaseIdleMs=119999,a=>a[0].evidence.tier='smoke']){const copy=structuredClone(all);mutate(copy);assert.throws(()=>evaluateG05GpuFocus(copy,config));}
});
test('slow complete populations and cohort drift cannot pass or disappear',()=>{
 const all=entries(),row=all.find(e=>e.job.runner==='room'&&e.job.algorithm==='tiled'&&e.job.preference==='low-power');
 for(const s of row.evidence.result.gpu){s.gpuSpanMs=70;s.gpuPassSumMs=69;s.resolveMs=69;s.passes[0].durationMs=69;}
 const a=evaluateG05GpuFocus(all,config),r=a.rows.find(r=>r.job.runner==='room'&&r.job.algorithm==='tiled'&&r.job.preference==='low-power');
 assert.equal(a.status,'failed');assert.equal(r.summary.gpuP95Ms,70);assert.equal(r.checks.find(c=>c.metric==='gpuP95Ms').limit,24);assert.equal(r.stability.gpuP95Ms.stable,false);
 const e=all.find(e=>e.job.runner==='cost');e.evidence.result.sourceUploads.cpu.after.sourceUploads++;
 assert.throws(()=>validateG05GpuFocusCandidate(e.evidence,e.job,config),/upload/);
});

test('reversing two workloads cannot cancel per-workload algorithm counterbalancing',()=>{
 const plan=createG05GpuFocusPlan();
 for(const preference of ['high-performance','low-power'])for(const runner of ['room','cost']){
  const first=cohort=>plan.find(j=>j.cohort===cohort&&j.preference===preference&&j.runner===runner).algorithm;
  assert.notEqual(first(0),first(1));assert.notEqual(first(1),first(2));
 }
});
