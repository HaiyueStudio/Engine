import test from 'node:test';
import assert from 'node:assert/strict';
import { READBACK_CHURN_SCHEMA_VERSION, READBACK_CHURN_SUITE, validateReadbackChurnResult } from './readback-churn-contract.mjs';

function passingResult() {
  return {
    schemaVersion: READBACK_CHURN_SCHEMA_VERSION,
    suite: READBACK_CHURN_SUITE,
    profile: 'short',
    environment: { adapter: { description: 'test adapter' } },
    config: { frames: 120 },
    readback: {
      requests: 120, accepted: 100, skipped: 20, mappingStarted: 100, delivered: 98, cancelled: 2, mapFailures: 0,
      mappingsBeforeSubmit: 0, resultsBeforeSubmit: 0, duplicateResults: 0, unknownResults: 0, valueMismatches: 0,
      stalePublishedResults: 0, pendingDestroyEvents: 2, maxRingOccupancy: 2, pendingAfterDrain: 0, skipRate: 1 / 6,
      latencyFrames: { p50: 1, p95: 2, max: 3 },
    },
    churn: {
      cycles: 30, resourcesCreated: 200, cacheHits: 20, cacheMisses: 10, liveResourcesAfterDrain: 0,
      liveEstimatedBytesAfterDrain: 0, cacheEntriesAfterClear: 0, releasedOwnerResiduals: 0, deviceLost: false,
      resourceTypes: Object.fromEntries(['buffer', 'texture', 'bind-group', 'pipeline-layout', 'compute-pipeline'].map(type => [type, { created: 1 }])),
      caches: [
        { label: 'renderer-resource', hits: 10, misses: 5 },
        { label: 'renderer-pipeline-layout', hits: 10, misses: 5 },
      ],
    },
    validation: { errors: [], uncapturedErrors: [] },
  };
}

test('accepts a fully drained real-WebGPU gate result', () => {
  assert.deepEqual(validateReadbackChurnResult(passingResult(), { profile: 'short' }), []);
});

test('rejects pre-submit mapping, incorrect readback, and resource residuals', () => {
  const result = passingResult();
  result.readback.mappingsBeforeSubmit = 1;
  result.readback.valueMismatches = 1;
  result.churn.liveResourcesAfterDrain = 3;
  const errors = validateReadbackChurnResult(result, { profile: 'short' });
  assert.equal(errors.some(error => error.includes('mappingsBeforeSubmit')), true);
  assert.equal(errors.some(error => error.includes('valueMismatches')), true);
  assert.equal(errors.some(error => error.includes('liveResourcesAfterDrain')), true);
});

test('long profile cannot silently shrink below its evidence window', () => {
  const result = passingResult();
  result.profile = 'long';
  result.config.frames = 999;
  assert.equal(validateReadbackChurnResult(result, { profile: 'long' }).some(error => error.includes('at least 1000')), true);
});
