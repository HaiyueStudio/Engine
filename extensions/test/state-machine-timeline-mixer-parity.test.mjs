import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStateMachineV2Modules, stateMachineV2Fixture } from './state-machine-v2-parity-fixture.mjs';

const { spec, runtime } = await loadStateMachineV2Modules();
const document = spec.parseHyaStateMachineV2(stateMachineV2Fixture());
const { TimelineSamplerV2, ChannelMixerV2, mapPlaybackTime } = runtime;

test('timeline sampler executes linear, cubic-ease, cubic-value, elastic and hold channels from one neutral clip', () => {
  const sampler = new TimelineSamplerV2(document), sample = sampler.sample('idle', 1);
  const values = Object.fromEntries(sample.contributions.map(entry => [entry.channel.id, entry.value]));
  assert.equal(values['transform.x'], 2); assert.deepEqual(values['path.points'], [1, 2]);
  assert.ok(Math.abs(values['transform.rotation']) > 3, 'angle channel follows the shortest signed arc across pi');
  assert.ok(values['paint.color'][0] < 0.5 && values['paint.color'][2] > 0.5, 'cubic easing is non-linear');
  assert.equal(values['rig.angle'], 1); assert.equal(values['text.value'], 'half');
  assert.equal(values['resource.asset'], 'b'); assert.equal(values.visible, false); assert.equal(values['draw.order'], 2);
  assert.ok(Number.isFinite(values['layout.width'])); sampler.dispose(); sampler.dispose();
  assert.throws(() => sampler.sample('idle', 0), error => error.code === 'E_STATE_MACHINE_RUNTIME_DISPOSED');
});

test('one-shot, loop, ping-pong, negative time, quantize and explicit remap are deterministic', () => {
  assert.equal(mapPlaybackTime(-1, 2, 'one-shot'), 0); assert.equal(mapPlaybackTime(5, 2, 'one-shot'), 2);
  assert.equal(mapPlaybackTime(-0.5, 2, 'loop'), 1.5); assert.equal(mapPlaybackTime(2.5, 2, 'loop'), 0.5);
  assert.equal(mapPlaybackTime(-0.5, 2, 'ping-pong'), 0.5); assert.equal(mapPlaybackTime(2.5, 2, 'ping-pong'), 1.5);
  const sampler = new TimelineSamplerV2(document);
  assert.equal(value(sampler.sample('idle', -0.5, { playback: 'loop' }), 'transform.x'), 3);
  assert.equal(value(sampler.sample('idle', 999, { timeRemap: 0.5 }), 'transform.x'), 1);
  const quantized = structuredClone(document); quantized.clips[0].quantize = true; quantized.clips[0].fps = 2;
  assert.equal(value(new TimelineSamplerV2(quantized).sample('idle', 0.26), 'transform.x'), 1);
});

test('callback ranges enumerate forward, reverse, loop and ping-pong occurrences in stable source order', () => {
  const sampler = new TimelineSamplerV2(document);
  const forward = sampler.sample('idle', 2.6, { playback: 'loop', previousRawTime: 0 }).effects;
  assert.deepEqual(forward.filter(entry => entry.channel.id === 'event.fire').map(entry => entry.occurrenceTime), [0.25, 1.25, 2.25]);
  assert.deepEqual(forward.map(entry => entry.occurrenceTime), [...forward.map(entry => entry.occurrenceTime)].sort((a, b) => a - b));
  const reverse = sampler.sample('idle', 0.1, { playback: 'loop', previousRawTime: 2.6 }).effects.filter(entry => entry.channel.id === 'event.fire');
  assert.deepEqual(reverse.map(entry => entry.occurrenceTime), [2.25, 1.25, 0.25]);
  const ping = sampler.sample('idle', 4, { playback: 'ping-pong', previousRawTime: 0 }).effects.filter(entry => entry.channel.id === 'event.fire');
  assert.deepEqual(ping.map(entry => entry.occurrenceTime), [0.25, 1.25, 2.75, 3.75]);
  const withStart = structuredClone(document), eventTrack = withStart.clips.find(clip => clip.id === 'active').tracks.find(track => track.channel === 'event.fire'); eventTrack.keys.unshift({ time: 0, value: { name: 'start' } });
  assert.deepEqual(new TimelineSamplerV2(withStart).sample('active', 0, { previousRawTime: 0 }).effects.map(entry => entry.payload.name), ['start']);
});

test('mixer executes override/additive/discrete/ownership policies with ordered layer and action priority', () => {
  const channels = Object.fromEntries(document.channels.map(channel => [channel.id, channel])), mixer = new ChannelMixerV2(undefined, ownershipPort()); mixer.begin();
  for (const contribution of [
    c(channels['transform.x'], 10, 0.5, 0, 0, 'override'), c(channels['transform.x'], 2, 1, 1, 0, 'additive'),
    c(channels['rig.angle'], 3, 0.5, 0, 0, 'additive'), c(channels['text.value'], 'low', 1, 0, 9, 'override'), c(channels['text.value'], 'high', 0.6, 1, 0, 'override'),
    c(channels['resource.asset'], 'old', 1, 0, 5, 'override'), c(channels['resource.asset'], 'owner', 0.2, 2, 0, 'override'),
  ]) mixer.submitContribution(contribution);
  const pose = mixer.commit(), values = Object.fromEntries(pose.channels.map(entry => [entry.channel.id, entry.value]));
  assert.equal(values['transform.x'], 7); assert.equal(values['rig.angle'], 1.5); assert.equal(values['text.value'], 'high'); assert.equal(values['resource.asset'], 'owner');
  const crossfade = new ChannelMixerV2(); crossfade.begin(); crossfade.submitContribution(c(channels['transform.x'], 0, 0.5, 0, 0, 'override')); crossfade.submitContribution(c(channels['transform.x'], 10, 0.5, 0, 1, 'override')); assert.equal(crossfade.commit().channels[0].value, 5, 'same-layer transition weights are normalized once');
});

