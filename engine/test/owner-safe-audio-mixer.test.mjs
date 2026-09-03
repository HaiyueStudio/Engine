import assert from 'node:assert/strict';
import test from 'node:test';
import { OwnerSafeAudioMixer } from '../dist/experimental/audio.js';

class FakeParam { value = 0; setValueAtTime(value) { this.value = value; } }
class FakeNode { connections = []; disconnected = 0; connect(node) { this.connections.push(node); return node; } disconnect() { this.disconnected++; this.connections.length = 0; } }
class FakeSource extends FakeNode { buffer = null; loop = false; playbackRate = new FakeParam(); onended = null; starts = 0; stops = 0; start() { this.starts++; } stop() { this.stops++; this.onended?.(); } }
class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakePanner extends FakeNode { pan = new FakeParam(); }
class FakeContext {
  state = 'suspended'; currentTime = 0; sampleRate = 48_000; destination = new FakeNode(); sources = []; panners = []; closed = 0;
  createBufferSource() { const value = new FakeSource(); this.sources.push(value); return value; }
  createGain() { return new FakeGain(); }
  createStereoPanner() { const value = new FakePanner(); this.panners.push(value); return value; }
  async decodeAudioData() { return buffer('decoded'); }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.closed++; this.state = 'closed'; }
}

test('owner-safe mixer requires unlock and replaces an owner channel without leaking nodes', async () => {
  const context = new FakeContext(); const mixer = new OwnerSafeAudioMixer({ context, maxVoicesTotal: 4, maxVoicesPerOwner: 2 }); mixer.installBuffer('hit', buffer('hit'));
  assert.equal(mixer.play(request('event-0')), null); await mixer.unlock(); const first = mixer.play(request('event-1')); assert.equal(first, 'voice:1'); assert.equal(mixer.stats.voices, 1);
  const second = mixer.play(request('event-2')); assert.equal(second, 'voice:2'); assert.equal(context.sources[0].stops, 1); assert.equal(mixer.stats.voices, 1); assert.equal(mixer.stats.audioNodes, 7);
  assert.equal(mixer.releaseOwner('P1'), 1); assert.equal(mixer.stats.voices, 0); assert.equal(mixer.stats.audioNodes, 4); mixer.dispose(); mixer.dispose(); assert.equal(context.closed, 0);
});

test('voice budgets evict the oldest lowest priority deterministically and protect higher priority', async () => {
  const context = new FakeContext(); const mixer = new OwnerSafeAudioMixer({ context, maxVoicesTotal: 2, maxVoicesPerOwner: 2 }); mixer.installBuffer('hit', buffer('hit')); await mixer.unlock();
  mixer.play(request('low-a', 'P1', 'a', 1)); mixer.play(request('high-b', 'P2', 'b', 10)); mixer.play(request('low-c', 'P3', 'c', 1));
  assert.equal(context.sources[0].stops, 1); assert.equal(context.sources[1].stops, 0); assert.equal(mixer.stats.voices, 2);
  assert.throws(() => mixer.play(request('too-low', 'P4', 'd', 0)), /higher-priority/u); mixer.dispose();
});

test('setPan updates only the selected live owner channel and validates its range', async () => {
  const context = new FakeContext(); const mixer = new OwnerSafeAudioMixer({ context }); mixer.installBuffer('hit', buffer('hit')); await mixer.unlock();
  mixer.play(request('p1-a', 'P1', 'voice')); mixer.play(request('p2-a', 'P2', 'voice'));
  assert.equal(mixer.setPan('P1', 'voice', .75), true); assert.equal(context.panners[0].pan.value, .75); assert.equal(context.panners[1].pan.value, 0);
  assert.equal(mixer.setPan('P1', 'missing', 0), false); assert.throws(() => mixer.setPan('P1', 'missing', 2), /pan/u); mixer.dispose();
});

test('low-priority channel requests preserve the existing voice', async () => {
  const context = new FakeContext(); const mixer = new OwnerSafeAudioMixer({ context }); mixer.installBuffer('hit', buffer('hit')); await mixer.unlock(); const first = mixer.play(request('first'));
  assert.equal(mixer.play({ ...request('low'), replaceChannel: false }), null); assert.equal(context.sources[0].stops, 0); assert.equal(mixer.stats.voices, 1); assert.equal(mixer.play({ ...request('replace'), replaceChannel: true }), 'voice:2'); assert.equal(context.sources[0].stops, 1); assert.notEqual(first, null); mixer.dispose();
});

test('decode, bus controls, suspend and owned-context disposal remain owner-safe', async () => {
  const context = new FakeContext(); const mixer = new OwnerSafeAudioMixer({ contextFactory: () => context, ownsContext: true }); const decoded = await mixer.decodeAndInstall('tone', new ArrayBuffer(12)); assert.equal(decoded.id, 'decoded'); await mixer.unlock(); mixer.setMasterVolume(0.5); mixer.setBusVolume('sfx', 0.25); mixer.play({ ...request('tone-event'), bufferId: 'tone', volume: 0.75, pan: -0.5, frequency: 1.5, loop: true });
  await mixer.suspend(); assert.equal(mixer.stats.state, 'suspended'); assert.equal(mixer.stats.sampleRate, 48_000); await mixer.resume(); assert.equal(mixer.stats.state, 'running'); mixer.dispose(); await Promise.resolve(); assert.equal(context.closed, 1); assert.deepEqual(mixer.stats, { state: 'closed', buffers: 0, voices: 0, owners: 0, audioNodes: 0, decodeJobs: 0, sampleRate: null, disposed: true });
});

function request(eventId, owner = 'P1', channel = 'voice', priority = 0) { return { eventId, bufferId: 'hit', owner, channel, bus: 'sfx', priority, startTick: 1 }; }
function buffer(id) { return { id, sampleRate: 48_000, length: 480, numberOfChannels: 1, duration: 0.01 }; }
