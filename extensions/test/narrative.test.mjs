import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { NarrativeRuntime, NarrativeGui, validateNarrativeDefinition, connectNarrativeActions } from '@haiyue/extensions/narrative';
import { I18n } from '@haiyue/extensions/i18n';
import { GuiElement, GuiRoot, GuiLabel, GuiButton } from '@haiyue/engine/gui';
import * as rootExports from '@haiyue/extensions';
const fixture = () => JSON.parse(readFileSync(new URL('../../examples/narrative/story.json', import.meta.url)));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const setup = () => { const runtime = new NarrativeRuntime(fixture()); runtime.start('run-1'); return runtime; };

test('focused subpath leaves root unchanged and definition is defensively frozen', () => {
  assert.deepEqual(Object.keys(rootExports), ['RenderSystem2DBase']);
  const raw = fixture(), d = validateNarrativeDefinition(raw); raw.nodes.intro.next = 'bad'; assert.equal(d.nodes.intro.next, 'decision'); assert.ok(Object.isFrozen(d.nodes.decision.options));
});
test('definition rejects missing targets, duplicate choices, unknown variables, bad types and executable expressions', () => {
  for (const edit of [d => d.nodes.intro.next = 'bad', d => d.nodes.decision.options.push(d.nodes.decision.options[0]), d => d.nodes['trust-check'].condition.variable = 'bad', d => d.nodes['trust-check'].condition.value = 'wrong', d => d.nodes['trust-check'].condition = { op: 'eval', code: '1' }, d => d.variables.trust = Infinity]) {
    const d = fixture(); edit(d); assert.throws(() => validateNarrativeDefinition(d));
  }
});
test('three routes reach two endings and record historical choices', () => {
  for (const option of ['rescue', 'signal', 'leave']) {
    const r = setup(); r.advance(); assert.equal(r.choose(option), true);
    if (option === 'signal') r.advance();
    if (option === 'rescue') r.completeAction(r.view.action.id, { won: true });
    if (r.view.action) r.completeAction(r.view.action.id, { medals: 1 });
    assert.equal(r.view.ending, option === 'leave' ? 'alone' : 'together');
    assert.equal(r.save().choices[0].optionId, option); r.dispose();
  }
});
test('failed battle branches to the alternate ending; hidden and disabled options cannot be selected', () => {
  const r = setup(); r.advance(); r.choose('rescue'); r.completeAction(r.view.action.id, { won: false }); assert.equal(r.view.ending, 'alone'); r.dispose();
  const d = fixture(); d.nodes.decision.options[0].visibleWhen = { op: 'eq', variable: 'won', value: true };
  const s = new NarrativeRuntime(d); s.start('limited', { battery: 0 }); s.advance();
  assert.deepEqual(s.view.choices.map(o => [o.id, o.enabled]), [['signal', false], ['leave', true]]);
  assert.equal(s.choose('rescue'), false); assert.equal(s.choose('signal'), false); assert.equal(s.save().choices.length, 0); s.dispose();
});
test('choice effects and automatic transitions roll back together on cycles or overflow', () => {
  const d = fixture(); d.nodes.loop = { type: 'effect', effects: [{ op: 'add', variable: 'trust', value: 1 }], next: 'loop' }; d.nodes.decision.options[0].next = 'loop';
  const r = new NarrativeRuntime(d, { maxAutomaticSteps: 8 }); r.start('cycle'); r.advance(); const before = r.save();
  assert.throws(() => r.choose('rescue'), /step limit/); assert.deepEqual(r.save(), before);
  const huge = fixture(); huge.variables.trust = Number.MAX_VALUE; huge.nodes.decision.options[0].effects[0].value = Number.MAX_VALUE;
  const r2 = new NarrativeRuntime(huge); r2.start('overflow'); r2.advance(); const old = r2.save(); assert.throws(() => r2.choose('rescue'), /finite/); assert.deepEqual(r2.save(), old); r.dispose(); r2.dispose();
});
test('automatic effects execute once and do not replay after restoring a settled save', () => {
  const d = fixture(); d.start = 'grant'; d.nodes.grant = { type: 'effect', effects: [{ op: 'add', variable: 'medals', value: 1 }], next: 'intro' };
  const r = new NarrativeRuntime(d); r.start('run'); const saved = r.save(); r.restore(JSON.parse(JSON.stringify(saved))); assert.equal(r.view.variables.medals, 1); r.dispose();
});
test('saves reject incompatible versions, unstable cursors and malformed variables/history atomically', () => {
  const r = setup(), original = r.save();
  for (const patch of [{ storyVersion: 'new' }, { nodeId: 'trust-check' }, { variables: { trust: 1 } }, { variables: { ...original.variables, won: 1 } }, { choices: [{ nodeId: 'intro', optionId: 'bad' }] }, { pendingAction: { sequence: 2 } }, { actionSequence: -1 }]) {
    assert.throws(() => r.restore({ ...original, ...patch })); assert.deepEqual(r.save(), original);
  }
  assert.throws(() => r.start('run-1'), /fresh/); r.dispose();
});
test('restored pending action keeps durable token but rejects old and duplicate acknowledgements', () => {
  const r = setup(); r.advance(); r.choose('rescue'); const first = r.view.action, saved = r.save();
  r.restore(JSON.parse(JSON.stringify(saved))); const next = r.view.action;
  assert.equal(first.token, next.token); assert.notEqual(first.id, next.id); assert.equal(r.completeAction(first.id, { won: true }), false);
  assert.throws(() => r.completeAction(next.id, { unknown: true }), /Unknown/); assert.equal(r.view.action.id, next.id);
  assert.equal(r.completeAction(next.id, { won: true }), true); assert.equal(r.completeAction(next.id), false); r.dispose();
});
test('stale UI revision cannot accidentally choose or advance a newer node', () => {
  const r = setup(), rev = r.view.revision; assert.equal(r.advance(rev), true); assert.equal(r.choose('leave', rev), false); assert.equal(r.advance(rev), false); r.dispose();
});
test('event delivery is deterministic, isolates subscribers and rejects reentrant mutation', () => {
  const r = new NarrativeRuntime(fixture()); const events = []; r.subscribe(e => { events.push(e.type); if (e.type === 'change') assert.throws(() => r.advance(), /after event/); });
  r.start('events'); r.advance(); r.choose('rescue'); assert.deepEqual(events, ['change', 'change', 'change', 'action']);
  let delivered = false; r.subscribe(() => { throw new Error('listener'); }); r.subscribe(() => { delivered = true; });
  assert.throws(() => r.completeAction(r.view.action.id, { won: false }), AggregateError); assert.equal(delivered, true); assert.equal(r.view.ending, 'alone'); assert.throws(() => r.dispose(), AggregateError); assert.equal(r.disposed, true);
});
test('action allowlist adapter supports retry and host deduplication after pending save restore', async () => {
  const r = setup(), ledger = new Map(); let grants = 0;
  const connection = connectNarrativeActions(r, { battle: () => ({ won: true }), 'award-medal': request => { if (!ledger.has(request.token)) { grants++; ledger.set(request.token, { medals: 1 }); } return ledger.get(request.token); } });
  r.advance(); r.choose('rescue'); const saved = r.save(); await tick(); assert.equal(r.view.ending, 'together');
  r.restore(saved); await tick(); assert.equal(r.view.ending, 'together'); assert.equal(grants, 1); assert.equal(connection.error, undefined); connection.dispose(); r.dispose();
});
test('missing/failed handlers pause; retry resumes without skipping the action', async () => {
  const r = setup(); r.advance(); r.choose('rescue'); let failed = true;
  const handlers = {}; const c = connectNarrativeActions(r, handlers); await tick(); assert.match(c.error.message, /Unregistered/); assert.equal(r.view.node.type, 'action');
  handlers.battle = () => { if (failed) throw new Error('offline'); return { won: false }; }; c.retry(); await tick(); assert.match(c.error.message, /offline/);
  failed = false; c.retry(); await tick(); assert.equal(r.view.ending, 'alone'); c.dispose(); r.dispose();
});
test('restore and disconnect abort old action handlers; ignored abort results never commit', async () => {
  const r = setup(); r.advance(); r.choose('rescue'); const jobs = [];
  const c = connectNarrativeActions(r, { battle: (_, signal) => { const d = deferred(); jobs.push({ ...d, signal }); return d.promise; } });
  await tick(); const saved = r.save(); r.restore(saved); await tick(); assert.equal(jobs[0].signal.aborted, true);
  jobs[0].resolve({ won: true }); await tick(); assert.equal(r.view.nodeId, 'battle');
  c.dispose(); assert.equal(jobs[1].signal.aborted, true); jobs[1].resolve({ won: true }); await tick(); assert.equal(r.view.nodeId, 'battle'); r.dispose();
});
function translations() {
  const i = new I18n({ locale: 'en', fallbackLocale: 'en' });
  for (const locale of ['en', 'zh-CN']) i.register({ schemaVersion: 1, locale, messages: { intro: locale === 'en' ? 'Emergency. Please help us.' : '紧急求救，请帮助我们。', pilot: 'Pilot', next: 'Continue', wait: 'Waiting', decision: 'Choose', rescue: 'Rescue', signal: 'Signal', leave: 'Leave', 'orbit.alt': 'Orbit' }, assets: { orbit: `${locale}.png` } });
  return i;
}
test('GPU GUI binds i18n, wraps text, keeps unrelated siblings and uses safe stale callbacks', async () => {
  const r = setup(), i = translations(), root = new GuiRoot(); const other = root.add(new GuiLabel({ text: 'HUD' }));
  const gui = new NarrativeGui(r, { parent: root.root, i18n: i, continueKey: 'next', waitingKey: 'wait' }); root.layout(400, 700);
  const collect = n => [n, ...n.children.flatMap(collect)];
  assert.ok(collect(gui.panel).some(n => n instanceof GuiLabel && n.text.includes('Emergency')));
  const button = collect(gui.panel).find(n => n instanceof GuiButton); button.handleClick({ type: 'click', stopped: false, stopPropagation() { this.stopped = true; } });
  assert.equal(r.view.nodeId, 'decision'); button.handleClick({ type: 'click', stopped: false, stopPropagation() {} }); assert.equal(r.view.nodeId, 'decision');
  await i.setLocale('zh-CN'); r.restore({ ...r.save(), nodeId: 'intro' }); root.layout(400, 700);
  assert.ok(collect(gui.panel).some(n => n instanceof GuiLabel && n.text.includes('紧急')));
  gui.dispose(); assert.deepEqual(root.root.children, [other]); r.dispose(); i.dispose();
});
test('GUI images release leases on replacement, locale change and disposal; abort detaches view', async () => {
  const r = setup(), i = translations(), root = new GuiRoot(), signal = new AbortController(); let releases = 0, loads = 0;
  const gui = new NarrativeGui(r, { parent: root.root, i18n: i, continueKey: 'next', waitingKey: 'wait', signal: signal.signal, imageLoader: async () => { loads++; return { texture: {}, release: () => releases++ }; } });
  await gui.ready; await i.setLocale('zh-CN'); await gui.ready; assert.equal(loads, 2); assert.equal(releases, 1);
  r.advance(); await gui.ready; assert.equal(loads, 2); signal.abort(); assert.equal(releases, 2); assert.equal(root.root.children.length, 0); r.dispose(); i.dispose();
});

test('CJK line wrapping leaves glyph padding and a narrow layout remains scrollable', () => {
  const r = setup(), i = translations(), root = new GuiRoot();
  const text = '这里是米拉。我们的飞船漂流在废弃空间站旁，只剩最后一块电池。你能听见吗？';
  i.register({ schemaVersion: 1, locale: 'en', messages: { intro: text, pilot: 'Pilot', next: 'Next', wait: 'Wait', 'orbit.alt': 'Orbit' } });
  const gui = new NarrativeGui(r, { parent: root.root, i18n: i, continueKey: 'next', waitingKey: 'wait' });
  root.layout(700, 300);
  const labels = node => [node, ...node.children.flatMap(labels)].filter(node => node instanceof GuiLabel);
  const lines = labels(gui.panel).filter(label => label.text.includes('这里') || label.text.includes('见吗'));
  assert.equal(lines.length, 2); assert.equal(lines.map(label => label.text).join(''), text); assert.ok(gui.panel.maxScrollY > 0);
  root.layout(320, 300); assert.ok(gui.panel.maxScrollY > 0);
  gui.dispose(); r.dispose(); i.dispose();
});
