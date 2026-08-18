import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  BUILTIN_POSTPROCESS_OPERATIONS,
  compileBuiltinPostprocessFamilyV1,
} from '../dist/index.js';

const familyUrl = new URL('../builtin-postprocess-family.json', import.meta.url);
const familySource = await readFile(familyUrl, 'utf8');
const sourceSha256 = createHash('sha256').update(familySource).digest('hex');
const ambientOcclusionExtension = JSON.parse(await readFile(
  new URL('../ambient-occlusion-postprocess-extension-contract.json', import.meta.url),
  'utf8',
));

function compile(source = familySource) {
  return compileBuiltinPostprocessFamilyV1(source, {
    sourcePath: 'shader-language/builtin-postprocess-family.json',
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    passGroup: 0,
  });
}

test('the stage 8 module family plus reviewed AO extension emits fourteen deterministic Artifact V2 production passes', () => {
  const first = compile();
  const second = compile();
  assert.deepEqual(Object.keys(first.passes), BUILTIN_POSTPROCESS_OPERATIONS);
  assert.equal(first.artifact.version, 2);
  assert.equal(first.artifact.compilerVersion, 'shader-language-stage8');
  assert.equal(first.artifact.source.kind, 'module-family');
  assert.equal(first.artifact.source.sha256, sourceSha256);
  assert.equal(first.artifact.artifactHash, second.artifact.artifactHash);
  assert.equal(first.artifact.artifactHash, ambientOcclusionExtension.artifact.artifactHash);
  for (const pass of Object.values(first.artifact.passes)) {
    assert.equal(pass.bindGroups.length, 1);
    assert.equal(pass.bindGroups[0].logicalSpace, 'pass');
    assert.equal(pass.bindGroups[0].logicalGroup, 3);
    assert.equal(pass.bindGroups[0].physicalGroup, 0);
    assert.equal(pass.bindGroups[0].owner, 'artifact');
    assert.match(pass.code, /haiyue:builtin-postprocess/);
  }
});

test('stage 8 reflection preserves uniforms, unfilterable depth and TAA MRT', () => {
  const { artifact } = compile();
  assert.equal(artifact.passes.sobel.uniformBlocks[0].byteSize, 32);
  assert.equal(artifact.passes['gaussian-blur'].uniformBlocks[0].fields.find(field => field.name === 'radius').type, 'i32');
  assert.equal(artifact.passes['outline-overlay'].bindGroups[0].bindings.length, 6);
  assert.equal(artifact.passes.taa.bindGroups[0].bindings[2].layout.sampleType, 'unfilterable-float');
  assert.equal(artifact.passes.taa.uniformBlocks[0].byteSize, 176);
  assert.equal(artifact.passes.taa.renderTargets.length, 2);
  assert.ok(artifact.passes.taa.passRequirements.includes('view-local-history'));
  for (const algorithm of ['ssao', 'sao', 'gtao']) {
    const pass = artifact.passes[algorithm];
    assert.equal(pass.bindGroups[0].bindings[1].layout.sampleType, 'unfilterable-float');
    assert.equal(pass.uniformBlocks[0].byteSize, 192);
    assert.equal(pass.uniformBlocks[0].fields.find(field => field.name === 'projectionMatrix').type, 'mat4x4<f32>');
    assert.equal(pass.uniformBlocks[0].fields.find(field => field.name === 'inverseProjectionMatrix').type, 'mat4x4<f32>');
    assert.ok(pass.passRequirements.includes('linear-depth'));
    assert.ok(pass.passRequirements.includes('view-normal'));
  }
  const denoise = artifact.passes['ao-denoise'];
  assert.equal(denoise.bindGroups[0].bindings.length, 6);
  assert.equal(denoise.bindGroups[0].bindings[1].layout.sampleType, 'unfilterable-float');
  assert.equal(denoise.bindGroups[0].bindings[2].layout.sampleType, 'unfilterable-float');
  assert.equal(denoise.uniformBlocks[0].byteSize, 192);
  assert.ok(denoise.passRequirements.includes('ambient-occlusion'));
  assert.ok(denoise.passRequirements.includes('linear-depth'));
  assert.ok(denoise.passRequirements.includes('view-normal'));
  const upscale = artifact.passes['ao-upscale'];
  assert.equal(upscale.bindGroups[0].bindings.length, 6);
  assert.equal(upscale.bindGroups[0].bindings[1].layout.sampleType, 'unfilterable-float');
  assert.equal(upscale.bindGroups[0].bindings[2].layout.sampleType, 'unfilterable-float');
});

test('module family rejects stale provenance, unknown operations and incomplete families', () => {
  assert.throws(
    () => compileBuiltinPostprocessFamilyV1(familySource, {
      sourcePath: 'shader-language/builtin-postprocess-family.json', sourceSha256: 'a'.repeat(64), passGroup: 0,
    }),
    /provenance/,
  );
  const value = JSON.parse(familySource);
  value.passes[0].operation = 'unknown';
  assert.throws(() => compile(JSON.stringify(value)), /Unknown or duplicate operation unknown/);
  value.passes.shift();
  assert.throws(() => compile(JSON.stringify(value)), /Unknown or duplicate operation|missing/);
  assert.throws(
    () => compileBuiltinPostprocessFamilyV1(familySource, {
      sourcePath: 'shader-language/builtin-postprocess-family.json', sourceSha256, passGroup: 1,
    }),
    /physical group 0/,
  );
});

