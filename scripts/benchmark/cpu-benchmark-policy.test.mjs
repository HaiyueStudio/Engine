import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  aggregateBaselineCohortResults,
  applyCohortRevalidation,
  classifyCohortStability,
  collectAbsoluteBudgetViolations,
  collectMetricBudgetViolations,
  compareBenchmarkResults,
  createBenchmarkIdentity,
  evaluateCohortRevalidation,
  matchesCaseFilter,
  resolveIndependentCohortTimeoutMs,
  resolveBenchmarkConfiguration,
  shouldFailBenchmarkEnforcement,
  validateReleaseBenchmarkArtifact,
} from './cpu-benchmark-policy.mjs';

const revision = '1234567890abcdef1234567890abcdef12345678';

test('explicit enforce configuration requires warmup 8, samples 30, and three cohort rounds', () => {
  assert.deepEqual(
    resolveBenchmarkConfiguration({ enforce: true, profile: 'ci' }),
    {
      enforce: true,
      profile: 'ci',
      warmup: 8,
      samples: 30,
      iterations: 5,
      cohortRounds: 3,
      caseFilter: [],
    },
  );
  assert.throws(() => resolveBenchmarkConfiguration({ enforce: true, warmup: 7 }), /warmup >= 8/);
  assert.throws(() => resolveBenchmarkConfiguration({ enforce: true, samples: 29 }), /samples >= 30/);
  assert.throws(() => resolveBenchmarkConfiguration({ enforce: true, cohortRounds: 2 }), /at least 3 cohort rounds/);
});

test('case filters accept exact, wildcard, comma-separated, and repeated filters', () => {
  const configuration = resolveBenchmarkConfiguration({
    caseFilter: ['render3d.*.1v,ecs.query-structure.1000', 'asset.*'],
  });
  assert.equal(matchesCaseFilter('render3d.real-frame.1000e.1pct.1v', configuration.caseFilter), true);
  assert.equal(matchesCaseFilter('ecs.query-structure.1000', configuration.caseFilter), true);
  assert.equal(matchesCaseFilter('asset.gltf-parse.500', configuration.caseFilter), true);
  assert.equal(matchesCaseFilter('scene.lifecycle.500', configuration.caseFilter), false);
});

test('complete full cohorts scale their process timeout with the enrolled case set', () => {
  assert.equal(resolveIndependentCohortTimeoutMs('ci', 51), 30 * 60_000);
  assert.equal(resolveIndependentCohortTimeoutMs('full', 1), 30 * 60_000);
  assert.equal(resolveIndependentCohortTimeoutMs('full', 95), 190 * 60_000);
  assert.throws(
    () => resolveIndependentCohortTimeoutMs('full', 0),
    /positive integer/,
  );
});

test('synthetic +20% eligible regression blocks only after three independent cohort medians confirm it', () => {
  const identity = benchmarkIdentity();
  const baselineResult = result({ p50: 100, p95: 100 });
  const candidateResult = result({ p50: 120, p95: 120 });
  const initial = compareBenchmarkResults({
    currentResults: [candidateResult],
    currentIdentity: identity,
    baseline: cohortBaseline(identity, [baselineResult]),
    threshold: 0.15,
  });

  assert.equal(initial.eligibility.status, 'eligible');
  assert.equal(initial.lowNoiseRegressions.length, 1);
  assert.equal(initial.enforceableRegressions.length, 0);

  const cohort = evaluateCohortRevalidation({
    suspectedRegressions: initial.regressions,
    baselineResults: [baselineResult],
    threshold: 0.15,
    rounds: [
      [result({ p50: 118, p95: 119 })],
      [result({ p50: 120, p95: 121 })],
      [result({ p50: 122, p95: 120 })],
    ],
  });
  const comparison = applyCohortRevalidation(initial, cohort);
  assert.equal(comparison.status, 'regression-confirmed');
  assert.equal(comparison.enforceableRegressions.length, 1);
  assert.equal(comparison.enforceableRegressions[0].cohortP50, 120);
  assert.equal(shouldFailBenchmarkEnforcement({
    comparison,
    budgetViolations: [],
    metricBudgetViolations: [],
  }), true);
});

