import test from 'node:test';
import assert from 'node:assert/strict';
import { importEngineSource } from './helpers/internal-source.mjs';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const { createFrameGraphCaptureInspector, beginFrameGraphCapture, frameGraphCaptureActive } = await importEngineSource('core/FrameGraphCapture.ts');
const { Render3DFramePlan } = await importEngineSource('systems/Render3DFramePlan.ts');
const { TransientTextureAllocator } = await importEngineSource('rtt/TransientTextureAllocator.ts');
function setup() {
  const owner = {}, device = createAuditGpuDevice(), callbacks = [];
  const context = { device, encoder: device.createCommandEncoder(), frameData: { frameId: 7 }, view: { key: 'main' }, afterSubmit: cb => callbacks.push(cb) };
  return { owner, device, context, callbacks };
}

test('unarmed capture does not replace encoders or allocate snapshots; one-shot captures live and culled dependencies', () => {
  const { owner, context } = setup(), original = context.encoder;
  assert.equal(beginFrameGraphCapture(owner, context), undefined);
  const inspector = createFrameGraphCaptureInspector(owner);
  assert.throws(() => createFrameGraphCaptureInspector(owner), /already exists/);
  assert.equal(beginFrameGraphCapture(owner, context), undefined); assert.equal(inspector.snapshot(), null);
  inspector.requestCapture(); const capture = beginFrameGraphCapture(owner, context);
  const plan = new Render3DFramePlan();
  plan.exportResources('output').add('scene', 'render', () => {}, { writes: ['color'] })
    .add('output', 'postprocess', () => {}, { reads: ['color'], writes: ['output'] })
    .add('unused', 'prepare', () => {}, { reads: ['color'], writes: ['unused'] }).execute();
  capture.finish(); assert.equal(context.encoder, original); assert.equal(frameGraphCaptureActive(), false);
  const snapshot = inspector.snapshot();
  assert.equal(snapshot.plans[0].nodes[2].reason, 'unreachable-from-outputs-and-side-effects');
  assert.deepEqual(snapshot.plans[0].nodes[2].dependsOn, ['scene']);
  assert.equal(snapshot.overhead.extraPasses, 0); assert.equal(snapshot.overhead.retainedGpuBytes, 0);
  assert.throws(() => snapshot.plans[0].nodes[0].reads.push('changed'), TypeError);
  assert.equal(beginFrameGraphCapture(owner, context), undefined);
  inspector.clear(); assert.equal(inspector.snapshot(), null); inspector.dispose();
});

test('encoded work is distinct from graph nodes, includes dispatch/copy/resolve and marks bundle draws unknown', () => {
  const { owner, context, callbacks, device } = setup(); const inspector = createFrameGraphCaptureInspector(owner); inspector.requestCapture();
  const capture = beginFrameGraphCapture(owner, context), encoder = capture.context.encoder;
  const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), resolveTarget: texture.createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.draw(3); pass.drawIndexed(3); pass.executeBundles([]); pass.end();
  const compute = encoder.beginComputePass(); compute.dispatchWorkgroups(1); compute.end();
  encoder.copyTextureToTexture({ texture }, { texture }, [1, 1]); capture.finish();
  const before = inspector.snapshot(); assert.equal(before.status, 'recorded'); assert.equal(before.work.submissions, 0);
  callbacks.forEach(cb => cb(device.queue));
  const after = inspector.snapshot(); assert.equal(after.status, 'submitted'); assert.equal(before.status, 'recorded');
  assert.deepEqual(after.work, { renderPasses: 1, computePasses: 1, drawCalls: 2, dispatchCalls: 1, bundleExecutions: 1, bundledDraws: null, copies: 1, resolves: 1, submissions: 1 });
  assert.equal(after.plans.length, 0); inspector.dispose(); texture.destroy();
});

test('allocation capture is JSON-safe, describes aliases, and preserves encoder identity through submission retirement', async () => {
  const { owner, context, device, callbacks } = setup(), inspector = createFrameGraphCaptureInspector(owner);
  const pool = new TransientTextureAllocator(device); inspector.requestCapture(); const capture = beginFrameGraphCapture(owner, context);
  const descriptor = { size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT };
  const lease = pool.acquire([{ name: 'a', descriptor, firstUse: 0, lastUse: 0 }, { name: 'b', descriptor, firstUse: 1, lastUse: 1 }], capture.context);
  lease.release(); capture.finish(); pool.destroy();
  assert.equal(lease.assignments[0].texture.destroyed, false);
  const snapshot = inspector.snapshot(), batch = snapshot.allocations[0];
  assert.equal(batch.mappings[0].physicalId, batch.mappings[1].physicalId);
  assert.equal(batch.mappings[1].decision, 'non-overlapping-lifetime-alias');
  assert.ok(snapshot.pools[0].counters.pendingPeakBytes > 0);
  assert.ok(!JSON.stringify(snapshot).includes('GPUTexture'));
  callbacks.forEach(cb => cb(device.queue)); await device.queue.onSubmittedWorkDone(); await Promise.resolve();
  assert.equal(pool.stats.physicalBytes, 0, 'afterSubmit sees the same recording encoder identity'); inspector.dispose();
});

test('failed, cancelled and bounded captures recover without leaving an active observer', () => {
  const { owner, context } = setup(), inspector = createFrameGraphCaptureInspector(owner);
  inspector.requestCapture(); const capture = beginFrameGraphCapture(owner, context);
  const plan = new Render3DFramePlan(); for (let i = 0; i < 300; i++) plan.clear().execute();
  capture.finish(Error('record failed'));
  const snapshot = inspector.snapshot(); assert.equal(snapshot.status, 'failed'); assert.equal(snapshot.truncated, true); assert.equal(snapshot.plans.length, 256);
  inspector.requestCapture(); const cancelled = beginFrameGraphCapture(owner, context); inspector.clear(); cancelled.finish();
  assert.equal(inspector.snapshot(), null); assert.equal(frameGraphCaptureActive(), false);
  inspector.requestCapture(); inspector.dispose(); assert.equal(beginFrameGraphCapture(owner, context), undefined);
  assert.throws(() => inspector.requestCapture(), /disposed/);
});


test('nested unarmed systems do not leak their graph metadata into the selected system', () => {
  const { owner, context } = setup(), inspector = createFrameGraphCaptureInspector(owner);
  inspector.requestCapture(); const outer = beginFrameGraphCapture(owner, context);
  const inner = beginFrameGraphCapture({}, context);
  new Render3DFramePlan().execute(); inner.finish();
  new Render3DFramePlan().execute(); outer.finish();
  assert.equal(inspector.snapshot().plans.length, 1); inspector.dispose();
});


test('decorated contexts preserve existing GPU timing attribution', async () => {
  const { RenderFrameContext, configureRenderFrameContextGpuPassTiming, hasGpuPassTiming, setNextGpuPassTimingLabel } = await importEngineSource('core/RenderCommandContext.ts');
  const { owner, device } = setup(), inspector = createFrameGraphCaptureInspector(owner), labels = [];
  const options = { descriptor: { colorAttachments: [] } };
  configureRenderFrameContextGpuPassTiming(options, { setNextPass: label => labels.push(label) });
  const context = new RenderFrameContext({ device }, options);
  inspector.requestCapture(); const capture = beginFrameGraphCapture(owner, context);
  assert.equal(hasGpuPassTiming(capture.context), true);
  setNextGpuPassTimingLabel(capture.context, { name: 'captured-pass' });
  assert.deepEqual(labels, [{ name: 'captured-pass' }]); capture.finish(); inspector.dispose();
});
