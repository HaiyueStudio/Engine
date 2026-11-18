import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GuiFocusManager, GuiRoot } from '@haiyue/engine/gui';
import { NarrativeRuntime } from '@haiyue/extensions/narrative';
import { I18n } from '@haiyue/extensions/i18n';
import { compileReadingFixture } from '../../scripts/fixtures/visual-novel-ui/compile.mjs';

const compiled = await compileReadingFixture();
after(() => rm(compiled, { recursive: true, force: true }));
const load = path => import(pathToFileURL(join(compiled, 'visual-novel/ui', path)));
const { ReadingPlayback, readingPreferenceStore } = await load('ReadingPlayback.js');
const { GuiReading } = await load('GuiReading.js');
const { readingOffsets, wrapReadingText } = await load('reading-text.js');
const complex = '中e\u0301👩‍👩‍👧‍👦🇨🇳';
const story = {
  schemaVersion: 1, id: 'reading', version: '1', start: 'one', variables: {},
  nodes: {
    one: { type: 'dialogue', textKey: 'one', speakerKey: 'narrator', next: 'two' },
    two: { type: 'dialogue', textKey: 'two', next: 'stage' },
    stage: { type: 'action', name: 'visualNovel.stage', next: 'branch' },
    branch: { type: 'choice', textKey: 'branch', options: [
      { id: 'locked', textKey: 'locked', next: 'end', enabledWhen: { op: 'all', conditions: [{ op: 'any', conditions: [] }] } },
      { id: 'yes', textKey: 'yes', next: 'end' },
    ] },
    end: { type: 'end', textKey: 'end', ending: 'done' },
  },
};
const lines = { first: { nodeId: 'one', textKey: 'one', voices: { 'zh-Hans': 'first-zh', en: 'first-en' } },
  second: { nodeId: 'two', textKey: 'two', voices: {} } };

function harness(t, extra = {}, definition = story) {
  const runtime = new NarrativeRuntime(definition);
  const i18n = new I18n({ locale: 'zh-Hans', fallbackLocale: 'en' });
  i18n.register({ schemaVersion: 1, locale: 'zh-Hans', messages: {
    one: complex, narrator: '守灯人', two: '再见', branch: '选择', locked: '条件未满足', yes: '沿着亮起路灯的小径，回到港口接过守灯人的工作', end: '终局',
  } });
  i18n.register({ schemaVersion: 1, locale: 'en', messages: {
    one: 'The harbor light is on.', narrator: 'Keeper', two: 'Goodbye', branch: 'Choose',
    locked: 'Unavailable', yes: 'Take the illuminated path and return to the harbor.', end: 'End',
  } });
  const playback = new ReadingPlayback({ runtime, i18n, lines, ...extra });
  t.after(() => { playback.dispose(); runtime.dispose(); i18n.dispose(); });
  return { runtime, i18n, playback };
}

function gui(t, playback, initial = [520, 420], document) {
  const root = new GuiRoot(), focus = new GuiFocusManager();
  const view = new GuiReading({ root, gui: { focus }, playback, document,
    measure: (value, size) => readingOffsets(value, 'zh-Hans').length * size * .58 });
  focus.setRoots([root.root]);
  const render = (width = initial[0], height = initial[1]) => { root.layout(width, height); focus.reconcile(); };
  t.after(() => { view.dispose(); focus.dispose(); root.destroy(); });
  render();
  return { view, root, focus, render };
}
function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }

test('focus and document visibility leave history replay attached to the active scene', async t => {
  const activeChanges = [], visibility = [];
  let cancellations = 0;
  const audio = { setVoiceVolume() {}, playLine: async () => true, replayHistory: async () => true,
    cancelHistory() { cancellations++; }, setActive: value => activeChanges.push(value),
    setPageVisible: value => visibility.push(value), dispose() {} };
  const document = Object.assign(new EventTarget(), { hidden: false });
  const { runtime, playback } = harness(t, { audio });
  runtime.start('background-history');
  const { focus, view } = gui(t, playback, [520, 420], document);
  focus.next();
  const entry = playback.history()[0];
  assert.equal(await playback.replayVoice(entry), true);
  const before = cancellations;
  focus.blur();
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(playback.confirm(), false);
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(cancellations, before);
  assert.deepEqual(activeChanges, []);
  assert.deepEqual(visibility, [true, false, true]);
  view.openHistory();
  playback.setModal(false);
  assert.equal(cancellations, before + 1);
});

