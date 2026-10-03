import test from 'node:test';
import assert from 'node:assert/strict';
import { importEngineSource } from './helpers/internal-source.mjs';
const { Render3DFramePlan } = await importEngineSource('systems/Render3DFramePlan.ts');
const { FrameGraphPlanCache } = await importEngineSource('core/FrameGraphPlanCache.ts');
const { frameGraphCacheScope } = await importEngineSource('core/frameGraphCacheScope.ts');
const { depthAttachmentOperations } = await importEngineSource('rtt/AttachmentOperations.ts');

function declare(plan, callback, observed = 'output') {
  return plan.clear().importResources('camera').exportResources(observed)
    .add('output', 'render', callback, { reads: ['color'], writes: ['output'] })
    .add('scene', 'render', () => {}, { reads: ['camera'], writes: ['color'] })
    .add('unused', 'prepare', () => { throw Error('dead branch'); }, { writes: ['unused'] });
}

test('cached topology matches uncached ordering/lifetimes and binds current callbacks after every clear', () => {
  const plan = new Render3DFramePlan(), executed = [];
  declare(plan, () => executed.push('old')).execute();
  const expected = structuredClone({ snapshot: plan.snapshot, stats: plan.stats, lifetimes: plan.resourceLifetimes });
  declare(plan, () => executed.push('current')).execute();
  assert.equal(plan.cache.stats.hits, 1);
  assert.deepEqual(executed, ['old', 'current']);
  assert.deepEqual({ snapshot: plan.snapshot, stats: plan.stats, lifetimes: plan.resourceLifetimes }, expected);
  assert.throws(() => { plan.resourceLifetimes[0].lastUse = 999; }, TypeError);
  plan.cache.enabled = false;
  declare(plan, () => executed.push('uncached')).execute();
  assert.deepEqual({ snapshot: plan.snapshot, stats: plan.stats, lifetimes: plan.resourceLifetimes }, expected);
  assert.deepEqual(executed, ['old', 'current', 'uncached']);
});

test('observers, access changes and invalid plans never bypass validation through a prior cache entry', () => {
  const plan = new Render3DFramePlan(); let runs = 0;
  declare(plan, () => runs++).execute();
  assert.throws(() => declare(plan, () => runs++, 'missing').execute(), /no producer/);
  declare(plan, () => runs++).add('invalid', 'render', () => {}, { reads: ['missing'] });
  assert.throws(() => plan.execute(), /without a producer/);
  declare(plan, () => runs++).add('duplicate', 'render', () => {}, { writes: ['color'] });
  assert.throws(() => plan.execute(), /more than one writer/);
  assert.equal(runs, 1);
  declare(plan, () => runs++).exportResources('unused');
  assert.throws(() => plan.execute(), /dead branch/);
  assert.equal(plan.stats.culledPassCount, 0);
});

test('scope and device fences, bounded LRU and explicit reset do not retain unbounded configurations', () => {
  const plan = new Render3DFramePlan(), device = {}, otherDevice = {};
  for (let i = 0; i < 300; i++) {
    plan.setCacheScope(device, `size:${i}`); declare(plan, () => {}).execute();
  }
  assert.equal(plan.cache.stats.size, 16); assert.equal(plan.cache.stats.evictions, 284);
  const hits = plan.cache.stats.hits;
  plan.setCacheScope(device, 'size:299'); declare(plan, () => {}).execute(); assert.equal(plan.cache.stats.hits, hits + 1);
  plan.setCacheScope(otherDevice, 'size:299'); declare(plan, () => {}).execute(); assert.equal(plan.cache.stats.hits, hits + 1);
  assert.equal(plan.cache.stats.size, 1);
  plan.clear().clearCache(); assert.equal(plan.cache.stats.size, 0);
  const cache = new FrameGraphPlanCache(2); cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3);
  assert.equal(cache.get('b'), undefined); assert.equal(cache.get('a'), 1);
});

test('executing plans reject mutation and reentry before corrupting current callbacks; recover after exceptions', () => {
  const plan = new Render3DFramePlan();
  declare(plan, () => {
    for (const action of [() => plan.clear(), () => plan.execute(), () => plan.add('nested', 'render', () => {}),
      () => plan.importResources('nested'), () => plan.exportResources('nested'), () => plan.clearCache(), () => plan.setCacheScope({}, '')])
      assert.throws(action, /reenter/);
  }).execute();
  assert.throws(() => declare(plan, () => { throw Error('caller'); }).execute(), /caller/);
  let ran = false; declare(plan, () => { ran = true; }).execute(); assert.ok(ran);
});

