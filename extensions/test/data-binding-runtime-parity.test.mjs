import assert from 'node:assert/strict';
import test from 'node:test';
import { dataBindingFixture, loadG07Modules } from './data-binding-parity-fixture.mjs';

const { data, runtime } = await loadG07Modules();
const parsed = data.parseHyaDataBinding(dataBindingFixture());

test('default global auto and nested path lookup preserve typed instance identity', () => {
  const converters = converterPort(), model = new runtime.DataBindingRuntime(parsed, { converterPort: converters });
  assert.equal(model.readBinding('b-score'), '2.3'); assert.equal(model.readBinding('b-title-default'), 'default title'); assert.equal(model.readBinding('b-title-global'), 'global title');
  assert.equal(model.readBinding('b-title-auto', ['root-local']), 'local title'); assert.equal(model.readBinding('b-title-auto'), 'global title'); assert.equal(model.readBinding('b-child-name'), 'nested');
  assert.equal(model.readBinding('b-custom'), 4.69); assert.deepEqual(converters.calls, ['begin', 'invoke:haiyue.converter.fixture@1/double', 'commit']);
  model.dispose();
});

test('transactions publish only at advance, rollback exactly, and consume triggers after observation', () => {
  const model = new runtime.DataBindingRuntime(parsed), batches = [], subscription = model.subscribe(batch => batches.push(batch), { instance: 'root-local' });
  const first = model.beginTransaction(); model.set('root-local', ['score'], 7.5, first); model.trigger('root-local', ['fire'], first); model.commit(first);
  assert.equal(batches.length, 0); assert.equal(model.read('root-local', ['fire']), true); const batch = model.advance();
  assert.deepEqual(batch.changes.map(change => change.kind), ['set', 'trigger']); assert.equal(batches.length, 1); assert.equal(model.read('root-local', ['fire']), false);
  const before = model.read('root-local', ['score']), second = model.beginTransaction(); model.set('root-local', ['score'], 99, second); model.rollback(second); assert.equal(model.read('root-local', ['score']), before); assert.equal(model.advance().changes.length, 0);
  subscription.unsubscribe(); subscription.unsubscribe(); model.dispose(); assert.equal(model.stats.observers, 0);
});

test('property groups and list mutations preserve item identity, ordering, nested instances and replacement values', () => {
  const model = new runtime.DataBindingRuntime(parsed), transaction = model.beginTransaction(); model.applyGroup('activate', 'root-local', transaction); model.applyGroup('reorder', 'root-local', transaction); model.set('root-local', ['child', 'name'], 'updated', transaction); model.set('root-local', ['artboard'], 'board-b', transaction); model.commit(transaction);
  assert.deepEqual(model.read('root-local', ['items']), ['item-2', 'item-1']); assert.equal(model.read('root-local', ['child', 'name']), 'updated'); assert.equal(model.read('root-local', ['artboard']), 'board-b');
  const batch = model.advance(); assert.ok(batch.changes.some(change => change.kind === 'list-insert')); assert.ok(batch.changes.some(change => change.kind === 'list-move'));
  const rebind = model.beginTransaction(); model.rebind('root-local', { title: 'replacement', child: 'child-1', items: ['item-2'], image: 'image-b', artboard: 'board-c' }, rebind); model.commit(rebind); assert.equal(model.read('root-local', ['title']), 'replacement'); assert.deepEqual(model.read('root-local', ['items']), ['item-2']); model.dispose();
});

test('stateful interpolator advances deterministically and component bindings own rebind/dispose state', () => {
  const model = new runtime.DataBindingRuntime(parsed); assert.equal(model.readBinding('b-score-smooth'), 2.345); const transaction = model.beginTransaction(); model.set('root-local', ['score'], 10, transaction); model.commit(transaction); assert.equal(model.readBinding('b-score-smooth'), 2.345); model.advance(0.5); assert.ok(Math.abs(model.readBinding('b-score-smooth') - 6.1725) < 0.001); model.advance(0.5); assert.ok(Math.abs(model.readBinding('b-score-smooth') - 10) < 0.001);
  const component = model.createComponentBinding('component', 'root-local'); assert.equal(component.read('score'), 10); component.set('title', 'component title'); assert.equal(component.read('title'), 'component title'); assert.throws(() => component.read('hidden'), error => error.code === 'E_DATA_RUNTIME_PATH'); component.rebind('root-global'); assert.equal(component.read('title'), 'global title'); assert.equal(model.stats.componentOwners, 1); component.dispose(); component.dispose(); assert.equal(model.stats.componentOwners, 0); assert.throws(() => component.read('title'), error => error.code === 'E_DATA_RUNTIME_STATE'); model.dispose();
});

