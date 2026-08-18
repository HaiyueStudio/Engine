import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  CANDIDATE_RESULT_PATH,
  CAPABILITY_SUPPORT_PATH,
  DASHBOARD_REPORT_PATH,
  NODE_RESULT_PATH,
  RESULT_PATH,
  ROOT,
  readCorpusManifest,
  syncCorpus,
  writeJson,
} from './corpus.mjs';
import { measureNodeCorpus } from './measure-node.mjs';
import { npmArgs, npmCommand } from '../npm-process.mjs';
import { summarizeFeatureAttribution } from './feature-attribution.mjs';
import { createCapabilitySnapshot } from './capability-roadmap.mjs';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';
import {
  compareHyaFirstFrameCohorts,
  HYA_FIRST_FRAME_DIAGNOSTIC_TOLERANCE,
} from './first-frame-policy.mjs';

const MIN_MEDIAN_PARSE_SPEEDUP = 1.25;
const MIN_GZIP_SAVING = 0.15;
const offline = process.argv.includes('--offline');
const skipBrowser = process.argv.includes('--skip-browser');
const candidate = process.argv.includes('--candidate');
if (candidate && skipBrowser) throw new Error('--candidate requires the browser benchmark; use --skip-browser alone for the node-only report.');
const iterations = readIntegerArgument('--iterations', 100);
const parseBatchSize = readIntegerArgument('--parse-batch-size', 50, 1);
const parseStabilityRuns = readIntegerArgument('--parse-stability-runs', 5, 1);
const largeIterations = readIntegerArgument('--large-iterations', 20);
const largeBatchSize = readIntegerArgument('--large-batch-size', 1, 1);
const manifest = readCorpusManifest();
const sync = await syncCorpus(manifest, { offline });
console.log(`[hya-corpus] assets ready: downloaded=${sync.downloaded}, reused=${sync.reused}.`);

const measurementOptions = {
  iterations,
  batchSize: parseBatchSize,
  largeIterations,
  largeBatchSize,
};
const samples = measureNodeCorpus(manifest, measurementOptions);
const currentGitRevision = gitRevision();
if (!candidate) {
  writeJson(CAPABILITY_SUPPORT_PATH, createCapabilitySnapshot(samples, {
    gitRevision: currentGitRevision,
    workingTreeDirty: repositoryDirty(),
  }));
}
const smallSamples = cohort(samples, 'small');
const largeSamples = cohort(samples, 'large');
const smallParseSpeedupRuns = [summarize(smallSamples).medianParseSpeedup];
const largeParseSpeedupRuns = [summarize(largeSamples).medianParseSpeedup];
for (let run = 1; run < parseStabilityRuns; run++) {
  const validationSamples = measureNodeCorpus(manifest, measurementOptions);
  smallParseSpeedupRuns.push(summarize(cohort(validationSamples, 'small')).medianParseSpeedup);
  largeParseSpeedupRuns.push(summarize(cohort(validationSamples, 'large')).medianParseSpeedup);
}
if (!skipBrowser) buildDashboard();

let browser = null;
if (!skipBrowser) {
  browser = await runChromeWebGpuFixture({
    root: ROOT,
    fixture: 'examples/hya-corpus-dashboard/index.html',
    query: { benchmark: 1 },
    timeoutMs: 180_000,
  });
  mergeBrowserMetrics(samples, browser.samples);
}

