import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameDiagnostics,
  GPUResourceTracker,
  RenderPipeline,
  World,
  registerEngineDiagnostics,
} from '../dist/experimental.js';
import { createMockEngine } from './helpers.mjs';

function attachFrameDiagnostics(engine, enabled = true) {
  const frameDiagnostics = new FrameDiagnostics({ enabled });
  registerEngineDiagnostics(engine, {
    frameDiagnostics,
    resourceTracker: new GPUResourceTracker({ debug: enabled, frameDiagnostics }),
  });
  return frameDiagnostics;
}

test('GPUResourceTracker debug snapshot traces ids, owners, frames, peaks, deltas, stacks, and caches', () => {
  const tracker = new GPUResourceTracker({ debug: true, captureStacks: true });
  const scope = tracker.createScope('system', 'stage7-system');
  tracker.beginFrame(7);
  const buffer = scope.trackBuffer({ destroy() {} }, 'vertices', 256);
  scope.trackSampler({}, 'linear');
  scope.trackBindGroup({}, 'material');
  scope.trackRenderPipeline({}, 'opaque');
  tracker.recordCacheAccess('pipeline-cache', false, { owner: scope.owner, entries: 1 });
  tracker.recordCacheAccess('pipeline-cache', true, { owner: scope.owner, entries: 1 });
  tracker.beginFrame(8);
  tracker.markUsed(buffer);

  const snapshot = tracker.getDebugSnapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.resources.length, 4);
  assert.equal(new Set(snapshot.resources.map(record => record.id)).size, 4);
  assert.equal(snapshot.resources.every(record => record.owner === scope.owner), true);
  assert.equal(snapshot.resources.find(record => record.label === 'vertices').createdAtFrame, 7);
  assert.equal(snapshot.resources.find(record => record.label === 'vertices').lastUsedFrame, 8);
  assert.match(snapshot.resources[0].creationStack, /observability-stage7/);
  assert.deepEqual(snapshot.byType.buffer, {
    current: 1,
    created: 1,
    destroyed: 0,
    peak: 1,
    estimatedBytes: 256,
    peakEstimatedBytes: 256,
    frameCreated: 0,
    frameDestroyed: 0,
  });
  assert.equal(snapshot.caches[0].hitRate, 0.5);

  scope.release();
  const released = tracker.getDebugSnapshot();
  assert.equal(released.resources.length, 0);
  assert.equal(released.releasedOwnerResiduals, 0);
  assert.equal(released.byType['render-pipeline'].destroyed, 1);
});

test('GPUResourceTracker keeps production diagnostic payload empty when debug is disabled', () => {
  const tracker = new GPUResourceTracker();
  tracker.trackBuffer({ destroy() {} }, 'production', 4);
  const snapshot = tracker.getDebugSnapshot();
  assert.equal(snapshot.enabled, false);
  assert.deepEqual(snapshot.resources, []);
  assert.deepEqual(snapshot.caches, []);
});

test('instrumented GPUDevice covers allocation, upload, draw, dispatch, and pipeline switch entry points', () => {
  const diagnostics = new FrameDiagnostics({ enabled: true });
  diagnostics.beginFrame(1);
  const tracker = new GPUResourceTracker({ debug: true, frameDiagnostics: diagnostics });
  const resource = () => ({});
  const renderPass = { draw() {}, drawIndexed() {}, drawIndirect() {}, drawIndexedIndirect() {}, setPipeline() {}, end() {} };
  const computePass = { dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {}, setPipeline() {}, end() {} };
  const device = {
    queue: { writeBuffer() {}, submit() {} },
    createBuffer: () => ({ destroy() {} }),
    createTexture: () => ({ destroy() {} }),
    createQuerySet: () => ({ destroy() {} }),
    createSampler: resource,
    createBindGroup: resource,
    createBindGroupLayout: resource,
    createPipelineLayout: resource,
    createRenderPipeline: resource,
    createComputePipeline: resource,
    createRenderPipelineAsync: async () => resource(),
    createComputePipelineAsync: async () => resource(),
    createCommandEncoder: () => ({ beginRenderPass: () => renderPass, beginComputePass: () => computePass }),
  };
  const owner = tracker.createScope('engine', 'instrumented').owner;
  tracker.instrumentDevice(device, owner);
  device.createBuffer({ size: 32, usage: 0, label: 'buffer' });
  device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 0, label: 'texture' });
  device.createSampler({ label: 'sampler' });
  device.createBindGroup({ label: 'group', layout: {}, entries: [] });
  device.createBindGroupLayout({ label: 'group-layout', entries: [] });
  device.createPipelineLayout({ label: 'pipeline-layout', bindGroupLayouts: [] });
  device.createRenderPipeline({ label: 'render', layout: 'auto', vertex: { module: {} } });
  device.createComputePipeline({ label: 'compute', layout: 'auto', compute: { module: {} } });
  device.createQuerySet({ label: 'queries', type: 'timestamp', count: 2 });
  device.queue.writeBuffer({}, 0, new Uint8Array(64));
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [] });
  pass.setPipeline({}); pass.draw(3);
  const compute = encoder.beginComputePass();
  compute.setPipeline({}); compute.dispatchWorkgroups(1);

  const types = new Set(tracker.getDebugSnapshot().resources.map(record => record.type));
  for (const type of ['buffer', 'texture', 'sampler', 'bind-group', 'bind-group-layout', 'pipeline-layout', 'render-pipeline', 'compute-pipeline', 'query-set']) {
    assert.equal(types.has(type), true, `missing ${type}`);
  }
  const counters = diagnostics.snapshot().counters;
  assert.equal(counters.bufferUploads, 1);
  assert.equal(counters.bufferUploadBytes, 64);
  assert.equal(counters.draws, 1);
  assert.equal(counters.dispatches, 1);
  assert.equal(counters.pipelineSwitches, 2);
});

