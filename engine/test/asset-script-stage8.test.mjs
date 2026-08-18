import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetJob, AssetManager, AssetOwnerScope } from '../dist/assets.js';
import {
  DEFAULT_SCRIPT_CAPABILITIES,
  generateScriptRuntimeDeclarations,
  SCRIPT_CAPABILITIES,
  SCRIPT_RUNTIME_COMPLETION_PATHS,
  ScriptComponent,
  ScriptResource,
} from '../dist/components.js';
import {
  Entity,
  World,
} from '../dist/index.js';
import {
  AssetCacheHierarchy,
  AssetUploadScheduler,
  BudgetedAssetCache,
} from '../dist/experimental.js';
import { createMockGpuDevice } from './helpers.mjs';

test('AssetJob owns progress, timeout, priority, and owner cancellation', async () => {
  const owner = new AssetOwnerScope('test-scene');
  const progress = [];
  const job = new AssetJob('model:hero', {
    owner,
    priority: 'interactive',
    timeoutMs: 10,
    onProgress: value => progress.push(value),
  });
  const result = job.start(async context => {
    context.setPhase('parsing');
    context.reportProgress(4, 8);
    return 'ready';
  });
  assert.equal(await result, 'ready');
  assert.equal(job.state, 'ready');
  assert.equal(job.priority, 200);
  assert.equal(progress.some(value => value.phase === 'parsing' && value.ratio === 0.5), true);
  assert.equal(owner.pendingJobCount, 0);

  const cancelled = new AssetJob('model:late', { owner });
  const pending = cancelled.start(() => new Promise(() => {}));
  owner.abort('scene-destroyed');
  await assert.rejects(pending, error => error.code === 'E_ASSET_JOB_ABORTED');
  assert.equal(cancelled.state, 'aborted');

  let resolveLate;
  let disposedLate = 0;
  const late = new AssetJob('model:dispose-late', { disposeLateResult: () => { disposedLate++; } });
  const latePromise = late.start(() => new Promise(resolve => { resolveLate = resolve; }));
  late.abort('owner-left');
  await assert.rejects(latePromise, error => error.code === 'E_ASSET_JOB_ABORTED');
  resolveLate({ gpu: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(disposedLate, 1);

  const closedOwner = new AssetOwnerScope('closed-scene');
  closedOwner.abort('already-closed');
  let executed = false;
  const neverStarted = new AssetJob('model:never-started', { owner: closedOwner });
  await assert.rejects(neverStarted.start(async () => { executed = true; return 'late'; }), error => error.code === 'E_ASSET_JOB_ABORTED');
  assert.equal(executed, false);
});

test('AssetJob rejects phase changes that bypass its authoritative transition table', () => {
  const job = new AssetJob('model:invalid-transition');
  assert.throws(
    () => job.setPhase('uploading'),
    error => error.code === 'E_ASSET_INVALID_DATA'
      && error.path === 'assets.jobs["model:invalid-transition"].state'
      && error.context.from === 'queued'
      && error.context.to === 'uploading',
  );
});

test('AssetManager request cancellation does not abort a deduplicated peer', async () => {
  const manager = new AssetManager(createMockGpuDevice(), undefined, { defaultTimeoutMs: 1000 });
  const firstController = new AbortController();
  let resolveLoad;
  let loadCount = 0;
  const loader = () => new Promise(resolve => {
    loadCount++;
    resolveLoad = resolve;
  });
  const first = manager.load('shared', loader, () => {}, { signal: firstController.signal });
  const second = manager.load('shared', loader, () => {});
  firstController.abort('first-owner-left');
  await assert.rejects(first);
  assert.equal(manager.getRefCount('shared'), 1);
  resolveLoad({ id: 'shared' });
  const handle = await second;
  assert.equal(handle.value.id, 'shared');
  assert.equal(loadCount, 1);
  handle.release();
  assert.equal(manager.pendingJobCount, 0);
});

test('budgeted caches evict unreferenced LRU entries and GPU uploads obey a frame budget', async () => {
  const disposed = [];
  const cache = new BudgetedAssetCache('cpu', { maxBytes: 8, maxEntries: 2 });
  cache.set('retained', 1, 4, { retain: true, dispose: value => disposed.push(value) });
  cache.set('old', 2, 4, { dispose: value => disposed.push(value) });
  cache.set('new', 3, 4, { dispose: value => disposed.push(value) });
  assert.equal(cache.get('retained'), 1);
  assert.equal(cache.get('old'), undefined);
  assert.equal(cache.snapshot().hits, 1);
  assert.equal(cache.snapshot().misses, 1);
  assert.deepEqual(disposed, [2]);
  cache.release('retained');

  const scheduler = new AssetUploadScheduler(8);
  const order = [];
  const low = scheduler.enqueue({ label: 'low', bytes: 6, priority: 'normal', upload: () => order.push('low') });
  const high = scheduler.enqueue({ label: 'high', bytes: 6, priority: 'critical', upload: () => order.push('high') });
  assert.equal(await scheduler.drainFrame(0), 0);
  assert.deepEqual(order, []);
  assert.equal(await scheduler.drainFrame(), 6);
  assert.deepEqual(order, ['high']);
  assert.equal(scheduler.snapshot().pendingTasks, 1);
  await scheduler.drainFrame();
  await Promise.all([low, high]);
  assert.deepEqual(order, ['high', 'low']);
  const uploadSnapshot = scheduler.snapshot();
  assert.equal(uploadSnapshot.uploadCalls, 2);
  assert.equal(uploadSnapshot.drainCalls, 2);
  assert.equal(uploadSnapshot.uploadedBytes, 12);
  assert.equal(uploadSnapshot.maxFrameUploadedBytes, 6);
  assert.equal(uploadSnapshot.peakPendingTasks, 2);
  assert.equal(uploadSnapshot.peakPendingBytes, 12);
  assert.equal(uploadSnapshot.failedTasks, 0);
  assert.equal(uploadSnapshot.cancelledTasks, 0);
  await assert.rejects(
    scheduler.enqueue({ label: 'oversized', bytes: 9, upload: () => {} }),
    error => error.code === 'E_ASSET_INVALID_DATA' && error.path === 'assets.uploads.task.bytes',
  );
});

test('atomic uploads make progress when a drain uses a smaller temporary budget', async () => {
  const scheduler = new AssetUploadScheduler(8);
  const order = [];
  const atomic = scheduler.enqueue({
    label: 'atomic',
    bytes: 6,
    upload: () => order.push('atomic'),
  });
  const trailing = scheduler.enqueue({
    label: 'trailing',
    bytes: 2,
    upload: () => order.push('trailing'),
  });

  assert.equal(await scheduler.drainFrame(4), 6);
  await atomic;
  assert.deepEqual(order, ['atomic']);
  assert.equal(scheduler.snapshot().pendingTasks, 1);
  assert.equal(scheduler.snapshot().maxFrameUploadedBytes, 6);

  assert.equal(await scheduler.drainFrame(4), 2);
  await trailing;
  assert.deepEqual(order, ['atomic', 'trailing']);
  assert.equal(scheduler.snapshot().pendingTasks, 0);
});

test('GPU cache entries are isolated by device and released with their device', () => {
  const caches = new AssetCacheHierarchy({ gpu: { maxBytes: 16, maxEntries: 2 } });
  const firstDevice = createMockGpuDevice();
  const secondDevice = createMockGpuDevice();
  const first = caches.forDevice(firstDevice);
  const second = caches.forDevice(secondDevice);
  first.set('texture', { device: 'first' }, 8);
  second.set('texture', { device: 'second' }, 8);
  assert.equal(first.get('texture').device, 'first');
  assert.equal(second.get('texture').device, 'second');
  caches.releaseDevice(firstDevice);
  assert.equal(first.size, 0);
  assert.equal(second.size, 1);
});

test('script capability contract is minimum-by-default and declarations share its source', () => {
  assert.deepEqual(DEFAULT_SCRIPT_CAPABILITIES, ['read', 'input', 'debug']);
  const declarations = generateScriptRuntimeDeclarations();
  for (const capability of DEFAULT_SCRIPT_CAPABILITIES) assert.match(declarations, new RegExp(`readonly ${capability}:`));
  for (const capability of ['scene', 'asset', 'physics']) assert.doesNotMatch(declarations, new RegExp(`readonly ${capability}:`));
  const fullDeclarations = generateScriptRuntimeDeclarations(SCRIPT_CAPABILITIES);
  for (const capability of SCRIPT_CAPABILITIES) assert.match(fullDeclarations, new RegExp(`readonly ${capability}:`));
  assert.equal(SCRIPT_RUNTIME_COMPLETION_PATHS.includes('api.debug.addDisposer'), true);
  assert.match(declarations, /addDisposer\(/);
});

test('script failure disables only the failing component and reports source identity', () => {
  const errors = [];
  const world = new World('scripts');
  const badEntity = new Entity('Bad');
  const goodEntity = new Entity('Good');
  const resource = new ScriptResource({
    name: 'bad-script',
    sourcePath: 'scripts/bad-script.js',
    scripts: { onUpdate: 'throw new Error("boom")' },
  });
  const bad = new ScriptComponent({}, resource);
  const good = new ScriptComponent({ onUpdate: 'component.state = (component.state || 0) + 1' });
  badEntity.addComponent(bad);
  goodEntity.addComponent(good);
  world.addEntity(badEntity);
  world.addEntity(goodEntity);
  ScriptComponent.enableTrustedProject({ capabilities: ['read', 'debug'], onError: event => errors.push(event) });
  try {
    world.update(16, 16);
    assert.equal(bad.disabled, true);
    assert.equal(good.state, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error.path, `scripts[${resource.id}].onUpdate`);
    assert.equal(errors[0].error.context.entityName, 'Bad');
    assert.equal(errors[0].sourceLocation.source.includes('scripts/bad-script.js'), true);
    resource.setScript('onUpdate', 'component.recovered = true');
    assert.equal(bad.disabled, false);
    assert.equal(bad.faulted, false);
    world.update(32, 16);
    assert.equal(bad.recovered, true);
    assert.equal(good.state, 2);
  } finally {
    ScriptComponent.resetExecutionOptions();
  }
});

test('script hot reload disposes registered side effects before compiling replacement code', () => {
  const world = new World('hot-reload');
  const entity = new Entity('Hot');
  const resource = new ScriptResource({
    name: 'hot',
    scripts: { onUpdate: 'if (!component.bound) { component.bound = true; api.debug.addDisposer(() => component.disposed = (component.disposed || 0) + 1); }' },
  });
  const script = new ScriptComponent({}, resource);
  entity.addComponent(script);
  world.addEntity(entity);
  ScriptComponent.enableTrustedProject({ capabilities: ['debug'] });
  try {
    world.update(16, 16);
    assert.equal(script.disposableCount, 1);
    resource.setScript('onUpdate', 'component.reloaded = true');
    assert.equal(script.disposed, 1);
    assert.equal(script.disposableCount, 0);
    world.update(32, 16);
    assert.equal(script.reloaded, true);
  } finally {
    ScriptComponent.resetExecutionOptions();
  }
});
