import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NarrativeRuntime } from '@haiyue/extensions/narrative';
import { loadProject, refreshPreview } from '../../scripts/visual-novel-authoring/project.mjs';

const cli = fileURLToPath(new URL('../../scripts/visual-novel-authoring/cli.mjs', import.meta.url));
const example = fileURLToPath(new URL('../../scripts/visual-novel-authoring/example', import.meta.url));
const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'haiyue-story-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(example, root, { recursive: true });
  const entry = join(root, 'story.json');
  const edit = async (file, mutate) => {
    const target = join(root, file);
    const value = JSON.parse(await readFile(target, 'utf8'));
    mutate(value);
    await writeFile(target, JSON.stringify(value, null, 2));
  };
  return { root, entry, edit };
}

test('named routes rejoin after a cross-chapter choice and reach two distinct endings deterministically', async t => {
  const { entry } = await fixture(t);
  const compilation = await loadProject(entry);
  assert.deepEqual(compilation.diagnostics, []);
  const { definition } = compilation.story;
  assert.equal(definition.narrative.nodes['arrival/set-stage'].name, 'visualNovel.stage');
  assert.equal(definition.narrative.nodes['arrival/view'].next, 'arrival/offer');
  assert.equal(definition.narrative.nodes['arrival/offer'].options[0].next, 'pier/restore-actor');
  assert.deepEqual(definition.cues['pier/restore-actor'][0][0].slots, [definition.presets.evening[1]]);
  assert.deepEqual(definition.replays['pier-memory'], { startLineId: 'first-view', endLineId: 'shared-pier' });
  const stay = await refreshPreview(entry, 'stay');
  const leave = await refreshPreview(entry, 'leave');
  assert.deepEqual(await refreshPreview(entry, 'stay'), stay);
  assert.deepEqual(await refreshPreview(entry, 'leave'), leave);
  assert.deepEqual([stay.preview.ending, leave.preview.ending], ['lantern', 'tide']);
  assert.deepEqual(stay.preview.visited.slice(0, -1), leave.preview.visited.slice(0, -1));
  assert.ok(stay.preview.visited.includes('pier/shared'));
  assert.deepEqual(stay.preview.variables, { trust: 1, knowsHarbor: true, openedJournal: true });
  assert.equal(leave.preview.text, 'You board the boat at low tide.');
});

test('preview reports hidden choices, variables, previously committed slots, and explicit stage barriers', async t => {
  const { entry, edit } = await fixture(t);
  await edit('arrival.json', doc => doc.nodes['set-stage'].cues.push([
    { op: 'state', slotId: 'actor', stateId: 'ready' },
    { op: 'wait', kind: 'event', slotId: 'actor', event: 'ready' },
  ]));
  await edit('story.json', doc => {
    doc.routes['inspect-journal'] = { steps: doc.routes.leave.steps.slice(0, 3) };
  });
  const stage = (await refreshPreview(entry, 'inspect-stage')).preview;
  assert.equal(stage.waiting.activeGroup, 0);
  assert.deepEqual(stage.slots, []);
  assert.deepEqual(stage.waiting.barriers.map(({ kind }) => kind), ['resource', 'resource', 'transition', 'duration', 'event']);
  assert.deepEqual(stage.waiting.barriers.at(-1), { group: 2, kind: 'event', slotId: 'actor', event: 'ready' });
  const choice = (await refreshPreview(entry, 'inspect-options')).preview;
  assert.equal(choice.lineId, 'harbor-choice');
  assert.equal(choice.variables.knowsHarbor, false);
  assert.deepEqual(choice.choices.map(({ id, visible, enabled }) => [id, visible, enabled]), [['stay', false, false], ['leave', true, true]]);
  assert.equal(choice.choices[0].conditions.visibleWhen.variable, 'knowsHarbor');
  assert.deepEqual(choice.slots.map(slot => slot.id), ['background', 'actor']);
  assert.equal(choice.slots[1].stateId, 'ready');
  const action = (await refreshPreview(entry, 'inspect-journal')).preview;
  assert.deepEqual(action.waiting, { kind: 'action', name: 'journal.mark', payload: { checkpoint: 'pier' } });
  assert.equal(action.variables.openedJournal, false);
});

