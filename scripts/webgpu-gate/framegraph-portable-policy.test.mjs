import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameGraphPortablePlan, parseFrameGraphPortableOptions, assessFrameGraphPortableResult, portableAdapters } from './framegraph-portable-policy.mjs';
import { FRAMEGRAPH_CASES } from './framegraph-regression-policy.mjs';
import { controlWords, controlRgba } from './framegraph-readback-controls-policy.mjs';

const job = { name: 'framegraph-black-frame', powerPreference: 'low-power', access: 'native', copySource: true };
function result() {
  const pixels = Array.from({ length: 16384 }, (_, i) => i % 4 === 3 ? 1 : .5);
  return { schemaVersion: 1, status: 'passed', scope: 'black-frame-attribution-only',
    adapter: { vendor: 'nvidia', architecture: 'pascal', isFallbackAdapter: false },
    browserEvidence: { nativeBackend: true }, browserDiagnostics: { unclassifiedFailureCount: 0 },
    coverage: 'production', chain: 'full', aoScratch: 'r8unorm', readback: 'atomic', access: 'native', copySource: true,
    shaderSubstitutions: [], clearSentinel: [1, 0, 1, 0], width: 64, height: 64, warmup: 4, frames: 1,
    validationErrors: [], cleanup: { ownerResidual: 0, liveGpuResources: 0 }, computed: pixels, copied: [...pixels],
    atomicReadback: { schemaVersion: 1, submissions: 1, frameId: 5, resourcesRetainedUntilAllMapsSettled: true,
      mapErrors: [], access: 'native', controls: { buffer: controlWords(), textureCompute: controlRgba().map(v => v / 255),
        textureCopy: controlRgba().map(v => v / 255), witness: [4660, 5, 64, 64, 22136, 5, 64, 64] } } };
}
test('portable diagnostics freeze both preferences, readback modes, two rounds and all compatibility fixtures', () => {
  const plan = createFrameGraphPortablePlan();
  assert.equal(plan.length, 32);
  assert.deepEqual(plan.slice(24).map(j => j.name), FRAMEGRAPH_CASES);
  assert.equal(new Set(plan.slice(0, 24).map(j => JSON.stringify(j))).size, 24);
  assert.deepEqual(parseFrameGraphPortableOptions(['--plan']), { plan: true });
  for (const args of [['--full'], ['--integrated'], ['--skip'], ['--plan', '--plan']])
    assert.throws(() => parseFrameGraphPortableOptions(args));
});
test('low-power may return the same discrete adapter without granting integrated qualification', () => {
  assert.equal(assessFrameGraphPortableResult(result(), job).status, 'passed');
});
test('adapter consistency ignores optional descriptive fields but missing native metadata fails closed', () => {
  const r = result();
  assert.deepEqual(portableAdapters({ adapter: { ...r.adapter, description: '', device: '' } }), portableAdapters(r));
  delete r.adapter.isFallbackAdapter;
  assert.throws(() => assessFrameGraphPortableResult(r, job), /Native identified/);
  assert.throws(() => assessFrameGraphPortableResult({ status: 'failed', error: 'Shader validation error' }, job), /Shader validation error/);
});
test('portable does not relax native identity, workload, browser errors or pixel coverage', () => {
  for (const mutate of [r => { r.adapter.isFallbackAdapter = true; }, r => { r.chain = 'none'; },
    r => { r.browserEvidence.nativeBackend = false; }, r => { r.browserDiagnostics.unclassifiedFailureCount = 1; },
    r => { r.shaderSubstitutions = [{}]; }, r => { r.validationErrors = ['error']; }]) {
    const r = result(); mutate(r); assert.throws(() => assessFrameGraphPortableResult(r, job));
  }
  const black = result(); black.computed = Array(16384).fill(0); black.copied = [...black.computed];
  assert.equal(assessFrameGraphPortableResult(black, job).status, 'failed');
  const stale = result(); stale.atomicReadback.controls.buffer.fill(0);
  assert.equal(assessFrameGraphPortableResult(stale, job).status, 'failed');
});
