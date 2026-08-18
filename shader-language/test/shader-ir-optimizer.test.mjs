import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  compileShaderIrProgramToGlslEs300,
  compileShaderIrProgramToWgsl,
  defineTypedShaderModule,
  optimizeShaderIrProgram,
  shaderIrOperationHasImplicitState,
} from '../dist/index.js';

const resolver = {
  resource: id => `resolved_${id.replaceAll('.', '_')}`,
  uniformField: (resourceId, fieldId) => `resolved_${resourceId.replaceAll('.', '_')}.${fieldId}`,
};

test('constant folding preserves f32 rounding and i32/u32 wrap semantics', () => {
  const typed = constantProgram();
  const optimized = optimizeShaderIrProgram(typed.ir);
  const byEntry = Object.fromEntries(optimized.program.entries.map(entry => [entry.id, entry]));

  assert.equal(byEntry.f32.nodes[0].type.dataType, 'f32');
  assert.equal(byEntry.f32.nodes[0].payload.value, Math.fround(Math.fround(0.1) + Math.fround(0.2)));
  assert.equal(byEntry.i32.nodes[0].type.dataType, 'i32');
  assert.equal(byEntry.i32.nodes[0].payload.value, -0x80000000);
  assert.equal(byEntry.u32.nodes[0].type.dataType, 'u32');
  assert.equal(byEntry.u32.nodes[0].payload.value, 0);
  assert.equal(optimized.report.constantFoldedNodeCount, 3);
  assert.equal(optimized.report.inputNodeCount, 9);
  assert.equal(optimized.report.outputNodeCount, 3);
  assert.equal(optimized.program.canonicalHash, typed.ir.canonicalHash);

  const wgsl = compileShaderIrProgramToWgsl(typed.ir, resolver, { variantCount: 3, pipelineCount: 2 });
  const glsl = compileShaderIrProgramToGlslEs300(typed.ir, { variantCount: 3, pipelineCount: 2 });
  for (const compilation of [wgsl, glsl]) {
    assert.equal(compilation.cost.schema, 'haiyue-shader-compilation-cost@1');
    assert.equal(compilation.cost.irNodeCountBeforeOptimization, 9);
    assert.equal(compilation.cost.irNodeCountAfterOptimization, 3);
    assert.equal(compilation.cost.variantCount, 3);
    assert.equal(compilation.cost.pipelineCount, 2);
    assert.ok(compilation.cost.sourceBytes > 0);
    assert.ok(Object.values(compilation.cost.phaseMs).every(value => Number.isFinite(value) && value >= 0));
    assert.equal(compilation.cost.scope.compilerOwnedPbrFullSourceVariants, 'not-reduced');
    assert.equal(compilation.cost.scope.productionArtifactPooling, 'deferred');
    assert.equal(compilation.cost.scope.overrideSpecialization, 'deferred');
  }
  assert.equal(wgsl.cost.sourceBytes, Buffer.byteLength(wgsl.code));
  assert.equal(glsl.cost.sourceBytes, Buffer.byteLength(glsl.entries.map(entry => entry.code).join('')));
  assert.ok(wgsl.sourceMap.some(span => span.sourceId === 'fold.f32'));
  assert.ok(glsl.entries.flatMap(entry => entry.sourceMap).some(span => span.sourceId === 'fold.f32'));
});

test('unsafe f32-to-int, infinity, and negative-zero cases remain runtime expressions', () => {
  const typed = defineTypedShaderModule({
    id: 'optimizer.unsafe-folds',
    entries: [
      constantEntry('rangeCast', 'i32', builder => builder.cast(builder.literal('f32', 0x7fffffff), 'i32')),
      constantEntry('infinity', 'f32', builder => builder.divide(builder.literal('f32', 1), builder.literal('f32', 0))),
      constantEntry('negativeZero', 'f32', builder => builder.multiply(builder.literal('f32', 0), builder.literal('f32', -1))),
    ],
  });
  const optimized = optimizeShaderIrProgram(typed.ir);
  assert.equal(optimized.report.constantFoldedNodeCount, 0);
  assert.deepEqual(
    optimized.program.entries.map(entry => entry.nodes.at(-1).operation),
    ['cast', 'divide', 'multiply'],
  );
});

