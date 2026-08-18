import { performance } from 'node:perf_hooks';
import { classifyCohortStability } from './cpu-benchmark-policy.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HARNESS_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_NODE_MAJOR = Number.parseInt(
  readFileSync(new URL('../../.node-version', import.meta.url), 'utf8').trim(),
  10,
);

export class BenchmarkLifecycleError extends Error {
  constructor(caseId, stage, cause, teardownError = null) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const teardownDetail = teardownError
      ? `; teardown also failed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`
      : '';
    super(`Benchmark lifecycle failed for "${caseId}" during ${stage}: ${detail}${teardownDetail}`, {
      cause,
    });
    this.name = 'BenchmarkLifecycleError';
    this.caseId = caseId;
    this.stage = stage;
    this.teardownError = teardownError;
  }
}

export async function runStatisticalBenchmarks(cases, options = {}) {
  const warmup = positiveInteger(options.warmup, 5);
  const samples = positiveInteger(options.samples, 20);
  const iterations = positiveInteger(options.iterations, 1);
  const results = [];
  for (const benchmark of cases) {
    const caseIterations = positiveInteger(benchmark.iterations, iterations);
    let state;
    let primaryError = null;
    let primaryStage = 'setup';
    const durations = [];
    const allocations = [];
    let checksum = 0;
    try {
      state = await benchmark.setup?.();
      primaryStage = 'run';
      for (let i = 0; i < warmup; i++) await runIterations(benchmark.run, state, caseIterations);
      await benchmark.resetMetrics?.(state);
      for (let sample = 0; sample < samples; sample++) {
        const heapBefore = process.memoryUsage().heapUsed;
        const started = performance.now();
        checksum = checksumValue(await runIterations(benchmark.run, state, caseIterations), checksum);
        durations.push((performance.now() - started) / caseIterations);
        allocations.push(Math.max(0, process.memoryUsage().heapUsed - heapBefore) / caseIterations);
      }
    } catch (error) {
      primaryError = error;
    }
    const teardownError = await captureLifecycleFailure(() => benchmark.teardown?.(state));
    if (primaryError) {
      throw new BenchmarkLifecycleError(benchmark.id, primaryStage, primaryError, teardownError);
    }
    if (teardownError) throw new BenchmarkLifecycleError(benchmark.id, 'teardown', teardownError);
    let metrics;
    let allocationEvidence;
    try {
      metrics = await benchmark.metrics?.(state) ?? null;
      allocationEvidence = await benchmark.allocationEvidence?.(state) ?? null;
    } catch (error) {
      throw new BenchmarkLifecycleError(benchmark.id, 'metrics', error);
    }
    results.push(createResult(benchmark, durations, allocations, {
      warmup, samples, iterations: caseIterations, checksum, metrics, allocationEvidence,
    }));
  }
  return results;
}

/**
 * Runs one untimed setup/run/metrics/teardown lifecycle for every supplied case.
 * Teardown is attempted even when setup, run, or metrics fails.
 */
export async function runBenchmarkLifecycleSmoke(cases) {
  const results = [];
  for (const benchmark of cases) {
    let state;
    let primaryError = null;
    let primaryStage = 'setup';
    let metrics = null;
    try {
      state = await benchmark.setup?.();
      await benchmark.resetMetrics?.(state);
      primaryStage = 'run';
      await benchmark.run(state, 0);
      primaryStage = 'metrics';
      metrics = await benchmark.metrics?.(state) ?? null;
      await benchmark.allocationEvidence?.(state);
    } catch (error) {
      primaryError = error;
    }
    const teardownError = await captureLifecycleFailure(() => benchmark.teardown?.(state));
    if (primaryError) {
      throw new BenchmarkLifecycleError(benchmark.id, primaryStage, primaryError, teardownError);
    }
    if (teardownError) throw new BenchmarkLifecycleError(benchmark.id, 'teardown', teardownError);
    results.push({
      id: benchmark.id,
      stages: ['setup', 'run', 'metrics', 'teardown'],
      metrics,
    });
  }
  return results;
}

async function captureLifecycleFailure(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error;
  }
}

