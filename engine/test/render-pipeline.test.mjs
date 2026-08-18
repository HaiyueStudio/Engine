import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Camera3D,
  cloneRenderPassDescriptor,
  createRenderFrameContext,
  Entity,
  getSceneFrameUniformSnapshot,
  RenderIntegration,
  RenderPipeline,
  RenderView,
  RenderViewFamily,
  System,
  Transform3D,
  World,
} from '../dist/experimental.js';
import { createMockEngine } from './helpers.mjs';

function makeSystem(name, calls, extra = {}) {
  return {
    ...extra,
    record(world, context) {
      calls.push([name, context.passActive]);
    },
  };
}

test('RenderPipeline executes systems in sort order and submits owned context', () => {
  const log = [];
  const calls = [];
  const pipeline = new RenderPipeline(createMockEngine(log));
  const world = new World('PipelineWorld');

  pipeline
    .add(makeSystem('late', calls), { sort: 10 })
    .add(makeSystem('early', calls), { sort: -1 });

  const context = pipeline.execute(world, 0, 16, { label: 'unit' });

  assert.deepEqual(calls.map(call => call[0]), ['early', 'late']);
  assert.equal(context.submitted, true);
  assert.equal(log.some(entry => entry[0] === 'submit'), true);
});

test('RenderPipeline freezes RenderView state for the whole frame', () => {
  const engine = createMockEngine();
  const camera = new Entity('ViewCamera');
  const passOptions = [];
  const target = {
    key: 'target:unit',
    format: 'rgba8unorm',
    width: 320,
    height: 180,
    displayWidth: 320,
    displayHeight: 180,
    getOutputView() { return { type: 'view-output' }; },
    getRenderPassDescriptor(options) {
      passOptions.push(options);
      return {
        colorAttachments: [{
          view: this.getOutputView(),
          clearValue: options.clearColor,
          loadOp: 'clear',
          storeOp: 'store',
        }],
      };
    },
  };
  const view = new RenderView({
    camera,
    target,
    clearColor: { r: 0.1, g: 0.2, b: 0.3, a: 1 },
    depthConvention: 'reverse',
    sampleCount: 4,
  });
  const seen = [];
  const pipeline = new RenderPipeline(engine);
  pipeline.add({
    record(_world, context) {
      seen.push(context.view);
      view.reverseZ = false;
      view.sampleCount = 1;
      view.clearColor.r = 1;
    },
  }, { passType: 'compute' });
  pipeline.add({ record(_world, context) { seen.push(context.view); } }, { passType: 'compute' });

  const context = pipeline.execute(new World('ViewWorld'), 0, 16, { view });

  assert.equal(seen[0], seen[1]);
  assert.equal(context.view, seen[0]);
  assert.equal(Object.isFrozen(context.view), true);
  assert.equal(Object.isFrozen(context.view.clearColor), true);
  assert.equal(context.view.reverseZ, true);
  assert.equal(context.view.sampleCount, 4);
  assert.equal(context.view.clearColor.r, 0.1);
  assert.equal(passOptions[0].depthConvention, 'reverse');
  assert.equal(passOptions[0].sampleCount, 4);
});

test('RenderView and render-pass descriptor caches reuse stable frame inputs', () => {
  const engine = createMockEngine();
  const view = new RenderView({
    camera: new Entity('CachedViewCamera'),
    target: engine.renderTarget,
    viewport: { x: 0, y: 0, width: 320, height: 180 },
  });
  const first = view.snapshot();
  assert.equal(view.snapshot(), first);

  const family = new RenderViewFamily({ views: [view] });
  const firstFamily = family.snapshot();
  assert.equal(family.snapshot(), firstFamily);

  view.viewport.width = 640;
  const changed = view.snapshot();
  assert.notEqual(changed, first);
  assert.equal(changed.width, 640);
  assert.notEqual(family.snapshot(), firstFamily);

  const attachment = {
    view: { id: 'first-view' },
    loadOp: 'clear',
    storeOp: 'store',
  };
  const descriptor = { colorAttachments: [attachment] };
  const firstClone = cloneRenderPassDescriptor(descriptor, 'load');
  assert.equal(cloneRenderPassDescriptor(descriptor, 'load'), firstClone);
  attachment.view = { id: 'second-view' };
  assert.notEqual(cloneRenderPassDescriptor(descriptor, 'load'), firstClone);
});

test('RenderPipeline freezes a RenderViewFamily and exposes its first view as the primary view', () => {
  const engine = createMockEngine();
  const first = new RenderView({ key: 'first', camera: new Entity('First'), target: engine.renderTarget });
  const second = new RenderView({ key: 'second', camera: new Entity('Second'), target: engine.renderTarget, loadOp: 'load' });
  const family = new RenderViewFamily({ views: [first, second] });
  let seen;
  const pipeline = new RenderPipeline(engine).add({
    record(_world, context) { seen = context; },
  }, { passType: 'compute' });

  const context = pipeline.execute(new World('ViewFamilyWorld'), 0, 16, { viewFamily: family });
  second.loadOp = 'clear';

  assert.equal(context, seen);
  assert.equal(context.view, context.viewFamily.views[0]);
  assert.deepEqual(context.viewFamily.views.map(view => [view.key, view.loadOp]), [
    ['first', 'clear'],
    ['second', 'load'],
  ]);
  assert.equal(Object.isFrozen(context.viewFamily), true);
  assert.equal(Object.isFrozen(context.viewFamily.views), true);
});

