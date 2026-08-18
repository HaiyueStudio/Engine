import test from 'node:test';
import assert from 'node:assert/strict';
import { TransparentMegaBatch } from '../dist/experimental.js';

function entry(payload, overrides = {}) {
  return {
    payload,
    entityId: overrides.entityId ?? payload,
    materialId: overrides.materialId ?? 1,
    rendererKey: overrides.rendererKey ?? 1,
    viewDepth: overrides.viewDepth ?? 0,
    transparentOrder: overrides.transparentOrder ?? 0,
    depthSort: overrides.depthSort ?? true,
  };
}

test('TransparentMegaBatch sorts globally by order, depth, renderer, material, and entity', () => {
  const batch = new TransparentMegaBatch();
  batch.push(entry('near', { entityId: 3, viewDepth: 2 }));
  batch.push(entry('far', { entityId: 2, viewDepth: 9 }));
  batch.push(entry('additive', { entityId: 1, transparentOrder: 10, depthSort: false, viewDepth: 999 }));
  batch.push(entry('same-depth-b', { entityId: 5, viewDepth: 4, rendererKey: 2, materialId: 1 }));
  batch.push(entry('same-depth-a', { entityId: 4, viewDepth: 4, rendererKey: 1, materialId: 2 }));

  batch.sort();

  const sorted = [];
  batch.forEachSorted(item => sorted.push(item.payload));
  assert.deepEqual(sorted, ['far', 'same-depth-a', 'same-depth-b', 'near', 'additive']);
});

test('TransparentMegaBatch preserves wide renderer material entity and signed order keys', () => {
  const batch = new TransparentMegaBatch();
  batch.push(entry('material-20', { entityId: 100, rendererKey: 1, materialId: 20, viewDepth: 5 }));
  batch.push(entry('material-4', { entityId: 90, rendererKey: 1, materialId: 4, viewDepth: 5 }));
  batch.push(entry('renderer-32', { entityId: 80, rendererKey: 32, materialId: 1, viewDepth: 5 }));
  batch.push(entry('renderer-16', { entityId: 70, rendererKey: 16, materialId: 1, viewDepth: 5 }));
  batch.push(entry('entity-high', { entityId: 4000, rendererKey: 50, materialId: 50, viewDepth: 5 }));
  batch.push(entry('entity-low', { entityId: 3000, rendererKey: 50, materialId: 50, viewDepth: 5 }));
  batch.push(entry('negative-order', { entityId: 1, transparentOrder: -1, viewDepth: 1 }));

  batch.sort();

  const sorted = [];
  batch.forEachSorted(item => sorted.push(item.payload));
  assert.deepEqual(sorted, [
    'negative-order',
    'material-4',
    'material-20',
    'renderer-16',
    'renderer-32',
    'entity-low',
    'entity-high',
  ]);
});

test('TransparentMegaBatch clear reuses storage and removes stale payload references', () => {
  const batch = new TransparentMegaBatch();
  batch.push(entry({ name: 'first' }, { viewDepth: 1 }));
  batch.sort();
  assert.equal(batch.count, 1);

  batch.clear();
  assert.equal(batch.count, 0);
  assert.equal(batch.entries[0].payload, null);

  batch.push(entry('second', { viewDepth: 2 }));
  batch.sort();
  const sorted = [];
  batch.forEachSorted(item => sorted.push(item.payload));
  assert.deepEqual(sorted, ['second']);
});

test('TransparentMegaBatch preserves insertion order when all sort keys match', () => {
  const batch = new TransparentMegaBatch();
  batch.push(entry('first', { entityId: 7, materialId: 3, rendererKey: 2, viewDepth: 5 }));
  batch.push(entry('second', { entityId: 7, materialId: 3, rendererKey: 2, viewDepth: 5 }));
  batch.push(entry('third', { entityId: 7, materialId: 3, rendererKey: 2, viewDepth: 5 }));

  batch.sort();

  const sorted = [];
  batch.forEachSorted(item => sorted.push(item.payload));
  assert.deepEqual(sorted, ['first', 'second', 'third']);
});

test('TransparentMegaBatch CPU and GPU depth keys share quantization for edge depths and repeated views', () => {
  globalThis.GPUBufferUsage ??= { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, MAP_READ: 8 };
  const device = {
    queue: { writeBuffer() {} },
    createBuffer: descriptor => ({ descriptor, destroy() {} }),
  };
  const createBatch = () => {
    const batch = new TransparentMegaBatch();
    batch.push(entry('coplanar-high-id', { entityId: 9, viewDepth: 1.02 }));
    batch.push(entry('coplanar-low-id', { entityId: 3, viewDepth: 1 }));
    batch.push(entry('negative', { entityId: 1, viewDepth: -100 }));
    batch.push(entry('huge', { entityId: 2, viewDepth: Number.MAX_VALUE }));
    batch.sort();
    assert.equal(batch.uploadGpu({ device }), true);
    return batch;
  };

  const first = createBatch();
  const second = createBatch();
  const sorted = [];
  first.forEachSorted(item => sorted.push(item.payload));
  assert.deepEqual(sorted, ['huge', 'coplanar-low-id', 'coplanar-high-id', 'negative']);

  const firstKeys = first._sortKeyData;
  const secondKeys = second._sortKeyData;
  assert.equal(firstKeys[1], firstKeys[6], 'near-coplanar depths use the same bucket and stable tie-break');
  assert.equal(firstKeys[16], 0, 'extreme positive depth clamps to the farthest reverse key');
  assert.equal(firstKeys[11], 0x7fff, 'negative depth clamps to the nearest reverse key');
  assert.deepEqual(
    Array.from(firstKeys.subarray(0, 20)),
    Array.from(secondKeys.subarray(0, 20)),
    'the quantized policy is view-local and deterministic',
  );
});
