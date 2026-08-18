import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PRODUCTION_MATERIAL_LIGHTING_OPERATIONS,
  ShaderComposerError,
  compileProductionMaterialLightingFamilyV1,
} from '../dist/index.js';

const path = 'shader-language/builtin-material-lighting-family.json';
const source = await readFile(new URL('../builtin-material-lighting-family.json', import.meta.url), 'utf8');
const compiled = compileProductionMaterialLightingFamilyV1(source, { sourcePath: path, sourceSha256: sha256(source) });

test('stage 11 compiles the reviewed material-lighting family atomically', () => {
  assert.equal(compiled.family.abiVersion, 1);
  assert.equal(compiled.artifact.version, 2);
  assert.equal(compiled.artifact.compilerVersion, 'shader-language-stage11');
  assert.deepEqual(Object.values(compiled.passes).map(pass => pass.operation), [...PRODUCTION_MATERIAL_LIGHTING_OPERATIONS]);
  assert.equal(Object.keys(compiled.passes).length, 6);
  for (const pass of Object.values(compiled.passes)) {
    assert.equal((pass.code.match(/struct FogUniforms/g) ?? []).length, 1);
    assert.match(pass.code, /haiyue:material-lighting-abi 1/);
    assert.match(pass.code, new RegExp(`haiyue:material-lighting-module ${compiled.lightingModuleHash}`));
  }
  const second = compileProductionMaterialLightingFamilyV1(source, { sourcePath: path, sourceSha256: sha256(source) });
  assert.equal(second.artifact.artifactHash, compiled.artifact.artifactHash);
});

test('stage 11 reflection freezes lighting, material, shadow and deformation ABI', () => {
  const passes = compiled.artifact.passes;
  for (const id of ['pbr', 'pbr-clearcoat', 'pbr-transmission', 'pbr-transmission-clearcoat']) {
    const pass = passes[id];
    assert.ok(pass.passRequirements.includes('eight-light-cap'));
    assert.ok(pass.passRequirements.includes('three-directional-shadow-cap'));
    assert.ok(pass.passRequirements.includes('deformation-abi-v1'));
    assert.ok(pass.passRequirements.includes('world-space-clipping'));
    assert.equal(pass.uniformBlocks.find(block => block.id === 'material.pbrParameters').byteSize, 608);
    assert.equal(pass.uniformBlocks.find(block => block.id === 'pass.lights').byteSize, 528);
    assert.equal(pass.uniformBlocks.find(block => block.id === 'pass.directionalShadows').byteSize, 240);
    assert.deepEqual(pass.bindGroups[3].bindings.slice(8, 11).map(binding => binding.id), [
      'object.currentJointMatrices', 'geometry.skinJoints', 'geometry.skinWeights',
    ]);
  }
  assert.ok(passes['pbr-clearcoat'].passRequirements.includes('clearcoat-enabled'));
  assert.ok(passes['pbr-transmission'].passRequirements.includes('transmission-enabled'));
  assert.ok(passes['blinn-phong'].passRequirements.includes('world-space-clipping'));
  assert.ok(passes.toon.passRequirements.includes('world-space-clipping'));
  assert.equal(passes['blinn-phong'].uniformBlocks.find(block => block.id === 'material.blinnPhongParameters').byteSize, 64);
  assert.equal(passes.toon.uniformBlocks.find(block => block.id === 'material.toonParameters').byteSize, 240);
  assert.equal(passes.toon.uniformBlocks.find(block => block.id === 'pass.directionalShadows').byteSize, 80);
});

test('stage 11 rejects partial families and stale provenance', () => {
  const partial = source.replace(/,\s*\{ "id": "toon"[^\n]+/, '');
  assert.throws(() => compileProductionMaterialLightingFamilyV1(partial, {
    sourcePath: path,
    sourceSha256: sha256(partial),
  }), ShaderComposerError);
  assert.throws(() => compileProductionMaterialLightingFamilyV1(source, {
    sourcePath: path,
    sourceSha256: '0'.repeat(64),
  }), ShaderComposerError);
});

test('stage 11 production integration removes runtime WGSL composition and old sources', async () => {
  const renderers = await Promise.all([
    '../../engine/src/renderer/PbrRenderer.ts',
    '../../engine/src/renderer/BlinnPhongRenderer.ts',
    '../../engine/src/renderer/ToonRenderer.ts',
  ].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  assert.ok(renderers.every(value => /getBuiltinMaterialLightingShader\(/.test(value)));
  assert.ok(renderers.every(value => !/createComposedShaderModule\(|composeWgsl\(/.test(value)));
  for (const file of [
    '../../engine/src/shaders/pbr-metallic-roughness.wgsl',
    '../../engine/src/shaders/blinn-phong.wgsl',
    '../../engine/src/shaders/toon.wgsl',
    '../../engine/src/shaders/fog.wgsl',
    '../../engine/src/shaders/features/pbr-brdf.wgsl',
    '../../engine/src/shaders/features/pbr-clearcoat.wgsl',
    '../../engine/src/shaders/features/pbr-sheen.wgsl',
    '../../engine/src/shaders/features/pbr-shadow.wgsl',
  ]) await assert.rejects(access(new URL(file, import.meta.url)));
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