test('reload edits text and a cue at the same stable line, then preserves the last preview on rejection', async t => {
  const { root, entry, edit } = await fixture(t);
  const baseline = (await refreshPreview(entry, 'stay', 'first-view')).preview;
  await edit('zh-Hans.json', doc => { doc.messages['arrival.view'] = '灯塔亮起。'; });
  await edit('arrival.json', doc => doc.nodes['set-stage'].cues.push([{ op: 'state', slotId: 'actor', stateId: 'ready' }]));
  const updated = await refreshPreview(entry, 'stay', undefined, baseline);
  assert.equal(updated.status, 'ready');
  assert.equal(updated.preview.lineId, baseline.lineId);
  assert.equal(updated.preview.text, '灯塔亮起。');
  assert.deepEqual(updated.preview.snapshot, baseline.snapshot);
  assert.equal(updated.preview.slots[1].stateId, 'ready');
  await edit('arrival.json', doc => { doc.nodes.view.next = 'missing'; });
  const rejected = await refreshPreview(entry, 'stay', undefined, updated.preview);
  assert.equal(rejected.status, 'rejected');
  assert.strictEqual(rejected.preview, updated.preview);
  assert.equal(rejected.diagnostics[0].code, 'unknown-target');
  await writeFile(join(root, 'arrival.json'), '{"id":');
  const syntaxError = await refreshPreview(entry, 'stay', undefined, updated.preview);
  assert.equal(syntaxError.diagnostics[0].code, 'invalid-json');
  assert.strictEqual(syntaxError.preview, updated.preview);
});

test('the public narrative runtime restores a snapshot after a chapter file rename and text-only edits', async t => {
  const { root, entry, edit } = await fixture(t);
  const saved = (await refreshPreview(entry, 'stay', 'shared-pier')).preview.snapshot;
  await rename(join(root, 'pier.json'), join(root, 'shared-chapter.json'));
  await edit('story.json', doc => { doc.chapters[1] = 'shared-chapter.json'; });
  await edit('zh-Hans.json', doc => { doc.messages['pier.shared'] = '新对白'; });
  const { story } = await loadProject(entry);
  const runtime = new NarrativeRuntime(story.definition.narrative);
  t.after(() => runtime.dispose());
  runtime.restore(saved);
  assert.equal(runtime.view.nodeId, 'pier/shared');
  assert.equal(runtime.advance(), true);
  assert.equal(runtime.view.action.name, 'journal.mark');
  const preview = (await refreshPreview(entry, 'stay', 'shared-pier')).preview;
  assert.equal(preview.text, '新对白');
  assert.deepEqual(preview.snapshot, saved);
});

test('field diagnostics report exact paths for cross-chapter jumps, repeated line/choice/chapter IDs and undeclared actions', async t => {
  const { entry, edit, root } = await fixture(t);
  await edit('arrival.json', doc => {
    doc.nodes.view.next = 'pier/does-not-exist';
    doc.nodes.offer.options[1].id = 'stay';
  });
  await edit('ending.json', doc => { doc.nodes.tide.lineId = doc.nodes.lantern.lineId; });
  await edit('pier.json', doc => { doc.nodes.journal.name = 'unregistered'; });
  await writeFile(join(root, 'extra.json'), '{"id":"arrival","nodes":{}}\n');
  await edit('story.json', doc => doc.chapters.push('extra.json'));
  const { story, diagnostics } = await loadProject(entry);
  assert.equal(story, null);
  const byCode = Object.fromEntries(diagnostics.map(item => [item.code, item]));
  assert.deepEqual(byCode['unknown-target'].path, ['nodes', 'view', 'next']);
  assert.deepEqual(byCode['duplicate-choice'].path, ['nodes', 'offer', 'options', 1, 'id']);
  assert.deepEqual(byCode['duplicate-line'].path, ['nodes', 'tide', 'lineId']);
  assert.equal(byCode['duplicate-chapter'].file, 'extra.json');
  assert.deepEqual(byCode['undeclared-action'].path, ['nodes', 'journal', 'name']);
  assert.ok(diagnostics.every(item => item.line >= 1 && item.column > 1));
  const content = (await readFile(join(root, 'arrival.json'), 'utf8')).split('\n');
  const { line, column } = byCode['unknown-target'];
  assert.match(content[line - 1].slice(column - 1), /^"pier\/does-not-exist"/);
});

