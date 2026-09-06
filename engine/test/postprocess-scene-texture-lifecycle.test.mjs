import test from 'node:test';
import assert from 'node:assert/strict';
import { PostProcessSceneTextureStore } from '../dist/experimental.js';
import { createAuditGpuDevice, getAuditGpuDeviceState } from '../../scripts/benchmark/real-renderer-audit-device.mjs';

const requirements = { depth: true, normal: true, motion: true, outlineMask: true, auxDepth: true };
const surface = { width: 320, height: 180, format: 'rgba8unorm', sampleCount: 4 };
const smallSurface = { ...surface, width: 128, height: 96 };

function fixture() {
  const completions = [];
  const device = createAuditGpuDevice({ behaviors: {
    'queue.onSubmittedWorkDone': () => new Promise((resolve, reject) => completions.push({ resolve, reject })),
  } });
  const engine = { device, ...surface, msaaSamples: 4, getDepthFormat: reverseZ => reverseZ ? 'depth32float' : 'depth24plus' };
  const store = new PostProcessSceneTextureStore();
  const callbacks = [];
  return {
    store, engine, completions,
    audit: getAuditGpuDeviceState(device),
    beginFrame: id => store.beginFrame(id, callback => callbacks.push(callback)),
    submit: () => {
      device.queue.submit([]);
      for (const callback of callbacks.splice(0)) callback(device.queue);
    },
    ensure: (target = surface, reverseZ = false) => store.ensure(engine, requirements, reverseZ, target),
    callbackCount: () => callbacks.length,
  };
}

function textures(store) {
  return [store.depthTexture, store.normalTexture, store.motionTexture, store.outlineMaskTexture,
    store.outlineVisibleMaskTexture, store.outlineVisibleMaskMsaaTexture, store.auxDepthTexture];
}

test('auxiliary textures and views survive same-frame size switches and reuse their original allocations', t => {
  const f = fixture();
  t.after(() => f.store.destroy());
  // Also exercises callers without an afterSubmit boundary: retain until explicit destroy.
  f.ensure();
  const first = textures(f.store);
  const depthView = f.store.depthView;
  f.ensure(smallSurface);
  assert.ok(first.every(texture => !texture.destroyed), 'first view must survive recording the second');
  f.ensure();
  assert.deepEqual(textures(f.store), first);
  assert.equal(f.store.depthView, depthView);
  assert.equal(f.audit.resources.get('texture').created, 14);
  f.store.destroy();
  assert.equal(f.audit.resources.get('texture').live, 0);
});

test('auxiliary resources are keyed by format, MSAA and depth convention as well as size', t => {
  const f = fixture();
  t.after(() => f.store.destroy());
  f.ensure();
  const original = textures(f.store);
  f.ensure({ ...surface, format: 'bgra8unorm' });
  assert.equal(f.store.outlineMaskTexture.format, 'bgra8unorm');
  assert.notEqual(f.store.outlineMaskTexture, original[3]);
  f.ensure({ ...surface, sampleCount: 1 }, true);
  assert.equal(f.store.auxDepthTexture.format, 'depth32float');
  assert.equal(f.store.outlineVisibleMaskMsaaTexture, null);
  assert.equal(f.store.outlineVisibleMaskMsaaView, null);
  f.ensure();
  assert.deepEqual(textures(f.store), original);
  assert.ok(original.every(texture => !texture.destroyed));
});

test('unused sizes retire only after submission and queue completion; current-frame sizes stay cached', async t => {
  const f = fixture();
  t.after(() => f.store.destroy());
  f.beginFrame(1);
  f.ensure();
  const original = textures(f.store);
  f.beginFrame(1);
  f.ensure(smallSurface);
  assert.equal(f.callbackCount(), 1, 'one queue completion request per frame');
  f.submit();
  f.completions[0].resolve();
  await Promise.resolve();
  assert.ok(original.every(texture => !texture.destroyed));
  f.beginFrame(2);
  f.ensure(smallSurface);
  assert.ok(original.every(texture => !texture.destroyed));
  f.submit();
  assert.ok(original.every(texture => !texture.destroyed));
  f.completions[1].resolve();
  await Promise.resolve();
  assert.ok(original.every(texture => texture.destroyed));
  assert.equal(f.audit.resources.get('texture').live, 7);
});

test('an earlier completion cannot retire resources reused by a later in-flight frame', async t => {
  const f = fixture();
  t.after(() => f.store.destroy());
  f.beginFrame(1);
  f.ensure();
  const original = textures(f.store);
  f.submit();
  f.beginFrame(2);
  f.ensure(smallSurface);
  f.submit();
  f.beginFrame(3);
  f.ensure();
  f.completions[0].resolve();
  f.completions[1].resolve();
  await Promise.resolve();
  assert.deepEqual(textures(f.store), original);
  assert.ok(original.every(texture => !texture.destroyed));
});

test('disabling auxiliary effects releases idle resources and clears exposed references after completion', async t => {
  const f = fixture();
  t.after(() => f.store.destroy());
  f.beginFrame(1);
  f.ensure();
  f.submit();
  f.completions[0].resolve();
  await Promise.resolve();
  f.beginFrame(2);
  f.submit();
  f.completions[1].reject(new Error('device lost'));
  await Promise.resolve();
  assert.ok(textures(f.store).every(texture => texture === null));
  assert.equal(f.store.depthView, null);
  assert.equal(f.audit.resources.get('texture').live, 0);
  f.beginFrame(3);
  f.ensure();
  assert.ok(textures(f.store).every(texture => !texture.destroyed));
});

test('destroy is idempotent and pending completions cannot affect a recovered store', async () => {
  const f = fixture();
  f.beginFrame(10);
  f.ensure();
  f.submit();
  f.beginFrame(11);
  f.submit();
  f.store.destroy();
  f.store.destroy();
  assert.equal(f.audit.resources.get('texture').live, 0);
  f.beginFrame(0);
  f.ensure();
  f.completions[0].resolve();
  f.completions[1].resolve();
  await Promise.resolve();
  assert.ok(textures(f.store).every(texture => !texture.destroyed));
  f.store.destroy();
  assert.equal(f.audit.resources.get('texture').live, 0);
});