test('dialogue reveal keeps extended graphemes whole and every prewrapped line in place', t => {
  const { runtime, playback } = harness(t);
  playback.setPreferences({ textSpeed: 1, fontScale: 1.5 });
  runtime.start('read');
  const surface = gui(t, playback);
  const indices = readingOffsets(complex, 'zh-Hans');
  assert.equal(indices.length, 5);
  assert.deepEqual(wrapReadingText(complex, indices, 2, value => readingOffsets(value, 'zh-Hans').length - 1).map(row => row.text),
    ['中e\u0301', '👩‍👩‍👧‍👦🇨🇳']);
  assert.deepEqual(wrapReadingText('\nA\n', readingOffsets('\nA\n', 'en'), 20, () => 1).map(row => row.text), ['', 'A', '']);
  const rows = () => descendants(surface.view.panel).filter(v => /:line:\d+$/u.test(v.id));
  const geometry = () => rows().map(v => ({ ...v.rect }));
  const firstGeometry = geometry();
  const identity = rows()[0];
  playback.tick(2000);
  surface.render();
  assert.equal(rows()[0].text, '中e\u0301');
  assert.equal(rows()[0], identity);
  assert.deepEqual(geometry(), firstGeometry);
  const revision = playback.view.revision;
  assert.equal(playback.confirm(revision), true);
  assert.equal(playback.view.nodeId, 'one');
  assert.equal(playback.view.visible, 4);
  assert.equal(playback.confirm(revision), true);
  assert.equal(playback.view.nodeId, 'two');
  assert.equal(playback.confirm(revision), false);
});

test('automatic timing waits for full text and voice, then stops at required actions and choices', t => {
  const audio = { linePending: true, setVoiceVolume() {}, update() {}, playLine: async () => true,
    cancelHistory() {}, cancelLine() {}, dispose() {} };
  const { runtime, playback } = harness(t, { minReadMs: 100, audio });
  playback.setPreferences({ textSpeed: 2 });
  runtime.start('auto');
  playback.setMode('auto');
  playback.tick(1900);
  assert.equal(playback.view.visible, 3);
  playback.tick(400);
  assert.equal(playback.view.nodeId, 'one');
  audio.linePending = false;
  playback.tick(0);
  assert.equal(playback.view.nodeId, 'two');
  playback.tick(1200);
  assert.equal(playback.view.nodeId, 'stage');
  assert.equal(playback.view.mode, 'manual');
  playback.tick(10000);
  assert.equal(playback.view.nodeId, 'stage');
  runtime.completeAction(runtime.view.action.id);
  playback.setMode('auto');
  playback.tick(10000);
  assert.equal(playback.view.kind, 'choice');
  assert.equal(playback.choose('locked'), false);
});

test('skip advances one previously read line then stops before a new line or any action', t => {
  const read = new Set(['first']);
  const { runtime, playback } = harness(t, { read });
  runtime.start('skip1');
  playback.setMode('skip');
  playback.tick(4000);
  assert.equal(playback.view.nodeId, 'two');
  assert.equal(playback.view.mode, 'manual');
  assert.equal(playback.view.visible, 0);
  assert.equal(read.has('second'), false);
  playback.confirm();
  assert.equal(read.has('second'), true);
  playback.setMode('skip');
  playback.tick(100);
  assert.equal(playback.view.nodeId, 'stage');
  assert.equal(playback.view.mode, 'manual');
});

