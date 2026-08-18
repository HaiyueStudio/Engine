import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SpineAssetWorkerClient,
  createSpineAssetWorkerSource,
} from '../dist/experimental-spine-worker.js';

class ControlledWorker {
  listeners = new Map();
  messages = [];
  terminateCalls = 0;

  postMessage(message) { this.messages.push(message); }
  addEventListener(type, listener) {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, listeners = new Set());
    listeners.add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, value) {
    const event = type === 'message' ? { data: value } : value;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  terminate() { this.terminateCalls++; }
}

test('Spine worker client consumes the shared versioned channel and preserves parsed semantics', async () => {
  const worker = new ControlledWorker();
  const client = new SpineAssetWorkerClient(worker);
  const pending = client.loadParsedAsset('/hero.json', '/hero.atlas');
  const request = worker.messages[0];
  assert.deepEqual(
    { version: request.version, type: request.type, jsonUrl: request.jsonUrl, atlasUrl: request.atlasUrl },
    { version: 1, type: 'loadParsedSpineAsset', jsonUrl: '/hero.json', atlasUrl: '/hero.atlas' },
  );
  const parsed = { data: { bones: [{ name: 'root' }] }, regions: [['hero', { page: 'hero.png' }]] };
  worker.emit('message', { version: 1, id: request.id, ok: true, value: parsed });
  assert.deepEqual(await pending, parsed);
  client.dispose();
  client.dispose();
  assert.equal(worker.terminateCalls, 1);
});

test('Spine worker abort and crash retire requests without late writeback', async () => {
  const worker = new ControlledWorker();
  const client = new SpineAssetWorkerClient(worker);
  const controller = new AbortController();
  const aborted = client.loadParsedAsset('/abort.json', '', { signal: controller.signal });
  controller.abort('source-replaced');
  await assert.rejects(aborted, error => error.name === 'AbortError' && error.cause === 'source-replaced');
  assert.equal(worker.messages.at(-1).type, 'cancel');
  assert.equal(worker.messages.at(-1).version, 1);

  const crashed = client.loadParsedAsset('/crash.json', '');
  worker.emit('error', new Event('error'));
  await assert.rejects(
    crashed,
    error => error.code === 'E_WORKER_PROTOCOL_INVALID' && error.path === 'spine.worker.error',
  );
  assert.equal(worker.terminateCalls, 1);
  client.dispose();
  assert.equal(worker.terminateCalls, 1);
});

test('Spine worker source validates and returns protocol version 1 envelopes', () => {
  const source = createSpineAssetWorkerSource('https://cdn.example/extensions/spine.js');
  assert.match(source, /request\.version !== 1/);
  assert.match(source, /version: 1, id: request\.id, ok: true/);
  assert.match(source, /version: 1, id: request\.id, ok: false/);
});
