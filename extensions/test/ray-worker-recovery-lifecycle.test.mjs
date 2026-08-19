import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const compiled = mkdtempSync(join(tmpdir(), 'haiyue-ray-g08-'));
mkdirSync(join(compiled, 'node_modules/@haiyue'), { recursive: true });
symlinkSync(resolve(root, 'node_modules/wgpu-matrix'), join(compiled, 'node_modules/wgpu-matrix'), 'junction');
symlinkSync(resolve(root, 'engine'), join(compiled, 'node_modules/@haiyue/engine'), 'junction');
process.on('exit', () => rmSync(compiled, { recursive: true, force: true }));
execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', '@webgpu/types', '--rootDir', resolve(root, 'extensions/src'), '--outDir', compiled, resolve(root, 'extensions/src/ray-tracing/worker/index.ts'), resolve(root, 'extensions/src/ray-tracing/lifecycle/index.ts')], { cwd: root, stdio: 'pipe' });
const workerApi = await import(pathToFileURL(join(compiled, 'ray-tracing/worker/index.js')));
const lifecycle = await import(pathToFileURL(join(compiled, 'ray-tracing/lifecycle/index.js')));
const acceleration = await import(pathToFileURL(join(compiled, 'ray-tracing/acceleration/index.js')));

class ControlledWorker {
  listeners = new Map(); messages = []; terminateCalls = 0;
  constructor(mode = 'manual') { this.mode = mode; this.runtime = new workerApi.RayAccelerationWorkerRuntime(); }
  postMessage(message, transfer = []) { this.messages.push({ message, transfer }); if (message.type === 'cancel') return; if (this.mode === 'crash') { queueMicrotask(() => this.emit('error', new Event('error'))); return; } if (this.mode === 'messageerror') { queueMicrotask(() => this.emit('messageerror', new Event('messageerror'))); return; } if (this.mode === 'protocol') { queueMicrotask(() => this.emit('message', { version: 999, id: message.id, ok: true, value: null })); return; } if (this.mode === 'auto') queueMicrotask(() => this.respondTo(message)); }
  respondTo(message) { if (message.type === 'releaseRayAccelerationOwner') return this.emit('message', { version: 1, id: message.id, ok: true, value: { released: this.runtime.release(message.ownerId) } }); const value = this.runtime.build(message.request); this.emit('message', { version: 1, id: message.id, ok: true, value }); }
  addEventListener(type, listener) { let values = this.listeners.get(type); if (!values) this.listeners.set(type, values = new Set()); values.add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, value) { const event = type === 'message' ? { data: value } : value; for (const listener of [...this.listeners.get(type) ?? []]) listener(event); }
  terminate() { this.terminateCalls++; this.runtime.destroy(); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0); }
}

test('Worker DTO transfer is plain, packed output remains valid, and incremental state survives cloned transfer buffers', () => {
  const source = snapshot(); const serialized = workerApi.serializeRaySceneSnapshot(source);
  assert.equal(serialized.transfer.length, 1); assert.ok(serialized.snapshot.geometries[0].positions instanceof Float64Array);
  const runtime = new workerApi.RayAccelerationWorkerRuntime();
  const first = runtime.build(request('scene', 1, serialized.snapshot)); assert.ok(first.packed); assert.equal(first.updateKind, 'initial-build'); assert.ok(first.transferBytes > 0);
  const packed = workerApi.deserializePackedAcceleration(first.packed); assert.equal(packed.fingerprint, first.packed.fingerprint);
  const directBuilder = new acceleration.RayAccelerationBuilder(); const direct = directBuilder.update(source); assert.ok(direct.snapshot); assert.equal(packed.fingerprint, direct.snapshot.packed.fingerprint); directBuilder.destroy();
  const secondDto = workerApi.serializeRaySceneSnapshot(source).snapshot; const second = runtime.build(request('scene', 2, secondDto));
  assert.equal(second.updateKind, 'unchanged'); assert.ok(second.packed); assert.equal(runtime.liveOwnerCount, 1);
  assert.equal(runtime.release('scene'), true); assert.equal(runtime.liveOwnerCount, 0); runtime.destroy(); runtime.destroy();
});