test('one noisy process round stays visible but a strict low-noise majority still decides the cohort median', () => {
  const baselineResult = result({ p50: 100, p95: 100 });
  const initial = compareBenchmarkResults({
    currentResults: [result({ p50: 120, p95: 120, relativeStddev: 0.2 })],
    currentIdentity: benchmarkIdentity(),
    baseline: cohortBaseline(benchmarkIdentity(), [baselineResult]),
    threshold: 0.15,
  });
  assert.equal(initial.regressions.length, 1);
  assert.equal(initial.lowNoiseRegressions.length, 0);

  const cohort = evaluateCohortRevalidation({
    suspectedRegressions: initial.regressions,
    baselineResults: [baselineResult],
    threshold: 0.15,
    rounds: [
      [result({ p50: 101, p95: 102, relativeStddev: 0.03 })],
      [result({ p50: 180, p95: 220, relativeStddev: 0.24 })],
      [result({ p50: 102, p95: 103, relativeStddev: 0.04 })],
    ],
  });
  const comparison = applyCohortRevalidation(initial, cohort);

  assert.equal(comparison.status, 'revalidation-cleared');
  assert.deepEqual(cohort.cases[0].stability.noisyRounds, [2]);
  assert.equal(cohort.cases[0].stability.status, 'stable-majority');
  assert.deepEqual(
    cohort.cases[0].stability.roundEvidence.map(round => round.p50),
    [101, 180, 102],
  );
  assert.equal(comparison.inconclusiveRegressions.length, 0);
  assert.equal(shouldFailBenchmarkEnforcement({
    comparison,
    budgetViolations: [],
    metricBudgetViolations: [],
  }), false);
});

test('a noisy majority makes cohort evidence inconclusive and blocks enforcement', () => {
  const stability = classifyCohortStability([
    result({ relativeStddev: 0.02 }),
    result({ relativeStddev: 0.12 }),
    result({ relativeStddev: 0.18 }),
  ]);
  assert.equal(stability.status, 'inconclusive');
  assert.deepEqual(stability.noisyRounds, [2, 3]);

  const initial = {
    status: 'regression-reported',
    regressions: [{ id: 'synthetic.case' }],
    enforceableRegressions: [],
    inconclusiveRegressions: [],
  };
  const cohort = evaluateCohortRevalidation({
    suspectedRegressions: initial.regressions,
    baselineResults: [result({ p50: 100, p95: 100 })],
    rounds: [
      [result({ p50: 120, p95: 120, relativeStddev: 0.02 })],
      [result({ p50: 119, p95: 121, relativeStddev: 0.12 })],
      [result({ p50: 121, p95: 122, relativeStddev: 0.18 })],
    ],
  });
  const comparison = applyCohortRevalidation(initial, cohort);
  assert.equal(comparison.status, 'revalidation-inconclusive');
  assert.equal(comparison.enforceableRegressions.length, 0);
  assert.equal(comparison.inconclusiveRegressions.length, 1);
  assert.equal(shouldFailBenchmarkEnforcement({
    comparison,
    budgetViolations: [],
    metricBudgetViolations: [],
  }), true);
});

test('runner mismatch makes relative comparison ineligible without reporting a false regression', () => {
  const currentIdentity = benchmarkIdentity({ runnerProfile: 'github-ubuntu-latest' });
  const baselineIdentity = benchmarkIdentity({ runnerProfile: 'apple-m4-pro-fixed' });
  const comparison = compareBenchmarkResults({
    currentResults: [result({ p50: 200, p95: 200 })],
    currentIdentity,
    baseline: cohortBaseline(baselineIdentity, [result({ p50: 100, p95: 100 })]),
  });
  assert.equal(comparison.status, 'ineligible');
  assert.ok(comparison.eligibility.reasons.includes('runnerProfile-mismatch'));
  assert.deepEqual(comparison.regressions, []);
  assert.deepEqual(comparison.enforceableRegressions, []);
});

