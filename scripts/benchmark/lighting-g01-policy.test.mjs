import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTimingSamples } from './timing-cohorts.mjs';
import { validateG01Baseline, poolG01Cohorts, G01_SAMPLING } from './lighting-g01-policy.mjs';
import { validateDeferred021Contract, canonicalInputPaths, assessG01Stability, assessG01Readiness, assessG01Channel, G01_APPROVED_CEILINGS, validateG01CaseIdentity, validateG01FrozenManifest } from './lighting-g01-policy.mjs';
import { readFileSync } from 'node:fs';

function fixture() {
  const samples = Array.from({length:300},(_,i)=>i>=285?9:1);
  return {suite:'lighting.g01.existing-instances',adapter:{vendor:'intel',architecture:'gen-9',isFallbackAdapter:false},count:1000,counts:[334,333,333],warmup:120,resolution:[1280,720],validationErrors:0,normalFrameInstanceReadbackBytes:0,timing:{cpuRecord:summarizeTimingSamples(samples),frameWall:summarizeTimingSamples(samples),gpuTimestamp:{status:'available',timing:summarizeTimingSamples(samples)}}};
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
  assert.deepEqual(G01_SAMPLING,{warmup:120,samples:300,cohorts:3,interCaseIdleMs:30000});
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
test('approved absolute ceiling retains instability and rejects even stable over-budget data',()=>{
  const options={deviceId:'mac-amd-rdna1',caseId:'instances-1k',channel:'gpuTimestamp',ceilings:G01_APPROVED_CEILINGS};
  const result=assessG01Channel([.050718,.078598,.050918],options);
  assert.equal(result.stable,false);assert.equal(result.acceptance,'approved-absolute-ceiling');
  assert.equal(assessG01Channel([.11,.11,.11],options).accepted,false);
  assert.equal(assessG01Channel([.05,.078,.05],{...options,deviceId:'mac-intel-gen9'}).accepted,false);
  assert.equal(assessG01Channel([.05,.078,.05],{...options,channel:'cpuRecord'}).accepted,false);
  assert.equal(assessG01Channel([.17,.135,.14],{...options,caseId:'instances-10k',channel:'cpuRecord'}).accepted,true);
  assert.equal(assessG01Channel([.17,.23,.14],{...options,caseId:'instances-10k',channel:'cpuRecord'}).accepted,false);
});
test('frozen contracts cannot expand named exceptions, omit timing channels or hide nonfinite memory',()=>{
  const c=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url),'utf8'));
  assert.deepEqual(validateDeferred021Contract(c,{requireFrozen:true}),[]);
  for(const mutate of [x=>{x.baselineVarianceCeilings.limits[0].maxCohortP95Ms=.2;},x=>{x.baselineVarianceCeilings.approvedBy='inferred';},x=>{x.devices[0].frameWallP95Ms=NaN;},x=>{delete x.cases.find(s=>s.group==='E').absoluteBudgets;},x=>{x.memory.maxWidth=NaN;},x=>{delete x.relativeBudgets.smallSceneGpuP95RegressionRatio;}]) {
    const bad=structuredClone(c);mutate(bad);assert.ok(validateDeferred021Contract(bad,{requireFrozen:true}).length);
  }
});
test('independent validation binds actual adapter and workload, not just filenames',()=>{
  const r=fixture(), c={fixture:'instances',count:1000}, d={vendor:'intel',architecture:'gen-9'};
  assert.deepEqual(validateG01CaseIdentity(r,c,d),[]);
  assert.match(validateG01CaseIdentity(r,c,{vendor:'amd',architecture:'rdna-1'}).join(),/adapter/);
  r.count=10000;assert.match(validateG01CaseIdentity(r,c,d).join(),/workload/);
  const bad=fixture();bad.timing.frameWall.rawSamples.pop();assert.match(validateG01Baseline(bad).join(),/frameWall population/);
  bad.counts=[1001,-1,0];assert.match(validateG01Baseline(bad).join(),/coverage/);
});
test('frozen evidence rejects tampered policy, omitted files and changed raw bytes',()=>{
  const value={summary:{sourceHash:'source',revision:'commit'},evidence:{sourceHash:'source',revision:'commit',finalPolicySha256:'policy',captureFiles:[{file:'a',sha256:'hash-a'},{file:'b',sha256:'hash-b'}]},expectedFiles:['a','b'],policyHash:'policy',fileHashes:{a:'hash-a',b:'hash-b'}};
  assert.deepEqual(validateG01FrozenManifest(value),[]);
  for(const mutate of [v=>{v.policyHash='changed';},v=>{v.evidence.captureFiles.pop();},v=>{v.fileHashes.b='changed';},v=>{v.evidence.sourceHash='changed';}]) {
    const bad=structuredClone(value);mutate(bad);assert.ok(validateG01FrozenManifest(bad).length);
  }
});