test('FrameDiagnostics measures unified stages and counters with a zero-cost disabled path', () => {
  let now = 10;
  const diagnostics = new FrameDiagnostics({ enabled: true, now: () => now });
  diagnostics.beginFrame(4);
  const result = diagnostics.measure('collect', () => { now += 2.5; return 42; });
  diagnostics.increment('draws', 3);
  diagnostics.increment('bufferUploadBytes', 1024);
  diagnostics.setGpuDuration(1.25);
  const snapshot = diagnostics.snapshot();
  assert.equal(result, 42);
  assert.equal(snapshot.frame, 4);
  assert.equal(snapshot.cpuMs.collect, 2.5);
  assert.equal(snapshot.counters.draws, 3);
  assert.equal(snapshot.counters.bufferUploadBytes, 1024);
  assert.equal(snapshot.gpuMs, 1.25);

  let ran = false;
  const disabled = new FrameDiagnostics();
  assert.equal(disabled.measure('update', () => { ran = true; return 'ok'; }), 'ok');
  assert.equal(ran, true);
  assert.equal(disabled.snapshot().enabled, false);
});

test('RenderPipeline debug snapshot explains merged passes, compute boundaries, and stable entry intent', () => {
  const engine = createMockEngine();
  const frameDiagnostics = attachFrameDiagnostics(engine);
  frameDiagnostics.beginFrame(1);
  const pipeline = new RenderPipeline(engine);
  const world = new World('debug-pipeline');
  const first = { label: 'first', record() {} };
  const second = { label: 'second', record() {} };
  const compute = { label: 'compute', record() {} };
  pipeline
    .add(first, { pass: 'shared', loadOp: 'clear', sort: 2 })
    .add(second, { pass: 'shared', loadOp: 'clear', sort: 3 })
    .add(compute, { passType: 'compute', sort: 4 });
  pipeline.execute(world);

  const snapshot = pipeline.getDebugSnapshot();
  assert.equal(snapshot.entries.length, 3);
  assert.equal(snapshot.entries[0].system, 'first');
  assert.equal(snapshot.entries[0].loadStore.load, 'clear');
  assert.equal(snapshot.passCount, 2);
  assert.deepEqual(snapshot.passes.map(pass => [pass.type, pass.entries.length]), [['render', 2], ['compute', 1]]);
  assert.deepEqual(snapshot.issues, []);
  assert.equal(frameDiagnostics.snapshot().counters.passes, 2);
});

test('RenderPipeline derives its target from RenderView and detects shared-pass misuse', () => {
  const engine = createMockEngine();
  const frameDiagnostics = attachFrameDiagnostics(engine);
  frameDiagnostics.beginFrame(1);
  const pipeline = new RenderPipeline(engine);
  const world = new World('invalid-pipeline');
  pipeline
    .add({ label: 'ends-pass', record(_world, context) { context.endPass(); } }, {
      pass: 'shared',
      loadOp: 'clear',
    })
    .add({ label: 'conflict', record() {} }, {
      pass: 'shared',
      loadOp: 'load',
    });
  pipeline.execute(world);
  const codes = pipeline.getDebugSnapshot().issues.map(issue => issue.code);
  assert.equal(codes.includes('shared-pass-state-ended'), true);
  assert.equal(codes.includes('shared-pass-attachment-conflict'), false, 'ending the prior pass explains the split');

  const conflictEngine = createMockEngine();
  const conflictDiagnostics = attachFrameDiagnostics(conflictEngine);
  conflictDiagnostics.beginFrame(1);
  const conflicts = new RenderPipeline(conflictEngine);
  conflicts
    .add({ record() {} }, { pass: 'shared', loadOp: 'clear' })
    .add({ record() {} }, { pass: 'shared', loadOp: 'load' });
  conflicts.execute(world);
  assert.equal(conflicts.getDebugSnapshot().issues.some(issue => issue.code === 'shared-pass-attachment-conflict'), true);
});

