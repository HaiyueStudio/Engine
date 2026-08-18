import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluatePerformanceBudget,
  createPerformanceSourceFingerprint,
  loadPerformanceBudgetConfig,
  selectPerformanceProfile,
  shouldEnforceDevicePerformanceBudgets,
} from './webgpu-performance-budget.mjs';
import { resolveLocalPerformanceProfileId } from './webgpu-performance-profile-selection.mjs';
import {
  aggregateTimingCohorts,
  assertMatchingTimingSourceFingerprints,
  createTimingVariabilityAnalysis,
  summarizeTimingSamples,
} from './benchmark/timing-cohorts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadPerformanceBudgetConfig(root);

test('legacy device budgets block only the explicit diagnostic performance run', () => {
  assert.equal(shouldEnforceDevicePerformanceBudgets({}), false);
  assert.equal(shouldEnforceDevicePerformanceBudgets({ WEBGPU_ENFORCE_DEVICE_PERFORMANCE_BUDGETS: '0' }), false);
  assert.equal(shouldEnforceDevicePerformanceBudgets({ WEBGPU_ENFORCE_DEVICE_PERFORMANCE_BUDGETS: '1' }), true);
});

test('selects a profile from the real platform and adapter fingerprint', () => {
  const selected = selectPerformanceProfile(config, {
    nodePlatform: 'darwin',
    adapter: { vendor: 'apple', architecture: 'metal-3' },
  });
  assert.equal(selected.id, 'apple-integrated');
});

test('fingerprints the executable benchmark inputs deterministically', () => {
  const first = createPerformanceSourceFingerprint(root);
  const second = createPerformanceSourceFingerprint(root);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, second);
});

test('rejects a requested profile when the physical adapter does not match', () => {
  assert.throws(() => selectPerformanceProfile(config, {
    nodePlatform: 'darwin',
    adapter: { vendor: 'apple', architecture: 'metal-3' },
  }, 'windows-discrete'), /does not match/);
});

test('resolves an unambiguous local profile and requires a choice on multi-GPU platforms', () => {
  assert.equal(resolveLocalPerformanceProfileId(config, 'darwin'), 'apple-integrated');
  assert.equal(
    resolveLocalPerformanceProfileId(config, 'win32', 'windows-discrete'),
    'windows-discrete',
  );
  assert.throws(
    () => resolveLocalPerformanceProfileId(config, 'win32'),
    /Multiple local WebGPU performance profiles/,
  );
});

test('enforces P95 and minimum sample count for every matched workload', () => {
  const results = [0, 1, 10, 100].flatMap(dynamicRatio => [1, 4].map(viewCount => ({
    id: `render3d.real-frame.256e.${dynamicRatio}pct.${viewCount}v`,
    entityCount: 256,
    dynamicRatio: dynamicRatio / 100,
    viewCount,
    samples: 20,
    timing: { p95: viewCount === 1 ? 8 : 12 },
    sampleWall: { p95: viewCount === 1 ? 9 : 13 },
    queueWait: { p95: viewCount === 1 ? 5 : 6 },
  })));
  const passed = evaluatePerformanceBudget(
    config, 'apple-integrated', 'render3d.real-frame', 'smoke', { results },
  );
  assert.equal(passed.status, 'passed');
  assert.equal(passed.checks.length, 24);

  results[0].sampleWall.p95 = 11;
  results[1].samples = 1;
  const failed = evaluatePerformanceBudget(
    config, 'apple-integrated', 'render3d.real-frame', 'smoke', { results },
  );
  assert.equal(failed.status, 'failed');
  assert.ok(failed.violations.some(item =>
    item.reason === 'p95-exceeded' && item.channel === 'sampleWall'));
  assert.ok(failed.violations.some(item => item.reason === 'samples-insufficient'));
});

test('real-renderer budgets reject queue-wait regressions independently of CPU runtime', () => {
  const result = {
    id: 'render3d.real-frame.1000e.10pct.1v',
    entityCount: 1000,
    dynamicRatio: 0.1,
    viewCount: 1,
    samples: 30,
    timing: { p95: 3.5 },
    sampleWall: { p95: 9 },
    queueWait: { p95: 6.5 },
  };
  const evaluated = evaluatePerformanceBudget(
    config,
    'apple-integrated',
    'render3d.real-frame',
    'full',
    { results: [
      { ...result, id: 'render3d.real-frame.1000e.0pct.1v', dynamicRatio: 0 },
      { ...result, id: 'render3d.real-frame.1000e.1pct.1v', dynamicRatio: 0.01 },
      result,
      { ...result, id: 'render3d.real-frame.1000e.100pct.1v', dynamicRatio: 1 },
      ...[0, 0.01, 0.1, 1].map(dynamicRatio => ({
        ...result,
        id: `render3d.real-frame.1000e.${dynamicRatio * 100}pct.4v`,
        dynamicRatio,
        viewCount: 4,
        timing: { p95: 8 },
        sampleWall: { p95: 12 },
        queueWait: { p95: 6 },
      })),
    ] },
  );
  assert.equal(evaluated.status, 'failed');
  assert.ok(evaluated.violations.some(item =>
    item.caseId === result.id
      && item.channel === 'queueWait'
      && item.reason === 'p95-exceeded'));
});

