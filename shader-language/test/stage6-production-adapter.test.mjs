import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ShaderComposerError,
  compileMotionBlurGraphV1,
  createMotionBlurPrecompiledArtifactV2,
} from '../dist/index.js';

const graphSource = await readFile(new URL('../pilot-motion-blur-postprocess.graph.json', import.meta.url), 'utf8');
const graphSha256 = createHash('sha256').update(graphSource).digest('hex');
const stage6Contract = JSON.parse(await readFile(new URL('../stage6-contract.json', import.meta.url), 'utf8'));

test('renderer adapter compacts logical pass group 3 to physical group 0 before WGSL emission', () => {
  const logical = compileMotionBlurGraphV1(graphSource, { id: 'pilot3.motion-blur' });
  const production = compileMotionBlurGraphV1(graphSource, { id: 'pilot3.motion-blur', passGroup: 0 });
  assert.equal(production.program.canonicalHash, logical.program.canonicalHash);
  assert.equal(production.compilation.typedModuleHash, logical.compilation.typedModuleHash);
  for (const pass of Object.keys(production.compilation.passes)) {
    assert.match(production.compilation.passes[pass].code, /@group\(0\)/);
    assert.doesNotMatch(production.compilation.passes[pass].code, /@group\(3\)/);
    assert.ok(production.compilation.passes[pass].reflection.resources.every(resource => (
      resource.space === 'pass' && resource.group === 0
    )));
    assert.notEqual(production.compilation.passes[pass].canonicalHash, logical.compilation.passes[pass].canonicalHash);
  }
});

test('precompiled production artifact contains complete binding layouts and uniform ABI', () => {
  const compiled = compileMotionBlurGraphV1(graphSource, { id: 'pilot3.motion-blur', passGroup: 0 });
  const artifact = createMotionBlurPrecompiledArtifactV2(compiled, {
    sourceGraphPath: 'shader-language/pilot-motion-blur-postprocess.graph.json',
    sourceGraphSha256: graphSha256,
  });
  assert.equal(artifact.format, 'haiyue-precompiled-shader-artifact');
  assert.equal(artifact.version, 2);
  assert.equal(artifact.passes['motion-blur-resolve'].bindGroups[0].logicalGroup, 3);
  assert.equal(artifact.passes['motion-blur-resolve'].bindGroups[0].physicalGroup, 0);
  assert.match(artifact.artifactHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(artifact.passes['motion-blur-resolve'].bindGroups[0].bindings.map(binding => [
    binding.id,
    binding.binding,
    binding.layout.kind,
    binding.layout.sampleType ?? binding.layout.samplerType ?? binding.layout.bufferType,
  ]), [
    ['pass.sourceColor', 0, 'texture', 'float'],
    ['pass.velocity', 1, 'texture', 'unfilterable-float'],
    ['pass.neighborMax', 2, 'texture', 'unfilterable-float'],
    ['pass.linearSampler', 3, 'sampler', 'filtering'],
    ['pass.motionBlurParameters', 4, 'buffer', 'uniform'],
  ]);
  assert.equal(artifact.passes['motion-blur-resolve'].uniformBlocks[0].byteSize, 48);
  assert.equal(artifact.passes['motion-tile-max'].uniformBlocks[0].byteSize, 16);
});

test('invalid renderer group remaps and incomplete artifact provenance are classified', () => {
  for (const passGroup of [-1, 4, 0.5]) {
    assert.throws(
      () => compileMotionBlurGraphV1(graphSource, { passGroup }),
      error => error instanceof ShaderComposerError
        && error.diagnostic.code === 'E_SHADER_RESOURCE_LIMIT'
        && error.diagnostic.path === 'options.passGroup',
    );
  }
  const compiled = compileMotionBlurGraphV1(graphSource, { passGroup: 0 });
  assert.throws(
    () => createMotionBlurPrecompiledArtifactV2(compiled, {
      sourceGraphPath: '',
      sourceGraphSha256: 'not-a-hash',
    }),
    error => error instanceof ShaderComposerError
      && error.diagnostic.code === 'E_SHADER_RESOURCE_CONFLICT'
      && error.diagnostic.path === 'source',
  );
});

test('stage 6 contract pins the generated production slice without a runtime compiler dependency', async () => {
  const compiled = compileMotionBlurGraphV1(graphSource, { id: 'pilot3.motion-blur', passGroup: 0 });
  const artifact = createMotionBlurPrecompiledArtifactV2(compiled, {
    sourceGraphPath: 'shader-language/pilot-motion-blur-postprocess.graph.json',
    sourceGraphSha256: graphSha256,
  });
  const [manifest, motionBlurSource, rootManifest, engineManifest, cacheGate] = await Promise.all([
    readFile(new URL('../../engine/src/shaders/generated/motion-blur-artifact.generated.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../engine/src/postprocess/MotionBlurPass.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../engine/package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../scripts/verify-production-cache.mjs', import.meta.url), 'utf8'),
  ]);
  assert.equal(stage6Contract.phase, 6);
  assert.equal(stage6Contract.artifact.version, 1, 'stage 6 remains an immutable historical record');
  assert.equal(artifact.version, 2, 'current production writer only emits Artifact V2');
  assert.deepEqual(stage6Contract.publicApiChanges, []);
  assert.equal(stage6Contract.apiBaselineUpdated, false);
  assert.match(manifest, /"version": 2/);
  assert.match(manifest, /PrecompiledShaderArtifactV2/);
  assert.match(motionBlurSource, /MOTION_BLUR_SHADER_ARTIFACT/);
  assert.match(motionBlurSource, /getPrecompiledShaderPassRuntime/);
  assert.doesNotMatch(motionBlurSource, /motion-blur-frag\.wgsl|compileMotionBlurGraphV1/);
  const dependencies = { ...engineManifest.dependencies, ...engineManifest.devDependencies };
  assert.equal(dependencies['@haiyue/shader-language'], undefined);
  assert.match(rootManifest.scripts['shader-language:check'], /verify-production-cache\.mjs/);
  assert.match(cacheGate, /generate-production-shaders\.mjs/);
  assert.match(rootManifest.scripts['verify:shader-language-stage6'], /verify:shader-language-stage5/);
  assert.match(rootManifest.scripts['verify:shader-language-stage6'], /verify:motion-blur/);
  for (const removed of [
    '../../engine/src/shaders/postprocess/motion-blur-frag.wgsl',
    '../../engine/src/shaders/postprocess/motion-tile-max-frag.wgsl',
    '../../engine/src/shaders/postprocess/motion-neighbor-max-frag.wgsl',
  ]) await assert.rejects(readFile(new URL(removed, import.meta.url), 'utf8'), /ENOENT/);
});