test('a repeated JSON key is rejected on its second source line before JSON can overwrite it', async t => {
  const { entry, root } = await fixture(t);
  await writeFile(join(root, 'ending.json'), '{\n"id":"ending",\n"nodes":{"x":{},\n"x":{}}\n}\n');
  const { story, diagnostics } = await loadProject(entry);
  assert.equal(story, null);
  assert.deepEqual(diagnostics, [{
    file: 'ending.json', line: 4, column: 1, path: ['nodes', 'x'],
    severity: 'error', code: 'duplicate-key', message: 'Duplicate key "x".',
  }]);
});

test('language packs, optional voices and structural reachability are checked together', async t => {
  const { entry, edit, root } = await fixture(t);
  await edit('en.json', doc => { delete doc.messages['choice.stay']; });
  await edit('arrival.json', doc => { doc.nodes.view.voices = { 'zh-Hans': 'greeting' }; });
  const pcm = Buffer.alloc(46);
  pcm.write('RIFF');
  pcm.writeUInt32LE(38, 4);
  pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(48000, 24);
  pcm.writeUInt32LE(96000, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36);
  pcm.writeUInt32LE(2, 40);
  await writeFile(join(root, 'greeting.wav'), pcm);
  await edit('story.json', doc => { doc.assets.greeting = { kind: 'audio', path: 'greeting.wav' }; });
  await edit('ending.json', doc => {
    doc.nodes.hidden = { type: 'end', ending: 'hidden', lineId: 'hidden-end', textKey: 'ending.tide' };
  });
  const { story, diagnostics } = await loadProject(entry);
  assert.deepEqual(diagnostics.map(item => item.code), ['missing-voice', 'missing-translation', 'unreachable-ending']);
  assert.ok(diagnostics.every(item => item.severity === 'warning' && item.line > 1));
  assert.deepEqual({ ...story.lines['first-view'].voices }, { 'zh-Hans': 'greeting' });
  assert.equal((await refreshPreview(entry, 'stay', 'first-view')).preview.voiceAssetId, 'greeting');
  const strict = await exec(process.execPath, [cli, 'check', entry, '--strict']).catch(error => error);
  assert.equal(strict.code, 1);
  assert.match(strict.stderr, /arrival\.json:\d+:\d+ warning \[missing-voice\]/);
});

test('bad material references, missing files and malformed HYA surface at the source field', async t => {
  const { entry, edit, root } = await fixture(t);
  await edit('story.json', doc => { doc.presets.evening[0].assetId = 'not-registered'; });
  assert.deepEqual((await loadProject(entry)).diagnostics[0].path, ['presets', 'evening', 0, 'assetId']);
  await edit('story.json', doc => { doc.presets.evening[0].assetId = 'harbor'; doc.assets.keeper.path = 'missing.hya.json'; });
  await writeFile(join(root, 'harbor.hya.json'), '{}\n');
  let result = await loadProject(entry);
  assert.equal(result.story, null);
  assert.deepEqual(result.diagnostics.map(({ code, path }) => [code, path]), [
    ['unreadable-asset', ['assets', 'harbor', 'path']], ['unreadable-asset', ['assets', 'keeper', 'path']],
  ]);
  await edit('story.json', doc => { doc.assets.keeper.path = '../external.hya'; });
  result = await loadProject(entry);
  assert.equal(result.diagnostics[0].code, 'invalid-path');
});

