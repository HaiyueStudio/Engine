import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createRenderFrameContext } from '../dist/experimental.js';
import { createAuditGpuDevice, getAuditGpuDeviceState } from '../../scripts/benchmark/real-renderer-audit-device.mjs';

function fixture() {
  const device = createAuditGpuDevice(), audit = getAuditGpuDeviceState(device);
  const frame = createRenderFrameContext({ device }, { descriptor: { colorAttachments: [] } });
  const shader = device.createShaderModule({ code: '' });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'main' } });
  const buffer = device.createBuffer({ size: 4096, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.UNIFORM });
  const group = device.createBindGroup({ layout: device.createBindGroupLayout({ entries: [] }), entries: [] });
  return { device, audit, frame, pipeline, buffer, group };
}

test('repeated draw state emits one binding per pass, preserving every draw', () => {
  const f = fixture(), pass = f.frame.beginPass();
  for (let i = 0; i < 1000; i++) {
    pass.setPipeline(f.pipeline); pass.setBindGroup(0, f.group, [256]);
    pass.setVertexBuffer(0, f.buffer); pass.setIndexBuffer(f.buffer, 'uint16');
    pass.drawIndexed(6);
  }
  for (const method of ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer']) assert.equal(f.audit.getCallCount(`renderPass.${method}`), 1, method);
  assert.equal(f.audit.getCallCount('renderPass.drawIndexed'), 1000);
  f.frame.endPass();
  const next = f.frame.beginPass(); next.setPipeline(f.pipeline); next.setBindGroup(0, f.group, [256]);
  assert.equal(f.audit.getCallCount('renderPass.setPipeline'), 2);
  assert.equal(f.audit.getCallCount('renderPass.setBindGroup'), 2);
  f.frame.submit(); f.buffer.destroy();
});

test('dynamic offset snapshots detect mutation, slices, and arbitrary iterable inputs', () => {
  const f = fixture(), pass = f.frame.beginPass();
  const offsets = new Uint32Array([111, 256, 512, 999]);
  pass.setBindGroup(0, f.group, offsets, 1, 2);
  pass.setBindGroup(0, f.group, [256, 512]);
  assert.equal(f.audit.getCallCount('renderPass.setBindGroup'), 1);
  offsets[1] = 768;
  pass.setBindGroup(0, f.group, offsets, 1, 2);
  assert.equal(f.audit.getCallCount('renderPass.setBindGroup'), 2);
  pass.setBindGroup(0, f.group, runInNewContext('new Uint32Array([999, 768, 512, 888])'), 1, 2);
  assert.equal(f.audit.getCallCount('renderPass.setBindGroup'), 2, 'typed offset slices retain their meaning across realms');
  let iterations = 0;
  function* values() { iterations++; yield 768; yield 512; }
  // The audit device records rather than consumes iterables. Check forwarding identity.
  const iterator = values(); pass.setBindGroup(0, f.group, iterator);
  pass.setBindGroup(0, f.group, [768, 512]);
  assert.equal(iterations, 0);
  assert.equal(f.audit.getCallCount('renderPass.setBindGroup'), 4);
  pass.setBindGroup(2, undefined); pass.setBindGroup(2, undefined);
  pass.setBindGroup(2, null);
  assert.equal(f.audit.getCallCount('renderPass.setBindGroup'), 6, 'unbinding an initially empty slot is forwarded safely');
  f.frame.submit(); f.buffer.destroy();
});

test('render bundles invalidate binding state, while buffer ranges and slots remain distinct', () => {
  const f = fixture();
  // Render3D opens its isolated scene pass through the encoder, not beginPass().
  const pass = f.frame.encoder.beginRenderPass({ colorAttachments: [] });
  const bind = () => { pass.setPipeline(f.pipeline); pass.setBindGroup(0, f.group); pass.setVertexBuffer(0, f.buffer); pass.setIndexBuffer(f.buffer, 'uint16'); };
  bind(); bind(); pass.executeBundles([]); bind(); bind();
  for (const method of ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer']) assert.equal(f.audit.getCallCount(`renderPass.${method}`), 2, method);
  pass.setVertexBuffer(0, f.buffer, 16, 32); pass.setVertexBuffer(1, f.buffer, 16, 32);
  pass.setIndexBuffer(f.buffer, 'uint32'); pass.setBindGroup(1, f.group);
  assert.equal(f.audit.getCallCount('renderPass.setVertexBuffer'), 4);
  assert.equal(f.audit.getCallCount('renderPass.setIndexBuffer'), 3);
  assert.equal(f.audit.getCallCount('renderPass.setBindGroup'), 3);
  pass.end(); f.frame.submit(); f.buffer.destroy();
  assert.equal(f.audit.snapshot().resources.buffer.live, 0);
});
