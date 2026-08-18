import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ShaderComposerError,
  composeShaderModules,
  defineShaderModule,
  formatShaderCompilationMessage,
  mapShaderSourceLocation,
  sha256Hex,
} from '../dist/index.js';

const fragmentEntryPoint = Object.freeze({ id: 'fragmentMain', stage: 'fragment', name: 'fragmentMain' });

test('links modules deterministically and isolates equal logical symbol names', () => {
  const double = scalarFeature('math.double', 'value * 2.0');
  const square = scalarFeature('math.square', 'value * value');
  const first = fragmentEntry([double, square]);
  const second = fragmentEntry([square, double]);

  const left = composeShaderModules({ label: 'deterministic', entry: first });
  const right = composeShaderModules({ label: 'deterministic', entry: second });

  assert.deepEqual(left.moduleIds, ['math.double', 'math.square', 'fixture.entry']);
  assert.equal(left.code, right.code);
  assert.equal(left.irHash, right.irHash);
  assert.equal(left.variantKey, right.variantKey);

  const functions = [...left.code.matchAll(/fn (hy_math_(?:double|square)_[a-f0-9]{8}_apply)\b/g)]
    .map(match => match[1]);
  assert.equal(functions.length, 2);
  assert.notEqual(functions[0], functions[1]);
  assert.match(left.code, new RegExp(`${functions[0]}\\(${functions[1]}\\(0\\.5\\)\\)`));
});

test('allocates symbolic resources and derives uniform reflection from one layout', () => {
  const surface = defineShaderModule({
    id: 'material.surface',
    stages: ['fragment'],
    symbols: [{ id: 'shade', kind: 'function', visibility: 'export', stages: ['fragment'] }],
    resources: [
      {
        id: 'material.params',
        space: 'material',
        kind: 'uniform-buffer',
        visibility: ['fragment'],
        fields: [
          { id: 'baseColor', type: 'vec4<f32>' },
          { id: 'roughness', type: 'f32' },
          { id: 'emissive', type: 'vec3<f32>' },
        ],
      },
      {
        id: 'material.baseColorTexture',
        space: 'material',
        kind: 'texture',
        visibility: ['fragment'],
        valueType: 'texture_2d<f32>',
      },
      {
        id: 'material.baseColorSampler',
        space: 'material',
        kind: 'sampler',
        visibility: ['fragment'],
        valueType: 'sampler',
      },
    ],
    source: context => `
fn ${context.symbol('shade')}(uv : vec2<f32>) -> vec4<f32> {
  let sampled = textureSample(${context.resource('material.baseColorTexture')}, ${context.resource('material.baseColorSampler')}, uv);
  return sampled * ${context.uniformField('material.params', 'baseColor')} + vec4<f32>(${context.uniformField('material.params', 'emissive')}, 0.0);
}`,
  });
  const entry = defineShaderModule({
    id: 'material.entry',
    stages: ['fragment'],
    dependencies: [surface],
    imports: [{ from: 'material.surface', symbol: 'shade', stages: ['fragment'] }],
    entryPoints: [fragmentEntryPoint],
    source: context => `@fragment fn ${context.entryPoint('fragmentMain')}() -> @location(0) vec4<f32> {
  return ${context.imported('material.surface', 'shade')}(vec2<f32>(0.5));
}`,
  });

  const result = composeShaderModules({ label: 'material-layout', entry });
  assert.deepEqual(result.reflection.resources.map(({ id, group, binding }) => ({ id, group, binding })), [
    { id: 'material.params', group: 2, binding: 0 },
    { id: 'material.baseColorTexture', group: 2, binding: 1 },
    { id: 'material.baseColorSampler', group: 2, binding: 2 },
  ]);
  assert.deepEqual(result.reflection.uniformBlocks, [{
    id: 'material.params',
    alignment: 16,
    byteSize: 48,
    fields: [
      { name: 'baseColor', type: 'vec4<f32>', offset: 0, size: 16 },
      { name: 'roughness', type: 'f32', offset: 16, size: 4 },
      { name: 'emissive', type: 'vec3<f32>', offset: 32, size: 12 },
    ],
  }]);
  assert.match(result.code, /@group\(2\) @binding\(0\) var<uniform>/);
  assert.match(result.code, /@align\(16\) baseColor : vec4<f32>/);
  assert.match(result.code, /@group\(2\) @binding\(1\) var .*texture_2d<f32>/);
});

