import test from 'node:test';
import assert from 'node:assert/strict';
import {generateDeferredTiledProduction} from '../scripts/generate-deferred-tiled-production.mjs';
import {compileDeferredLightingArtifact} from '../scripts/generate-deferred-lighting-production.mjs';

test('tiled family keeps reference surface/global lighting and specializes point evaluation without changing global lighting',async()=>{
  const reference=await compileDeferredLightingArtifact(),result=await generateDeferredTiledProduction();
  assert.equal(reference.artifactHash,'a86678918dce8989b276ec17cf312e1c4c1be96d071528454e49f16ead516586');
  assert.equal(result.passCount,2);
  const pass=result.artifact.passes['deferred-tiled'],original=reference.passes['deferred-reference'];
  const localBegin=original.code.indexOf('  for (var index = 0u; index < lightView.pointCount; index++) {');
  assert.ok(pass.code.includes(original.code.slice(0,localBegin)));
  assert.ok(pass.code.endsWith(original.code.slice(original.code.indexOf('  let dielectricF = fresnelSchlickRoughnessF90',localBegin))));
  assert.deepEqual(pass.renderTargets,original.renderTargets);
  assert.deepEqual(pass.bindGroups.slice(0,3),original.bindGroups.slice(0,3));
  assert.deepEqual(pass.bindGroups[3].bindings.slice(0,-2),original.bindGroups[3].bindings);
  assert.match(pass.code,/if \(tileRange.z != 0u\) \{/);
  assert.match(pass.code,/let local = pointIndices\[index\];/);
  assert.match(pass.code,/let local = tileWords\[tileRange.x \+ index\];/);
  assert.equal((pass.code.match(/direct \+= deferredPoint\(/g)??[]).length,2);
  assert.match(pass.code,/if \(distance >= range\)/);
  assert.match(pass.code,/if \(nDotL <= 0.0\)/);
});
test('compute reflection owns exactly three storage buffers and matches the frozen tile ABI',async()=>{
  const {artifact}=await generateDeferredTiledProduction(),cull=artifact.passes['deferred-tile-cull'];
  assert.deepEqual(cull.entryPoints,{compute:'cs_main'});
  const bindings=cull.bindGroups.flatMap(group=>group.bindings);
  assert.equal(bindings.filter(binding=>binding.layout.kind==='buffer'&&binding.layout.bufferType.includes('storage')).length,3);
  assert.ok(bindings.every(binding=>JSON.stringify(binding.visibility)==='["compute"]'));
  assert.equal(cull.bindGroups[0].owner,'artifact');
  for(const literal of ['TILE_SIZE: u32 = 16u','TILE_WORKGROUP_SIZE: u32 = 64u','TILE_CAPACITY: u32 = 128u','TILE_STRIDE_WORDS: u32 = 132u'])assert.ok(cull.code.includes(literal));
  assert.ok(cull.code.includes('source.header.sourceGeneration != lightView.sourceGeneration'));
  assert.ok(!cull.code.includes('textureLoad'), 'no opaque depth rejection');
});
