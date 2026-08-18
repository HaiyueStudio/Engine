import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPrecompiledShaderArtifactV2, ShaderComposerError } from '../dist/index.js';
import { PRODUCTION_SHADER_GENERATORS } from '../scripts/generate-production-shaders.mjs';

const registry = JSON.parse(await readFile(new URL('../production-source-registry.json', import.meta.url), 'utf8'));
const glslDecision = JSON.parse(await readFile(new URL('../glsl-es300-decision.json', import.meta.url), 'utf8'));

test('every production generator is Artifact V2 and has an explicit source retention decision', () => {
  assert.equal(registry.schemaVersion, 2);
  assert.equal(registry.artifactVersion, 2);
  assert.deepEqual(
    registry.families.map(family => family.id).sort(),
    PRODUCTION_SHADER_GENERATORS.map(generator => generator.id).sort(),
  );
  assert.ok(PRODUCTION_SHADER_GENERATORS.every(generator => generator.artifactVersion === 2));
  for (const family of registry.families) {
    assert.ok(family.sourceOwner.length > 0);
    assert.ok(family.generator.length > 0);
    assert.ok(family.artifact.length > 0);
    assert.ok(family.moduleId.length > 0);
    assert.ok(Number.isInteger(family.moduleVersion));
    assert.ok(family.typedSignature.length > 0);
    assert.ok(family.reflectionOwner.length > 0);
    assert.ok(family.layoutOwner.length > 0);
    assert.ok(family.variantOwner.length > 0);
    assert.ok(family.resources.length > 0);
    assert.ok(family.retention.length > 0);
    assert.deepEqual(family.targets, ['webgpu-wgsl']);
    assert.ok(family.escapeLevel === 0 || family.escapeLevel === 2);
  }
  assert.deepEqual(registry.families.map(family => family.stage), [6, 8, 9, 10, 11, 12, 13]);
  assert.equal(registry.portability.stage, 14);
});

test('Artifact V2 resource reflection rejects drift from production WGSL', () => {
  const definition = {
    compilerVersion: 'm025-test',
    source: { kind: 'module-family', path: 'm025-fixture', sha256: 'a'.repeat(64) },
    canonicalHash: 'b'.repeat(64),
    typedModuleHash: 'c'.repeat(64),
    passes: [{
      id: 'drift',
      code: '@group(0) @binding(0) var source : texture_2d<f32>;\n@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(); }\n@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(); }',
      entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
      bindGroups: [{
        logicalSpace: 'pass', logicalGroup: 3, physicalGroup: 0, owner: 'artifact',
        bindings: [{
          id: 'pass.source', binding: 0, visibility: ['fragment'],
          layout: { kind: 'sampler', samplerType: 'filtering' },
        }],
      }],
      uniformBlocks: [], vertexBuffers: [], varyings: [],
      renderTargets: [{ location: 0, formatClass: 'color' }],
      capabilities: [], passRequirements: [], sourceMap: [],
    }],
  };
  assert.throws(
    () => createPrecompiledShaderArtifactV2(definition),
    error => error instanceof ShaderComposerError
      && error.diagnostic.path === 'bindGroups.0:0.layout',
  );
});

test('runtime Artifact V2 types are generated from the canonical private contract', async () => {
  const source = await readFile(new URL('../src/adapter/precompiled-artifact-contract.ts', import.meta.url), 'utf8');
  const generated = await readFile(new URL('../../engine/src/shader/PrecompiledShaderArtifact.generated.ts', import.meta.url), 'utf8');
  const runtime = await readFile(new URL('../../engine/src/shader/PrecompiledShaderRuntime.ts', import.meta.url), 'utf8');
  assert.equal(generated, '// Generated from shader-language/src/adapter/precompiled-artifact-contract.ts. Do not edit.\n' + source);
  assert.doesNotMatch(runtime, /interface PrecompiledShaderArtifactV2|PrecompiledShaderArtifactV1/);
  assert.match(runtime, /artifact\.version !== 2/);
});

test('production binding remap no longer edits WGSL strings', async () => {
  const materialDefinitions = await readFile(new URL('../src/material-lighting/definitions.ts', import.meta.url), 'utf8');
  const pbrBindings = await readFile(new URL('../src/material-lighting/stdlib/pbr-skinning-bindings.wgsl', import.meta.url), 'utf8');
  assert.doesNotMatch(materialDefinitions, /\.replace\([^\n]*@group|\.replace\([^\n]*@binding/);
  assert.match(pbrBindings, /@binding\(8\)/);
  assert.match(pbrBindings, /@binding\(10\)/);
});

test('GLSL ES300 remains an optional IR portability verifier, not a product backend', () => {
  assert.equal(glslDecision.decision, 'retain-optional-portability-verifier');
  assert.equal(glslDecision.productBackend, false);
  assert.equal(glslDecision.runtimeDependency, false);
  assert.equal(glslDecision.productionFamilyTarget, false);
  assert.equal(glslDecision.webgl2Fallback, 'not-authorized');
  assert.ok(glslDecision.unsupported.includes('compute'));
  assert.ok(glslDecision.unsupported.includes('mrt'));
});
