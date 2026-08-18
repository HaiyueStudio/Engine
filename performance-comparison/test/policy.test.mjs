import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateComparisonReport } from '../lib/policy.mjs';
import { expectedStructuralEvidence } from '../scene-contract.mjs';

function cohort(p50, p95 = p50 * 1.1, rsd = 0.03) {
  return { frameWall: { p50, p95, relativeStandardDeviation: rsd } };
}

function engine(engineId, backend, p50) {
  return {
    engineId,
    backend,
    nativeBackend: true,
    structural: expectedStructuralEvidence(),
    visual: { status: 'passed' },
    browserErrorCount: 0,
    cohorts: [cohort(p50), cohort(p50 * 1.01), cohort(p50 * 0.99)],
  };
}

test('passes when HaiYue leads the complete same-machine WebGPU group', () => {
  const report = { engines: [
    engine('haiyue', 'webgpu', 4),
    engine('three', 'webgpu', 5),
    engine('babylon', 'webgpu', 4.8),
    engine('playcanvas', 'webgpu', 4.5),
    engine('galacean', 'webgl2', 5.2),
  ] };
  assert.equal(evaluateComparisonReport(report).status, 'passed');
});

test('allows a five percent statistical tie but rejects a slower subject', () => {
  const tied = { engines: [
    engine('haiyue', 'webgpu', 4.2),
    engine('three', 'webgpu', 4),
    engine('babylon', 'webgpu', 5),
    engine('playcanvas', 'webgpu', 5.5),
    engine('galacean', 'webgl2', 4),
  ] };
  assert.equal(evaluateComparisonReport(tied).status, 'passed');
  tied.engines[0] = engine('haiyue', 'webgpu', 4.21);
  assert.equal(evaluateComparisonReport(tied).status, 'failed');
});

test('keeps Galacean outside the WebGPU ranking and rejects parity drift', () => {
  const galacean = engine('galacean', 'webgl2', 1);
  galacean.structural.objectCount--;
  const result = evaluateComparisonReport({ engines: [
    engine('haiyue', 'webgpu', 4),
    engine('three', 'webgpu', 5),
    engine('babylon', 'webgpu', 5),
    engine('playcanvas', 'webgpu', 5),
    galacean,
  ] });
  assert.equal(result.ranking.some(item => item.engineId === 'galacean'), false);
  assert.match(result.violations.join('\n'), /galacean: structural\.objectCount/);
});

test('rejects missing adapters, backend fallback, noisy cohorts and failed visuals', () => {
  const three = engine('three', 'webgl2', 5);
  three.visual.status = 'failed';
  three.cohorts = [cohort(3, 6, 0.6), cohort(5, 6, 0.6), cohort(8, 9, 0.02)];
  const result = evaluateComparisonReport({ engines: [engine('haiyue', 'webgpu', 4), three] });
  const message = result.violations.join('\n');
  assert.match(message, /babylon: required adapter result is missing/);
  assert.match(message, /three: ranked backend is webgl2/);
  assert.match(message, /three: visual sanity check did not pass/);
  assert.match(message, /three: timing cohorts are too noisy/);
});

test('full evidence requires the frozen warmup, cohort and raw-sample counts', () => {
  const engines = [
    engine('haiyue', 'webgpu', 4),
    engine('three', 'webgpu', 5),
    engine('babylon', 'webgpu', 5),
    engine('playcanvas', 'webgpu', 5),
    engine('galacean', 'webgl2', 5),
  ];
  const result = evaluateComparisonReport({
    profile: 'full',
    configuration: { cohorts: 3, warmupFrames: 12, sampleFrames: 40 },
    engines,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.violations.join('\n'), /raw samples are incomplete/);
});
