import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PRODUCTION_DEFORMATION_OPERATIONS,
  ShaderComposerError,
  compileProductionDeformationFamilyV1,
} from '../dist/index.js';

const path = 'shader-language/builtin-deformation-family.json';
const source = await readFile(new URL('../builtin-deformation-family.json', import.meta.url), 'utf8');
const compiled = compileProductionDeformationFamilyV1(source, { sourcePath: path, sourceSha256: sha256(source) });

test('stage 10 atomically compiles the production deformation pass family', () => {
  assert.equal(compiled.family.abiVersion, 1);
  assert.equal(compiled.artifact.version, 2);
  assert.equal(compiled.artifact.compilerVersion, 'shader-language-stage10');
  assert.deepEqual(Object.values(compiled.passes).map(pass => pass.operation), [...PRODUCTION_DEFORMATION_OPERATIONS]);
  assert.equal(Object.keys(compiled.passes).length, 9);
  for (const pass of Object.values(compiled.passes)) {
    assert.match(pass.code, /haiyue:deformation-abi 1/);
    assert.match(pass.code, new RegExp(`haiyue:deformation-module ${compiled.deformationModuleHash}`));
  }
  const second = compileProductionDeformationFamilyV1(source, { sourcePath: path, sourceSha256: sha256(source) });
  assert.equal(second.artifact.artifactHash, compiled.artifact.artifactHash);
});

test('stage 10 reflection freezes current and history deformation ABI', () => {
  const passes = compiled.artifact.passes;
  for (const passId of ['forward', 'forward-skinned', 'depth', 'shadow', 'shadow-morph', 'shadow-skinned', 'shadow-skinned-morph', 'outline']) {
    assert.ok(passes[passId].passRequirements.includes('deformation-abi-v1'));
    assert.ok(passes[passId].passRequirements.includes('current-deformation-state'));
    assert.ok(passes[passId].passRequirements.includes('world-space-clipping'));
  }
  assert.deepEqual(passes['forward-skinned'].bindGroups[3].bindings.map(binding => binding.id), [
    'object.currentJointMatrices', 'geometry.skinJoints', 'geometry.skinWeights',
  ]);
  assert.deepEqual(passes.outline.bindGroups[3].bindings.map(binding => binding.id), [
    'object.currentJointMatrices', 'geometry.skinJoints', 'geometry.skinWeights',
  ]);
  const motion = passes['motion-vector'];
  assert.ok(motion.passRequirements.includes('world-space-clipping'));
  assert.ok(motion.passRequirements.includes('current-and-previous-same-deformation'));
  assert.deepEqual(motion.bindGroups[2].bindings.map(binding => binding.id), [
    'object.currentJointMatrices', 'object.previousJointMatrices', 'geometry.skinJoints', 'geometry.skinWeights',
  ]);
  const history = motion.uniformBlocks.find(block => block.id === 'object.deformationHistory');
  assert.equal(history.byteSize, 240);
  assert.deepEqual(history.fields.map(field => [field.name, field.offset]), [
    ['currentModel', 0], ['previousModel', 64], ['previousViewProjection', 128],
    ['currentMorphWeights', 192], ['previousMorphWeights', 208], ['deformationFlags', 224],
  ]);
});

test('stage 10 rejects partial families and stale provenance', () => {
  const partial = source.replace(/,\s*\{ "id": "outline"[^\n]+/, '');
  assert.throws(() => compileProductionDeformationFamilyV1(partial, {
    sourcePath: path,
    sourceSha256: sha256(partial),
  }), ShaderComposerError);
  assert.throws(() => compileProductionDeformationFamilyV1(source, {
    sourcePath: path,
    sourceSha256: '0'.repeat(64),
  }), ShaderComposerError);
});

test('stage 10 production integration removes handwritten deformation shader sources', async () => {
  const renderers = await Promise.all([
    '../../engine/src/renderer/Mesh3DRenderer.ts',
    '../../engine/src/renderer/DepthRenderer.ts',
    '../../engine/src/renderer/ShadowMapRenderer.ts',
    '../../engine/src/renderer/MotionVectorRenderer.ts',
    '../../engine/src/renderer/OutlineMaskRenderer.ts',
  ].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  assert.ok(renderers.every(value => /getBuiltinDeformationShader\(/.test(value)));
  assert.match(renderers[4], /CurrentDeformationGpuCache/);
  for (const file of [
    '../../engine/src/shaders/depth-material.wgsl',
    '../../engine/src/shaders/motion-vector.wgsl',
    '../../engine/src/shaders/outline-mask.wgsl',
    '../../engine/src/shaders/shadow-map.wgsl',
    '../../engine/src/shaders/features/morph.wgsl',
    '../../engine/src/shaders/features/skinning.wgsl',
    '../../engine/src/shaders/generated/simple3d-basic-material.generated.wgsl',
  ]) await assert.rejects(access(new URL(file, import.meta.url)));
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
