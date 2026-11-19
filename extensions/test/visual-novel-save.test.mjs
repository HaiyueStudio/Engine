import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { LocalStorageSaveBackend, GameSaveService, GameSaveError } from '@haiyue/engine/save';
import { I18n } from '@haiyue/extensions/i18n';
import { buildSaveFixture, evidenceRoot, freshOutput } from '../../scripts/fixtures/visual-novel-save/build.mjs';
import { story } from '../../scripts/fixtures/visual-novel-save/story.mjs';

const output = await freshOutput();
after(async () => { assert.equal(dirname(output), evidenceRoot); await rm(output, { recursive: true, force: true }); });
const { VisualNovelSaveSession, VisualNovelStage } = await import(pathToFileURL(await buildSaveFixture(output)));
const tick = () => new Promise(resolve => setImmediate(resolve));
const codes = code => error => error?.code === code;
const gameId = 'g05-unit';
const key = slot => `g05-tests:game-save:${gameId}:${slot}`;

function storage() {
  const records = new Map();
  return {
    records, get length() { return records.size; }, key: index => [...records.keys()][index] ?? null,
    getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value),
    removeItem: key => records.delete(key),
  };
}

function fixture(t, store = storage(), options = {}) {
  const backend = new LocalStorageSaveBackend({ storage: store, namespace: 'g05-tests' });
  const i18n = new I18n({ locale: story.defaultLocale, fallbackLocale: story.defaultLocale });
  i18n.register(story.locales[story.defaultLocale]);
  const errors = [], surfaces = [], activations = [];
  let selected, leases = 0;
  const host = {
    create(mode) {
      let sequence = 0;
      const number = surfaces.length;
      const stage = new VisualNovelStage({
        concurrency: 4, prepareTimeoutMs: 2000, port: {
          async acquire(slot, signal) {
            await options.acquire?.(number, slot, signal);
            leases++;
            return { value: { source: {}, bytes: 12, designSize: [128,96] }, release() { leases--; } };
          },
          async create(_asset, _slot, generation) {
            let time = 0, sequence = 0;
            const frame = () => ({ ready: true, generation, sequence: ++sequence, time, events: [] });
            return { advance: request => { time += request.deltaSeconds; return frame(); },
              seek: value => { time = value; return frame(); }, setVisible() {}, configure() {},
              resize: view => view.viewport, takeInvalidation: () => false, dispose() {} };
          },
        },
      });
      const surface = {
        mode, stage, frame: (deltaSeconds = 0) => stage.frame({ sequence: ++sequence, deltaSeconds, viewport: [320,200], dpr: 1 }),
        mount(reading) { this.reading = reading; },
        async prepare(ready, signal) {
          let settled = false;
          void ready.finally(() => { settled = true; }).catch(() => {});
          while (!settled) { await tick(); signal.throwIfAborted(); if (!settled) this.frame(); }
          await ready;
        },
        music: { snapshot: () => surface.track,
          async prepare(saved) { surface.track = saved ?? { assetId: 'music', playing: true, position: 0 }; } },
        thumbnail: () => options.thumbnail?.(),
        dispose() { stage.dispose(); this.disposed = true; },
      };
      surfaces.push(surface);
      return surface;
    },
    present(next, previous) {
      assert.equal(previous, selected ?? null);
      options.beforePresent?.(next);
      selected = next;
      activations.push(next?.reading.view.nodeId ?? null);
    },
  };
  const session = new VisualNovelSaveSession({
    story, i18n, backend, gameId, manualSlots: ['one','two','legacy'], host, profileStorage: store,
    clock: () => new Date('2026-11-16T00:00:00.000Z'), autosave: options.autosave ?? true,
    actions: { award: options.award ?? (() => ({ coins: 1 })) },
    onError: error => errors.push(error), ...(options.migrations ? { migrations: options.migrations } : {}),
  });
  t.after(async () => { try { await session.dispose(); } finally { i18n.dispose(); } });
  async function wait(check) {
    for (let index = 0; index < 100; index++) { if (check()) return; await tick(); selected?.frame(); }
    assert.fail('The expected reading boundary was not reached.');
  }
  async function start(run = 'first') {
    await session.start(run);
    session.setPreferences({ textSpeed: 0 });
    await wait(() => session.view?.nodeId === 'dock/intro');
  }
  return { store, backend, session, surfaces, activations, errors, wait, start, leases: () => leases, active: () => selected };
}

