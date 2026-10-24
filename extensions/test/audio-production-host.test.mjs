import assert from 'node:assert/strict';
import test from 'node:test';
import {AUDIO_BYTES, audioEventFixture, audioResolver, FakeAudioBackend, loadG08Modules} from './audio-event-parity-fixture.mjs';
import {hostFixture} from './audio-production-fixture.mjs';

const {audio, runtime, production: {ProductionAudioBackend}} = await loadG08Modules();
const document = audio.parseHyaAudioEvents(audioEventFixture());
const resource = document.resources[0];
const flush = () => new Promise(resolve => queueMicrotask(resolve));


async function decoded(backend, value = resource, signal = new AbortController().signal) {
  return backend.decode({resource: value, bytes: AUDIO_BYTES.slice().buffer}, signal);
}
function schedule(backend, buffer, onEnded = () => {}) {
  return backend.schedule({voiceId: 'voice', decoded: buffer, whenFrame: 240, offsetFrame: 120,
    stopFrame: 1440, gain: .4, rate: 2, bus: 'sfx', onEnded});
}

test('production host preserves existing three-domain schedule, gain chain, stop and event trace', async () => {
  const referenceBackend = new FakeAudioBackend();
  const reference = new runtime.AudioEventRuntime(document, referenceBackend, {resolver: audioResolver()});
  const host = hostFixture(), backend = new ProductionAudioBackend(host);
  const player = new runtime.AudioEventRuntime(document, backend, {resolver: backend.resolver});
  for (const owner of [reference, player]) {
    await owner.prepare(); await owner.advance({composition: 0, state: 0, event: 0});
    await owner.dispatchCue({eventId: 'action', cue: 'blip', operation: 'start', clock: 'event'});
    await owner.dispatchCue({eventId: 'action', cue: 'blip', operation: 'start', clock: 'event'});
  }
  const projection = value => [value.voiceId ?? value.token.slice(value.token.indexOf(':') + 1), value.whenFrame ?? value.startFrame,
    value.offsetFrame, value.stopFrame, value.rate, value.gain, value.loop ?? null, value.bus];
  assert.deepEqual(host.requests.map(projection), referenceBackend.schedules.map(projection));
  assert.deepEqual(player.trace, reference.trace);
  assert.deepEqual(host.controls.filter(value => value[0] === 'stop').map(value => [value[1].slice(value[1].indexOf(':') + 1), value[2]]), referenceBackend.stops);
  assert.deepEqual(host.requests.map(value => value.bus), ['sfx', 'music', 'sfx', 'sfx']);
  player.dispose(); reference.dispose();
  assert.equal(backend.stats.voices, 0); assert.equal(backend.stats.decoded, 0);
  assert.equal(host.state, 'running'); assert.ok(host.decoded.every(value => value.released === 1));
});

test('future sample-frame controls and decoder lifetime survive owner release until last voice ends', async () => {
  const host = hostFixture(), backend = new ProductionAudioBackend(host), buffer = await decoded(backend);
  let ended = 0; const voice = schedule(backend, buffer, () => ended++);
  assert.equal(host.requests[0].durationFrames, 1200);
  voice.setGain(.25, 480); voice.setRate(1.5, 720);
  assert.deepEqual(host.controls, [['gain', host.requests[0].token, .25, 480], ['rate', host.requests[0].token, 1.5, 720]]);
  buffer.release(); buffer.release(); assert.equal(host.decoded[0].released, 0);
  voice.stop(1200); voice.dispose(); host.requests[0].onEnded();
  assert.equal(ended, 1); assert.equal(host.decoded[0].released, 1); assert.equal(host.released, 1);
  assert.deepEqual(backend.stats, {voices: 0, decoded: 0, jobs: 0, faults: 0, disposed: false});
  backend.dispose();
});

test('pausing and disposing one player does not suspend the shared audio host or another player', async () => {
  const host = hostFixture(), firstBackend = new ProductionAudioBackend(host), secondBackend = new ProductionAudioBackend(host);
  const first = new runtime.AudioEventRuntime(document, firstBackend, {resolver: firstBackend.resolver});
  const second = new runtime.AudioEventRuntime(document, secondBackend, {resolver: secondBackend.resolver});
  for (const player of [first, second]) {await player.prepare(); await player.advance({composition: 0, state: 0, event: 0});}
  const voices = second.stats.voices;
  assert.equal(new Set(host.requests.map(request => request.token)).size, host.requests.length, 'voice identities cannot collide across owners of a shared host');
  await first.pause(); assert.equal(host.state, 'running'); assert.equal(second.stats.voices, voices);
  first.dispose(); assert.equal(host.state, 'running'); assert.equal(second.stats.voices, voices);
  await second.dispatchCue({eventId: 'after-other-dispose', cue: 'blip', operation: 'start', clock: 'event'});
  assert.ok(second.stats.voices >= voices); second.dispose();
  assert.ok(host.decoded.every(value => value.released === 1));
});

