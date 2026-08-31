import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  BUILTIN_RENDER_OPERATIONS,
  ShaderComposerError,
  compileBuiltinRenderFamilyV1,
} from '../dist/index.js';

const fixtures = await Promise.all([
  family('../builtin-engine-2d-ui-family.json'),
  family('../builtin-components-2d-ui-family.json'),
  family('../builtin-simple-3d-family.json'),
]);
const compiled = fixtures.map(value => compileBuiltinRenderFamilyV1(value.source, {
  sourcePath: value.path,
  sourceSha256: value.hash,
}));

test('current stage 9 families retain the historical seventeen passes plus indexed sprite', () => {
  const second = fixtures.map(value => compileBuiltinRenderFamilyV1(value.source, {
    sourcePath: value.path,
    sourceSha256: value.hash,
  }));
  assert.equal(compiled.length, 3);
  assert.equal(compiled.reduce((sum, value) => sum + Object.keys(value.passes).length, 0), 18);
  assert.ok(compiled[1].passes['indexed-sprite']);
  assert.deepEqual(
    compiled.map(value => value.artifact.artifactHash),
    second.map(value => value.artifact.artifactHash),
  );
  const operations = compiled.flatMap(value => Object.values(value.passes).map(pass => pass.operation));
  assert.deepEqual(
    [...operations].sort(),
    [...BUILTIN_RENDER_OPERATIONS['2d-ui'], ...BUILTIN_RENDER_OPERATIONS['simple-3d']].sort(),
  );
  for (const family of compiled) {
    assert.equal(family.artifact.version, 2);
    assert.equal(family.artifact.compilerVersion, 'shader-language-stage9');
    for (const pass of Object.values(family.artifact.passes)) {
      assert.ok(pass.code.includes('// haiyue:builtin-render'));
      assert.deepEqual(pass.bindGroups.map(group => group.physicalGroup), pass.bindGroups.map((_group, index) => index));
      assert.ok(pass.bindGroups.every(group => group.owner === 'renderer'));
      assert.ok(pass.vertexBuffers.every(buffer => buffer.attributes.every(attribute => attribute.semantic)));
    }
  }
});