test('latest-wins aborts the previous generation and classifies its late reply without writeback', async () => {
  const controlled = new ControlledWorker(); const created = workerApi.RayAccelerationWorkerClient.create(() => controlled); const client = created.client;
  const first = client.build('scene', snapshot()); const firstMessage = controlled.messages[0].message;
  const second = client.build('scene', snapshot({ fingerprint: 'scene:2', revision: 'r2' })); const secondMessage = controlled.messages.findLast(value => value.message.type === 'buildRayAcceleration').message;
  await assert.rejects(first, error => error.name === 'AbortError');
  controlled.respondTo(firstMessage); controlled.respondTo(secondMessage); const result = await second;
  assert.equal(result.generation, 2); assert.equal(result.sourceFingerprint, 'scene:2'); assert.ok(client.diagnostics.some(value => value.code === 'RAY_WORKER_STALE_REPLY'));
  controlled.mode = 'auto'; await client.releaseOwner('scene'); client.dispose(); client.dispose(); assert.equal(client.pendingCount, 0); assert.equal(client.liveOwnerCount, 0); assert.equal(controlled.listenerCount(), 0); assert.equal(controlled.terminateCalls, 1);
});

test('worker crash, messageerror, and protocol mismatch recreate once and replay only the current source revision', async () => {
  for (const fault of ['crash', 'messageerror', 'protocol']) {
    const workers = [new ControlledWorker(fault), new ControlledWorker('auto')]; let index = 0;
    const client = workerApi.RayAccelerationWorkerClient.create(() => workers[index++], { maxRecoveryAttempts: 1 }).client;
    const result = await client.build('scene', snapshot()); assert.ok(result.packed); assert.equal(result.generation, 1);
    const expected = fault === 'crash' ? 'RAY_WORKER_CRASH' : fault === 'messageerror' ? 'RAY_WORKER_MESSAGE_ERROR' : 'RAY_WORKER_PROTOCOL_ERROR';
    assert.ok(client.diagnostics.some(value => value.code === expected)); assert.ok(client.diagnostics.some(value => value.code === 'RAY_WORKER_RECOVERY_STARTED')); assert.ok(client.diagnostics.some(value => value.code === 'RAY_WORKER_RECOVERY_COMPLETED'));
    assert.equal(workers[0].terminateCalls, 1); client.dispose(); assert.equal(workers[1].terminateCalls, 1);
  }
});

