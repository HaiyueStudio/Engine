import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssetManager,
  beginRenderCommandPass,
  clearCachedRenderPassDescriptors,
  createSVG2DMeshes,
  createPolygon2D,
  DEFAULT_ENGINE_DEFAULTS,
  EventEmitter,
  EngineErrorCode,
  FrameLoop,
  Frustum,
  Geometry2D,
  Geometry3D,
  GpuSortComputePass,
  GPUResourceTracker,
  requireEngineCanvas,
  requireEngineDevice,
  getCachedRenderPassDescriptor,
  RenderTargetManager,
  assertPluginDependencies,
  TextureConvolutionProcessor,
  TransparentMegaBatch,
} from '../dist/experimental.js';
import { Material, MaterialRendererRegistry } from '../dist/material.js';
import {
  deserializeEngineError,
  EngineError,
  ErrorDomain,
  ErrorRecovery,
  isSerializedEngineError,
  serializeEngineError,
} from '../dist/core.js';

test('EngineError preserves four distinct recovery strategies across worker serialization', () => {
  const strategies = [
    [ErrorRecovery.Ignore, true],
    [ErrorRecovery.Retry, true],
    [ErrorRecovery.ReleaseResource, false],
    [ErrorRecovery.TerminateRuntime, false],
  ];
  for (const [recovery, recoverable] of strategies) {
    const original = new EngineError(EngineErrorCode.AssetLoadFailed, `failure:${recovery}`, {
      domain: ErrorDomain.Asset,
      recovery,
      context: { url: '/asset.bin' },
      path: 'assets[0]',
      cause: new TypeError('root cause'),
    });
    const payload = serializeEngineError(original);
    assert.equal(isSerializedEngineError(payload), true);
    const restored = deserializeEngineError(payload);
    assert.equal(restored.recovery, recovery);
    assert.equal(restored.recoverable, recoverable);
    assert.equal(restored.domain, ErrorDomain.Asset);
    assert.equal(restored.path, 'assets[0]');
    assert.equal(restored.context.url, '/asset.bin');
    assert.equal(restored.cause.name, 'TypeError');
  }
});

test('AssetManager de-duplicates concurrent loads and releases by ref count', async () => {
  const manager = new AssetManager({});
  assert.equal('getStatus' in manager, false);
  let loadCount = 0;
  let disposeCount = 0;

  const [first, second] = await Promise.all([
    manager.load('asset:a', async () => {
      loadCount++;
      return { id: 'a' };
    }, () => {
      disposeCount++;
    }),
    manager.load('asset:a', async () => {
      loadCount++;
      return { id: 'a' };
    }, () => {
      disposeCount++;
    }),
  ]);

  assert.equal(loadCount, 1);
  assert.equal(manager.getJobState('asset:a'), 'ready');
  assert.equal(manager.getRefCount('asset:a'), 2);
  assert.equal(first.value, second.value);

  first.release();
  assert.equal(manager.getRefCount('asset:a'), 1);
  assert.equal(disposeCount, 0);

  second.release();
  assert.equal(manager.getJobState('asset:a'), null);
  assert.equal(disposeCount, 1);
});

test('AssetManager setAsset/getAsset handles and deletion dispose owned data', () => {
  const manager = new AssetManager({});
  let disposeCount = 0;
  const initial = manager.setAsset('memory:data', { value: 1 }, () => {
    disposeCount++;
  });

  assert.equal(manager.getJobState('memory:data'), 'ready');
  assert.equal(manager.getRefCount('memory:data'), 1);

  const second = manager.getAsset('memory:data');
  assert.ok(second);
  assert.equal(second.value.value, 1);
  assert.equal(manager.getRefCount('memory:data'), 2);

  initial.release();
  second.release();
  assert.equal(disposeCount, 1);
  assert.equal(manager.getJobState('memory:data'), null);
});

