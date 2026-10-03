import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyFrameGraphBlackFrame, compareFrameGraphProbePixels, parseFrameGraphBlackFrameOptions, arithmeticPostprocessProbe } from './framegraph-black-frame-policy.mjs';
const image = rgb => Array.from({ length: 64 * 64 * 4 }, (_, i) => i % 4 === 3 ? 1 : rgb);
const fixture = () => ({ schemaVersion: 1, status: 'passed', scope: 'black-frame-attribution-only',
  adapter: { vendor: 'intel', architecture: 'gen-9', isFallbackAdapter: false }, width: 64, height: 64, warmup: 4, frames: 1,
  validationErrors: [], cleanup: { ownerResidual: 0, liveGpuResources: 0 }, copySource: true, computed: image(.5), copied: image(.5) });
test('coverage probe defaults to production and rejects ambiguous or reduced populations', () => {
  assert.deepEqual(parseFrameGraphBlackFrameOptions([]), { coverage: 'production' });
  assert.deepEqual(parseFrameGraphBlackFrameOptions(['--coverage=after-pipeline']), { coverage: 'after-pipeline' });
  assert.deepEqual(parseFrameGraphBlackFrameOptions(['--coverage=arithmetic-chain']), { coverage: 'arithmetic-chain' });
  for (const args of [['--integrated'], ['--coverage=unknown'], ['--coverage=after-pipeline', '--coverage=after-pipeline']])
    assert.throws(() => parseFrameGraphBlackFrameOptions(args));
});
test('arithmetic chain substitution preserves bindings and fragment code and ignores unrelated shaders', () => {
  for (const name of ['gtao', 'sao', 'ssao', 'ao-denoise', 'ao-upscale', 'gaussian-blur']) {
    const source = readFileSync(new URL(`../../engine/src/shaders/generated/postprocess-${name}.generated.wgsl`, import.meta.url), 'utf8');
    const candidate = arithmeticPostprocessProbe(source), end = source.indexOf('\n}', source.indexOf('@vertex')) + 2;
    assert.notEqual(candidate, source); assert.doesNotMatch(candidate, /positions\[vertexIndex\]/);
    assert.equal(candidate.slice(candidate.indexOf('\n}', candidate.indexOf('@vertex')) + 2), source.slice(end));
  }
  for (const source of ['unrelated shader', readFileSync(new URL('../../engine/src/shaders/generated/postprocess-output.generated.wgsl', import.meta.url), 'utf8')])
    assert.equal(arithmeticPostprocessProbe(source), source);
});
test('an untouched sentinel remains a failure and source coverage is reported independently', () => {
  const r = fixture(); r.computed = Array.from({ length: 16384 }, (_, i) => [1, 0, 1, 0][i % 4]);
  r.copied = [...r.computed]; r.sourcePixels = image(.01);
  const result = classifyFrameGraphBlackFrame(r);
  assert.equal(result.status, 'failed'); assert.equal(result.computed.sentinelPixels, 4096);
  assert.equal(result.source.coveredPixels, 4096); assert.equal(result.source.coloredPixels, 4096);
});
test('matching direct copy and compute results retain independent pixel evidence', () => {
  const r = classifyFrameGraphBlackFrame(fixture()); assert.equal(r.status, 'passed'); assert.equal(r.maxReadbackDelta, 0); assert.equal(r.performanceQualified, false);
});
test('black compute, black copy and diverging readbacks fail without selecting the successful path', () => {
  for (const mutate of [r => { r.computed = image(0); }, r => { r.copied = image(0); }, r => { r.copied = image(.8); }]) {
    const r = fixture(); mutate(r); assert.equal(classifyFrameGraphBlackFrame(r).status, 'failed');
  }
});
test('invalid pixels or cleanup cannot be classified as a successful probe', () => {
  for (const mutate of [r => r.computed.pop(), r => { r.computed[0] = NaN; }, r => { r.cleanup.ownerResidual = 1; }]) {
    const r = fixture(); mutate(r); assert.throws(() => classifyFrameGraphBlackFrame(r));
  }
});
test('a single bright pixel cannot pass a full-frame draw, even when both readbacks agree', () => {
  const r = fixture(); r.computed = Array(16384).fill(0); r.computed.splice(0, 4, .3, .3, .3, 1); r.copied = [...r.computed];
  const result = classifyFrameGraphBlackFrame(r); assert.equal(result.status, 'failed'); assert.equal(result.computed.coveredPixels, 1);
});
test('cross-version parity rejects changed lit images as well as missing output', () => {
  assert.equal(compareFrameGraphProbePixels(image(.5), image(.5)).status, 'passed');
  assert.equal(compareFrameGraphProbePixels(image(.5), image(.8)).status, 'failed');
  assert.throws(() => compareFrameGraphProbePixels([], []));
});
test('failed execution or texture-dimension witness cannot qualify even matching images', () => {
  const r = fixture(); r.readbackWitness = [4660, 64, 64, 22136, 4660, 64, 64, 22136];
  assert.equal(classifyFrameGraphBlackFrame(r).witnessValid, true);
  for (const values of [Array(8).fill(0), Array(8).fill(0xffffffff), [4660, 1, 1, 22136, 4660, 64, 64, 22136]]) {
    r.readbackWitness = values; const result = classifyFrameGraphBlackFrame(r);
    assert.equal(result.witnessValid, false); assert.equal(result.status, 'failed');
  }
});
test('observed device loss cannot qualify matching sequential readbacks', () => {
  const r = fixture(); r.deviceLoss = { reason: 'unknown', message: 'GPU stopped', phase: 'readback' };
  assert.throws(() => classifyFrameGraphBlackFrame(r), /device lost/);
});