test('stage 9 reflection preserves multi-group, vertex and uniform ABI boundaries', () => {
  const engine2d = compiled[0].artifact.passes;
  const components2d = compiled[1].artifact.passes;
  const simple3d = compiled[2].artifact.passes;
  assert.equal(components2d['animation-2d'].bindGroups.length, 4);
  assert.doesNotMatch(components2d['animation-2d'].code, /color\.rgb\s*=/);
  assert.match(components2d['animation-2d'].code, /color = vec4<f32>\(mix\(color\.rgb, tinted/);
  assert.match(components2d['animation-2d'].code, /fn fs_main_premultiplied_texture/);
  assert.match(components2d['animation-2d'].code, /source\.rgb \* object\.multiplyColor\.rgb/);
  assert.match(components2d['animation-2d'].code, /object\.screenColor\.rgb \* source\.a - source\.rgb \* object\.screenColor\.rgb/);
  assert.match(components2d['animation-2d'].code, /object\.params\.y < 0\.5/);
  assert.equal(components2d['animation-2d'].uniformBlocks.find(block => block.id === 'object.animation2d').byteSize, 1296);
  assert.deepEqual(components2d['animation-2d'].bindGroups.map(group => group.logicalSpace), [
    'frame', 'object', 'material', 'pass',
  ]);
  assert.equal(engine2d['gui-shape'].vertexBuffers[0].arrayStride, 60);
  assert.deepEqual(engine2d['particle2d'].vertexBuffers.map(buffer => buffer.stepMode), ['vertex', 'instance']);
  assert.equal(simple3d['basic-material'].bindGroups.length, 3);
  assert.equal(simple3d['basic-material-skinned'].bindGroups.length, 4);
  assert.deepEqual(simple3d['basic-material-skinned'].bindGroups[3].bindings.map(binding => binding.id), [
    'object.skinMatrices', 'object.skinJoints', 'object.skinWeights',
  ]);
  assert.equal(simple3d['basic-material'].uniformBlocks.find(block => block.id === 'frame.scene').byteSize, 272);
  assert.ok(simple3d['basic-material'].passRequirements.includes('world-space-clipping'));
  assert.ok(simple3d['basic-material-skinned'].passRequirements.includes('world-space-clipping'));
  assert.ok(simple3d['normal-material'].passRequirements.includes('world-space-clipping'));
  assert.equal(simple3d.sky.passRequirements.includes('world-space-clipping'), false);
  assert.equal(simple3d.particle3d.vertexBuffers[1].arrayStride, 48);
  assert.match(simple3d['basic-material-skinned'].code, /applyMorphPosition[\s\S]+skinPosition/);
});

test('stage 9 family parser rejects stale provenance, cross-family operations and duplicates', () => {
  assert.throws(() => compileBuiltinRenderFamilyV1(fixtures[0].source, {
    sourcePath: fixtures[0].path,
    sourceSha256: '0'.repeat(64),
  }), ShaderComposerError);
  const crossFamily = fixtures[0].source.replace('"operation": "bitmap-text"', '"operation": "sky"');
  assert.throws(() => compileBuiltinRenderFamilyV1(crossFamily, {
    sourcePath: fixtures[0].path,
    sourceSha256: sha256(crossFamily),
  }), ShaderComposerError);
  const duplicate = fixtures[1].source.replace('"operation": "spine2d"', '"operation": "animation-2d"');
  assert.throws(() => compileBuiltinRenderFamilyV1(duplicate, {
    sourcePath: fixtures[1].path,
    sourceSha256: sha256(duplicate),
  }), ShaderComposerError);
});

test('production renderers consume generated outputs and remove the seventeen handwritten entry sources', async () => {
  const engineFiles = [
    '../../engine/src/renderer/Mesh2DRenderer.ts',
    '../../engine/src/renderer/BitmapTextRenderer.ts',
    '../../engine/src/renderer/RadialShadowRenderer.ts',
    '../../engine/src/gui/rendering/GuiImageRenderer.ts',
    '../../engine/src/gui/rendering/GuiShapeRenderer.ts',
    '../../engine/src/gui/rendering/GuiTextRenderer.ts',
    '../../engine/src/systems/Particle2DRenderSystem.ts',
    '../../engine/src/renderer/Mesh3DRenderer.ts',
    '../../engine/src/renderer/NormalRenderer.ts',
    '../../engine/src/renderer/MeshHelperRenderer.ts',
    '../../engine/src/renderer/SkyRenderer.ts',
    '../../engine/src/systems/Particle3DRenderSystem.ts',
  ];
  const engineSources = await Promise.all(engineFiles.map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  assert.ok(engineSources.slice(0, 7).every(source => /getBuiltin2dUiShader\(/.test(source)));
  assert.match(engineSources[7], /getBuiltinDeformationShader\(/);
  assert.ok(engineSources.slice(8).every(source => /getBuiltinSimple3dShader\(/.test(source)));
  assert.ok(engineSources.every(source => !/createShaderModule\(\{[^}]*code:\s*(?:mesh2d|particle2d|particle3d|gui|RADIAL|BITMAP)/s.test(source)));

  const componentFiles = [
    '../../extensions/src/animation/Animation2DRenderSystem.ts',
    '../../extensions/src/canvas-text/CanvasText2DRenderSystem.ts',
    '../../extensions/src/spine/Spine2DGpuRenderer.ts',
    '../../extensions/src/tilemap/Tilemap2DRenderer.ts',
  ];
  for (const source of await Promise.all(componentFiles.map(path => readFile(new URL(path, import.meta.url), 'utf8')))) {
    assert.match(source, /shaders\/generated\/2d-ui-.+\.generated\.wgsl/);
  }

  const removed = [
    '../../extensions/src/shaders/animation-2d.wgsl',
    '../../extensions/src/shaders/canvas-text-2d.wgsl',
    '../../extensions/src/shaders/spine2d.wgsl',
    '../../extensions/src/shaders/tilemap2d.wgsl',
    '../../engine/src/shaders/basic-material-skinned.wgsl',
    '../../engine/src/shaders/basic-material.wgsl',
    '../../engine/src/shaders/bitmap-text.wgsl',
    '../../engine/src/shaders/gui-image.wgsl',
    '../../engine/src/shaders/gui-shape.wgsl',
    '../../engine/src/shaders/gui-text.wgsl',
    '../../engine/src/shaders/mesh-helper.wgsl',
    '../../engine/src/shaders/mesh2d.wgsl',
    '../../engine/src/shaders/normal-material.wgsl',
    '../../engine/src/shaders/particle2d.wgsl',
    '../../engine/src/shaders/particle3d.wgsl',
    '../../engine/src/shaders/radial-shadow.wgsl',
    '../../engine/src/shaders/sky.wgsl',
  ];
  for (const path of removed) await assert.rejects(access(new URL(path, import.meta.url)));
});

test('stage 9 migration inventory and commands keep the compiler private', async () => {
  const [contract, manifest, rootPackage, enginePackage, componentsPackage, registry] = await Promise.all([
    readFile(new URL('../stage9-contract.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../migration-manifest.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../engine/package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../extensions/package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../scripts/generate-production-shaders.mjs', import.meta.url), 'utf8'),
  ]);
  const sources = manifest.sourceFamilies.flatMap(value => value.sources);
  const generated = manifest.sourceFamilies.filter(value => value.status === 'generated').flatMap(value => value.sources);
  assert.ok(manifest.stage >= 9);
  assert.equal(contract.phase, 9);
  assert.equal(contract.artifact.passCount, 17);
  assert.ok(contract.bundle.engineArtifactGzipBytes <= contract.bundle.engineArtifactGzipBudgetBytes);
  assert.ok(sources.length >= 58);
  assert.ok(generated.length >= 30);
  assert.equal(manifest.sourceFamilies.find(value => value.id === '2d-ui').status, 'generated');
  assert.equal(manifest.sourceFamilies.find(value => value.id === 'simple-3d').status, 'generated');
  assert.match(registry, /id: 'builtin-render'/);
  assert.match(rootPackage.scripts['shader-language:stage9:check'], /stage9-render-families\.test\.mjs/);
  assert.match(rootPackage.scripts['shader-language:stage9:check'], /check-stage9-bundle\.mjs/);
  assert.match(rootPackage.scripts['verify:shader-language-stage9'], /verify:shader-language-stage8/);
  assert.equal(enginePackage.exports['./internal/2d-ui-shader-artifact'], undefined);
  assert.equal(enginePackage.exports['./internal/simple3d-shader-artifact'], undefined);
  assert.equal(componentsPackage.exports['./internal/2d-ui-shader-artifact'], undefined);
});

async function family(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  return { path: `shader-language/${path.slice(3)}`, source, hash: sha256(source) };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
