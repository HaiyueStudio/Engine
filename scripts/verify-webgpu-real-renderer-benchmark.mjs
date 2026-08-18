import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import {
  aggregateTimingCohorts,
  assertMatchingTimingSourceFingerprints,
  createTimingVariabilityAnalysis,
  summarizeTimingSamples,
} from './benchmark/timing-cohorts.mjs';
import {
  createPerformanceEvidence,
  createPerformanceSourceFingerprint,
  evaluatePerformanceBudget,
  loadPerformanceBudgetConfig,
  performanceEvidencePath,
  selectPerformanceProfile,
  shouldEnforceDevicePerformanceBudgets,
} from './webgpu-performance-budget.mjs';
import { shouldWriteFormalPerformanceEvidence } from './performance-evidence-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const long = process.argv.includes('--long');
const artifactPath = resolve(root, 'artifacts/webgpu/real-renderer-benchmark.json');
const mode = long ? 'full' : 'smoke';
const benchmarkRoot = process.env.WEBGPU_BENCHMARK_ROOT ? resolve(process.env.WEBGPU_BENCHMARK_ROOT) : root;
const sourceFingerprint = createPerformanceSourceFingerprint(root, benchmarkRoot);
const timingCohortCount = positiveInteger(
  process.env.RENDERER_TIMING_COHORTS,
  long ? 3 : 2,
);
if (long && timingCohortCount < 3) {
  throw new Error('The long real-renderer gate requires at least three independent timing cohorts.');
}
const samplesPerCohort = positiveInteger(
  process.env.RENDERER_TIMING_SAMPLES,
  long ? 30 : 20,
);
const gpuSamples = nonNegativeInteger(
  process.env.RENDERER_GPU_TIMESTAMP_SAMPLES,
  long ? 10 : 4,
);
const fixtureOptions = {
  root: benchmarkRoot,
  fixture: 'scripts/webgpu-gate/real-renderer-benchmark-fixture.html',
  query: {
    entities: long ? 1_000 : 256,
    warmup: long ? 4 : 2,
    samples: samplesPerCohort,
    gpuSamples,
    pass: 'timing',
  },
  timeoutMs: long ? 240_000 : 120_000,
};
// HeapProfiler sampling materially perturbs short CPU frame timings. Keep the
// release P95 cohorts uninstrumented, then run the same source/workload in a
// separate process for allocation evidence. Every timing launch contributes
// equally to the pooled result; no best run is selected.
const timingCohorts = [];
for (let index = 0; index < timingCohortCount; index++) {
  const id = `timing-${index + 1}`;
  console.log(`[webgpu-real-renderer] Starting ${id}/${timingCohortCount}.`);
  timingCohorts.push(await runFixturePass(id, fixtureOptions));
}
const allocationPass = await runFixturePass('allocation', {
  ...fixtureOptions,
  query: {
    ...fixtureOptions.query,
    gpuSamples: 0,
    pass: 'allocation',
  },
  allocationSampling: {
    samplingInterval: Number(process.env.RENDERER_ALLOCATION_SAMPLING_INTERVAL ?? 32768),
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  },
});
const allPasses = [...timingCohorts, allocationPass];
const verifiedSourceFingerprint = assertMatchingTimingSourceFingerprints(allPasses);
if (verifiedSourceFingerprint !== sourceFingerprint) {
  throw new Error('Performance source fingerprint changed before the first timing cohort.');
}
assertSameRuntimeIdentity(allPasses);
const result = aggregateTimingCohorts(timingCohorts);
poolRealRendererDiagnosticChannels(result, timingCohorts);
assertRuntimeTimingBoundaries(result);
result.allocationSampling = allocationPass.result.allocationSampling;
result.allocationProbe = {
  id: allocationPass.id,
  isolatedFromTiming: true,
  sourceFingerprint: allocationPass.sourceFingerprint,
  fixtureResult: allocationPass.result,
};
result.sourceConsistency = {
  status: 'matched',
  sourceFingerprint: verifiedSourceFingerprint,
  passes: allPasses.map(pass => ({
    id: pass.id,
    sourceFingerprint: pass.sourceFingerprint,
    passKind: pass.result.passKind,
  })),
};

const performanceConfig = loadPerformanceBudgetConfig(root);
const selected = selectPerformanceProfile(
  performanceConfig,
  { nodePlatform: process.platform, adapter: result.adapter },
  process.env.WEBGPU_DEVICE_PROFILE,
);
const performanceBudget = evaluatePerformanceBudget(
  performanceConfig, selected.id, result.suite, mode, result,
);
const enforcePerformanceBudget = shouldEnforceDevicePerformanceBudgets();
result.mode = mode;
result.performanceBudget = performanceBudget;
result.variabilityAnalysis = createTimingVariabilityAnalysis(
  result,
  performanceBudget,
);
result.gate.performanceBudgetStatus = performanceBudget.status;
result.gate.performanceBudgetRole = enforcePerformanceBudget ? 'blocking-diagnostic-run' : 'diagnostic-only';
result.gate.status = !enforcePerformanceBudget || performanceBudget.status === 'passed' ? 'passed' : 'failed';
result.evidence = createPerformanceEvidence(root, selected, performanceBudget, result, sourceFingerprint);
const evidencePath = resolve(root, performanceEvidencePath(selected.id, result.suite));

mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
if (shouldWriteFormalPerformanceEvidence(mode)) {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
}
if (performanceBudget.status !== 'passed') {
  const detail = performanceBudget.violations
    .map(item => `${item.caseId ?? item.rule}${item.channel ? ` [${item.channel}]` : ''}: ${item.reason}${Number.isFinite(item.p95Ms) ? ` (${item.p95Ms.toFixed(2)}ms > ${item.maxP95Ms}ms)` : ''}`)
    .join('\n');
  if (enforcePerformanceBudget) {
    throw new Error(`Real-renderer performance budget failed for ${selected.id}:\n${detail}`);
  }
  console.warn(`[webgpu-real-renderer] Diagnostic device budget exceeded for ${selected.id}:\n${detail}`);
}
console.log(`[webgpu-real-renderer] ${result.results.length} cases passed; sampled ${result.allocationSampling.sampledBytes} allocation bytes.`);
console.log(
  `[webgpu-real-renderer] ${performanceBudget.checks.length} P95 checks `
  + `${performanceBudget.status === 'passed' ? 'passed' : 'recorded as diagnostic-only'} for ${selected.id}.`,
);
for (const analysis of result.variabilityAnalysis.cases) {
  const benchmarkCase = result.results.find(candidate => candidate.id === analysis.caseId);
  console.log(
    `[webgpu-real-renderer] ${analysis.caseId}: pooled P95 `
    + `${analysis.pooledP95Ms.toFixed(3)}ms, ${analysis.stability}, `
    + `${analysis.conclusion}; sampling wall `
    + `${benchmarkCase.sampleWall.p95.toFixed(3)}ms, queue wait `
    + `${benchmarkCase.queueWait.p95.toFixed(3)}ms.`,
  );
}
console.log(`[webgpu-real-renderer] Wrote ${artifactPath}`);

async function runFixturePass(id, options) {
  const before = createPerformanceSourceFingerprint(root, benchmarkRoot);
  if (before !== sourceFingerprint) {
    throw new Error(`Performance executable inputs changed before ${id}; discard this evidence and retry.`);
  }
  const result = await runChromeWebGpuFixture(options);
  const after = createPerformanceSourceFingerprint(root, benchmarkRoot);
  if (after !== before) {
    throw new Error(`Performance executable inputs changed during ${id}; discard this evidence and retry.`);
  }
  return { id, sourceFingerprint: before, result };
}

function assertSameRuntimeIdentity(passes) {
  const first = passes[0]?.result;
  const expectedAdapter = JSON.stringify(first?.adapter ?? {});
  const expectedBrowser = first?.browser ?? '';
  for (const pass of passes) {
    if (JSON.stringify(pass.result.adapter ?? {}) !== expectedAdapter) {
      throw new Error(`Adapter identity changed during ${pass.id}.`);
    }
    if (pass.result.browser !== expectedBrowser) {
      throw new Error(`Browser identity changed during ${pass.id}.`);
    }
    const expectedPassKind = pass.id === 'allocation' ? 'allocation' : 'timing';
    if (pass.result.passKind !== expectedPassKind) {
      throw new Error(`${pass.id} reported unexpected pass kind ${pass.result.passKind}.`);
    }
  }
}

function poolRealRendererDiagnosticChannels(artifact, cohorts) {
  const timingChannels = [
    'sampleWall',
    'cpuUpdate',
    'cpuRecord',
    'dirtyRange',
    'upload',
    'objectTableUpload',
    'cpuSubmit',
    'queueWait',
  ];
  const countChannels = ['objectTableFlushes', 'denseWholeSpanUploads'];
  for (let caseIndex = 0; caseIndex < artifact.results.length; caseIndex++) {
    const result = artifact.results[caseIndex];
    const cohortCases = cohorts.map(cohort => cohort.result.results[caseIndex]);
    const boundary = JSON.stringify(cohortCases[0].timingBoundary);
    if (cohortCases.some(item => JSON.stringify(item.timingBoundary) !== boundary)) {
      throw new Error(`${result.id}: timing boundary changed between cohorts.`);
    }
    result.timingBoundary = cohortCases[0].timingBoundary;
    for (const channel of timingChannels) {
      const samples = cohortCases.flatMap(item => item[channel]?.rawSamples ?? []);
      if (samples.length !== result.samples) {
        throw new Error(
          `${result.id}: ${channel} has ${samples.length} pooled samples; `
          + `expected ${result.samples}.`,
        );
      }
      result[channel] = summarizeTimingSamples(samples);
      for (let index = 0; index < result.timingCohorts.length; index++) {
        result.timingCohorts[index][channel] = cohortCases[index][channel];
      }
    }
    for (const channel of countChannels) {
      const samples = cohortCases.flatMap(item => item[channel]?.rawSamples ?? []);
      if (samples.length !== result.samples) {
        throw new Error(
          `${result.id}: ${channel} has ${samples.length} pooled samples; `
          + `expected ${result.samples}.`,
        );
      }
      result[channel] = summarizeCountSamples(samples);
      for (let index = 0; index < result.timingCohorts.length; index++) {
        result.timingCohorts[index][channel] = cohortCases[index][channel];
      }
    }
  }
}

function assertRuntimeTimingBoundaries(artifact) {
  for (const result of artifact.results) {
    if (
      result.timingBoundary?.runtime !== 'frame-start-through-single-submit-return'
      || result.timingBoundary?.samplingFence !== 'queue.onSubmittedWorkDone'
      || result.timingBoundary?.queueWaitIncludedInTiming !== false
    ) {
      throw new Error(`${result.id}: invalid runtime/sampling timing boundary.`);
    }
  }
}

function summarizeCountSamples(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    total,
    perFrame: values.length > 0 ? total / values.length : 0,
    min: values.length > 0 ? Math.min(...values) : 0,
    max: values.length > 0 ? Math.max(...values) : 0,
    rawSamples: values,
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}
