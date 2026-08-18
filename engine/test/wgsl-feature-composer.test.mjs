import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeWgsl,
  createComposedShaderModule,
  createRenderPipelineAsync,
  defineWgslFeatureModule,
  formatWgslCompilationMessage,
  mapWgslSourceLocation,
} from '../dist/experimental.js';

test('WGSL composer orders dependencies, deduplicates includes, and creates a canonical feature key', () => {
  const math = defineWgslFeatureModule({
    id: 'test.math',
    sourceName: 'math.wgsl',
    source: 'fn twice(value: f32) -> f32 { return value * 2.0; }',
    exports: ['twice'],
  });
  const lighting = defineWgslFeatureModule({
    id: 'test.lighting',
    sourceName: 'lighting.wgsl',
    source: 'fn illuminate(value: f32) -> f32 { return twice(value); }',
    dependencies: [math],
    exports: ['illuminate'],
  });

  const first = composeWgsl({
    label: 'test',
    sourceName: 'entry.wgsl',
    source: 'fn main() -> f32 { return illuminate(SCALE); }',
    features: [lighting, math],
    defines: { SCALE: '2.0' },
  });
  const reordered = composeWgsl({
    label: 'test',
    sourceName: 'entry.wgsl',
    source: 'fn main() -> f32 { return illuminate(SCALE); }',
    features: [math, lighting],
    defines: { SCALE: '2.0' },
  });

  assert.deepEqual(first.featureIds, ['test.math', 'test.lighting']);
  assert.equal(first.featureKey, reordered.featureKey);
  assert.equal(first.code, reordered.code);
  assert.equal(first.code.match(/fn twice/g)?.length, 1);
  assert.ok(first.code.indexOf('fn twice') < first.code.indexOf('fn illuminate'));
  assert.match(first.code, /const SCALE = 2\.0;/);
});

test('WGSL composer rejects cycles, conflicting module ids, and duplicate exported symbols', () => {
  const cyclicA = {
    id: 'cycle.a', source: 'fn a() {}', sourceName: 'a.wgsl', exports: ['a'], dependencies: [],
  };
  const cyclicB = {
    id: 'cycle.b', source: 'fn b() {}', sourceName: 'b.wgsl', exports: ['b'], dependencies: [cyclicA],
  };
  cyclicA.dependencies.push(cyclicB);
  assert.throws(() => composeWgsl({ label: 'cycle', source: 'fn main() {}', features: [cyclicA] }), /dependency cycle/);

  const sharedA = defineWgslFeatureModule({ id: 'same.id', source: 'fn first() {}', exports: ['first'] });
  const sharedB = defineWgslFeatureModule({ id: 'same.id', source: 'fn second() {}', exports: ['second'] });
  assert.throws(
    () => composeWgsl({ label: 'ids', source: 'fn main() {}', features: [sharedA, sharedB] }),
    /Conflicting WGSL feature module id/,
  );

  const duplicateA = defineWgslFeatureModule({ id: 'duplicate.a', source: 'fn shared() {}', exports: ['shared'] });
  const duplicateB = defineWgslFeatureModule({ id: 'duplicate.b', source: 'fn shared() {}', exports: ['shared'] });
  assert.throws(
    () => composeWgsl({ label: 'exports', source: 'fn main() {}', features: [duplicateA, duplicateB] }),
    /provided by both/,
  );
});

test('WGSL composer rejects resource binding collisions across features and entry source', () => {
  const storage = defineWgslFeatureModule({
    id: 'test.storage',
    sourceName: 'storage.wgsl',
    source: '@group(1) @binding(0) var<storage, read> featureObjects: array<vec4f>;',
    exports: ['featureObjects'],
  });

  assert.throws(
    () => composeWgsl({
      label: 'binding-collision',
      sourceName: 'entry.wgsl',
      source: '@group(1) @binding(0) var<uniform> entryObject: vec4f;',
      features: [storage],
    }),
    /@group\(1\) @binding\(0\).*test\.storage.*@entry/,
  );
  assert.doesNotThrow(() => composeWgsl({
    label: 'binding-reserved',
    sourceName: 'entry.wgsl',
    source: [
      '// @group(1) @binding(0) in documentation is not a declaration.',
      '@group(1) @binding(1) var<uniform> entryObject: vec4f;',
    ].join('\n'),
    features: [storage],
  }));
});

test('WGSL compilation locations map generated lines back to feature modules', () => {
  const fog = defineWgslFeatureModule({
    id: 'test.fog',
    sourceName: 'fog-feature.wgsl',
    source: ['fn fogAmount() -> f32 {', '  return broken_symbol;', '}'].join('\n'),
    exports: ['fogAmount'],
  });
  const composition = composeWgsl({
    label: 'mapped',
    sourceName: 'entry.wgsl',
    source: 'fn main() -> f32 { return fogAmount(); }',
    features: [fog],
  });
  const generatedLine = composition.code.split('\n').findIndex(line => line.includes('broken_symbol')) + 1;
  const location = mapWgslSourceLocation(composition, generatedLine, 10);

  assert.deepEqual(location, {
    moduleId: 'test.fog',
    sourceName: 'fog-feature.wgsl',
    line: 2,
    column: 10,
    generatedLine,
  });
  assert.equal(
    formatWgslCompilationMessage(composition, {
      message: "unresolved identifier 'broken_symbol'",
      lineNum: generatedLine,
      linePos: 10,
      type: 'error',
    }),
    "fog-feature.wgsl:2:10 [error] unresolved identifier 'broken_symbol'",
  );
});

test('composed shader compilation errors are exposed as an awaitable hard failure', async () => {
  const composition = composeWgsl({
    label: 'broken',
    sourceName: 'broken.wgsl',
    source: '@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }',
  });
  let pipelineCreated = false;
  const device = {
    createShaderModule() {
      return {
        async getCompilationInfo() {
          return { messages: [{ message: 'synthetic failure', lineNum: 1, linePos: 1, type: 'error' }] };
        },
      };
    },
    async createRenderPipelineAsync() {
      pipelineCreated = true;
      return {};
    },
  };
  const module = createComposedShaderModule(device, composition);
  await assert.rejects(createRenderPipelineAsync(device, {
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
  }, { renderer: 'test', key: 'broken', label: 'broken pipeline' }), error => {
    assert.match(error.message, /Failed to compile render pipeline/);
    assert.match(error.cause?.message ?? '', /WGSL compilation failed.*synthetic failure/s);
    return true;
  });
  assert.equal(pipelineCreated, false);
});
