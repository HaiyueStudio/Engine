import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import { importEngineSource } from './helpers/internal-source.mjs';
const { DeferredLightGpuTable } = await importEngineSource('renderer/DeferredLightGpuTable.ts');
const { DeferredLightTable, createDeferredReferenceView } = await importEngineSource('frame/DeferredLightTable.ts');
const candidate = intensity => ({ id: 1, shadow: null, info: { type: 2, color: [1, 1, 1], intensity, position: [0, 0, 1], range: 2, direction: [0, -1, 0] } });
function context(device) {
  const callbacks = [];
  return { device, encoder: device.createCommandEncoder(), afterSubmit: cb => callbacks.push(cb),
    async submit() { device.queue.submit([this.encoder.finish()]); for (const cb of callbacks.splice(0)) cb(device.queue); await device.queue.onSubmittedWorkDone(); } };
}

test('static source uploads once across views and frames; source and view bindings use independent aligned bytes', async () => {
  const device = createAuditGpuDevice(), gpu = new DeferredLightGpuTable(device);
  const source = new DeferredLightTable().update([candidate(1)], []);
  const a = createDeferredReferenceView(source), b = createDeferredReferenceView(source), ctx = context(device);
  const first = gpu.bind(source, a, ctx), second = gpu.bind(source, b, ctx);
  assert.equal(gpu.stats.sourceUploads, 1);
  assert.equal(gpu.stats.viewUploads, 2);
  assert.equal(first.source.offset, second.source.offset);
  assert.notEqual(first.header.offset, second.header.offset);
  assert.equal(first.indices.offset % device.limits.minStorageBufferOffsetAlignment, 0);
  assert.equal(first.header.size, 32);
  await ctx.submit();
  const next = context(device);
  gpu.bind(source, a, next);
  assert.equal(gpu.stats.sourceUploads, 1);
  assert.equal(gpu.stats.viewUploads, 2);
  gpu.destroy();
  assert.equal(first.source.buffer.destroyed, false, 'pending encoder retains resources after destroy');
  await next.submit();
  assert.equal(first.source.buffer.destroyed, true);
  assert.equal(first.header.buffer.destroyed, true);
});

test('more than three unsubmitted phases allocate protected slots and retire growth only after submit', async () => {
  const writes = [];
  const device = createAuditGpuDevice({ behaviors: { 'queue.writeBuffer': ({ args, defaultImplementation }) => {
    writes.push({ buffer: args[0], offset: args[1], bytes: new Uint8Array(args[2].buffer ?? args[2]).slice() });
    return defaultImplementation();
  } } });
  const gpu = new DeferredLightGpuTable(device), cpu = new DeferredLightTable(), ctx = context(device);
  const bindings = [];
  for (let i = 1; i <= 9; i++) {
    const source = cpu.update([candidate(i)], []);
    bindings.push(gpu.bind(source, createDeferredReferenceView(source), ctx));
  }
  assert.equal(new Set(bindings.map(b => b.source.offset)).size, 9);
  const first = bindings[0].source.buffer, last = bindings.at(-1).source.buffer;
  assert.notEqual(first, last);
  assert.equal(first.destroyed, false);
  const restored = writes.find(w => w.buffer === last && w.offset === 0);
  assert.equal(new DataView(restored.bytes.buffer).getFloat32(32, true), 1, 'growth restores the first immutable source');
  await ctx.submit();
  assert.equal(first.destroyed, true);
  const next = context(device), source = cpu.update([candidate(10)], []);
  const binding = gpu.bind(source, createDeferredReferenceView(source), next);
  assert.equal(binding.source.buffer, last, 'completed slots recycle without frame-by-frame allocation');
  await next.submit(); gpu.destroy();
  assert.equal(last.destroyed, true);
});

test('zero-light bindings remain legal; stale source, missing submit hook and device replacement fail explicitly', () => {
  const device = createAuditGpuDevice(), gpu = new DeferredLightGpuTable(device), cpu = new DeferredLightTable();
  const empty = cpu.update([], []), view = createDeferredReferenceView(empty), ctx = context(device);
  const binding = gpu.bind(empty, view, ctx);
  assert.equal(binding.source.size, 80);
  assert.equal(binding.indices.size, 4);
  assert.throws(() => gpu.bind(empty, view, { device, encoder: device.createCommandEncoder() }), /afterSubmit/);
  assert.throws(() => gpu.bind(empty, view, context(createAuditGpuDevice())), /generation/);
  assert.throws(() => gpu.bind(cpu.update([candidate(1)], []), view, ctx), /Stale/);
  gpu.abandon();
  assert.equal(binding.source.buffer.destroyed, true);
  assert.equal(binding.header.buffer.destroyed, true);
  assert.throws(() => gpu.bind(empty, view, ctx), /destroyed/);
});

