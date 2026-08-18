const MIN_ENFORCE_WARMUP = 8;
const MIN_ENFORCE_SAMPLES = 30;
const MIN_COHORT_ROUNDS = 3;
const LOW_NOISE_RELATIVE_STDDEV = 0.1;
const UNREGISTERED_RUNNER_PROFILE = 'local-unregistered';

export const CPU_BENCHMARK_POLICY = Object.freeze({
  minEnforceWarmup: MIN_ENFORCE_WARMUP,
  minEnforceSamples: MIN_ENFORCE_SAMPLES,
  minCohortRounds: MIN_COHORT_ROUNDS,
  lowNoiseRelativeStddev: LOW_NOISE_RELATIVE_STDDEV,
  unregisteredRunnerProfile: UNREGISTERED_RUNNER_PROFILE,
});

export function resolveBenchmarkConfiguration(options = {}) {
  const enforce = options.enforce === true;
  const profile = nonEmptyString(options.profile) ?? 'ci';
  if (!['ci', 'full'].includes(profile)) {
    throw new RangeError(`Unknown CPU benchmark profile "${profile}"; expected "ci" or "full".`);
  }
  const warmup = positiveInteger(options.warmup, enforce || profile === 'full' ? 8 : 3);
  const samples = positiveInteger(options.samples, enforce || profile === 'full' ? 30 : 12);
  const iterations = positiveInteger(options.iterations, profile === 'full' ? 10 : 5);
  const cohortRounds = positiveInteger(options.cohortRounds, MIN_COHORT_ROUNDS);
  const caseFilter = normalizeCaseFilter(options.caseFilter);

  if (enforce && warmup < MIN_ENFORCE_WARMUP) {
    throw new RangeError(`Enforced CPU benchmarks require warmup >= ${MIN_ENFORCE_WARMUP}; received ${warmup}.`);
  }
  if (enforce && samples < MIN_ENFORCE_SAMPLES) {
    throw new RangeError(`Enforced CPU benchmarks require samples >= ${MIN_ENFORCE_SAMPLES}; received ${samples}.`);
  }
  if (enforce && cohortRounds < MIN_COHORT_ROUNDS) {
    throw new RangeError(`Enforced CPU benchmarks require at least ${MIN_COHORT_ROUNDS} cohort rounds; received ${cohortRounds}.`);
  }

  return {
    enforce,
    profile,
    warmup,
    samples,
    iterations,
    cohortRounds,
    caseFilter,
  };
}

export function createBenchmarkIdentity({
  environment,
  runnerProfile,
  profile,
  warmup,
  samples,
  iterations,
  revision,
  dirty,
}) {
  return {
    node: environment?.node ?? null,
    v8: environment?.v8 ?? null,
    platform: environment?.platform ?? null,
    arch: environment?.arch ?? null,
    cpu: environment?.cpu ?? null,
    runnerProfile: normalizeRunnerProfile(runnerProfile),
    benchmarkProfile: profile ?? null,
    warmup: finiteInteger(warmup),
    samples: finiteInteger(samples),
    iterations: finiteInteger(iterations),
    revision: revision ?? null,
    dirty: typeof dirty === 'boolean' ? dirty : null,
  };
}

export function extractBenchmarkIdentity(report) {
  if (!report) return null;
  if (report.identity) return { ...report.identity };
  const results = Array.isArray(report.results) ? report.results : [];
  return createBenchmarkIdentity({
    environment: report.environment,
    runnerProfile: report.runnerProfile,
    profile: report.profile,
    warmup: commonInteger(results, 'warmup'),
    samples: commonInteger(results, 'samples'),
    iterations: report.configuration?.iterations,
    revision: report.revision,
    dirty: report.dirty,
  });
}

