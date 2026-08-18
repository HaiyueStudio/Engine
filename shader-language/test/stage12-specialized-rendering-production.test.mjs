import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PRODUCTION_SPECIALIZED_RENDERING_OPERATIONS,
  ShaderComposerError,
  compileProductionSpecializedRenderingFamilyV1,
} from '../dist/index.js';

const path = 'shader-language/builtin-specialized-rendering-family.json';
const source = await readFile(new URL('../builtin-specialized-rendering-family.json', import.meta.url), 'utf8');
const compiled = compileProductionSpecializedRenderingFamilyV1(source, { sourcePath: path, sourceSha256: sha256(source) });

test('stage 12 compiles the reviewed specialized render and texture utility family atomically', () => {
  assert.equal(compiled.family.abiVersion, 1);
  assert.equal(compiled.artifact.version, 2);
  assert.equal(compiled.artifact.compilerVersion, 'shader-language-stage12');
  assert.deepEqual(Object.values(compiled.passes).map(pass => pass.operation), [...PRODUCTION_SPECIALIZED_RENDERING_OPERATIONS]);
  assert.equal(Object.keys(compiled.passes).length, 7);
  for (const pass of Object.values(compiled.passes)) {
    assert.match(pass.code, /haiyue:specialized-rendering-abi 1/);
    assert.match(pass.code, new RegExp(`haiyue:specialized-rendering-module ${compiled.specializedModuleHash}`));
  }
  const second = compileProductionSpecializedRenderingFamilyV1(source, { sourcePath: path, sourceSha256: sha256(source) });
  assert.equal(second.artifact.artifactHash, compiled.artifact.artifactHash);
});

test('stage 12 reflection freezes renderer ownership, texture utility layouts and compute ABI', () => {
  const passes = compiled.artifact.passes;
  assert.deepEqual(passes['instanced-mesh3d'].bindGroups.map(group => group.owner), ['renderer', 'renderer']);
  assert.equal(passes['instanced-mesh3d'].uniformBlocks.find(block => block.id === 'pass.lights').byteSize, 528);
  assert.equal(passes.line3d.uniformBlocks.find(block => block.id === 'frame.lineCamera').byteSize, 96);
  assert.equal(passes.line3d.uniformBlocks.find(block => block.id === 'material.lineParameters').byteSize, 32);
  assert.equal(passes['planar-mirror'].uniformBlocks.find(block => block.id === 'material.planarMirror').byteSize, 80);
  assert.equal(passes.volume.bindGroups[1].bindings[0].id, 'object.volumeTable');
  assert.equal(passes['texture-convolution'].entryPoints.compute, 'main');
  assert.equal(passes['texture-convolution'].renderTargets.length, 0);
  assert.equal(passes['texture-convolution'].uniformBlocks[0].byteSize, 64);
  assert.deepEqual(passes['texture-convolution'].bindGroups.map(group => group.owner), ['artifact']);
  assert.deepEqual(passes.mipmap.bindGroups.map(group => group.owner), ['artifact']);
  assert.deepEqual(passes['equirectangular-to-cube'].bindGroups.map(group => group.owner), ['artifact']);
});

test('stage 12 rejects partial families and stale provenance', () => {
  const partial = source.replace(/,\s*\{ "id": "equirectangular-to-cube"[^\n]+/, '');
  assert.throws(() => compileProductionSpecializedRenderingFamilyV1(partial, {
    sourcePath: path,
    sourceSha256: sha256(partial),
  }), ShaderComposerError);
  assert.throws(() => compileProductionSpecializedRenderingFamilyV1(source, {
    sourcePath: path,
    sourceSha256: '0'.repeat(64),
  }), ShaderComposerError);
});

test('stage 12 production integration removes handwritten and inline specialized sources', async () => {
  const consumers = await Promise.all([
    '../../engine/src/renderer/InstancedMesh3DRenderer.ts',
    '../../engine/src/renderer/Line3DRenderer.ts',
    '../../engine/src/renderer/PlanarMirrorRenderer.ts',
    '../../engine/src/renderer/VolumeRenderer.ts',
    '../../engine/src/compute/TextureConvolutionProcessor.ts',
    '../../engine/src/assets/ImageTextureUpload.ts',
    '../../engine/src/lighting/EquirectangularReflectionMap.ts',
  ].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  assert.ok(consumers.every(value => /getBuiltinSpecializedRenderingShader\(/.test(value)));
  assert.ok(consumers.every(value => !/\/\*\s*wgsl\s*\*\//.test(value)));
  for (const file of [
    '../../engine/src/shaders/instanced-mesh3d.wgsl',
    '../../engine/src/shaders/line3d.wgsl',
    '../../engine/src/shaders/planar-mirror-material.wgsl',
    '../../engine/src/shaders/texture-convolution.wgsl',
    '../../engine/src/shaders/volume-material.wgsl',
  ]) await assert.rejects(access(new URL(file, import.meta.url)));
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
