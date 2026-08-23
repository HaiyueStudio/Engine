import assert from 'node:assert/strict';
import test from 'node:test';
import {
  audioEventFixture,
  audioResolver,
  deferredGate,
  FakeAudioBackend,
  loadG08Modules,
} from './audio-event-parity-fixture.mjs';

const { audio, runtime } = await loadG08Modules();

function createRuntime(mutator = () => undefined, backend = new FakeAudioBackend()) {
  const fixture = audioEventFixture();
  mutator(fixture);
  const document = audio.parseHyaAudioEvents(fixture);
  const resolver = audioResolver();
  return { backend, document, resolver, player: new runtime.AudioEventRuntime(document, backend, { resolver }) };
}

test('three clock domains produce exact sample-frame schedules and exactly-once event tokens', async () => {
  const { backend, player } = createRuntime();
  await player.prepare();
  await player.advance({ composition: 0, state: 0, event: 0 });
  assert.deepEqual(backend.schedules.map(entry => [entry.voiceId, entry.whenFrame, entry.offsetFrame, entry.rate, entry.gain]), [
    ['audio-voice-1', 480, 0, 1, 0.4],
    ['audio-voice-2', 0, 100, 1, 0.4],
    ['audio-voice-3', 960, 0, 2, 0.5],
  ]);
  assert.deepEqual(backend.stops, [['audio-voice-1', 1_920]]);
  assert.deepEqual(backend.schedules[1].loop, { startFrame: 100, endFrame: 1_100 });
  await player.advance({ composition: 0, state: 0, event: 0 });
  assert.equal(backend.schedules.length, 3, 'look-ahead windows do not duplicate timeline events');

  await player.dispatchCue({ eventId: 'listener-1', cue: 'blip', operation: 'start', clock: 'event' });
  await player.dispatchCue({ eventId: 'listener-1', cue: 'blip', operation: 'start', clock: 'event' });
  assert.equal(backend.schedules.length, 4);
  assert.ok(player.trace.some(entry => entry.kind === 'ignored' && entry.reason === 'duplicate-event-token'));
  player.dispose();
  assert.equal(backend.disposed, 1);
  assert.equal(player.stats.voices, 0);
  assert.equal(player.assets.stats.cacheEntries, 0);
});

test('same-frame source order, finite loops and oracle-compatible schedule projection are byte-stable', async () => {
  const run = async () => {
    const { backend, player } = createRuntime(fixture => {
      fixture.cues[1].loop.iterations = 3;
      fixture.timelineEvents = [
        { id: 'same-a', clock: 'composition', time: 0.01, sequence: 7, cue: 'blip', operation: 'start' },
        { id: 'same-b', clock: 'composition', time: 0.01, sequence: 7, cue: 'loop', operation: 'start' },
      ];
    });
    await player.prepare(['embedded-tone']);
    await player.advance({ composition: 0, state: 0, event: 0 });
    const projection = backend.schedules.map(entry => ({
      eventId: player.trace.find(trace => trace.voiceId === entry.voiceId)?.eventId,
      frame: entry.whenFrame,
      offset: entry.offsetFrame,
      stop: entry.stopFrame ?? null,
      loop: entry.loop ?? null,
      gain: entry.gain,
      rate: entry.rate,
    }));
    player.dispose();
    return projection;
  };
  const expected = [
    { eventId: 'same-a', frame: 480, offset: 0, stop: 2_880, loop: null, gain: 0.4, rate: 1 },
    { eventId: 'same-b', frame: 480, offset: 100, stop: 3_480, loop: { startFrame: 100, endFrame: 1_100 }, gain: 0.4, rate: 1 },
  ];
  assert.deepEqual(await run(), expected);
  assert.deepEqual(await run(), expected);
});

test('seek, rewind, pause and resume rebuild deterministic loop offsets without replaying crossed one-shots', async () => {
  const backend = new FakeAudioBackend();
  backend.kind = 'realtime';
  const { player } = createRuntime(() => undefined, backend);
  await player.prepare(['embedded-tone']);
  await player.advance({ composition: 0, state: 0, event: 0 });
  backend.frame = 1_200;
  await player.seek('state', 0.02);
  const seekSchedule = backend.schedules.at(-1);
  assert.equal(seekSchedule.offsetFrame, 1_060);
  assert.equal(player.trace.filter(entry => entry.eventId === 'composition-start' && entry.kind === 'scheduled').length, 1);

  backend.frame = 1_400;
  await player.pause();
  assert.equal(player.stats.paused, true);
  assert.equal(backend.suspendCalls, 1);
  backend.frame = 4_000;
  await player.resume(false);
  assert.equal(player.stats.paused, false);
  assert.equal(backend.resumeCalls, 1);
  assert.ok(backend.schedules.at(-1).offsetFrame >= 100);

  await player.rewind('state');
  assert.equal(backend.schedules.at(-1).offsetFrame, 100);
  player.reset();
  assert.equal(player.stats.eventTokens, 0);
  assert.equal(player.stats.voices, 0);
  player.dispose();
});

