import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOutputProbeOptions, outputProbeShader, validateOutputProbeEvidence } from './multiview-output-probe-policy.mjs';

test('output probe rejects unknown, duplicate and unbounded experiment options', () => {
  assert.deepEqual(parseOutputProbeOptions([]), { preference: 'high-performance', variant: 'original', frames: 512 });
  assert.deepEqual(parseOutputProbeOptions(['--integrated', '--variant=explicit-state', '--frames=4096']),
    { preference: 'low-power', variant: 'explicit-state', frames: 4096 });
  for (const args of [['--full'], ['--frames=0'], ['--frames=1=oops'], ['--frames=16385'], ['--frames=3.5'], ['--variant=unknown'], ['--frames=1', '--frames=2']]) {
    assert.throws(() => parseOutputProbeOptions(args));
  }
});

test('diagnostic shader variants preserve the complete production fragment stage', () => {
  const source = readFileSync(new URL('../../engine/src/shaders/generated/postprocess-output.generated.wgsl', import.meta.url), 'utf8');
  for (const variant of ['original', 'explicit-state']) assert.equal(outputProbeShader(source, variant), source);
  for (const variant of ['arithmetic-vertex', 'vertex-buffer']) {
    const shader = outputProbeShader(source, variant);
    assert.equal(shader.slice(shader.indexOf('struct OutputParams')), source.slice(source.indexOf('struct OutputParams')));
    assert.doesNotMatch(shader, /positions\[vertexIndex\]/);
  }
  assert.throws(() => outputProbeShader('invalid', 'vertex-buffer'), /Unrecognized/);
  assert.throws(() => outputProbeShader(source, 'unknown'), /Unknown/);
});

test('probe acceptance rejects partial cases, wrong workloads and missing diagnostics', () => {
  const options = parseOutputProbeOptions([]);
  const result = { schemaVersion: 1, status: 'passed', variant: options.variant, requestedFrames: options.frames,
    shaderSha256: 'hash', adapter: { vendor: 'test', architecture: 'test', isFallbackAdapter: false },
    failure: null, validationErrors: [],
    cases: ['clear-only', 'shared-hdr', 'isolated-hdr'].map(mode => ({ mode, completedFrames: options.frames })) };
  validateOutputProbeEvidence(result, options, 'hash');
  for (const change of [
    { status: 'failed' }, { schemaVersion: 2 }, { variant: 'explicit-state' }, { requestedFrames: 1 },
    { shaderSha256: 'other' }, { adapter: { ...result.adapter, isFallbackAdapter: true } },
    { failure: {} }, { failure: undefined }, { validationErrors: undefined }, { validationErrors: ['error'] },
    { cases: result.cases.slice(1) }, { cases: result.cases.map(c => ({ ...c, completedFrames: 511 })) },
  ]) assert.throws(() => validateOutputProbeEvidence({ ...result, ...change }, options, 'hash'));
});

test('fallback initialization comparison uses identical shaders and preserves normal output branch', () => {
  const source = readFileSync(new URL('../../engine/src/shaders/generated/postprocess-output.generated.wgsl', import.meta.url), 'utf8');
  const lazy = outputProbeShader(source, 'lazy-depth');
  assert.equal(lazy, outputProbeShader(source, 'initialized-depth'));
  assert.match(lazy, /@binding\(2\).*texture_depth_2d_array/);
  assert.match(lazy, /params.settings.w > 0.0/);
  assert.equal(lazy.slice(lazy.indexOf('  let size =')), source.slice(source.indexOf('  let size =')));
  assert.equal(parseOutputProbeOptions(['--variant=lazy-depth']).variant, 'lazy-depth');
  assert.equal(parseOutputProbeOptions(['--variant=initialized-depth']).variant, 'initialized-depth');
});