test('deduplicates compatible resource requests and merges stage visibility', () => {
  const vertexOwner = resourceOwner('resource.vertex', 'vertex');
  const fragmentOwner = resourceOwner('resource.fragment', 'fragment');
  const entry = defineShaderModule({
    id: 'resource.entry',
    stages: ['vertex', 'fragment'],
    dependencies: [fragmentOwner, vertexOwner],
    entryPoints: [fragmentEntryPoint],
    source: context => `@fragment fn ${context.entryPoint('fragmentMain')}() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,
  });
  const result = composeShaderModules({ label: 'resource-merge', entry });
  assert.equal(result.reflection.resources.length, 1);
  assert.deepEqual(result.reflection.resources[0].visibility, ['vertex', 'fragment']);
});

test('reports binding and resource declaration conflicts before code generation', () => {
  const first = fixedResourceOwner('binding.first', 'pass.first', 4);
  const second = fixedResourceOwner('binding.second', 'pass.second', 4);
  assertComposerError(() => composeShaderModules({
    label: 'fixed-conflict',
    entry: dependencyEntry('binding.entry', [first, second]),
  }), 'E_SHADER_BINDING_CONFLICT');

  const uniform = resourceOwner('conflict.uniform', 'fragment');
  const texture = defineShaderModule({
    id: 'conflict.texture',
    stages: ['fragment'],
    resources: [{
      id: 'material.shared',
      space: 'material',
      kind: 'texture',
      visibility: ['fragment'],
      valueType: 'texture_2d<f32>',
    }],
    source: () => 'const conflictTextureMarker : f32 = 1.0;',
  });
  assertComposerError(() => composeShaderModules({
    label: 'resource-conflict',
    entry: dependencyEntry('conflict.entry', [uniform, texture]),
  }), 'E_SHADER_RESOURCE_CONFLICT');
});

test('classifies capability, target, stage and direct binding errors', () => {
  const capability = defineShaderModule({
    id: 'capability.entry',
    stages: ['fragment'],
    requires: ['feature.derivatives'],
    entryPoints: [fragmentEntryPoint],
    source: context => `@fragment fn ${context.entryPoint('fragmentMain')}() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,
  });
  assertComposerError(
    () => composeShaderModules({ label: 'missing-capability', entry: capability }),
    'E_SHADER_CAPABILITY_MISSING',
  );
  assert.doesNotThrow(() => composeShaderModules({
    label: 'available-capability',
    entry: capability,
    availableCapabilities: ['feature.derivatives'],
  }));
  assertComposerError(
    () => composeShaderModules({ label: 'unsupported-target', entry: capability, target: 'webgl2-glsl-es300' }),
    'E_SHADER_TARGET_UNSUPPORTED',
  );

  const vertex = defineShaderModule({
    id: 'stage.vertex',
    stages: ['vertex'],
    symbols: [{ id: 'deform', kind: 'function', visibility: 'export', stages: ['vertex'] }],
    source: context => `fn ${context.symbol('deform')}() -> vec4<f32> { return vec4<f32>(1.0); }`,
  });
  const badImport = defineShaderModule({
    id: 'stage.entry',
    stages: ['fragment'],
    dependencies: [vertex],
    imports: [{ from: 'stage.vertex', symbol: 'deform', stages: ['fragment'] }],
    entryPoints: [fragmentEntryPoint],
    source: context => `@fragment fn ${context.entryPoint('fragmentMain')}() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,
  });
  assertComposerError(() => composeShaderModules({ label: 'stage-mismatch', entry: badImport }), 'E_SHADER_STAGE_MISMATCH');

  const rawBinding = defineShaderModule({
    id: 'binding.raw',
    stages: ['fragment'],
    entryPoints: [fragmentEntryPoint],
    source: context => `@group(2) @binding(0) var rawTexture : texture_2d<f32>;
@fragment fn ${context.entryPoint('fragmentMain')}() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,
  });
  assertComposerError(() => composeShaderModules({ label: 'raw-binding', entry: rawBinding }), 'E_SHADER_SOURCE_GENERATION_FAILED');
});

test('classifies dependency graph, capability conflict and invalid source failures', () => {
  const duplicateA = scalarFeature('duplicate.feature', 'value');
  const duplicateB = scalarFeature('duplicate.feature', 'value + 1.0');
  assertComposerError(() => composeShaderModules({
    label: 'duplicate-module-id',
    entry: dependencyEntry('duplicate.entry', [duplicateA, duplicateB]),
  }), 'E_SHADER_MODULE_ID_CONFLICT');

  const cycleA = rawModule('cycle.a');
  const cycleB = rawModule('cycle.b');
  cycleA.dependencies.push(cycleB);
  cycleB.dependencies.push(cycleA);
  assertComposerError(() => composeShaderModules({ label: 'cycle', entry: cycleA }), 'E_SHADER_DEPENDENCY_CYCLE');

  const provider = defineShaderModule({
    id: 'conflict.provider',
    stages: ['fragment'],
    provides: ['lighting.clustered'],
    source: () => 'const conflictProviderMarker : f32 = 1.0;',
  });
  const consumer = defineShaderModule({
    id: 'conflict.consumer',
    stages: ['fragment'],
    conflicts: ['lighting.clustered'],
    source: () => 'const conflictConsumerMarker : f32 = 1.0;',
  });
  assertComposerError(() => composeShaderModules({
    label: 'capability-conflict',
    entry: dependencyEntry('conflict.capability-entry', [provider, consumer]),
  }), 'E_SHADER_CAPABILITY_CONFLICT');

  const invalidSource = defineShaderModule({
    id: 'source.invalid',
    stages: ['fragment'],
    entryPoints: [fragmentEntryPoint],
    source: () => undefined,
  });
  assertComposerError(() => composeShaderModules({ label: 'invalid-source', entry: invalidSource }), 'E_SHADER_SOURCE_GENERATION_FAILED');
});