test('relative comparison validates every required evidence identity dimension before timing deltas', () => {
  const baselineIdentity = benchmarkIdentity();
  const mutations = [
    ['node', 'v24.0.0', 'node-mismatch'],
    ['v8', '13.0.0', 'v8-mismatch'],
    ['platform', 'linux', 'platform-mismatch'],
    ['arch', 'x64', 'arch-mismatch'],
    ['cpu', 'Different CPU', 'cpu-mismatch'],
    ['runnerProfile', 'different-fixed-runner', 'runnerProfile-mismatch'],
    ['benchmarkProfile', 'full', 'benchmarkProfile-mismatch'],
    ['samples', 31, 'samples-mismatch'],
    ['iterations', 6, 'iterations-mismatch'],
    ['revision', 'invalid', 'current-revision-invalid'],
    ['dirty', true, 'current-worktree-dirty'],
  ];
  for (const [field, value, reason] of mutations) {
    const comparison = compareBenchmarkResults({
      currentResults: [result()],
      currentIdentity: { ...baselineIdentity, [field]: value },
      baseline: cohortBaseline(baselineIdentity, [result()]),
    });
    assert.equal(comparison.status, 'ineligible', field);
    assert.ok(comparison.eligibility.reasons.includes(reason), `${field}: ${comparison.eligibility.reasons.join(', ')}`);
    assert.deepEqual(comparison.regressions, []);
  }
});

test('absolute P95 budget excess is an enforce failure in every runner profile', () => {
  const violations = collectAbsoluteBudgetViolations([
    result({ p95: 10.01, budgetP95Ms: 10 }),
  ]);
  assert.equal(violations.length, 1);
  assert.equal(shouldFailBenchmarkEnforcement({
    comparison: { enforceableRegressions: [] },
    budgetViolations: violations,
    metricBudgetViolations: [],
  }), true);
});

test('structural metric excess is an enforce failure in every runner profile', () => {
  const violations = collectMetricBudgetViolations([
    result({
      metrics: { uploadCalls: 2 },
      metricBudgets: { uploadCalls: { max: 1 } },
    }),
  ]);
  assert.deepEqual(violations, [{
    id: 'synthetic.case',
    metric: 'uploadCalls',
    value: 2,
    constraint: '<=',
    budget: 1,
  }]);
  assert.equal(shouldFailBenchmarkEnforcement({
    comparison: { enforceableRegressions: [] },
    budgetViolations: [],
    metricBudgetViolations: violations,
  }), true);
});

test('dirty or unregistered baseline evidence is explicitly ineligible', () => {
  const cleanIdentity = benchmarkIdentity();
  const comparison = compareBenchmarkResults({
    currentResults: [result()],
    currentIdentity: cleanIdentity,
    baseline: cohortBaseline(
      {
        ...cleanIdentity,
        runnerProfile: 'local-unregistered',
        dirty: true,
      },
      [result()],
    ),
  });
  assert.equal(comparison.status, 'ineligible');
  assert.ok(comparison.eligibility.reasons.includes('runnerProfile-mismatch'));
  assert.ok(comparison.eligibility.reasons.includes('baseline-runner-profile-unregistered'));
  assert.ok(comparison.eligibility.reasons.includes('baseline-worktree-dirty'));
});

test('release artifact must be enforce-mode, complete, revision-bound, clean, and relatively eligible', () => {
  const identity = benchmarkIdentity({ benchmarkProfile: 'full' });
  const artifact = {
    schemaVersion: 4,
    profile: 'full',
    revision,
    dirty: false,
    identity,
    configuration: {
      benchmarkProfile: 'full',
      warmup: 8,
      samples: 30,
      iterations: 5,
      caseFilter: [],
    },
    policy: { mode: 'enforce-cohort' },
    budgetStatus: 'within-budget',
    budgetViolations: [],
    metricBudgetViolations: [],
    results: [result()],
    comparison: {
      eligibility: { status: 'eligible', reasons: [] },
      enforceableRegressions: [],
      inconclusiveRegressions: [],
    },
  };
  assert.deepEqual(validateReleaseBenchmarkArtifact(artifact, {
    revision,
    runnerProfile: identity.runnerProfile,
    benchmarkProfile: 'full',
  }), { status: 'passed', violations: [] });

  const stale = validateReleaseBenchmarkArtifact(artifact, {
    revision: 'abcdef1234567890abcdef1234567890abcdef12',
  });
  assert.equal(stale.status, 'failed');
  assert.ok(stale.violations.some(violation => violation.includes('does not match expected')));

  const filtered = validateReleaseBenchmarkArtifact({
    ...artifact,
    configuration: { ...artifact.configuration, caseFilter: ['synthetic.case'] },
  });
  assert.equal(filtered.status, 'failed');
  assert.ok(filtered.violations.some(violation => violation.includes('complete profile')));
});