test('voice limits, overlap and transition policies are deterministic and observable', async () => {
  const { backend, player } = createRuntime(fixture => {
    fixture.limits.maxVoices = 2;
    fixture.limits.maxVoicesPerResource = 2;
    fixture.voiceStealing = 'steal-lowest-priority';
  });
  await player.prepare(['embedded-tone']);
  await player.dispatchCue({ eventId: 'one', cue: 'blip', operation: 'start', clock: 'event' });
  backend.frame = 10;
  await player.dispatchCue({ eventId: 'two', cue: 'blip', operation: 'start', clock: 'event' });
  backend.frame = 20;
  await player.dispatchCue({ eventId: 'three', cue: 'loop', operation: 'start', clock: 'event' });
  assert.ok(player.trace.some(entry => entry.kind === 'stolen' && entry.reason === 'per-resource-voice-limit'));
  assert.equal(player.stats.voices, 2);

  player.setBusGain('master', 0.25);
  assert.ok(backend.gainChanges.some(([, gain]) => gain === 0.1));
  await player.transition('state-a', 'restart');
  assert.ok(player.trace.some(entry => entry.kind === 'stopped' && entry.reason === 'transition'));
  assert.ok(player.trace.filter(entry => entry.cue === 'loop' && entry.kind === 'scheduled').length >= 2);
  player.dispose();
});

test('reject stealing policy fails structurally instead of silently dropping a voice', async () => {
  const { player } = createRuntime(fixture => {
    fixture.limits.maxVoices = 1;
    fixture.limits.maxVoicesPerResource = 1;
    fixture.voiceStealing = 'reject';
  });
  await player.prepare(['embedded-tone']);
  await player.dispatchCue({ eventId: 'one', cue: 'blip', operation: 'start', clock: 'event' });
  await assert.rejects(
    player.dispatchCue({ eventId: 'two', cue: 'loop', operation: 'start', clock: 'event' }),
    error => error.code === 'E_AUDIO_RUNTIME_LIMIT',
  );
  player.dispose();
});

test('pending late-decode starts participate in overlap and voice budgets', async () => {
  const rejectBackend = new FakeAudioBackend();
  const rejectGate = deferredGate();
  rejectBackend.decodeGate = rejectGate;
  const { player: rejectPlayer } = createRuntime(fixture => {
    fixture.limits.maxVoices = 1;
    fixture.limits.maxVoicesPerResource = 1;
    fixture.voiceStealing = 'reject';
  }, rejectBackend);
  const first = rejectPlayer.dispatchCue({ eventId: 'pending-one', cue: 'blip', operation: 'start', clock: 'event' });
  await waitFor(() => rejectGate.waits.length === 1);
  await assert.rejects(
    rejectPlayer.dispatchCue({ eventId: 'pending-two', cue: 'loop', operation: 'start', clock: 'event' }),
    error => error.code === 'E_AUDIO_RUNTIME_LIMIT',
  );
  assert.equal(rejectPlayer.stats.pendingVoices, 1);
  rejectGate.resolve();
  await first;
  rejectPlayer.dispose();

  const stealBackend = new FakeAudioBackend();
  const stealGate = deferredGate();
  stealBackend.decodeGate = stealGate;
  const { player: stealPlayer } = createRuntime(fixture => {
    fixture.limits.maxVoices = 1;
    fixture.limits.maxVoicesPerResource = 1;
    fixture.voiceStealing = 'steal-oldest';
  }, stealBackend);
  const old = stealPlayer.dispatchCue({ eventId: 'old-pending', cue: 'blip', operation: 'start', clock: 'event' });
  await waitFor(() => stealGate.waits.length === 1);
  const current = stealPlayer.dispatchCue({ eventId: 'new-pending', cue: 'loop', operation: 'start', clock: 'event' });
  stealGate.resolve();
  await Promise.all([old, current]);
  assert.equal(stealBackend.schedules.length, 1);
  assert.equal(stealPlayer.trace.find(entry => entry.kind === 'scheduled').eventId, 'new-pending');
  assert.ok(stealPlayer.trace.some(entry => entry.kind === 'stolen' && entry.reason === 'pending:per-resource-voice-limit'));
  stealPlayer.dispose();
});

test('event storms stop at the exactly-once token budget', async () => {
  const { player } = createRuntime(fixture => { fixture.limits.maxEventTokens = 2; });
  await player.dispatchCue({ eventId: 'stop-one', cue: 'blip', operation: 'stop', clock: 'event' });
  await player.dispatchCue({ eventId: 'stop-two', cue: 'blip', operation: 'stop', clock: 'event' });
  await assert.rejects(
    player.dispatchCue({ eventId: 'stop-three', cue: 'blip', operation: 'stop', clock: 'event' }),
    error => error.code === 'E_AUDIO_RUNTIME_LIMIT',
  );
  player.dispose();
});

