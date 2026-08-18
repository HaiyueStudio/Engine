import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPrecompiledShaderPassRuntime,
  PrecompiledUniformBlockWriter,
} from '../dist/internal/precompiled-shader-runtime.js';

test('artifact v2 composes artifact and renderer-owned layouts without cache aliasing', () => {
  ensureGpuGlobals();
  const log = [];
  const device = createDevice(log);
  const artifact = fixtureArtifact();
  const firstFrameLayout = { label: 'frame-a' };
  const secondFrameLayout = { label: 'frame-b' };

  const first = getPrecompiledShaderPassRuntime(device, artifact, 'multi', {
    rendererOwnedLayouts: { 0: firstFrameLayout },
  });
  const repeated = getPrecompiledShaderPassRuntime(device, artifact, 'multi', {
    rendererOwnedLayouts: { 0: firstFrameLayout },
  });
  const changedOwner = getPrecompiledShaderPassRuntime(device, artifact, 'multi', {
    rendererOwnedLayouts: { 0: secondFrameLayout },
  });

  assert.equal(first, repeated);
  assert.notEqual(first, changedOwner);
  assert.equal(first.module, changedOwner.module, 'external layout identity must not duplicate immutable modules');
  assert.equal(first.bindGroupLayouts[0], firstFrameLayout);
  assert.equal(first.bindGroupLayouts[1], changedOwner.bindGroupLayouts[1], 'artifact-owned layouts remain shared');
  assert.equal(log.filter(entry => entry[0] === 'createShaderModule').length, 1);
  assert.equal(log.filter(entry => entry[0] === 'createBindGroupLayout').length, 1);
  assert.equal(log.filter(entry => entry[0] === 'createPipelineLayout').length, 2);
  assert.deepEqual(log.find(entry => entry[0] === 'createBindGroupLayout')[1].entries[0].buffer, {
    type: 'uniform', hasDynamicOffset: false, minBindingSize: 32,
  });
});

test('artifact v2 rejects missing renderer layouts before creating GPU resources', () => {
  ensureGpuGlobals();
  const log = [];
  const device = createDevice(log);
  assert.throws(
    () => getPrecompiledShaderPassRuntime(device, fixtureArtifact(), 'multi'),
    /requires renderer-owned bind group layout 0/,
  );
  assert.equal(log.length, 0);
});

test('artifact v2 rejects logical-space drift and duplicate bindings before GPU allocation', () => {
  ensureGpuGlobals();
  for (const mutate of [
    artifact => { artifact.passes.multi.bindGroups[1].logicalGroup = 1; },
    artifact => { artifact.passes.multi.bindGroups[1].bindings.push({ ...artifact.passes.multi.bindGroups[1].bindings[0] }); },
  ]) {
    const log = [];
    const artifact = fixtureArtifact();
    mutate(artifact);
    assert.throws(
      () => getPrecompiledShaderPassRuntime(createDevice(log), artifact, 'multi', {
        rendererOwnedLayouts: { 0: { label: 'frame' } },
      }),
      /invalid logical group|invalid binding/,
    );
    assert.equal(log.length, 0);
  }
});

test('artifact v2 materializes a standalone single-group postprocess layout', () => {
  ensureGpuGlobals();
  const log = [];
  const runtime = getPrecompiledShaderPassRuntime(createDevice(log), singleGroupArtifact(), 'postprocess');
  assert.equal(runtime.bindGroupLayouts.length, 1);
  assert.deepEqual(log.find(entry => entry[0] === 'createBindGroupLayout')[1].entries, [
    {
      binding: 0, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
    },
    {
      binding: 1, visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: 'filtering' },
    },
  ]);
});

