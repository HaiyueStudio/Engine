import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OwnerSafeAudioMixer } from '@haiyue/engine/audio';
import { AudioContextAudit, audioBuffer } from '../../engine/test/owner-safe-audio-fixture.mjs';
import { compileReadingFixture } from '../../scripts/fixtures/visual-novel-ui/compile.mjs';

const compiled = await compileReadingFixture();
after(() => rm(compiled, { recursive: true, force: true }));
const { ReadingAudio, gameAudioPlaybackPort } = await import(pathToFileURL(join(compiled, 'visual-novel/audio/ReadingAudio.js')));
const { GameAudioRuntime } = await import(pathToFileURL(join(compiled, 'audio/GameAudio.js')));
const sound = (id, volume, owner = id) => ({ bufferId: id, eventId: id, owner, channel: 'music', bus: 'music', loop: true, volume, startTick: 1 });

async function setup(t, resolve) {
  const context = new AudioContextAudit();
  const mixer = new OwnerSafeAudioMixer({ context });
  for (const name of ['ambient', 'foreign', 'hello-zh', 'hello-en']) mixer.installBuffer(name, audioBuffer(name));
  const game = new GameAudioRuntime({ mixer }), other = new GameAudioRuntime({ mixer }), released = [], errors = [];
  const makeBuffer = id => ({ bufferId: id, release() { released.push(id); } });
  const audio = new ReadingAudio({ gameAudio: game, duckFactor: .5,
    resolve: (id, signal) => resolve?.(id, signal, makeBuffer) ?? Promise.resolve(makeBuffer(id)), onError: error => errors.push(error) });
  t.after(() => { audio.dispose(); other.dispose(); game.dispose(); mixer.dispose(); });
  await mixer.unlock();
  const music = game.play(sound('ambient', .8)), foreign = other.play(sound('foreign', .7));
  audio.setMusicVoice(music);
  return { context, mixer, released, errors, audio, game, foreign, music, bed: context.gains[4].gain, outside: context.gains[5].gain };
}

test('history uses a separate voice, ends once and restores only its current scene gain', async t => {
  const h = await setup(t);
  assert.equal(await h.audio.playLine('hello-zh'), true);
  assert.equal(h.bed.value, .4);
  assert.equal(h.outside.value, .7);
  assert.equal(await h.audio.replayHistory('hello-en'), true);
  assert.equal(h.audio.linePending, false);
  assert.equal(h.audio.historyPending, true);
  assert.equal(h.context.sources[2].stops, 1);
  assert.equal(h.context.sources[3].buffer.id, 'hello-en');
  h.game.setVolumes({ music: .25 });
  h.mixer.setGain('ambient', 'music', .6);
  h.audio.setVoiceVolume(.25);
  assert.equal(h.context.gains.at(-1).gain.value, .25);
  assert.equal(h.bed.value, .3);
  h.context.sources[3].finish();
  h.context.sources[3].finish();
  assert.equal(h.bed.value, .6);
  assert.deepEqual(h.released, ['hello-zh', 'hello-en']);
  assert.equal(h.mixer.getVolumes().music, .25);
  assert.equal(h.outside.value, .7);
  assert.deepEqual(h.errors, []);
});

test('retired, foreign and replacement music IDs cannot receive a stale duck or release', async t => {
  const h = await setup(t);
  h.audio.setMusicVoice(h.foreign);
  await h.audio.replayHistory('hello-en');
  assert.equal(h.outside.value, .7);
  const replacement = h.game.play(sound('ambient', .5));
  h.audio.setMusicVoice(replacement);
  assert.equal(h.context.gains.at(-1).gain.value, .25);
  h.audio.cancelHistory();
  assert.equal(h.context.gains.at(-1).gain.value, .5);
  assert.equal(h.outside.value, .7);
  assert.equal(h.mixer.stats.voices, 2);
});

test('a late buffer is released after cut, pause or disposal without starting or attenuating anything', async t => {
  const blocked = Promise.withResolvers();
  const h = await setup(t, (id, _signal, make) => id === 'hello-zh' ? blocked.promise.then(() => make(id)) : Promise.resolve(make(id)));
  const pending = h.audio.replayHistory('hello-zh');
  assert.equal(h.audio.historyPending, true);
  await h.audio.playLine('hello-en');
  assert.equal(h.audio.historyPending, false);
  await h.mixer.suspend();
  h.audio.update();
  assert.equal(h.bed.value, .8);
  h.audio.setActive(false);
  h.audio.dispose();
  blocked.resolve();
  assert.equal(await pending, false);
  assert.equal(h.context.sources.length, 3);
  assert.deepEqual(h.released.sort(), ['hello-en','hello-zh']);
  assert.equal(h.mixer.stats.voices, 2);
});

test('background return and locked output preserve music settings and start no stale voice', async t => {
  const h = await setup(t);
  await h.audio.playLine('hello-zh');
  h.audio.setActive(false);
  h.game.setVolumes({ music: .42 });
  assert.equal(await h.audio.replayHistory('hello-en'), false);
  await h.mixer.suspend();
  h.audio.setActive(true);
  assert.equal(await h.audio.replayHistory('hello-en'), false);
  await h.mixer.resume();
  assert.equal(h.context.sources.length, 3);
  assert.equal(h.mixer.getVolumes().music, .42);
  assert.equal(h.bed.value, .8);
  assert.equal(await h.audio.replayHistory('hello-en'), true);
  h.audio.dispose();
  assert.equal(h.bed.value, .8);
  assert.equal(h.mixer.stats.voices, 2);
});

test('disposing the scene audio owner retires child voices while leaving other owners alive', async t => {
  const h = await setup(t);
  const fx = h.game.play({ ...sound('ambient', .8, 'fx'), bus: 'sfx' });
  h.audio.setMusicVoice(fx);
  await h.audio.replayHistory('hello-zh');
  assert.equal(h.context.gains[6].gain.value, .8);
  h.game.dispose();
  assert.equal(h.audio.historyPending, false);
  assert.equal(await h.audio.replayHistory('hello-en'), false);
  assert.deepEqual(h.released, ['hello-zh']);
  assert.equal(h.mixer.stats.voices, 1);
  assert.equal(h.outside.value, .7);
});

test('a host disposal error still closes the remaining voices and playback leases', async () => {
  const failure = Error('host voice disposal failed');
  const host = { state: 'suspended', stereoPan: true, sampleRate: 48000, nodeCount: 4,
    async resume() { this.state = 'running'; },
    close() { this.state = 'closed'; },
    openVoice(_buffer, options) {
      return { nodeCount: 3, stereoPan: true, start() {}, stop() {},
        dispose() { if (options.gain === .25) throw failure; },
      };
    },
  };
  const mixer = new OwnerSafeAudioMixer({ host });
  const game = new GameAudioRuntime({ mixer });
  const port = gameAudioPlaybackPort(game);
  const first = port.open(), second = port.open();
  await mixer.unlock();
  mixer.installBuffer('tone', audioBuffer('tone'));
  first.play({ ...sound('tone', .25, 'first'), eventId: 'first' });
  first.play({ ...sound('tone', .5, 'second'), eventId: 'second' });
  second.play({ ...sound('tone', .5, 'third'), eventId: 'third' });
  game.play({ ...sound('tone', .5, 'fourth'), eventId: 'fourth' });
  assert.equal(mixer.stats.voices, 4);
  assert.throws(() => game.dispose(), error => error === failure);
  assert.equal(mixer.stats.voices, 0);
  assert.throws(() => second.play(sound('tone', .5)), /released/);
  mixer.dispose();
});
