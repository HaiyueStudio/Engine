import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createG09AcceptanceRoute, interpretG09Microbenchmark, validateG09AcceptanceRouting } from './framegraph-acceptance-routing.mjs';
import { G09_OUTSTANDING_ACCEPTANCE } from './framegraph-acceptance-cases.mjs';
const config = JSON.parse(readFileSync(new URL('../../config/framegraph-acceptance-021.json', import.meta.url)));
const assessment = (a, b, stable = true) => ({ status: 'failed', performanceQualified: false, rows: [{ caseId: 'single-light', metric: 'gpuPassSum',
  A0: { pooled: { p95: a }, stability: { stable } }, B4: { pooled: { p95: b }, stability: { stable } } }] });

test('legacy microbenchmarks are optional while production and integrity requirements remain required', () => {
  const route = createG09AcceptanceRoute(config);
  assert.equal(route.microbenchmark.releaseBlocking, false);
  assert.equal(route.microbenchmark.legacyCalibrationRequired, false);
  assert.equal(route.requiredEvidence.length, 5);
  assert.equal(route.status, 'incomplete');
  assert.equal(route.g09Complete, false);
  assert.equal(route.production.unregisteredProfileResult, 'incomplete');
  assert.doesNotMatch(JSON.stringify(G09_OUTSTANDING_ACCEPTANCE), /common-sampling-freeze|original-budgets/);
});
test('small absolute cost above 5% warns without rewriting the historical failure', () => {
  const raw = assessment(.145408, .180192), before = structuredClone(raw);
  const result = interpretG09Microbenchmark(raw, config);
  assert.equal(result.status, 'warning');
  assert.equal(result.historicalStatus, 'failed');
  assert.equal(result.releaseBlocking, false);
  assert.ok(Math.abs(result.rows[0].absoluteDeltaMs - .034784) < 1e-10);
  assert.deepEqual(raw, before);
});
test('unstable faster and slower populations remain inconclusive; no noise waiver or release promotion', () => {
  for (const value of [.1, .18]) {
    const result = interpretG09Microbenchmark(assessment(.145, value, false), config);
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.performanceQualified, false);
  }
});
test('invalid evidence cannot become a warning and a plan cannot be a pass', () => {
  for (const value of [NaN, Infinity, 0, -1]) assert.throws(() => interpretG09Microbenchmark(assessment(.1, value), config));
  assert.throws(() => interpretG09Microbenchmark({ status: 'passed', performanceQualified: true, rows: [] }, config));
  for (const mutate of [c => c.requiredEvidence.pop(), c => { c.microbenchmark.retainAllSamples = false; },
    c => { c.microbenchmark.regressionWarningRatio = .2; }, c => { c.production.automaticRetry = true; },
    c => { c.production.requiredProfileFields = ['targetFps']; }]) {
    const value = structuredClone(config); mutate(value); assert.throws(() => validateG09AcceptanceRouting(value));
  }
});
test('at and below 5% remains informational and never supplies production qualification', () => {
  const result = interpretG09Microbenchmark(assessment(1, 1.05), config);
  assert.equal(result.status, 'within-warning-budget');
  assert.equal(result.g09Complete, false);
});
test('cold startup and sampled fence wall time do not acquire an invented 5% budget', () => {
  for (const metric of ['coldCpu', 'frameWall']) {
    const value = assessment(1, 2); value.rows[0].metric = metric;
    assert.equal(interpretG09Microbenchmark(value, config).rows[0].status, 'informational');
  }
});
