import test from 'node:test';
import assert from 'node:assert/strict';
import { Fog } from '../dist/lighting.js';
import {
  FOG_UNIFORM_WGSL,
  FogUniformLayout,
  getSceneFrameUniformSnapshot,
  getSceneFrameGpuArena,
  disposeSceneFrameGpuArena,
  FrameRingResource,
  SceneFrameGpuArena,
  SCENE_FRAME_UNIFORM_FLOATS,
  SCENE_FRAME_UNIFORM_WGSL,
  SceneFrameUniformLayout,
  writeSceneFrameUniforms,
} from '../dist/experimental.js';

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
globalThis.GPUBufferUsage ??= { COPY_DST: 1, UNIFORM: 2 };

function createArenaDevice(alignment = 256) {
  const writes = [];
  const buffers = [];
  const layouts = [];
  const bindGroups = [];
  const device = {
    limits: {
      minUniformBufferOffsetAlignment: alignment,
      maxUniformBufferBindingSize: 64 * 1024,
      maxBufferSize: 16 * 1024 * 1024,
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        writes.push({ buffer, offset, data: Float32Array.from(data) });
      },
    },
    createBindGroupLayout(descriptor) {
      const layout = { descriptor };
      layouts.push(layout);
      return layout;
    },
    createBuffer(descriptor) {
      const buffer = { ...descriptor, destroyed: false, destroy() { this.destroyed = true; } };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup(descriptor) {
      const bindGroup = { descriptor };
      bindGroups.push(bindGroup);
      return bindGroup;
    },
  };
  return { device, writes, buffers, layouts, bindGroups };
}

test('SceneFrameUniform ABI fixes WGSL alignment, size, offsets, and field order', () => {
  assert.deepEqual(FogUniformLayout, {
    name: 'FogUniforms',
    alignment: 16,
    size: 48,
    fields: [
      { name: 'color', wgslType: 'vec4<f32>', alignment: 16, size: 16, offset: 0 },
      { name: 'distanceParams', wgslType: 'vec4<f32>', alignment: 16, size: 16, offset: 16 },
      { name: 'heightParams', wgslType: 'vec4<f32>', alignment: 16, size: 16, offset: 32 },
    ],
  });
  assert.deepEqual(SceneFrameUniformLayout, {
    name: 'SceneFrameUniforms',
    alignment: 16,
    size: 272,
    fields: [
      { name: 'viewProjection', wgslType: 'mat4x4<f32>', alignment: 16, size: 64, offset: 0 },
      { name: 'view', wgslType: 'mat4x4<f32>', alignment: 16, size: 64, offset: 64 },
      { name: 'inverseViewProjection', wgslType: 'mat4x4<f32>', alignment: 16, size: 64, offset: 128 },
      { name: 'eyePosition', wgslType: 'vec4<f32>', alignment: 16, size: 16, offset: 192 },
      { name: 'viewport', wgslType: 'vec4<f32>', alignment: 16, size: 16, offset: 208 },
      { name: 'fog', wgslType: 'FogUniforms', alignment: 16, size: 48, offset: 224 },
    ],
  });
  assert.equal(SCENE_FRAME_UNIFORM_FLOATS, 68);
  assert.equal(FOG_UNIFORM_WGSL, [
    'struct FogUniforms {',
    '  color : vec4<f32>,',
    '  distanceParams : vec4<f32>,',
    '  heightParams : vec4<f32>,',
    '}',
  ].join('\n'));
  assert.equal(SCENE_FRAME_UNIFORM_WGSL, [
    'struct SceneFrameUniforms {',
    '  viewProjection : mat4x4<f32>,',
    '  view : mat4x4<f32>,',
    '  inverseViewProjection : mat4x4<f32>,',
    '  eyePosition : vec4<f32>,',
    '  viewport : vec4<f32>,',
    '  fog : FogUniforms,',
    '}',
  ].join('\n'));
});

test('SceneFrameUniform writer follows schema-derived offsets for camera and Fog', () => {
  const matrix = Float32Array.from({ length: 16 }, (_, index) => index + 1);
  const fog = new Fog({
    mode: 'height',
    color: [0.25, 0.5, 0.75, 0.8],
    maxOpacity: 0.7,
    distanceStart: 4,
    distanceEnd: 30,
    baseHeight: 6,
    density: 0.12,
    heightFalloff: 0.3,
  });
  const data = writeSceneFrameUniforms(new Float32Array(68), {
    viewProjectionMatrix: matrix,
    viewMatrix: matrix,
    inverseViewProjectionMatrix: matrix,
    position: [11, 12, 13],
    width: 800,
    height: 400,
  }, fog);

  assert.deepEqual([...data.subarray(0, 16)], [...matrix]);
  assert.deepEqual([...data.subarray(16, 32)], [...matrix]);
  assert.deepEqual([...data.subarray(32, 48)], [...matrix]);
  assert.deepEqual([...data.subarray(48, 52)], [11, 12, 13, 0]);
  assert.deepEqual([...data.subarray(52, 56)], [...new Float32Array([800, 400, 1 / 800, 1 / 400])]);
  assert.deepEqual([...data.subarray(56, 60)], [...new Float32Array([0.25, 0.5, 0.75, 0.8])]);
  assert.deepEqual([...data.subarray(60, 64)], [...new Float32Array([2, 4, 30, 0.7])]);
  assert.deepEqual([...data.subarray(64, 68)], [...new Float32Array([6, 0.12, 0.3, 0])]);
  assert.throws(() => writeSceneFrameUniforms(new Float32Array(67), {
    viewProjectionMatrix: matrix,
    viewMatrix: matrix,
    inverseViewProjectionMatrix: matrix,
    position: [0, 0, 0],
    width: 1,
    height: 1,
  }, null), /requires 68 floats/);
});

