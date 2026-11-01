import test from'node:test';import assert from'node:assert/strict';
import{productionProfile}from'./tilemap-browser-policy.mjs';
import{validateTilemapProduction}from'./tilemap-production-policy.mjs';
const production=()=>{
 const workloads=[false,true].flatMap(atlas=>[0,1,10].map(mutation=>({atlas,mutation})));
 return {schemaVersion:1,status:'passed',adapter:{isFallbackAdapter:false},errors:[],profile:productionProfile,cohorts:[1,2].flatMap(round=>(round===2?[...workloads].reverse():workloads).map(spec=>{
  const frames=Array.from({length:2401},(_,i)=>({time:i*1000/60,intervalMs:1000/60,cpuMutationMs:0,cpuUpdateRenderSubmitMs:1,visible:true,focused:true,vertexUploadCalls:0,vertexUploadBytes:0,draws:2,residentChunks:2,activeBytes:100,retiredBytes:0,workingBytes:0,cpuVertexBytes:100,cpuMapBytes:524288}));
  return {...spec,round,firstRenderedAt:0,captureStartedAt:10000,completedAt:40000,readiness:[{frame:1,completedAt:1},{frame:2,completedAt:20}],warmup:frames.filter(f=>f.time<10000),samples:frames.filter(f=>f.time>=10000),gpuWorkingSet:{totals:{estimatedBytes:100}},beforeSceneDestroy:{totals:{estimatedBytes:100}},cleanup:{stats:{totalBytes:0}},finalGpu:{resources:0,estimatedBytes:0}};
 }))};
};
test('production keeps uninterrupted visible captures, original pacing and lifecycle budgets',()=>{
 assert.equal(validateTilemapProduction(production()).status,'passed');
 for(const change of [r=>r.cohorts.pop(),r=>r.cohorts.reverse(),r=>r.cohorts[0].completedAt--,r=>r.cohorts[0].warmup.pop(),r=>r.cohorts[0].samples[0].focused=false,r=>r.cohorts[0].samples[0].visible=false,r=>r.cohorts[0].samples[0].intervalMs=100,r=>r.cohorts[0].samples[0].vertexUploadCalls=1,r=>r.cohorts[0].cleanup.stats.totalBytes=1,r=>r.cohorts[0].readiness.pop(),r=>delete r.cohorts[0].gpuWorkingSet]){const r=production();change(r);assert.equal(validateTilemapProduction(r).status,'failed');}
});
test('first startup clock delta is retained; later negative or missing presented intervals still fail',()=>{
 const first=production();for(const c of first.cohorts)c.warmup[0].intervalMs=-60;assert.equal(validateTilemapProduction(first).status,'passed');
 for(const change of [r=>r.cohorts[0].warmup[0].intervalMs=NaN,r=>r.cohorts[0].warmup[1].intervalMs=-1,r=>r.cohorts[0].samples[0].intervalMs=-1,r=>r.cohorts[0].samples[0].focused=false]){const r=production();change(r);assert.equal(validateTilemapProduction(r).status,'failed');}
});