export function compareBenchmarkResults({
  currentResults,
  currentIdentity,
  baseline,
  threshold = 0.15,
}) {
  const previous = Array.isArray(baseline?.results) ? baseline.results : [];
  const baselineIdentity = extractBenchmarkIdentity(baseline);
  const eligibility = assessRelativeComparisonEligibility({
    currentIdentity,
    baselineIdentity,
    baselineCohort: baseline?.baselineCohort,
    currentResults,
    baselineResults: previous,
  });
  const previousById = new Map(previous.map(result => [result.id, result]));
  const compared = [];

  for (const result of currentResults) {
    const baselineResult = previousById.get(result.id);
    if (!hasTimingResult(baselineResult)) continue;
    compared.push({
      id: result.id,
      p50Delta: relativeDelta(result.p50, baselineResult.p50),
      p95Delta: relativeDelta(result.p95, baselineResult.p95),
      currentRelativeStddev: result.relativeStddev,
      baselineRelativeStddev: baselineResult.relativeStddev,
      lowNoise: isLowNoise(result) && isLowNoise(baselineResult),
    });
  }

  if (eligibility.status !== 'eligible') {
    return {
      status: 'ineligible',
      eligibility,
      compared,
      regressions: [],
      lowNoiseRegressions: [],
      enforceableRegressions: [],
      inconclusiveRegressions: [],
      cohortRevalidation: null,
    };
  }

  const regressions = compared.filter(item => item.p50Delta > threshold || item.p95Delta > threshold);
  const lowNoiseRegressions = regressions.filter(item => item.lowNoise);
  return {
    status: regressions.length > 0 ? 'regression-reported' : 'within-threshold',
    eligibility,
    compared,
    regressions,
    lowNoiseRegressions,
    enforceableRegressions: [],
    inconclusiveRegressions: [],
    cohortRevalidation: null,
  };
}

/**
 * A cohort remains usable when a strict majority of its independent process
 * rounds is low-noise. No round is dropped from the median: noisy rounds stay
 * visible in the evidence, while a noisy majority makes the decision
 * inconclusive and therefore non-releasable.
 */
export function classifyCohortStability(roundResults) {
  if (!Array.isArray(roundResults) || roundResults.length < MIN_COHORT_ROUNDS) {
    throw new RangeError(`CPU benchmark cohort stability requires at least ${MIN_COHORT_ROUNDS} independent rounds.`);
  }
  const roundEvidence = roundResults.map((result, index) => ({
    round: index + 1,
    p50: result?.p50 ?? null,
    p95: result?.p95 ?? null,
    relativeStddev: result?.relativeStddev ?? null,
    lowNoise: isLowNoise(result),
  }));
  const noisyRounds = roundEvidence.filter(round => !round.lowNoise);
  const maxNoisyRounds = Math.floor((roundEvidence.length - 1) / 2);
  return {
    status: noisyRounds.length <= maxNoisyRounds ? 'stable-majority' : 'inconclusive',
    lowNoiseThreshold: LOW_NOISE_RELATIVE_STDDEV,
    maxNoisyRounds,
    noisyRounds: noisyRounds.map(round => round.round),
    roundEvidence,
  };
}

export function evaluateCohortRevalidation({
  suspectedRegressions,
  rounds,
  baselineResults,
  threshold = 0.15,
}) {
  if (!Array.isArray(rounds) || rounds.length < MIN_COHORT_ROUNDS) {
    throw new RangeError(`CPU benchmark cohort revalidation requires at least ${MIN_COHORT_ROUNDS} independent rounds.`);
  }
  const baselineById = new Map(baselineResults.map(result => [result.id, result]));
  const cases = [];

  for (const suspected of suspectedRegressions) {
    const baseline = baselineById.get(suspected.id);
    const roundResults = rounds.map(round => round.find(result => result.id === suspected.id));
    if (!hasTimingResult(baseline) || roundResults.some(result => !hasTimingResult(result))) {
      throw new Error(`Cohort revalidation omitted benchmark case "${suspected.id}".`);
    }
    const stability = classifyCohortStability(roundResults);
    const cohortP50 = median(roundResults.map(result => result.p50));
    const cohortP95 = median(roundResults.map(result => result.p95));
    const p50Delta = relativeDelta(cohortP50, baseline.p50);
    const p95Delta = relativeDelta(cohortP95, baseline.p95);
    const exceedsThreshold = p50Delta > threshold || p95Delta > threshold;
    cases.push({
      id: suspected.id,
      rounds: roundResults.length,
      cohortP50,
      cohortP95,
      baselineP50: baseline.p50,
      baselineP95: baseline.p95,
      p50Delta,
      p95Delta,
      stability,
      confirmed: stability.status === 'stable-majority' && exceedsThreshold,
      inconclusive: stability.status === 'inconclusive',
    });
  }

  return {
    rounds: rounds.length,
    aggregation: 'median-of-independent-process-rounds',
    cases,
    confirmedRegressions: cases.filter(item => item.confirmed),
    inconclusiveRegressions: cases.filter(item => item.inconclusive),
  };
}

