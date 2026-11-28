import test from 'node:test';
import assert from 'node:assert/strict';
import {Entity} from '@haiyue/engine';
import {Animation2DRenderSystem} from '../dist/animation.js';
import {createAuditGpuDevice, getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';

globalThis.GPUTextureUsage ??= {TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16};
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
const settle = async () => {await Promise.resolve(); await Promise.resolve();};
function fixture() {
  const fences = [], device = createAuditGpuDevice({behaviors: {'queue.onSubmittedWorkDone': () => {
    const fence = deferred(); fences.push(fence); return fence.promise;
  }}});
  const lost = deferred(); device.lost = lost.promise;
  const renderer = new Animation2DRenderSystem({device, width: 64, height: 32, format: 'rgba8unorm', msaaSamples: 1}, new Entity());
  const context = () => {
    const submits = [], cancels = [];
    return {device, afterSubmit: cb => submits.push(cb), afterCancel: cb => cancels.push(cb),
      submit() {for (const cb of submits) cb(device.queue);}, cancel() {for (const cb of cancels) cb();}};
  };
  return {device, renderer, context, fences, lost, live: () => getAuditGpuDeviceState(device).snapshot().resources.texture?.live ?? 0};
}

test('effect resize retires the old generation even when the replacement recording is cancelled', async () => {
  const f = fixture(), a = f.context(), old = f.renderer.getEffectTarget('a', a, 1); a.submit();
  f.renderer.engine.width = 96;
  const b = f.context(), next = f.renderer.getEffectTarget('a', b, 2); b.cancel();
  f.renderer.destroyEffectTarget(next);
  assert.equal(f.live(), 2, 'only the previously submitted generation waits for completion');
  assert.equal(f.fences.length, 1);
  f.fences[0].resolve(); await settle();
  assert.equal(f.live(), 0);
  f.renderer.destroyEffectTarget(old); assert.equal(f.live(), 0);
});

test('effect sweeping and repeated cancellation release unused targets exactly once', async () => {
  const f = fixture(), context = f.context();
  f.renderer.getEffectTarget('a', context, 1);
  f.renderer.sweepEffectTargets(3, context);
  assert.equal(f.live(), 2);
  context.cancel(); context.cancel(); context.submit(); await settle();
  assert.equal(f.live(), 0);
  assert.equal(f.fences.length, 0);
});

test('effect targets shared by recordings survive one cancellation and the submitted queue fence', async () => {
  const f = fixture(), a = f.context(), b = f.context(), target = f.renderer.getEffectTarget('a', a, 1);
  assert.equal(f.renderer.getEffectTarget('a', b, 2), target);
  f.renderer.destroyEffectTarget(target); a.cancel();
  assert.equal(f.live(), 2); assert.equal(f.fences.length, 0);
  b.submit(); assert.equal(f.live(), 2); assert.equal(f.fences.length, 1);
  f.fences[0].resolve(); await settle(); assert.equal(f.live(), 0);
});

test('effect retirement cleans up on rejected queue completion and rejects closed contexts', async () => {
  const f = fixture(), context = f.context(), target = f.renderer.getEffectTarget('a', context, 1);
  for (let i = 0; i < 10; i++) assert.equal(f.renderer.getEffectTarget('a', context, 1), target);
  context.submit();
  assert.throws(() => f.renderer.getEffectTarget('a', context, 1), /after submission or cancellation/);
  f.renderer.destroyEffectTarget(target);
  assert.equal(f.fences.length, 1);
  f.fences[0].reject(Error('device lost')); await settle(); assert.equal(f.live(), 0);
});

test('effect retirement preserves the legacy direct-host queue fence', async () => {
  const f = fixture(), target = f.renderer.getEffectTarget('a', {device: f.device}, 1);
  f.renderer.destroyEffectTarget(target); assert.equal(f.live(), 2);
  assert.equal(f.fences.length, 1); f.fences[0].resolve(); await settle(); assert.equal(f.live(), 0);
});

test('recovery retires masks and effects together without destroying an open recording', () => {
  const f = fixture(), context = f.context();
  f.renderer.getMaskTarget('mask', context, 1);
  f.renderer.getEffectTarget('effect', context, 1);
  f.renderer.releaseGpuResourcesForRecovery();
  assert.equal(f.live(), 3);
  assert.equal(f.renderer.maskTargets.size, 0);
  assert.equal(f.renderer.effectTargets.size, 0);
  context.cancel(); assert.equal(f.live(), 0);
  f.renderer.releaseGpuResourcesForRecovery(); assert.equal(f.live(), 0);
});

test('device loss releases active and retired target generations while fences and recordings remain open', async () => {
  const f = fixture(), a = f.context();
  const old = f.renderer.getEffectTarget('effect', a, 1); a.submit();
  f.renderer.engine.width = 96;
  const b = f.context(); f.renderer.getEffectTarget('effect', b, 2); f.renderer.getMaskTarget('mask', b, 2);
  const resources = getAuditGpuDeviceState(f.device).snapshot().resources.texture;
  assert.equal(f.live(), 5); assert.equal(f.fences.length, 1);
  f.lost.resolve({reason: 'destroyed'}); await settle();
  assert.equal(f.live(), 0);
  b.cancel(); f.fences[0].resolve(); await settle();
  f.renderer.destroyEffectTarget(old); f.renderer.releaseGpuResourcesForRecovery();
  assert.equal(f.live(), 0);
  assert.equal(getAuditGpuDeviceState(f.device).snapshot().resources.texture.destroyed, resources.created);
});

test('a synchronous queue failure still releases retired targets', () => {
  const f = fixture(), context = f.context(), target = f.renderer.getEffectTarget('effect', context, 1);
  f.device.queue.onSubmittedWorkDone = () => {throw Error('device lost');};
  context.submit(); f.renderer.destroyEffectTarget(target);
  assert.equal(f.live(), 0);
});
