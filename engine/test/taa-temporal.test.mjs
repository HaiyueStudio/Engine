import assert from 'node:assert/strict';
import test from 'node:test';
import { TaaPass, MotionBlurPass, PostProcessRenderer, Render3DSystem, Entity, Geometry3D } from '../dist/experimental.js';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const frame = (id, key = 'main', width = 16, height = 16) => ({
  frameId: id, viewKey: key, width, height, cameraId: 1, near: 0.1, far: 100, reverseZ: false, isOrthographic: true,
  projectionJitter: new Float32Array(2), projectionMatrix: identity(), viewProjectionMatrix: identity(), inverseViewProjectionMatrix: identity(),
});
function fixture(t, behaviors = {}) {
  const device = createAuditGpuDevice({ behaviors });
  const taa = new TaaPass();
  taa.prepare(device, 'rgba8unorm');
  t.after(() => taa.destroy());
  const texture = (format, f) => device.createTexture({ size: [f.width, f.height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  function inputs(f) { return { frame: f, depth: texture('r32float', f), motion: texture('rgba16float', f) }; }
  function apply(f, source = inputs(f), format = 'rgba8unorm') {
    taa.resize(device, format);
    taa.setSceneTextures(source);
    taa.apply(device.createCommandEncoder(), texture(format, f), texture(format, f).createView(), device);
    return taa._historyStore.histories.get(f.viewKey);
  }
  return { device, taa, texture, inputs, apply, validUniform: () => new Float32Array(taa._uniformWriter.buffer)[37] };
}

test('TAA requires temporal motion v2 and rejects missing or mismatched scene buffers', t => {
  const f = fixture(t);
  assert.equal(f.taa.needsMotionTexture, true);
  assert.equal(f.taa.needsDepthTexture, true);
  const context = frame(0);
  assert.throws(() => f.apply(context, { frame: context }), /requires linear depth, temporal motion/);
  assert.throws(() => f.apply(context, { ...f.inputs(context), motion: f.texture('rg16float', context) }), /temporal motion v2/);
  assert.throws(() => f.apply(context, { ...f.inputs(context), depth: f.texture('r32float', frame(0, 'main', 8, 8)) }), /dimensions/);
});

test('TAA keeps HDR color, precise depth, alpha and pipeline state independent for alternating views/formats', t => {
  const f = fixture(t);
  const a = f.apply(frame(0));
  const b = f.apply(frame(0, 'small', 8, 8), undefined, 'rgba16float');
  assert.notEqual(a.uniformBuffer, b.uniformBuffer);
  assert.deepEqual(a.colors.map(texture => texture.format), ['rgba16float', 'rgba16float']);
  assert.deepEqual(a.depths.map(texture => texture.format), ['r32float', 'r32float']);
  assert.equal(f.apply(frame(1)), a);
  assert.equal(f.validUniform(), 1);
  assert.equal(f.apply(frame(1, 'small', 8, 8), undefined, 'rgba16float'), b);
  assert.equal(f.validUniform(), 1);
  assert.equal(f.taa._pipelines.size, 2);
  for (const pipeline of f.taa._pipelines.values()) {
    assert.deepEqual(pipeline.descriptor.fragment.targets.slice(1).map(target => target.format), ['rgba16float', 'r32float']);
  }
});

test('TAA resets only the requested view and rejects discontinuities without treating jitter as a camera cut', t => {
  const f = fixture(t);
  f.apply(frame(0)); f.apply(frame(0, 'other'));
  const before = f.taa.getMotionHistoryRevision('other');
  f.taa.resetHistory('main');
  assert.notEqual(f.taa.getMotionHistoryRevision('main'), before);
  assert.equal(f.taa.getMotionHistoryRevision('other'), before);
  f.apply(frame(1)); assert.equal(f.validUniform(), 0);
  f.apply(frame(1, 'other')); assert.equal(f.validUniform(), 1);
  const jittered = frame(2);
  jittered.projectionJitter.set([0.25, -0.25]);
  jittered.projectionMatrix[12] = 0.5 / jittered.width;
  jittered.projectionMatrix[13] = 0.5 / jittered.height;
  f.apply(jittered); assert.equal(f.validUniform(), 1);
  f.apply(frame(4)); assert.equal(f.validUniform(), 0, 'frame gap');
  f.apply({ ...frame(5), cameraId: 2 }); assert.equal(f.validUniform(), 0, 'camera identity');
  const zoomed = { ...frame(6), cameraId: 2 };
  zoomed.projectionMatrix[0] = 2;
  f.apply(zoomed); assert.equal(f.validUniform(), 0, 'projection change');
  f.taa.resetHistory();
  assert.equal(f.taa.stats.validHistoryCount, 0);
  assert.equal(f.taa.getMotionHistoryRevision('main'), f.taa.getMotionHistoryRevision('other'));
});

test('TAA retains resized and removed histories until the encoding submission completes', async t => {
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const f = fixture(t, { 'queue.onSubmittedWorkDone': () => completion });
  const renderer = new PostProcessRenderer();
  renderer.prepare({ device: f.device, width: 16, height: 16, format: 'rgba8unorm' });
  t.after(() => renderer.destroy());
  const callbacks = [];
  renderer.beginFrame(0, callback => callbacks.push(callback));
  const encoder = f.device.createCommandEncoder();
  const render = context => renderer.run(encoder, [f.taa], f.texture('rgba8unorm', context).createView(), f.inputs(context));
  render(frame(0));
  const old = f.taa._historyStore.histories.get('main');
  renderer.resize(8, 8);
  render(frame(0, 'main', 8, 8));
  const next = f.taa._historyStore.histories.get('main');
  renderer.run(encoder, [], f.texture('rgba8unorm', frame(0, 'main', 8, 8)).createView());
  for (const history of [old, next]) assert.equal(history.colors[0].destroyed, false);
  for (const callback of callbacks) callback(f.device.queue);
  assert.equal(old.uniformBuffer.destroyed, false, 'queue completion is still pending');
  complete(); await completion; await Promise.resolve();
  for (const history of [old, next]) {
    assert.equal(history.uniformBuffer.destroyed, true);
    for (const texture of [...history.colors, ...history.depths]) assert.equal(texture.destroyed, true);
  }
});

test('motion history packs depth, validity and jitter cancellation per view without resetting from jitter alone', t => {
  const f = fixture(t);
  const system = new Render3DSystem({ device: f.device, defaults: {}, width: 16, height: 16, format: 'rgba8unorm', getDepthFormat: () => 'depth24plus' }, new Entity('camera'), { registerDefaultMaterialRenderers: false });
  t.after(() => system.destroy());
  const motion = system._postScenePasses._requireMotionVectorRenderer();
  const geometry = new Geometry3D({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
  const pass = f.device.createCommandEncoder().beginRenderPass({ colorAttachments: [] });
  t.after(() => pass.end());
  const render = (id, jitter, key = 'main') => {
    const data = new Float32Array(68); data.set(identity()); data.set([16, 16, 1 / 16, 1 / 16], 52);
    const options = { ...frame(id, key), historyRevision: 0, projectionJitter: jitter };
    motion.beginView({ data, frameId: id, phaseRevision: id, cameraEntityId: 1 }, options, {});
    motion.render(pass, 9, geometry, identity());
    motion.endView(options);
    return motion._views.get(key).entities.get(9);
  };
  assert.equal(render(0, [0, 0]).uniformData[58], 0);
  const entity = render(1, [0.25, -0.25]);
  assert.equal(entity.buffer.size, 272);
  assert.equal(entity.uniformData[58], 1);
  assert.deepEqual([...entity.uniformData.slice(64, 66)], [0.25 / 16, -0.25 / 16]);
  assert.equal(render(1, [0, 0], 'other').uniformData[58], 0);
  assert.equal(render(3, [0, 0]).uniformData[58], 0);
});

test('Motion Blur and TAA keep different view sizes in separate uniform buffers and reuse stable scratch textures', async t => {
  const f = fixture(t);
  const blur = new MotionBlurPass({ reconstruction: 'tile-neighbor-max' });
  const renderer = new PostProcessRenderer();
  renderer.prepare({ device: f.device, width: 16, height: 16, format: 'rgba8unorm' });
  t.after(() => renderer.destroy());
  const callbacks = [];
  for (let id = 0; id < 2; id++) {
    renderer.beginFrame(id, callback => callbacks.push(callback));
    for (const context of [frame(id), frame(id, 'small', 8, 8)]) {
      renderer.resize(context.width, context.height);
      renderer.run(f.device.createCommandEncoder(), [blur, f.taa], f.texture('rgba8unorm', context).createView(), f.inputs(context));
    }
    const resources = [...blur._sizedResources.values()];
    assert.equal(resources.length, 2);
    assert.notEqual(resources[0].uniform, resources[1].uniform);
    assert.notEqual(resources[0].tileParams, resources[1].tileParams);
    const tiles = resources.map(resource => resource.tile);
    for (const callback of callbacks.splice(0)) callback(f.device.queue);
    await Promise.resolve();
    for (const texture of tiles) assert.equal(texture.destroyed, false);
  }
});