export function applyCohortRevalidation(comparison, cohortRevalidation) {
  const enforceableRegressions = cohortRevalidation.confirmedRegressions;
  const inconclusiveRegressions = cohortRevalidation.inconclusiveRegressions;
  return {
    ...comparison,
    status: enforceableRegressions.length > 0
      ? 'regression-confirmed'
      : inconclusiveRegressions.length > 0
        ? 'revalidation-inconclusive'
        : comparison.regressions.length > 0
          ? 'revalidation-cleared'
          : comparison.status,
    enforceableRegressions,
    inconclusiveRegressions,
    cohortRevalidation,
  };
}

/**
 * A release baseline is promoted from complete, independent process rounds.
 * Every round remains visible; the per-case median prevents one unusually fast
 * or slow process from becoming the long-lived comparison target.
 */
export function aggregateBaselineCohortResults(rounds) {
  if (!Array.isArray(rounds) || rounds.length < MIN_COHORT_ROUNDS) {
    throw new RangeError(`CPU benchmark baseline promotion requires at least ${MIN_COHORT_ROUNDS} independent full rounds.`);
  }
  const firstRound = rounds[0];
  if (!Array.isArray(firstRound) || firstRound.length === 0) {
    throw new Error('CPU benchmark baseline promotion requires non-empty benchmark rounds.');
  }
  const expectedIds = firstRound.map(result => result.id);
  const expectedIdSet = new Set(expectedIds);
  if (expectedIdSet.size !== expectedIds.length) {
    throw new Error('CPU benchmark baseline promotion received duplicate case ids.');
  }
  for (let round = 0; round < rounds.length; round++) {
    const results = rounds[round];
    if (!Array.isArray(results)
      || results.length !== expectedIds.length
      || results.some(result => !expectedIdSet.has(result.id))) {
      throw new Error(`CPU benchmark baseline round ${round + 1} has incompatible case coverage.`);
    }
  }

  return expectedIds.map(id => {
    const evidence = rounds.map(results => results.find(result => result.id === id));
    const template = evidence[0];
    if (evidence.some(result => !hasTimingResult(result))) {
      throw new Error(`CPU benchmark baseline round omitted timing evidence for "${id}".`);
    }
    for (const result of evidence.slice(1)) {
      for (const key of ['warmup', 'samples', 'iterations', 'budgetP95Ms', 'unit', 'lowerIsBetter']) {
        if (result[key] !== template[key]) {
          throw new Error(`CPU benchmark baseline case "${id}" changed ${key} between rounds.`);
        }
      }
    }
    const roundEvidence = evidence.map((result, index) => ({
      round: index + 1,
      p50: result.p50,
      p95: result.p95,
      relativeStddev: result.relativeStddev,
      allocationBytesP50: result.allocationBytesP50,
    }));
    return {
      ...template,
      p50: median(evidence.map(result => result.p50)),
      p95: median(evidence.map(result => result.p95)),
      mean: median(evidence.map(result => result.mean)),
      stddev: median(evidence.map(result => result.stddev)),
      relativeStddev: median(evidence.map(result => result.relativeStddev)),
      min: median(evidence.map(result => result.min)),
      max: median(evidence.map(result => result.max)),
      allocationBytesP50: median(evidence.map(result => result.allocationBytesP50)),
      baselineCohort: {
        rounds: evidence.length,
        aggregation: 'median-of-all-independent-process-rounds',
        roundEvidence,
      },
    };
  });
}