test('EventEmitter preserves priority, once, and mutation during emit', () => {
  const emitter = new EventEmitter();
  const calls = [];
  const late = () => calls.push('late');
  const removable = () => {
    calls.push('remove-self');
    emitter.off('tick', removable);
    emitter.on('tick', late);
  };

  emitter.on('tick', () => calls.push('low'), { priority: -1 });
  emitter.once('tick', () => calls.push('once'), { priority: 10 });
  emitter.on('tick', removable, { priority: 5 });

  emitter.emit('tick');
  emitter.emit('tick');

  assert.deepEqual(calls, ['once', 'remove-self', 'low', 'late', 'low']);
  assert.equal(emitter.listenerCount('tick'), 2);
});

test('EventEmitter dispatches capture, target, and bubble EngineEvent phases', () => {
  const root = new EventEmitter();
  const child = new EventEmitter();
  const calls = [];

  root.on('pointer', event => calls.push(`root:${event.eventPhase}`), { capture: true });
  child.on('pointer', event => calls.push(`child:${event.eventPhase}`));
  root.on('pointer', event => calls.push(`root:${event.eventPhase}`));

  const event = child.emit('pointer', {
    path: [root, child],
    bubbles: true,
    detail: { x: 12 },
  });

  assert.deepEqual(calls, ['root:capture', 'child:target', 'root:bubble']);
  assert.equal(event.detail.x, 12);
  assert.equal(event.currentTarget, null);
  assert.equal(event.eventPhase, 'none');
});

test('MaterialRendererRegistry resolves by materialType string before constructor matching', () => {
  class TestMaterial extends Material {
    type = 'runtime-material';
  }

  const registry = new MaterialRendererRegistry();
  const byString = { materialType: 'runtime-material', renderItem() {} };
  const byConstructor = { materialType: TestMaterial, renderItem() {} };
  registry.register(byConstructor).register(byString);

  assert.equal(registry.resolve(new TestMaterial()), byString);

  registry.unregister('runtime-material');
  assert.equal(registry.resolve(new TestMaterial()), byConstructor);
});

test('EnginePlugin dependency check reports missing dependencies', () => {
  assert.doesNotThrow(() => assertPluginDependencies(
    { name: 'feature', version: '1.0.0', dependencies: ['base'] },
    name => name === 'base',
  ));

  assert.throws(
    () => assertPluginDependencies(
      { name: 'feature', version: '1.0.0', dependencies: ['missing'] },
      () => false,
    ),
    /requires dependency "missing"/,
  );
});

test('EngineError covers engine availability guards', () => {
  const engine = {
    device: null,
    canvas: null,
  };

  assert.throws(
    () => requireEngineDevice(engine),
    error => error.code === EngineErrorCode.EngineNotInitialized,
  );
  assert.throws(
    () => requireEngineCanvas(engine),
    error => error.code === EngineErrorCode.EngineDestroyed,
  );
});

test('EngineError covers RenderCommandContext invalid pass state', () => {
  assert.throws(
    () => beginRenderCommandPass({ encoder: {} }),
    error => error.code === EngineErrorCode.RenderCommandContextInvalid,
  );
});

test('EngineError covers geometry parameter validation', () => {
  assert.throws(
    () => new Geometry3D({ positions: new Float32Array([0, 1]) }),
    error => error.code === EngineErrorCode.GeometryInvalidParameter,
  );
  assert.throws(
    () => new Geometry3D({
      positions: new Float32Array([0, 0, 0]),
      indices: new Uint16Array([1]),
    }),
    error => error.code === EngineErrorCode.GeometryInvalidParameter,
  );
  assert.throws(
    () => new Geometry2D(new Float32Array([0, 0]), new Uint16Array([1])),
    error => error.code === EngineErrorCode.GeometryInvalidParameter,
  );
  assert.throws(
    () => createPolygon2D({ points: [[0, 0], [1, 0]] }),
    error => error.code === EngineErrorCode.GeometryInvalidParameter,
  );
  assert.throws(
    () => new Frustum().setFromPlanes([1, 0, 0, 0]),
    error => error.code === EngineErrorCode.GeometryInvalidParameter,
  );
  assert.throws(
    () => createSVG2DMeshes('<html></html>'),
    error => error.code === EngineErrorCode.GeometryInvalidParameter,
  );
});