test('synchronous host completion is notified after caller registration, once, without a retained voice', async () => {
  const host = hostFixture(); host.syncEnd = true;
  const backend = new ProductionAudioBackend(host), buffer = await decoded(backend);
  let registered = false, ended = 0;
  const voice = schedule(backend, buffer, () => {assert.equal(registered, true); ended++;});
  registered = true; assert.equal(ended, 0); await flush();
  voice.dispose(); assert.equal(ended, 1); assert.equal(host.released, 1); assert.equal(backend.stats.voices, 0);
  buffer.release(); backend.dispose(); assert.equal(host.decoded[0].released, 1);
});

test('failed scheduling cannot emit an ended event or retain a decoder voice reference', async () => {
  const host = hostFixture(); host.syncEnd = true; host.throwSchedule = true;
  const backend = new ProductionAudioBackend(host), buffer = await decoded(backend); let ended = 0;
  assert.throws(() => schedule(backend, buffer, () => ended++), /host schedule failed/);
  await flush(); assert.equal(ended, 0); assert.equal(backend.stats.voices, 0);
  buffer.release(); assert.equal(host.decoded[0].released, 1); backend.dispose();
});

test('abort and disposal cancel live decodes and release late host results exactly once', async () => {
  for (const dispose of [false, true]) {
    const host = hostFixture(); let resolve; host.gate = new Promise(done => {resolve = done;});
    const backend = new ProductionAudioBackend(host), controller = new AbortController();
    const job = decoded(backend, resource, controller.signal);
    assert.equal(backend.stats.jobs, 1);
    if (dispose) backend.dispose(); else controller.abort();
    assert.equal(host.decoded[0].signal.aborted, true); resolve();
    await assert.rejects(job, error => error.code === 'E_AUDIO_RUNTIME_ABORTED');
    assert.equal(host.decoded[0].released, 1); assert.equal(backend.stats.jobs, 0); assert.equal(backend.stats.decoded, 0);
    backend.dispose();
  }
});

test('existing asset owner verifies bytes before host decode and rejects false PCM metadata', async () => {
  const host = hostFixture(), backend = new ProductionAudioBackend(host);
  const bad = structuredClone(resource); bad.integrity.digest = '0'.repeat(64);
  const owner = new runtime.AudioAssetOwner([bad], backend, {...document.limits, ownsDecoder: false});
  await assert.rejects(owner.load(bad.id), error => error.code === 'E_AUDIO_RUNTIME_INTEGRITY');
  assert.equal(host.decoded.length, 0); owner.dispose();
  const original = host.decode.bind(host);
  host.decode = async (...args) => ({...await original(...args), bytes: 1});
  await assert.rejects(decoded(backend), error => error.code === 'E_AUDIO_RUNTIME_DECODE');
  assert.equal(host.decoded[0].released, 1); assert.equal(backend.stats.decoded, 0); backend.dispose();
});

test('host contract rejects absent ports and invalid clocks before creating decoders or voices', () => {
  for (const mutation of [host => {delete host.decode;}, host => {host.frame = NaN;}, host => {host.state = 'unknown';}, host => {host.sampleRate = 0;}]) {
    const host = hostFixture(); mutation(host);
    assert.throws(() => new ProductionAudioBackend(host), error => /^E_AUDIO_RUNTIME_/.test(error.code));
    assert.equal(host.decoded.length, 0); assert.equal(host.requests.length, 0);
  }
});

test('cleanup failures are bounded and cannot interrupt other owned resource releases', async () => {
  const host = hostFixture(), decode = host.decode.bind(host);
  host.decode = async (...args) => ({...await decode(...args), release() {throw new Error('release failure');}});
  const backend = new ProductionAudioBackend(host);
  for (let index = 0; index < 70; index++) {const value = await decoded(backend); value.release();}
  assert.equal(backend.stats.faults, 70); assert.equal(backend.cleanupFaults.length, 64);
  assert.equal(backend.stats.decoded, 0); backend.dispose();
});
