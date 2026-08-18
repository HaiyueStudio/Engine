import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AssetManager,
  EngineErrorCode,
  EnginePluginHost,
  GPUResourceTracker,
  getEngineGPUResourceTracker,
  HaiyueEngine,
} from '../dist/experimental.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createDevice(id, log) {
  const lost = deferred();
  const device = {
    id,
    features: new Set(),
    lost: lost.promise,
    queue: {
      onSubmittedWorkDone: () => Promise.resolve(),
      copyExternalImageToTexture() {},
    },
    createTexture(descriptor) {
      const texture = {
        descriptor,
        createView: () => ({ texture }),
        destroy() { log.push(`texture:destroy:${id}`); },
      };
      log.push(`texture:create:${id}`);
      return texture;
    },
    createBuffer(descriptor) {
      return { descriptor, destroy() { log.push(`buffer:destroy:${id}`); } };
    },
    createQuerySet(descriptor) {
      return { descriptor, count: descriptor.count, destroy() { log.push(`query:destroy:${id}`); } };
    },
    destroy() { log.push(`device:destroy:${id}`); },
    lose(message = `lost:${id}`) {
      lost.resolve({ reason: 'unknown', message });
    },
  };
  return device;
}

function createEngineHarness({ failRecovery = false } = {}) {
  const log = [];
  const first = createDevice('first', log);
  const second = createDevice('second', log);
  let requestCount = 0;
  const adapter = {
    features: new Set(),
    requestDevice: async () => requestCount === 1 ? first : second,
  };
  const gpu = {
    async requestAdapter() {
      requestCount++;
      if (failRecovery && requestCount > 1) return null;
      return adapter;
    },
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
  const context = {
    configure({ device }) { log.push(`context:configure:${device.id}`); },
    unconfigure() { log.push('context:unconfigure'); },
    getCurrentTexture: () => ({ createView: () => ({}) }),
  };
  const canvas = {
    width: 1,
    height: 1,
    clientWidth: 1,
    clientHeight: 1,
    getContext: type => type === 'webgpu' ? context : null,
    getBoundingClientRect: () => ({ width: 16, height: 9 }),
    addEventListener() {},
    removeEventListener() {},
  };
  const engine = new HaiyueEngine({ canvas, gpu, timestampQuery: false, devicePixelRatio: 1 });
  return { engine, first, second, log, get requestCount() { return requestCount; } };
}

test('Engine canvas strings support bare IDs and CSS selectors', () => {
  const previousDocument = globalThis.document;
  const directCanvas = { kind: 'direct-canvas' };
  const idCanvas = { kind: 'id-canvas', localName: 'canvas' };
  const selectorCanvas = { kind: 'selector-canvas', localName: 'canvas' };
  const panel = { kind: 'panel', localName: 'div' };
  const calls = [];
  const engines = [];

  globalThis.document = {
    getElementById(value) {
      calls.push(`id:${value}`);
      return value === 'canvas' ? idCanvas : null;
    },
    querySelector(value) {
      calls.push(`selector:${value}`);
      if (value === '##invalid') throw new SyntaxError('Invalid selector');
      if (value === '#canvas' || value === '.game-canvas' || value === '[data-render="main"]') return selectorCanvas;
      if (value === '#panel') return panel;
      return null;
    },
  };

  try {
    const direct = new HaiyueEngine({ canvas: directCanvas });
    const byId = new HaiyueEngine({ canvas: ' canvas ' });
    const byHash = new HaiyueEngine({ canvas: '#canvas' });
    const bySelectorFallback = new HaiyueEngine({ canvas: '.game-canvas' });
    const byAttribute = new HaiyueEngine({ canvas: '[data-render="main"]' });
    engines.push(direct, byId, byHash, bySelectorFallback, byAttribute);

    assert.equal(direct.canvas, directCanvas);
    assert.equal(byId.canvas, idCanvas);
    assert.equal(byHash.canvas, selectorCanvas);
    assert.equal(bySelectorFallback.canvas, selectorCanvas);
    assert.equal(byAttribute.canvas, selectorCanvas);
    for (const target of ['', '#missing', '#panel', '##invalid']) {
      assert.throws(
        () => new HaiyueEngine({ canvas: target }),
        error => error.code === EngineErrorCode.WebGpuContextUnavailable
          && error.path === 'options.canvas',
      );
    }
    assert.deepEqual(calls, [
      'id:canvas',
      'selector:#canvas',
      'id:.game-canvas',
      'selector:.game-canvas',
      'id:[data-render="main"]',
      'selector:[data-render="main"]',
      'selector:#missing',
      'selector:#panel',
      'selector:##invalid',
    ]);
  } finally {
    for (const engine of engines) engine.destroy();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('GPU owner scopes expose auditable records and release idempotently', () => {
  const tracker = new GPUResourceTracker();
  const destroyed = [];
  const scope = tracker.createScope('system', 'unit-renderer');
  scope.trackBuffer({ destroy: () => destroyed.push('buffer') }, 'vertices', 256);
  scope.trackTexture({ destroy: () => destroyed.push('texture') }, 'albedo', 1024);

  assert.deepEqual(scope.usage, { buffers: 1, textures: 1, querySets: 0, estimatedBytes: 1280 });
  assert.deepEqual(tracker.getResources(scope.owner).map(resource => resource.label), ['vertices', 'albedo']);
  scope.release();
  scope.release();
  assert.deepEqual(destroyed, ['buffer', 'texture']);
  assert.deepEqual(tracker.getUsage(), { buffers: 0, textures: 0, querySets: 0, estimatedBytes: 0 });
  assert.throws(
    () => scope.trackBuffer({ destroy() {} }, 'late', 1),
    error => error.code === EngineErrorCode.ResourceOwnerReleased,
  );
});

test('Engine recovers device, render targets, active scene, and registered GPU participants', async () => {
  const previousUsage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1 };
  const harness = createEngineHarness();
  const { engine, first, second } = harness;
  const states = [];
  const phases = [];
  const participantCalls = [];
  let recoveryObservedFromLostEvent = null;
  engine.on('state-change', event => states.push(event.detail.state));
  engine.on('recovery-progress', event => phases.push(event.detail.phase));
  engine.on('device-lost', () => { recoveryObservedFromLostEvent = engine.waitForRecovery(); });

  await Promise.all([engine.init(), engine.init()]);
  assert.equal(harness.requestCount, 1);
  const scene = engine.createScene({ name: 'RecoveryScene', render3D: false, render2D: false, gui: false });
  engine.switchScene(scene);
  engine.registerDeviceRecoveryParticipant({
    recoveryLabel: 'unit-participant',
    recoverySource: { descriptor: 'cpu-copy' },
    suspendForDeviceLoss() { participantCalls.push('suspend'); },
    recoverGpuResource(device) { participantCalls.push(`recover:${device.id}`); },
  });

  first.lose();
  await Promise.resolve();
  await engine.waitForRecovery();
  await recoveryObservedFromLostEvent;

  assert.equal(engine.state, 'ready');
  assert.equal(engine.device, second);
  assert.equal(scene.state, 'active');
  assert.deepEqual(participantCalls, ['suspend', 'recover:second']);
  assert.equal(phases.at(-1), 'ready');
  assert.deepEqual(states, ['initializing', 'ready', 'lost', 'recovering', 'ready']);
  assert.equal(harness.requestCount, 2);

  engine.destroy();
  engine.destroy();
  assert.equal(engine.state, 'destroyed');
  assert.deepEqual(getEngineGPUResourceTracker(engine).getUsage(), { buffers: 0, textures: 0, querySets: 0, estimatedBytes: 0 });
  assert.throws(() => engine.run(), error => error.code === EngineErrorCode.EngineDestroyed);
  globalThis.GPUTextureUsage = previousUsage;
});

test('Engine enters failed after unrecoverable device replacement and rejects public rendering APIs', async () => {
  const previousUsage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1 };
  const { engine, first } = createEngineHarness({ failRecovery: true });
  let failure = null;
  engine.on('recovery-failed', event => { failure = event.detail.error; });
  await engine.init();
  first.lose('adapter unavailable');
  await Promise.resolve();
  await engine.waitForRecovery();

  assert.equal(engine.state, 'failed');
  assert.equal(failure.code, EngineErrorCode.EngineRecoveryFailed);
  assert.deepEqual(getEngineGPUResourceTracker(engine).getUsage(), { buffers: 0, textures: 0, querySets: 0, estimatedBytes: 0 });
  assert.throws(() => engine.getRenderPassDescriptor(), error => error.code === EngineErrorCode.EngineInvalidState);
  assert.throws(() => engine.createScene(), error => error.code === EngineErrorCode.EngineInvalidState);
  engine.destroy();
  assert.deepEqual(getEngineGPUResourceTracker(engine).getUsage(), { buffers: 0, textures: 0, querySets: 0, estimatedBytes: 0 });
  globalThis.GPUTextureUsage = previousUsage;
});

test('Consecutive Scene switches use active/inactive/destroyed transitions and leave no owned resources', async () => {
  const previousUsage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1 };
  const { engine } = createEngineHarness();
  await engine.init();
  let previous = null;
  for (let index = 0; index < 12; index++) {
    const scene = engine.createScene({ name: `Switch-${index}`, render3D: false, render2D: false, gui: false });
    engine.switchScene(scene, { destroyPrevious: true });
    assert.equal(scene.state, 'active');
    if (previous) assert.equal(previous.state, 'destroyed');
    previous = scene;
  }
  engine.switchScene(null, { destroyPrevious: true });
  assert.equal(previous.state, 'destroyed');
  assert.equal(engine.activeScene, null);
  engine.destroy();
  assert.deepEqual(getEngineGPUResourceTracker(engine).getUsage(), { buffers: 0, textures: 0, querySets: 0, estimatedBytes: 0 });
  assert.equal(engine.assetManager, undefined);
  globalThis.GPUTextureUsage = previousUsage;
});

test('Scene golden path updates the active scene exactly once between frame hooks and clears lifecycle owners', async () => {
  const previousUsage = globalThis.GPUTextureUsage;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1 };
  const callbacks = new Map();
  let nextFrameId = 0;
  globalThis.requestAnimationFrame = callback => {
    const id = ++nextFrameId;
    callbacks.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => callbacks.delete(id);

  const { engine } = createEngineHarness();
  const foreignHarness = createEngineHarness();
  try {
    await engine.init();
    const first = engine.createScene({ name: 'Golden first', render3D: false, render2D: false, gui: false });
    const second = engine.createScene({ name: 'Golden second', render3D: false, render2D: false, gui: false });
    const foreign = foreignHarness.engine.createScene({ name: 'Foreign', render3D: false, render2D: false, gui: false });
    const frames = [];
    first.world.update = () => { frames.push('first'); return first.world; };
    second.world.update = () => { frames.push('second'); return second.world; };
    engine.on('update', () => frames.push('before'));
    engine.on('after-update', () => frames.push('after'));

    engine.switchScene(first).run();
    const firstCallback = callbacks.get(nextFrameId);
    assert.ok(firstCallback);
    callbacks.delete(nextFrameId);
    firstCallback(16);
    assert.deepEqual(frames, ['before', 'first', 'after']);

    engine.switchScene(second, { destroyPrevious: true });
    const secondCallback = callbacks.get(nextFrameId);
    assert.ok(secondCallback);
    callbacks.delete(nextFrameId);
    secondCallback(32);
    assert.deepEqual(frames.slice(3), ['before', 'second', 'after']);
    assert.equal(first.state, 'destroyed');
    assert.throws(
      () => engine.switchScene(foreign),
      error => error.code === EngineErrorCode.SceneInvalidState,
    );
    assert.equal(engine.activeScene, second, 'failed switches must leave the current scene active');

    engine.destroy();
    assert.equal(second.state, 'destroyed');
    assert.equal(engine.listenerCount('update'), 0);
    assert.equal(engine.listenerCount('after-update'), 0);
    assert.equal(engine.assetManager, undefined);
    assert.deepEqual(getEngineGPUResourceTracker(engine).getUsage(), { buffers: 0, textures: 0, querySets: 0, estimatedBytes: 0 });
  } finally {
    engine.destroy();
    foreignHarness.engine.destroy();
    globalThis.GPUTextureUsage = previousUsage;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test('Asset jobs abort without late owner writeback and recover retained CPU descriptors', async () => {
  const firstDevice = { id: 'first' };
  const secondDevice = { id: 'second' };
  const manager = new AssetManager(firstDevice);
  const disposed = [];
  manager.registerLoader({
    type: 'unit/gpu',
    async load(url, context) {
      context.setPhase('parsing');
      await Promise.resolve();
      if (context.signal.aborted) throw context.signal.reason;
      context.setPhase('uploading');
      return { url, device: context.device.id };
    },
    dispose(value) { disposed.push(value.device); },
  });
  const handle = await manager.loadAsset('unit/gpu', '/asset.bin');
  assert.equal(handle.value.device, 'first');
  manager.suspendForDeviceLoss();
  assert.equal(manager.getJobState(handle.key), 'queued');
  assert.throws(() => handle.value, error => error.code === EngineErrorCode.AssetNotReady);
  assert.deepEqual(await manager.recoverDevice(secondDevice, new AbortController().signal), []);
  assert.equal(handle.value.device, 'second');
  assert.deepEqual(disposed, ['first']);
  handle.release();
  assert.equal(manager.size, 0);
  assert.equal(manager.pendingJobCount, 0);
});

test('Scene destruction aborts pending load assignment and reaches a terminal state once', async () => {
  const load = deferred();
  let released = 0;
  let assigned = 0;
  const engine = {
    defaults: {},
    clearColor: { r: 0, g: 0, b: 0, a: 1 },
    reverseZ: false,
    msaaSamples: 1,
    assetManager: {
      resolveType: () => 'unit/data',
      loadUrl: async () => load.promise,
    },
    getDepthFormat: () => 'depth24plus',
    getOutputView() {},
    getRenderPassDescriptor() {},
  };
  const { Scene } = await import('../dist/experimental.js');
  const scene = new Scene(engine, { render3D: false, render2D: false, gui: false });
  const pending = scene.load({
    url: '/late.bin',
    assign: () => { assigned++; },
  });
  scene.destroy();
  scene.destroy();
  load.resolve({ key: 'late', value: { late: true }, release: () => { released++; } });
  await assert.rejects(pending, error => error.code === EngineErrorCode.SceneDestroyed);
  assert.equal(scene.state, 'destroyed');
  assert.equal(assigned, 0);
  assert.equal(released, 1);
  assert.throws(() => scene.add({}), error => error.code === EngineErrorCode.SceneDestroyed);
});

test('Plugin graph rejects cycles before install side effects', () => {
  const host = new EnginePluginHost({
    scope: 'engine',
    installHint: 'unit',
    createContext: tracker => ({
      scope: 'engine', engine: {}, rollback: tracker, unregister: () => tracker.unregister(),
      hasPlugin: name => host.hasPlugin(name), registerComponent() {}, registerAssetLoader() {},
    }),
    hasDependency: name => host.hasPlugin(name),
  });
  assert.throws(
    () => host.installPlugin({ name: 'cycle', version: '1.0.0', dependencies: ['cycle'] }),
    error => error.code === EngineErrorCode.PluginDependencyCycle,
  );
  assert.equal(host.hasPlugin('cycle'), false);
});