test('RenderFrameContext runs deferred CPU work only after its command buffer is submitted', () => {
  const log = [];
  const engine = createMockEngine(log);
  const pipeline = new RenderPipeline(engine);
  const world = new World('AfterSubmitWorld');
  const calls = [];
  pipeline.add({
    record(_world, context) {
      context.afterSubmit(queue => calls.push(['after-submit', queue === engine.device.queue, context.submitted]));
      calls.push(['record']);
    },
  }, { passType: 'compute' });

  const context = createRenderFrameContext(engine);
  pipeline.execute(world, 0, 16, { context });
  assert.deepEqual(calls, [['record']]);
  assert.equal(context.submitted, false);

  context.submit();
  assert.deepEqual(calls, [
    ['record'],
    ['after-submit', true, true],
  ]);
  assert.ok(log.findIndex(entry => entry[0] === 'submit') < log.length);
});

test('RenderPipeline shares compatible render passes and separates isolated passes', () => {
  const log = [];
  const calls = [];
  const pipeline = new RenderPipeline(createMockEngine(log));
  const world = new World('SharedPassWorld');

  pipeline
    .add(makeSystem('a', calls), { pass: 'shared', loadOp: 'clear' })
    .add(makeSystem('b', calls), { pass: 'shared', loadOp: 'clear' })
    .add(makeSystem('c', calls), { pass: 'isolated', loadOp: 'load' });

  pipeline.execute(world);

  assert.deepEqual(calls, [
    ['a', true],
    ['b', true],
    ['c', false],
  ]);
  assert.equal(log.filter(entry => entry[0] === 'beginRenderPass').length, 1);
  assert.equal(log.filter(entry => entry[0] === 'endPass').length, 1);
});

test('RenderPipeline compute entries end active render pass and do not begin a render pass', () => {
  const log = [];
  const calls = [];
  const pipeline = new RenderPipeline(createMockEngine(log));
  const world = new World('ComputeWorld');
  const compute = {
    record(world, delta, context) {
      calls.push(['compute', delta, context.passActive]);
    },
  };

  pipeline
    .add(makeSystem('render', calls), { pass: 'shared' })
    .add(compute, { passType: 'compute', recordMode: 'delta' })
    .add(makeSystem('render2', calls), { pass: 'shared' });

  pipeline.execute(world, 0, 33);

  assert.deepEqual(calls, [
    ['render', true],
    ['compute', 33, false],
    ['render2', true],
  ]);
  assert.equal(log.filter(entry => entry[0] === 'beginRenderPass').length, 2);
});

test('RenderPipeline does not infer delta mode from record arity', () => {
  const calls = [];
  const pipeline = new RenderPipeline(createMockEngine());
  const world = new World('ExplicitRecordModeWorld');
  const arityThreeSystem = {
    record(world, maybeContext, maybeContext2) {
      calls.push([maybeContext?.passActive, maybeContext2]);
    },
  };

  pipeline.add(arityThreeSystem, { passType: 'compute' });
  pipeline.execute(world, 0, 33);

  assert.deepEqual(calls, [[false, undefined]]);
});

test('RenderPipeline supports depthless render entries', () => {
  const log = [];
  const calls = [];
  const pipeline = new RenderPipeline(createMockEngine(log));
  const world = new World('DepthlessPassWorld');

  pipeline.add(makeSystem('fullscreen', calls), { pass: 'shared', loadOp: 'clear', depth: false });

  pipeline.execute(world);

  const beginPass = log.find(entry => entry[0] === 'beginRenderPass');
  assert.ok(beginPass, 'expected a render pass to be opened');
  assert.equal(beginPass[1].depthStencilAttachment, undefined);
});

test('RenderPipeline remove prevents execution and clear resets active size', () => {
  const calls = [];
  const pipeline = new RenderPipeline(createMockEngine());
  const world = new World('RemoveWorld');
  const removed = makeSystem('removed', calls);
  const kept = makeSystem('kept', calls);

  pipeline.add(removed).add(kept).remove(removed);
  assert.equal(pipeline.size, 1);
  pipeline.execute(world);
  assert.deepEqual(calls.map(call => call[0]), ['kept']);

  pipeline.clear();
  assert.equal(pipeline.size, 0);
});