export function runIsolatedBenchmarkCohorts(options) {
  const caseId = requiredString(options.caseId, 'caseId');
  const cohortCount = Math.max(5, positiveInteger(options.cohorts, 5));
  const warmup = Math.max(8, positiveInteger(options.warmup, 8));
  const samples = Math.max(30, positiveInteger(options.samples, 30));
  const iterations = positiveInteger(options.iterations, 1);
  const profile = options.profile ?? 'ci';
  const suiteUrl = options.suiteUrl ?? new URL('./suite.mjs', import.meta.url).href;
  const expectedNodeMajor = positiveInteger(options.expectedNodeMajor, REPOSITORY_NODE_MAJOR);
  const phaseTiming = options.phaseTiming === true;
  const cohorts = [];

  assertNodeMajor(expectedNodeMajor);
  for (let cohort = 0; cohort < cohortCount; cohort++) {
    const request = {
      caseId,
      profile,
      suiteUrl,
      warmup,
      samples,
      iterations,
      phaseTiming,
    };
    const child = spawnSync(process.execPath, [HARNESS_PATH, '--cohort-worker', JSON.stringify(request)], {
      cwd: options.cwd ?? process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BENCHMARK_RENDER3D_PHASES: phaseTiming ? '1' : '0',
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (child.error) throw child.error;
    if (child.status !== 0) {
      throw new Error(
        `Benchmark cohort ${cohort + 1}/${cohortCount} failed for ${caseId}:\n`
        + `${child.stderr || child.stdout}`,
      );
    }
    const result = JSON.parse(child.stdout);
    if (Number.parseInt(result.node?.slice(1), 10) !== expectedNodeMajor) {
      throw new Error(`Benchmark cohort used ${result.node}; expected Node ${expectedNodeMajor}.`);
    }
    cohorts.push(result);
  }
  return summarizeBenchmarkCohorts(caseId, cohorts);
}

export async function runSameProcessBenchmarkSeries(options) {
  const caseId = requiredString(options.caseId, 'caseId');
  const precedingCaseIds = options.precedingCaseIds ?? [];
  const repeats = positiveInteger(options.repeats, 5);
  const warmup = positiveInteger(options.warmup, 8);
  const samples = positiveInteger(options.samples, 30);
  const iterations = positiveInteger(options.iterations, 1);
  const profile = options.profile ?? 'ci';
  const suiteUrl = options.suiteUrl ?? new URL('./suite.mjs', import.meta.url).href;
  const suite = await import(suiteUrl);
  const results = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const cases = suite.createBenchmarkCases(profile);
    const precedingCases = precedingCaseIds.map(precedingCaseId => {
      const preceding = cases.find(candidate => candidate.id === precedingCaseId);
      if (!preceding) throw new Error(`Unknown preceding benchmark case "${precedingCaseId}".`);
      return preceding;
    });
    if (precedingCases.length > 0) {
      await runStatisticalBenchmarks(precedingCases, { warmup, samples, iterations });
    }
    const heapUsedAfterPrecedingCases = process.memoryUsage().heapUsed;
    if (options.gcBetween === true) {
      if (typeof globalThis.gc !== 'function') {
        throw new Error('--gc-between requires launching Node with --expose-gc.');
      }
      globalThis.gc();
      globalThis.gc();
    }
    const heapUsedBeforeTarget = process.memoryUsage().heapUsed;
    const benchmark = cases.find(candidate => candidate.id === caseId);
    if (!benchmark) throw new Error(`Unknown benchmark case "${caseId}".`);
    const [result] = await runStatisticalBenchmarks([benchmark], { warmup, samples, iterations });
    results.push({
      repeat: repeat + 1,
      node: process.version,
      precedingCaseIds,
      heapUsedAfterPrecedingCases,
      heapUsedBeforeTarget,
      heapUsedAfter: process.memoryUsage().heapUsed,
      ...result,
    });
  }
  return results;
}

export function summarizeBenchmarkCohorts(caseId, cohorts) {
  const stability = classifyCohortStability(cohorts);
  const p50s = cohorts.map(result => result.p50).sort((a, b) => a - b);
  const p95s = cohorts.map(result => result.p95).sort((a, b) => a - b);
  const allocations = cohorts.map(result => result.allocationBytesP50).sort((a, b) => a - b);
  const phaseNames = new Set();
  for (const result of cohorts) {
    for (const name of Object.keys(result.metrics?.phaseTimingsMsPerFrame ?? {})) phaseNames.add(name);
  }
  const phaseTimingsMsPerFrame = {};
  for (const name of phaseNames) {
    const values = cohorts
      .map(result => result.metrics?.phaseTimingsMsPerFrame?.[name])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    phaseTimingsMsPerFrame[name] = percentile(values, 0.5);
  }
  return {
    caseId,
    cohortCount: cohorts.length,
    node: cohorts[0]?.node ?? process.version,
    warmup: cohorts[0]?.warmup ?? 0,
    samples: cohorts[0]?.samples ?? 0,
    iterations: cohorts[0]?.iterations ?? 0,
    p50Median: percentile(p50s, 0.5),
    p95Median: percentile(p95s, 0.5),
    allocationBytesP50Median: percentile(allocations, 0.5),
    phaseTimingsMsPerFrame,
    stability,
    cohorts,
  };
}

async function runIterations(run, state, iterations) {
  let result;
  for (let i = 0; i < iterations; i++) result = await run(state, i);
  return result;
}

function createResult(benchmark, durations, allocations, metadata) {
  const sorted = [...durations].sort((a, b) => a - b);
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const variance = durations.reduce((sum, value) => sum + (value - mean) ** 2, 0) / durations.length;
  const stddev = Math.sqrt(variance);
  return {
    id: benchmark.id,
    group: benchmark.group,
    stage: benchmark.stage ?? benchmark.group,
    budgetP95Ms: Number.isFinite(benchmark.budgetP95Ms) ? benchmark.budgetP95Ms : null,
    unit: 'ms/op',
    lowerIsBetter: true,
    warmup: metadata.warmup,
    samples: metadata.samples,
    iterations: metadata.iterations,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    mean,
    stddev,
    relativeStddev: mean === 0 ? 0 : stddev / mean,
    min: sorted[0],
    max: sorted.at(-1),
    allocationBytesP50: percentile([...allocations].sort((a, b) => a - b), 0.5),
    allocationEvidence: metadata.allocationEvidence,
    checksum: metadata.checksum,
    metrics: metadata.metrics,
    metricBudgets: benchmark.metricBudgets ?? null,
  };
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function checksumValue(value, previous) {
  if (typeof value === 'number' && Number.isFinite(value)) return ((previous * 31) + Math.trunc(value)) >>> 0;
  if (typeof value === 'string') return [...value].reduce((sum, char) => ((sum * 31) + char.charCodeAt(0)) >>> 0, previous);
  if (value && typeof value === 'object') return ((previous * 31) + Object.keys(value).length) >>> 0;
  return ((previous * 31) + Number(Boolean(value))) >>> 0;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function assertNodeMajor(expected) {
  const actual = Number.parseInt(process.versions.node, 10);
  if (actual !== expected) throw new Error(`Benchmark requires Node ${expected}; received ${process.version}.`);
}

async function runCohortWorker(request) {
  const suite = await import(request.suiteUrl);
  const benchmark = suite.createBenchmarkCases(request.profile)
    .find(candidate => candidate.id === request.caseId);
  if (!benchmark) throw new Error(`Unknown benchmark case "${request.caseId}".`);
  const [result] = await runStatisticalBenchmarks([benchmark], request);
  process.stdout.write(JSON.stringify({ node: process.version, ...result }));
}

function readCliValue(args, name, fallback) {
  const prefix = `--${name}=`;
  const entry = args.find(value => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : fallback;
}

async function runHarnessCli(args) {
  if (args[0] === '--cohort-worker') {
    await runCohortWorker(JSON.parse(args[1]));
    return;
  }
  const caseId = readCliValue(args, 'case', '');
  if (!caseId) return;
  assertNodeMajor(REPOSITORY_NODE_MAJOR);
  const common = {
    caseId,
    profile: readCliValue(args, 'profile', 'ci'),
    warmup: readCliValue(args, 'warmup', 8),
    samples: readCliValue(args, 'samples', 30),
    iterations: readCliValue(args, 'iterations', 1),
  };
  if (args.includes('--same-process')) {
    const precedingCaseIds = readCliValue(args, 'preceded-by', '')
      .split(',')
      .filter(Boolean);
    const results = await runSameProcessBenchmarkSeries({
      ...common,
      repeats: readCliValue(args, 'repeats', 5),
      precedingCaseIds,
      gcBetween: args.includes('--gc-between'),
    });
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  const summary = runIsolatedBenchmarkCohorts({
    ...common,
    cohorts: readCliValue(args, 'cohorts', 5),
    phaseTiming: args.includes('--phases'),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  await runHarnessCli(process.argv.slice(2));
}
