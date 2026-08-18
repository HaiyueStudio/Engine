import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAssetWorkerFirst,
  WorkerChannel,
  WORKER_CHANNEL_PROTOCOL_VERSION,
} from '../dist/experimental/async.js';
import { EngineError, EngineErrorCode } from '../dist/index.js';

class ControlledWorker {
  listeners = new Map();
  messages = [];
  terminateCalls = 0;

  postMessage(message, transfer) {
    this.messages.push({ message, transfer: transfer ?? [] });
  }

  addEventListener(type, listener) {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, listeners = new Set());
    listeners.add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, value) {
    const event = type === 'message' ? { data: value } : value;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  respond(id, value) {
    this.emit('message', { version: WORKER_CHANNEL_PROTOCOL_VERSION, id, ok: true, value });
  }

  terminate() { this.terminateCalls++; }
}

function createChannel(worker, options = {}) {
  return new WorkerChannel(worker, {
    label: 'contract worker',
    path: 'contract.worker',
    maxPending: 4,
    ...options,
  });
}

const stringTask = overrides => ({
  validate: value => typeof value === 'string',
  ...overrides,
});

test('WorkerChannel validates versioned responses and transferable ownership', async () => {
  const worker = new ControlledWorker();
  const channel = createChannel(worker);
  const buffer = new ArrayBuffer(8);
  const pending = channel.request('decode', { label: 'a' }, stringTask({ transfer: [buffer] }));
  const request = worker.messages[0];
  assert.equal(request.message.version, 1);
  assert.equal(request.message.type, 'decode');
  assert.equal(request.transfer[0], buffer);
  worker.respond(request.message.id, 'done');
  assert.equal(await pending, 'done');
  assert.equal(channel.pendingCount, 0);
  channel.dispose();
});

test('WorkerChannel resolves out of order and latest-wins retires stale work', async () => {
  const worker = new ControlledWorker();
  const channel = createChannel(worker);
  const first = channel.request('parse', { value: 1 }, stringTask());
  const second = channel.request('parse', { value: 2 }, stringTask());
  worker.respond(worker.messages[1].message.id, 'second');
  worker.respond(worker.messages[0].message.id, 'first');
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);

  const stale = channel.request('preview', { generation: 1 }, stringTask({ latestKey: 'preview' }));
  const latest = channel.request('preview', { generation: 2 }, stringTask({ latestKey: 'preview' }));
  await assert.rejects(stale, error => error.name === 'AbortError' && error.cause === 'superseded:preview');
  const latestRequest = worker.messages.findLast(entry => entry.message.type === 'preview');
  worker.respond(latestRequest.message.id, 'latest');
  assert.equal(await latest, 'latest');
  assert.equal(worker.messages.some(entry => entry.message.type === 'cancel'), true);
  channel.dispose();
});

test('WorkerChannel covers abort-before-send, abort-in-flight and bounded overflow', async () => {
  const worker = new ControlledWorker();
  const channel = createChannel(worker, { maxPending: 1 });
  const before = new AbortController();
  before.abort('closed');
  await assert.rejects(
    channel.request('parse', {}, stringTask({ signal: before.signal })),
    error => error.name === 'AbortError' && error.cause === 'closed',
  );
  assert.equal(worker.messages.length, 0);

  const activeController = new AbortController();
  const active = channel.request('parse', {}, stringTask({ signal: activeController.signal }));
  await assert.rejects(
    channel.request('overflow', {}, stringTask()),
    error => error.code === 'E_WORKER_PROTOCOL_INVALID' && error.path === 'contract.worker.queue',
  );
  activeController.abort('owner-left');
  await assert.rejects(active, error => error.name === 'AbortError' && error.cause === 'owner-left');
  assert.equal(channel.pendingCount, 0);
  assert.equal(worker.messages.at(-1).message.type, 'cancel');
  channel.dispose();
});

test('WorkerChannel retires version mismatch, worker crash and messageerror exactly once', async () => {
  for (const fault of ['version', 'error', 'messageerror']) {
    const worker = new ControlledWorker();
    const channel = createChannel(worker);
    const pending = channel.request('parse', {}, stringTask());
    if (fault === 'version') {
      worker.emit('message', { version: 999, id: worker.messages[0].message.id, ok: true, value: 'bad' });
    } else {
      worker.emit(fault, new Event(fault));
    }
    await assert.rejects(
      pending,
      error => error.code === 'E_WORKER_PROTOCOL_INVALID'
        && error.path === `contract.worker.${fault === 'version' ? 'response' : fault}`,
    );
    assert.equal(channel.isFaulted, true);
    assert.equal(channel.pendingCount, 0);
    assert.equal(worker.terminateCalls, 1);
    channel.dispose();
    channel.dispose();
    assert.equal(worker.terminateCalls, 1);
  }
});

test('parseAssetWorkerFirst reports an allowed infrastructure fallback before using the main parser', async () => {
  const diagnostics = [];
  const value = await parseAssetWorkerFirst({
    parser: { type: 'fixture/data', parse: input => `main:${input}` },
    input: 'payload',
    context: { source: '/fixture.bin' },
    worker: async () => {
      throw new EngineError(EngineErrorCode.WorkerProtocolInvalid, 'worker unavailable');
    },
    onFallback: diagnostic => diagnostics.push(diagnostic),
  });
  assert.equal(value, 'main:payload');
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(
    { kind: diagnostics[0].kind, parserType: diagnostics[0].parserType, source: diagnostics[0].source },
    { kind: 'worker-infrastructure-fallback', parserType: 'fixture/data', source: '/fixture.bin' },
  );
});
