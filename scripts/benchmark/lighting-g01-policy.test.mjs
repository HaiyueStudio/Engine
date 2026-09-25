import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTimingSamples } from './timing-cohorts.mjs';
import { validateG01Baseline, poolG01Cohorts, G01_SAMPLING } from './lighting-g01-policy.mjs';
import { validateDeferred021Contract, canonicalInputPaths, assessG01Stability, assessG01Readiness } from './lighting-g01-policy.mjs';
import { readFileSync } from 'node:fs';

function fixture() {
  const samples = Array.from({length:300},(_,i)=>i>=285?9:1);
  return {suite:'lighting.g01.existing-instances',adapter:{vendor:'intel',architecture:'gen-9',isFallbackAdapter:false},count:1000,counts:[334,333,333],validationErrors:0,normalFrameInstanceReadbackBytes:0,timing:{cpuRecord:summarizeTimingSamples(samples),gpuTimestamp:{status:'available',timing:summarizeTimingSamples(samples)}}};
}
test('fingerprint paths are deterministic across filesystem traversal order',()=>{
  assert.deepEqual(canonicalInputPaths(['b','a','b']),canonicalInputPaths(['a','b']));
});
test('stability rejects round-to-round drift without dropping slow cohorts',()=>{
  assert.equal(assessG01Stability([1,1.01,1.02]).stable,true);
  const unstable=assessG01Stability([0.868,1.337,1.456]);
  assert.equal(unstable.stable,false);
  assert.deepEqual(unstable.cohortP95,[0.868,1.337,1.456]);
  for(const values of [[1,1],[1,1,1,1],[1,0,1],[1,NaN,1],[1,Infinity,1]]) {
    assert.throws(()=>assessG01Stability(values),/three positive finite/);
  }
});
test('capture integrity cannot substitute for stable evidence and frozen budgets',()=>{
  const passed={failures:[],unstableCases:[],contractFailures:[]};
  assert.deepEqual(assessG01Readiness(passed),{captureIntegrity:'passed',budgetFreezeReadiness:'ready'});
  for(const field of ['failures','unstableCases','contractFailures','hostFailures']) {
    const result=assessG01Readiness({...passed,[field]:['incomplete']});
    assert.equal(result.budgetFreezeReadiness,'not-ready');
    assert.equal(result.captureIntegrity,field==='failures'?'failed':'passed');
  }
});
test('preserves complete sample population and uses nearest rank P95',()=>{
  const r=fixture();assert.deepEqual(validateG01Baseline(r),[]);
  const pooled=poolG01Cohorts([r,structuredClone(r),structuredClone(r)]);
  assert.equal(pooled.cpu.rawSamples.length,900);assert.equal(pooled.cpu.p95,1);assert.equal(pooled.cpu.p99,9);
  assert.deepEqual(G01_SAMPLING,{warmup:120,samples:300,cohorts:3});
});
test('rejects fabricated statistics, dropped samples and CPU substituted for missing GPU',()=>{
  const r=fixture();r.timing.cpuRecord.p95=0;assert.match(validateG01Baseline(r).join(),/statistics/);
  r.timing.cpuRecord.rawSamples.pop();assert.match(validateG01Baseline(r).join(),/population/);
  r.timing.gpuTimestamp={status:'unavailable',reason:'unsupported'};assert.match(validateG01Baseline(r).join(),/GPU population/);
});
test('rejects software devices, NaN, lost instances and normal frame readback',()=>{
  const r=fixture();r.adapter.isFallbackAdapter=true;r.timing.cpuRecord.rawSamples[0]=NaN;r.counts=[0,0,0];r.normalFrameInstanceReadbackBytes=100;
  const errors=validateG01Baseline(r).join();for(const text of ['software','invalid sample','coverage','readback'])assert.ok(errors.includes(text));
});
test('requires three cohorts and stable actual adapter',()=>{
  const r=fixture();assert.throws(()=>poolG01Cohorts([r,r]),/three/);
  const other=structuredClone(r);other.adapter.vendor='amd';assert.throws(()=>poolG01Cohorts([r,r,other]),/Adapter changed/);
});
test('contract preserves mandatory coverage, resource ceilings and pending evidence',()=>{
  const c=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url),'utf8'));
  assert.deepEqual(validateDeferred021Contract(c),[]);
  const pending=structuredClone(c);pending.state='candidate';pending.devices[0].gpuP95Ms=null;
  assert.ok(validateDeferred021Contract(pending,{requireFrozen:true}).length>=2);
  const invalid=structuredClone(c);invalid.cases=invalid.cases.filter(x=>x.id!=='lights-9');invalid.memory.maxDeferredBytesPerViewGeneration=1;invalid.layout.overflow='clamp';
  const errors=validateDeferred021Contract(invalid).join();for(const s of ['lights-9','memory','ABI'])assert.ok(errors.includes(s));
  const missingHost=structuredClone(c);delete missingHost.sampling.hostEvidence;
  assert.match(validateDeferred021Contract(missingHost).join(),/host evidence/);
});
test('cohorts bind actual served input hashes',()=>{
  const a=fixture();a.httpProvenance={files:[{sourcePath:'engine/dist/index.js',sha256:'a',byteLength:1}]};
  const b=structuredClone(a);b.httpProvenance.files[0].sha256='b';
  assert.throws(()=>poolG01Cohorts([a,a,b]),/Served inputs changed/);
});
