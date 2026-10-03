import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import { importEngineSource } from './helpers/internal-source.mjs';
const { TransientTextureAllocator } = await importEngineSource('rtt/TransientTextureAllocator.ts');
const { acquireSequentialAttachments, releaseSequentialAttachments, getSequentialAttachmentAllocator } = await importEngineSource('rtt/TransientAttachmentSequence.ts');
const descriptor = () => ({ size: [32, 16], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
const request = (name, firstUse, lastUse, changes = {}) => ({ name, firstUse, lastUse, descriptor: { ...descriptor(), ...changes } });
function context(device, frameId = 1) {
  const callbacks = [], completions = [];
  return { device, encoder: device.createCommandEncoder(), frameData: { frameId }, afterSubmit: cb => callbacks.push(cb),
    submit() { callbacks.splice(0).forEach(cb => cb({ onSubmittedWorkDone: () => new Promise(resolve => completions.push(resolve)) })); },
    async complete() { completions.splice(0).forEach(resolve => resolve()); await Promise.resolve(); await Promise.resolve(); } };
}

test('inclusive lifetimes alias only after the last usage scope and preserve exact descriptors', () => {
  const device = createAuditGpuDevice(), pool = new TransientTextureAllocator(device), ctx = context(device);
  const lease = pool.acquire([request('a', 0, 1), request('b', 1, 2), request('c', 2, 3), request('usage', 4, 4, { usage: GPUTextureUsage.RENDER_ATTACHMENT }),
    request('size', 5, 5, { size: [16, 16] }), request('format', 6, 6, { format: 'r16float' }), request('samples', 7, 7, { sampleCount: 4 }),
    request('mips', 8, 8, { mipLevelCount: 2 }), request('layers', 9, 9, { size: [32, 16, 2] })], ctx);
  const a = lease.assignments;
  assert.notEqual(a[0].texture, a[1].texture, 'read and write at the same pass cannot alias');
  assert.equal(a[0].texture, a[2].texture);
  assert.equal(new Set(a.map(x => x.texture)).size, 8);
  lease.release(); pool.destroy(true); assert.equal(pool.stats.physicalBytes, 0);
});

test('different unsubmitted encoders stay isolated; queue-ordered frames reuse, destruction waits for completion', async () => {
  const device = createAuditGpuDevice(), pool = new TransientTextureAllocator(device);
  const a = context(device), b = context(device), c = context(device, 2);
  const first = pool.acquire([request('a', 0, 1)], a); first.release();
  const same = pool.acquire([request('same-encoder', 2, 3)], a); same.release();
  assert.equal(first.assignments[0].texture, same.assignments[0].texture);
  const other = pool.acquire([request('other-encoder', 0, 1)], b); other.release();
  assert.notEqual(first.assignments[0].texture, other.assignments[0].texture);
  a.submit();
  const queued = pool.acquire([request('queued', 0, 1)], c); queued.release();
  assert.equal(first.assignments[0].texture, queued.assignments[0].texture);
  pool.destroy(); assert.ok(!first.assignments[0].texture.destroyed);
  c.submit(); b.submit(); await a.complete(); await b.complete();
  assert.ok(!first.assignments[0].texture.destroyed);
  await c.complete(); assert.equal(pool.stats.physicalBytes, 0);
});

test('bad plans do not allocate; budget failures roll back and 300 resizes have bounded idle storage', async () => {
  const device = createAuditGpuDevice(); let bytes = 0;
  const pool = new TransientTextureAllocator(device, size => { if (bytes + size > 20000) throw Error('budget'); bytes += size; return () => { bytes -= size; }; });
  const ctx = context(device);
  assert.throws(() => pool.acquire([request('a', 3, 2)], ctx), /interval/);
  assert.throws(() => pool.acquire([request('a', 0, 1), request('a', 2, 3)], ctx), /Duplicate/);
  assert.equal(bytes, 0);
  assert.throws(() => pool.acquire([request('first', 0, 3), request('too-large', 0, 3, { size: [128, 128] })], ctx), /budget/);
  assert.equal(bytes, 0);
  for (let i = 0; i < 300; i++) {
    const frame = context(device, i + 2);
    const lease = pool.acquire([request('scratch', 0, 1, { size: [16 + i % 3, 16] })], frame);
    lease.release(); frame.submit(); await frame.complete();
    assert.ok(bytes <= 2 * 18 * 16 * 8);
  }
  pool.destroy(); assert.equal(bytes, 0);
});

test('MRT sequences reuse equal-size views, retain latest diagnostics, and reject a third unsubmitted generation', async () => {
  const device = createAuditGpuDevice(), owner = {}, a = context(device), b = context(device), c = context(device);
  const acquire = (view, ctx, reverse = false) => acquireSequentialAttachments(owner, view, 32, 16, ['rgba16float', 'rgba16float', 'rgba16float', 'depth32float'], ctx,
    { name: 'gbuffer', firstUse: 0, lastUse: 3 }, reverse, () => () => {});
  const first = acquire('left', a), second = acquire('right', a);
  assert.equal(first, second, 'stable views preserve bind group caches');
  assert.equal(new Set(first.textures).size, 4);
  const independent = acquire('left', b);
  assert.notEqual(first.textures[0], independent.textures[0]);
  assert.throws(() => acquire('left', c), { reason: 'live-target-generations' });
  a.submit(); b.submit(); await a.complete(); await b.complete();
  const reversed = acquire('left', c, true);
  assert.notEqual(reversed.textures[3], first.textures[3], 'depth convention is part of compatibility');
  releaseSequentialAttachments(owner); assert.ok(!reversed.textures[3].destroyed);
  c.submit(); await c.complete(); assert.equal(getSequentialAttachmentAllocator(owner).stats.physicalBytes, 0);
});

test('cached logical slot plans re-resolve physical textures for pending encoders and descriptor changes', async () => {
  const device = createAuditGpuDevice(), pool = new TransientTextureAllocator(device);
  const requests = [request('a', 0, 1), request('b', 1, 2), request('c', 2, 3)];
  const firstContext = context(device), secondContext = context(device);
  const first = pool.acquire(requests, firstContext); first.release();
  const second = pool.acquire(requests, secondContext); second.release();
  assert.equal(pool.planCache.stats.hits, 1);
  assert.equal(second.assignments[0].texture, second.assignments[2].texture);
  assert.notEqual(first.assignments[0].texture, second.assignments[0].texture);
  pool.planCache.enabled = false;
  const uncached = pool.acquire(requests, secondContext); uncached.release();
  assert.deepEqual(uncached.assignments.map(a => a.physicalId), second.assignments.map(a => a.physicalId));
  pool.planCache.enabled = true;
  const resized = pool.acquire([request('a', 0, 1, { size: [16, 16] })], firstContext); resized.release();
  assert.equal(pool.planCache.stats.size, 2);
  pool.destroy(); firstContext.submit(); secondContext.submit(); await firstContext.complete(); await secondContext.complete();
  assert.equal(pool.stats.physicalBytes, 0); assert.equal(pool.planCache.stats.size, 0);
});