test('Geometry2D exposes explicit versioned mutation helpers', () => {
  const geometry = new Geometry2D(
    new Float32Array([0, 0, 1, 0, 0, 1]),
    new Uint16Array([0, 1, 2]),
  );

  assert.equal(geometry.version, 0);
  geometry.markDirty();
  assert.equal(geometry.version, 1);

  geometry.setPositions(new Float32Array([0, 0, 2, 0, 0, 2]));
  assert.equal(geometry.version, 2);
  assert.equal(geometry.vertexCount, 3);

  geometry.setData(
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    new Uint16Array([0, 1, 2, 0, 2, 3]),
  );
  assert.equal(geometry.version, 3);
  assert.equal(geometry.vertexCount, 4);
  assert.equal(geometry.indexCount, 6);

  assert.throws(
    () => geometry.setIndices(new Uint16Array([0, 9])),
    error => error.code === EngineErrorCode.GeometryInvalidParameter,
  );
});

test('Engine defaults include 2D and GUI render defaults', () => {
  assert.equal(DEFAULT_ENGINE_DEFAULTS.render2D.loadOp, 'load');
  assert.equal(DEFAULT_ENGINE_DEFAULTS.gui.loadOp, 'load');
  assert.equal(DEFAULT_ENGINE_DEFAULTS.renderPipeline.entry.pass, 'shared');
});

test('EngineError covers renderer resource readiness guards', () => {
  const batch = new TransparentMegaBatch();
  assert.throws(
    () => batch.sortKeyBuffer,
    error => error.code === EngineErrorCode.RendererResourceNotReady,
  );
});

test('EngineError covers compute parameter validation', () => {
  const sortPass = new GpuSortComputePass({ device: null });
  assert.throws(
    () => sortPass.sort({ encoder: {} }, {
      sortKeyBuffer: {},
      sortIndexBuffer: {},
      count: 3,
      paddedCapacity: 3,
    }),
    error => error.code === EngineErrorCode.ComputeInvalidParameter,
  );
  assert.throws(
    () => sortPass.sort({ encoder: {} }, {
      sortKeyBuffer: {},
      sortIndexBuffer: {},
      count: 2,
      paddedCapacity: 2,
      keyWords: 0,
    }),
    error => error.code === EngineErrorCode.ComputeInvalidParameter,
  );
  assert.throws(
    () => new TextureConvolutionProcessor({ device: null }, { format: 'rgba16float' }),
    error => error.code === EngineErrorCode.ComputeInvalidParameter,
  );
});

test('GpuSortComputePass stores compact per-pass params without dynamic offsets', () => {
  const previousGpuBufferUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = {
    STORAGE: 1 << 0,
    COPY_DST: 1 << 1,
  };
  const log = [];
  const queue = {
    writeBuffer(buffer, offset, data, dataOffset, size) {
      log.push(['writeBuffer', buffer.label, offset, dataOffset ?? 0, size]);
    },
  };
  const device = {
    queue,
    createBindGroupLayout(descriptor) {
      log.push(['createBindGroupLayout', descriptor.entries[2].buffer.type, descriptor.entries[2].buffer.hasDynamicOffset ?? false]);
      return { descriptor };
    },
    createShaderModule(descriptor) {
      return { descriptor };
    },
    createPipelineLayout(descriptor) {
      return { descriptor };
    },
    createComputePipeline(descriptor) {
      return { descriptor };
    },
    createBuffer(descriptor) {
      const buffer = {
        label: descriptor.label,
        descriptor,
        destroy() {
          log.push(['destroyBuffer', descriptor.label]);
        },
      };
      log.push(['createBuffer', descriptor.label, descriptor.size, descriptor.usage]);
      return buffer;
    },
    createBindGroup(descriptor) {
      log.push(['createBindGroup', descriptor.label, descriptor.entries[2].resource.buffer.label]);
      return { descriptor };
    },
  };
  const passLog = [];
  const computePass = {
    setPipeline() {
      passLog.push(['setPipeline']);
    },
    setBindGroup(...args) {
      const [index, bindGroup, dynamicOffsets] = args;
      passLog.push(['setBindGroup', index, bindGroup.descriptor.entries[2].resource.buffer.label, dynamicOffsets, args.length]);
    },
    dispatchWorkgroups(x) {
      passLog.push(['dispatchWorkgroups', x]);
    },
    end() {
      passLog.push(['end']);
    },
  };
  const context = {
    encoder: {
      beginComputePass(descriptor) {
        passLog.push(['beginComputePass', descriptor.label]);
        return computePass;
      },
    },
  };

  const sortPass = new GpuSortComputePass({ device }, 'sort.test');
  sortPass.sort(context, {
    sortKeyBuffer: { label: 'keys' },
    sortIndexBuffer: { label: 'indices' },
    count: 8,
    paddedCapacity: 8,
    keyWords: 2,
  });

  const paramBuffers = log.filter(entry => entry[0] === 'createBuffer' && String(entry[1]).startsWith('sort.test.params.'));
  assert.equal(paramBuffers.length, 8);
  assert.equal(paramBuffers.every(entry => entry[2] === 32), true);
  assert.deepEqual(log.find(entry => entry[0] === 'createBindGroupLayout'), ['createBindGroupLayout', 'read-only-storage', false]);
  assert.equal(passLog.filter(entry => entry[0] === 'dispatchWorkgroups').length, 6);
  assert.equal(passLog.filter(entry => entry[0] === 'setBindGroup').every(entry => entry[3] === undefined), true);
  assert.equal(passLog.filter(entry => entry[0] === 'setBindGroup').every(entry => entry[4] === 2), true);
  assert.equal(log.filter(entry => entry[0] === 'writeBuffer').every(entry => entry[4] === 32), true);
  sortPass.destroy();
  globalThis.GPUBufferUsage = previousGpuBufferUsage;
});