test('pure structural CSE shares expressions, retains all source origins, and normalizes canonical identity', () => {
  const duplicated = cseProgram(false);
  const shared = cseProgram(true);
  const optimized = optimizeShaderIrProgram(duplicated.ir);

  assert.equal(duplicated.ir.canonicalHash, shared.ir.canonicalHash);
  assert.equal(optimized.report.inputNodeCount, 7);
  assert.equal(optimized.report.outputNodeCount, 5);
  assert.equal(optimized.report.commonSubexpressionEliminatedNodeCount, 2);
  const add = optimized.program.entries[0].nodes.find(node => node.operation === 'add');
  assert.deepEqual([add.source.sourceId, ...add.sourceAliases.map(source => source.sourceId)], ['cse.add.a', 'cse.add.b']);

  const wgsl = compileShaderIrProgramToWgsl(duplicated.ir, resolver);
  const glsl = compileShaderIrProgramToGlslEs300(duplicated.ir);
  for (const compilation of [wgsl, ...glsl.entries]) {
    const sourceMap = compilation.sourceMap;
    assert.ok(sourceMap.some(span => span.sourceId === 'cse.add.a'));
    assert.ok(sourceMap.some(span => span.sourceId === 'cse.add.b'));
  }
  assert.equal((wgsl.code.match(/ \+ /g) ?? []).length, 1);
  assert.equal((glsl.entries[0].code.match(/ \+ /g) ?? []).length, 1);
});