test('side effects are exactly once, transactional, rewindable and resettable', () => {
  const port = transactionalPort(), mixer = new ChannelMixerV2(port, ownershipPort()), sampler = new TimelineSamplerV2(document), sample = sampler.sample('idle', 1, { previousRawTime: 0 });
  mixer.begin(); mixer.submit(sample); const first = mixer.commit(); assert.equal(first.effects.length, 3); assert.equal(port.delivered.length, 3);
  mixer.begin(); mixer.submit(sample); assert.equal(mixer.commit().effects.length, 0); assert.equal(port.delivered.length, 3);
  mixer.rewind(0.4); mixer.begin(); mixer.submit(sample); assert.equal(mixer.commit().effects.length, 2, 'audio/script are re-armed after rewind');
  mixer.reset(); mixer.begin(); mixer.submit(sample); assert.equal(mixer.commit().effects.length, 3);
  const failingPort = transactionalPort(); failingPort.fail = true; const failing = new ChannelMixerV2(failingPort, ownershipPort()); failing.begin(); failing.submit(sample);
  assert.throws(() => failing.commit(), /side effect failure/); assert.equal(failing.deliveredEffectCount, 0); assert.deepEqual(failingPort.calls.slice(-1), ['rollback']);
});

test('resource/data ownership transfers, restores defaults, rolls back and releases on reset/dispose', () => {
  const channel = document.channels.find(entry => entry.id === 'resource.asset'), port = ownershipPort(), mixer = new ChannelMixerV2(undefined, port);
  mixer.begin(); mixer.submitContribution(c(channel, 'owned', 1, 0, 0, 'override')); mixer.commit(); assert.deepEqual(port.delivered.at(-1), { previous: 'a', next: 'owned' });
  mixer.begin(); mixer.commit(); assert.deepEqual(port.delivered.at(-1), { previous: 'owned', next: 'a' }, 'missing owner contribution restores declared default');
  mixer.begin(); mixer.submitContribution(c(channel, 'stable', 1, 0, 0, 'override')); mixer.commit(); port.fail = true; mixer.begin(); mixer.submitContribution(c(channel, 'rejected', 1, 0, 0, 'override'));
  assert.throws(() => mixer.commit(), /ownership failure/); port.fail = false; mixer.begin(); mixer.submitContribution(c(channel, 'stable', 1, 0, 0, 'override')); assert.equal(mixer.commit().channels.find(entry => entry.channel.id === channel.id).value, 'stable');
  mixer.reset(); assert.equal(port.resets, 1); mixer.dispose(); mixer.dispose(); assert.equal(port.disposals, 1);
});

test('missing side-effect and ownership ports fail structurally instead of silently dropping semantics', () => {
  const sampler = new TimelineSamplerV2(document), sample = sampler.sample('idle', 1, { previousRawTime: 0 });
  const missingEffect = new ChannelMixerV2(undefined, ownershipPort()); missingEffect.begin(); missingEffect.submit(sample); assert.throws(() => missingEffect.commit(), error => error.code === 'E_STATE_MACHINE_SIDE_EFFECT_PORT_REQUIRED');
  const resource = document.channels.find(entry => entry.id === 'resource.asset'), missingOwner = new ChannelMixerV2(transactionalPort()); missingOwner.begin(); missingOwner.submitContribution(c(resource, 'new-owner', 1, 0, 0, 'override')); assert.throws(() => missingOwner.commit(), error => error.code === 'E_STATE_MACHINE_OWNERSHIP_PORT_REQUIRED');
});

function value(sample, id) { return sample.contributions.find(entry => entry.channel.id === id).value; }
function c(channel, value, weight, layerOrder, actionOrder, blendMode) { return { channel, value, weight, layerOrder, actionOrder, blendMode }; }
function transactionalPort() { return { calls: [], staged: [], delivered: [], fail: false, begin() { this.calls.push('begin'); this.staged = []; }, invoke(effect) { this.calls.push('invoke'); if (this.fail) throw new Error('side effect failure'); this.staged.push(effect); }, commit() { this.calls.push('commit'); this.delivered.push(...this.staged); this.staged = []; }, rollback() { this.calls.push('rollback'); this.staged = []; }, reset() { this.calls.push('reset'); this.staged = []; }, pause() { this.calls.push('pause'); }, resume() { this.calls.push('resume'); }, stop() { this.calls.push('stop'); }, dispose() { this.calls.push('dispose'); this.staged = []; } }; }
function ownershipPort() { return { staged: [], delivered: [], fail: false, resets: 0, disposals: 0, begin() { this.staged = []; }, transfer(change) { if (this.fail) throw new Error('ownership failure'); this.staged.push({ previous: change.previous, next: change.next }); }, commit() { this.delivered.push(...this.staged); this.staged = []; }, rollback() { this.staged = []; }, reset() { this.resets++; }, dispose() { this.disposals++; } }; }
