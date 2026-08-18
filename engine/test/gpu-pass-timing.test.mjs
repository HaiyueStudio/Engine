import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameDiagnostics, GPUResourceTracker, RenderPipeline, World, registerEngineDiagnostics } from '../dist/experimental.js';

function ensureGpuConstants() {
  globalThis.GPUBufferUsage ??= {
    MAP_READ: 1 << 0,
    COPY_SRC: 1 << 1,
    COPY_DST: 1 << 2,
    QUERY_RESOLVE: 1 << 3,
  };
  globalThis.GPUMapMode ??= { READ: 1 };
}

function createTimingEngine({ supported = true, diagnosticsEnabled = true } = {}) {
  ensureGpuConstants();
  const diagnostics = new FrameDiagnostics({ enabled: diagnosticsEnabled });
  const timestamps = new BigUint64Array(256);
  const resources = { querySets: [], buffers: [] };
  let clock = 0n;

  const device = {
    queue: { submit() {} },
    createQuerySet(descriptor) {
      const querySet = { descriptor, destroyed: false, destroy() { this.destroyed = true; } };
      resources.querySets.push(querySet);
      return querySet;
    },
    createBuffer(descriptor) {
      const storage = new ArrayBuffer(descriptor.size);
      const buffer = {
        descriptor,
        storage,
        destroyed: false,
        async mapAsync() {},
        getMappedRange(offset = 0, size = descriptor.size - offset) { return storage.slice(offset, offset + size); },
        unmap() {},
        destroy() { this.destroyed = true; },
      };
      resources.buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder() {
      const createPass = descriptor => {
        const writes = descriptor?.timestampWrites;
        if (writes?.beginningOfPassWriteIndex !== undefined) {
          timestamps[writes.beginningOfPassWriteIndex] = clock;
          clock += 1_000_000n;
        }
        return {
          end() {
            if (writes?.endOfPassWriteIndex !== undefined) {
              timestamps[writes.endOfPassWriteIndex] = clock;
              clock += 250_000n;
            }
          },
        };
      };
      return {
        beginRenderPass: createPass,
        beginComputePass: createPass,
        resolveQuerySet(_querySet, firstQuery, queryCount, destination, destinationOffset) {
          const target = new BigUint64Array(destination.storage, destinationOffset, queryCount);
          target.set(timestamps.subarray(firstQuery, firstQuery + queryCount));
        },
        copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
          new Uint8Array(destination.storage, destinationOffset, size)
            .set(new Uint8Array(source.storage, sourceOffset, size));
        },
        finish() { return {}; },
      };
    },
  };
  const descriptor = { colorAttachments: [{ view: {}, loadOp: 'clear', storeOp: 'store' }] };
  const engine = {
    device,
    timestampQuerySupported: supported,
    getRenderPassDescriptor: () => descriptor,
    getOutputView: () => ({}),
    getDepthFormat: () => 'depth24plus',
  };
  registerEngineDiagnostics(engine, {
    frameDiagnostics: diagnostics,
    resourceTracker: new GPUResourceTracker({ frameDiagnostics: diagnostics }),
  });
  return {
    engine,
    diagnostics,
    resources,
  };
}

test('RenderPipeline reports asynchronous GPU timing for each actual shared, compute, and isolated pass', async () => {
  const { engine, diagnostics, resources } = createTimingEngine();
  diagnostics.beginFrame(7);
  const pipeline = new RenderPipeline(engine);
  const world = new World('gpu-pass-timing');

  pipeline
    .add({ label: 'shared-a', record() {} }, { pass: 'shared', loadOp: 'clear' })
    .add({ label: 'shared-b', record() {} }, { pass: 'shared', loadOp: 'clear' })
    .add({
      label: 'compute-work',
      record(_world, context) {
        context.encoder.beginComputePass({ label: 'inner-compute' }).end();
      },
    }, { passType: 'compute' })
    .add({
      label: 'isolated-work',
      record(_world, context) {
        context.beginPass(context.descriptor, context.loadOp);
        context.endPass();
      },
    }, { pass: 'isolated', loadOp: 'load' });

  pipeline.execute(world);
  await new Promise(resolve => setImmediate(resolve));

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.gpu.frame, 7);
  assert.equal(snapshot.gpu.passes.length, 3);
  assert.deepEqual(snapshot.gpu.passes.map(pass => pass.type), ['render', 'compute', 'render']);
  assert.equal(snapshot.gpu.passes.every(pass => pass.durationMs === 1), true);
  assert.equal(snapshot.gpu.totalMs, 3);
  assert.equal(snapshot.gpuMs, 3);
  assert.match(snapshot.gpu.passes[0].label, /^render:/);
  assert.match(snapshot.gpu.passes[1].label, /^compute:/);
  assert.match(snapshot.gpu.passes[2].label, /isolated-work$/);

  pipeline.clear();
  assert.equal(resources.querySets.every(resource => resource.destroyed), true);
  assert.equal(resources.buffers.every(resource => resource.destroyed), true);
});

test('GPU pass timing allocates nothing when diagnostics or timestamp-query support is disabled', () => {
  for (const options of [
    { supported: false, diagnosticsEnabled: true },
    { supported: true, diagnosticsEnabled: false },
  ]) {
    const { engine, diagnostics, resources } = createTimingEngine(options);
    diagnostics.beginFrame(1);
    const pipeline = new RenderPipeline(engine);
    pipeline.add({ record() {} }, { pass: 'shared' });
    pipeline.execute(new World('gpu-pass-timing-disabled'));
    assert.equal(resources.querySets.length, 0);
    assert.equal(resources.buffers.length, 0);
    assert.equal(diagnostics.snapshot().gpu, undefined);
  }
});

test('FrameDiagnostics rejects stale GPU readbacks and combines pipelines completed for the same frame', () => {
  const diagnostics = new FrameDiagnostics({ enabled: true });
  diagnostics.beginFrame(9);
  diagnostics.setGpuPassDurations(9, [
    { index: 0, type: 'render', label: 'main', durationMs: 2 },
  ]);
  diagnostics.setGpuPassDurations(8, [
    { index: 0, type: 'compute', label: 'stale', durationMs: 100 },
  ]);
  diagnostics.setGpuPassDurations(9, [
    { index: 0, type: 'compute', label: 'post', durationMs: 0.5 },
  ]);

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.gpu.frame, 9);
  assert.equal(snapshot.gpu.totalMs, 2.5);
  assert.deepEqual(snapshot.gpu.passes.map(pass => [pass.index, pass.label]), [[0, 'main'], [1, 'post']]);
});
