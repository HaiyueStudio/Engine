import assert from 'node:assert/strict';
import test from 'node:test';
import { Entity, Render3DSystem, PostProcessRenderer, RenderView, RttTexture, TransientRenderTargetPool } from '../dist/experimental.js';
import { RttEngine } from '../dist/rtt.js';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';

function fixture(t, behaviors = {}) {
  const device = createAuditGpuDevice({ behaviors });
  const engine = { device, width: 16, height: 16, format: 'bgra8unorm', defaults: {}, getDepthFormat: () => 'depth24plus' };
  const system = new Render3DSystem(engine, new Entity('camera'), { registerDefaultMaterialRenderers: false });
  t.after(() => system.destroy());
  const output = system._postScenePasses.output;
  output.prepare(device);
  t.after(() => output.destroy());
  const texture = device.createTexture({ size: [16, 16], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  t.after(() => texture.destroy());
  return { device, engine, system, output, texture };
}

test('scene output validates exposure and keeps transfer settings independent for each destination', t => {
  const { output, device, texture } = fixture(t);
  for (const value of [-1, NaN, Infinity]) assert.throws(() => output.configure('bgra8unorm', value, 'reinhard'), RangeError);
  assert.throws(() => output.configure('bgra8unorm', 1, 'aces'), RangeError);
  for (const [key, format, exposure, tone, transfer] of [
    ['display', 'bgra8unorm', .5, 'reinhard', 1], ['capture', 'rgba16float', 2, 'none', 0], ['srgb', 'rgba8unorm-srgb', 1, 'reinhard', 2],
  ]) {
    output.configure(format, exposure, tone);
    output.setSceneTextures({ frame: { frameId: 0, viewKey: key } });
    output.apply(device.createCommandEncoder(), texture, {}, device);
    assert.deepEqual([...output._bindings.get(key).values], [exposure, tone === 'reinhard' ? 1 : 0, transfer, 0]);
  }
  assert.equal(new Set([...output._bindings.values()].map(value => value.uniform)).size, 3);
});

test('unchanged scene output reuses uniforms, bind groups and pipelines across frames', t => {
  let writes = 0;
  const { output, device, texture } = fixture(t, { 'queue.writeBuffer': () => { writes++; } });
  output.configure('bgra8unorm', 1, 'reinhard');
  for (let id = 0; id < 3; id++) {
    output.setSceneTextures({ frame: { frameId: id, viewKey: 'stable' } });
    output.apply(device.createCommandEncoder(), texture, {}, device);
  }
  assert.equal(writes, 1);
  assert.equal(output._bindings.size, 1);
  assert.equal(output._pipelines.size, 1);
});

test('expired output uniforms remain alive until the encoding submission completes', async t => {
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const { output, engine, device, texture } = fixture(t, { 'queue.onSubmittedWorkDone': () => completion });
  const renderer = new PostProcessRenderer(); renderer.prepare(engine);
  t.after(() => renderer.destroy());
  const callbacks = [];
  let retired;
  for (const [frameId, viewKey] of [[0, 'old'], [121, 'current']]) {
    renderer.beginFrame(frameId, callback => callbacks.push(callback));
    renderer.run(device.createCommandEncoder(), [output], texture.createView(), { frame: { frameId, viewKey } });
    if (frameId === 0) retired = output._bindings.get('old').uniform;
  }
  assert.equal(output._bindings.has('old'), false);
  assert.equal(retired.destroyed, false);
  for (const callback of callbacks) callback(device.queue);
  assert.equal(retired.destroyed, false);
  complete(); await completion; await Promise.resolve();
  assert.equal(retired.destroyed, true);
});

test('scene output resolves into the display MSAA attachment and keeps its samples for later UI loads', t => {
  const { output, engine, device, texture } = fixture(t);
  const target = new RttEngine(engine, 16, 16); t.after(() => target.destroy());
  const view = new RenderView({ target, sampleCount: 4, loadOp: 'load' }).snapshot();
  output.configure(target.format, 1, 'reinhard', view);
  output.setSceneTextures({ frame: { frameId: 0, viewKey: view.key } });
  const destination = target.getOutputView();
  let descriptor;
  const encoder = device.createCommandEncoder();
  const begin = encoder.beginRenderPass.bind(encoder);
  encoder.beginRenderPass = value => { descriptor = value; return begin(value); };
  output.apply(encoder, texture, destination, device);
  const attachment = descriptor.colorAttachments[0];
  assert.notEqual(attachment.view, destination);
  assert.equal(attachment.resolveTarget, destination);
  assert.equal(attachment.storeOp, 'store');
  assert.equal(attachment.loadOp, 'load');
  assert.equal([...output._pipelines.values()][0].descriptor.multisample.count, 4);
});

for (const sampleCount of [1, 4]) for (const reverseZ of [false, true]) {
  test(`HDR scene preserves target depth for particles (${sampleCount} samples, reverseZ=${reverseZ})`, t => {
    const { engine, device, system } = fixture(t);
    const target = new RttEngine(engine, 16, 16);
    t.after(() => target.destroy());
    const view = new RenderView({
      key: 'particles', target, camera: new Entity('camera'), sampleCount,
      depthConvention: reverseZ ? 'reverse' : 'standard',
    }).snapshot();
    const post = system._postScenePasses;
    post.prepare([], { device, encoder: device.createCommandEncoder(), view }, reverseZ);
    const sceneDescriptor = post.buildScenePassDescriptor('clear', reverseZ, view);
    const destination = target.getRenderPassDescriptor(view);
    assert.equal(sceneDescriptor.depthStencilAttachment.view, destination.depthStencilAttachment.view);
    assert.equal(sceneDescriptor.depthStencilAttachment.depthClearValue, reverseZ ? 0 : 1);
    assert.equal(sceneDescriptor.depthStencilAttachment.depthStoreOp, 'store');
    assert.equal(post._postRenderer.sceneDepthView, destination.depthStencilAttachment.view,
      'outline visibility and later overlays must read the same scene depth');

    const continuation = post.buildScenePassDescriptor('load', reverseZ, view);
    assert.equal(continuation.depthStencilAttachment.view, sceneDescriptor.depthStencilAttachment.view);
    assert.equal(continuation.depthStencilAttachment.depthLoadOp, 'load');
    post.destroy();
    assert.equal(destination.depthStencilAttachment.view.texture.destroyed, false,
      'the post renderer must not destroy borrowed target depth');
  });
}

test('viewport-local HDR depth remains local after a full-target view', t => {
  const { engine, device, system } = fixture(t);
  const target = new RttEngine(engine, 16, 16);
  t.after(() => target.destroy());
  const post = system._postScenePasses;
  const full = new RenderView({ key: 'full', target, camera: new Entity('camera') }).snapshot();
  post.prepare([], { device, encoder: device.createCommandEncoder(), view: full }, false);
  const borrowed = post.buildScenePassDescriptor('clear', false, full).depthStencilAttachment.view;
  const inset = new RenderView({
    key: 'inset', target, camera: full.camera,
    viewport: { x: 4, y: 4, width: 8, height: 8 },
  }).snapshot();
  post.prepare([], { device, encoder: device.createCommandEncoder(), view: inset }, false);
  const local = post.buildScenePassDescriptor('clear', false, inset).depthStencilAttachment.view;
  assert.notEqual(local, borrowed);
  assert.equal(local.texture.width, 8);
  assert.equal(local.texture.height, 8);
  assert.equal(post._postRenderer.sceneDepthView, local);
});

test('HDR RTT format survives resize and cannot alias an UNORM target with equal dimensions', t => {
  const { engine } = fixture(t);
  const rtt = new RttTexture(engine, { width: 16, height: 16, format: 'rgba16float' });
  t.after(() => rtt.destroy());
  rtt.resize(8, 8);
  assert.equal(rtt.textureSource.texture.format, 'rgba16float');
  assert.equal(rtt.engine.format, 'rgba16float');
  const pool = new TransientRenderTargetPool(engine); t.after(() => pool.destroy());
  const assigned = pool.assign(['bgra8unorm', 'rgba16float'].map((format, id) => ({
    id, scope: `output-${id}`, firstUse: id, lastUse: id, payload: null,
    descriptor: { width: 16, height: 16, sampleCount: 1, reverseZ: false, format },
  })));
  assert.notEqual(assigned[0].physicalId, assigned[1].physicalId);
  assert.equal(assigned[1].estimatedBytes - assigned[0].estimatedBytes, 16 * 16 * 4);
});