export function collectAbsoluteBudgetViolations(results) {
  return results
    .filter(result => result.budgetP95Ms !== null && result.p95 > result.budgetP95Ms)
    .map(result => ({
      id: result.id,
      stage: result.stage,
      p95: result.p95,
      budgetP95Ms: result.budgetP95Ms,
    }));
}

export function collectMetricBudgetViolations(results) {
  const violations = [];
  for (const result of results) {
    if (!result.metrics || !result.metricBudgets) continue;
    for (const [metric, budget] of Object.entries(result.metricBudgets)) {
      const value = result.metrics[metric];
      if (!Number.isFinite(value)) {
        violations.push({ id: result.id, metric, value, constraint: 'finite', budget: 1 });
        continue;
      }
      if (Number.isFinite(budget.max) && value > budget.max) {
        violations.push({ id: result.id, metric, value, constraint: '<=', budget: budget.max });
      }
      if (Number.isFinite(budget.min) && value < budget.min) {
        violations.push({ id: result.id, metric, value, constraint: '>=', budget: budget.min });
      }
    }
  }
  return violations;
}

export function shouldFailBenchmarkEnforcement({
  comparison,
  budgetViolations,
  metricBudgetViolations,
}) {
  return (comparison?.enforceableRegressions?.length ?? 0) > 0
    || (comparison?.inconclusiveRegressions?.length ?? 0) > 0
    || budgetViolations.length > 0
    || metricBudgetViolations.length > 0;
}

export function validateReleaseBenchmarkArtifact(report, expected = {}) {
  const violations = [];
  const identity = extractBenchmarkIdentity(report);
  if (!report || report.schemaVersion !== 4) violations.push('CPU benchmark artifact schemaVersion must be 4');
  if (!identity) {
    violations.push('CPU benchmark artifact identity is missing');
    return { status: 'failed', violations };
  }

  validateIdentityValue(violations, identity, 'node');
  validateIdentityValue(violations, identity, 'v8');
  validateIdentityValue(violations, identity, 'platform');
  validateIdentityValue(violations, identity, 'arch');
  validateIdentityValue(violations, identity, 'cpu');
  validateIdentityValue(violations, identity, 'runnerProfile');
  validateIdentityValue(violations, identity, 'benchmarkProfile');
  if (!validRevision(identity.revision)) violations.push('CPU benchmark revision is missing or invalid');
  if (identity.dirty !== false) violations.push('CPU benchmark artifact was measured from a dirty worktree');
  if (!isRegisteredRunnerProfile(identity.runnerProfile)) violations.push('CPU benchmark runner profile is not fixed/registered');
  if (identity.warmup < MIN_ENFORCE_WARMUP) violations.push(`CPU benchmark warmup must be >= ${MIN_ENFORCE_WARMUP}`);
  if (identity.samples < MIN_ENFORCE_SAMPLES) violations.push(`CPU benchmark samples must be >= ${MIN_ENFORCE_SAMPLES}`);
  if (!Number.isInteger(identity.iterations) || identity.iterations < 1) violations.push('CPU benchmark iterations are invalid');

  for (const key of ['revision', 'runnerProfile', 'benchmarkProfile', 'node', 'v8', 'platform', 'arch', 'cpu']) {
    if (expected[key] !== undefined && identity[key] !== expected[key]) {
      violations.push(`CPU benchmark ${key} "${identity[key]}" does not match expected "${expected[key]}"`);
    }
  }
  if (report.revision !== identity.revision || report.dirty !== identity.dirty) {
    violations.push('CPU benchmark root revision/dirty fields do not match its identity');
  }
  if (report.profile !== identity.benchmarkProfile
    || report.configuration?.benchmarkProfile !== identity.benchmarkProfile) {
    violations.push('CPU benchmark profile fields do not match its identity');
  }
  for (const key of ['warmup', 'samples', 'iterations']) {
    if (report.configuration?.[key] !== identity[key]) {
      violations.push(`CPU benchmark configuration ${key} does not match its identity`);
    }
  }
  if (report.policy?.mode !== 'enforce-cohort') violations.push('CPU benchmark artifact was not produced in cohort-enforce mode');
  if ((report.configuration?.caseFilter?.length ?? 0) !== 0) violations.push('Release CPU benchmark artifact must contain the complete profile, not a case filter');
  if (!Array.isArray(report.results) || report.results.length === 0) {
    violations.push('CPU benchmark artifact contains no benchmark results');
  } else {
    for (const result of report.results) {
      if (result.warmup !== identity.warmup || result.samples !== identity.samples) {
        violations.push(`CPU benchmark result ${result.id ?? '(unknown)'} sampling does not match its identity`);
      }
      if (!Number.isInteger(result.iterations) || result.iterations < 1) {
        violations.push(`CPU benchmark result ${result.id ?? '(unknown)'} iterations are invalid`);
      }
    }
  }
  if (report.budgetStatus !== 'within-budget') violations.push('CPU benchmark absolute or metric budgets were exceeded');
  if ((report.budgetViolations?.length ?? 0) > 0) violations.push('CPU benchmark artifact contains absolute budget violations');
  if ((report.metricBudgetViolations?.length ?? 0) > 0) violations.push('CPU benchmark artifact contains metric budget violations');
  if (report.comparison?.eligibility?.status !== 'eligible') {
    violations.push('CPU benchmark relative comparison is ineligible for release');
  }
  if ((report.comparison?.enforceableRegressions?.length ?? 0) > 0) {
    violations.push('CPU benchmark artifact contains confirmed relative regressions');
  }
  if ((report.comparison?.inconclusiveRegressions?.length ?? 0) > 0) {
    violations.push('CPU benchmark artifact contains inconclusive relative regressions');
  }

  return { status: violations.length === 0 ? 'passed' : 'failed', violations };
}