test('artifact v2 preserves storage and external texture descriptors', () => {
  ensureGpuGlobals();
  const log = [];
  const artifact = singleGroupArtifact();
  artifact.passes.postprocess.bindGroups[0].bindings = [
    {
      id: 'pass.output', binding: 0, visibility: ['fragment'],
      layout: { kind: 'storage-texture', access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
    },
    {
      id: 'pass.video', binding: 1, visibility: ['fragment'],
      layout: { kind: 'external-texture' },
    },
  ];
  getPrecompiledShaderPassRuntime(createDevice(log), artifact, 'postprocess');
  assert.deepEqual(log.find(entry => entry[0] === 'createBindGroupLayout')[1].entries, [
    {
      binding: 0, visibility: GPUShaderStage.FRAGMENT,
      storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
    },
    {
      binding: 1, visibility: GPUShaderStage.FRAGMENT,
      externalTexture: {},
    },
  ]);
});

test('artifact v2 uniform writer consumes reflected offsets without a second ABI', () => {
  const artifact = fixtureArtifact();
  const writer = new PrecompiledUniformBlockWriter(artifact.passes.multi, 'material.tint');
  writer.setF32('color', 0, 0.25);
  writer.setF32('color', 3, 1);
  writer.setI32('sampleCount', 0, -4);
  writer.setU32('flags', 0, 7);
  const view = new DataView(writer.buffer);
  assert.equal(writer.byteLength, 32);
  assert.equal(view.getFloat32(0, true), 0.25);
  assert.equal(view.getFloat32(12, true), 1);
  assert.equal(view.getInt32(16, true), -4);
  assert.equal(view.getUint32(20, true), 7);
});

test('production runtime rejects legacy artifact v1 before GPU allocation', () => {
  ensureGpuGlobals();
  const log = [];
  assert.throws(
    () => getPrecompiledShaderPassRuntime(createDevice(log), fixtureArtifactV1(), 'legacy'),
    /requires Artifact V2/,
  );
  assert.equal(log.length, 0);
});

function fixtureArtifact() {
  return {
    format: 'haiyue-precompiled-shader-artifact',
    version: 2,
    compilerVersion: 'shader-language-stage7',
    source: { kind: 'typed-ir', path: 'fixture', sha256: 'a'.repeat(64) },
    canonicalHash: 'b'.repeat(64),
    typedModuleHash: 'c'.repeat(64),
    artifactHash: 'd'.repeat(64),
    passes: {
      multi: {
        id: 'multi',
        code: 'stage7 fixture',
        canonicalHash: 'e'.repeat(64),
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
              layout: { kind: 'buffer', bufferType: 'uniform', hasDynamicOffset: false, minBindingSize: 32 },
            }],
          },
        ],
        uniformBlocks: [{
          id: 'material.tint', alignment: 16, byteSize: 32,
          fields: [
            { name: 'color', type: 'vec4<f32>', offset: 0, size: 16 },
            { name: 'sampleCount', type: 'i32', offset: 16, size: 4 },
            { name: 'flags', type: 'u32', offset: 20, size: 4 },
          ],
        }],
        vertexBuffers: [], varyings: [], renderTargets: [{ location: 0, formatClass: 'color' }],
        capabilities: [], passRequirements: [], sourceMap: [],
      },
    },
  };
}

function fixtureArtifactV1() {
  return {
    format: 'haiyue-precompiled-shader-artifact', version: 1, compilerVersion: 'shader-language-stage6',
    sourceGraph: { path: 'fixture', sha256: 'a'.repeat(64) },
    graphCanonicalHash: 'b'.repeat(64), typedModuleHash: 'c'.repeat(64),
    logicalResourceGroup: 3, physicalResourceGroup: 0, artifactHash: 'd'.repeat(64),
    passes: {
      legacy: {
        id: 'legacy', code: 'legacy fixture', canonicalHash: 'e'.repeat(64),
        vertexEntryPoint: 'vs_main', fragmentEntryPoint: 'fs_main', targetFormatClass: 'color',
        bindings: [{
          id: 'pass.source', binding: 0, visibility: ['fragment'],
          layout: { kind: 'texture', sampleType: 'float', viewDimension: '2d', multisampled: false },
        }],
        uniformBlocks: [],
      },
    },
  };
}

function singleGroupArtifact() {
  return {
    format: 'haiyue-precompiled-shader-artifact',
    version: 2,
    compilerVersion: 'shader-language-stage7',
    source: { kind: 'typed-ir', path: 'postprocess-fixture', sha256: '1'.repeat(64) },
    canonicalHash: '2'.repeat(64),
    typedModuleHash: '3'.repeat(64),
    artifactHash: '4'.repeat(64),
    passes: {
      postprocess: {
        id: 'postprocess',
        code: 'single group postprocess fixture',
        canonicalHash: '5'.repeat(64),
        entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
        bindGroups: [{
          logicalSpace: 'pass', logicalGroup: 3, physicalGroup: 0, owner: 'artifact',
          bindings: [
            {
              id: 'pass.source', binding: 0, visibility: ['fragment'],
              layout: { kind: 'texture', sampleType: 'float', viewDimension: '2d', multisampled: false },
            },
            {
              id: 'pass.sampler', binding: 1, visibility: ['fragment'],
              layout: { kind: 'sampler', samplerType: 'filtering' },
            },
          ],
        }],
        uniformBlocks: [], vertexBuffers: [], varyings: [],
        renderTargets: [{ location: 0, formatClass: 'color' }],
        capabilities: [], passRequirements: [], sourceMap: [],
      },
    },
  };
}

function ensureGpuGlobals() {
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
}

function createDevice(log) {
  return {
    createShaderModule(descriptor) { log.push(['createShaderModule', descriptor]); return { descriptor }; },
    createBindGroupLayout(descriptor) { log.push(['createBindGroupLayout', descriptor]); return { descriptor }; },
    createPipelineLayout(descriptor) { log.push(['createPipelineLayout', descriptor]); return { descriptor }; },
  };
}
