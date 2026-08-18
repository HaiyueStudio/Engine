import test from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePlanarReflectionPixelBaseline,
  createPlanarReflectionPixelBaseline,
} from './planar-reflection-pixel-baseline.mjs';

function result() {
  return {
    pixelCases: {
      visible: {
        width: 320,
        height: 192,
        hash: 'aaaa',
        nonBlackPixels: 8_000,
        averageLuminance: 11,
        samples: { center: [25, 25, 25, 255] },
        mirrorStats: { planned: 1, executed: 1, dropped: 0 },
      },
    },
  };
}

test('treats unstable GPU hashes as diagnostics when visual metrics are stable', () => {
  const baseline = createPlanarReflectionPixelBaseline(result());
  const current = result();
  current.pixelCases.visible.hash = 'bbbb';
  current.pixelCases.visible.nonBlackPixels += 100;
  current.pixelCases.visible.samples.center[0] += 2;
  const comparison = comparePlanarReflectionPixelBaseline(current, baseline);
  assert.equal(comparison.status, 'passed');
  assert.deepEqual(comparison.hashMismatches, [{ id: 'visible', expected: 'aaaa', actual: 'bbbb' }]);
});

test('fails meaningful pixel and reflection-planner changes', () => {
  const baseline = createPlanarReflectionPixelBaseline(result());
  const current = result();
  current.pixelCases.visible.nonBlackPixels = 4_000;
  current.pixelCases.visible.mirrorStats.executed = 0;
  const comparison = comparePlanarReflectionPixelBaseline(current, baseline);
  assert.equal(comparison.status, 'failed');
  assert.ok(comparison.violations.some(item => item.includes('nonBlackPixels')));
  assert.ok(comparison.violations.some(item => item.includes('planner/culling')));
});