test('RenderPipeline compatibility and diagnostics use actual attachment identity and sample count', () => {
  const log = [];
  const engine = createMockEngine(log);
  const frameDiagnostics = attachFrameDiagnostics(engine);
  frameDiagnostics.beginFrame(1);
  let outputView = { id: 'first-output' };
  let descriptorVersion = 1;
  engine.getRenderPassDescriptorVersion = () => descriptorVersion;
  engine.getRenderPassDescriptor = () => ({
    colorAttachments: [{ view: outputView, loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: {
      view: engine.depthTextureView,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
  });
  const pipeline = new RenderPipeline(engine);
  pipeline
    .add({ label: 'replace-target', record() {
      outputView = { id: 'second-output' };
      descriptorVersion++;
    } }, { pass: 'shared', loadOp: 'clear' })
    .add({ label: 'new-target', record() {
      engine.msaaSamples = 4;
    } }, { pass: 'shared', loadOp: 'clear' })
    .add({ label: 'new-sample-count', record() {} }, { pass: 'shared', loadOp: 'clear' });

  pipeline.execute(new World('ActualTargetIdentityWorld'));

  const snapshot = pipeline.getDebugSnapshot();
  assert.equal(log.filter(entry => entry[0] === 'beginRenderPass').length, 3);
  assert.equal(snapshot.passCount, 3);
  assert.equal(snapshot.issues.length, 2);
  assert.match(snapshot.issues[0].message, /target attachment identity/);
  assert.match(snapshot.issues[1].message, /sample count/);
});

test('RenderPipeline pass history records isolated and compute interruption decisions', () => {
  const engine = createMockEngine();
  const frameDiagnostics = attachFrameDiagnostics(engine);
  frameDiagnostics.beginFrame(1);
  const pipeline = new RenderPipeline(engine);
  pipeline
    .add({ record() {} }, { pass: 'shared', loadOp: 'clear' })
    .add({ record() {} }, { passType: 'compute' })
    .add({ record() {} }, { pass: 'isolated', loadOp: 'load' });

  pipeline.execute(new World('PassDecisionHistoryWorld'));

  assert.deepEqual(pipeline.getDebugSnapshot().passes.map(pass => [pass.type, pass.shared]), [
    ['render', true],
    ['compute', false],
    ['render', false],
  ]);
});

test('RenderPipeline skips per-frame pass and issue collection when diagnostics are disabled', () => {
  const engine = createMockEngine();
  const frameDiagnostics = attachFrameDiagnostics(engine, false);
  const pipeline = new RenderPipeline(engine);
  const world = new World('production-pipeline');
  pipeline
    .add({ record() {} }, { pass: 'shared', loadOp: 'clear' })
    .add({ record() {} }, { pass: 'shared', loadOp: 'load' })
    .add({ record() {} }, { passType: 'compute' });

  pipeline.execute(world);

  const snapshot = pipeline.getDebugSnapshot();
  assert.equal(snapshot.execution, 1);
  assert.equal(snapshot.entries.length, 3);
  assert.equal(snapshot.passCount, 0);
  assert.deepEqual(snapshot.passes, []);
  assert.deepEqual(snapshot.issues, []);
  assert.equal(frameDiagnostics.snapshot().counters.passes, 0);
});

test('RenderPipeline drops prior decision traces without collecting replacements when diagnostics turn off', () => {
  const engine = createMockEngine();
  const frameDiagnostics = attachFrameDiagnostics(engine, true);
  const pipeline = new RenderPipeline(engine)
    .add({ record() {} }, { pass: 'shared', loadOp: 'clear' })
    .add({ record() {} }, { pass: 'shared', loadOp: 'load' });
  const world = new World('disabled-trace-reset');
  pipeline.execute(world);
  assert.equal(pipeline.getDebugSnapshot().passCount, 2);

  frameDiagnostics.enabled = false;
  pipeline.execute(world);
  assert.equal(pipeline.getDebugSnapshot().passCount, 0);
  assert.deepEqual(pipeline.getDebugSnapshot().issues, []);
});