test('timing statistics retain raw samples and use population variance', () => {
  const summary = summarizeTimingSamples([1, 2, 3, 4]);
  assert.deepEqual(summary.rawSamples, [1, 2, 3, 4]);
  assert.equal(summary.p50, 2);
  assert.equal(summary.p95, 4);
  assert.equal(summary.mean, 2.5);
  assert.equal(summary.variance, 1.25);
  assert.equal(summary.standardDeviation, Math.sqrt(1.25));
});

test('equal independent cohorts are pooled without selecting the best launch', () => {
  const cohorts = [
    timingCohort('cohort-1', new Array(20).fill(5)),
    timingCohort('cohort-2', new Array(20).fill(6)),
    timingCohort('cohort-3', new Array(20).fill(9)),
  ];
  const artifact = aggregateTimingCohorts(cohorts);
  const result = artifact.results[0];
  assert.equal(result.samples, 60);
  assert.equal(result.timing.rawSamples.length, 60);
  assert.equal(result.timing.p95, 9);
  assert.equal(result.timing.p99, 9);
  assert.equal(result.timing.sampleCount, 60);
  assert.equal(result.sampleWall.sampleCount, 60);
  assert.equal(result.cpuUpdate.sampleCount, 60);
  assert.deepEqual(
    result.timingCohorts.map(cohort => cohort.timing.p95),
    [5, 6, 9],
  );
  assert.equal(result.cohortStatistics.p95.variance, 26 / 9);
  assert.equal(result.cohortStatistics.p99.variance, 26 / 9);
  assert.equal(
    artifact.configuration.aggregation,
    'equal-cohort pooled empirical nearest-rank',
  );
});

test('source fingerprints must match across timing and allocation passes', () => {
  const cohorts = [
    timingCohort('timing-1', [5]),
    { ...timingCohort('allocation', [5]), sourceFingerprint: 'sha256:other' },
  ];
  assert.throws(
    () => assertMatchingTimingSourceFingerprints(cohorts),
    /source fingerprint mismatch/,
  );
});

test('variability analysis distinguishes stable cost from launch variance', () => {
  const stableArtifact = aggregateTimingCohorts([
    timingCohort('stable-1', new Array(20).fill(8)),
    timingCohort('stable-2', new Array(20).fill(8.1)),
    timingCohort('stable-3', new Array(20).fill(8.2)),
  ]);
  const stable = createTimingVariabilityAnalysis(stableArtifact, {
    checks: [{ caseId: 'render3d.real-frame.1000e.100pct.1v', maxP95Ms: 7 }],
  });
  assert.equal(
    stable.summary.conclusion,
    'stable-workload-budget-regression-observed',
  );
  const stableCase = stable.cases[0];
  assert.equal(stableCase.stability, 'stable');
  assert.equal(stableCase.conclusion, 'consistent-workload-cost');
  assert.equal(stableCase.cohortsExceedingBudget, 3);

  const variableArtifact = aggregateTimingCohorts([
    timingCohort('variable-1', new Array(20).fill(5)),
    timingCohort('variable-2', new Array(20).fill(5)),
    timingCohort('variable-3', new Array(20).fill(12)),
  ]);
  const variableAnalysis = createTimingVariabilityAnalysis(variableArtifact, {
    checks: [{ caseId: 'render3d.real-frame.1000e.100pct.1v', maxP95Ms: 7 }],
  });
  assert.equal(
    variableAnalysis.summary.conclusion,
    'budget-failure-attributed-to-variance',
  );
  const variable = variableAnalysis.cases[0];
  assert.equal(variable.stability, 'unstable');
  assert.equal(variable.conclusion, 'measurement-or-environment-variance');
  assert.ok(variable.signals.some(signal =>
    signal.factor === 'thermal-or-sustained-system-load'));
});

function timingCohort(id, frameSamples) {
  const channel = values => summarizeTimingSamples(values);
  const scaled = scale => frameSamples.map(value => value * scale);
  return {
    id,
    sourceFingerprint: 'sha256:fixture',
    result: {
      schemaVersion: 3,
      suite: 'render3d.real-frame',
      passKind: id === 'allocation' ? 'allocation' : 'timing',
      generatedAt: `2026-07-24T00:00:0${id.length % 10}.000Z`,
      browser: 'test browser',
      adapter: { vendor: 'apple' },
      configuration: { samples: frameSamples.length },
      gate: { status: 'passed', failures: [] },
      results: [{
        id: 'render3d.real-frame.1000e.100pct.1v',
        entityCount: 1000,
        dynamicRatio: 1,
        viewCount: 1,
        samples: frameSamples.length,
        coldStart: {
          rawSamples: [{ deviceRequestMs: 1 }],
          total: channel([1]),
        },
        warmup: channel(scaled(1.2)),
        timing: channel(frameSamples),
        sampleWall: channel(scaled(1.5)),
        cpuUpdate: channel(scaled(0.1)),
        cpuRecord: channel(scaled(0.4)),
        cpuSubmit: channel(scaled(0.05)),
        queueWait: channel(scaled(0.5)),
        gpuTimestamp: {
          status: 'available',
          timing: channel(scaled(0.6)),
          passLabels: ['main'],
        },
        metrics: { drawsPerFrame: 1 },
      }],
    },
  };
}
