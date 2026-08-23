import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { audioEventFixture, loadG08Modules } from './audio-event-parity-fixture.mjs';

const { audio } = await loadG08Modules();

test('audio event v1 parses and deep-freezes every neutral delivery and scheduling policy', () => {
  const parsed = audio.parseHyaAudioEvents(audioEventFixture());
  assert.equal(parsed.extension, 'org.haiyue.audio-events@1');
  assert.deepEqual(parsed.resources.map(resource => resource.source.kind), ['embedded', 'referenced', 'hosted']);
  assert.deepEqual(parsed.timelineEvents.map(event => event.clock), ['composition', 'composition', 'state', 'event']);
  assert.equal(parsed.cues[1].loop.iterations, 'infinite');
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.resources));
  assert.ok(Object.isFrozen(parsed.resources[0].source));
  assert.ok(Object.isFrozen(parsed.cues[1].loop));
});

test('strict parser rejects unknown fields, versions, codecs, integrity, references and graph cycles', () => {
  const unknown = audioEventFixture();
  unknown.extra = true;
  assert.throws(() => audio.parseHyaAudioEvents(unknown), error => error.code === 'E_AUDIO_EVENT_FORMAT' && error.path === '$.extra');

  const version = audioEventFixture();
  version.version = 2;
  assert.throws(() => audio.parseHyaAudioEvents(version), error => error.code === 'E_AUDIO_EVENT_VERSION');

  const codec = audioEventFixture();
  codec.resources[0].mediaType = 'audio/mpeg';
  assert.throws(() => audio.parseHyaAudioEvents(codec), error => error.code === 'E_AUDIO_EVENT_CODEC');

  const integrity = audioEventFixture();
  integrity.resources[0].integrity.digest = 'ABC';
  assert.throws(() => audio.parseHyaAudioEvents(integrity), error => error.code === 'E_AUDIO_EVENT_INTEGRITY');

  const reference = audioEventFixture();
  reference.cues[0].resource = 'missing';
  assert.throws(() => audio.parseHyaAudioEvents(reference), error => error.code === 'E_AUDIO_EVENT_REFERENCE');

  const graph = audioEventFixture();
  graph.buses[0].parent = 'sfx';
  assert.throws(() => audio.parseHyaAudioEvents(graph), error => error.code === 'E_AUDIO_EVENT_GRAPH');

  const cyclic = audioEventFixture();
  cyclic.self = cyclic;
  assert.throws(() => audio.parseHyaAudioEvents(cyclic), error => error.code === 'E_AUDIO_EVENT_GRAPH');
});

test('parser rejects malformed loop ranges, unsafe gain chains and all hard budgets before runtime', () => {
  const loop = audioEventFixture();
  loop.cues[1].durationFrames = 100;
  assert.throws(() => audio.parseHyaAudioEvents(loop), error => error.code === 'E_AUDIO_EVENT_FORMAT');

  const range = audioEventFixture();
  range.cues[1].loop.endFrame = 100;
  assert.throws(() => audio.parseHyaAudioEvents(range), error => error.code === 'E_AUDIO_EVENT_NUMBER');

  const gain = audioEventFixture();
  gain.buses[0].gain = 4;
  gain.buses[1].gain = 4;
  assert.throws(() => audio.parseHyaAudioEvents(gain), error => error.code === 'E_AUDIO_EVENT_LIMIT');

  const resources = audioEventFixture();
  assert.throws(
    () => audio.parseHyaAudioEvents(resources, { limits: { maxResources: 2 } }),
    error => error.code === 'E_AUDIO_EVENT_LIMIT',
  );

  const events = audioEventFixture();
  assert.throws(
    () => audio.parseHyaAudioEvents(events, { limits: { maxTimelineEvents: 3 } }),
    error => error.code === 'E_AUDIO_EVENT_LIMIT',
  );

  const decoded = audioEventFixture();
  decoded.limits.maxDecodedBytes = 4;
  assert.throws(() => audio.parseHyaAudioEvents(decoded), error => error.code === 'E_AUDIO_EVENT_LIMIT');

  const voices = audioEventFixture();
  voices.limits.maxVoicesPerResource = 5;
  assert.throws(() => audio.parseHyaAudioEvents(voices), error => error.code === 'E_AUDIO_EVENT_LIMIT');
});

test('restricted media profile is explicit and cannot masquerade as multi-voice parity', () => {
  const restricted = audioEventFixture();
  restricted.playbackProfile = 'html-media-restricted';
  assert.throws(() => audio.parseHyaAudioEvents(restricted), error => error.code === 'E_AUDIO_EVENT_FORMAT');
  restricted.limits.maxVoices = 1;
  restricted.limits.maxVoicesPerResource = 1;
  for (const cue of restricted.cues) cue.overlap = 'ignore';
  const parsed = audio.parseHyaAudioEvents(restricted);
  assert.equal(parsed.playbackProfile, 'html-media-restricted');
});

test('frozen G08 census identities have complete source-neutral solution families', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const census = JSON.parse(await readFile(path.join(workspace, 'docs/for-ai/rive-hya/runtime-census.json'), 'utf8'));
  const contract = audio.G08_AUDIO_CENSUS_CONTRACT;
  const objects = census.objects.filter(entry => entry.goal === contract.goal);
  const properties = census.properties.filter(entry => entry.goal === contract.goal);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(census.compatibilityTupleId, 'rive-7.3-webgl2-2.40.0');
  assert.equal(objects.length, contract.objectCount);
  assert.equal(properties.length, contract.propertyCount);
  assert.equal(digest(objects.map(entry => `${entry.typeKey}:${entry.name}`)), contract.objectIdentitySha256);
  assert.equal(digest(properties.map(entry => `${entry.key}:${entry.owner}.${entry.name}`)), contract.propertyIdentitySha256);
  assert.ok([...objects, ...properties].every(entry => (
    entry.family === contract.family
    && entry.fixtureOwner === contract.goal
    && entry.diagnostic
    && entry.diagnostic !== 'UNCLASSIFIED'
  )));
  assert.equal(new Set(contract.solutions).size, contract.solutions.length);
});

test('audio contracts and runtime contain no source-format branch or class vocabulary', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const roots = ['animation-spec/src/audio', 'extensions/src/animation/audio'];
  const files = (await Promise.all(roots.map(root => walk(path.join(workspace, root))))).flat().filter(file => file.endsWith('.ts'));
  for (const file of files) assert.doesNotMatch(await readFile(file, 'utf8'), /rive/i, file);
});

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(resolved));
    else result.push(resolved);
  }
  return result;
}
