import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GAME_SAVE_FORMAT,
  GameSaveErrorCode,
  GameSaveService,
  IndexedDbSaveBackend,
  LocalStorageSaveBackend,
  MemorySaveBackend,
  parseGameSaveFile,
  serializeGameSaveFile,
  validateGameSaveEnvelope,
} from '../dist/save.js';

const fixedClock = () => new Date('2026-08-21T12:34:56.000Z');
const validPlayerData = value => (
  typeof value === 'object'
  && value !== null
  && Number.isInteger(value.level)
  && Array.isArray(value.position)
  && value.position.length === 3
  && value.position.every(Number.isFinite)
);

function createService(options = {}) {
  return new GameSaveService({
    gameId: 'save-test',
    dataVersion: 2,
    backend: new MemorySaveBackend(),
    validateData: validPlayerData,
    clock: fixedClock,
    createId: () => 'generated',
    ...options,
  });
}

test('save service supports multiple slots, dynamic overwrite, checkpoints, summaries, and deletion', async () => {
  const service = createService();
  const first = await service.save({
    saveId: 'slot-1',
    name: 'Manual slot',
    data: { level: 1, position: [0, 1, 2] },
    thumbnail: { mimeType: 'image/webp', dataUrl: 'data:image/webp;base64,AA==', width: 320, height: 180 },
  });
  assert.equal(first.format, GAME_SAVE_FORMAT);
  assert.equal(first.revision, 1);
  assert.equal(service.validate(first).valid, true);

  const updated = await service.save({
    saveId: 'slot-1',
    name: 'Manual slot',
    kind: 'autosave',
    data: { level: 2, position: [4, 5, 6] },
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal(updated.kind, 'autosave');

  const checkpoint = await service.checkpoint({
    name: 'Before boss',
    data: { level: 2, position: [7, 8, 9] },
  });
  assert.equal(checkpoint.saveId, 'generated');
  assert.equal(checkpoint.kind, 'checkpoint');

  const summaries = await service.list();
  assert.equal(summaries.length, 2);
  assert.equal(Object.hasOwn(summaries[0], 'data'), false);
  assert.deepEqual((await service.load('slot-1')).data.position, [4, 5, 6]);

  await service.delete('slot-1');
  assert.equal(await service.load('slot-1'), null);
});

test('single-slot services reject a second slot but allow overwriting the fixed slot', async () => {
  const service = createService({ maxSlots: 1 });
  await service.save({ saveId: 'autosave', name: 'Auto save', data: { level: 1, position: [0, 0, 0] } });
  await service.save({ saveId: 'autosave', name: 'Auto save', data: { level: 2, position: [1, 0, 0] } });
  await assert.rejects(
    service.save({ saveId: 'manual', name: 'Manual', data: { level: 2, position: [1, 0, 0] } }),
    error => error.code === GameSaveErrorCode.SlotLimit,
  );
});

test('game validators and integrity checks reject incomplete or modified data', async () => {
  const service = createService();
  await assert.rejects(
    service.save({ saveId: 'bad', name: 'Bad', data: { level: 2 } }),
    error => error.code === GameSaveErrorCode.InvalidData && error.issues.some(issue => issue.path === '$.data'),
  );

  const save = await service.save({ saveId: 'good', name: 'Good', data: { level: 3, position: [1, 2, 3] } });
  const corrupted = structuredClone(save);
  corrupted.data.level = 99;
  const result = validateGameSaveEnvelope(corrupted, { expectedGameId: 'save-test', expectedDataVersion: 2, validateData: validPlayerData });
  assert.equal(result.valid, false);
  assert.equal(result.issues.some(issue => issue.code === 'integrity-mismatch'), true);
});

test('LocalStorage backend persists independent slots and reports corrupt records', async () => {
  const storage = new FakeStorage();
  const backend = new LocalStorageSaveBackend({ namespace: 'tests', storage });
  const service = createService({ backend });
  await service.save({ saveId: 'a', name: 'A', data: { level: 1, position: [0, 0, 0] } });
  await service.save({ saveId: 'b', name: 'B', data: { level: 2, position: [1, 1, 1] } });

  const reopened = createService({ backend: new LocalStorageSaveBackend({ namespace: 'tests', storage }) });
  assert.equal((await reopened.list()).length, 2);
  assert.equal((await reopened.load('b')).data.level, 2);

  storage.setItem('tests:game-save:save-test:corrupt', '{oops');
  await assert.rejects(reopened.list(), error => error.code === GameSaveErrorCode.SerializationFailed);
});

test('save files round-trip through the common envelope and import conflict policy', async () => {
  const source = createService();
  const save = await source.save({ saveId: 'portable', name: 'Portable', data: { level: 8, position: [9, 9, 9] } });
  const text = serializeGameSaveFile(save);
  assert.equal(parseGameSaveFile(text, { expectedGameId: 'save-test', expectedDataVersion: 2, validateData: validPlayerData }).data.level, 8);

  const target = createService();
  await target.import(text);
  await assert.rejects(target.import(text), error => error.code === GameSaveErrorCode.Conflict);
  assert.equal((await target.import(text, { replace: true })).saveId, 'portable');
  assert.equal(await target.export('portable'), text);
});

test('IndexedDB backend exposes a structured unavailable error outside a browser', async () => {
  if (globalThis.indexedDB !== undefined) return;
  const backend = new IndexedDbSaveBackend();
  await assert.rejects(backend.list('test'), error => error.code === GameSaveErrorCode.StorageUnavailable);
});

test('disposed services reject late operations and dispose an owned backend once', async () => {
  let disposals = 0;
  const backend = new MemorySaveBackend();
  backend.dispose = () => { disposals++; };
  const service = createService({ backend, ownsBackend: true });
  await service.dispose();
  await service.dispose();
  assert.equal(disposals, 1);
  await assert.rejects(service.list(), error => error.code === GameSaveErrorCode.Disposed);
});

class FakeStorage {
  #items = new Map();
  get length() { return this.#items.size; }
  clear() { this.#items.clear(); }
  getItem(key) { return this.#items.get(String(key)) ?? null; }
  key(index) { return [...this.#items.keys()][index] ?? null; }
  removeItem(key) { this.#items.delete(String(key)); }
  setItem(key, value) { this.#items.set(String(key), String(value)); }
}