test('versioned built-in converter op set covers formulas, strings, lists, colors, normalization and triggers', () => {
  const model = new runtime.DataBindingRuntime(parsed); assert.equal(model.readBinding('b-formula'), 4.69); assert.equal(model.readBinding('b-list-length'), 1); assert.ok(Math.abs(model.readBinding('b-radians') - 2.345 * Math.PI / 180) < 1e-12); assert.deepEqual(model.readBinding('b-number-list'), ['item-1']); assert.equal(model.readBinding('b-title-format'), 'local title____'); assert.equal(model.readBinding('b-numeric-clean'), '12.5'); assert.equal(model.readBinding('b-color'), '#ff0000ff'); assert.equal(model.readBinding('b-edge'), false);
  assert.equal(model.readBinding('b-range'), '23'); const transaction = model.beginTransaction(); model.set('root-local', ['enabled'], false, transaction); model.commit(transaction); assert.equal(model.readBinding('b-edge'), true); assert.equal(model.readBinding('b-edge'), false);
  model.dispose();
});

test('custom converter failure rolls back its port and missing ports fail structurally', async () => {
  const converters = converterPort(); converters.fail = true; const model = new runtime.DataBindingRuntime(parsed, { converterPort: converters });
  assert.throws(() => model.readBinding('b-custom'), /converter failure/); assert.deepEqual(converters.calls, ['begin', 'invoke:haiyue.converter.fixture@1/double', 'rollback']); model.dispose();
  const missing = new runtime.DataBindingRuntime(parsed); assert.throws(() => missing.readBinding('b-custom'), error => error.code === 'E_DATA_RUNTIME_PORT'); await assert.rejects(missing.replaceResource('hero', 'image', 'image-a'), error => error.code === 'E_DATA_RUNTIME_PORT'); missing.dispose();
});

test('resource replacement aborts late results, releases every handle once and dispose is idempotent', async () => {
  const pending = [], released = new Map(), port = { acquire(kind, id, signal) { const deferred = createDeferred(); pending.push({ kind, id, signal, deferred }); return deferred.promise; } }, model = new runtime.DataBindingRuntime(parsed, { resourcePort: port });
  const first = model.replaceResource('hero', 'image', 'image-a'); assert.equal(pending[0].signal.aborted, false); const second = model.replaceResource('hero', 'image', 'image-b'); assert.equal(pending[0].signal.aborted, true);
  pending[0].deferred.resolve(handle('image-a', released)); await assert.rejects(first, error => error.code === 'E_DATA_RUNTIME_STATE'); pending[1].deferred.resolve(handle('image-b', released)); assert.equal(await second, 'image-b'); assert.equal(model.resourceOwner.stats.handles, 1);
  model.dispose(); model.dispose(); assert.equal(released.get('image-a'), 1); assert.equal(released.get('image-b'), 1); assert.equal(model.resourceOwner.stats.entries, 0);
});

test('model-based random mutation, list and rollback trace is deterministic', () => {
  const operations = randomOperations(0x71507, 300), replay = () => { const model = new runtime.DataBindingRuntime(parsed, { maxListItems: 32 }), trace = []; for (const operation of operations) { const transaction = model.beginTransaction(); try { if (operation.kind === 'score') model.set('root-local', ['score'], operation.value, transaction); else if (operation.kind === 'insert') model.listInsert('root-local', ['items'], model.read('root-local', ['items']).length, operation.value, transaction); else if (operation.kind === 'remove' && model.read('root-local', ['items']).length > 0) model.listRemove('root-local', ['items'], 0, transaction); else model.trigger('root-local', ['fire'], transaction); if (operation.rollback) model.rollback(transaction); else model.commit(transaction); } catch (error) { model.rollback(transaction); if (error.code !== 'E_DATA_RUNTIME_LIMIT') throw error; } const batch = model.advance(); trace.push([model.read('root-local', ['score']), model.read('root-local', ['items']), batch.changes.map(change => change.kind)]); } model.dispose(); return trace; };
  assert.deepEqual(replay(), replay());
});

function converterPort() { return { calls: [], fail: false, begin() { this.calls.push('begin'); }, invoke(request) { this.calls.push(`invoke:${request.protocol}/${request.port}`); if (this.fail) throw new Error('converter failure'); return Number(request.value) * Number(request.arguments.factor); }, commit() { this.calls.push('commit'); }, rollback() { this.calls.push('rollback'); }, dispose() { this.calls.push('dispose'); } }; }
function createDeferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function handle(value, released) { return { value, release() { released.set(value, (released.get(value) ?? 0) + 1); } }; }
function randomOperations(seed, count) { let state = seed >>> 0; const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; }; return Array.from({ length: count }, () => { const kind = Math.floor(random() * 4), rollback = random() < 0.15; if (kind === 0) return { kind: 'score', value: random() * 100, rollback }; if (kind === 1) return { kind: 'insert', value: random() < 0.5 ? 'item-1' : 'item-2', rollback }; if (kind === 2) return { kind: 'remove', rollback }; return { kind: 'trigger', rollback }; }); }