test('restart selects the latest successful slot and restores choice, current chapter history, pose and music', async t => {
  const a = fixture(t);
  await a.start();
  await a.session.save('one');
  a.active().frame(.15);
  a.active().track = { assetId: 'music', playing: true, position: .75 };
  assert.equal(a.session.advance(), true);
  await a.session.flush();
  await a.session.save('two');
  const expected = a.active().stage.snapshot;
  const slots = await a.session.listSlots();
  assert.deepEqual(slots.filter(row => row.status === 'valid').map(row => row.id), ['auto','one','two']);
  const committed = [...a.store.records];
  await a.session.dispose();
  assert.equal(a.leases(), 0);
  const b = fixture(t, a.store);
  assert.equal(await b.session.continueLatest(), true);
  assert.equal(b.session.view.text, '请选择航线。');
  assert.deepEqual(b.session.view.choices.map(choice => choice.id), ['left','right']);
  assert.equal(b.session.view.preferences.textSpeed, 0);
  assert.deepEqual(b.session.history.map(entry => entry.lineId), ['intro']);
  assert.deepEqual(b.active().stage.snapshot, expected);
  assert.equal(b.active().track.position, .75);
  assert.deepEqual([...b.store.records], committed);
  assert.equal(await b.session.load('one'), true);
  assert.deepEqual(b.session.history.map(entry => entry.lineId), ['intro'], 'the current row is not duplicated');
  assert.equal(b.leases(), 4);
});

test('corrupt slots are isolated; a legacy migration is validated while the old record remains readable by its original version', async t => {
  const a = fixture(t, storage(), { migrations: { 0: data => data.previous } });
  await a.start();
  await a.session.save('one');
  await a.session.flush();
  const before = await a.backend.read(gameId, 'one');
  const old = new GameSaveService({ gameId, backend: a.backend, dataVersion: 0, clock: () => new Date('2026-11-17') });
  await old.save({ name: 'Legacy', saveId: 'legacy', data: { previous: before.data } });
  const original = a.store.getItem(key('legacy'));
  a.store.setItem(key('one'), '{');
  assert.deepEqual((await a.session.listSlots()).map(row => [row.id,row.status]),
    [['auto','valid'],['one','unreadable'],['two','empty'],['legacy','valid']]);
  await assert.rejects(a.session.load('one'), error => error instanceof GameSaveError);
  assert.equal(await a.session.continueLatest(), true);
  assert.equal(a.session.view.lineId, 'intro');
  assert.equal(a.store.getItem(key('legacy')), original);
  await a.session.save('two', { name: 'Fresh' });
  assert.ok(await a.backend.read(gameId, 'two'));
  assert.equal(a.store.getItem(key('one')), '{');
  await old.dispose();
});

test('a thumbnail failure leaves a valid named save and an unrecognized asset never reaches the host', async t => {
  const a = fixture(t, storage(), { thumbnail: () => { throw Error('readback failed'); } });
  await a.start();
  await a.session.save('one', { name: 'Harbor', thumbnail: true });
  assert.ok(a.errors.some(error => error.message === 'readback failed'));
  const item = await a.backend.read(gameId, 'one');
  assert.equal(item.name, 'Harbor');
  assert.equal(item.thumbnail, undefined);
  const raw = new GameSaveService({ gameId, backend: a.backend, dataVersion: 1 });
  await raw.save({ name: 'Broken asset', saveId: 'two', data: { ...item.data,
    slots: item.data.slots.map(slot => ({ ...slot, assetId: 'missing' })) } });
  const before = a.active();
  await assert.rejects(a.session.load('two'), codes('E_GAME_SAVE_INVALID_DATA'));
  assert.equal(a.active(), before);
  assert.equal(a.surfaces.length, 1);
  await raw.dispose();
});

