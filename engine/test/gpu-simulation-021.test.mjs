import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditGpuDevice, getAuditGpuDeviceState } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import { GpuComputeProgram, GpuReadbackRing, GpuInstanceLod, InstancedToonMaterial, InstancedMesh3DRenderer, inspectGpuSimulationCapabilities } from '../dist/experimental/gpu-driven.js';
import { createBox3D } from '../dist/geometry.js';
import { ComputeKernel } from '../dist/compute.js';
const limits = { maxComputeWorkgroupsPerDimension: 65535, maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxStorageBuffersPerShaderStage: 8 };
const gpu = options => createAuditGpuDevice({ limits, ...options });
const context = device => { const callbacks = []; return { device, encoder: device.createCommandEncoder(), afterSubmit: cb => callbacks.push(cb), submit() { device.queue.submit([this.encoder.finish()]); for (const cb of callbacks) cb(); } }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const options = { label: 'test-compute', code: '@compute @workgroup_size(1) fn main() {}', bindGroupLayoutEntries: [] };

test('async compute must initialize; checks owner, limits, active pass and stale device', async () => {
  const device = gpu(), engine = { device }, program = new GpuComputeProgram(engine, options), ctx = context(device);
  assert.throws(() => program.createBindGroup([]), /Initialize/);
  await program.initialize();
  const group = program.createBindGroup([]);
  program.dispatch(ctx, group, 1);
  program.dispatch(ctx, group, 0);
  assert.throws(() => program.dispatch(ctx, group, 65536), /limit/);
  assert.throws(() => program.dispatch({ ...ctx, passEncoder: {} }, group, 1), /render pass/);
  assert.throws(() => program.dispatch(ctx, {}, 1), /foreign/);
  const indirect = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDIRECT });
  program.dispatchIndirect(ctx, group, indirect);
  assert.throws(() => program.dispatchIndirect(ctx, group, indirect, 4), /indirect/);
  const calls = getAuditGpuDeviceState(device).snapshot().calls;
  assert.equal(calls.filter(c => c.method === 'device.createComputePipelineAsync').length, 1);
  engine.device = gpu();
  assert.throws(() => program.dispatch(ctx, group, 1), /Initialize/);
  await program.initialize();
  assert.throws(() => program.dispatch(context(engine.device), group, 1), /stale/);
  program.destroy();
  await assert.rejects(program.initialize(), /destroyed/);
});

test('async pipeline completion after disposal cannot resurrect the program', async () => {
  let complete;
  const device = gpu();
  const create = device.createComputePipelineAsync;
  device.createComputePipelineAsync = descriptor => new Promise(resolve => { complete = () => resolve(create(descriptor)); });
  const program = new GpuComputeProgram({ device }, options);
  const ready = program.initialize();
  program.destroy(); complete();
  await assert.rejects(ready, /superseded/);
  assert.throws(() => program.createBindGroup([]), /Initialize/);
});

test('legacy ComputeKernel rejects cross-device and nested-pass dispatch', () => {
  const device = gpu(), engine = { device }, kernel = new ComputeKernel(engine, options), group = kernel.createBindGroup([]);
  assert.throws(() => kernel.dispatch({ ...context(device), passEncoder: {} }, group, 1), /active/);
  assert.throws(() => kernel.dispatch(context(gpu()), group, 1), /active/);
  assert.throws(() => kernel.dispatch(context(device), group, 65536), /limit/);
  engine.device = gpu();
  assert.throws(() => kernel.createBindGroup([]), /previous device/);
});

test('readback begins only after submission, applies backpressure and releases mapping before reuse', async () => {
  let mapped = 0, complete;
  const device = gpu({ behaviors: { 'buffer.mapAsync': ({ defaultImplementation }) => { mapped++; return new Promise(resolve => { complete = () => { defaultImplementation(); resolve(); }; }); } } });
  const ring = new GpuReadbackRing(device, 16, 1), source = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC }), ctx = context(device);
  const request = ring.request(ctx, source, 0, 16, 'tick-7');
  assert.equal(mapped, 0);
  assert.equal(ring.request(ctx, source, 0, 4), null);
  ctx.submit(); await flush(); assert.equal(mapped, 1);
  complete(); const result = await request; await flush();
  assert.equal(result.status, 'completed'); assert.equal(result.bytes.length, 16); assert.equal(result.token, 'tick-7');
  assert.equal(ring.stats.pending, 0); assert.equal(ring.stats.skipped, 1);
  ring.destroy(); source.destroy();
});

test('reset and disposal invalidate pending publications without reusing mapped slots', async () => {
  let complete;
  const device = gpu({ behaviors: { 'buffer.mapAsync': ({ defaultImplementation }) => new Promise(resolve => { complete = () => { defaultImplementation(); resolve(); }; }) } });
  const ring = new GpuReadbackRing(device, 4, 1), source = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_SRC }), ctx = context(device);
  const request = ring.request(ctx, source, 0, 4); ctx.submit(); await flush();
  ring.invalidate(); assert.equal((await request).status, 'cancelled');
  assert.equal(ring.request(context(device), source, 0, 4), null);
  ring.destroy(); complete(); await flush(); await flush();
  assert.equal(ring.stats.pending, 0); assert.equal(ring.stats.completed, 0);
  assert.equal(getAuditGpuDeviceState(device).snapshot().calls.filter(c => c.method === 'buffer.destroy').length, 1);
  source.destroy();
});