test('modal focus blocks progression and returns to the opener or an eligible replacement', t => {
  const { playback, runtime } = harness(t);
  runtime.start('focus');
  const { view, focus, render } = gui(t, playback);
  focus.focus(view.controls.history);
  view.openHistory();
  render();
  assert.equal(focus.modal, view.historyMenu);
  assert.equal(playback.confirm(), false);
  view.historyMenu.close();
  assert.equal(focus.focused, view.controls.history);
  focus.focus(view.controls.settings);
  view.openSettings();
  render();
  assert.equal(focus.modal, view.settingsMenu);
  view.controls.settings.setDisabled(true);
  view.settingsMenu.close();
  assert.notEqual(focus.focused, view.controls.settings);
  assert.equal(focus.modal, null);
  assert.equal(playback.view.nodeId, 'one');
});

test('narrow safe areas and 200 percent font keep a wrapped choice and its focus across locale changes', async t => {
  const { playback, runtime, i18n } = harness(t);
  playback.setPreferences({ fontScale: 2, highContrast: true });
  runtime.start('choices');
  runtime.advance(); runtime.advance(); runtime.completeAction(runtime.view.action.id);
  const { view, focus, render } = gui(t, playback, [320,360]);
  view.setInsets({ left: 19, top: 26, right: 17, bottom: 31 });
  render();
  const button = descendants(view.panel).find(item => item.id.endsWith('choice:yes'));
  focus.focus(button);
  assert.equal(button.children.length > 1, true);
  assert.equal(view.panel.rect.x, 19);
  assert.equal(view.panel.rect.y + view.panel.rect.height, 329);
  assert.equal(view.panel.style.backgroundColor, '#000000');
  await i18n.setLocale('en');
  render(352,360);
  assert.equal(focus.focused, button);
  assert.equal(button.children.map(label => label.text).join('').trim(), 'Take the illuminated path and return to the harbor.');
});

test('preferences round-trip through the versioned store and survive invalid old data', t => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const preferences = readingPreferenceStore(storage, 'prefs');
  values.set('prefs', '{broken');
  const errors = [];
  const first = harness(t, { preferences, onError: error => errors.push(error) });
  assert.equal(errors.length, 1);
  first.playback.setPreferences({ textSpeed: 0, fontScale: 1.75, voiceVolume: .25, reducedMotion: true, highContrast: true });
  first.playback.setPreferences({ fontScale: 19 });
  const second = harness(t, { preferences });
  assert.deepEqual(second.playback.view.preferences, { textSpeed: 0, fontScale: 1.75, highContrast: true, reducedMotion: true, voiceVolume: .25 });
});

test('long history builds a bounded row pool and resolves replay in the selected language without moving the story', async t => {
  const replay = [];
  const audio = { setVoiceVolume() {}, cancelLine() {}, cancelHistory() {}, playLine: async () => true,
    replayHistory: async id => { replay.push(id); return true; }, dispose() {} };
  const def = { ...story, nodes: { one: { ...story.nodes.one, next: 'one' } } };
  const { runtime, playback, i18n } = harness(t, { maxHistory: 8000, audio }, def);
  playback.setPreferences({ textSpeed: 0 });
  runtime.start('history');
  for (let i = 0; i < 10_000; i++) runtime.advance();
  assert.equal(playback.historySize, 8000);
  assert.equal(playback.history()[0].key, '2002');
  const surface = gui(t, playback, [304,390]);
  surface.view.openHistory();
  surface.render();
  assert.equal(surface.view.historyList.stats.logicalItems, 8000);
  assert.ok(surface.view.historyList.stats.rowInstances <= 9);
  surface.view.historyList.setScrollOffset(0);
  surface.render();
  assert.ok(surface.view.historyList.stats.rowInstances <= 9);
  const selected = playback.history()[0];
  const revision = runtime.view.revision;
  await i18n.setLocale('en');
  await playback.replayVoice(selected);
  assert.deepEqual(replay, ['first-en']);
  assert.equal(runtime.view.revision, revision);
});