test('RenderTargetManager owns canvas render targets and render pass descriptors', async () => {
  const previousGpuTextureUsage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 0x10 };
  const log = [];
  const outputTexture = createMockTexture('swapchain', log);
  const submittedResolvers = [];
  const context = {
    configure(descriptor) {
      log.push(['configure', descriptor]);
    },
    getCurrentTexture() {
      log.push(['getCurrentTexture']);
      return outputTexture;
    },
  };
  const canvas = {
    width: 1,
    height: 1,
    clientWidth: 100,
    clientHeight: 50,
    getBoundingClientRect() {
      return { width: 100, height: 50 };
    },
    getContext(type) {
      assert.equal(type, 'webgpu');
      return context;
    },
  };
  const device = {
    queue: {
      onSubmittedWorkDone() {
        log.push(['onSubmittedWorkDone']);
        return new Promise(resolve => submittedResolvers.push(resolve));
      },
    },
    createTexture(descriptor) {
      const texture = createMockTexture(`texture:${descriptor.format}:${descriptor.sampleCount ?? 1}`, log);
      log.push(['createTexture', descriptor, texture]);
      return texture;
    },
  };
  const resizes = [];
  const manager = new RenderTargetManager({
    canvas,
    alphaMode: 'opaque',
    msaaSamples: 1,
    reverseZ: false,
    clearColor: { r: 0, g: 0, b: 0, a: 1 },
    devicePixelRatio: 2,
    gpuResourceTracker: new GPUResourceTracker(),
    getDepthFormat: reverseZ => reverseZ ? 'depth32float' : 'depth24plus',
    onResize: (width, height) => resizes.push([width, height]),
  });

  manager.configure(device, 'bgra8unorm');
  assert.equal(canvas.width, 200);
  assert.equal(canvas.height, 100);
  assert.deepEqual(resizes, [[200, 100]]);
  assert.equal(manager.displayWidth, 100);
  assert.equal(manager.displayHeight, 50);
  assert.equal(manager.msaaTextureView, null);
  assert.ok(manager.depthTextureView);

  const firstDescriptor = manager.getRenderPassDescriptor();
  assert.equal(manager.getRenderPassDescriptorVersion(), 1);
  assert.equal(firstDescriptor.colorAttachments[0].resolveTarget, undefined);
  assert.equal(firstDescriptor.depthStencilAttachment.depthClearValue, 1);

  const alternateDescriptor = manager.getRenderPassDescriptor({
    clearColor: { r: 0.25, g: 0.5, b: 0.75, a: 1 },
    depthConvention: 'reverse',
    sampleCount: 4,
  });
  const alternateTextureCount = log.filter(item => item[0] === 'createTexture').length;
  assert.ok(alternateDescriptor.colorAttachments[0].resolveTarget);
  assert.equal(alternateDescriptor.depthStencilAttachment.depthClearValue, 0);
  assert.equal(alternateDescriptor.colorAttachments[0].clearValue.r, 0.25);
  manager.getRenderPassDescriptor({
    clearColor: { r: 1, g: 0, b: 0, a: 1 },
    depthConvention: 'reverse',
    sampleCount: 4,
  });
  assert.equal(log.filter(item => item[0] === 'createTexture').length, alternateTextureCount);

  manager.setMsaaSamples(4);
  assert.equal(log.filter(item => item[0] === 'destroyTexture').length, 0);
  assert.equal(submittedResolvers.length, 1);
  submittedResolvers.shift()();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(log.filter(item => item[0] === 'destroyTexture' && item[1] === 'texture:depth24plus:1').length, 1);

  const msaaDescriptor = manager.getRenderPassDescriptor();
  assert.ok(manager.msaaTextureView);
  assert.ok(msaaDescriptor.colorAttachments[0].resolveTarget);

  manager.setReverseZ(true);
  const reverseZDescriptor = manager.getRenderPassDescriptor();
  assert.equal(reverseZDescriptor.depthStencilAttachment.depthClearValue, 0);
  assert.ok(log.some(item => item[0] === 'createTexture' && item[1].format === 'depth32float'));

  manager.destroy();
  assert.equal(manager.canvas, null);
  globalThis.GPUTextureUsage = previousGpuTextureUsage;
});

