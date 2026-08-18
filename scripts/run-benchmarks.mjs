import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, freemem, tmpdir, totalmem } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runStatisticalBenchmarks } from './benchmark/harness.mjs';
import {
  aggregateBaselineCohortResults,
  applyCohortRevalidation,
  collectAbsoluteBudgetViolations,
  collectMetricBudgetViolations,
  compareBenchmarkResults,
  createBenchmarkIdentity,
  evaluateCohortRevalidation,
  matchesCaseFilter,
  resolveIndependentCohortTimeoutMs,
  resolveBenchmarkConfiguration,
  shouldFailBenchmarkEnforcement,
} from './benchmark/cpu-benchmark-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await main();

async function main() {
  const cli = parseArguments(process.argv.slice(2));
  const configuration = resolveBenchmarkConfiguration({
    enforce: cli.enforce || process.env.BENCHMARK_ENFORCE === '1',
    profile: cli.profile ?? process.env.BENCHMARK_PROFILE,
    warmup: cli.warmup ?? process.env.BENCHMARK_WARMUP,
    samples: cli.samples ?? process.env.BENCHMARK_SAMPLES,
    iterations: cli.iterations ?? process.env.BENCHMARK_ITERATIONS,
    cohortRounds: cli.cohortRounds ?? process.env.BENCHMARK_COHORT_ROUNDS,
    caseFilter: cli.caseFilter.length > 0 ? cli.caseFilter : process.env.BENCHMARK_CASE_FILTER,
  });
  const output = resolve(root, cli.output ?? process.env.BENCHMARK_OUTPUT ?? 'artifacts/benchmarks/haiyue-benchmark-v3.json');
  const baselinePath = resolve(root, cli.baseline ?? process.env.BENCHMARK_BASELINE ?? 'review/baselines/benchmark-stage9.json');
  const runnerProfile = cli.runnerProfile ?? process.env.CPU_BENCHMARK_RUNNER_PROFILE;
  const threshold = Number(cli.threshold ?? process.env.BENCHMARK_REGRESSION_THRESHOLD ?? 0.15);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError(`CPU benchmark regression threshold must be a finite non-negative number; received ${threshold}.`);
  }
  const writingBaseline = output === baselinePath;
  if (writingBaseline) {
    assertBaselinePromotionContext({
      configuration,
      identity: createBenchmarkIdentity({
        environment: environmentFingerprint(),
        runnerProfile,
        profile: configuration.profile,
        warmup: configuration.warmup,
        samples: configuration.samples,
        iterations: configuration.iterations,
        revision: gitRevision(),
        dirty: gitDirty(),
      }),
    });
  }

  if (!cli.cohortWorker) {
    buildWorkspace('engine');
    buildWorkspace('extensions');
    buildWorkspace('extensions', 'rollup.worker.config.js');
    buildEditorTesting();
  }

  const { createBenchmarkCases } = await import('./benchmark/suite.mjs');
  const cases = createBenchmarkCases(configuration.profile)
    .filter(benchmark => matchesCaseFilter(benchmark.id, configuration.caseFilter));
  if (cases.length === 0) {
    throw new Error(`CPU benchmark case filter matched no cases: ${configuration.caseFilter.join(', ') || '(empty)'}.`);
  }
  let results = await runStatisticalBenchmarks(cases, configuration);

  if (cli.cohortWorker) {
    if (!cli.cohortOutput) throw new Error('--cohort-worker requires --cohort-output <path>.');
    const cohortOutput = resolve(cli.cohortOutput);
    mkdirSync(dirname(cohortOutput), { recursive: true });
    writeFileSync(cohortOutput, `${JSON.stringify({ results }, null, 2)}\n`);
    return;
  }

  const revision = gitRevision();
  const dirty = gitDirty();
  const environment = environmentFingerprint();
  const identity = createBenchmarkIdentity({
    environment,
    runnerProfile,
    profile: configuration.profile,
    warmup: configuration.warmup,
    samples: configuration.samples,
    iterations: configuration.iterations,
    revision,
    dirty,
  });
  let baselineCohort = null;
  if (writingBaseline) {
    assertBaselinePromotionContext({ configuration, identity });
    const additionalRounds = runIndependentCohortRounds({
      configuration,
      runnerProfile: identity.runnerProfile,
      caseIds: cases.map(item => item.id),
      roundCount: configuration.cohortRounds - 1,
      message: 'Collecting complete baseline cohort',
    });
    const allRounds = [results, ...additionalRounds];
    results = aggregateBaselineCohortResults(allRounds);
    baselineCohort = {
      rounds: allRounds.length,
      aggregation: 'per-case-median-of-all-independent-process-rounds',
      outlierPolicy: 'retain-all-rounds',
      caseCoverage: 'complete-profile',
    };
  }
  const baseline = writingBaseline ? null : readBaseline(baselinePath);
  let comparison = compareBenchmarkResults({
    currentResults: results,
    currentIdentity: identity,
    baseline,
    threshold,
  });
  if (configuration.enforce && comparison.regressions.length > 0) {
    const rounds = runIndependentCohortRounds({
      configuration,
      runnerProfile: identity.runnerProfile,
      caseIds: comparison.regressions.map(item => item.id),
    });
    comparison = applyCohortRevalidation(comparison, evaluateCohortRevalidation({
      suspectedRegressions: comparison.regressions,
      rounds,
      baselineResults: baseline.results,
      threshold,
    }));
  }

  const budgetViolations = collectAbsoluteBudgetViolations(results);
  const metricBudgetViolations = collectMetricBudgetViolations(results);
  const report = {
    schemaVersion: 4,
    suiteVersion: 'stage9-follow-up-v3',
    generatedAt: new Date().toISOString(),
    profile: configuration.profile,
    revision,
    dirty,
    environment,
    identity,
    configuration: {
      benchmarkProfile: configuration.profile,
      warmup: configuration.warmup,
      samples: configuration.samples,
      iterations: configuration.iterations,
      caseFilter: configuration.caseFilter,
      cohortRounds: configuration.cohortRounds,
    },
    policy: {
      mode: configuration.enforce ? 'enforce-cohort' : 'report-only',
      relativeRegressionThreshold: threshold,
      lowNoiseRelativeStddev: 0.1,
      relativeComparison: 'identical-clean-runner-evidence-only',
      cohortDecision: 'all-eligible-regressions;median-of-all-rounds;strict-low-noise-majority',
      baselinePromotion: 'complete-full-profile;minimum-three-independent-process-rounds;median-of-all-rounds',
      gpuMetrics: {
        synchronizationControlPath: 'ci-mock-device',
        deviceTiming: 'fixed-environment-only',
      },
      allocationMetrics: {
        heapUsedDelta: 'coarse-signal-only',
        steadyStateGate: 'deterministic-pool-miss-and-hot-object-created',
        periodicEvidence: 'chrome-v8-allocation-sampling',
      },
      baseline: !writingBaseline && existsSync(baselinePath) ? relative(root, baselinePath) : null,
    },
    results,
    baselineCohort,
    comparison,
    budgetStatus: budgetViolations.length === 0 && metricBudgetViolations.length === 0 ? 'within-budget' : 'budget-exceeded',
    budgetViolations,
    metricBudgetViolations,
    externalBaselines: {
      gltfFirstVisibleFrame: readExternalBaseline('artifacts/webgpu/gltf-asset-first-frame.json'),
      realRendererFrame: readExternalRendererBenchmark('artifacts/webgpu/real-renderer-benchmark.json'),
    },
  };

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report, output);

  if (configuration.enforce && shouldFailBenchmarkEnforcement({
    comparison,
    budgetViolations,
    metricBudgetViolations,
  })) {
    process.exitCode = 1;
  }
}

