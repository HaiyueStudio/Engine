import test from 'node:test';
import assert from 'node:assert/strict';
import { captureAtomicReadback } from './framegraph-atomic-readback.mjs';

test('a failed map retains all resources until the other maps settle; copies share one submission', async () => {
  const previous = Object.fromEntries(['GPUBufferUsage', 'GPUShaderStage', 'GPUMapMode'].map(k => [k, globalThis[k]]));
  Object.assign(globalThis, { GPUBufferUsage: { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 },
    GPUShaderStage: { COMPUTE: 1 }, GPUMapMode: { READ: 1 } });
  let release, maps = 0, submissions = 0;
  const buffers = [], copies = [], events = [];
  const pending = new Promise(resolve => { release = resolve; });
  const pass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
  const encoder = { beginComputePass: () => pass,
    copyBufferToBuffer(...args) { copies.push(args); },
    copyTextureToBuffer(...args) { copies.push(args); }, finish: () => ({}) };
  const device = {
    createBuffer({ size }) {
      const data = new ArrayBuffer(size);
      const buffer = { size, destroyed: false, getMappedRange: () => data, unmap() {},
        mapAsync() { events.push('map'); maps++; return maps === 1 ? Promise.reject(Error('injected mapping failure')) : maps === 2 ? pending : Promise.resolve(); },
        destroy() { this.destroyed = true; events.push('destroy'); } };
      buffers.push(buffer); return buffer;
    },
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }), createBindGroup: () => ({}),
    createCommandEncoder: () => encoder, queue: { submit() { submissions++; events.push('submit'); } },
  };
  const texture = { width: 64, height: 64, format: 'bgra8unorm', createView: () => ({}) };
  try {
    const run = captureAtomicReadback(device, texture, texture,
      { texture: { ...texture, width: 63, height: 5 }, buffer: { size: 1024 } },
      { frameId: 5, copySource: true, access: 'native' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(submissions, 1); assert.equal(maps, 7);
    assert.equal(buffers.some(b => b.destroyed), false);
    assert.equal(events[0], 'submit');
    release(); const result = await run;
    assert.equal(result.atomicReadback.mapErrors.length, 1);
    assert.equal(result.atomicReadback.mapErrors[0].key, 'computed');
    assert.equal(result.computed, null);
    assert.equal(result.sourcePixels.length, 16384);
    assert.equal(buffers.every(b => b.destroyed), true);
    const textureCopies = copies.filter(args => args.length === 3);
    assert.equal(textureCopies.length, 2);
    assert.deepEqual(textureCopies[1][2], { width: 63, height: 5, depthOrArrayLayers: 1 });
    assert.equal(textureCopies[1][1].bytesPerRow, 256);
    assert.equal(textureCopies[1][1].rowsPerImage, 5);
  } finally {
    release();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
