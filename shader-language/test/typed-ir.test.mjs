import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ShaderComposerError,
  compileShaderIrProgramToWgsl,
  composeShaderModules,
  defineTypedShaderModule,
  mapShaderSourceLocation,
  validateShaderIrProgram,
} from '../dist/index.js';

const positionGeometry = Object.freeze({ dataType: 'vec3<f32>', semantic: 'position', coordinateSpace: 'geometry-local' });
const positionClip = Object.freeze({ dataType: 'vec4<f32>', semantic: 'position', coordinateSpace: 'clip' });
const uvGeometry = Object.freeze({ dataType: 'vec2<f32>', semantic: 'uv', coordinateSpace: 'geometry-local' });
const color3Linear = Object.freeze({ dataType: 'vec3<f32>', semantic: 'color', colorSpace: 'linear' });
const color4Linear = Object.freeze({ dataType: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' });

test('Typed IR generates deterministic vertex WGSL through symbolic Composer resources', () => {
  const typed = typedVertexModule(false);
  const composition = composeShaderModules({ label: 'typed-vertex', entry: typed.module });

  assert.equal(typed.ir.format, 'haiyue-typed-shader-ir');
  assert.match(typed.ir.canonicalHash, /^[a-f0-9]{64}$/);
  assert.match(composition.code, new RegExp(`// haiyue:typed-ir ${typed.ir.canonicalHash}`));
  assert.match(composition.code, /@group\(1\) @binding\(0\) var<uniform>/);
  assert.match(composition.code, /@vertex fn vertexMain\(@location\(0\) hy_in_position : vec3<f32>\)/);
  assert.match(composition.code, /\* vec4<f32>\(hy_in_position, 1\.0\)\)/);
  assert.doesNotMatch(composition.code, /@group\([^)]*\).*@group\(/);
  assert.deepEqual(composition.reflection.entryPoints, [{ stage: 'vertex', name: 'vertexMain' }]);
  assert.deepEqual(composition.reflection.resources.map(({ id, group, binding }) => ({ id, group, binding })), [
    { id: 'object.transforms', group: 1, binding: 0 },
  ]);
});

test('canonical IR and WGSL ignore unreachable authoring nodes and source metadata', () => {
  const clean = typedVertexModule(false, { sourceId: 'graph.clean', sourceName: 'clean.graph.json', line: 2 });
  const withDeadNode = typedVertexModule(true, { sourceId: 'graph.changed', sourceName: 'changed.graph.json', line: 200 });
  assert.equal(clean.ir.canonicalHash, withDeadNode.ir.canonicalHash);

  const left = composeShaderModules({ label: 'typed-dce', entry: clean.module });
  const right = composeShaderModules({ label: 'typed-dce', entry: withDeadNode.module });
  assert.equal(left.code, right.code);
  assert.equal(left.irHash, right.irHash);
  assert.doesNotMatch(left.code, /99\.0/);
});

test('type, semantic and coordinate-space mismatches fail before WGSL codegen', () => {
  assertDiagnostic(() => defineFragmentFailure('typed.type-failure', (builder, inputs) =>
    builder.add(inputs.scalar, inputs.vector)), 'E_SHADER_TYPE_MISMATCH');

  assertDiagnostic(() => defineFragmentFailure('typed.space-failure', (builder, inputs) =>
    builder.add(inputs.worldPosition, inputs.objectPosition)), 'E_SHADER_SPACE_MISMATCH');

  assertDiagnostic(() => defineFragmentFailure('typed.semantic-failure', (builder, inputs) =>
    builder.add(inputs.worldNormal, inputs.worldDirection)), 'E_SHADER_SEMANTIC_MISMATCH');

  assertDiagnostic(() => defineTypedShaderModule({
    id: 'typed.output-space-failure',
    entries: [{
      id: 'vertexMain',
      stage: 'vertex',
      name: 'vertexMain',
      inputs: [{ id: 'position', type: positionGeometry, location: 0 }],
      output: { type: positionClip, builtin: 'position' },
      build: (_builder, inputs) => inputs.position,
    }],
  }), 'E_SHADER_TYPE_MISMATCH');
});

test('position/direction algebra and transform from/to spaces are enforced', () => {
  assertDiagnostic(() => defineFragmentFailure('typed.position-addition', (builder, inputs) =>
    builder.add(inputs.worldPosition, inputs.worldPosition)), 'E_SHADER_SEMANTIC_MISMATCH');

  const displacement = defineTypedShaderModule({
    id: 'typed.position-direction',
    entries: [{
      id: 'fragmentMain',
      stage: 'fragment',
      name: 'fragmentMain',
      inputs: [
        { id: 'left', type: { dataType: 'vec3<f32>', semantic: 'position', coordinateSpace: 'world' }, location: 0 },
        { id: 'right', type: { dataType: 'vec3<f32>', semantic: 'position', coordinateSpace: 'world' }, location: 1 },
      ],
      output: { type: { dataType: 'vec3<f32>', semantic: 'direction', coordinateSpace: 'world' }, location: 0 },
      build: (builder, inputs) => builder.subtract(inputs.left, inputs.right),
    }],
  });
  assert.match(composeShaderModules({ label: 'position-direction', entry: displacement.module }).code, /hy_in_left - hy_in_right/);

  assertDiagnostic(() => defineTypedShaderModule({
    id: 'typed.transform-space',
    resources: [{
      id: 'object.transforms',
      space: 'object',
      kind: 'uniform-buffer',
      visibility: ['vertex'],
      fields: [{
        id: 'wrongMatrix',
        type: 'mat4x4<f32>',
        semantic: 'transform',
        fromSpace: 'object',
        toSpace: 'world',
      }],
    }],
    entries: [{
      id: 'vertexMain',
      stage: 'vertex',
      name: 'vertexMain',
      inputs: [{ id: 'position', type: positionGeometry, location: 0 }],
      output: { type: positionClip, builtin: 'position' },
      build: (builder, inputs) => builder.transformPosition(
        builder.uniformField('object.transforms', 'wrongMatrix'),
        inputs.position,
        'clip',
      ),
    }],
  }), 'E_SHADER_SPACE_MISMATCH');
});

test('stage rules reject derivatives and implicit-LOD sampling in vertex, while explicit LOD remains legal', () => {
  assertDiagnostic(() => defineTypedShaderModule({
    id: 'typed.vertex-derivative',
    entries: [{
      id: 'vertexMain',
      stage: 'vertex',
      name: 'vertexMain',
      inputs: [{ id: 'position', type: positionClip, location: 0 }],
      output: { type: positionClip, builtin: 'position' },
      build: (builder, inputs) => {
        builder.derivativeX(builder.literal('f32', 1));
        return inputs.position;
      },
    }],
  }), 'E_SHADER_STAGE_VIOLATION');

  const resources = textureResources(['vertex']);
  assertDiagnostic(() => defineTypedShaderModule({
    id: 'typed.vertex-implicit-sample',
    resources,
    entries: [{
      id: 'vertexMain',
      stage: 'vertex',
      name: 'vertexMain',
      inputs: [
        { id: 'position', type: positionClip, location: 0 },
        { id: 'uv', type: uvGeometry, location: 1 },
      ],
      output: { type: positionClip, builtin: 'position' },
      build: (builder, inputs) => {
        builder.textureSample('material.albedoTexture', 'material.surfaceSampler', inputs.uv);
        return inputs.position;
      },
    }],
  }), 'E_SHADER_STAGE_VIOLATION');

  const explicit = defineTypedShaderModule({
    id: 'typed.vertex-explicit-sample',
    resources,
    entries: [{
      id: 'vertexMain',
      stage: 'vertex',
      name: 'vertexMain',
      inputs: [
        { id: 'position', type: positionClip, location: 0 },
        { id: 'uv', type: uvGeometry, location: 1 },
      ],
      output: { type: positionClip, builtin: 'position' },
      build: (builder, inputs) => {
        builder.textureSample('material.albedoTexture', 'material.surfaceSampler', inputs.uv, {
          level: builder.literal('f32', 0),
        });
        return inputs.position;
      },
    }],
  });
  assert.ok(explicit.ir.entries[0].nodes.some(node => node.operation === 'texture-sample-level'));
});

test('numeric casts and semantic/color conversions must be explicit', () => {
  assertDiagnostic(() => defineFragmentFailure('typed.numeric-cast', (builder, inputs) =>
    builder.add(inputs.scalar, inputs.integer)), 'E_SHADER_TYPE_MISMATCH');

  const cast = fragmentScalarModule('typed.explicit-cast', (builder, inputs) =>
    builder.add(inputs.scalar, builder.cast(inputs.integer, 'f32')));
  assert.match(composeShaderModules({ label: 'explicit-cast', entry: cast.module }).code, /f32\(hy_in_integer\)/);

  assertDiagnostic(() => fragmentTextureModule('typed.srgb-mismatch', (builder, sample) =>
    builder.multiply(sample, builder.literal(color4Linear, [1, 1, 1, 1]))), 'E_SHADER_SEMANTIC_MISMATCH');

  const decoded = fragmentTextureModule('typed.srgb-decode', (builder, sample) =>
    builder.multiply(builder.srgbToLinear(sample), builder.literal(color4Linear, [1, 1, 1, 1])));
  const code = composeShaderModules({ label: 'srgb-decode', entry: decoded.module }).code;
  assert.match(code, /select\(/);
  assert.match(code, /pow\(/);
});

test('PBR composition foundation expresses texture, UV distortion, height gradient and factors as typed nodes', () => {
  const typed = pbrCompositionFoundation();
  validateShaderIrProgram(typed.ir);
  const composition = composeShaderModules({
    label: 'pbr-composition-stage2',
    entry: typed.module,
    vertexSemantics: ['TEXCOORD_0', 'POSITION_WORLD'],
  });

  assert.match(composition.code, /textureSample\(/);
  assert.match(composition.code, /sin\(/);
  assert.match(composition.code, /mix\(/);
  assert.match(composition.code, /pow\(/);
  assert.doesNotMatch(composition.code, /\.replace\(|@group\(2\).*@group\(2\)/);
  assert.deepEqual(composition.reflection.resources.map(resource => resource.id), [
    'material.params',
    'material.albedoTexture',
    'material.surfaceSampler',
  ]);
  assert.deepEqual(composition.reflection.vertexSemantics, ['POSITION_WORLD', 'TEXCOORD_0']);

  const graphSpan = composition.sourceMap.find(span => span.sourceId === 'graph.composedBaseColor');
  assert.ok(graphSpan);
  assert.deepEqual(mapShaderSourceLocation(composition, graphSpan.generatedStartLine, 1), {
    sourceId: 'graph.composedBaseColor',
    sourceName: 'pilot-pbr-composition.graph.json',
    line: 55,
    column: 7,
    generatedLine: graphSpan.generatedStartLine,
  });
});

test('standalone WGSL backend output is deterministic and contains no resource binding declarations', () => {
  const typed = pbrCompositionFoundation();
  const resolver = {
    resource: id => `resolved_${id.replaceAll('.', '_')}`,
    uniformField: (resourceId, fieldId) => `resolved_${resourceId.replaceAll('.', '_')}.${fieldId}`,
  };
  const first = compileShaderIrProgramToWgsl(typed.ir, resolver);
  const second = compileShaderIrProgramToWgsl(typed.ir, resolver);
  assert.deepEqual(withoutPhaseTimings(first), withoutPhaseTimings(second));
  assert.equal(first.canonicalHash, typed.ir.canonicalHash);
  assert.doesNotMatch(first.code, /@group|@binding/);
  assert.deepEqual(first.entryPoints, [{ stage: 'fragment', name: 'fragmentMain' }]);
});

function withoutPhaseTimings(compilation) {
  return { ...compilation, cost: { ...compilation.cost, phaseMs: undefined } };
}

test('empty compute entry codegen stays stage-valid while side effects remain deferred', () => {
  const typed = defineTypedShaderModule({
    id: 'typed.compute-empty',
    entries: [{
      id: 'computeMain',
      stage: 'compute',
      name: 'computeMain',
      inputs: [{ id: 'dispatchId', type: 'vec3<u32>', builtin: 'global_invocation_id' }],
      build: () => null,
    }],
  });
  const composition = composeShaderModules({ label: 'compute-empty', entry: typed.module });
  assert.match(composition.code, /@compute @workgroup_size\(1\) fn computeMain\(@builtin\(global_invocation_id\) hy_in_dispatchId : vec3<u32>\)/);
});

test('IR values cannot cross entry builders and a forged canonical hash is rejected', () => {
  let foreignValue;
  assertDiagnostic(() => defineTypedShaderModule({
    id: 'typed.owner-boundary',
    entries: [
      {
        id: 'first',
        stage: 'fragment',
        name: 'first',
        output: { type: 'f32', location: 0 },
        build: builder => {
          foreignValue = builder.literal('f32', 1);
          return foreignValue;
        },
      },
      {
        id: 'second',
        stage: 'fragment',
        name: 'second',
        output: { type: 'f32', location: 0 },
        build: builder => builder.add(foreignValue, builder.literal('f32', 1)),
      },
    ],
  }), 'E_SHADER_IR_INVALID');

  const typed = typedVertexModule(false);
  assertDiagnostic(() => validateShaderIrProgram({ ...typed.ir, canonicalHash: '0'.repeat(64) }), 'E_SHADER_IR_INVALID');
});

test('stage 2 machine contract keeps production migration and full PBR pilot deferred', async () => {
  const contract = JSON.parse(await readFile(new URL('../stage2-contract.json', import.meta.url), 'utf8'));
  assert.equal(contract.phase, 2);
  assert.equal(contract.status, 'implemented');
  assert.equal(contract.implementation, 'typed-expression-ir-and-wgsl-backend');
  assert.deepEqual(contract.productionMigrations, []);
  assert.equal(contract.pbrPilotStatus, 'typed-expression-foundation-only');
  assert.ok(contract.deliverables.includes('real-webgpu-compile-and-pixel-smoke'));
  assert.ok(contract.deferred.includes('material-surface-lowering'));
  assert.ok(contract.deferred.includes('production-pbr-migration'));
});

function typedVertexModule(withDeadNode, transformSource = {
  sourceId: 'graph.vertexTransform',
  sourceName: 'vertex-transform.graph.json',
  line: 42,
  column: 3,
}) {
  return defineTypedShaderModule({
    id: 'typed.vertex-fixture',
    resources: [{
      id: 'object.transforms',
      space: 'object',
      kind: 'uniform-buffer',
      visibility: ['vertex'],
      fixedBinding: 0,
      fields: [{
        id: 'modelViewProjection',
        type: 'mat4x4<f32>',
        semantic: 'transform',
        fromSpace: 'geometry-local',
        toSpace: 'clip',
      }],
    }],
    entries: [{
      id: 'vertexMain',
      stage: 'vertex',
      name: 'vertexMain',
      inputs: [{ id: 'position', type: positionGeometry, location: 0 }],
      output: { type: positionClip, builtin: 'position' },
      build: (builder, inputs) => {
        if (withDeadNode) builder.literal('f32', 99, { sourceId: 'graph.dead' });
        return builder.transformPosition(
          builder.uniformField('object.transforms', 'modelViewProjection'),
          inputs.position,
          'clip',
          transformSource,
        );
      },
    }],
  });
}

function defineFragmentFailure(id, build) {
  return defineTypedShaderModule({
    id,
    entries: [{
      id: 'fragmentMain',
      stage: 'fragment',
      name: 'fragmentMain',
      inputs: [
        { id: 'scalar', type: 'f32', location: 0 },
        { id: 'integer', type: 'i32', location: 1 },
        { id: 'vector', type: 'vec3<f32>', location: 2 },
        { id: 'worldPosition', type: { dataType: 'vec3<f32>', semantic: 'position', coordinateSpace: 'world' }, location: 3 },
        { id: 'objectPosition', type: { dataType: 'vec3<f32>', semantic: 'position', coordinateSpace: 'object' }, location: 4 },
        { id: 'worldDirection', type: { dataType: 'vec3<f32>', semantic: 'direction', coordinateSpace: 'world' }, location: 5 },
        { id: 'worldNormal', type: { dataType: 'vec3<f32>', semantic: 'normal', coordinateSpace: 'world' }, location: 6 },
      ],
      output: { type: 'f32', location: 0 },
      build,
    }],
  });
}

function fragmentScalarModule(id, build) {
  return defineTypedShaderModule({
    id,
    entries: [{
      id: 'fragmentMain',
      stage: 'fragment',
      name: 'fragmentMain',
      inputs: [
        { id: 'scalar', type: 'f32', location: 0 },
        { id: 'integer', type: 'i32', location: 1 },
      ],
      output: { type: 'f32', location: 0 },
      build,
    }],
  });
}

function fragmentTextureModule(id, transform) {
  return defineTypedShaderModule({
    id,
    resources: textureResources(['fragment']),
    entries: [{
      id: 'fragmentMain',
      stage: 'fragment',
      name: 'fragmentMain',
      inputs: [{ id: 'uv', type: uvGeometry, location: 0 }],
      output: { type: color4Linear, location: 0 },
      build: (builder, inputs) => transform(
        builder,
        builder.textureSample('material.albedoTexture', 'material.surfaceSampler', inputs.uv),
      ),
    }],
  });
}

function textureResources(visibility) {
  return [
    {
      id: 'material.albedoTexture',
      space: 'material',
      kind: 'texture',
      visibility,
      valueType: 'texture_2d<f32>',
      colorSpace: 'srgb',
    },
    {
      id: 'material.surfaceSampler',
      space: 'material',
      kind: 'sampler',
      visibility,
      valueType: 'sampler',
    },
  ];
}

function pbrCompositionFoundation() {
  return defineTypedShaderModule({
    id: 'material.pbr-composition-stage2',
    resources: [
      {
        id: 'material.params',
        space: 'material',
        kind: 'uniform-buffer',
        visibility: ['fragment'],
        fields: [
          { id: 'baseColorFactor', type: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' },
          { id: 'roughness', type: 'f32' },
          { id: 'noiseScale', type: 'f32' },
          { id: 'noiseStrength', type: 'f32' },
        ],
      },
      ...textureResources(['fragment']),
    ],
    entries: [{
      id: 'fragmentMain',
      stage: 'fragment',
      name: 'fragmentMain',
      inputs: [
        { id: 'uv', type: uvGeometry, location: 0 },
        { id: 'worldPosition', type: { dataType: 'vec3<f32>', semantic: 'position', coordinateSpace: 'world' }, location: 1 },
      ],
      output: { type: color4Linear, location: 0 },
      source: { sourceId: 'graph.root', sourceName: 'pilot-pbr-composition.graph.json', line: 1 },
      build: (builder, inputs) => {
        const worldY = builder.swizzle(inputs.worldPosition, 'y');
        const phase = builder.multiply(worldY, builder.uniformField('material.params', 'noiseScale'));
        const noise = builder.multiply(builder.sin(phase), builder.uniformField('material.params', 'noiseStrength'));
        const uvOffset = builder.withSemantic(builder.splat(noise, 2), uvGeometry);
        const distortedUv = builder.add(inputs.uv, uvOffset, { sourceId: 'graph.distortedUv', sourceName: 'pilot-pbr-composition.graph.json', line: 12 });
        const sampled = builder.textureSample('material.albedoTexture', 'material.surfaceSampler', distortedUv, {
          source: { sourceId: 'graph.albedoSample', sourceName: 'pilot-pbr-composition.graph.json', line: 24 },
        });
        const sampledLinear = builder.srgbToLinear(sampled);
        const sampledRgb = builder.swizzle(sampledLinear, 'rgb');

        const zero = builder.literal('f32', 0);
        const one = builder.literal('f32', 1);
        const half = builder.literal('f32', 0.5);
        const height = builder.clamp(builder.add(builder.multiply(worldY, half), half), zero, one);
        const low = builder.literal(color3Linear, [0.12, 0.32, 0.92]);
        const high = builder.literal(color3Linear, [1, 0.62, 0.12]);
        const gradient = builder.mix(low, high, height);
        const factor = builder.swizzle(builder.uniformField('material.params', 'baseColorFactor'), 'rgb');
        const roughness = builder.uniformField('material.params', 'roughness');
        const composed = builder.multiply(
          builder.multiply(builder.multiply(sampledRgb, gradient), factor),
          roughness,
          { sourceId: 'graph.composedBaseColor', sourceName: 'pilot-pbr-composition.graph.json', line: 55, column: 7 },
        );
        return builder.construct(color4Linear, [composed, builder.swizzle(sampledLinear, 'a')]);
      },
    }],
  });
}

function assertDiagnostic(callback, code) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ShaderComposerError);
    assert.equal(error.diagnostic.code, code);
    return true;
  });
}
