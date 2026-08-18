import assert from 'node:assert/strict';
import test from 'node:test';
import { compareHyaFirstFrameCohorts } from './first-frame-policy.mjs';

test('cross-host HYA first-frame regression remains visible without becoming release-blocking', () => {
  const diagnostic = compareHyaFirstFrameCohorts(
    {
      cohorts: {
        small: { sampleCount: 2, firstFrameP95Ms: 20.34 },
        large: { sampleCount: 1, firstFrameP95Ms: 120 },
      },
    },
    {
      cohorts: {
        small: { sampleCount: 2, firstFrameP95Ms: 7.995 },
        large: { sampleCount: 1, firstFrameP95Ms: 100 },
      },
    },
  );

  assert.equal(diagnostic.role, 'cross-host-diagnostic');
  assert.equal(diagnostic.releaseBlocking, false);
  assert.equal(diagnostic.status, 'regression-observed');
  assert.deepEqual(diagnostic.cohorts.map(cohort => cohort.status), [
    'regression-observed',
    'regression-observed',
  ]);
  assert.equal(diagnostic.cohorts[0].baselineP95Ms, 7.995);
  assert.equal(diagnostic.cohorts[0].currentP95Ms, 20.34);
});

test('same-host-compatible values report within tolerance', () => {
  const diagnostic = compareHyaFirstFrameCohorts(
    { cohorts: { small: { sampleCount: 1, firstFrameP95Ms: 8.5 } } },
    { summary: { firstFrameP95Ms: 8 } },
  );

  assert.equal(diagnostic.status, 'within-tolerance');
  assert.equal(diagnostic.cohorts[0].status, 'within-tolerance');
});
