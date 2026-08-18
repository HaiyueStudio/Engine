import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPrecompiledShaderArtifactV2,
  ShaderComposerError,
} from '../dist/index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

test('artifact v2 carries complete single-pass postprocess layout reflection', () => {
  const artifact = createPrecompiledShaderArtifactV2(definition([postprocessPass()]));
  const pass = artifact.passes.grayscale;
  assert.equal(artifact.version, 2);
  assert.match(artifact.artifactHash, /^[a-f0-9]{64}$/);
  assert.match(pass.canonicalHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(pass.bindGroups[0], {
    logicalSpace: 'pass',
    logicalGroup: 3,
    physicalGroup: 0,
    owner: 'artifact',
    bindings: [
      {
        id: 'pass.sourceColor',
        binding: 0,
        visibility: ['fragment'],
        layout: { kind: 'texture', sampleType: 'float', viewDimension: '2d', multisampled: false },
      },
      {
        id: 'pass.linearSampler',
        binding: 1,
        visibility: ['fragment'],
        layout: { kind: 'sampler', samplerType: 'filtering' },
      },
    ],
  });
  assert.deepEqual(pass.entryPoints, { vertex: 'vs_main', fragment: 'fs_main' });
  assert.deepEqual(pass.renderTargets, [{ location: 0, formatClass: 'color' }]);
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(Object.isFrozen(pass.bindGroups[0].bindings), true);
});

test('artifact v2 supports multiple physical groups with explicit renderer ownership', () => {
  const artifact = createPrecompiledShaderArtifactV2(definition([multiGroupPass()]));
  const pass = artifact.passes['multi-group-fixture'];
  assert.deepEqual(pass.bindGroups.map(group => [
    group.logicalSpace,
    group.logicalGroup,
    group.physicalGroup,
    group.owner,
  ]), [
    ['frame', 0, 0, 'renderer'],
    ['material', 2, 1, 'artifact'],
  ]);
  assert.equal(pass.vertexBuffers[0].attributes[0].semantic, 'POSITION');
  assert.equal(pass.uniformBlocks[0].byteSize, 16);
});

test('artifact v2 hash is deterministic and sensitive to reflected layout ownership', () => {
  const first = createPrecompiledShaderArtifactV2(definition([multiGroupPass()]));
  const second = createPrecompiledShaderArtifactV2(definition([multiGroupPass()]));
  const changedPass = multiGroupPass();
  changedPass.bindGroups[1] = { ...changedPass.bindGroups[1], owner: 'renderer' };
  const changed = createPrecompiledShaderArtifactV2(definition([changedPass]));
  assert.equal(first.artifactHash, second.artifactHash);
  assert.equal(first.passes['multi-group-fixture'].canonicalHash, second.passes['multi-group-fixture'].canonicalHash);
  assert.notEqual(first.artifactHash, changed.artifactHash);
});

test('artifact v2 rejects gaps, logical-space drift, incomplete stages, and invalid provenance', () => {
  const cases = [
    {
      mutate(pass) { pass.bindGroups[1].physicalGroup = 2; },
      path: 'passes.multi-group-fixture.bindGroups',
    },
    {
      mutate(pass) { pass.bindGroups.reverse(); },
      path: 'passes.multi-group-fixture.bindGroups',
    },
    {
      mutate(pass) { pass.bindGroups[1].logicalGroup = 1; },
      path: 'passes.multi-group-fixture.bindGroups.1.logicalGroup',
    },
    {
      mutate(pass) { delete pass.entryPoints.fragment; },
      path: 'passes.multi-group-fixture.entryPoints',
    },
  ];
  for (const entry of cases) {
    const pass = multiGroupPass();
    entry.mutate(pass);
    assert.throws(
      () => createPrecompiledShaderArtifactV2(definition([pass])),
      error => error instanceof ShaderComposerError && error.diagnostic.path === entry.path,
    );
  }
  assert.throws(
    () => createPrecompiledShaderArtifactV2({ ...definition([postprocessPass()]), canonicalHash: 'stale' }),
    error => error instanceof ShaderComposerError && error.diagnostic.path === 'canonicalHash',
  );
});

function definition(passes) {
  return {
    compilerVersion: 'shader-language-stage7',
    source: { kind: 'typed-ir', path: 'shader-language/test/stage7-fixture', sha256: HASH_A },
    canonicalHash: HASH_B,
    typedModuleHash: HASH_C,
    passes,
  };
}

function postprocessPass() {
  return {
    id: 'grayscale',
    code: '@group(0) @binding(0) var sourceColor : texture_2d<f32>;\n@group(0) @binding(1) var linearSampler : sampler;\n@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(); }\n@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(); }',
    entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
    bindGroups: [{
      logicalSpace: 'pass',
      logicalGroup: 3,
      physicalGroup: 0,
      owner: 'artifact',
      bindings: [
        {
          id: 'pass.sourceColor', binding: 0, visibility: ['fragment'],
          layout: { kind: 'texture', sampleType: 'float', viewDimension: '2d', multisampled: false },
        },
        {
          id: 'pass.linearSampler', binding: 1, visibility: ['fragment'],
          layout: { kind: 'sampler', samplerType: 'filtering' },
        },
      ],
    }],
    uniformBlocks: [],
    vertexBuffers: [],
    varyings: [{ semantic: 'SCREEN_UV', location: 0, type: 'vec2<f32>', interpolation: 'perspective' }],
    renderTargets: [{ location: 0, formatClass: 'color' }],
    capabilities: [],
    passRequirements: ['scene-color'],
    sourceMap: [{ sourceId: 'fixture', sourceName: 'stage7-fixture', generatedStartLine: 1, generatedEndLine: 2 }],
  };
}

function multiGroupPass() {
  return {
    id: 'multi-group-fixture',
    code: 'struct View { value: vec4<f32>, }\nstruct Tint { color: vec4<f32>, }\n@group(0) @binding(0) var<uniform> view : View;\n@group(1) @binding(0) var<uniform> tint : Tint;\n@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(); }\n@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(); }',
    entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
    bindGroups: [
      {
        logicalSpace: 'frame', logicalGroup: 0, physicalGroup: 0, owner: 'renderer',
        bindings: [{
          id: 'frame.view', binding: 0, visibility: ['vertex', 'fragment'],
          layout: { kind: 'buffer', bufferType: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
        }],
      },
      {
        logicalSpace: 'material', logicalGroup: 2, physicalGroup: 1, owner: 'artifact',
        bindings: [{
          id: 'material.tint', binding: 0, visibility: ['fragment'],
          layout: { kind: 'buffer', bufferType: 'uniform', hasDynamicOffset: false, minBindingSize: 16 },
        }],
      },
    ],
    uniformBlocks: [{
      id: 'material.tint', alignment: 16, byteSize: 16,
      fields: [{ name: 'color', type: 'vec4<f32>', offset: 0, size: 16 }],
    }],
    vertexBuffers: [{
      arrayStride: 12,
      stepMode: 'vertex',
      attributes: [{ semantic: 'POSITION', shaderLocation: 0, offset: 0, format: 'float32x3' }],
    }],
    varyings: [],
    renderTargets: [{ location: 0, formatClass: 'color' }],
    capabilities: [],
    passRequirements: [],
    sourceMap: [],
  };
}