const formalBaseline = readFormalBaseline();
const report = {
  schemaVersion: 3,
  suiteVersion: 'hya-lottie-real-v1',
  generatedAt: new Date().toISOString(),
  source: manifest.source,
  sources: manifest.sources ?? { legacy: manifest.source },
  referenceRenderer: manifest.referenceRenderer ?? null,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    gitRevision: currentGitRevision,
    browser: browser?.environment ?? null,
  },
  methodology: {
    parseIterations: iterations,
    parseBatchSize,
    largeParseIterations: largeIterations,
    largeParseBatchSize: largeBatchSize,
    parseStabilityRuns,
    parseAcceptanceThreshold: MIN_MEDIAN_PARSE_SPEEDUP,
    gzipAcceptanceThreshold: MIN_GZIP_SAVING,
    firstFrameRegressionTolerance: HYA_FIRST_FRAME_DIAGNOSTIC_TOLERANCE,
    firstFrameRegressionRole: 'cross-host-diagnostic',
    parse: `Median and p95 source-to-runtime parse time after warmup; each observation amortizes a batch of ${parseBatchSize} parses to reduce sub-millisecond timer quantization. Lottie includes JSON parse and conversion; HYA reuses the fetched input buffer and includes binary validation plus typed-view creation.`,
    size: 'Raw and gzip-9 bytes for source Lottie JSON and generated HYA binary.',
    fidelity: 'Per-frame RGBA mean absolute similarity combined with alpha-mask intersection-over-union against pinned reference PNGs. Legacy references are After Effects exports; large-corpus references use the pinned lottie-web 5.13.0 Canvas renderer. The benchmark scene pins a transparent clear color.',
    network: 'Real loopback HTTP fetch with cache disabled and Response.body streaming. Request-to-headers, body download, byte count and chunk count are recorded separately for source Lottie, HYA and every pinned external image/data/font resource.',
    firstFrame: 'After one unreported sample primes the shared Animation2D pipeline, each measured sample starts at its uncached HYA request and ends at the first complete WebGPU frame after all required resources settle. It includes streaming HTTP delivery, HYA parse, asset-specific runtime construction, external image and FontFace completion, text rerasterization, geometry/upload preparation and queue completion.',
    featureAttribution: 'Static source feature inventory plus one-to-one converter-diagnostic attribution by exact JSON path and diagnostic code. Observed fidelity loss is correlation for prioritization, not proof of causality.',
  },
  summary: summarize(samples),
  cohorts: {
    small: summarize(smallSamples),
    large: summarize(largeSamples),
  },
  parseStability: stability(smallParseSpeedupRuns),
  parseStabilityByCohort: {
    small: stability(smallParseSpeedupRuns),
    large: stability(largeParseSpeedupRuns),
  },
  featureSummary: summarizeFeatureAttribution(samples),
  samples,
};
report.diagnostics = {
  firstFrameRegression: compareHyaFirstFrameCohorts(report, formalBaseline),
};
validateReport(report, formalBaseline);
if (report.diagnostics.firstFrameRegression.status === 'regression-observed') {
  const details = report.diagnostics.firstFrameRegression.cohorts
    .filter(cohort => cohort.status === 'regression-observed')
    .map(cohort => `${cohort.label} ${formatMs(cohort.currentP95Ms)} vs ${formatMs(cohort.baselineP95Ms)}`)
    .join(', ');
  console.warn(
    `[hya-corpus] first-frame cross-host diagnostic observed: ${details}. `
    + 'Absolute milliseconds remain recorded but are not a portable release-performance gate.',
  );
}
if (report.parseStabilityByCohort.small.minimum < MIN_MEDIAN_PARSE_SPEEDUP) {
  throw new Error(
    `HYA legacy/small minimum median parse speedup ${report.parseStabilityByCohort.small.minimum.toFixed(3)}x `
    + `is below the ${MIN_MEDIAN_PARSE_SPEEDUP.toFixed(2)}x acceptance threshold; formal evidence was not updated.`,
  );
}
if (skipBrowser) {
  writeJson(NODE_RESULT_PATH, report);
  console.log(`[hya-corpus] node-only report written to ${NODE_RESULT_PATH}; checked-in browser baseline was not changed.`);
} else if (candidate) {
  writeJson(CANDIDATE_RESULT_PATH, report);
  console.log(`[hya-corpus] candidate report written to ${CANDIDATE_RESULT_PATH}; checked-in browser baseline and dashboard report were not changed.`);
} else {
  writeJson(RESULT_PATH, report);
  writeJson(DASHBOARD_REPORT_PATH, report);
  console.log(`[hya-corpus] report written to ${RESULT_PATH} and ${DASHBOARD_REPORT_PATH}.`);
}
console.log(
  `[hya-corpus] small=${smallSamples.length}, fidelity=${formatPercent(report.cohorts.small.medianFidelity)}, `
  + `gzip saving=${formatPercent(report.cohorts.small.gzipByteSaving)}, parse speedup=${report.cohorts.small.medianParseSpeedup.toFixed(2)}x `
  + `(stable min ${report.parseStabilityByCohort.small.minimum.toFixed(2)}x / ${parseStabilityRuns} runs), `
  + `first-frame p50=${formatMs(report.cohorts.small.firstFrameP50Ms)}.`,
);
console.log(
  `[hya-corpus] large=${largeSamples.length}, fidelity=${formatPercent(report.cohorts.large.medianFidelity)}, `
  + `gzip saving=${formatPercent(report.cohorts.large.gzipByteSaving)}, parse speedup=${report.cohorts.large.medianParseSpeedup.toFixed(2)}x, `
  + `network p50=${formatMs(report.cohorts.large.networkP50Ms)}, first-frame p50=${formatMs(report.cohorts.large.firstFrameP50Ms)}.`,
);

