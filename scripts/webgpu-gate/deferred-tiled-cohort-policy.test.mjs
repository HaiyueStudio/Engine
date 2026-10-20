import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseTiledCohortOptions,tiledCohortPlan,evaluateTiledCohorts} from './deferred-tiled-cohort-policy.mjs';
const contract=JSON.parse(await readFile(new URL('../../config/lighting-performance-021.json',import.meta.url),'utf8'));
function fixture(){return tiledCohortPlan().map(({cohort,...options})=>{
  const device=contract.devices.find(d=>d.powerPreference===options.preference),tiled=options.algorithm==='tiled'&&!options.overlap;
  const effective=options.algorithm==='tiled'?'deferred-tiled':'deferred-reference';
  return {cohort,evidence:{tier:'diagnostic-g03-performance-candidate',inputs:{sha256:'source'},harness:{sha256:'harness'},revision:'revision',dirty:true,options,interCaseIdleMs:30000,
    hostSamples:[0,1].map(i=>({command:'pmset -g therm',output:'CPU_Speed_Limit = 100\nCPU_Scheduler_Limit = 100\nCPU_Available_CPUs = 8',observedAt:`2026-09-26T00:00:0${i}Z`})),
    result:{status:'passed',schemaVersion:1,adapter:{vendor:device.vendor,architecture:device.architecture,isFallbackAdapter:false},fixtureId:'deferred-room-021-v1',resolution:[1280,720],...options,warmup:120,samples:300,
      raw:Array.from({length:300},(_,frame)=>({frame,cpuRuntimeMs:2,cpuRecordMs:1,cpuSubmitMs:1,queueWaitMs:0,frameWallMs:12,authoredMutationMs:0,gpuSpanMs:tiled?6:10,gpuPassSumMs:tiled?5:9,cullMs:tiled?1:0,resolveMs:tiled?3:8,effective,bypassReason:options.algorithm==='tiled'&&!tiled?'all-lights-cover-near-plane':null,passes:tiled?[{kind:'compute',label:'DeferredTiles.cull'}]:[]})),
      tiles:{heatmap:Array(3600).fill(0),plan:{tileCount:3600},resolveListReferences:100},source:{pointCount:options.count,directionalCount:1,ambientCount:1},completeCoverage:true,pixels:{maxHdrDelta:0,maxLdrDelta:0,litPixels:100000},validationErrors:[],cleanup:{ownerResidual:0,liveGpuResources:0}}}};});}
test('three cohorts reverse cases and adapters while preserving every paired path',()=>{
  const p=tiledCohortPlan();assert.equal(p.length,24);assert.equal(p[0].preference,'high-performance');assert.equal(p[8].preference,'low-power');assert.equal(p[8].algorithm,'tiled');
  const report=evaluateTiledCohorts(fixture(),contract);assert.equal(report.relativeBudgetsPassed,true);assert.equal(report.absoluteBudgetsPassed,true);assert.equal(report.productQualification,false);assert.ok(report.comparisons.every(c=>c.samplesPerAlgorithm===900));
});
test('cohort gate rejects missing, reordered, mixed, throttled and fake-device evidence',()=>{
  assert.throws(()=>evaluateTiledCohorts(fixture().slice(1),contract),/24/);
  for(const mutate of [c=>c.reverse(),c=>{c[1].evidence.inputs.sha256='changed';},c=>{c[1].evidence.harness.sha256='changed';},c=>{c[1].evidence.hostSamples[0].output='CPU_Speed_Limit = 50';},c=>{c[1].evidence.interCaseIdleMs=29999;},c=>{c[1].evidence.result.adapter.vendor='other';},c=>{c[1].evidence.result.raw.pop();}]){
    const captures=fixture();mutate(captures);assert.throws(()=>evaluateTiledCohorts(captures,contract));
  }
});
test('all slow samples stay in pooled percentiles and absolute budgets remain separate',()=>{
  const captures=fixture();
  for(const c of captures)if(c.evidence.options.algorithm==='tiled')for(const sample of c.evidence.result.raw){sample.gpuSpanMs=30;sample.resolveMs=28;}
  const report=evaluateTiledCohorts(captures,contract);assert.equal(report.relativeBudgetsPassed,false);assert.equal(report.absoluteBudgetsPassed,false);assert.ok(report.comparisons.every(c=>c.tiled.gpuSpanMs===30));
});
test('pooled budget success cannot hide unstable rounds or inherit G01 instance exceptions',()=>{
  const captures=fixture();
  for(const c of captures)if(c.cohort===2)for(const sample of c.evidence.result.raw)sample.cpuRuntimeMs=3.5;
  const report=evaluateTiledCohorts(captures,contract);
  assert.equal(report.relativeBudgetsPassed,true);assert.equal(report.absoluteBudgetsPassed,true);assert.equal(report.stabilityPassed,false);
});

test('extended cooldown is explicit, uniform and verified against measured idle',()=>{
  assert.deepEqual(parseTiledCohortOptions(['--run','--idle-ms=120000']),{mode:'--run',idleMs:120000});
  assert.deepEqual(parseTiledCohortOptions(['--plan']),{mode:'--plan',idleMs:30000});
  for(const args of [[],['--run','--plan'],['--run','--samples=1'],['--run','--idle-ms=29999'],['--run','--idle-ms=120000','--idle-ms=120000']])assert.throws(()=>parseTiledCohortOptions(args));
  const plan=tiledCohortPlan(120000);assert.equal(plan.length,24);assert.ok(plan.every(run=>run.idleMs===120000));
  const captures=fixture();for(const c of captures){c.evidence.options.idleMs=120000;c.evidence.interCaseIdleMs=120001;}
  assert.equal(evaluateTiledCohorts(captures,contract).interCaseIdleMs,120000);
  captures[1].evidence.options.idleMs=30000;assert.throws(()=>evaluateTiledCohorts(captures,contract),/workload/);
  captures[1].evidence.options.idleMs=120000;captures[1].evidence.interCaseIdleMs=119999;assert.throws(()=>evaluateTiledCohorts(captures,contract),/Host/);
  captures[1].evidence.interCaseIdleMs=NaN;assert.throws(()=>evaluateTiledCohorts(captures,contract),/Host/);
});
