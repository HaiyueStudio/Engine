import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeTimingSamples } from './timing-cohorts.mjs';

test('nearest-rank timing summary exposes P50/P95/P99 and 1% low FPS', () => {
  const samples = Array.from({ length: 100 }, (_, index) => index + 1);
  const summary = summarizeTimingSamples(samples);

  assert.equal(summary.sampleCount, 100);
  assert.equal(summary.samples, 100);
  assert.equal(summary.p50, 50);
  assert.equal(summary.p95, 95);
  assert.equal(summary.p99, 99);
  assert.equal(summary.onePercentLowFps, 1_000 / 99);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 100);
  assert.equal(summary.mean, 50.5);
});

test('single-sample timing summary keeps every percentile on the boundary', () => {
  const summary = summarizeTimingSamples([4]);

  assert.equal(summary.sampleCount, 1);
  assert.equal(summary.p50, 4);
  assert.equal(summary.p95, 4);
  assert.equal(summary.p99, 4);
  assert.equal(summary.onePercentLowFps, 250);
  assert.equal(summary.min, 4);
  assert.equal(summary.max, 4);
  assert.equal(summary.mean, 4);
});

test('zero frame time uses a JSON-safe null instead of infinite 1% low FPS', () => {
  const summary = summarizeTimingSamples([0, 0, 0]);

  assert.equal(summary.p99, 0);
  assert.equal(summary.onePercentLowFps, null);
  assert.equal(JSON.parse(JSON.stringify(summary)).onePercentLowFps, null);
});

test('timing summary rejects empty, negative, and non-finite samples', () => {
  assert.throws(() => summarizeTimingSamples([]), /at least one raw sample/);
  assert.throws(() => summarizeTimingSamples([0, -1]), /finite and non-negative/);
  assert.throws(
    () => summarizeTimingSamples([Number.POSITIVE_INFINITY]),
    /finite and non-negative/,
  );
  assert.throws(() => summarizeTimingSamples([Number.NaN]), /finite and non-negative/);
});