test('render pass descriptor cache can be explicitly cleared per engine', () => {
  let version = 1;
  let cloneSource = 0;
  const engine = {
    getRenderPassDescriptorVersion() {
      return version;
    },
    getRenderPassDescriptor() {
      cloneSource++;
      return {
        colorAttachments: [{
          view: {},
          loadOp: 'clear',
          storeOp: 'store',
        }],
      };
    },
  };

  const first = getCachedRenderPassDescriptor(engine, 'load');
  const second = getCachedRenderPassDescriptor(engine, 'load');
  assert.equal(first, second);
  assert.equal(cloneSource, 1, 'cache hits must not request or clone a new source descriptor');

  clearCachedRenderPassDescriptors(engine);
  const third = getCachedRenderPassDescriptor(engine, 'load');
  assert.notEqual(first, third);
  assert.equal(cloneSource, 2);
});

test('FrameLoop schedules frames, computes delta, and stops cleanly', () => {
  let now = 10;
  let nextHandle = 1;
  const callbacks = new Map();
  const cancelled = [];
  const calls = [];
  const loop = new FrameLoop({
    now: () => now,
    requestFrame(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      cancelled.push(handle);
      callbacks.delete(handle);
    },
    onFrame(time, delta) {
      calls.push([time, delta]);
    },
  });

  loop.start();
  loop.start();
  assert.equal(callbacks.size, 1);
  assert.equal(loop.running, true);

  const first = callbacks.get(1);
  callbacks.delete(1);
  first(26);
  assert.deepEqual(calls, [[26, 16]]);
  assert.equal(callbacks.size, 1);

  loop.stop();
  assert.equal(loop.running, false);
  assert.deepEqual(cancelled, [2]);
  assert.equal(callbacks.size, 0);

  now = 100;
  loop.start();
  const restart = callbacks.get(3);
  callbacks.delete(3);
  restart(140);
  assert.deepEqual(calls.at(-1), [140, 40]);
});

test('FrameLoop does not schedule a new frame when stopped during callback', () => {
  let frameCallback = null;
  let scheduled = 0;
  const loop = new FrameLoop({
    now: () => 0,
    requestFrame(callback) {
      scheduled++;
      frameCallback = callback;
      return scheduled;
    },
    cancelFrame() {},
    onFrame() {
      loop.stop();
    },
  });

  loop.start();
  frameCallback(1);
  assert.equal(scheduled, 1);
  assert.equal(loop.running, false);
});

function createMockTexture(label, log) {
  return {
    label,
    createView() {
      const view = { label: `${label}:view` };
      log.push(['createView', label, view]);
      return view;
    },
    destroy() {
      log.push(['destroyTexture', label]);
    },
  };
}