test('growth retirement protects older encoders submitted after the growing encoder', async () => {
  const device = createAuditGpuDevice(), gpu = new DeferredLightGpuTable(device), cpu = new DeferredLightTable();
  const older = context(device), newer = context(device);
  const source = cpu.update([candidate(1)], []);
  const original = gpu.bind(source, createDeferredReferenceView(source), older);
  for (let i = 2; i <= 5; i++) {
    const next = cpu.update([candidate(i)], []);
    gpu.bind(next, createDeferredReferenceView(next), newer);
  }
  await newer.submit();
  assert.equal(original.source.buffer.destroyed, false, 'older source encoder has not submitted');
  assert.equal(original.header.buffer.destroyed, false, 'older view encoder has not submitted');
  gpu.destroy();
  await older.submit();
  assert.equal(original.source.buffer.destroyed, true);
  assert.equal(original.header.buffer.destroyed, true);
});

test('device loss after normal teardown abandons all pending buffer generations', async () => {
  const device = createAuditGpuDevice(), gpu = new DeferredLightGpuTable(device), cpu = new DeferredLightTable();
  const pending = context(device), buffers = new Set();
  for (let i = 1; i <= 9; i++) {
    const source = cpu.update([candidate(i)], []);
    const binding = gpu.bind(source, createDeferredReferenceView(source), pending);
    buffers.add(binding.source.buffer); buffers.add(binding.header.buffer);
  }
  gpu.destroy();
  assert.ok([...buffers].every(buffer => !buffer.destroyed));
  gpu.abandon();
  assert.ok([...buffers].every(buffer => buffer.destroyed));
});

test('submitted dynamic records reuse their binding while GPU completion notifications are pending', async () => {
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const device = createAuditGpuDevice({ behaviors: { 'queue.onSubmittedWorkDone': () => completion } });
  const gpu = new DeferredLightGpuTable(device), cpu = new DeferredLightTable(), submissions = [];
  let first;
  try {
    for (let i = 1; i <= 12; i++) {
      const ctx = context(device), source = cpu.update([candidate(i)], []);
      const binding = gpu.bind(source, createDeferredReferenceView(source), ctx);
      first ??= binding;
      assert.equal(binding.source.buffer, first.source.buffer, 'submitted records must not grow the buffer');
      assert.equal(binding.source.offset, first.source.offset, 'binding offset must not depend on completion notification timing');
      assert.equal(binding.header.offset, first.header.offset);
      submissions.push(ctx.submit());
    }
    gpu.destroy();
    assert.equal(first.source.buffer.destroyed, false, 'buffer destruction still waits for GPU completion');
  } finally {
    gpu.destroy(); complete(); await Promise.all(submissions);
    gpu.abandon();
  }
  assert.equal(first.source.buffer.destroyed, true);
});

test('a submitted encoder cannot release a shared slot still referenced by an unsubmitted encoder', async () => {
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const device = createAuditGpuDevice({ behaviors: { 'queue.onSubmittedWorkDone': () => completion } });
  const gpu = new DeferredLightGpuTable(device), cpu = new DeferredLightTable(), submissions = [];
  const older = context(device), shared = context(device);
  const source = cpu.update([candidate(1)], []), view = createDeferredReferenceView(source);
  const first = gpu.bind(source, view, older);
  gpu.bind(source, view, shared);
  submissions.push(shared.submit());
  try {
    const next = context(device), changed = cpu.update([candidate(2)], []);
    const second = gpu.bind(changed, createDeferredReferenceView(changed), next);
    assert.notEqual(second.source.offset, first.source.offset, 'unsubmitted draw must retain its original record');
    assert.notEqual(second.header.offset, first.header.offset);
    submissions.push(next.submit());
    submissions.push(older.submit());
    const last = context(device), changedAgain = cpu.update([candidate(3)], []);
    const third = gpu.bind(changedAgain, createDeferredReferenceView(changedAgain), last);
    assert.equal(third.source.offset, first.source.offset, 'all references have submitted; queue ordering permits reuse');
    assert.equal(third.header.offset, first.header.offset);
    submissions.push(last.submit());
    gpu.destroy();
    assert.equal(first.source.buffer.destroyed, false);
  } finally {
    gpu.destroy(); complete(); await Promise.all(submissions); gpu.abandon();
  }
  assert.equal(first.source.buffer.destroyed, true);
});
