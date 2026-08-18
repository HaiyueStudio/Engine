import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareVolumePixelRecords,
  resolveVolumePixelCandidateMode,
} from './volume-example-pixel-policy.mjs';

const baseline = Object.freeze({
  schemaVersion: 1,
  fixture: 'volume',
  width: 960,
  height: 640,
  hash: 'reviewed',
  bytes: 100,
  coverage: 'full',
});

test('volume pixel policy reports every changed baseline field', () => {
  const mismatches = compareVolumePixelRecords({
    ...baseline,
    hash: 'candidate',
    bytes: 101,
  }, baseline);
  assert.deepEqual(mismatches, [
    'Volume pixel regression at hash: expected reviewed, received candidate.',
    'Volume pixel regression at bytes: expected 100, received 101.',
  ]);
});

test('volume candidate retention is explicit and never implied by an output path alone', () => {
  assert.deepEqual(resolveVolumePixelCandidateMode({}), { enabled: false, directory: null });
  assert.deepEqual(resolveVolumePixelCandidateMode({
    VOLUME_CANDIDATE_DIFF: '1',
    VOLUME_CANDIDATE_DIR: 'artifacts/webgpu/volume-candidate',
  }), {
    enabled: true,
    directory: 'artifacts/webgpu/volume-candidate',
  });
  assert.throws(
    () => resolveVolumePixelCandidateMode({ VOLUME_CANDIDATE_DIFF: '1' }),
    /must be provided together/,
  );
  assert.throws(
    () => resolveVolumePixelCandidateMode({ VOLUME_CANDIDATE_DIR: 'candidate' }),
    /must be provided together/,
  );
});
