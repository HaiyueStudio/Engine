import test from 'node:test';
import assert from 'node:assert/strict';
import {COMPATIBILITY_MATERIALS,COMPATIBILITY_LIGHT_COUNTS,parseCompatibilityOptions,validateCompatibilityEvidence} from './deferred-compatibility-policy.mjs';
function evidence(){return {schemaVersion:2,status:'passed',adapter:{vendor:'test',architecture:'test',isFallbackAdapter:false},validationErrors:[],cleanup:{ownerResidual:0,liveGpuResources:0},
  cases:COMPATIBILITY_MATERIALS.flatMap(materialCase=>['reference','tiled'].flatMap(algorithm=>COMPATIBILITY_LIGHT_COUNTS.map(count=>({materialCase,algorithm,count,completeCoverage:true,maxDelta:.0002,litPixels:4096,passes:[{name:'deferred-full-light-opaque',reads:['gbuffer'],writes:['opaque-color'],dependsOn:['resolve']},{name:'deferred-full-light-transparent',reads:['opaque-color'],writes:['scene-color'],dependsOn:['resolve']}]})))),
  contributions:COMPATIBILITY_MATERIALS.flatMap(materialCase=>Array.from({length:128},(_,entityId)=>({materialCase,entityId,pixel:[.001,.002,.003]})))};}
test('G04 options reject ignored, duplicate and ambiguous flags',()=>{
  assert.deepEqual(parseCompatibilityOptions([]),{preference:'high-performance'});
  assert.deepEqual(parseCompatibilityOptions(['--integrated']),{preference:'low-power'});
  for(const args of [['--full'],['--integrated','--integrated']])assert.throws(()=>parseCompatibilityOptions(args));
});
test('G04 evidence requires every material/light/backend combination and original Forward light contribution',()=>{
  validateCompatibilityEvidence(evidence());
  for(const change of [e=>e.cases.pop(),e=>e.cases.reverse(),e=>e.contributions.pop(),e=>e.contributions[0].entityId=e.contributions[1].entityId,
    e=>e.contributions[0].pixel[0]=NaN,e=>e.cases[0].completeCoverage=false,e=>e.cases[0].maxDelta=NaN,
    e=>e.cases[1].litPixels=0,e=>e.cases[0].passes[1].reads=['scene-color'],e=>e.cases[0].passes=[],
    e=>e.validationErrors=undefined,e=>e.cleanup.liveGpuResources=1,e=>e.adapter.isFallbackAdapter=true]){
    const bad=evidence();change(bad);assert.throws(()=>validateCompatibilityEvidence(bad));
  }
});