test('RenderPipeline exposes a renderer-agnostic execution boundary contract', () => {
  const calls = [];
  const system = makeSystem('bounded', calls);
  const boundaryLog = [];
  const boundary = {
    enter(entry) {
      boundaryLog.push(['enter', entry === system]);
      return 'owner-token';
    },
    leave(token) { boundaryLog.push(['leave', token]); },
    remove(entry) { boundaryLog.push(['remove', entry === system]); },
    clear() { boundaryLog.push(['clear']); },
  };
  const pipeline = new RenderPipeline(createMockEngine(), boundary);
  const world = new World('BoundaryWorld');

  pipeline.add(system).execute(world);
  pipeline.remove(system);
  pipeline.clear();

  assert.deepEqual(calls.map(call => call[0]), ['bounded']);
  assert.deepEqual(boundaryLog, [
    ['enter', true],
    ['leave', 'owner-token'],
    ['remove', true],
    ['clear'],
  ]);
});

test('RenderPipeline restores an entered execution boundary when record throws', () => {
  const boundaryLog = [];
  const boundary = {
    enter() {
      boundaryLog.push('enter');
      return 7;
    },
    leave(token) { boundaryLog.push(`leave:${token}`); },
  };
  const pipeline = new RenderPipeline(createMockEngine(), boundary);
  pipeline.add({ record() { throw new Error('record failed'); } }, { passType: 'compute' });

  assert.throws(() => pipeline.execute(new World('BoundaryFailureWorld')), /record failed/);
  assert.deepEqual(boundaryLog, ['enter', 'leave:7']);
});

test('RenderIntegration merges system renderPipelineOptions with explicit overrides', () => {
  const calls = [];
  const engine = createMockEngine();
  const world = new World('MergedRenderOptionsWorld');
  const integration = new RenderIntegration(engine);
  const deltaSystem = {
    autoUpdate: true,
    renderPipelineOptions: { passType: 'compute', recordMode: 'delta' },
    record(_world, delta, context) {
      calls.push([delta, context.passActive]);
    },
  };

  world.addRuntimeIntegration(integration);
  integration.register(deltaSystem, { pass: 'shared', loadOp: 'load' });
  world.update(0, 42);

  assert.deepEqual(calls, [[42, false]]);
  assert.equal(deltaSystem.autoUpdate, false);
});

test('World runtime integrations share one logical frame and one post-update phase', () => {
  const engine = createMockEngine();
  const world = new World('SharedFrameTokenWorld');
  const seen = [];
  const integrations = [new RenderIntegration(engine), new RenderIntegration(engine)];
  for (const [index, integration] of integrations.entries()) {
    integration.register({
      record(_world, context) {
        seen.push({
          index,
          frameId: context.frameData.frameId,
          phaseRevision: context.frameData.phaseRevision,
          engine: context.frameData.engine,
        });
      },
    }, { passType: 'compute' });
    world.addRuntimeIntegration(integration);
  }

  world.update(10, 16);
  assert.deepEqual(seen.map(item => [item.index, item.frameId, item.phaseRevision]), [
    [0, 1, 2],
    [1, 1, 2],
  ]);
  assert.equal(seen.every(item => item.engine === engine), true);

  world.update(26, 16);
  assert.deepEqual(seen.slice(2).map(item => [item.index, item.frameId, item.phaseRevision]), [
    [0, 2, 4],
    [1, 2, 4],
  ]);
});

test('post-update render phase invalidates camera and uniform snapshots without advancing frameId', () => {
  const engine = createMockEngine();
  const world = new World('RenderPhaseTransformWorld');
  const camera = new Camera3D();
  const transform = new Transform3D();
  const cameraEntity = new Entity('Camera').addComponent(transform).addComponent(camera);
  world.addEntity(cameraEntity);

  let updateCameraFrame;
  let updateUniforms;
  const updateSystem = new System({ all: [Camera3D] }, entity => {
    updateCameraFrame = world.frameData.getCamera3D(entity, camera, 640, 360, false);
    updateUniforms = getSceneFrameUniformSnapshot(updateCameraFrame, null);
    transform.setTranslation(0, 0, 7);
  });
  world.addSystem(updateSystem);

  let renderCameraFrame;
  let renderUniforms;
  const integration = new RenderIntegration(engine);
  integration.register({
    record(_world, context) {
      renderCameraFrame = context.frameData.getCamera3D(cameraEntity, camera, 640, 360, false);
      renderUniforms = getSceneFrameUniformSnapshot(renderCameraFrame, null);
    },
  }, { passType: 'compute' });
  world.addRuntimeIntegration(integration);

  world.update(10, 16);

  assert.equal(world.frameData.frameId, 1);
  assert.equal(updateCameraFrame, renderCameraFrame, 'camera frame storage remains allocation-stable');
  assert.equal(updateUniforms.frameId, renderUniforms.frameId);
  assert.notEqual(updateUniforms.phaseRevision, renderUniforms.phaseRevision);
  assert.notEqual(updateUniforms, renderUniforms, 'phase-local uniform data must be rebuilt');
  assert.equal(updateUniforms.data[50], 0);
  assert.equal(renderUniforms.data[50], 7);
});