test('LOD uses aligned visibility slices and GPU count copies; capacity and encoder misuse fail early', () => {
  const device = gpu(), engine = { device }, lod = new GpuInstanceLod(engine, 65);
  const matrices = device.createBuffer({ size: 65 * 64, usage: GPUBufferUsage.STORAGE });
  const colors = device.createBuffer({ size: 65 * 16, usage: GPUBufferUsage.STORAGE });
  const command = device.createBuffer({ size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
  const view = { planes: new Float32Array(24), viewMatrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], localSphere: [0,0,0,1], projectionPixelScale: 100, perspective: true };
  const ctx = context(device); lod.encode(ctx, matrices, 65, view); lod.encodeDrawCount(ctx, 2, command);
  assert.equal(lod.source(2, matrices, colors).visibleOffset, 1024);
  assert.throws(() => lod.encode(ctx, matrices, 65, view), /separate LOD/);
  assert.throws(() => lod.encode(context(device), matrices, 66, view), /input/);
  const copies = getAuditGpuDeviceState(device).snapshot().calls.filter(c => c.method === 'commandEncoder.copyBufferToBuffer');
  assert.equal(copies.length, 1);
  engine.device = gpu(); assert.throws(() => lod.reset(), /lost device/);
  lod.destroy(); matrices.destroy(); colors.destroy(); command.destroy();
});

test('borrowed GPU instance buffers avoid CPU instance uploads/auxiliary allocations and remain caller-owned', () => {
  const device = gpu(), renderer = new InstancedMesh3DRenderer(); renderer.prepare({ device, format: 'rgba8unorm', getDepthFormat: () => 'depth24plus' });
  // The public frame snapshot accepted by updateCamera is immutable per frame.
  renderer.updateCamera({ frameId: 1, phaseRevision: 0, cameraEntityId: 1, data: new Float32Array(68) });
  const source = { device, capacity: 4, count: 4,
    transforms: device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE }),
    colors: device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE }),
    visibleIndices: device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE }) };
  const material = new InstancedToonMaterial(1), geometry = createBox3D();
  const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [] });
  const audit = getAuditGpuDeviceState(device); audit.reset();
  renderer.render(pass, 42, geometry, material, { externalInstances: source });
  renderer.render(pass, 42, geometry, material, { externalInstances: source });
  assert.equal(renderer.matCache.size, 0);
  const calls = audit.snapshot().calls;
  assert.equal(calls.filter(c => c.method === 'device.createBuffer' && /GpuInstances/.test(c.label)).length, 1);
  assert.equal(calls.filter(c => c.method === 'queue.writeBuffer' && /GpuInstances/.test(c.label)).length, 1);
  assert.throws(() => renderer.render(pass, 43, geometry, material, { externalInstances: { ...source, visibleOffset: 4 } }), /alignment/);
  const destroyed = [];
  for (const b of [source.transforms, source.colors, source.visibleIndices]) { const original = b.destroy; b.destroy = () => { destroyed.push(b); original(); }; }
  pass.end(); renderer.destroy();
  assert.equal(destroyed.length, 0);
  for (const b of [source.transforms, source.colors, source.visibleIndices]) b.destroy();
});

test('capability admission reports insufficient device limits explicitly', () => {
  const report = inspectGpuSimulationCapabilities(gpu(), { stateBytes: 320000, instanceCount: 10000 });
  assert.equal(report.supported, true);
  assert.equal(inspectGpuSimulationCapabilities(gpu({ limits: { ...limits, maxComputeInvocationsPerWorkgroup: 32 } }), { stateBytes: 320000, instanceCount: 10000 }).supported, false);
});

test('disposing an encoded readback retains its destination until submitted work is mapped', async () => {
  const device = gpu(), ring = new GpuReadbackRing(device, 4, 1), ctx = context(device);
  const source = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_SRC });
  const request = ring.request(ctx, source, 0, 4);
  const audit = getAuditGpuDeviceState(device); audit.reset(); ring.destroy();
  assert.equal((await request).status, 'cancelled');
  assert.equal(audit.getCallCount('buffer.destroy'), 0);
  ctx.submit(); await flush(); await flush();
  assert.equal(audit.getCallCount('buffer.destroy'), 1);
  assert.equal(ring.stats.pending, 0); source.destroy();
});

test('legacy instance buffers allocate culling/sorting on demand and release all auxiliary resources', () => {
  const device = gpu(), renderer = new InstancedMesh3DRenderer(); renderer.prepare({ device });
  const audit = getAuditGpuDeviceState(device); audit.reset();
  const material = new InstancedToonMaterial(16), data = renderer._ensureMaterialData(42, material, 16);
  assert.equal(audit.getCallCount('device.createBuffer'), 4);
  const cull = data.auxiliary.culling(); assert.equal(audit.getCallCount('device.createBuffer'), 6);
  assert.equal(data.auxiliary.culling(), cull); assert.equal(audit.getCallCount('device.createBuffer'), 6);
  data.auxiliary.sorting(); assert.equal(audit.getCallCount('device.createBuffer'), 9);
  data.auxiliary.indirect(); assert.equal(audit.getCallCount('device.createBuffer'), 11);
  renderer.releaseEntitiesNotIn(new Set()); assert.equal(audit.getCallCount('buffer.destroy'), 11);
  renderer.destroy();
});
