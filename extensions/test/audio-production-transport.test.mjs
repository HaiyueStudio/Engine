import assert from 'node:assert/strict';
import test from 'node:test';
import {audioEventFixture, audioResolver, FakeAudioBackend, loadG08Modules} from './audio-event-parity-fixture.mjs';
const {audio, runtime} = await loadG08Modules();
function player(mutate = () => {}) {
  const fixture = audioEventFixture(); mutate(fixture);
  const document = audio.parseHyaAudioEvents(fixture), backend = new FakeAudioBackend();
  return {backend, owner: new runtime.AudioEventRuntime(document, backend, {resolver: audioResolver(), compositionTransport: true})};
}

test('composition seek silently consumes past one-shots without scheduling future lookahead cues', async () => {
  const {backend, owner} = player(); await owner.prepare();
  await owner.seek('composition', .02);
  assert.equal(backend.schedules.length, 0, 'the still-audible one-shot is not replayed at the seek target');
  await owner.seek('state', .02); assert.equal(backend.schedules.length, 1);
  assert.equal(backend.schedules[0].offsetFrame, 1060); assert.equal(backend.schedules[0].loop.startFrame, 100);
  await owner.seek('event', .01); assert.equal(backend.schedules.length, 1, 'future one-shot waits for normal advancement');
  await owner.advance({composition: .02, state: .02, event: .01});
  assert.equal(backend.schedules.length, 2); assert.equal(backend.schedules[1].whenFrame, 480);
  owner.dispose();
});

test('paused seek replaces the saved continuous pose and restores it only on resume', async () => {
  const {backend, owner} = player(); await owner.prepare();
  await owner.advance({composition: 0, state: 0, event: 0}); await owner.pause();
  const before = backend.schedules.length;
  await owner.seek('state', .02); await owner.seek('composition', .02); await owner.seek('event', .02);
  assert.equal(backend.schedules.length, before); assert.equal(owner.stats.paused, true); assert.equal(owner.stats.voices, 0);
  assert.equal(owner.stats.pausedVoices, 1);
  await owner.resume(false); assert.equal(backend.schedules.length, before + 1);
  assert.equal(backend.schedules.at(-1).offsetFrame, 1060); assert.equal(owner.stats.paused, false);
  owner.dispose();
});

test('composition rate applies to native voices, finite duration and late decode offsets', async () => {
  const {backend, owner} = player(fixture => {fixture.timelineEvents = [fixture.timelineEvents[0]];});
  await owner.prepare(); await owner.advance({composition: 0, state: 0, event: 0}, 2);
  assert.equal(backend.schedules.length, 1);
  assert.deepEqual([backend.schedules[0].whenFrame, backend.schedules[0].stopFrame, backend.schedules[0].rate], [240, 1440, 2]);
  backend.frame = 480;
  await owner.dispatchCue({eventId: 'late', cue: 'blip', operation: 'start', clock: 'composition', atTime: 0});
  assert.equal(backend.schedules.at(-1).offsetFrame, 0, 'direct dispatch begins at the observed host frame');
  owner.dispose();
});

test('changing rate retains active one-shot content and adjusts future start delay without replaying event tokens', async () => {
  const {backend, owner} = player(fixture => {fixture.timelineEvents = [fixture.timelineEvents[0]];});
  await owner.prepare(); await owner.advance({composition: 0, state: 0, event: 0});
  assert.equal(backend.schedules[0].whenFrame, 480);
  await owner.advance({composition: 0, state: 0, event: 0}, 2);
  assert.equal(backend.schedules[1].whenFrame, 240); assert.equal(backend.schedules[1].rate, 2);
  backend.frame = 720; await owner.advance({composition: .02, state: 0, event: 0}, 1);
  assert.equal(backend.schedules[2].offsetFrame, 960); assert.equal(backend.schedules[2].rate, 1);
  assert.equal(backend.schedules[2].whenFrame, 720); assert.equal(backend.schedules[2].stopFrame, 2160);
  await owner.advance({composition: .02, state: 0, event: 0}, 1);
  assert.equal(backend.schedules.length, 3, 'timeline token was retained during both rate changes'); owner.dispose();
});

test('unsupported combined rate and backwards clocks reject before any domain or voice mutation', async () => {
  const {backend, owner} = player(); await owner.prepare(); await owner.advance({composition: .02, state: .02, event: .02});
  const trace = owner.trace, schedules = backend.schedules.length;
  await assert.rejects(owner.advance({composition: .03, state: .01, event: .03}), error => error.code === 'E_AUDIO_RUNTIME_CLOCK');
  assert.deepEqual(owner.trace, trace); assert.equal(backend.schedules.length, schedules);
  await assert.rejects(owner.advance({composition: .03, state: .03, event: .03}, 16), error => error.code === 'E_AUDIO_RUNTIME_PROFILE');
  assert.deepEqual(owner.trace, trace); assert.equal(backend.schedules.length, schedules); owner.dispose();
});