test('queue overflow never masquerades as recovery and failed Worker recreation is exact', async () => {
  const blocked = new ControlledWorker(); const queued = workerApi.RayAccelerationWorkerClient.create(() => blocked, { maxPending: 1 }).client;
  const active = queued.build('a', snapshot());
  await assert.rejects(queued.build('b', snapshot({ fingerprint: 'b', revision: 'b' })), error => error.code === 'E_WORKER_PROTOCOL_INVALID');
  assert.ok(queued.diagnostics.some(value => value.code === 'RAY_WORKER_QUEUE_OVERFLOW')); assert.ok(!queued.diagnostics.some(value => value.code === 'RAY_WORKER_RECOVERY_STARTED'));
  const activeRejection = assert.rejects(active, error => error.name === 'AbortError'); blocked.mode = 'auto'; await queued.releaseOwner('a'); await activeRejection; queued.dispose();

  const crashed = new ControlledWorker('crash'); let calls = 0; const failed = workerApi.RayAccelerationWorkerClient.create(() => { calls++; if (calls > 1) throw new Error('factory-failed'); return crashed; }, { maxRecoveryAttempts: 1 }).client;
  await assert.rejects(failed.build('scene', snapshot()), error => error.code === 'E_WORKER_PROTOCOL_INVALID'); assert.ok(failed.diagnostics.some(value => value.code === 'RAY_WORKER_RECOVERY_FAILED' && value.context.cause === 'factory-failed')); failed.dispose();

  const racingWorkers = [new ControlledWorker(), new ControlledWorker('auto')]; let racingIndex = 0;
  const racing = workerApi.RayAccelerationWorkerClient.create(() => racingWorkers[racingIndex++], { maxPending: 1, maxRecoveryAttempts: 1 }).client;
  const racingActive = racing.build('active', snapshot()); const overflow = racing.build('overflow', snapshot({ fingerprint: 'overflow', revision: 'overflow' }));
  racingWorkers[0].emit('error', new Event('error'));
  await assert.rejects(overflow, error => error.code === 'E_WORKER_PROTOCOL_INVALID'); assert.ok((await racingActive).packed);
  assert.equal(racingIndex, 2); assert.equal(racing.diagnostics.filter(value => value.code === 'RAY_WORKER_RECOVERY_STARTED').length, 1); racing.dispose();

  const repeated = [new ControlledWorker('crash'), new ControlledWorker('crash')]; let repeatedIndex = 0; const exhausted = workerApi.RayAccelerationWorkerClient.create(() => repeated[repeatedIndex++], { maxRecoveryAttempts: 1 }).client;
  await assert.rejects(exhausted.build('scene', snapshot()), error => error.code === 'E_WORKER_PROTOCOL_INVALID'); assert.ok(exhausted.diagnostics.some(value => value.code === 'RAY_WORKER_RECOVERY_FAILED' && value.context.attempts === 1)); exhausted.dispose();
});

test('device loss recreates a clean generation, resets history, and destroys resources in reverse order', async () => {
  const order = []; const firstDevice = gpuDevice('first'); const secondDevice = gpuDevice('second');
  const owner = new lifecycle.RayDeviceRecoveryOwner({ label: 'ray-runtime', maxRecoveryAttempts: 1, acquireDevice: async () => secondDevice,
    create: async (_device, _source, context) => ({ historyGeneration: context.generation, resources: [resource('buffers', order, 2), resource('history', order, 3)] }) });
  const initial = await owner.initialize(firstDevice, { revision: 1 }); assert.equal(initial.status, 'ready'); assert.equal(owner.liveResourceCount, 5);
  firstDevice.lose('unknown', 'injected'); const recovered = await waitFor(async () => owner.awaitIdle()); assert.equal(recovered.status, 'ready'); assert.ok(owner.generation > initial.generation); assert.deepEqual(order.slice(0, 2), ['history', 'buffers']); assert.equal(owner.liveResourceCount, 5);
  owner.destroy(); owner.destroy(); assert.equal(owner.liveResourceCount, 0); assert.deepEqual(order.slice(-2), ['history', 'buffers']); assert.ok(owner.diagnostics.some(value => value.code === 'RAY_DEVICE_LOST')); assert.ok(owner.diagnostics.some(value => value.code === 'RAY_DEVICE_RECOVERY_COMPLETED'));
});

