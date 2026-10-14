import test from 'node:test';
import assert from 'node:assert/strict';
import { AchievementRuntime, AchievementGui } from '@haiyue/extensions/achievements';
import { I18n } from '@haiyue/extensions/i18n';
import { GuiElement } from '@haiyue/engine/gui';
import * as root from '@haiyue/extensions';
const definitions = () => [
  { id: 'first', target: 1, titleKey: 'first', descriptionKey: 'desc', rule: { kind: 'fact', event: 'solve' } },
  { id: 'ten', target: 10, titleKey: 'ten', descriptionKey: 'desc', rule: { kind: 'counter', event: 'solve', field: 'count' } },
  { id: 'best', target: 100, titleKey: 'best', descriptionKey: 'desc', rule: { kind: 'best', event: 'score', field: 'score' } },
  { id: 'secret', target: 1, titleKey: 'secret', descriptionKey: 'desc', hidden: true, rule: { kind: 'fact', event: 'secret' } },
];
const copy = x => JSON.parse(JSON.stringify(x));
function fixture(overrides = {}) {
  const saved = new Map(), reports = [];
  const options = { definitions: definitions(), definitionVersion: '1', profile: 'game/guest',
    storage: { read: async key => copy(saved.get(key) ?? null), write: async (key, value) => { saved.set(key, copy(value)); } },
    port: { contractVersion: 1, async reportProgress(id, value) { reports.push({ id, value }); return { id, state: 'local-only', sessionGeneration: 1 }; }, async unlock() { throw Error('Rules report absolute values'); } }, ...overrides };
  return { options, saved, reports, runtime: new AchievementRuntime(options) };
}
test('focused root boundary; immutable catalog; facts/counters/best report only at an explicit checkpoint', async () => {
  assert.deepEqual(Object.keys(root), ['RenderSystem2DBase']);
  const f = fixture(); await f.runtime.initialize(); f.options.definitions[0].target = 99;
  await f.runtime.record({ id: '1', type: 'solve', values: { count: 3 } });
  await f.runtime.record({ id: '2', type: 'score', values: { score: 90 } });
  await f.runtime.record({ id: '3', type: 'score', values: { score: 20 } });
  assert.equal(f.reports.length, 0); assert.deepEqual(f.runtime.snapshot().records.map(r => r.value), [1, 3, 90, 0]);
  await f.runtime.sync(); assert.deepEqual(f.reports.map(r => r.value), [1, 3, 90]); f.runtime.dispose();
});
test('atomic fact+dedupe persistence survives restart and duplicate/parallel delivery', async () => {
  const f = fixture(); await f.runtime.initialize(); let toasts = 0; f.runtime.subscribe(e => { if (e.type === 'unlocked') toasts++; });
  const fact = { id: 'puzzle-1', type: 'solve', values: { count: 1 } };
  assert.deepEqual(await Promise.all([f.runtime.record(fact), f.runtime.record(fact)]), [true, false]); assert.equal(toasts, 1);
  f.runtime.dispose(); const r = new AchievementRuntime(f.options); await r.initialize(); assert.equal(await r.record(fact), false);
  assert.equal(r.snapshot().records[1].value, 1); await r.sync(); r.dispose();
});
test('write failure rolls back value and dedupe, retry emits one local unlock', async () => {
  const f = fixture(); await f.runtime.initialize(); const write = f.options.storage.write; let unlocks = 0;
  f.runtime.subscribe(e => { if (e.type === 'unlocked') unlocks++; }); f.options.storage.write = async () => { throw Error('disk full'); };
  const fact = { id: '1', type: 'solve', values: { count: 1 } }; await assert.rejects(f.runtime.record(fact), /disk full/);
  assert.equal(f.runtime.snapshot().records[0].value, 0); assert.equal(unlocks, 0);
  f.options.storage.write = write; await f.runtime.record(fact); assert.equal(unlocks, 1); f.runtime.dispose();
});
test('failed platform report stays pending across restart; accepted receipt never repeats unlock toast', async () => {
  const f = fixture(); await f.runtime.initialize(); await f.runtime.record({ id: '1', type: 'solve', values: { count: 1 } });
  const report = f.options.port.reportProgress; f.options.port.reportProgress = async () => { throw Error('offline'); };
  await assert.rejects(f.runtime.sync(), /offline/); f.runtime.dispose();
  f.options.port.reportProgress = report; const r = new AchievementRuntime(f.options); let toasts = 0; r.subscribe(e => { if (e.type === 'unlocked') toasts++; });
  await r.initialize(); await r.sync(); assert.equal(toasts, 0); assert.equal(r.snapshot().records[0].pending, false); r.dispose();
});
test('bounded dedupe contract and authoritative monotonic checkpoints', async () => {
  const f = fixture({ dedupeWindow: 2 }); await f.runtime.initialize();
  for (let i = 0; i < 3; i++) await f.runtime.record({ id: String(i), type: 'solve', values: { count: 1 } });
  assert.deepEqual(f.runtime.snapshot().recentEventIds, ['1', '2']);
  await f.runtime.checkpoint({ ten: 8 }); await f.runtime.checkpoint({ ten: 4 }); assert.equal(f.runtime.snapshot().records[1].value, 8);
  await assert.rejects(f.runtime.checkpoint({ missing: 1 }), /Invalid/); f.runtime.dispose();
});
test('invalid facts are atomic; target/rule changes and corrupt saves require validated migration', async () => {
  const f = fixture(); await f.runtime.initialize();
  await assert.rejects(f.runtime.record({ id: '1', type: 'solve' }), /Missing/); assert.equal(f.runtime.snapshot().records[0].value, 0);
  await f.runtime.record({ id: '1', type: 'solve', values: { count: 1 } }); f.runtime.dispose();
  const options = { ...f.options, definitionVersion: '2' };
  const r = new AchievementRuntime(options); await assert.rejects(r.initialize(), /migration/); r.dispose();
  const migrated = new AchievementRuntime({ ...options, migrate: (old, empty) => ({ ...empty, records: old.records }) }); await migrated.initialize(); assert.equal(migrated.snapshot().records[1].value, 1); migrated.dispose();
});
test('disposal ignores late persistence, unsubscribes observers, and bounds queued operations', async () => {
  const f = fixture({ maxQueuedOperations: 1 }); await f.runtime.initialize();
  let resolve; f.options.storage.write = () => new Promise(r => { resolve = r; });
  let events = 0; f.runtime.subscribe(() => events++); const off = f.runtime.subscribe(() => { throw Error('listener'); }); off();
  const pending = f.runtime.record({ id: '1', type: 'solve', values: { count: 1 } });
  await assert.rejects(f.runtime.record({ id: '2', type: 'solve', values: { count: 1 } }), /queue full/);
  await new Promise(r => setImmediate(r)); f.runtime.dispose(); resolve(); await assert.rejects(pending, /disposed/); assert.equal(events, 1);
});
test('GPU presenter hides secret text/artwork, refreshes locale, suppresses platform duplicates and disposes', async () => {
  const f = fixture(); await f.runtime.initialize(); const parent = new GuiElement(), i18n = new I18n({ locale: 'en', fallbackLocale: 'en' });
  for (const locale of ['en', 'zh']) i18n.register({ schemaVersion: 1, locale, messages: { first: `${locale}-first`, ten: 'ten', best: 'best', secret: 'SECRET', desc: 'description', hidden: '???', locked: 'locked', unlocked: 'unlocked' } });
  const ui = new AchievementGui(f.runtime, { parent, i18n, hiddenKey: 'hidden', lockedKey: 'locked', unlockedKey: 'unlocked', toastDurationMs: 10 });
  const text = () => ui.panel.children.flatMap(row => row.children).map(child => child.text ?? '').join(' ');
  assert.ok(!text().includes('SECRET')); assert.ok(text().includes('en-first'));
  await i18n.setLocale('zh'); assert.ok(text().includes('zh-first'));
  await f.runtime.record({ id: '1', type: 'secret' }); assert.ok(text().includes('SECRET')); assert.equal(ui.toast.visible, true);
  await f.runtime.sync(); await new Promise(r => setTimeout(r, 15)); assert.equal(ui.toast.visible, false);
  await f.runtime.record({ id: '1', type: 'secret' }); assert.equal(ui.toast.visible, false);
  ui.dispose(); assert.equal(parent.children.length, 0); i18n.dispose(); f.runtime.dispose();
});
test('a hung port releases the queue on timeout/disposal and late completion cannot erase an intent', async () => {
  const f = fixture({ reportTimeoutMs: 5 }); await f.runtime.initialize(); await f.runtime.record({ id: '1', type: 'secret' });
  let finish; f.options.port.reportProgress = () => new Promise(resolve => { finish = resolve; });
  await assert.rejects(f.runtime.sync(), /timed out/);
  finish({ id: 'secret', state: 'local-only', sessionGeneration: 1 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.snapshot().records[3].pending, true);
  const next = f.runtime.sync(); await new Promise(resolve => setImmediate(resolve)); f.runtime.dispose(); await assert.rejects(next, /disposed/);
});