test('renderers sharing one camera frame receive the same CPU uniform snapshot', () => {
  const cameraFrame = {
    frameId: 7,
    phaseRevision: 11,
    entity: { id: 42 },
    width: 800,
    height: 600,
    reverseZ: false,
    viewProjectionMatrix: Float32Array.from({ length: 16 }, (_, index) => index),
    viewMatrix: Float32Array.from({ length: 16 }, (_, index) => index + 20),
    inverseViewProjectionMatrix: Float32Array.from({ length: 16 }, (_, index) => index + 40),
    position: new Float32Array([3, 4, 5]),
  };
  const first = getSceneFrameUniformSnapshot(cameraFrame, null);
  const shared = getSceneFrameUniformSnapshot(cameraFrame, new Fog());
  cameraFrame.phaseRevision = 12;
  cameraFrame.viewProjectionMatrix[0] = 99;
  cameraFrame.position.set([6, 7, 8]);
  const next = getSceneFrameUniformSnapshot(cameraFrame, null);

  assert.equal(shared, first);
  assert.equal(first.frameId, 7);
  assert.equal(first.phaseRevision, 11);
  assert.equal(first.cameraEntityId, 42);
  assert.deepEqual([...first.data.subarray(48, 52)], [3, 4, 5, 0]);
  assert.notEqual(next, first);
  assert.equal(next.frameId, 7);
  assert.equal(next.phaseRevision, 12);
  assert.equal(next.data[0], 99);
  assert.deepEqual([...next.data.subarray(48, 52)], [6, 7, 8, 0]);
});

test('SceneFrameGpuArena aligns view slots, deduplicates uploads, and rotates frame regions', () => {
  const { device, writes, buffers, layouts, bindGroups } = createArenaDevice(256);
  const arena = getSceneFrameGpuArena(device);
  const binding = arena.createBinding();
  const secondPipelineBinding = arena.createBinding();
  const cameraFrame = {
    frameId: 1,
    phaseRevision: 1,
    entity: { id: 7 },
    width: 800,
    height: 600,
    reverseZ: false,
    viewProjectionMatrix: new Float32Array(16),
    viewMatrix: new Float32Array(16),
    inverseViewProjectionMatrix: new Float32Array(16),
    position: new Float32Array([1, 2, 3]),
  };

  const first = getSceneFrameUniformSnapshot(cameraFrame, null);
  const firstOffset = binding.upload(first);
  assert.equal(binding.upload(first), firstOffset);
  assert.equal(secondPipelineBinding.upload(first), firstOffset);
  assert.equal(secondPipelineBinding.bindGroup, binding.bindGroup);
  assert.equal(writes.length, 1, 'all pipelines reuse the first upload and bind group');

  cameraFrame.frameId = 2;
  cameraFrame.phaseRevision = 2;
  cameraFrame.position[0] = 4;
  const secondOffset = binding.upload(getSceneFrameUniformSnapshot(cameraFrame, null));
  cameraFrame.frameId = 3;
  cameraFrame.phaseRevision = 3;
  const thirdOffset = binding.upload(getSceneFrameUniformSnapshot(cameraFrame, null));
  cameraFrame.frameId = 4;
  cameraFrame.phaseRevision = 4;
  const fourth = getSceneFrameUniformSnapshot(cameraFrame, null);
  const wrappedOffset = binding.upload(fourth);

  assert.equal(arena.slotStride, 512);
  assert.equal(fourth, first, 'steady-state CPU snapshots reuse the three-entry ring');
  assert.equal(secondOffset - firstOffset, arena.maxViews * 512);
  assert.equal(thirdOffset - secondOffset, arena.maxViews * 512);
  assert.equal(wrappedOffset, firstOffset, 'the fourth revision reuses the first frame-ring region');
  assert.equal(writes.length, 4);
  assert.equal(layouts.length, 1);
  assert.equal(bindGroups.length, 1);
  assert.equal(layouts[0].descriptor.entries[0].buffer.hasDynamicOffset, true);
  assert.equal(layouts[0].descriptor.entries[0].buffer.minBindingSize, 272);
  assert.equal(bindGroups[0].descriptor.entries[0].resource.size, 272);
  assert.equal(getSceneFrameGpuArena(device), arena, 'one arena is shared per GPUDevice');

  binding.destroy();
  assert.equal(arena.getStats().viewCount, 1, 'a view remains retained by another pipeline binding');
  secondPipelineBinding.destroy();
  assert.equal(arena.getStats().viewCount, 0, 'scene/renderer teardown releases view slots');
  assert.equal(buffers[0].destroyed, false, 'scene/renderer teardown keeps the device-owned buffer alive');
  disposeSceneFrameGpuArena(device);
  assert.equal(buffers[0].destroyed, true);
});

