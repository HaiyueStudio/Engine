import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadStateMachineV2Modules, stateMachineV2Fixture, v1StateMachineFixture } from './state-machine-v2-parity-fixture.mjs';

const { spec, runtime } = await loadStateMachineV2Modules();
const { parseHyaStateMachineV2, migrateHyaStateMachineV1, HYA_CHANNEL_FAMILY_CONTRACTS, StateMachineV2Diagnostic } = spec;

test('v2 parser freezes one executable policy for every cross-goal channel family', () => {
  const document = parseHyaStateMachineV2(stateMachineV2Fixture());
  assert.equal(Object.isFrozen(document), true); assert.equal(Object.isFrozen(document.stateMachines[0].layers[0].transitions), true);
  assert.deepEqual(Object.keys(HYA_CHANNEL_FAMILY_CONTRACTS).sort(), ['event-audio-script', 'paint-path', 'resource-data', 'rig', 'text-layout', 'transform', 'visibility-order']);
  for (const family of Object.keys(HYA_CHANNEL_FAMILY_CONTRACTS)) assert.ok(document.channels.some(channel => channel.family === family), `fixture covers ${family}`);
  assert.deepEqual(new Set(document.channels.filter(channel => ['paint.color', 'text.value', 'resource.asset', 'audio.play'].includes(channel.id)).map(channel => channel.policy)), new Set(['override', 'discrete', 'ownership']));
});

test('strict parser rejects unknown fields, invalid policy, references, malformed graph and hard limits before runtime', () => {
  const unknown = stateMachineV2Fixture(); unknown.stateMachines[0].layers[0].surprise = true;
  assert.throws(() => parseHyaStateMachineV2(unknown), error => diagnostic(error, 'E_STATE_MACHINE_V2_FORMAT', '$.stateMachines[0].layers[0].surprise'));
  const policy = stateMachineV2Fixture(); policy.channels.find(channel => channel.id === 'visible').policy = 'additive';
  assert.throws(() => parseHyaStateMachineV2(policy), error => diagnostic(error, 'E_STATE_MACHINE_V2_POLICY', '$.channels[8]'));
  const reference = stateMachineV2Fixture(); reference.clips[0].tracks[0].channel = 'missing';
  assert.throws(() => parseHyaStateMachineV2(reference), error => diagnostic(error, 'E_STATE_MACHINE_V2_REFERENCE', '$.clips[0].tracks[0].channel'));
  const graph = stateMachineV2Fixture(); graph.stateMachines[0].layers[0].transitions = graph.stateMachines[0].layers[0].transitions.filter(transition => transition.from !== '@entry');
  assert.throws(() => parseHyaStateMachineV2(graph), error => diagnostic(error, 'E_STATE_MACHINE_V2_GRAPH', '$.stateMachines[0].layers[0].transitions'));
  const nestedCycle = stateMachineV2Fixture(); nestedCycle.components[0].source = { kind: 'state-machine', machine: 'main' }; nestedCycle.components[0].playback = 'state-machine';
  assert.throws(() => parseHyaStateMachineV2(nestedCycle), error => error.code === 'E_STATE_MACHINE_V2_GRAPH');
  const payloadCycle = stateMachineV2Fixture(), cycle = {}; cycle.self = cycle; payloadCycle.clips[0].tracks.find(track => track.channel === 'event.fire').keys[0].value = cycle;
  assert.throws(() => parseHyaStateMachineV2(payloadCycle), error => error.code === 'E_STATE_MACHINE_V2_FORMAT' && /cycle/.test(error.message));
  const random = stateMachineV2Fixture(); random.stateMachines[0].layers[0].transitions[1].randomWeight = 2;
  assert.throws(() => parseHyaStateMachineV2(random), error => error.code === 'E_STATE_MACHINE_V2_NUMBER');
  assert.throws(() => parseHyaStateMachineV2(stateMachineV2Fixture(), { limits: { maxKeyframes: 2 } }), error => error.code === 'E_STATE_MACHINE_V2_LIMIT');
});

test('v1 graph migration preserves masks, priorities, any-state, trigger, loop, offset and interruption without a v1 sampler', () => {
  const fixture = stateMachineV2Fixture(), byId = Object.fromEntries(fixture.clips.map(clip => [clip.id, clip.tracks]));
  const migrated = migrateHyaStateMachineV1(v1StateMachineFixture(), { channels: fixture.channels, tracksByClip: byId });
  assert.deepEqual(migrated.diagnostics.map(entry => entry.code), ['W_STATE_MACHINE_V1_MIGRATED']);
  const machine = migrated.document.stateMachines[0], layer = machine.layers[0], transition = layer.transitions.find(entry => entry.id === 'go');
  assert.equal(layer.transitions[0].from, '@entry'); assert.equal(layer.states[0].motion.playback, 'loop');
  assert.equal(transition.from, '@any'); assert.equal(transition.conditionGroups[0][0].kind, 'trigger');
  assert.equal(transition.destinationOffset, 0.25); assert.equal(transition.interruption, 'source');
  const graphOnly = migrateHyaStateMachineV1(v1StateMachineFixture());
  assert.ok(graphOnly.diagnostics.some(entry => entry.code === 'W_STATE_MACHINE_V1_CHANNEL_POLICY_REQUIRED'));
  const controller = new runtime.HyaStateMachineRuntimeV2(graphOnly.document, 'legacy'); controller.setTrigger('go'); controller.update(0.1);
  assert.equal(controller.trace.layers[0].transitionId, 'go'); assert.equal(controller.getInput('go'), false); controller.update(0.1); assert.equal(controller.trace.layers[0].stateId, 'active'); assert.ok(controller.trace.layers[0].localTime >= 0.25);
});

test('frozen timeline/state census map is byte-for-byte synchronized with the accepted runtime census', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const [census, map] = await Promise.all([
    readFile(path.join(workspace, 'docs/for-ai/rive-hya/runtime-census.json'), 'utf8').then(JSON.parse),
    readFile(path.join(workspace, 'animation-spec/schema/state-machine-v2-census-map.json'), 'utf8').then(JSON.parse),
  ]);
  const family = 'timeline-state-machine';
  assert.equal(map.compatibilityTupleId, census.compatibilityTupleId);
  assert.deepEqual(map.objects, census.objects.filter(entry => entry.family === family).map(entry => ({ typeKey: entry.typeKey, name: entry.name })));
  assert.deepEqual(map.properties, census.properties.filter(entry => entry.family === family).map(entry => ({ key: entry.key, owner: entry.owner, name: entry.name })));
  assert.equal(map.objects.length, 59); assert.equal(map.properties.length, 75);
  const [schema, contract] = await Promise.all([
    readFile(path.join(workspace, 'animation-spec/schema/state-machine-v2.schema.json'), 'utf8').then(JSON.parse),
    readFile(path.join(workspace, 'animation-spec/schema/state-machine-v2.contract.json'), 'utf8').then(JSON.parse),
  ]);
  assert.equal(schema.properties.extension.const, contract.extension); assert.equal(contract.census.objectCount, 59); assert.equal(contract.migration.noSecondSampler, true);
});

function diagnostic(error, code, path) { return error instanceof StateMachineV2Diagnostic && error.code === code && error.path === path; }
