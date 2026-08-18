import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createShaderLanguageShowcaseBundle,
  generateShaderLanguageShowcaseExample,
} from '../scripts/generate-showcase-example.mjs';

const root = new URL('../../', import.meta.url);

test('showcase lowers one canonical Typed IR to portable WGSL and GLSL artifacts', () => {
  const bundle = createShaderLanguageShowcaseBundle();
  assert.equal(bundle.runtimeCompilerIncluded, false);
  assert.equal(bundle.productRendererContract, 'webgpu-only-unchanged');
  assert.match(bundle.canonicalHash, /^[0-9a-f]{64}$/);
  assert.match(bundle.wgsl.compositionHash, /^[0-9a-f]{64}$/);
  assert.match(bundle.glsl.backendHash, /^[0-9a-f]{64}$/);
  assert.equal(bundle.metrics.pipelineCount, 2);
  assert.equal(bundle.metrics.variantCount, 1);
  assert.equal(bundle.metrics.irNodeCountBeforeOptimization, bundle.metrics.nodeCount);
  assert.ok(bundle.metrics.irNodeCountAfterOptimization < bundle.metrics.irNodeCountBeforeOptimization);
  assert.ok(bundle.metrics.sourceBytes > Buffer.byteLength(bundle.wgsl.code));
  assert.equal(bundle.metrics.staticVariantCount, 1);
  assert.equal(bundle.graph.nodes.length, 9);
  assert.deepEqual(bundle.glsl.entries.map(entry => entry.stage).sort(), ['fragment', 'vertex']);
  assert.match(bundle.wgsl.code, /@fragment fn fragmentMain/);
  assert.match(bundle.glsl.entries.find(entry => entry.stage === 'fragment').code, /#version 300 es/);

  const irSources = new Set(bundle.ir.entries.flatMap(entry => entry.nodes.map(node => node.source.sourceId)));
  for (const node of bundle.graph.nodes) assert.equal(irSources.has(node.sourceId), true, node.sourceId);

  const wgsl = bundle.wgsl.reflection.uniformBlocks.find(block => block.id === 'material.params');
  const glsl = bundle.glsl.uniformBlocks.find(block => block.resourceId === 'material.params').layout;
  assert.deepEqual(
    { byteSize: wgsl.byteSize, fields: wgsl.fields.map(field => [field.name, field.type, field.offset, field.size]) },
    { byteSize: glsl.byteSize, fields: glsl.fields.map(field => [field.name, field.type, field.offset, field.size]) },
  );

  assert.equal(bundle.pbr.graph.nodes.length, 6);
  assert.equal(bundle.pbr.variantPolicy.reachableSpecializationVariants, 1);
  assert.deepEqual(bundle.pbr.variantPolicy.specializationAxes, []);
  assert.deepEqual(bundle.pbr.variantPolicy.reservedSpecializationAxes, ['clearcoat', 'transmission']);
  assert.equal(bundle.pbr.variantPolicy.maximumSpecializationVariants, 4);
  assert.equal(bundle.pbr.variantPolicy.reachablePilotFamilyVariants, 1);
  assert.equal(bundle.pbr.variantPolicy.maximumPilotFamilyVariants, 8);
  assert.match(bundle.pbr.wgsl.code, /showcasePbrVertex/);
  assert.match(bundle.pbr.wgsl.code, /textureSample\(/);
  assert.ok(bundle.pbr.wgsl.sourceMap.some(span => span.sourceId === '@lighting.metallic-roughness'));
  assert.ok(bundle.pbr.wgsl.sourceMap.some(span => span.sourceId === 'scene.fog'));
  assert.deepEqual(bundle.pbr.wgsl.reflection.resources.map(resource => [resource.id, resource.group]), [
    ['frame.scene', 0],
    ['material.parameters', 2],
    ['material.albedoTexture', 2],
    ['material.normalTexture', 2],
    ['material.surfaceSampler', 2],
  ]);

  assert.equal(bundle.character.program.jointCount, 19);
  assert.equal(bundle.character.program.morphTargetCount, 2);
  assert.deepEqual(bundle.character.passOrder, ['forward', 'depth', 'shadow', 'motion-vector', 'outline-selection']);
  assert.equal(Object.keys(bundle.character.passes).length, 5);
  for (const pass of Object.values(bundle.character.passes)) {
    assert.equal(pass.deformationModuleHash, bundle.character.deformationModuleHash);
    assert.match(pass.code, new RegExp(bundle.character.deformationModuleHash));
    assert.match(pass.code, /fn hy_deform_vertex\(/);
  }
  assert.equal(bundle.character.passes['motion-vector'].reflection.historySemantics, 'current-and-previous-same-ir');
  assert.equal(bundle.character.passes.forward.reflection.uniformBlocks[0].byteSize, 416);
});

test('showcase artifact is current and browser runtime has no compiler dependency', async () => {
  await generateShaderLanguageShowcaseExample();
  const [generated, main, renderer, pbrRenderer, characterRenderer, characterMaterial, manifest, packageJson, cacheGate] = await Promise.all([
    readFile(new URL('examples/shader-language-lab/generated/showcase.generated.ts', root), 'utf8'),
    readFile(new URL('examples/shader-language-lab/main.ts', root), 'utf8'),
    readFile(new URL('examples/shader-language-lab/DualBackendRenderer.ts', root), 'utf8'),
    readFile(new URL('examples/shader-language-lab/PbrMaterialRenderer.ts', root), 'utf8'),
    readFile(new URL('examples/shader-language-lab/CharacterPassRenderer.ts', root), 'utf8'),
    readFile(new URL('examples/shader-language-character-material/main.ts', root), 'utf8'),
    readFile(new URL('examples/manifest.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('package.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('shader-language/scripts/verify-production-cache.mjs', root), 'utf8'),
  ]);
  assert.match(generated, /^\/\/ Generated by/);
  assert.doesNotMatch(generated, /^import /m);
  assert.doesNotMatch(main + renderer + pbrRenderer + characterRenderer + characterMaterial, /@haiyue\/shader-language|compileShaderIrProgramToGlslEs300|defineTypedShaderModule/);
  const entry = manifest.entries.find(candidate => candidate.id === 'shader-language-lab');
  assert.equal(entry.entry, 'shader-language-lab/main.ts');
  assert.equal(entry.catalog.group, 'materials');
  assert.equal(entry.capabilities.includes('pixel-parity'), true);
  assert.equal(entry.capabilities.includes('pbr-material-graph'), true);
  assert.equal(entry.capabilities.includes('character-five-pass'), true);
  const characterEntry = manifest.entries.find(candidate => candidate.id === 'shader-language-character-material');
  assert.equal(characterEntry.entry, 'shader-language-character-material/main.ts');
  assert.equal(characterEntry.catalog.group, 'materials');
  assert.equal(characterEntry.capabilities.includes('character-material'), true);
  assert.equal(characterEntry.capabilities.includes('shared-deformation-abi'), true);
  assert.match(characterMaterial, /CharacterPassRenderer\.create/);
  assert.match(characterMaterial, /pixelDeltaFromReference/);
  assert.match(packageJson.scripts['shader-language:check'], /verify-production-cache\.mjs/);
  assert.match(cacheGate, /generate-showcase-example\.mjs/);
  assert.match(packageJson.scripts['verify:shader-language-lab'], /verify-shader-language-lab-example\.mjs/);
  assert.match(packageJson.scripts['verify:shader-language-character-material'], /verify-shader-language-character-material-example\.mjs/);
});