export function validateCandidateCpuBenchmarkArtifact(report, expected = {}) {
  const violations = [];
  const identity = extractBenchmarkIdentity(report);
  if (!report || report.schemaVersion !== 4) violations.push('CPU candidate schemaVersion must be 4');
  if (!identity) {
    violations.push('CPU candidate identity is missing');
    return { status: 'failed', violations, summary: null };
  }
  if (report.profile !== 'full' || identity.benchmarkProfile !== 'full') {
    violations.push('CPU candidate must use the complete full profile');
  }
  if ((report.configuration?.caseFilter?.length ?? -1) !== 0) {
    violations.push('CPU candidate must not filter benchmark cases');
  }
  const nodeMajor = Number.parseInt(identity.node?.slice(1), 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    violations.push(`CPU candidate requires Node.js >=22; received ${identity.node}`);
  }
  if (identity.platform !== 'darwin' || identity.arch !== 'arm64' || identity.cpu !== 'Apple M4 Pro') {
    violations.push('CPU candidate requires the registered Apple M4 Pro darwin/arm64 runner');
  }
  if (identity.runnerProfile !== expected.runnerProfile) {
    violations.push(`CPU candidate runner ${identity.runnerProfile} does not match ${expected.runnerProfile}`);
  }
  if (identity.revision !== expected.revision || report.revision !== expected.revision) {
    violations.push(`CPU candidate revision does not match expected ${expected.revision}`);
  }
  if (identity.dirty !== false || report.dirty !== false) {
    violations.push('CPU candidate was measured from a dirty worktree');
  }
  if (identity.warmup < MIN_ENFORCE_WARMUP || identity.samples < MIN_ENFORCE_SAMPLES) {
    violations.push('CPU candidate warmup/sample configuration is below the enforce minimum');
  }
  if (report.policy?.mode !== 'enforce-cohort') violations.push('CPU candidate must use enforce-cohort mode');
  if (report.budgetStatus !== 'within-budget'
    || (report.budgetViolations?.length ?? 1) !== 0
    || (report.metricBudgetViolations?.length ?? 1) !== 0) {
    violations.push('CPU candidate has absolute or structural metric budget violations');
  }
  const cohort = report.baselineCohort;
  if (cohort?.rounds < MIN_COHORT_ROUNDS
    || cohort?.aggregation !== 'per-case-median-of-all-independent-process-rounds'
    || cohort?.outlierPolicy !== 'retain-all-rounds'
    || cohort?.caseCoverage !== 'complete-profile') {
    violations.push('CPU candidate must retain at least three complete independent rounds');
  }
  if (!Array.isArray(report.results) || report.results.length === 0) {
    violations.push('CPU candidate has no benchmark cases');
  } else {
    const expectedCaseIds = expected.caseIds;
    const actualCaseIds = report.results.map(result => result.id);
    if (!Array.isArray(expectedCaseIds) || expectedCaseIds.length === 0) {
      violations.push('CPU candidate validator has no authoritative full-profile case set');
    } else if (actualCaseIds.length !== expectedCaseIds.length
      || new Set(actualCaseIds).size !== expectedCaseIds.length
      || expectedCaseIds.some(id => !actualCaseIds.includes(id))) {
      violations.push(
        `CPU candidate full-profile coverage is incomplete: expected ${expectedCaseIds.length}, received ${actualCaseIds.length}`,
      );
    }
    for (const result of report.results) {
      if (result.baselineCohort?.rounds < MIN_COHORT_ROUNDS
        || result.baselineCohort?.rounds !== cohort?.rounds
        || result.baselineCohort?.roundEvidence?.length !== cohort?.rounds) {
        violations.push(`CPU candidate case ${result.id} has incomplete cohort evidence`);
      }
      for (const round of result.baselineCohort?.roundEvidence ?? []) {
        if (!Number.isInteger(round?.round)
          || !Number.isFinite(round?.p50)
          || !Number.isFinite(round?.p95)
          || !Number.isFinite(round?.relativeStddev)
          || !Number.isFinite(round?.allocationBytesP50)) {
          violations.push(`CPU candidate case ${result.id} has incomplete retained round evidence`);
          break;
        }
      }
      if (!Number.isFinite(result.p50) || !Number.isFinite(result.p95)
        || !Number.isFinite(result.relativeStddev)
        || !Number.isFinite(result.allocationBytesP50)) {
        violations.push(`CPU candidate case ${result.id} has incomplete timing/allocation evidence`);
      }
    }
  }
  return {
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    summary: {
      identity,
      configuration: report.configuration,
      cohort: report.baselineCohort,
      cases: (report.results ?? []).map(result => ({
        id: result.id,
        p50: result.p50,
        p95: result.p95,
        relativeStddev: result.relativeStddev,
        allocationBytesP50: result.allocationBytesP50,
        metrics: result.metrics ?? null,
      })),
    },
  };
}

