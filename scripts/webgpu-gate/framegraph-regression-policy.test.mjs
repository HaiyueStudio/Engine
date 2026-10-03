import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameGraphRegressionPlan, parseFrameGraphRegressionOptions,
  validateFrameGraphRegressionResult, validateFrameGraphRegressionEvidence } from './framegraph-regression-policy.mjs';
const adapter = { vendor: 'amd', architecture: 'rdna-1', isFallbackAdapter: false };
function result(name) {
  const reuse = name === 'framegraph-reuse';
  return { schemaVersion: 1, status: 'passed', cases: [
    ['forward', 1, false], ...(!reuse ? [['forward-msaa', 1, false]] : []),
    ['reference', 4, false], ['tiled', 4, false], ['tiled', 4, true],
  ].map(([algorithm, count, mixed]) => ({ maxDelta: 0, ...Object.fromEntries(['baseline', 'candidate'].map(side => [side, {
    algorithm, count, mixed, [reuse ? 'reuse' : 'cached']: side === 'candidate', adapter,
    actualPasses: 12, cleanup: { ownerResidual: 0, liveGpuResources: 0 }, rgbMaxima: Array(count).fill(.5),
    dimensions: Array.from({ length: count }, (_, i) => mixed && i % 2 ? [48, 40] : [64, 64]),
    alphaCoverage: Array.from({ length: count }, (_, i) => mixed && i % 2 ? 48 * 40 : 64 * 64),
    stats: Object.fromEntries((algorithm.startsWith('forward') ? ['post'] : ['post', 'deferred', 'ao']).map(pool => [pool,
      { physicalBytes: reuse && side === 'baseline' ? 200 : 100 }])),
  }])) })) };
}
function evidence() {
  return { schemaVersion: 2, status: 'passed', tier: 'smoke', performanceQualified: false,
    inputs: { sha256: 'input' }, build: { inputs: { sha256: 'input' } }, sourceFingerprint: 'source',
    results: createFrameGraphRegressionPlan('smoke').map(job => ({ ...job, status: 'passed', result: result(job.name) })) };
}
const identity = { inputs: 'input', sourceFingerprint: 'source', tier: 'smoke' };
test('full requires eight jobs on each frozen adapter, including 312-switch and native device tests', () => {
  const plan = createFrameGraphRegressionPlan(); assert.equal(plan.length, 16);
  for (const preference of ['high-performance', 'low-power']) {
    assert.equal(plan.filter(j => j.powerPreference === preference).length, 8);
    assert.ok(plan.some(j => j.powerPreference === preference && j.name === 'deferred-g04-lifecycle'));
    assert.ok(plan.some(j => j.powerPreference === preference && j.name === 'deferred-g04-device'));
  }
  assert.deepEqual(parseFrameGraphRegressionOptions([]), { tier: 'full', plan: false });
  assert.throws(() => parseFrameGraphRegressionOptions(['--full', '--smoke']));
  assert.throws(() => parseFrameGraphRegressionOptions(['--unknown']));
  assert.throws(() => createFrameGraphRegressionPlan('quick'));
});
test('valid smoke evidence remains unqualified and cannot stand in for full', () => {
  validateFrameGraphRegressionEvidence(evidence(), identity);
  assert.throws(() => validateFrameGraphRegressionEvidence(evidence(), { ...identity, tier: 'full' }));
});
test('reject stale, missing, reordered, failed or performance-promoted evidence', () => {
  for (const mutate of [e => { e.inputs.sha256 = 'stale'; }, e => { e.build.inputs.sha256 = 'stale'; },
    e => { e.sourceFingerprint = 'stale'; }, e => e.results.pop(), e => e.results.reverse(),
    e => { e.results[0].status = 'failed'; }, e => { e.performanceQualified = true; }]) {
    const e = evidence(); mutate(e); assert.throws(() => validateFrameGraphRegressionEvidence(e, identity));
  }
});
test('reject blank pixels, NaN, wrong ablation, changed work, residue, missing pools and invalid saving', () => {
  for (const mutate of [r => { r.cases[0].maxDelta = NaN; }, r => { r.cases[0].maxDelta = .1; },
    r => r.cases.pop(), r => { r.cases[0].candidate.rgbMaxima = [0]; },
    r => { r.cases[0].candidate.alphaCoverage = [1]; },
    r => { r.cases[0].candidate.reuse = false; }, r => { r.cases[0].candidate.actualPasses++; },
    r => { r.cases[0].candidate.cleanup.ownerResidual = 1; }, r => { delete r.cases[0].candidate.stats.post; },
    r => { r.cases[0].candidate.stats.post.physicalBytes = 200; }]) {
    const r = result('framegraph-reuse'); mutate(r);
    assert.throws(() => validateFrameGraphRegressionResult(r, { name: 'framegraph-reuse', powerPreference: 'high-performance' }));
  }
});
test('full rejects substituted device classes; smoke still rejects fallback adapters', () => {
  const r = result('framegraph-cache');
  assert.throws(() => validateFrameGraphRegressionResult(r, { name: 'framegraph-cache', powerPreference: 'low-power' }));
  const fallback = structuredClone(r); fallback.cases[0].candidate.adapter.isFallbackAdapter = true;
  assert.throws(() => validateFrameGraphRegressionResult(fallback, { name: 'framegraph-cache', powerPreference: 'high-performance' }, 'smoke'));
});
