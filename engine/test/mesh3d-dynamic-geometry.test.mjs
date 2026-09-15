import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import { BasicMaterial, Geometry3D } from '../dist/index.js';
import { Mesh3DRenderer } from '../dist/experimental.js';

test('dynamic Basic meshes keep every bound vertex stream large enough when helpers grow and shrink', async () => {
  for (const initialCount of [288, 0]) {
    const bound = new Map();
    const pendingRetirements = [];
    let drawn = -1;
    const device = createAuditGpuDevice({ behaviors: {
      'renderPass.setVertexBuffer': ({ args: [slot, buffer] }) => bound.set(slot, buffer),
      'renderPass.draw': ({ args: [count, , first] }) => {
        drawn = count;
        for (let slot = 0; slot < 7; slot++) {
          const buffer = bound.get(slot);
          assert.ok(buffer && !buffer.destroyed, `slot ${slot} must bind a live buffer`);
          const required = (first + count) * (slot === 2 ? 8 : 12);
          assert.ok(buffer.size >= required, `slot ${slot}: ${buffer.size} bytes cannot draw ${count} vertices (${required} bytes)`);
        }
      },
      'queue.onSubmittedWorkDone': () => new Promise(resolve => pendingRetirements.push(resolve)),
    } });
    const renderer = new Mesh3DRenderer();
    renderer.prepare({ device, format: 'rgba8unorm', getDepthFormat: () => 'depth24plus' });
    const geometry = new Geometry3D({ positions: new Float32Array(initialCount * 3) });
    const material = new BasicMaterial();
    const worldMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const items = [{ entityId: 1, geometry, material, worldMatrix }];
    const batch = { gpuUploadEnabled: false, getObjectSlot: () => 6 };
    const draw = count => {
      geometry.positions = new Float32Array(count * 3);
      geometry.markDirty();
      renderer.prepareObjects(items, 0, 1, 0, batch);
      renderer.flushUploads();
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [] });
      renderer.renderBatch(pass, items, 0, 1, batch);
      pass.end();
      device.queue.submit([encoder.finish()]);
      assert.equal(drawn, count);
      return [3, 4, 5, 6].map(slot => bound.get(slot));
    };
    try {
      const original = draw(initialCount);
      const grown = draw(2304);
      assert.ok(original.every(buffer => !buffer.destroyed), 'previous buffers must survive in-flight work');
      for (const resolve of pendingRetirements.splice(0)) resolve();
      await Promise.resolve();
      assert.ok(original.every(buffer => buffer.destroyed), 'replaced buffers retire after GPU work completes');
      for (const count of [288, 0, 2304]) assert.deepEqual(draw(count), grown, 'reuse sufficient fallback capacity');
      draw(4608);
    } finally {
      renderer.destroy();
      for (const resolve of pendingRetirements.splice(0)) resolve();
      await Promise.resolve();
    }
  }
});