test('late GPU creation cannot cross generation and bounded acquisition failure exhausts visibly', async () => {
  const first = gpuDevice('first'); const second = gpuDevice('second'); const pending = deferred(); const disposed = [];
  const owner = new lifecycle.RayDeviceRecoveryOwner({ label: 'late-owner', create: async (device, _source, context) => device === first ? pending.promise : ({ historyGeneration: context.generation, resources: [resource('new', disposed, 1)] }) });
  const old = owner.initialize(first, {}); const current = await owner.recoverWith(second); assert.equal(current.status, 'ready');
  pending.resolve({ historyGeneration: 1, resources: [resource('late', disposed, 1)] }); assert.equal((await old).status, 'stale'); assert.ok(disposed.includes('late')); assert.equal(owner.liveResourceCount, 1); owner.destroy();

  const lost = gpuDevice('lost'); let attempts = 0; const exhausted = new lifecycle.RayDeviceRecoveryOwner({ label: 'exhausted', maxRecoveryAttempts: 2, acquireDevice: async () => { attempts++; throw new Error(`no-device-${attempts}`); }, create: async (_device, _source, context) => ({ historyGeneration: context.generation, resources: [] }) });
  await exhausted.initialize(lost, {}); lost.lose('unknown', 'gone'); const failure = await waitFor(async () => exhausted.awaitIdle()); assert.equal(failure.status, 'failed'); assert.equal(attempts, 2); assert.ok(exhausted.diagnostics.some(value => value.code === 'RAY_DEVICE_RECOVERY_EXHAUSTED')); exhausted.destroy();

  const pendingDestroy = deferred(); const destroyedOrder = []; const destroyOwner = new lifecycle.RayDeviceRecoveryOwner({ label: 'destroy-pending', create: async (_device, _source, context) => { const value = await pendingDestroy.promise; return { historyGeneration: context.generation, resources: [resource(value, destroyedOrder, 1)] }; } });
  const destroyResult = destroyOwner.initialize(gpuDevice('pending'), {}); destroyOwner.destroy(); pendingDestroy.resolve('late-after-destroy'); assert.equal((await destroyResult).status, 'destroyed'); assert.deepEqual(destroyedOrder, ['late-after-destroy']); assert.equal(destroyOwner.liveResourceCount, 0);
});

test('worker source freezes version, cancellation, release, transferable response, and runtime destruction seams', () => {
  const source = workerApi.createRayAccelerationWorkerSource('/extensions/ray-tracing.js');
  for (const token of ["request.version !== 1", "request.type === 'cancel'", 'active.has(request.id)', 'active.delete(request.id)', "releaseRayAccelerationOwner", 'Object.values(value.packed.buffers)', 'runtime.build']) assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

const identity = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function snapshot(overrides = {}) { const fingerprint = overrides.fingerprint ?? 'scene:1'; return Object.freeze({ schemaVersion: 1, sourceRevision: Object.freeze({ worldId: 1, structureVersion: 1, componentChangeRevision: 0 }), revision: overrides.revision ?? 'r1', fingerprint, geometries: Object.freeze([{ kind: 'triangle-mesh', geometryId: 'g', revision: 1, positions: Object.freeze([-1, -1, 0, 1, -1, 0, 0, 1, 0]), normals: null, indices: null, primitiveCount: 1 }]), instances: Object.freeze([{ instanceId: 'i', entityId: 'e', geometryId: 'g', geometryRevision: 1, transform: identity }]), analyticPrimitives: Object.freeze([]), provenance: Object.freeze([{ instanceId: 'i', entityId: 'e', meshComponentId: 1, hierarchyVersion: 0, transformLocalVersion: 0, material: Object.freeze({ materialId: 'm', revision: 0, type: 'basic' }) }]), diagnostics: Object.freeze([]) }); }
function request(ownerId, generation, dto) { return { format: workerApi.RAY_ACCELERATION_WORKER_REQUEST_FORMAT, ownerId, generation, sourceFingerprint: dto.fingerprint, forceRebuild: false, snapshot: dto }; }
function resource(label, order, count) { let destroyed = false; return { label, liveResourceCount: count, ownedBytes: count * 16, destroy() { if (destroyed) return; destroyed = true; order.push(label); this.liveResourceCount = 0; } }; }
function gpuDevice(label) { const lost = deferred(); return { label, lost: lost.promise, destroyCalls: 0, destroy() { this.destroyCalls++; }, lose(reason, message) { lost.resolve({ reason, message }); } }; }
function deferred() { let resolvePromise, rejectPromise; const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; }); return { promise, resolve: resolvePromise, reject: rejectPromise }; }
async function waitFor(read) { for (let index = 0; index < 100; index++) { const value = await read(); if (value) return value; await new Promise(resolveWait => setTimeout(resolveWait, 0)); } throw new Error('timed out'); }
