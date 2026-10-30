import assert from 'node:assert/strict';

export const regionMemoryMetrics=Object.freeze(['retainedColorBytes','workingColorBytes','workingRetiringColorBytes','regionDepthBytes','totalRegionAttachmentBytes']);
export function validateWorkingSetContract(c){
  assert.equal(c.schemaVersion,1);assert.equal(c.contractId,'engine-022-g04-working-set-v1');assert.equal(c.status,'accepted');assert.equal(c.targetVersion,'0.2.2');
  assert.equal(c.decision,'docs/for-ai/adr/0133-region-cache-working-set-accounting.md');
  assert.equal(c.cache.maxRegions,8);assert.equal(c.cache.maxRetainedColorBytes,64*1024*1024);
  assert.deepEqual(c.requiredMetrics,regionMemoryMetrics);
  assert.equal(c.workingSet.previousFramePixels,'forbidden; fully initialize before use in each recording');
  assert.equal(c.workingSet.budget,'separate from retained pixel cache; include in total GPU resource acceptance');return c;
}
export function validateRegionMemory(s,gpu){
  for(const key of regionMemoryMetrics)assert.ok(Number.isSafeInteger(s[key])&&s[key]>=0,`Invalid ${key}`);
  assert.ok(Number.isSafeInteger(s.cachedRegions)&&s.cachedRegions>=0&&s.cachedRegions<=8);
  assert.ok(s.retainedColorBytes<=64*1024*1024,'Retained cache exceeds unchanged cap');
  assert.ok(s.workingRetiringColorBytes<=s.workingColorBytes,'Retiring working color omitted from working total');
  assert.equal(s.totalRegionAttachmentBytes,s.retainedColorBytes+s.workingColorBytes+s.regionDepthBytes,'Incomplete regional attachment total');
  assert.ok(Number.isSafeInteger(gpu?.texture?.estimatedBytes)&&gpu.texture.estimatedBytes>=s.totalRegionAttachmentBytes,'Full texture accounting omits regional allocations');
  return s;
}