test('view scope fences resize/DPR, format, target, sample count, reverse depth, viewport and family', () => {
  const target = { width: 64, height: 64, format: 'rgba16float' };
  const view = { key: 'a', target, width: 64, height: 64, displayWidth: 64, displayHeight: 64, sampleCount: 1, reverseZ: false, loadOp: 'clear', postProcessEnabled: true };
  const base = frameGraphCacheScope({ view });
  for (const change of [{ width: 32 }, { displayWidth: 32 }, { sampleCount: 4 }, { reverseZ: true }, { loadOp: 'load' }, { postProcessEnabled: false }, { viewport: { x: 1, width: 32 } }, { scissor: { x: 3 } }, { target: { ...target } }])
    assert.notEqual(frameGraphCacheScope({ view: { ...view, ...change } }), base);
  target.format = 'rgba8unorm'; assert.notEqual(frameGraphCacheScope({ view }), base); target.format = 'rgba16float';
  assert.notEqual(frameGraphCacheScope({ view, viewFamily: { views: [view] } }), base);
  assert.equal(frameGraphCacheScope({ view, frameData: { frameId: 99 }, encoder: {} }), base, 'dynamic frame/encoder must be rebound, not keyed');
});

test('attachment policy preserves loaded depth and only discards proven unobserved writes', () => {
  assert.deepEqual(depthAttachmentOperations({ loadOp: 'load', writesDepth: false, retained: true }), { depthReadOnly: true });
  assert.deepEqual(depthAttachmentOperations({ loadOp: 'load', writesDepth: true, retained: true }), { depthLoadOp: 'load', depthStoreOp: 'store' });
  assert.deepEqual(depthAttachmentOperations({ loadOp: 'clear', clearValue: 0, writesDepth: true, retained: false }), { depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 0 });
  assert.deepEqual(depthAttachmentOperations({ loadOp: 'clear', clearValue: 1, writesDepth: false, retained: true }), { depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 }, 'clear itself writes depth');
  assert.deepEqual(depthAttachmentOperations({ loadOp: 'load', writesDepth: false, retained: true }, false), { depthLoadOp: 'load', depthStoreOp: 'store' });
});

test('Outline resizing keeps recorded textures and size-specific uniforms alive until submitted completion', async () => {
  const { createAuditGpuDevice } = await import('../../scripts/benchmark/real-renderer-audit-device.mjs');
  const { OutlinePass } = await importEngineSource('postprocess/OutlinePass.ts');
  const { setPostProcessSubmission } = await importEngineSource('postprocess/PostProcessSubmission.ts');
  const device = createAuditGpuDevice(), pass = new OutlinePass(), callbacks = [];
  pass.prepare(device, 'rgba16float', 64, 64);
  const original = [pass._edgeTex, pass._blurTex, pass._glowTex, pass._blurHParamsBuf, pass._blurVParamsBuf];
  setPostProcessSubmission(pass, callback => callbacks.push(callback));
  pass.resize(device, 'rgba16float', 48, 40);
  assert.ok(original.every(resource => !resource.destroyed));
  assert.notEqual(pass._blurHParamsBuf, original[3]);
  const current = pass._edgeTex; pass.destroy(); assert.ok(!current.destroyed);
  let finish; const completed = new Promise(resolve => { finish = resolve; });
  callbacks.forEach(callback => callback({ onSubmittedWorkDone: () => completed }));
  assert.ok(original.every(resource => !resource.destroyed));
  finish(); await completed; await Promise.resolve();
  assert.ok(original.every(resource => resource.destroyed)); assert.ok(current.destroyed);
  setPostProcessSubmission(pass);
});


test('cache hits preserve the reason for the last invalidation', () => {
  const plan = new Render3DFramePlan();
  plan.setCacheScope({}, 'main'); declare(plan, () => {}).execute();
  declare(plan, () => {}).execute();
  assert.equal(plan.cache.stats.lastReason, 'hit');
  assert.equal(plan.cache.stats.lastInvalidationReason, 'device-generation');
});