test('performance job uses portable formal comparison instead of a fixed Apple CPU/GPU profile', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/ci-device-performance.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /WEBGPU_REQUIRE_NATIVE: "1"/);
  assert.match(workflow, /npm run performance:compare:test/);
  assert.match(workflow, /npm run performance:compare:formal/);
  assert.match(workflow, /artifacts\/performance-comparison\/formal\.json/);
  assert.doesNotMatch(workflow, /device-profile|WEBGPU_DEVICE_PROFILE|apple-integrated|windows-integrated|windows-discrete/);
});

test('baseline promotion retains every round and uses the per-case median instead of a single fast trough', () => {
  const rounds = [
    [result({ p50: 80, p95: 82, relativeStddev: 0.02, allocationBytesP50: 80 })],
    [result({ p50: 101, p95: 104, relativeStddev: 0.03, allocationBytesP50: 100 })],
    [result({ p50: 100, p95: 103, relativeStddev: 0.04, allocationBytesP50: 90 })],
  ];
  const [promoted] = aggregateBaselineCohortResults(rounds);

  assert.equal(promoted.p50, 100);
  assert.equal(promoted.p95, 103);
  assert.equal(promoted.allocationBytesP50, 90);
  assert.equal(promoted.baselineCohort.rounds, 3);
  assert.deepEqual(
    promoted.baselineCohort.roundEvidence.map(round => round.p50),
    [80, 101, 100],
  );
});

test('relative comparison rejects legacy single-run baseline evidence', () => {
  const identity = benchmarkIdentity();
  const comparison = compareBenchmarkResults({
    currentResults: [result()],
    currentIdentity: identity,
    baseline: { identity, results: [result()] },
  });

  assert.equal(comparison.status, 'ineligible');
  assert.ok(comparison.eligibility.reasons.includes('baseline-cohort-rounds-insufficient'));
  assert.ok(comparison.eligibility.reasons.includes('baseline-cohort-aggregation-invalid'));
  assert.ok(comparison.eligibility.reasons.includes('baseline-cohort-case-evidence-incomplete'));
});

function benchmarkIdentity(overrides = {}) {
  return {
    ...createBenchmarkIdentity({
      environment: {
        node: 'v22.15.0',
        v8: '12.4.254.21-node.24',
        platform: 'darwin',
        arch: 'arm64',
        cpu: 'Apple M4 Pro',
      },
      runnerProfile: 'apple-m4-pro-fixed',
      profile: 'ci',
      warmup: 8,
      samples: 30,
      iterations: 5,
      revision,
      dirty: false,
    }),
    ...overrides,
  };
}

function cohortBaseline(identity, results) {
  const rounds = 3;
  return {
    identity,
    baselineCohort: {
      rounds,
      aggregation: 'per-case-median-of-all-independent-process-rounds',
      outlierPolicy: 'retain-all-rounds',
      caseCoverage: 'complete-profile',
    },
    results: results.map(item => ({
      ...item,
      baselineCohort: {
        rounds,
        aggregation: 'median-of-all-independent-process-rounds',
        roundEvidence: [],
      },
    })),
  };
}

function result(overrides = {}) {
  return {
    id: 'synthetic.case',
    group: 'synthetic',
    stage: 'synthetic',
    budgetP95Ms: null,
    warmup: 8,
    samples: 30,
    iterations: 5,
    p50: 1,
    p95: 1,
    relativeStddev: 0.01,
    metrics: null,
    metricBudgets: null,
    ...overrides,
  };
}