function buildWorkspace(workspace, config = null) {
  const args = [resolve(root, 'scripts/build-rollup-once.mjs')];
  if (config) args.push(config);
  const result = spawnSync(process.execPath, args, {
    cwd: resolve(root, workspace),
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function buildEditorTesting() {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/build-rollup-once.mjs'), 'rollup.test.config.js'], {
    cwd: resolve(root, 'editor'),
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runIndependentCohortRounds({
  configuration,
  runnerProfile,
  caseIds,
  roundCount = configuration.cohortRounds,
  message = 'Revalidating',
}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'haiyue-cpu-benchmark-cohort-'));
  const rounds = [];
  const timeoutMs = resolveIndependentCohortTimeoutMs(configuration.profile, caseIds.length);
  try {
    for (let round = 0; round < roundCount; round++) {
      const output = resolve(directory, `round-${round + 1}.json`);
      const args = [
        fileURLToPath(import.meta.url),
        '--cohort-worker',
        '--cohort-output', output,
        '--enforce',
        '--profile', configuration.profile,
        '--warmup', String(configuration.warmup),
        '--samples', String(configuration.samples),
        '--iterations', String(configuration.iterations),
        '--cohort-rounds', String(configuration.cohortRounds),
        '--runner-profile', runnerProfile,
      ];
      for (const id of caseIds) args.push('--case', id);
      console.log(
        `[benchmark] ${message} ${caseIds.length} case(s), independent process `
        + `${round + 1}/${roundCount}; timeout=${Math.ceil(timeoutMs / 60_000)}m.`,
      );
      const result = spawnSync(process.execPath, args, {
        cwd: root,
        stdio: 'inherit',
        timeout: timeoutMs,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`CPU benchmark cohort process ${round + 1} failed with exit code ${result.status}.`);
      }
      rounds.push(JSON.parse(readFileSync(output, 'utf8')).results);
    }
    return rounds;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertBaselinePromotionContext({ configuration, identity }) {
  if (!configuration.enforce) {
    throw new Error('CPU benchmark baseline promotion requires --enforce.');
  }
  if (configuration.profile !== 'full') {
    throw new Error('CPU benchmark baseline promotion requires --profile full.');
  }
  if (configuration.caseFilter.length > 0) {
    throw new Error('CPU benchmark baseline promotion requires the complete profile without --case filters.');
  }
  if (identity.runnerProfile === 'local-unregistered') {
    throw new Error('CPU benchmark baseline promotion requires a registered --runner-profile.');
  }
  if (identity.runnerProfile !== 'apple-m4-pro-fixed') {
    throw new Error('The formal CPU benchmark baseline must use --runner-profile apple-m4-pro-fixed.');
  }
  const nodeMajor = Number.parseInt(identity.node?.slice(1), 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    throw new Error(`CPU benchmark baseline promotion requires Node.js >=22; received ${identity.node}.`);
  }
  if (identity.platform !== 'darwin' || identity.arch !== 'arm64' || identity.cpu !== 'Apple M4 Pro') {
    throw new Error(
      'The apple-m4-pro-fixed baseline runner must report darwin/arm64 with CPU "Apple M4 Pro".',
    );
  }
  if (identity.dirty !== false) {
    throw new Error('CPU benchmark baseline promotion requires a clean worktree.');
  }
}

function printReport(report, output) {
  for (const result of report.results) {
    console.log(`[benchmark] ${result.id}: P50 ${result.p50.toFixed(3)}ms, P95 ${result.p95.toFixed(3)}ms, RSD ${(result.relativeStddev * 100).toFixed(1)}%, alloc P50 ${Math.round(result.allocationBytesP50)}B`);
  }
  if (report.comparison.eligibility.status === 'ineligible') {
    const reasons = report.comparison.eligibility.reasons;
    const visibleReasons = reasons.slice(0, 12);
    const omitted = reasons.length - visibleReasons.length;
    console.warn(
      `[benchmark] Relative comparison ineligible: ${visibleReasons.join(', ')}`
      + `${omitted > 0 ? ` (+${omitted} more in artifact)` : ''}.`,
    );
  }
  for (const regression of report.comparison.regressions) {
    console.warn(`[benchmark] regression ${regression.id}: P50 ${percent(regression.p50Delta)}, P95 ${percent(regression.p95Delta)}`);
  }
  for (const regression of report.comparison.enforceableRegressions) {
    console.warn(`[benchmark] confirmed cohort regression ${regression.id}: P50 ${percent(regression.p50Delta)}, P95 ${percent(regression.p95Delta)}`);
  }
  for (const regression of report.comparison.inconclusiveRegressions) {
    console.warn(`[benchmark] inconclusive cohort ${regression.id}: noisy rounds ${regression.stability.noisyRounds.join(', ')}/${regression.rounds}`);
  }
  for (const violation of report.budgetViolations) {
    console.warn(`[benchmark] budget ${violation.id} (${violation.stage}): P95 ${violation.p95.toFixed(3)}ms > ${violation.budgetP95Ms.toFixed(3)}ms`);
  }
  for (const violation of report.metricBudgetViolations) {
    console.warn(`[benchmark] metric budget ${violation.id}.${violation.metric}: ${violation.value} outside ${violation.constraint} ${violation.budget}`);
  }
  console.log(`[benchmark] Wrote ${relative(root, output)} (${report.comparison.status}).`);
}

function parseArguments(argv) {
  const parsed = {
    enforce: false,
    cohortWorker: false,
    cohortOutput: null,
    profile: null,
    output: null,
    baseline: null,
    runnerProfile: null,
    warmup: null,
    samples: null,
    iterations: null,
    cohortRounds: null,
    threshold: null,
    caseFilter: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--enforce') parsed.enforce = true;
    else if (argument === '--cohort-worker') parsed.cohortWorker = true;
    else if (argument === '--case') parsed.caseFilter.push(requiredValue(argv, ++index, argument));
    else if (argument === '--profile') parsed.profile = requiredValue(argv, ++index, argument);
    else if (argument === '--output') parsed.output = requiredValue(argv, ++index, argument);
    else if (argument === '--baseline') parsed.baseline = requiredValue(argv, ++index, argument);
    else if (argument === '--runner-profile') parsed.runnerProfile = requiredValue(argv, ++index, argument);
    else if (argument === '--warmup') parsed.warmup = requiredValue(argv, ++index, argument);
    else if (argument === '--samples') parsed.samples = requiredValue(argv, ++index, argument);
    else if (argument === '--iterations') parsed.iterations = requiredValue(argv, ++index, argument);
    else if (argument === '--cohort-rounds') parsed.cohortRounds = requiredValue(argv, ++index, argument);
    else if (argument === '--threshold') parsed.threshold = requiredValue(argv, ++index, argument);
    else if (argument === '--cohort-output') parsed.cohortOutput = requiredValue(argv, ++index, argument);
    else throw new Error(`Unknown CPU benchmark argument "${argument}".`);
  }
  return parsed;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function readBaseline(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Invalid benchmark baseline ${path}: ${error.message}`); }
}

function readExternalBaseline(path) {
  const absolutePath = resolve(root, path);
  if (!existsSync(absolutePath)) return null;
  const artifact = JSON.parse(readFileSync(absolutePath, 'utf8'));
  return {
    artifact: path,
    gateStatus: artifact.gate?.status ?? null,
    suite: artifact.suite ?? null,
    timings: artifact.timings ?? null,
    resources: artifact.resources ?? null,
    lifecycle: artifact.lifecycle ?? null,
  };
}

function readExternalRendererBenchmark(path) {
  const absolutePath = resolve(root, path);
  if (!existsSync(absolutePath)) return null;
  const artifact = JSON.parse(readFileSync(absolutePath, 'utf8'));
  return {
    artifact: path,
    gateStatus: artifact.gate?.status ?? null,
    suite: artifact.suite ?? null,
    configuration: artifact.configuration ?? null,
    allocationSampling: artifact.allocationSampling ?? null,
    results: artifact.results ?? null,
  };
}

function percent(value) { return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`; }
function gitRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
function gitDirty() {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().length > 0 : null;
}
function environmentFingerprint() {
  const cpu = cpus()[0];
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    release: process.release.name,
    arch: process.arch,
    cpu: cpu?.model ?? 'unknown',
    cpuCount: cpus().length,
    cpuSpeedMHz: cpu?.speed ?? null,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
  };
}