test('a closed all-automatic loop is rejected while an automatic subgraph with a structural escape is allowed', async t => {
  const { entry, edit } = await fixture(t);
  await edit('ending.json', doc => {
    doc.nodes.loop = { type: 'effect', effects: [], next: 'branch' };
    doc.nodes.branch = {
      type: 'branch', condition: { op: 'eq', variable: 'trust', value: 0 }, then: 'loop', otherwise: 'loop',
    };
  });
  const result = await loadProject(entry);
  assert.equal(result.story, null);
  assert.deepEqual(result.diagnostics.filter(item => item.code === 'closed-automatic-cycle').map(item => item.path[1]), ['loop', 'branch']);
  await edit('ending.json', doc => { doc.nodes.branch.otherwise = 'lantern'; });
  assert.ok((await loadProject(entry)).story);
});

test('a route blocked by an evaluated condition reports the affected step and preserves the prior view', async t => {
  const { entry, edit } = await fixture(t);
  const previous = (await refreshPreview(entry, 'stay')).preview;
  await edit('story.json', doc => { delete doc.routes.stay.initial; });
  const result = await refreshPreview(entry, 'stay', undefined, previous);
  assert.strictEqual(result.preview, previous);
  assert.equal(result.status, 'rejected');
  assert.equal(result.diagnostics[0].code, 'invalid-preview-route');
  assert.deepEqual(result.diagnostics[0].path, ['routes', 'stay', 'steps', 1]);
});

test('CLI produces portable bytes, protects source files, and keeps the last output on compilation failure', async t => {
  const { entry, edit, root } = await fixture(t);
  const out = join(root, 'compiled.json');
  assert.equal(JSON.parse((await exec(process.execPath, [cli, 'compile', entry, '--out', out, '--strict'])).stdout).status, 'ready');
  const bytes = await readFile(out, 'utf8');
  assert.equal(JSON.parse(bytes).definition.schemaVersion, 1);
  const overwrite = await exec(process.execPath, [cli, 'compile', entry, '--out', join(root, 'arrival.json')]).catch(error => error);
  assert.equal(overwrite.code, 1);
  assert.match(overwrite.stderr, /overwrite a source/);
  await edit('arrival.json', doc => { doc.nodes.view.next = 'missing'; });
  const failed = await exec(process.execPath, [cli, 'compile', entry, '--out', out]).catch(error => error);
  assert.equal(failed.code, 1);
  assert.equal(await readFile(out, 'utf8'), bytes);
});

test('CLI reload stays at the same line through edits and a rejected rebuild', { timeout: 20000 }, async t => {
  const { entry, edit } = await fixture(t);
  const child = spawn(process.execPath, [cli, 'preview', entry, '--route', 'stay', '--line', 'first-view', '--reload'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  child.stderr.resume();
  const stream = createInterface({ input: child.stdout });
  t.after(() => { stream.close(); if (child.exitCode === null) child.kill(); });
  const lines = stream[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await lines.next()).value);
  const original = await next();
  assert.equal(original.preview.lineId, 'first-view');
  await edit('zh-Hans.json', doc => { doc.messages['arrival.view'] = '重载成功'; });
  child.stdin.write('\n');
  const updated = await next();
  assert.equal(updated.preview.text, '重载成功');
  assert.equal(updated.preview.lineId, original.preview.lineId);
  await edit('arrival.json', doc => { doc.nodes.view.next = 'missing'; });
  child.stdin.write('\n');
  const failed = await next();
  assert.equal(failed.status, 'rejected');
  assert.deepEqual(failed.preview, updated.preview);
  child.stdin.end('q\n');
  assert.deepEqual(await exited, [1, null]);
});