test('texture sampling and derivatives remain distinct implicit-state operations', () => {
  const typed = protectedOperationProgram();
  const optimized = optimizeShaderIrProgram(typed.ir);
  assert.deepEqual(optimized.report.protectedOperationCounts, {
    textureSample: 2,
    textureSampleLevel: 2,
    derivativeX: 2,
    derivativeY: 0,
  });
  assert.equal(optimized.program.entries.flatMap(entry => entry.nodes).filter(node => node.operation === 'texture-sample').length, 2);
  assert.equal(optimized.program.entries.flatMap(entry => entry.nodes).filter(node => node.operation === 'texture-sample-level').length, 2);
  assert.equal(optimized.program.entries.flatMap(entry => entry.nodes).filter(node => node.operation === 'derivative-x').length, 2);
  assert.equal(shaderIrOperationHasImplicitState('texture-sample'), true);
  assert.equal(shaderIrOperationHasImplicitState('texture-sample-level'), true);
  assert.equal(shaderIrOperationHasImplicitState('derivative-x'), true);
  assert.equal(shaderIrOperationHasImplicitState('add'), false);

  const wgsl = compileShaderIrProgramToWgsl(typed.ir, resolver);
  const glsl = compileShaderIrProgramToGlslEs300(typed.ir);
  assert.equal((wgsl.code.match(/textureSample\(/g) ?? []).length, 2);
  assert.equal((wgsl.code.match(/textureSampleLevel\(/g) ?? []).length, 2);
  assert.equal((wgsl.code.match(/dpdx\(/g) ?? []).length, 2);
  assert.equal(glsl.entries.reduce((count, entry) => count + (entry.code.match(/texture\(/g) ?? []).length, 0), 2);
  assert.equal(glsl.entries.reduce((count, entry) => count + (entry.code.match(/textureLod\(/g) ?? []).length, 0), 2);
  assert.equal(glsl.entries.reduce((count, entry) => count + (entry.code.match(/dFdx\(/g) ?? []).length, 0), 2);
});

test('optimizer governance keeps PBR artifact pooling and override specialization explicitly deferred', async () => {
  const contract = JSON.parse(await readFile(new URL('../shader-ir-optimizer-contract.json', import.meta.url), 'utf8'));
  assert.equal(contract.canonicalIdentity, 'optimization-normalized-and-source-metadata-independent');
  assert.deepEqual(contract.cse.protectedOperations, [
    'texture-sample', 'texture-sample-level', 'derivative-x', 'derivative-y',
  ]);
  assert.equal(contract.costEvidenceSchema, 'haiyue-shader-compilation-cost@1');
  assert.equal(contract.productionScope.compilerOwnedPbrFullSourceVariants, 'not-reduced');
  assert.equal(contract.productionScope.productionArtifactPooling, 'deferred');
  assert.equal(contract.productionScope.overrideSpecialization, 'deferred');
});

function constantProgram() {
  return defineTypedShaderModule({
    id: 'optimizer.constants',
    entries: [
      constantEntry('f32', 'f32', builder => builder.add(
        builder.literal('f32', 0.1),
        builder.literal('f32', 0.2),
        { sourceId: 'fold.f32', line: 10 },
      )),
      constantEntry('i32', 'i32', builder => builder.add(
        builder.literal('i32', 0x7fffffff),
        builder.literal('i32', 1),
        { sourceId: 'fold.i32', line: 20 },
      )),
      constantEntry('u32', 'u32', builder => builder.add(
        builder.literal('u32', 0xffffffff),
        builder.literal('u32', 1),
        { sourceId: 'fold.u32', line: 30 },
      )),
    ],
  });
}

function constantEntry(id, type, build) {
  return {
    id,
    stage: 'fragment',
    name: `${id}Main`,
    output: { type, location: 0 },
    build,
  };
}

function cseProgram(shared) {
  const positionScreen = { dataType: 'vec4<f32>', semantic: 'position', coordinateSpace: 'screen' };
  return defineTypedShaderModule({
    id: shared ? 'optimizer.cse.shared' : 'optimizer.cse.duplicated',
    entries: [{
      id: 'fragmentMain', stage: 'fragment', name: 'fragmentMain',
      inputs: [{ id: 'position', type: positionScreen, builtin: 'position' }],
      output: { type: 'f32', location: 0 },
      build: (builder, inputs) => {
        const value = builder.swizzle(inputs.position, 'x');
        const first = builder.add(
          value,
          builder.literal('f32', 2, { sourceId: 'cse.literal.a' }),
          { sourceId: 'cse.add.a', line: 11 },
        );
        const second = shared ? first : builder.add(
          value,
          builder.literal('f32', 2, { sourceId: 'cse.literal.b' }),
          { sourceId: 'cse.add.b', line: 12 },
        );
        return builder.multiply(first, second);
      },
    }],
  });
}

function protectedOperationProgram() {
  const positionScreen = { dataType: 'vec4<f32>', semantic: 'position', coordinateSpace: 'screen' };
  const uvScreen = { dataType: 'vec2<f32>', semantic: 'uv', coordinateSpace: 'screen' };
  const colorLinear = { dataType: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' };
  return defineTypedShaderModule({
    id: 'optimizer.protected',
    resources: [
      { id: 'material.texture', space: 'material', kind: 'texture', visibility: ['fragment'], valueType: 'texture_2d<f32>', colorSpace: 'linear' },
      { id: 'material.sampler', space: 'material', kind: 'sampler', visibility: ['fragment'], valueType: 'sampler' },
    ],
    entries: [
      {
        id: 'samples', stage: 'fragment', name: 'samplesMain',
        output: { type: colorLinear, location: 0 },
        build: builder => {
          const uv = builder.literal(uvScreen, [0.5, 0.5]);
          const first = builder.textureSample('material.texture', 'material.sampler', uv, { source: { sourceId: 'sample.a' } });
          const second = builder.textureSample('material.texture', 'material.sampler', uv, { source: { sourceId: 'sample.b' } });
          const level = builder.literal('f32', 0);
          const third = builder.textureSample('material.texture', 'material.sampler', uv, { level, source: { sourceId: 'sample-level.a' } });
          const fourth = builder.textureSample('material.texture', 'material.sampler', uv, { level, source: { sourceId: 'sample-level.b' } });
          return builder.add(builder.add(first, second), builder.add(third, fourth));
        },
      },
      {
        id: 'derivatives', stage: 'fragment', name: 'derivativesMain',
        inputs: [{ id: 'position', type: positionScreen, builtin: 'position' }],
        output: { type: positionScreen, location: 0 },
        build: (builder, inputs) => builder.multiply(
          builder.derivativeX(inputs.position, { sourceId: 'derivative.a' }),
          builder.derivativeX(inputs.position, { sourceId: 'derivative.b' }),
        ),
      },
    ],
  });
}