test('load during prefetch and a newer load release abandoned resources while a failed handoff preserves the last scene', async t => {
  const delayed = Promise.withResolvers(), entered = Promise.withResolvers();
  const prefetch = Promise.withResolvers(), prefetchStarted = Promise.withResolvers();
  let rejectHandoff = false;
  const a = fixture(t, storage(), { acquire: async (generation, slot) => {
    if (generation === 1 && slot.id === 'effect') { entered.resolve(); await delayed.promise; }
    if (generation === 0 && slot.id === 'preload') { prefetchStarted.resolve(); await prefetch.promise; }
  }, beforePresent: next => { if (next && rejectHandoff) throw Error('publish rejected'); } });
  await a.start();
  await a.session.save('one');
  const speculative = a.active().stage.preload([{ id: 'preload', assetId: 'effect', bounds: [0,0,64,64], order: 0 }]);
  const stopped = assert.rejects(speculative, codes('E_SCENE_FLOW_ABORTED'));
  await prefetchStarted.promise;
  const original = a.active();
  const slow = a.session.load('one');
  const rejected = assert.rejects(slow, codes('E_SCENE_FLOW_SUPERSEDED'));
  await entered.promise;
  assert.equal(a.active(), original);
  assert.equal(await a.session.load('one'), true);
  await rejected;
  delayed.resolve();
  prefetch.resolve();
  await stopped;
  await tick();
  assert.equal(a.leases(), 4);
  assert.ok(original.disposed && a.surfaces[1].disposed);
  const current = a.active();
  rejectHandoff = true;
  await assert.rejects(a.session.load('one'), /publish rejected/);
  assert.equal(a.active(), current);
  assert.equal(a.leases(), 4);
});

test('saved replay drafts survive restart, action tokens deduplicate rewards, and chapter/CG replays preserve live state and writes', async t => {
  const store = storage(), rewardTokens = new Map();
  let handlerCalls = 0;
  const award = request => {
    handlerCalls++;
    if (!rewardTokens.has(request.token)) rewardTokens.set(request.token, { coins: 1 });
    return rewardTokens.get(request.token);
  };
  const a = fixture(t, store, { award });
  await a.start();
  a.session.advance();
  await a.session.save('one');
  await a.session.dispose();
  const b = fixture(t, store, { award });
  await b.session.load('one');
  assert.equal(b.session.choose('left'), true);
  await b.wait(() => b.session.view.lineId === 'leftEnd');
  await b.session.flush();
  assert.deepEqual(b.session.listReplays(), ['chapter']);
  await b.session.load('one');
  assert.equal(b.session.choose('right'), true);
  await b.wait(() => b.session.view.lineId === 'rightEnd');
  await b.session.flush();
  assert.deepEqual(b.session.listReplays(), ['chapter','cg']);
  assert.equal(rewardTokens.size, 1);
  const original = b.active(), before = b.session.view, records = [...store.records];
  for (const [replay, choice, line] of [['chapter','left','leftEnd'],['cg','right','rightEnd']]) {
    await b.session.startReplay(replay);
    assert.equal(b.session.view.lineId, 'intro');
    await assert.rejects(b.session.save('two'), codes('E_GAME_SAVE_INVALID_DATA'));
    b.session.advance();
    assert.equal(b.session.view.choices.find(item => item.id !== choice).enabled, false);
    assert.equal(b.session.choose(choice === 'left' ? 'right' : 'left'), false);
    b.session.choose(choice);
    await b.wait(() => b.session.view.lineId === line);
    assert.equal(b.session.advance(), false);
    assert.equal(b.session.endReplay(), true);
    assert.equal(b.active(), original);
    assert.equal(b.session.view, before);
    assert.equal(b.leases(), 4);
  }
  await b.session.startReplay('chapter');
  b.session.advance();
  assert.equal(b.session.endReplay(), true);
  assert.equal(handlerCalls, 2);
  assert.deepEqual([...store.records], records);
});
