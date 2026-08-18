import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ShaderComposerError,
  compileShaderIrProgramToGlslEs300,
  composeShaderModules,
  defineTypedShaderModule,
  mapGlslEs300SourceLocation,
} from '../dist/index.js';

const positionClip = Object.freeze({ dataType: 'vec4<f32>', semantic: 'position', coordinateSpace: 'clip' });
const uvScreen = Object.freeze({ dataType: 'vec2<f32>', semantic: 'uv', coordinateSpace: 'screen' });
const colorLinear = Object.freeze({ dataType: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' });

test('one canonical Typed IR deterministically emits complete WGSL and GLSL ES 3.00 programs', () => {
  const typed = dualBackendFixture();
  const wgsl = composeShaderModules({ label: 'stage14-wgsl', entry: typed.module });
  const first = compileShaderIrProgramToGlslEs300(typed.ir);
  const second = compileShaderIrProgramToGlslEs300(typed.ir);

  assert.deepEqual(withoutPhaseTimings(first), withoutPhaseTimings(second));
  assert.equal(first.canonicalHash, typed.ir.canonicalHash);
  assert.match(first.backendHash, /^[a-f0-9]{64}$/);
  assert.match(wgsl.code, new RegExp(typed.ir.canonicalHash));
  assert.equal(first.target, 'webgl2-glsl-es300');
  assert.equal(first.profile, 'webgl2-compatible');
  assert.deepEqual(first.entries.map(entry => [entry.stage, entry.originalEntryPoint]), [
    ['fragment', 'fragmentMain'],
    ['vertex', 'vertexMain'],
  ]);

  const vertex = first.entries.find(entry => entry.stage === 'vertex');
  const fragment = first.entries.find(entry => entry.stage === 'fragment');
  assert.match(vertex.code, /^#version 300 es/m);
  assert.match(vertex.code, /layout\(location=0\) in vec4 hy_in_position;/);
  assert.match(vertex.code, /gl_Position = hy_in_position;/);
  assert.match(fragment.code, /layout\(std140\) uniform hy_block_material_params/);
  assert.match(fragment.code, /uniform sampler2D hy_sample_material_sourceTexture_material_sourceSampler;/);
  assert.match(fragment.code, /texture\(/);
  assert.match(fragment.code, /greaterThan\(/);
  assert.match(fragment.code, /layout\(location=0\) out vec4 hy_out_fragmentMain;/);

  assert.deepEqual(first.uniformBlocks.map(block => ({
    resourceId: block.resourceId,
    binding: block.binding,
    byteSize: block.layout.byteSize,
    fields: block.layout.fields.map(field => [field.name, field.offset]),
  })), [{ resourceId: 'material.params', binding: 0, byteSize: 16, fields: [['tint', 0]] }]);
  assert.deepEqual(first.sampledTextures.map(sample => ({
    texture: sample.textureResourceId,
    sampler: sample.samplerResourceId,
    unit: sample.textureUnit,
  })), [{ texture: 'material.sourceTexture', sampler: 'material.sourceSampler', unit: 0 }]);

  const sampleLine = fragment.code.split('\n').findIndex(line => line.includes(' = texture(')) + 1;
  assert.deepEqual(mapGlslEs300SourceLocation(fragment, sampleLine), {
    sourceId: 'stage14.sample',
    sourceName: 'stage14-dual-backend.fixture',
    line: 23,
    column: 1,
    generatedLine: sampleLine,
  });
});

test('std140 reflection owns matrix stride independently from WGSL host layout', () => {
  const typed = defineTypedShaderModule({
    id: 'stage14.std140-matrix',
    resources: [{
      id: 'material.params', space: 'material', kind: 'uniform-buffer', visibility: ['fragment'],
      fields: [{ id: 'basis', type: 'mat2x2<f32>' }, { id: 'factor', type: 'f32' }],
    }],
    entries: [{
      id: 'fragmentMain', stage: 'fragment', name: 'fragmentMain',
      output: { type: 'f32', location: 0 },
      build: builder => builder.uniformField('material.params', 'factor'),
    }],
  });
  const result = compileShaderIrProgramToGlslEs300(typed.ir);
  assert.deepEqual(result.uniformBlocks[0].layout, {
    id: 'material.params', alignment: 16, byteSize: 48,
    fields: [
      { name: 'basis', type: 'mat2x2<f32>', offset: 0, size: 32, matrixStride: 16 },
      { name: 'factor', type: 'f32', offset: 32, size: 4 },
    ],
  });
});

test('unsupported WebGL2 features and limits fail precisely instead of silently lowering', () => {
  const compute = defineTypedShaderModule({
    id: 'stage14.compute-rejection',
    entries: [{ id: 'computeMain', stage: 'compute', name: 'computeMain', build: () => null }],
  });
  assertDiagnostic(() => compileShaderIrProgramToGlslEs300(compute.ir), 'E_SHADER_TARGET_UNSUPPORTED', /compute/);

  const storage = defineTypedShaderModule({
    id: 'stage14.storage-rejection',
    resources: [{
      id: 'pass.values', space: 'pass', kind: 'storage-buffer-read', visibility: ['fragment'], valueType: 'array<u32>',
    }],
    entries: [{
      id: 'fragmentMain', stage: 'fragment', name: 'fragmentMain', output: { type: 'f32', location: 0 },
      build: builder => builder.literal('f32', 1),
    }],
  });
  assertDiagnostic(() => compileShaderIrProgramToGlslEs300(storage.ir), 'E_SHADER_TARGET_UNSUPPORTED', /storage-buffer-read/);

  const typed = dualBackendFixture();
  assertDiagnostic(
    () => compileShaderIrProgramToGlslEs300(typed.ir, { maxCombinedTextureUnits: 0 }),
    'E_SHADER_TARGET_UNSUPPORTED',
    /positive integer/,
  );
  assertDiagnostic(
    () => composeShaderModules({ label: 'stage14-no-fake-composer', entry: typed.module, target: 'webgl2-glsl-es300' }),
    'E_SHADER_TARGET_UNSUPPORTED',
    /target|webgl/i,
  );

  const varying = defineTypedShaderModule({
    id: 'stage14.varying-rejection',
    entries: [{
      id: 'fragmentMain', stage: 'fragment', name: 'fragmentMain',
      inputs: [{ id: 'uv', type: uvScreen, location: 0 }],
      output: { type: colorLinear, location: 0 },
      build: builder => builder.construct(colorLinear, [
        builder.swizzle(builder.literal(uvScreen, [0.5, 0.5]), 'x'),
        builder.swizzle(builder.literal(uvScreen, [0.5, 0.5]), 'y'),
        builder.literal('f32', 0), builder.literal('f32', 1),
      ]),
    }],
  });
  assertDiagnostic(() => compileShaderIrProgramToGlslEs300(varying.ir), 'E_SHADER_TARGET_UNSUPPORTED', /varying linking/);
});

test('stage 14 contract preserves the WebGPU-only renderer boundary', async () => {
  const contract = JSON.parse(await readFile(new URL('../stage14-contract.json', import.meta.url), 'utf8'));
  assert.equal(contract.phase, 14);
  assert.equal(contract.status, 'implemented');
  assert.equal(contract.implementation, 'typed-ir-glsl-es300-codegen-feasibility');
  assert.equal(contract.productRendererContract, 'webgpu-only-unchanged');
  assert.deepEqual(contract.productionMigrations, []);
  assert.deepEqual(contract.publicApiChanges, []);
  assert.equal(contract.apiBaselineUpdated, false);
  assert.ok(contract.deferred.includes('webgl2-renderer-fallback'));
});

function dualBackendFixture() {
  return defineTypedShaderModule({
    id: 'fixture.stage14-dual-backend',
    resources: [
      {
        id: 'material.params', space: 'material', kind: 'uniform-buffer', visibility: ['fragment'],
        fields: [{ id: 'tint', type: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' }],
      },
      {
        id: 'material.sourceTexture', space: 'material', kind: 'texture', visibility: ['fragment'],
        valueType: 'texture_2d<f32>', colorSpace: 'srgb',
      },
      {
        id: 'material.sourceSampler', space: 'material', kind: 'sampler', visibility: ['fragment'], valueType: 'sampler',
      },
    ],
    entries: [
      {
        id: 'vertexMain', stage: 'vertex', name: 'vertexMain',
        inputs: [{ id: 'position', type: positionClip, location: 0 }],
        output: { type: positionClip, builtin: 'position' },
        build: (_builder, inputs) => inputs.position,
      },
      {
        id: 'fragmentMain', stage: 'fragment', name: 'fragmentMain',
        output: { type: colorLinear, location: 0 },
        build: builder => {
          const uv = builder.literal(uvScreen, [0.5, 0.5]);
          const sampled = builder.textureSample('material.sourceTexture', 'material.sourceSampler', uv, {
            source: { sourceId: 'stage14.sample', sourceName: 'stage14-dual-backend.fixture', line: 23 },
          });
          const linear = builder.srgbToLinear(sampled);
          return builder.multiply(linear, builder.uniformField('material.params', 'tint', {
            sourceId: 'stage14.tint', sourceName: 'stage14-dual-backend.fixture', line: 27,
          }));
        },
      },
    ],
  });
}

function assertDiagnostic(action, code, message) {
  assert.throws(action, error => {
    assert.ok(error instanceof ShaderComposerError);
    assert.equal(error.diagnostic.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function withoutPhaseTimings(compilation) {
  return { ...compilation, cost: { ...compilation.cost, phaseMs: undefined } };
}
