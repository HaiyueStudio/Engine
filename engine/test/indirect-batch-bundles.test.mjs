import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh3DRenderer, GpuDrivenBatchBuffer, FrameDiagnostics, GPUResourceTracker, createGPUResourceOwner } from '../dist/experimental.js';
import { createAuditGpuDevice, getAuditGpuDeviceState } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import { createRealRendererBenchmarkScenario, runRealRendererBenchmarkFrame, destroyRealRendererBenchmarkScenario } from '../../scripts/benchmark/real-renderer-scenario.mjs';

function fixture(t) {
  const executed = [];
  const device = createAuditGpuDevice({ behaviors: { 'renderPass.executeBundles': ({ args }) => executed.push(...args[0]) } });
  const diagnostics = new FrameDiagnostics({ enabled: true });
  const tracker = new GPUResourceTracker({ frameDiagnostics: diagnostics });
  tracker.instrumentDevice(device, createGPUResourceOwner('system', 'bundle-test'));
  const batches = new GpuDrivenBatchBuffer({ device });
  batches.upload(Array.from({ length: 300 }, (_, i) => ({ entityId: i, geometryId: 1, materialId: 1,
    instanceCount: 1, vertexCount: 3, indexCount: 3, firstInstance: i * 2, sortKey: i })));
  const cache = new Mesh3DRenderer().indirectBatches;
  const pass = device.createCommandEncoder().beginRenderPass({ colorAttachments: [] });
  const pipeline = device.createRenderPipeline({});
  const group = device.createBindGroup({ entries: [] });
  const vertex = device.createBuffer({ size: 64, usage: GPUBufferUsage.VERTEX });
  const index = device.createBuffer({ size: 64, usage: GPUBufferUsage.INDEX });
  const offsets = new Uint32Array([256]);
  const bind = (overrides = {}) => {
    cache.begin().setPipeline(overrides.pipeline ?? pipeline);
    cache.setBindGroup(0, overrides.group ?? group, offsets);
    cache.setVertexBuffer(0, overrides.vertex ?? vertex);
  };
  const draw = (first = 0, count = 3, indexed = true) => cache.draw(pass, device, batches, first, count,
    indexed ? index : null, 'uint16', ['rgba16float'], 'depth24plus', 1);
  t.after(() => { cache.clear(); batches.destroy(); tracker.releaseAll(); });
  return { device, audit: getAuditGpuDeviceState(device), executed, cache, diagnostics, batches, offsets, bind, draw };
}

test('warm indirect range reuses bindings and commands, while diagnostics count every executed GPU draw', t => {
  const f = fixture(t);
  f.diagnostics.beginFrame(1);
  f.bind(); f.draw();
  const first = f.executed[0];
  assert.deepEqual(first.commands.filter(c => c.name === 'drawIndexedIndirect').map(c => c.args[1]), [0, 20, 40]);
  assert.equal(f.diagnostics.snapshot().counters.draws, 3, 'encoding a bundle must not count twice');
  f.audit.reset(); f.diagnostics.beginFrame(2);
  // A GPU producer may replace these command contents without changing bindings.
  f.batches.writeIndexedIndirect(1, 3, 0, 0, 0, 127);
  f.bind(); f.draw();
  assert.equal(f.executed[1], first);
  assert.equal(f.audit.getCallCount('renderBundle.drawIndexedIndirect'), 0);
  assert.equal(f.audit.getCallCount('renderPass.drawIndexedIndirect'), 0);
  assert.equal(f.audit.getCallCount('renderPass.executeBundles'), 1);
  assert.equal(f.diagnostics.snapshot().counters.draws, 3);
  assert.equal(f.cache.stats.reusedDraws, 3);
});

test('bundle validity uses resource identities and copied dynamic offsets, not object transforms or IDs', t => {
  const f = fixture(t);
  f.bind(); f.draw();
  const first = f.executed.at(-1);
  f.offsets[0] = 512;
  f.bind(); f.draw();
  assert.notEqual(f.executed.at(-1), first);
  assert.equal(first.commands.find(c => c.name === 'setBindGroup').args[2][0], 256);
  for (const override of [
    { pipeline: f.device.createRenderPipeline({}) },
    { group: f.device.createBindGroup({ entries: [] }) },
    { vertex: f.device.createBuffer({ size: 64, usage: GPUBufferUsage.VERTEX }) },
  ]) {
    const previous = f.executed.at(-1);
    f.bind(override); f.draw();
    assert.notEqual(f.executed.at(-1), previous);
  }
  f.bind(); f.draw(7, 2, false);
  assert.deepEqual(f.executed.at(-1).commands.filter(c => c.name === 'drawIndirect').map(c => c.args[1]), [112, 128]);
  assert.equal(f.executed.at(-1).commands.some(c => c.name === 'setIndexBuffer'), false);
  f.cache.clear(); f.bind(); f.draw();
  assert.notEqual(f.executed.at(-1), first);
});

test('changing range layouts have a bounded bundle history', t => {
  const f = fixture(t);
  for (let first = 0; first < 300; first++) { f.bind(); f.draw(first, 1); }
  assert.equal(f.cache.stats.evictions, 44);
  const builds = f.cache.stats.builds;
  f.bind(); f.draw(0, 1);
  assert.equal(f.cache.stats.builds, builds + 1);
});

test('real renderer gpu-driven frame uses range bundles after view-ring warmup and preserves draw accounting', async () => {
  const device = createAuditGpuDevice({ recordLimit: 0 });
  const state = await createRealRendererBenchmarkScenario({ device, entityCount: 140, renderProfile: 'gpu-driven', viewCount: 2 });
  try {
    for (let frame = 0; frame < 6; frame++) await runRealRendererBenchmarkFrame(state);
    const audit = getAuditGpuDeviceState(device);
    audit.reset();
    await runRealRendererBenchmarkFrame(state);
    assert.equal(audit.getCallCount('device.createRenderBundleEncoder'), 0, 'stable frame must not encode bundles again');
    assert.ok(audit.getCallCount('renderPass.executeBundles') >= 10, 'five opaque renderer families in two views');
    assert.equal(audit.getCallCount('renderBundle.drawIndexedIndirect'), 0);
    assert.ok(state.diagnostics.snapshot().counters.draws > 100, 'GPU draws include reused commands');
  } finally { await destroyRealRendererBenchmarkScenario(state); }
  assert.equal(state.finalMetrics.ownerResidual, 0);
});
