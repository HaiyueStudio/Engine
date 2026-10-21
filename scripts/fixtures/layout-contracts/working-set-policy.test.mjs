import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateWorkingSetContract,validateRegionMemory} from './working-set-policy.mjs';
const contract=JSON.parse(readFileSync(new URL('../../../config/region-working-set-022-contract.json',import.meta.url),'utf8'));
const sample={retainedColorBytes:0,workingColorBytes:82944000,workingRetiringColorBytes:0,regionDepthBytes:33177600,totalRegionAttachmentBytes:116121600,cachedRegions:0};
const gpu={texture:{estimatedBytes:116121600}};
test('approved working population leaves cache limits fixed and accepts fully counted 1080p MSAA4',()=>{
 validateWorkingSetContract(contract);validateRegionMemory(sample,gpu);
});
test('reject expanded cache, hidden retirement, partial totals and incomplete full GPU accounting',()=>{
 for(const mutate of [s=>s.retainedColorBytes=67108865,s=>s.cachedRegions=9,s=>s.workingRetiringColorBytes=s.workingColorBytes+1,s=>s.regionDepthBytes=0,s=>delete s.workingColorBytes,s=>s.totalRegionAttachmentBytes=NaN]){
  const s=structuredClone(sample);mutate(s);assert.throws(()=>validateRegionMemory(s,gpu));
 }
 assert.throws(()=>validateRegionMemory(sample,{texture:{estimatedBytes:82944000}}));
 for(const mutate of [c=>c.cache.maxRegions=9,c=>c.cache.maxRetainedColorBytes++,c=>c.requiredMetrics.pop(),c=>c.workingSet.previousFramePixels='allowed']){
  const c=structuredClone(contract);mutate(c);assert.throws(()=>validateWorkingSetContract(c));
 }
});
