import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createG05ForwardPlan,parseG05ForwardOptions,G05_FORWARD_CASES,validateG05ForwardCapture,evaluateG05ForwardBudgets} from './deferred-g05-forward-policy.mjs';
import {summarizeTimingSamples} from '../benchmark/timing-cohorts.mjs';
import {observeForwardAllocations} from './deferred-g05-forward-allocation.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState,ensureRealRendererGpuConstants} from '../benchmark/real-renderer-audit-device.mjs';
const config=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url)));
const methods=['createBuffer','createTexture','createShaderModule','createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync'];
function data(){
 const entries=createG05ForwardPlan().map(job=>{
  const c=G05_FORWARD_CASES.find(c=>c.id===job.caseId),stats=summarizeTimingSamples(Array(300).fill(1));
  const result={suite:'lighting.scaling.real-fixture',adapter:{vendor:job.preference==='low-power'?'intel':'amd',architecture:job.preference==='low-power'?'gen-9':'rdna-1',isFallbackAdapter:false},
   fixture:{localLightCount:c.lights,viewCount:c.views,dynamicRatio:c.dynamic,overlap:c.overlap,resolution:{width:1280,height:720}},warmup:{rawSamples:Array(120).fill(1)},timing:structuredClone(stats),sampleWall:structuredClone(stats),gpuTimestamp:{status:'available',timing:structuredClone(stats)},sceneProvenance:{matches:true},execution:{validation:{errorCount:0},ownerCleanup:{ownerResidual:{value:0}}},renderer:{lightingStrategy:'forward'},
   g05Forward:{schemaVersion:1,observedMethods:methods,allocations:[{method:'createBuffer',label:'Forward.frame'}],deferredCreated:[],cleanup:{liveGpuResources:0,ownerResidual:0}}};
  return {job,evidence:{schemaVersion:1,tier:'diagnostic-g05-forward-candidate',job,inputs:{sha256:'a'.repeat(64)},harness:{sha256:'b'.repeat(64)},revision:'c'.repeat(40),interCaseIdleMs:120001,hostSamples:Array.from({length:2},()=>({ready:true,cpuSpeedLimit:100,cpuSchedulerLimit:100})),result}};
 });
 const baseline=entries.map(({job,evidence})=>({caseId:job.caseId,cohort:job.cohort,sourceHash:config.baselineEvidence.sourceHash,revision:config.baselineEvidence.revision,validationErrors:[],hostSamples:structuredClone(evidence.hostSamples),result:structuredClone(evidence.result)}));
 return {entries,baseline};
}
test('Forward reports short cooling separately from throttling without relaxing either gate',()=>{
 const {evidence,job}=data().entries[0];
 evidence.interCaseIdleMs=119999.62386300002;
 assert.throws(()=>validateG05ForwardCapture(evidence,job),/Insufficient Forward cooling/);
 evidence.interCaseIdleMs=120000;
 validateG05ForwardCapture(evidence,job);
 evidence.hostSamples[1].cpuSpeedLimit=99;
 assert.throws(()=>validateG05ForwardCapture(evidence,job),/Unqualified Forward host/);
});
test('Forward plan preserves both G01 small scenes, native adapters and all three cohorts',()=>{
 assert.equal(createG05ForwardPlan().length,12);assert.equal(createG05ForwardPlan(false).length,4);
 assert.deepEqual(parseG05ForwardOptions(['--plan']),{full:false,plan:true});assert.equal(parseG05ForwardOptions(['--full']).full,true);
 for(const args of [['--full','--full'],['--samples=3'],['--skip-build']])assert.throws(()=>parseG05ForwardOptions(args));
});
test('Forward qualification rejects Deferred allocation, missing hooks, stale identity, truncation and host throttling',()=>{
 const {entries}=data(),{evidence,job}=entries[0];validateG05ForwardCapture(evidence,job);
 for(const mutate of [e=>e.result.g05Forward.allocations[0].label='DeferredTiles:indices',e=>e.result.g05Forward.observedMethods=methods.slice(1),e=>e.result.g05Forward.deferredCreated=[{}],e=>e.result.g05Forward.cleanup.liveGpuResources=1,e=>e.result.fixture.localLightCount=8,e=>e.result.timing.rawSamples.pop(),e=>e.hostSamples[1].cpuSpeedLimit=50,e=>e.inputs.sha256='']){const e=structuredClone(evidence);mutate(e);assert.throws(()=>validateG05ForwardCapture(e,job));}
});
test('Forward regression uses frozen pooled baseline and existing 5% limits; unstable cohorts cannot pass',()=>{
 const {entries,baseline}=data(),before=JSON.stringify(config);const initial=evaluateG05ForwardBudgets(entries,baseline,config);assert.equal(initial.status,'passed');assert.equal(initial.checks.length,8);
 for(const row of entries.filter(e=>e.job.caseId==='forward-small-1'&&e.job.preference==='high-performance'))row.evidence.result.timing=summarizeTimingSamples(Array(300).fill(1.06));
 let report=evaluateG05ForwardBudgets(entries,baseline,config);assert.equal(report.status,'failed');assert.equal(report.checks.find(c=>c.metric==='cpu').limit,1.05);
 const clean=data();const raw=Array(300).fill(1);raw.fill(2,0,30);clean.entries[0].evidence.result.timing=summarizeTimingSamples(raw);
 report=evaluateG05ForwardBudgets(clean.entries,clean.baseline,config);const drift=report.checks.find(c=>c.metric==='cpu');assert.equal(drift.ratio,1);assert.equal(drift.stability.stable,false);assert.equal(drift.passed,false);
 assert.equal(JSON.stringify(config),before);
});
test('Forward missing/replaced baseline and mixed candidate inputs cannot establish regression',()=>{
 const {entries,baseline}=data();assert.throws(()=>evaluateG05ForwardBudgets(entries.slice(1),baseline,config),/Incomplete/);
 assert.throws(()=>evaluateG05ForwardBudgets(entries,baseline.slice(1),config),/Missing frozen/);
 const mutated=structuredClone(baseline);mutated[0].sourceHash='x';assert.throws(()=>evaluateG05ForwardBudgets(entries,mutated,config),/baseline identity/);
 entries[1].evidence.inputs.sha256='d'.repeat(64);assert.throws(()=>evaluateG05ForwardBudgets(entries,baseline,config),/Mixed/);
});
test('allocation audit forwards methods through the shared versioned device and retains Deferred attempts',async()=>{
 ensureRealRendererGpuConstants();const device=createAuditGpuDevice(),audit=observeForwardAllocations(device);
 const buffer=device.createBuffer({label:'Forward.buffer',size:64,usage:GPUBufferUsage.UNIFORM});
 device.createTexture({label:'TransientMRT:gbuffer:0',size:[2,2],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT});
 const module=device.createShaderModule({label:'GeneratedShader.deferred-lighting',code:'@compute @workgroup_size(1) fn main() {}'});
 await device.createComputePipelineAsync({label:'DeferredTiles.cull',layout:'auto',compute:{module,entryPoint:'main'}});
 const snapshot=audit.snapshot();assert.deepEqual(snapshot.observedMethods,methods);assert.ok(snapshot.deferredCreated.length>=3);assert.ok(snapshot.allocations.some(a=>a.label==='Forward.buffer'&&a.bytes===64));assert.equal(buffer.size,64);assert.ok(getAuditGpuDeviceState(device));
});