test('production passes consume generated artifacts while CustomPass remains the explicit raw escape hatch', async () => {
  const paths = [
    'GrayscalePass.ts', 'SobelPass.ts', 'FxaaPass.ts', 'GaussianBlurPass.ts', 'OutlinePass.ts', 'TaaPass.ts', 'AmbientOcclusionPass.ts',
  ];
  const sources = await Promise.all(paths.map(path => readFile(new URL(`../../engine/src/postprocess/${path}`, import.meta.url), 'utf8')));
  for (const source of sources.slice(0, -1)) {
    assert.match(source, /getBuiltinPostprocessShader/);
    assert.doesNotMatch(source, /\.\.\/shaders\/postprocess\/(?:fullscreen|grayscale|sobel|fxaa|gaussian|outline|taa)/);
    assert.doesNotMatch(source, /createShaderModule/);
  }
  assert.match(sources.at(-1), /getAmbientOcclusionShader/);
  assert.doesNotMatch(sources.at(-1), /getBuiltinPostprocessShader/);
  for (const source of [sources[1], sources[3], sources[4], sources[5]]) {
    assert.match(source, /PrecompiledUniformBlockWriter/);
  }
  const [renderer, custom, passBase] = await Promise.all([
    readFile(new URL('../../engine/src/postprocess/PostProcessRenderer.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../engine/src/postprocess/CustomPass.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../engine/src/postprocess/PostProcessPass.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(renderer, /getBuiltinPostprocessShader\(device, 'present'\)/);
  assert.doesNotMatch(renderer, /@vertex|@fragment/);
  assert.match(custom, /fragmentCode/);
  assert.match(passBase, /postprocess-fullscreen\.generated\.wgsl/);
});

test('stage 8 remains historical while the AO extension reviews current production growth', async () => {
  const [contract, manifest, enginePackage, engineRollup, registry, baseArtifact, aoArtifact] = await Promise.all([
    readFile(new URL('../stage8-contract.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../migration-manifest.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../engine/package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../engine/rollup.config.js', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/generate-production-shaders.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../engine/src/shaders/generated/postprocess-builtins-artifact.generated.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../engine/src/shaders/generated/postprocess-ambient-occlusion-artifact.generated.ts', import.meta.url), 'utf8'),
  ]);
  const sources = manifest.sourceFamilies.flatMap(family => family.sources);
  const generated = manifest.sourceFamilies.filter(family => family.status === 'generated').flatMap(family => family.sources);
  assert.equal(contract.phase, 8);
  assert.equal(contract.moduleFamily.operationCount, 9);
  assert.equal(contract.inventory.wgslSourceCount, 58);
  assert.equal(contract.inventory.generatedSourceCount, 13);
  assert.equal(ambientOcclusionExtension.moduleFamily.sha256, sourceSha256);
  assert.equal(ambientOcclusionExtension.moduleFamily.operationCount, 14);
  assert.deepEqual(ambientOcclusionExtension.moduleFamily.addedOperations, ['ssao', 'sao', 'gtao', 'ao-denoise', 'ao-upscale']);
  assert.deepEqual(ambientOcclusionExtension.moduleFamily.algorithmOperations, ['ssao', 'sao', 'gtao']);
  assert.deepEqual(ambientOcclusionExtension.moduleFamily.supportOperations, ['ao-denoise', 'ao-upscale']);
  assert.ok(manifest.stage >= 8);
  assert.equal(contract.inventory.handwrittenSourceCount, 45);
  assert.ok(sources.length >= contract.inventory.wgslSourceCount);
  assert.ok(generated.length >= contract.inventory.generatedSourceCount);
  assert.equal(manifest.inlineShaderSites.length, contract.inventory.inlineShaderSiteCount);
  assert.equal(manifest.sourceFamilies.find(family => family.id === 'postprocess-builtins').sources.length, 15);
  assert.equal(ambientOcclusionExtension.inventoryDelta.generatedSourceCount, 5);
  assert.doesNotMatch(baseArtifact, /postprocess-(?:ssao|sao|gtao)\.generated\.wgsl/);
  for (const operation of ['ssao', 'sao', 'gtao', 'ao-denoise', 'ao-upscale']) assert.match(aoArtifact, new RegExp(`postprocess-${operation}\\.generated\\.wgsl`));
  assert.doesNotMatch(aoArtifact, /postprocess-(?:present|taa|outline-edge)\.generated\.wgsl/);
  assert.match(registry, /id: 'builtin-postprocess'/);
  assert.match(engineRollup, /internal\/postprocess-shader-artifact/);
  assert.equal(enginePackage.exports['./internal/postprocess-shader-artifact'], undefined);
  assert.deepEqual(contract.publicApiChanges, []);
  assert.equal(contract.apiBaselineUpdated, false);
});
