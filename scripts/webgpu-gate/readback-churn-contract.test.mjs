import { GPUResourceTracker } from '../../engine/dist/experimental.js';
import { aggregateChurnCacheHistory, releaseChurnOwner, releaseChurnScope } from './readback-churn-cache-history.mjs';
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

test('retiring many churn owners preserves their measured totals while tracker metadata stays bounded', () => {
  const tracker = new GPUResourceTracker({ debug: true });
  const engine = tracker.createScope('engine', 'cache-history-engine');
  const history = [];
  tracker.recordCacheAccess('renderer-resource', false, { owner: engine.owner, entries: 1 });
  for (let i = 0; i < 30; i++) {
    const scope = tracker.createScope('frame', `cycle-${i}`);
    tracker.recordCacheAccess('renderer-pipeline-layout', false, { owner: scope.owner, entries: 1 });
    tracker.recordCacheAccess('renderer-pipeline-layout', true, { owner: scope.owner, entries: 1 });
    tracker.recordCacheAccess('renderer-resource', true, { owner: engine.owner, entries: 1 });
    releaseChurnScope(tracker, scope, history);
    assert.equal(tracker.getDebugSnapshot().caches.length, 1, 'retired metadata must still be released');
  }
  releaseChurnOwner(tracker, engine.owner, history);
  assert.deepEqual(tracker.getDebugSnapshot().caches, []);
  assert.deepEqual(aggregateChurnCacheHistory(history), [
    { label: 'renderer-pipeline-layout', hits: 30, misses: 30, peakEntries: 1 },
    { label: 'renderer-resource', hits: 30, misses: 1, peakEntries: 1 },
  ]);
});

test('empty and repeated releases do not invent activity or double count another live owner', () => {
  const tracker = new GPUResourceTracker({ debug: true });
  const scope = tracker.createScope('frame', 'one');
  const other = tracker.createScope('engine', 'other');
  const history = [];
  tracker.recordCacheAccess('actual-cache', true, { owner: scope.owner, entries: 3 });
  tracker.recordCacheAccess('other-cache', false, { owner: other.owner, entries: 1 });
  releaseChurnScope(tracker, scope, history);
  releaseChurnScope(tracker, scope, history);
  assert.deepEqual(aggregateChurnCacheHistory(history), [{ label: 'actual-cache', hits: 1, misses: 0, peakEntries: 3 }]);
  assert.equal(tracker.getDebugSnapshot().caches.length, 1);
  tracker.releaseAll();
  assert.deepEqual(aggregateChurnCacheHistory([]), []);
});

test('resource residue remains observable after activity capture', () => {
  const tracker = new GPUResourceTracker({ debug: true });
  const scope = tracker.createScope('frame', 'retired');
  const history = [];
  tracker.recordCacheAccess('cache', false, { owner: scope.owner });
  releaseChurnScope(tracker, scope, history);
  const buffer = tracker.trackBuffer({ destroy() {} }, { owner: scope.owner, label: 'late-buffer', estimatedBytes: 16 });
  assert.equal(tracker.getDebugSnapshot().releasedOwnerResiduals, 1);
  tracker.untrackBuffer(buffer);
  assert.equal(tracker.getDebugSnapshot().releasedOwnerResiduals, 0);
});
