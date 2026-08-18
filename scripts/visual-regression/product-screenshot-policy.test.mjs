import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVisualFingerprint,
  PRODUCT_SCREENSHOT_CASES,
} from './product-screenshot-policy.mjs';

test('product screenshot suite covers character, AO, shadows, Spine and a complete game', () => {
  assert.deepEqual(PRODUCT_SCREENSHOT_CASES.map(entry => entry.id), [
    'character-animation',
    'ambient-occlusion',
    'multiple-directional-shadows',
    'spine-animation',
    'complete-game-match-3',
  ]);
  assert.ok(PRODUCT_SCREENSHOT_CASES.every(entry => entry.baseline.endsWith('.json')));
  assert.ok(PRODUCT_SCREENSHOT_CASES.every(entry => entry.baselineImage.endsWith('.png')));
});

test('visual fingerprint comparison tolerates quantization noise and rejects scene changes', () => {
  const baseline = {
    id: 'fixture',
    budget: {
      maxMeanAbsoluteError: 14,
      maxChangedChannelRatio: 0.18,
      changedChannelThreshold: 34,
      maxMeanRgbDelta: 24,
      maxDarkRatioDelta: 0.15,
    },
    capture: {
      sampleWidth: 2,
      sampleHeight: 1,
      signature: [17, 34, 51, 68, 85, 102],
      meanRgb: [42.5, 59.5, 76.5],
      darkRatio: 0.1,
    },
  };
  assert.equal(compareVisualFingerprint({
    sampleWidth: 2,
    sampleHeight: 1,
    signature: [17, 34, 51, 68, 102, 102],
    meanRgb: [42.5, 68, 76.5],
    darkRatio: 0.12,
  }, baseline).status, 'passed');
  assert.equal(compareVisualFingerprint({
    sampleWidth: 2,
    sampleHeight: 1,
    signature: [255, 255, 255, 255, 255, 255],
    meanRgb: [255, 255, 255],
    darkRatio: 0,
  }, baseline).status, 'failed');
});