export function matchesCaseFilter(id, filters) {
  if (filters.length === 0) return true;
  return filters.some(filter => globToRegExp(filter).test(id));
}

/**
 * A complete full-profile cohort includes the 48-case planar matrix, whose
 * runtime grows with the enrolled case set. Keep filtered revalidation bounded
 * at 30 minutes. A clean 95-case Apple M4 Pro / Node 24 full round observed by
 * G07 took about 130 minutes, so complete/full cohorts receive two minutes per
 * case. This changes only process supervision headroom; warmup, samples,
 * iterations, case coverage, budgets, and the three-round requirement remain
 * unchanged.
 */
export function resolveIndependentCohortTimeoutMs(profile, caseCount) {
  if (!Number.isInteger(caseCount) || caseCount < 1) {
    throw new RangeError('CPU benchmark cohort caseCount must be a positive integer.');
  }
  const minimumTimeoutMs = 30 * 60_000;
  return profile === 'full'
    ? Math.max(minimumTimeoutMs, caseCount * 2 * 60_000)
    : minimumTimeoutMs;
}

function assessRelativeComparisonEligibility({
  currentIdentity,
  baselineIdentity,
  baselineCohort,
  currentResults,
  baselineResults,
}) {
  const reasons = [];
  if (!baselineIdentity || baselineResults.length === 0) {
    reasons.push('baseline-missing');
    return { status: 'ineligible', reasons };
  }
  if (!baselineCohort || baselineCohort.rounds < MIN_COHORT_ROUNDS) {
    reasons.push('baseline-cohort-rounds-insufficient');
  }
  if (baselineCohort?.aggregation !== 'per-case-median-of-all-independent-process-rounds') {
    reasons.push('baseline-cohort-aggregation-invalid');
  }
  if (baselineResults.some(result => !result.baselineCohort
    || result.baselineCohort.rounds !== baselineCohort?.rounds)) {
    reasons.push('baseline-cohort-case-evidence-incomplete');
  }
  for (const key of ['node', 'v8', 'platform', 'arch', 'cpu', 'runnerProfile', 'benchmarkProfile']) {
    if (!nonEmptyString(currentIdentity?.[key])) reasons.push(`current-${key}-missing`);
    if (!nonEmptyString(baselineIdentity[key])) reasons.push(`baseline-${key}-missing`);
    if (currentIdentity?.[key] !== baselineIdentity[key]) reasons.push(`${key}-mismatch`);
  }
  if (!isRegisteredRunnerProfile(currentIdentity?.runnerProfile)) reasons.push('current-runner-profile-unregistered');
  if (!isRegisteredRunnerProfile(baselineIdentity.runnerProfile)) reasons.push('baseline-runner-profile-unregistered');
  if (!validRevision(currentIdentity?.revision)) reasons.push('current-revision-invalid');
  if (!validRevision(baselineIdentity.revision)) reasons.push('baseline-revision-invalid');
  if (currentIdentity?.dirty !== false) reasons.push('current-worktree-dirty');
  if (baselineIdentity.dirty !== false) reasons.push('baseline-worktree-dirty');
  for (const key of ['warmup', 'samples', 'iterations']) {
    if (!Number.isInteger(currentIdentity?.[key])) reasons.push(`current-${key}-invalid`);
    if (!Number.isInteger(baselineIdentity[key])) reasons.push(`baseline-${key}-invalid`);
    if (currentIdentity?.[key] !== baselineIdentity[key]) reasons.push(`${key}-mismatch`);
  }

  const baselineById = new Map(baselineResults.map(result => [result.id, result]));
  for (const result of currentResults) {
    const baseline = baselineById.get(result.id);
    if (!baseline) {
      reasons.push(`${result.id}:baseline-case-missing`);
      continue;
    }
    for (const key of ['warmup', 'samples', 'iterations']) {
      if (result[key] !== baseline[key]) reasons.push(`${result.id}:${key}-mismatch`);
    }
  }

  return {
    status: reasons.length === 0 ? 'eligible' : 'ineligible',
    reasons: [...new Set(reasons)],
  };
}

function normalizeCaseFilter(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .flatMap(item => String(item).split(','))
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeRunnerProfile(value) {
  return nonEmptyString(value) ?? UNREGISTERED_RUNNER_PROFILE;
}

function isRegisteredRunnerProfile(value) {
  return Boolean(nonEmptyString(value)) && value !== UNREGISTERED_RUNNER_PROFILE;
}

function hasTimingResult(result) {
  return result && Number.isFinite(result.p50) && Number.isFinite(result.p95);
}

function isLowNoise(result) {
  return Number.isFinite(result.relativeStddev) && result.relativeStddev <= LOW_NOISE_RELATIVE_STDDEV;
}

function relativeDelta(current, baseline) {
  return baseline === 0 ? 0 : (current - baseline) / baseline;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`);
}

function commonInteger(items, key) {
  const values = [...new Set(items.map(item => item?.[key]).filter(Number.isInteger))];
  return values.length === 1 ? values[0] : null;
}

function finiteInteger(value) {
  return Number.isInteger(Number(value)) ? Number(value) : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validRevision(value) {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value);
}

function validateIdentityValue(violations, identity, key) {
  if (!nonEmptyString(identity[key])) violations.push(`CPU benchmark ${key} is missing`);
}
