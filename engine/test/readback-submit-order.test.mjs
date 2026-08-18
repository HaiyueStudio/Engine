import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRenderFrameContext,
  GpuDrivenBatchBuffer,
  TransparentMegaBatch,
} from '../dist/experimental.js';

function ensureGpuConstants() {
  globalThis.GPUBufferUsage ??= {
    STORAGE: 1 << 0,
    COPY_DST: 1 << 1,
    COPY_SRC: 1 << 2,
    INDIRECT: 1 << 3,
    MAP_READ: 1 << 4,
  };
  globalThis.GPUMapMode ??= { READ: 1 };
}

function createReadbackEngine(log, options = {}) {
  ensureGpuConstants();
  const mappedIndices = new Uint32Array([1, 0]).buffer;
  const device = {
    createBuffer(descriptor) {
      return {
        label: descriptor.label,
        mapAsync() {
          log.push(['mapAsync', descriptor.label]);
          return options.mapAsync?.(descriptor) ?? Promise.resolve();
        },
        getMappedRange() {
          return mappedIndices;
        },
        unmap() {
          log.push(['unmap', descriptor.label]);
        },
        destroy() { log.push(['destroy', descriptor.label]); },
      };
    },
    createCommandEncoder() {
      return {
        copyBufferToBuffer(source, _sourceOffset, destination, _destinationOffset, size) {
          log.push(['copyBufferToBuffer', source.label, destination.label, size]);
        },
        finish() {
          log.push(['finish']);
          return { type: 'command-buffer' };
        },
      };
    },
    queue: {
      writeBuffer() {},
      submit() {
        log.push(['submit']);
      },
    },
  };
  return { device };
}

function transparentEntry(payload, entityId) {
  return {
    payload,
    entityId,
    materialId: 1,
    rendererKey: 1,
    viewDepth: entityId,
    transparentOrder: 0,
    depthSort: true,
  };
}

test('GPU readbacks enter mapping only after RenderFrameContext submission', async () => {
  const log = [];
  const engine = createReadbackEngine(log);
  const transparent = new TransparentMegaBatch(engine, 'transparent-test');
  transparent.push(transparentEntry('first', 1));
  transparent.push(transparentEntry('second', 2));
  assert.equal(transparent.uploadGpu(), true);

  const gpuDriven = new GpuDrivenBatchBuffer(engine, 'gpu-driven-test');
  gpuDriven.upload([
    { entityId: 1, geometryId: 1, materialId: 1, instanceCount: 1, indexCount: 3, vertexCount: 3, sortKey: 2 },
    { entityId: 2, geometryId: 1, materialId: 1, instanceCount: 1, indexCount: 3, vertexCount: 3, sortKey: 1 },
  ]);

  const context = createRenderFrameContext(engine, { descriptor: { colorAttachments: [] } });
  assert.equal(transparent.requestGpuSortedIndexReadback(context), true);
  assert.equal(gpuDriven.requestSortedIndexReadback(context), true);
  assert.equal(gpuDriven.requestIndexedInstanceCountReadback(context), true);
  assert.equal(log.some(entry => entry[0] === 'mapAsync'), false);

  context.submit();
  const submitIndex = log.findIndex(entry => entry[0] === 'submit');
  const mapIndices = log
    .map((entry, index) => entry[0] === 'mapAsync' ? index : -1)
    .filter(index => index >= 0);
  assert.equal(mapIndices.length, 3);
  assert.equal(mapIndices.every(index => index > submitIndex), true);

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual([...transparent.getGpuSortedIndices()], [1, 0]);
  assert.deepEqual([...gpuDriven.getSortedIndices()], [1, 0]);
});

test('readback is skipped when a custom command context has no submission boundary', () => {
  const log = [];
  const engine = createReadbackEngine(log);
  const transparent = new TransparentMegaBatch(engine, 'transparent-no-submit-boundary');
  transparent.push(transparentEntry('only', 1));
  transparent.uploadGpu();
  const bareContext = {
    device: engine.device,
    encoder: engine.device.createCommandEncoder(),
  };

  assert.equal(transparent.requestGpuSortedIndexReadback(bareContext), false);
  assert.equal(log.some(entry => entry[0] === 'copyBufferToBuffer'), false);
  assert.equal(log.some(entry => entry[0] === 'mapAsync'), false);
});

test('destroy cancels pending readback and defers native buffer destruction until mapping settles', async () => {
  const log = [];
  let settleMapping;
  const mapping = new Promise(resolve => { settleMapping = resolve; });
  const engine = createReadbackEngine(log, {
    mapAsync: descriptor => descriptor.label.endsWith('indexedInstanceCounts.readback.0') ? mapping : Promise.resolve(),
  });
  const gpuDriven = new GpuDrivenBatchBuffer(engine, 'gpu-driven-pending-destroy');
  gpuDriven.upload([
    { entityId: 1, geometryId: 1, materialId: 1, instanceCount: 1, indexCount: 3, vertexCount: 3, sortKey: 1 },
  ]);
  const results = [];
  const context = createRenderFrameContext(engine, { descriptor: { colorAttachments: [] } });
  assert.equal(gpuDriven.requestIndexedInstanceCountReadback(context, { token: 7, onComplete: result => results.push(result) }), true);
  context.submit();
  gpuDriven.destroy();

  const readbackLabel = 'gpu-driven-pending-destroy.indexedInstanceCounts.readback.0';
  assert.equal(log.some(entry => entry[0] === 'destroy' && entry[1] === readbackLabel), false);
  settleMapping();
  await mapping;
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(results.map(result => ({ status: result.status, token: result.token, published: result.published })), [
    { status: 'cancelled', token: 7, published: false },
  ]);
  assert.equal(log.some(entry => entry[0] === 'destroy' && entry[1] === readbackLabel), true);
  assert.equal(gpuDriven.getReadbackDebugSnapshot().indexedInstanceCounts.pending, 0);
});
