import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetManager, AssetWorkerClient, EngineErrorCode } from '../dist/experimental.js';
import { createMockGpuDevice } from './helpers.mjs';

class FakeWorker {
  listeners = new Set();
  requests = [];
  terminated = false;

  addEventListener(type, listener) {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(message) {
    this.requests.push(message);
    queueMicrotask(() => {
      if (message.url === 'fail.txt') {
        this.emit({
          version: 1,
          id: message.id,
          ok: false,
          error: {
            name: 'EngineError',
            domain: 'asset',
            code: 'E_ASSET_LOAD_FAILED',
            message: 'failed in worker',
            recoverable: true,
            recovery: 'retry',
            context: { url: message.url, resourceType: message.type },
            path: 'assetWorker.request',
          },
        });
        return;
      }
      const value = message.type === 'fetchArrayBuffer'
        ? new TextEncoder().encode(`buffer:${message.url}`).buffer
        : message.type === 'fetchJson'
          ? { url: message.url }
          : `text:${message.url}`;
      this.emit({ version: 1, id: message.id, ok: true, value });
    });
  }

  emit(data) {
    for (const listener of this.listeners) listener({ data });
  }

  terminate() {
    this.terminated = true;
  }
}

test('AssetManager de-duplicates concurrent loads and reference counts handles', async () => {
  const disposed = [];
  let loadCount = 0;
  const manager = new AssetManager(createMockGpuDevice());

  const [a, b] = await Promise.all([
    manager.load('asset:a', async () => {
      loadCount++;
      return { id: 'a' };
    }, value => disposed.push(value.id)),
    manager.load('asset:a', async () => {
      loadCount++;
      return { id: 'b' };
    }, value => disposed.push(value.id)),
  ]);

  assert.equal(loadCount, 1);
  assert.equal(a.value, b.value);
  assert.equal(manager.getRefCount('asset:a'), 2);
  assert.deepEqual(manager.getDebugSnapshot().activity, { recordHits: 1, recordMisses: 1 });

  a.release();
  assert.equal(manager.getRefCount('asset:a'), 1);
  assert.deepEqual(disposed, []);

  b.release();
  assert.equal(manager.hasAsset('asset:a'), false);
  assert.deepEqual(disposed, ['a']);
  assert.throws(() => b.value, error => error.code === EngineErrorCode.AssetHandleReleased);
});

test('AssetManager disposes a load that resolves after all handles were released', async () => {
  const disposed = [];
  let resolve;
  const manager = new AssetManager(createMockGpuDevice());
  const pending = manager.load('late', () => new Promise(r => { resolve = r; }), value => disposed.push(value.id));

  assert.equal(manager.getJobState('late'), 'loading');
  pending.catch(() => {});
  const record = manager.getRefCount('late');
  assert.equal(record, 1);

  const handlePromise = pending;
  const earlyHandle = manager.getAsset('late');
  assert.equal(earlyHandle, null);
  resolve({ id: 'late' });
  const handle = await handlePromise;
  handle.release();

  assert.deepEqual(disposed, ['late']);
  assert.equal(manager.getJobState('late'), null);
});

test('AssetManager loadAsset uses registered loaders and reports missing loaders', async () => {
  const manager = new AssetManager(createMockGpuDevice());
  manager.registerLoader({
    type: 'text/plain',
    async load(url) {
      return `loaded:${url}`;
    },
  });

  const handle = await manager.loadAsset('text/plain', '/hello.txt');
  assert.equal(handle.value, 'loaded:/hello.txt');
  handle.release();

  assert.throws(
    () => manager.loadAsset('missing/type', '/x'),
    error => error.code === EngineErrorCode.AssetLoadFailed,
  );
});

test('AssetManager infers loader type by extension, mime type, alias, and matcher', async () => {
  const manager = new AssetManager(createMockGpuDevice());
  const loaded = [];

  manager.registerLoader({
    type: 'model/gltf',
    extensions: ['.gltf', 'glb'],
    mimeTypes: ['model/gltf+json'],
    aliases: ['gltf'],
    async load(url) {
      loaded.push(url);
      return { type: 'model/gltf', url };
    },
  });
  manager.registerLoader({
    type: 'unit/special',
    match: url => url.includes('special-resource'),
    async load(url) {
      return { type: 'unit/special', url };
    },
  });

  assert.equal(manager.resolveType('/models/scene.gltf'), 'model/gltf');
  assert.equal(manager.resolveType('/models/scene.glb?rev=1'), 'model/gltf');
  assert.equal(manager.resolveType('/download', { mimeType: 'model/gltf+json' }), 'model/gltf');
  assert.equal(manager.resolveType('/anything', { alias: 'gltf' }), 'model/gltf');
  assert.equal(manager.resolveType('/special-resource.bin'), 'unit/special');
  assert.equal(manager.resolveType('/unknown.bin'), null);

  const handle = await manager.loadUrl('scene.gltf');
  assert.deepEqual(handle.value, { type: 'model/gltf', url: 'scene.gltf' });
  assert.deepEqual(loaded, ['scene.gltf']);
  assert.equal(manager.hasAsset('asset:model/gltf:scene.gltf'), true);
  handle.release();
});

test('AssetManager supports asset aliases and loader alias cleanup', async () => {
  const manager = new AssetManager(createMockGpuDevice());
  manager.registerLoader({
    type: 'text/plain',
    extensions: ['txt'],
    aliases: ['text'],
    async load(url) {
      return `loaded:${url}`;
    },
  });

  const handle = await manager.loadUrl('hello.txt', { alias: 'greeting' });
  assert.equal(handle.key, 'asset:text/plain:hello.txt');
  assert.equal(manager.resolveAssetKey('greeting'), 'asset:text/plain:hello.txt');
  const aliasHandle = manager.getAsset('greeting');
  assert.equal(aliasHandle.value, 'loaded:hello.txt');
  aliasHandle.release();
  handle.release();

  assert.equal(manager.resolveType('hello.txt'), 'text/plain');
  assert.equal(manager.resolveType('anything', { alias: 'text' }), 'text/plain');
  manager.unregisterLoader('text/plain');
  assert.equal(manager.resolveType('hello.txt'), null);
  assert.equal(manager.resolveType('anything', { alias: 'text' }), null);
});

test('AssetWorkerClient resolves worker fetch requests and reports failures', async () => {
  const fakeWorker = new FakeWorker();
  const client = new AssetWorkerClient(fakeWorker);

  const text = await client.fetchText('hello.txt');
  assert.equal(text, 'text:hello.txt');

  const buffer = await client.fetchArrayBuffer('hello.bin');
  assert.equal(new TextDecoder().decode(buffer), 'buffer:hello.bin');

  const json = await client.fetchJson('hello.json');
  assert.deepEqual(json, { url: 'hello.json' });

  await assert.rejects(
    () => client.fetchText('fail.txt'),
    error => error.code === EngineErrorCode.AssetLoadFailed
      && error.domain === 'asset'
      && error.recovery === 'retry'
      && error.context.url === 'fail.txt'
      && error.path === 'assetWorker.request',
  );

  client.dispose();
  assert.equal(fakeWorker.terminated, true);
});

test('AssetWorkerClient rejects malformed worker responses with a protocol error', async () => {
  const worker = new FakeWorker();
  worker.postMessage = message => queueMicrotask(() => worker.emit({ version: 1, id: message.id, ok: false, error: 'string-only error' }));
  const client = new AssetWorkerClient(worker);

  await assert.rejects(
    () => client.fetchText('bad-response.txt'),
    error => error.code === EngineErrorCode.WorkerProtocolInvalid
      && error.domain === 'worker'
      && error.recovery === 'terminate-runtime'
      && error.path === 'assetWorker.response',
  );
  assert.equal(worker.terminated, true, 'protocol faults retire the worker');
  const valueWorker = new FakeWorker();
  valueWorker.postMessage = message => queueMicrotask(() => valueWorker.emit({ version: 1, id: message.id, ok: true, value: 42 }));
  const valueClient = new AssetWorkerClient(valueWorker);
  await assert.rejects(
    () => valueClient.fetchText('bad-value.txt'),
    error => error.code === EngineErrorCode.WorkerProtocolInvalid
      && error.path === 'assetWorker.response.value',
  );
  client.dispose();
  valueClient.dispose();
});

test('AssetWorkerClient clears pending requests when postMessage throws', async () => {
  const fakeWorker = new FakeWorker();
  fakeWorker.postMessage = () => {
    throw new Error('postMessage failed');
  };
  const client = new AssetWorkerClient(fakeWorker);

  await assert.rejects(
    () => client.fetchText('hello.txt'),
    error => error.code === EngineErrorCode.WorkerProtocolInvalid
      && error.path === 'assetWorker.request'
      && error.cause.message === 'postMessage failed',
  );

  client.dispose();
});

test('AssetManager passes configured worker to registered loaders', async () => {
  const fakeWorker = new FakeWorker();
  const worker = new AssetWorkerClient(fakeWorker);
  const manager = new AssetManager(createMockGpuDevice(), undefined, { worker });

  manager.registerLoader({
    type: 'text/plain',
    extensions: ['txt'],
    async load(url, context) {
      assert.equal(context.worker, worker);
      return context.worker.fetchText(url);
    },
  });

  const handle = await manager.loadUrl('worker.txt');
  assert.equal(handle.value, 'text:worker.txt');
  assert.equal(fakeWorker.requests.length, 1);
  handle.release();
  worker.dispose();
});

test('AssetManager rebuilds cache-keyed compressed texture wrappers during device recovery', async () => {
  const manager = new AssetManager(createMockGpuDevice());
  const disposed = [];
  let loadCount = 0;
  manager.registerLoader({
    type: 'texture/mock-compressed',
    async load() {
      return { generation: ++loadCount };
    },
    dispose(value) {
      disposed.push(value.generation);
    },
  });
  const handle = await manager.loadTexture({
    kind: 'compressed-texture',
    type: 'texture/mock-compressed',
    src: '/texture.ktx2',
  }, { cacheKey: 'stable-texture' });
  assert.equal(handle.value.generation, 1);

  manager.suspendForDeviceLoss();
  assert.throws(() => handle.value, error => error.code === EngineErrorCode.AssetNotReady);
  assert.deepEqual(await manager.recoverDevice(createMockGpuDevice(), new AbortController().signal), []);
  assert.equal(handle.value.generation, 2);
  assert.equal(loadCount, 2);
  assert.deepEqual(disposed, [1]);

  handle.release();
  assert.deepEqual(disposed, [1, 2]);
  manager.dispose();
});