function buildDashboard() {
  const result = spawnSync(npmCommand(), npmArgs(['run', 'build', '-w', './examples']), {
    cwd: ROOT,
    env: { ...process.env, EXAMPLE_FILTER: 'hya-corpus-dashboard' },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`HYA dashboard build failed with status ${result.status}.`);
}

function mergeBrowserMetrics(samples, browserSamples) {
  const byId = new Map((browserSamples ?? []).map(sample => [sample.id, sample]));
  for (const sample of samples) {
    const measured = byId.get(sample.id);
    if (!measured) throw new Error(`Browser benchmark omitted corpus sample ${sample.id}.`);
    sample.firstFrame = measured.firstFrame;
    sample.delivery = measured.delivery ?? null;
    sample.fidelity = measured.fidelity;
    const frames = new Map(measured.frames.map(frame => [frame.frame, frame]));
    for (const frame of sample.frames) frame.metrics = frames.get(frame.frame)?.metrics ?? null;
  }
}

function summarize(samples) {
  const totalLottieBytes = sum(samples, sample => sample.source.bytes);
  const totalHyaBytes = sum(samples, sample => sample.hya.bytes);
  const totalLottieGzipBytes = sum(samples, sample => sample.source.gzipBytes);
  const totalHyaGzipBytes = sum(samples, sample => sample.hya.gzipBytes);
  const fidelities = finite(samples.map(sample => sample.fidelity?.score));
  const parseSpeedups = finite(samples.map(sample => sample.parse.speedup));
  const firstFrames = finite(samples.map(sample => sample.firstFrame?.totalMs));
  const network = finite(samples.map(sample => sample.delivery?.hya.network.totalMs));
  const downloads = finite(samples.map(sample => sample.delivery?.hya.network.bodyDownloadMs));
  return {
    sampleCount: samples.length,
    referenceFrameCount: sum(samples, sample => sample.frames.length),
    cleanConversionCount: samples.filter(sample => sample.conversion.status === 'clean').length,
    failedFeatureSampleCount: samples.filter(sample => sample.featureAnalysis.failedFeatureCount > 0).length,
    unclassifiedFailureCount: sum(samples, sample => sample.featureAnalysis.unclassifiedFailureCount),
    totalLottieBytes,
    totalHyaBytes,
    totalLottieGzipBytes,
    totalHyaGzipBytes,
    rawByteSaving: saving(totalHyaBytes, totalLottieBytes),
    gzipByteSaving: saving(totalHyaGzipBytes, totalLottieGzipBytes),
    medianFidelity: median(fidelities),
    minimumFidelity: fidelities.length > 0 ? Math.min(...fidelities) : null,
    medianParseSpeedup: median(parseSpeedups) ?? 0,
    firstFrameP50Ms: median(firstFrames),
    firstFrameP95Ms: percentile(firstFrames, 0.95),
    networkP50Ms: median(network),
    networkP95Ms: percentile(network, 0.95),
    downloadP50Ms: median(downloads),
    downloadP95Ms: percentile(downloads, 0.95),
  };
}

function cohort(samples, sizeClass) {
  return samples.filter(sample => (sample.sizeClass ?? 'small') === sizeClass);
}

function stability(runs) {
  return {
    runs,
    minimum: runs.length > 0 ? Math.min(...runs) : 0,
    median: median([...runs].sort((a, b) => a - b)),
    maximum: runs.length > 0 ? Math.max(...runs) : 0,
  };
}

function readFormalBaseline() {
  if (!existsSync(RESULT_PATH)) return null;
  return JSON.parse(readFileSync(RESULT_PATH, 'utf8'));
}

function validateReport(report, baseline) {
  const small = report.cohorts.small;
  if (small.gzipByteSaving === null || small.gzipByteSaving < MIN_GZIP_SAVING) {
    throw new Error(
      `HYA legacy/small gzip saving ${formatPercent(small.gzipByteSaving)} is below `
      + `${formatPercent(MIN_GZIP_SAVING)}; evidence was not updated.`,
    );
  }
  if (report.summary.unclassifiedFailureCount !== 0) {
    throw new Error(`HYA corpus has ${report.summary.unclassifiedFailureCount} unclassified conversion failures.`);
  }
  if (!report.environment.browser) return;
  for (const sample of report.samples) {
    if (!sample.fidelity || !sample.firstFrame || !sample.delivery) {
      throw new Error(`HYA browser evidence is incomplete for ${sample.id}.`);
    }
    if (
      sample.delivery.source.network.bytes !== sample.source.bytes
      || sample.delivery.hya.network.bytes !== sample.hya.bytes
      || !sample.delivery.source.network.streamed
      || !sample.delivery.hya.network.streamed
    ) throw new Error(`HYA HTTP streaming evidence is invalid for ${sample.id}.`);
    const externalResources = sample.delivery.externalResources ?? [];
    const expectedExternalBytes = sample.source.externalResourceBytes ?? 0;
    const deliveredExternalBytes = sum(externalResources, resource => resource.network.bytes);
    if (
      deliveredExternalBytes !== expectedExternalBytes
      || externalResources.some(resource => (
        resource.network.bytes !== resource.expectedBytes || !resource.network.streamed
      ))
      || sample.firstFrame.externalResourceBytes !== expectedExternalBytes
      || sample.firstFrame.externalResourceCount !== externalResources.length
      || sample.firstFrame.pendingResourceCount !== 0
      || sample.firstFrame.failedResourceCount !== 0
    ) throw new Error(`HYA external-resource delivery evidence is invalid for ${sample.id}.`);
  }
  if (!baseline) return;
  validateCohortRegression('legacy/small', small, baseline.cohorts?.small ?? baseline.summary);
  if (report.cohorts.large.sampleCount > 0 && baseline.cohorts?.large?.sampleCount > 0) {
    validateCohortRegression('large', report.cohorts.large, baseline.cohorts.large);
  }
}

function validateCohortRegression(label, cohort, baseline) {
  const fidelityFloor = baseline?.minimumFidelity;
  if (
    typeof fidelityFloor === 'number'
    && (cohort.minimumFidelity === null || cohort.minimumFidelity + 1e-9 < fidelityFloor)
  ) {
    throw new Error(
      `HYA ${label} minimum fidelity ${formatPercent(cohort.minimumFidelity)} is below `
      + `the formal cohort baseline ${formatPercent(fidelityFloor)}.`,
    );
  }
}

function sum(values, selector) {
  return values.reduce((total, value) => total + selector(value), 0);
}

function finite(values) {
  return values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
}

function median(values) {
  return percentile(values, 0.5);
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? null;
}

function saving(value, original) {
  return original === 0 ? null : 1 - value / original;
}

function gitRevision() {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'unknown';
}

function repositoryDirty() {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  return status.status !== 0 || status.stdout.trim().length > 0;
}

function readIntegerArgument(name, fallback, minimum = 10) {
  const argument = process.argv.find(value => value.startsWith(`${name}=`));
  if (!argument) return fallback;
  const value = Number(argument.slice(name.length + 1));
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}.`);
  return value;
}

function formatPercent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatMs(value) {
  return value === null ? 'n/a' : `${value.toFixed(2)}ms`;
}