test('late decode catch-up preserves content time while drop and error policies stay explicit', async () => {
  const catchBackend = new FakeAudioBackend();
  const catchGate = deferredGate();
  catchBackend.decodeGate = catchGate;
  const { player: catchPlayer } = createRuntime(() => undefined, catchBackend);
  const pending = catchPlayer.dispatchCue({ eventId: 'late', cue: 'blip', operation: 'start', clock: 'event' });
  await waitFor(() => catchGate.waits.length === 1);
  catchBackend.frame = 480;
  catchGate.resolve();
  await pending;
  assert.equal(catchBackend.schedules[0].offsetFrame, 480);
  assert.ok(catchPlayer.trace.some(entry => entry.kind === 'late-catch-up'));
  catchPlayer.dispose();

  const dropBackend = new FakeAudioBackend();
  const dropGate = deferredGate();
  dropBackend.decodeGate = dropGate;
  const { player: dropPlayer } = createRuntime(fixture => { fixture.clock.lateDecodePolicy = 'drop'; }, dropBackend);
  const dropped = dropPlayer.dispatchCue({ eventId: 'drop', cue: 'blip', operation: 'start', clock: 'event' });
  await waitFor(() => dropGate.waits.length === 1);
  dropBackend.frame = 100;
  dropGate.resolve();
  await dropped;
  assert.equal(dropBackend.schedules.length, 0);
  assert.ok(dropPlayer.trace.some(entry => entry.kind === 'late-drop'));
  dropPlayer.dispose();

  const errorBackend = new FakeAudioBackend();
  const errorGate = deferredGate();
  errorBackend.decodeGate = errorGate;
  const { player: errorPlayer } = createRuntime(fixture => { fixture.clock.lateDecodePolicy = 'error'; }, errorBackend);
  const failed = errorPlayer.dispatchCue({ eventId: 'error', cue: 'blip', operation: 'start', clock: 'event' });
  await waitFor(() => errorGate.waits.length === 1);
  errorBackend.frame = 100;
  errorGate.resolve();
  await assert.rejects(failed, error => error.code === 'E_AUDIO_RUNTIME_CLOCK');
  errorPlayer.dispose();
});

test('drift, suspension, autoplay and visibility changes follow frozen browser policies', async () => {
  const driftBackend = new FakeAudioBackend();
  const { player: driftPlayer } = createRuntime(() => undefined, driftBackend);
  driftBackend.frame = 1_000;
  await driftPlayer.advance({ composition: 0.01, state: 0, event: 0 });
  assert.ok(driftPlayer.diagnostics.some(entry => entry.code === 'W_AUDIO_CLOCK_RESYNC'));
  assert.ok(driftPlayer.trace.some(entry => entry.kind === 'drift-resync'));
  driftPlayer.dispose();

  const suspendedBackend = new FakeAudioBackend();
  suspendedBackend.kind = 'realtime';
  suspendedBackend.state = 'suspended';
  const { player: suspendedPlayer } = createRuntime(fixture => {
    fixture.browser.autoplay = 'require-user-gesture';
  }, suspendedBackend);
  await suspendedPlayer.dispatchCue({ eventId: 'queued', cue: 'blip', operation: 'start', clock: 'event' });
  assert.equal(suspendedPlayer.stats.pendingSuspended, 1);
  await assert.rejects(suspendedPlayer.resume(false), error => error.code === 'E_AUDIO_RUNTIME_AUTOPLAY');
  await suspendedPlayer.resume(true);
  assert.equal(suspendedPlayer.stats.pendingSuspended, 0);
  assert.equal(suspendedBackend.schedules.length, 1);
  await suspendedPlayer.setVisibility(false);
  assert.equal(suspendedPlayer.stats.paused, true);
  await suspendedPlayer.setVisibility(true);
  assert.ok(suspendedPlayer.diagnostics.some(entry => entry.code === 'W_AUDIO_VISIBILITY_RESUME_REQUIRED'));
  suspendedPlayer.dispose();

  const strictBackend = new FakeAudioBackend();
  const { player: strictPlayer } = createRuntime(fixture => {
    fixture.clock.driftPolicy = 'error';
  }, strictBackend);
  strictBackend.frame = 1_000;
  await assert.rejects(
    strictPlayer.advance({ composition: 0.01, state: 0, event: 0 }),
    error => error.code === 'E_AUDIO_RUNTIME_CLOCK',
  );
  strictPlayer.dispose();
});

test('backend profile mismatch prevents restricted media from claiming sample-accurate parity', () => {
  const backend = new FakeAudioBackend();
  backend.profile = 'html-media-restricted';
  const document = audio.parseHyaAudioEvents(audioEventFixture());
  assert.throws(
    () => new runtime.AudioEventRuntime(document, backend, { resolver: audioResolver() }),
    error => error.code === 'E_AUDIO_RUNTIME_PROFILE',
  );
});

test('resource replacement validates every dependent cue before stopping live voices', async () => {
  const { backend, player } = createRuntime();
  await player.prepare(['embedded-tone']);
  await player.dispatchCue({ eventId: 'live', cue: 'blip', operation: 'start', clock: 'event' });
  const invalid = structuredClone(player.document.resources[0]);
  invalid.frameLength = 50;
  await assert.rejects(player.replaceResource(invalid), error => error.code === 'E_AUDIO_RUNTIME_RESOURCE');
  assert.equal(backend.stops.length, 0);
  assert.equal(player.stats.voices, 1);
  player.dispose();
});

async function waitFor(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for test condition');
}
