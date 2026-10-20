import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateDeferredLightingProduction } from '../scripts/generate-deferred-lighting-production.mjs';
const contract=JSON.parse(await readFile(new URL('../deferred-lighting-extension-contract.json',import.meta.url),'utf8'));
test('Deferred production outputs match their private extension contract and exact measured costs',async()=>{
  const result=await generateDeferredLightingProduction();
  assert.equal(result.artifactVersion,2);
  assert.equal(result.artifactHash,contract.deferredArtifactHash);
  assert.equal(result.passCount,contract.passCount);
  assert.equal(result.wgslBytes,contract.wgslBytes);
  assert.equal(contract.publicExport,false);
});
test('Forward and Deferred geometry share the same surface, clipping and deformation implementation',async()=>{
  const read=name=>readFile(new URL(`../../engine/src/shaders/generated/${name}.generated.wgsl`,import.meta.url),'utf8');
  const [forward,deferred,resolve]=await Promise.all([read('material-lighting-pbr'),read('deferred-gbuffer'),read('deferred-reference')]);
  const shared=forward.slice(0,forward.indexOf('@fragment\nfn fs_main'));
  assert.ok(shared.includes('fn sampleStandardPbrSurface('));
  assert.ok(deferred.startsWith(shared));
  assert.match(deferred,/hy_is_clipped/);
  assert.match(deferred,/sampleStandardPbrSurface\(input\)/);
  assert.match(resolve,/sourceGeneration/);
  assert.match(resolve,/pointIndices/);
});

test('vertex RGBA preserves default WebGPU limits and alpha coverage in every generated consumer',async()=>{
  const read=name=>readFile(new URL(`../../engine/src/shaders/generated/${name}.generated.wgsl`,import.meta.url),'utf8');
  const pbr=await read('material-lighting-pbr');
  assert.match(pbr,/material\.baseColor \* input\.color/);
  assert.ok(pbr.indexOf('material.baseColor * input.color')<pbr.indexOf('base.a < material.factors.w'));
  for(const name of ['deformation-depth','deformation-shadow','deformation-shadow-morph','deformation-shadow-skinned','deformation-shadow-skinned-morph','deformation-motion-vector','deformation-outline','simple3d-normal-material']){
    const source=await read(name);
    assert.match(source,/@location\(12\) color\s*:\s*vec4<f32>/,name);
    assert.match(source,/coverage\.baseColor\.a \* vertexAlpha/,name);
    assert.match(source,/hy_has_material_coverage\((?:in|input)\.uv0, (?:in|input)\.uv1, (?:in|input)\.vertexAlpha\)/,name);
  }
  const {compileProductionDeformationFamilyV1}=await import('../dist/index.js');
  // The full eight-buffer PBR/motion layouts retain their existing storage bindings.
  const {createHash}=await import('node:crypto');
  const compile=async(file,fn)=>{
    const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');
    return fn(source,{sourcePath:`shader-language/${file}`,sourceSha256:createHash('sha256').update(source).digest('hex')});
  };
  const deformation=await compile('builtin-deformation-family.json',compileProductionDeformationFamilyV1);
  for(const [name,pass] of Object.entries(deformation.artifact.passes)){
    assert.ok(pass.vertexBuffers.length<=8,name);
    assert.ok(pass.vertexBuffers.flatMap(b=>b.attributes).length<=16,name);
    if(name.startsWith('forward'))continue;
    const color=pass.vertexBuffers.flatMap(b=>b.attributes).find(a=>a.semantic==='COLOR_0');
    assert.equal(color?.shaderLocation,12,name);
  }
});
