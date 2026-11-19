import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? '.');
assert.equal(basename(directory), 'edited', 'Use a fresh copy of the installed project named edited.');
const root = join(directory, 'project');
const load = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
const save = (path, data) => writeFile(join(root, path), JSON.stringify(data, null, 2) + '\n');
const [story, arrival, pier, ending, zh, en, signal] = await Promise.all(
  ['story.json', 'arrival.json', 'pier.json', 'ending.json', 'zh-Hans.json', 'en.json', 'assets/signal.hya.json'].map(load),
);

story.presets['rain-night'].find(slot => slot.id === 'keeper').bounds[0] += 100;
story.assets['gold-signal'] = { kind: 'hya', path: 'assets/gold-signal.hya.json' };
story.presets.beacon[0].assetId = 'gold-signal';
const recolor = color => { [color[0], color[1], color[2]] = [1, .59, .16]; };
const [core, motion] = signal.parts;
for (const node of core.document.nodes) recolor(node.components[0].fill);
for (const channel of motion.document.channels) if (channel.defaultValue) recolor(channel.defaultValue);
for (const track of motion.document.clips[0].tracks) {
  for (const key of track.keys) if (Array.isArray(key.value)) recolor(key.value);
}

arrival.nodes.fork.options.push({
  id: 'signal', textKey: 'choice.signal', next: 'pier/approach',
  effects: [{ op: 'set', variable: 'trust', value: 2 }],
});
pier.nodes['original-verdict'] = pier.nodes.verdict;
pier.nodes.verdict = { type: 'branch', condition: { op: 'gt', variable: 'trust', value: 1 },
  then: 'ending/relight', otherwise: 'original-verdict' };
ending.nodes.relight = { type: 'end', ending: 'relight', lineId: 'relight-end', textKey: 'ending.relight' };
Object.assign(zh.messages, { 'choice.signal': '点亮第二盏灯', 'ending.relight': '结局 · 双灯引航' });
Object.assign(en.messages, { 'choice.signal': 'Light a second lantern', 'ending.relight': 'Ending · Two Lights' });
story.routes.relight = structuredClone(story.routes.lantern);
story.routes.relight.steps.find(step => step.choiceId).choiceId = 'signal';

await Promise.all([
  ['story.json', story], ['arrival.json', arrival], ['pier.json', pier], ['ending.json', ending],
  ['zh-Hans.json', zh], ['en.json', en], ['assets/gold-signal.hya.json', signal],
].map(([path, data]) => save(path, data)));
