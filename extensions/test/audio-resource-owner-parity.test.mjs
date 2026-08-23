import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIO_BYTES,
  audioEventFixture,
  audioResolver,
  deferredGate,
  FakeAudioBackend,
  loadG08Modules,
} from './audio-event-parity-fixture.mjs';

const { audio, runtime } = await loadG08Modules();
const document = audio.parseHyaAudioEvents(audioEventFixture());

function owner(backend = new FakeAudioBackend(), resolver = audioResolver()) {
  return new runtime.AudioAssetOwner(document.resources, backend, {
    resolver,
    maxDecodeJobs: document.limits.maxDecodeJobs,
    maxDecodedFrames: document.limits.maxDecodedFrames,
    maxDecodedBytes: document.limits.maxDecodedBytes,
  });
}

test('external audio never receives implicit URL permission and integrity mismatch fails before decode', async () => {
  const backend = new FakeAudioBackend();
  const withoutResolver = new runtime.AudioAssetOwner(document.resources, backend, {
    maxDecodeJobs: 2,
    maxDecodedFrames: 100_000,
    maxDecodedBytes: 1_000_000,
  });
  await assert.rejects(withoutResolver.load('referenced-tone'), error => error.code === 'E_AUDIO_RUNTIME_PORT');
  assert.deepEqual(backend.decodeCalls, []);
  withoutResolver.dispose();

  const bad = structuredClone(document.resources[0]);
  bad.integrity.digest = '0'.repeat(64);
  const mismatchBackend = new FakeAudioBackend();
  const mismatch = new runtime.AudioAssetOwner([bad], mismatchBackend, {
    maxDecodeJobs: 1,
    maxDecodedFrames: 100_000,
    maxDecodedBytes: 1_000_000,
  });
  await assert.rejects(mismatch.load(bad.id), error => error.code === 'E_AUDIO_RUNTIME_INTEGRITY');
  assert.deepEqual(mismatchBackend.decodeCalls, []);
  mismatch.dispose();
});

test('content-addressed decode cache shares handles and releases the final reference exactly once', async () => {
  const backend = new FakeAudioBackend();
  const resolver = audioResolver();
  const assets = owner(backend, resolver);
  const embedded = await assets.load('embedded-tone');
  const referenced = await assets.load('referenced-tone');
  assert.equal(embedded, referenced);
  assert.deepEqual(backend.decodeCalls, ['embedded-tone']);
  assert.deepEqual(resolver.requests, [], 'known verified digest reuses the decoded handle before resolving another delivery');
  assert.equal(assets.stats.cacheEntries, 1);
  assets.releaseResource('embedded-tone');
  assert.equal(backend.released, 0);
  assets.releaseResource('referenced-tone');
  assert.equal(backend.released, 1);
  assets.dispose();
  assets.dispose();
  assert.equal(backend.released, 1);
  assert.equal(resolver.disposed, 1);
});

test('cache identity never bypasses declared decoded metadata validation', async () => {
  const backend = new FakeAudioBackend();
  const resources = structuredClone(document.resources.slice(0, 2));
  resources[1].sampleRate = 44_100;
  const assets = new runtime.AudioAssetOwner(resources, backend, {
    resolver: audioResolver(),
    maxDecodeJobs: 2,
    maxDecodedFrames: 100_000,
    maxDecodedBytes: 1_000_000,
  });
  await assets.load('embedded-tone');
  assert.throws(() => assets.load('referenced-tone'), error => error.code === 'E_AUDIO_RUNTIME_DECODE');
  assert.deepEqual(backend.decodeCalls, ['embedded-tone']);
  assets.dispose();
});

test('decoded metadata and aggregate allocation budgets are verified before cache ownership', async () => {
  const metadataBackend = new FakeAudioBackend();
  metadataBackend.decode = async request => ({
    sampleRate: request.resource.sampleRate,
    channels: request.resource.channels,
    frameLength: request.resource.frameLength + 1,
    payload: {},
    release() { metadataBackend.released++; },
  });
  const metadata = owner(metadataBackend);
  await assert.rejects(metadata.load('embedded-tone'), error => error.code === 'E_AUDIO_RUNTIME_DECODE');
  assert.equal(metadataBackend.released, 1, 'metadata-mismatched handle is retired before cache install');
  metadata.dispose();

  const budgetBackend = new FakeAudioBackend();
  const budget = new runtime.AudioAssetOwner(document.resources, budgetBackend, {
    resolver: audioResolver(),
    maxDecodeJobs: 1,
    maxDecodedFrames: 100_000,
    maxDecodedBytes: 4,
  });
  await assert.rejects(budget.load('embedded-tone'), error => error.code === 'E_AUDIO_RUNTIME_LIMIT');
  assert.equal(budgetBackend.released, 1);
  assert.equal(budget.stats.cacheEntries, 0);
  budget.dispose();
});

test('replacement aborts the previous generation and a late decode cannot write back', async () => {
  const backend = new FakeAudioBackend();
  const gate = deferredGate();
  backend.decodeGate = gate;
  const resolver = audioResolver();
  const assets = owner(backend, resolver);
  const first = assets.load('embedded-tone');
  await waitFor(() => gate.waits.length === 1);
  const replacement = structuredClone(document.resources[0]);
  replacement.source = { kind: 'hosted', key: 'replacement/tone' };
  const second = assets.replace(replacement);
  await waitFor(() => gate.waits.length === 2);
  gate.resolve(0);
  await assert.rejects(first, error => error.code === 'E_AUDIO_RUNTIME_ABORTED');
  assert.equal(backend.released, 1, 'late first-generation handle was released');
  gate.resolve(1);
  const handle = await second;
  assert.equal(handle.payload.resource, 'embedded-tone');
  assert.equal(assets.stats.loadedResources, 1);
  assets.dispose();
  assert.equal(backend.released, 2);
});

test('dispose aborts resolver/decode jobs and retires every late handle without residuals', async () => {
  const backend = new FakeAudioBackend();
  const gate = deferredGate();
  backend.decodeGate = gate;
  const resolver = audioResolver(AUDIO_BYTES);
  const assets = owner(backend, resolver);
  const pending = assets.load('embedded-tone');
  await waitFor(() => gate.waits.length === 1);
  assets.dispose();
  assets.dispose();
  gate.resolve();
  await assert.rejects(pending, error => error.code === 'E_AUDIO_RUNTIME_ABORTED');
  assert.equal(backend.released, 1);
  assert.equal(backend.disposed, 1);
  assert.equal(resolver.disposed, 1);
  assert.deepEqual(assets.stats, {
    resources: 3,
    loadedResources: 0,
    cacheEntries: 0,
    activeDecodeJobs: 0,
    decodedBytes: 0,
    disposed: true,
  });
});

test('decode concurrency has a hard budget and never falls back to an unowned path', async () => {
  const backend = new FakeAudioBackend();
  const gate = deferredGate();
  backend.decodeGate = gate;
  const assets = new runtime.AudioAssetOwner(document.resources, backend, {
    resolver: audioResolver(),
    maxDecodeJobs: 1,
    maxDecodedFrames: 100_000,
    maxDecodedBytes: 1_000_000,
  });
  const first = assets.load('embedded-tone');
  await waitFor(() => gate.waits.length === 1);
  assert.throws(() => assets.load('referenced-tone'), error => error.code === 'E_AUDIO_RUNTIME_LIMIT');
  gate.resolve();
  await first;
  assets.dispose();
});

async function waitFor(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for resource job');
}
