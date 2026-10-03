import test from 'node:test';
import assert from 'node:assert/strict';
import { Entity, Render3DSystem, PostProcessRenderer, GrayscalePass, GaussianBlurPass, OutlinePass, TaaPass, MotionBlurPass } from '../dist/experimental.js';
import { GtaoPass } from '../dist/postprocess.js';
import { createAuditGpuDevice, getAuditGpuDeviceState } from '../../scripts/benchmark/real-renderer-audit-device.mjs';

function setup(t) {
  const device = createAuditGpuDevice(), engine = { device, width: 64, height: 64, format: 'rgba16float', msaaSamples: 1 };
  const renderer = new PostProcessRenderer(); renderer.prepare(engine);
  t.after(() => renderer.destroy());
  return { device, engine, renderer, graph: renderer._graph };
}

test('AO occlusion discards unused color producers and recomputes reachability after mode changes', t => {
  const { graph } = setup(t);
  const gray = new GrayscalePass(), blur = new GaussianBlurPass(), ao = new GtaoPass({ displayMode: 'occlusion' });
  assert.deepEqual(graph.compile([gray, blur, ao]), [ao]);
  assert.equal(graph.stats.culledPassCount, 2);
  assert.ok(graph.resourceLifetimes.some(r => r.name === 'linear-depth'));
  assert.ok(graph.resourceLifetimes.some(r => r.name === 'view-normal'));
  ao.displayMode = 'composite';
  assert.deepEqual(graph.compile([gray, blur, ao]), [gray, blur, ao]);
  assert.equal(graph.stats.culledPassCount, 0);
});

test('TAA histories, AO progression and custom subclass side effects survive dead color outputs', t => {
  const { graph } = setup(t);
  class Custom extends GrayscalePass {}
  const gray = new GrayscalePass(), taa = new TaaPass(), custom = new Custom(), motion = new MotionBlurPass();
  const firstAo = new GtaoPass(), lastAo = new GtaoPass({ displayMode: 'occlusion' });
  assert.deepEqual(graph.compile([gray, taa, custom, motion, firstAo, lastAo]), [gray, taa, custom, motion, firstAo, lastAo]);
  assert.equal(graph.stats.culledPassCount, 0);
});

test('culled passes are neither prepared nor recorded; live pass count controls ping-pong allocation', t => {
  const { renderer, device } = setup(t), calls = [];
  const gray = new GrayscalePass(), blur = new GaussianBlurPass(), ao = new GtaoPass({ displayMode: 'occlusion' });
  for (const pass of [gray, blur, ao]) {
    pass.prepare = () => calls.push(`prepare:${pass.label}`);
    pass.apply = (_encoder, src, dst) => { assert.ok(src); assert.ok(dst); calls.push(`apply:${pass.label}`); };
    pass.destroy = () => calls.push(`destroy:${pass.label}`);
  }
  renderer.run(device.createCommandEncoder(), [gray, blur, ao], { label: 'output' });
  assert.deepEqual(calls, ['prepare:GTAO', 'apply:GTAO']);
  assert.equal(getAuditGpuDeviceState(device).calls.filter(c => c.method === 'device.createTexture').length, 1, 'no ping-pong allocation for a sole live pass');
  ao.displayMode = 'composite';
  renderer.run(device.createCommandEncoder(), [gray, blur, ao], { label: 'output' });
  assert.ok(calls.includes('apply:Grayscale'));
  ao.displayMode = 'occlusion'; calls.length = 0;
  renderer.run(device.createCommandEncoder(), [gray, blur, ao], { label: 'output' });
  assert.deepEqual(calls, ['destroy:Grayscale', 'destroy:GaussianBlur', 'apply:GTAO']);
});

test('unused outline effect no longer requests mask surfaces but custom effects keep them', t => {
  const { engine } = setup(t);
  const system = new Render3DSystem(engine, new Entity('camera'), { registerDefaultMaterialRenderers: false });
  t.after(() => system.destroy());
  const ao = new GtaoPass({ displayMode: 'occlusion' });
  const requirements = system._postScenePasses.getRequirements([new OutlinePass(), ao]);
  assert.equal(requirements.needsOutlineMask, false);
  assert.equal(requirements.needsDepth, true);
  class Custom extends OutlinePass {}
  assert.equal(system._postScenePasses.getRequirements([new Custom(), ao]).needsOutlineMask, true);
});

test('postprocess cache rebinds replacement instances and invalidates AO modes and auxiliary requirements', t => {
  const { graph } = setup(t);
  const first = new GrayscalePass(), replacement = new GrayscalePass();
  assert.deepEqual(graph.compile([first]), [first]);
  assert.deepEqual(graph.compile([replacement]), [replacement]);
  assert.equal(graph.cache.stats.hits, 1);
  assert.equal(graph.snapshot[0].payload, replacement);
  const ao = new GtaoPass({ displayMode: 'occlusion' });
  assert.deepEqual(graph.compile([replacement, ao]), [ao]);
  ao.displayMode = 'composite'; assert.deepEqual(graph.compile([replacement, ao]), [replacement, ao]);
  ao.displayMode = 'occlusion'; assert.deepEqual(graph.compile([replacement, ao]), [ao]);
  assert.equal(graph.cache.stats.hits, 2);
  graph.clearCache(); assert.equal(graph.cache.stats.size, 0); assert.equal(graph.snapshot.length, 0);
});