test('specializations are validated and enter code, hash and variant key', () => {
  const entry = defineShaderModule({
    id: 'variant.entry',
    stages: ['fragment'],
    specializations: [{ id: 'variant.useFog', type: 'bool', defaultValue: false }],
    entryPoints: [fragmentEntryPoint],
    source: context => `@fragment fn ${context.entryPoint('fragmentMain')}() -> @location(0) vec4<f32> {
  if (${context.specialization('variant.useFog')}) { return vec4<f32>(0.5); }
  return vec4<f32>(1.0);
}`,
  });
  const disabled = composeShaderModules({ label: 'variant', entry });
  const enabled = composeShaderModules({
    label: 'variant',
    entry,
    specializationValues: { 'variant.useFog': true },
  });
  assert.notEqual(disabled.code, enabled.code);
  assert.notEqual(disabled.irHash, enabled.irHash);
  assert.notEqual(disabled.variantKey, enabled.variantKey);
  assert.match(disabled.code, /const hy_spec_variant_useFog_[a-f0-9]{8} : bool = false;/);
  assert.match(enabled.code, /const hy_spec_variant_useFog_[a-f0-9]{8} : bool = true;/);
  assertComposerError(() => composeShaderModules({
    label: 'unknown-variant',
    entry,
    specializationValues: { 'variant.unknown': true },
  }), 'E_SHADER_SPECIALIZATION_INVALID');
});

test('maps generated compilation diagnostics back to module sources', () => {
  const entry = defineShaderModule({
    id: 'diagnostic.entry',
    sourceName: 'fixtures/diagnostic-entry.wgsl',
    stages: ['fragment'],
    entryPoints: [fragmentEntryPoint],
    source: context => `@fragment fn ${context.entryPoint('fragmentMain')}() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}`,
  });
  const result = composeShaderModules({ label: 'diagnostic', entry });
  const span = result.sourceMap.find(candidate => candidate.sourceId === 'diagnostic.entry');
  assert.ok(span);
  const location = mapShaderSourceLocation(result, span.generatedStartLine + 1, 7);
  assert.deepEqual(location, {
    sourceId: 'diagnostic.entry',
    sourceName: 'fixtures/diagnostic-entry.wgsl',
    line: 2,
    column: 7,
    generatedLine: span.generatedStartLine + 1,
  });
  assert.equal(formatShaderCompilationMessage(result, {
    message: 'expected expression',
    lineNum: span.generatedStartLine + 1,
    linePos: 7,
    type: 'error',
  }), 'fixtures/diagnostic-entry.wgsl:2:7 [error] expected expression');
});