test('FrameRingResource retires submitted generations and shrinks only after hysteresis', async () => {
  const created = [];
  const destroyed = [];
  const afterSubmitCallbacks = [];
  let resolveQueue;
  const queueDone = new Promise(resolve => { resolveQueue = resolve; });
  const queue = { onSubmittedWorkDone: () => queueDone };
  const context = {
    device: { queue },
    afterSubmit: callback => afterSubmitCallbacks.push(callback),
  };
  const ring = new FrameRingResource({
    label: 'test.frameRing',
    initialCapacity: 2,
    maximumCapacity: 16,
    shrinkDelayFrames: 2,
    create: info => {
      const resource = { generation: info.generation, capacity: info.capacity };
      created.push(resource);
      return resource;
    },
    destroy: resource => destroyed.push(resource.generation),
  });

  ring.beginFrame(1, context);
  assert.equal(ring.slot(0), 0);
  ring.beginFrame(8, context);
  assert.equal(ring.capacity, 8);
  assert.equal(afterSubmitCallbacks.length, 1);
  assert.deepEqual(destroyed, [], 'the submitted generation remains alive before submission completion');
  afterSubmitCallbacks.shift()(queue);
  await Promise.resolve();
  assert.deepEqual(destroyed, [], 'queue completion, not afterSubmit itself, owns retirement');
  resolveQueue();
  await queueDone;
  await Promise.resolve();
  assert.deepEqual(destroyed, [1]);

  ring.beginFrame(1, context);
  assert.equal(ring.capacity, 8, 'one low-water frame does not shrink');
  ring.beginFrame(1, context);
  assert.equal(ring.capacity, 2, 'the configured low-water delay triggers a headroom-preserving shrink');
  assert.deepEqual(created.map(resource => resource.capacity), [2, 8, 2]);
  ring.destroy();
});

test('SceneFrameGpuArena grows generations before encoding and retires the old buffer after GPU completion', async () => {
  const { device, buffers, layouts, bindGroups } = createArenaDevice(256);
  let resolveQueue;
  const queueDone = new Promise(resolve => { resolveQueue = resolve; });
  device.queue.onSubmittedWorkDone = () => queueDone;
  const afterSubmitCallbacks = [];
  const context = {
    device,
    afterSubmit: callback => afterSubmitCallbacks.push(callback),
  };
  const arena = new SceneFrameGpuArena(device, { maxViews: 1, maximumViews: 4 });
  const binding = arena.createBinding();
  const makeFrame = (entityId, revision) => ({
    frameId: revision,
    phaseRevision: revision,
    entity: { id: entityId },
    width: 64,
    height: 64,
    reverseZ: false,
    viewProjectionMatrix: new Float32Array(16),
    viewMatrix: new Float32Array(16),
    inverseViewProjectionMatrix: new Float32Array(16),
    position: new Float32Array(3),
  });
  const first = getSceneFrameUniformSnapshot(makeFrame(1, 1), null);
  const second = getSceneFrameUniformSnapshot(makeFrame(2, 1), null);

  binding.upload(first);
  const oldBuffer = buffers[0];
  assert.equal(arena.ensureCapacityForSnapshots([first, second], context), true);
  assert.equal(arena.maxViews, 2);
  assert.equal(arena.maximumViews, 4);
  assert.equal(arena.remainingViews, 1);
  assert.equal(arena.getStats().retiringGenerations, 1);
  assert.equal(layouts.length, 1, 'growth preserves the pipeline-compatible bind group layout');
  assert.equal(bindGroups.length, 2);
  assert.equal(oldBuffer.destroyed, false);

  binding.upload(first);
  binding.upload(second);
  assert.equal(arena.getStats().viewCount, 2);
  assert.equal(arena.remainingViews, 0);
  assert.equal(afterSubmitCallbacks.length, 1);
  afterSubmitCallbacks[0](device.queue);
  resolveQueue();
  await queueDone;
  await Promise.resolve();
  assert.equal(oldBuffer.destroyed, true);
  assert.equal(arena.getStats().retiringGenerations, 0);

  binding.destroy();
  arena.destroy();
});
