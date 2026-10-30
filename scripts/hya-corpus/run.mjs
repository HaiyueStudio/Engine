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

import {MIN_MEDIAN_PARSE_SPEEDUP,MIN_GZIP_SAVING,mergeBrowserMetrics,summarize,cohort,stability,validateReport,formatPercent} from './report-policy.mjs';
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
    fixture: 'examples/hya-lottie-corpus-dashboard/index.html',
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
    env: { ...process.env, EXAMPLE_FILTER: 'hya-lottie-corpus-dashboard' },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`HYA dashboard build failed with status ${result.status}.`);
}

function readFormalBaseline() {
  if (!existsSync(RESULT_PATH)) return null;
  return JSON.parse(readFileSync(RESULT_PATH, 'utf8'));
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

function formatMs(value) {
  return value === null ? 'n/a' : `${value.toFixed(2)}ms`;
}