test('expresses the current PBR skinning binding remap without WGSL string replacement', () => {
  const skinning = defineShaderModule({
    id: 'vertex.skinning.pbr-stage1',
    stages: ['vertex'],
    symbols: [{ id: 'skinPosition', kind: 'function', visibility: 'export', stages: ['vertex'] }],
    resources: [
      {
        id: 'pass.skin.jointMatrices',
        space: 'pass',
        kind: 'storage-buffer-read',
        visibility: ['vertex'],
        valueType: 'array<mat4x4<f32>>',
        fixedBinding: 8,
      },
      {
        id: 'pass.skin.joints',
        space: 'pass',
        kind: 'storage-buffer-read',
        visibility: ['vertex'],
        valueType: 'array<vec4<f32>>',
        fixedBinding: 9,
      },
      {
        id: 'pass.skin.weights',
        space: 'pass',
        kind: 'storage-buffer-read',
        visibility: ['vertex'],
        valueType: 'array<vec4<f32>>',
        fixedBinding: 10,
      },
    ],
    source: context => `fn ${context.symbol('skinPosition')}(vertexIndex : u32, jointIndex : u32) -> vec4<f32> {
  let joints = ${context.resource('pass.skin.joints')}[vertexIndex];
  let weights = ${context.resource('pass.skin.weights')}[vertexIndex];
  return ${context.resource('pass.skin.jointMatrices')}[u32(joints.x) + jointIndex] * vec4<f32>(weights.xyz, 1.0);
}`,
  });
  const entry = defineShaderModule({
    id: 'vertex.skinning.fixture',
    stages: ['vertex'],
    dependencies: [skinning],
    imports: [{ from: 'vertex.skinning.pbr-stage1', symbol: 'skinPosition', stages: ['vertex'] }],
    entryPoints: [{ id: 'vertexMain', stage: 'vertex', name: 'vertexMain' }],
    source: context => `@vertex fn ${context.entryPoint('vertexMain')}(@builtin(vertex_index) vertexIndex : u32) -> @builtin(position) vec4<f32> {
  return ${context.imported('vertex.skinning.pbr-stage1', 'skinPosition')}(vertexIndex, 0u);
}`,
  });
  const result = composeShaderModules({ label: 'pbr-skinning-stage1', entry });
  assert.deepEqual(result.reflection.resources.map(resource => resource.binding), [8, 9, 10]);
  assert.deepEqual(result.reflection.resources.map(resource => resource.group), [3, 3, 3]);
  assert.match(result.code, /@group\(3\) @binding\(8\)/);
  assert.match(result.code, /@group\(3\) @binding\(9\)/);
  assert.match(result.code, /@group\(3\) @binding\(10\)/);
  assert.doesNotMatch(result.code, /\.replace\(/);
});

test('keeps the stage 1 machine contract private and bounded', async () => {
  const contract = JSON.parse(await readFile(new URL('../stage1-contract.json', import.meta.url), 'utf8'));
  assert.equal(contract.phase, 1);
  assert.equal(contract.status, 'implemented');
  assert.equal(contract.packageStatus, 'private-workspace');
  assert.deepEqual(contract.productionMigrations, []);
  assert.ok(contract.deliverables.includes('deterministic-module-linker'));
  assert.ok(contract.deferred.includes('typed-expression-ir'));
});

test('uses a portable deterministic SHA-256 implementation', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

function scalarFeature(id, expression) {
  return defineShaderModule({
    id,
    stages: ['fragment'],
    symbols: [{ id: 'apply', kind: 'function', visibility: 'export', stages: ['fragment'] }],
    source: context => `fn ${context.symbol('apply')}(value : f32) -> f32 { return ${expression}; }`,
  });
}

function fragmentEntry(dependencies) {
  return defineShaderModule({
    id: 'fixture.entry',
    stages: ['fragment'],
    dependencies,
    imports: [
      { from: 'math.double', symbol: 'apply', stages: ['fragment'] },
      { from: 'math.square', symbol: 'apply', stages: ['fragment'] },
    ],
    entryPoints: [fragmentEntryPoint],
    source: context => `@fragment fn ${context.entryPoint('fragmentMain')}() -> @location(0) vec4<f32> {
  let value = ${context.imported('math.double', 'apply')}(${context.imported('math.square', 'apply')}(0.5));
  return vec4<f32>(value);
}`,
  });
}

function resourceOwner(id, stage) {
  return defineShaderModule({
    id,
    stages: [stage],
    resources: [{
      id: 'material.shared',
      space: 'material',
      kind: 'uniform-buffer',
      visibility: [stage],
      fields: [{ id: 'value', type: 'f32' }],
    }],
    source: context => `const ${id.replaceAll('.', '_')}Marker : f32 = ${context.uniformField('material.shared', 'value')};`,
  });
}

function fixedResourceOwner(moduleId, resourceId, fixedBinding) {
  return defineShaderModule({
    id: moduleId,
    stages: ['fragment'],
    resources: [{
      id: resourceId,
      space: 'pass',
      kind: 'texture',
      visibility: ['fragment'],
      valueType: 'texture_2d<f32>',
      fixedBinding,
    }],
    source: () => `const ${moduleId.replaceAll('.', '_')}Marker : f32 = 1.0;`,
  });
}

function dependencyEntry(id, dependencies) {
  return defineShaderModule({
    id,
    stages: ['fragment'],
    dependencies,
    entryPoints: [fragmentEntryPoint],
    source: context => `@fragment fn ${context.entryPoint('fragmentMain')}() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,
  });
}

function assertComposerError(callback, code) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ShaderComposerError);
    assert.equal(error.diagnostic.code, code);
    return true;
  });
}

function rawModule(id) {
  return {
    id,
    version: 1,
    sourceName: `${id}.wgsl`,
    stages: ['fragment'],
    dependencies: [],
    symbols: [],
    imports: [],
    resources: [],
    specializations: [],
    requires: [],
    provides: [],
    conflicts: [],
    targets: ['webgpu-wgsl'],
    profiles: ['webgpu-portable'],
    passRequirements: [],
    entryPoints: [fragmentEntryPoint],
    source: context => `@fragment fn ${context.entryPoint('fragmentMain')}() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,
  };
}
