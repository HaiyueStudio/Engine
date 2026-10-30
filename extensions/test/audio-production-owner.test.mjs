import assert from 'node:assert/strict';
import test from 'node:test';
import {audioEventFixture, loadG08Modules} from './audio-event-parity-fixture.mjs';
import {hostFixture} from './audio-production-fixture.mjs';
const {audio, productionOwner: {ProductionAudioOwner}} = await loadG08Modules();
async function create(mutate = () => {}, options = {}) {
  const source = audioEventFixture(); mutate(source);
  const document = audio.parseHyaAudioEvents(source), host = hostFixture();
  const owner = new ProductionAudioOwner(document, host, options); await owner.prepare(); return {owner, host};
}
const update = (operation, domain = 'composition', time = 0, rate = 1) => ({operation, domain, time, rate});

test('running shared context does not bypass explicit gesture authorization; unlock calls host synchronously once', async () => {
  const {owner, host} = await create();
  await assert.rejects(owner.play('blip'), error => error.code === 'E_AUDIO_RUNTIME_AUTOPLAY');
  await assert.rejects(owner.update(update('advance')), error => error.code === 'E_AUDIO_RUNTIME_AUTOPLAY');
  assert.equal(host.requests.length, 0);
  const grant = owner.unlock(); assert.equal(host.unlocks, 1); await grant; assert.equal(host.unlocks, 1);
  await owner.play('blip'); assert.equal(host.requests.length, 1); assert.equal(host.requests[0].gain, .4);
  owner.dispose(); assert.equal(host.state, 'running');
});

test('serialized immutable command snapshots preserve order and a rejected command does not poison the queue', async () => {
  const {owner, host} = await create(); await owner.unlock();
  const request = update('advance'); const first = owner.update(request); request.time = 100;
  await first; assert.equal(host.requests[0].startFrame, 480);
  await assert.rejects(owner.play('absent'), error => error.code === 'E_AUDIO_RUNTIME_RESOURCE');
  const one = owner.play('blip'), two = owner.stop('blip'), three = owner.play('blip');
  await Promise.all([one, two, three]);
  assert.ok(host.requests.length >= 3); assert.equal(owner.stats.pending, 0);
  assert.deepEqual(owner.trace.filter(entry => entry.token.startsWith('hya-audio-command') && entry.operation === 'scheduled').map(entry => entry.token), ['hya-audio-command-1', 'hya-audio-command-3']);
  const trace = owner.trace; assert.ok(Object.isFrozen(trace) && trace.every(entry => Object.isFrozen(entry) && Object.isFrozen(entry.details)));
  assert.ok(trace.filter(entry => entry.operation === 'scheduled').every(entry => entry.resource === 'embedded-tone' || entry.resource === 'referenced-tone'));
  owner.dispose();
});

test('paused silent seeks retain no voices and stop/resume does not replay crossed one-shots', async () => {
  const {owner, host} = await create();
  await owner.update(update('seek', 'composition', .02)); await owner.update(update('seek', 'state', .02));
  assert.equal(host.requests.length, 0); await owner.unlock();
  assert.equal(host.requests.length, 1); assert.equal(host.requests[0].offsetFrame, 1060);
  await owner.update(update('pause')); const before = host.requests.length;
  await owner.update(update('seek', 'state', .03)); assert.equal(host.requests.length, before);
  await owner.update(update('resume')); assert.equal(host.requests.at(-1).offsetFrame, 540);
  await owner.update(update('stop')); assert.equal(owner.stats.voices, 0);
  await assert.rejects(owner.play('blip'), error => error.code === 'E_AUDIO_RUNTIME_STATE');
  await owner.update(update('resume')); const restarted = host.requests.length; await owner.update(update('advance'));
  assert.deepEqual(host.requests.slice(restarted).map(value => value.startFrame), [480, 0, 960]); owner.dispose();
});

test('invalid requests cannot consume tokens or authorize negative or unsupported audio rates', async () => {
  const {owner, host} = await create(); await owner.unlock();
  for (const request of [update('advance', 'unknown'), update('advance', 'state', NaN), update('advance', 'state', 0, -1),
    update('advance', 'state', 0, 16), update('not-an-operation')]) {
    await assert.rejects(owner.update(request), error => /^E_AUDIO_RUNTIME_/.test(error.code));
  }
  assert.equal(host.requests.length, 0); await owner.play('blip');
  assert.equal(owner.trace.find(entry => entry.operation === 'scheduled').token, 'hya-audio-command-1'); owner.dispose();
});

test('abort during preparation retires every late decoded handle and never closes a shared host', async () => {
  const controller = new AbortController(), document = audio.parseHyaAudioEvents(audioEventFixture()), host = hostFixture();
  let release; host.gate = new Promise(resolve => {release = resolve;});
  const owner = new ProductionAudioOwner(document, host, {signal: controller.signal}), job = owner.prepare();
  for (let index = 0; index < 30 && host.decoded.length === 0; index++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(host.decoded.length); controller.abort(); release();
  await assert.rejects(job, error => error.code === 'E_AUDIO_RUNTIME_ABORTED');
  assert.ok(host.decoded.every(value => value.released === 1)); assert.equal(owner.stats.decoded, 0); assert.equal(host.state, 'running');
  await assert.rejects(owner.play('blip'), error => error.code === 'E_AUDIO_RUNTIME_ABORTED'); owner.dispose();
});

test('dispose cancels queued calls and releases voices even if the borrowed host clock fails', async () => {
  const {owner, host} = await create(); await owner.unlock(); await owner.play('blip');
  const queued = owner.play('blip'); host.frame = NaN; owner.dispose();
  await assert.rejects(queued, error => error.code === 'E_AUDIO_RUNTIME_STATE');
  assert.equal(owner.stats.voices, 0); assert.equal(owner.stats.decoded, 0); assert.ok(owner.stats.cleanupErrors > 0);
  assert.ok(host.decoded.every(value => value.released === 1)); owner.dispose();
});

test('bounded command queue rejects overflow and synchronous bus edits cannot race pending operations', async () => {
  const {owner, host} = await create(source => {source.limits.maxEventTokens = 2;}); await owner.unlock();
  const one = owner.play('blip'), two = owner.stop('blip');
  assert.throws(() => owner.setBusGain('sfx', .2), error => error.code === 'E_AUDIO_RUNTIME_STATE');
  await assert.rejects(owner.play('blip'), error => error.code === 'E_AUDIO_RUNTIME_LIMIT');
  await Promise.all([one, two]); owner.setBusGain('sfx', .2);
  assert.equal(owner.stats.pending, 0); assert.equal(host.state, 'running'); owner.dispose();
});

test('a suspended host requires a fresh explicit unlock rather than implicit gesture reuse', async () => {
  const {owner, host} = await create(); await owner.unlock(); assert.equal(host.unlocks, 1);
  host.state = 'suspended';
  await assert.rejects(owner.update(update('resume')), error => error.code === 'E_AUDIO_RUNTIME_AUTOPLAY');
  assert.equal(host.unlocks, 1); await owner.unlock(); assert.equal(host.unlocks, 2);
  await owner.play('blip'); owner.dispose();
});

test('stopping a cue while paused removes its saved voice instead of reviving it on resume', async () => {
  const {owner, host} = await create(); await owner.unlock(); await owner.play('blip');
  await owner.update(update('pause')); await owner.stop('blip'); const before = host.requests.length;
  await owner.update(update('resume')); assert.equal(host.requests.length, before); owner.dispose();
});
