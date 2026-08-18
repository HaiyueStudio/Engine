import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import {
  comparePlanarReflectionPixelBaseline,
  createPlanarReflectionPixelBaseline,
} from './planar-reflection-pixel-baseline.mjs';
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
const baselinePath = resolve(root, 'review/baselines/render-pixels-planar-reflection.json');
const artifactPath = resolve(root, 'artifacts/webgpu/planar-reflection.json');
const performanceConfig = loadPerformanceBudgetConfig(root);
const mode = long ? 'full' : 'smoke';
const benchmarkRoot = process.env.WEBGPU_BENCHMARK_ROOT ? resolve(process.env.WEBGPU_BENCHMARK_ROOT) : root;
const sourceFingerprint = createPerformanceSourceFingerprint(root, benchmarkRoot);
const result = await runChromeWebGpuFixture({
  root: benchmarkRoot,
  fixture: 'scripts/webgpu-gate/planar-reflection-fixture.html',
  query: {
    mode,
    warmup: process.env.PLANAR_REFLECTION_WARMUP ?? (long ? 3 : 2),
    samples: process.env.PLANAR_REFLECTION_SAMPLES ?? 40,
  },
  timeoutMs: long ? 900_000 : 300_000,
});
if (createPerformanceSourceFingerprint(root, benchmarkRoot) !== sourceFingerprint) {
  throw new Error('Performance executable inputs changed while the planar-reflection fixture was running; discard this evidence and retry.');
}
const selected = selectPerformanceProfile(
  performanceConfig,
  { nodePlatform: process.platform, adapter: result.adapter },
  process.env.WEBGPU_DEVICE_PROFILE,
);
const performanceBudget = evaluatePerformanceBudget(
  performanceConfig, selected.id, result.suite, mode, result,
);
const enforcePerformanceBudget = shouldEnforceDevicePerformanceBudgets();
result.performanceBudget = performanceBudget;
result.gate.performanceBudgetStatus = performanceBudget.status;
result.gate.performanceBudgetRole = enforcePerformanceBudget ? 'blocking-diagnostic-run' : 'diagnostic-only';
const evidencePath = resolve(root, performanceEvidencePath(selected.id, result.suite));
let pixelBaselineFailure = null;

if (process.env.UPDATE_PLANAR_REFLECTION_BASELINE === '1') {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(createPlanarReflectionPixelBaseline(result), null, 2)}\n`);
  result.gate.pixelBaselineStatus = 'updated';
  console.log(`[planar-reflection] Updated ${relative(root, baselinePath)}.`);
} else {
  if (!existsSync(baselinePath)) {
    pixelBaselineFailure = 'Planar-reflection pixel baseline is missing. Run with UPDATE_PLANAR_REFLECTION_BASELINE=1 after reviewing the fixture output.';
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const comparison = comparePlanarReflectionPixelBaseline(result, baseline);
    result.pixelBaselineComparison = comparison;
    if (comparison.status !== 'passed') {
      pixelBaselineFailure = `Planar-reflection pixel regression:\n${comparison.violations.join('\n')}`;
    }
    if (comparison.hashMismatches.length > 0) {
      console.warn(`[planar-reflection] ${comparison.hashMismatches.length} GPU hash mismatch(es) retained as diagnostics; numeric/semantic pixel gates decide the result.`);
    }
  }
  result.gate.pixelBaselineStatus = pixelBaselineFailure ? 'failed' : 'passed';
}

result.gate.status = !pixelBaselineFailure && (!enforcePerformanceBudget || performanceBudget.status === 'passed') ? 'passed' : 'failed';
result.evidence = createPerformanceEvidence(root, selected, performanceBudget, result, sourceFingerprint);
mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
if (shouldWriteFormalPerformanceEvidence(mode)) {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
}

if (pixelBaselineFailure) throw new Error(pixelBaselineFailure);

if (performanceBudget.status !== 'passed') {
  const detail = performanceBudget.violations
    .map(item => `${item.caseId ?? item.rule}: ${item.reason}${Number.isFinite(item.p95Ms) ? ` (${item.p95Ms.toFixed(2)}ms > ${item.maxP95Ms}ms)` : ''}`)
    .join('\n');
  if (enforcePerformanceBudget) {
    throw new Error(`Planar-reflection performance budget failed for ${selected.id}:\n${detail}`);
  }
  console.warn(`[planar-reflection] Diagnostic device budget exceeded for ${selected.id}:\n${detail}`);
}

console.log(`[planar-reflection] ${result.benchmarkResults.length} real WebGPU cases and ${Object.keys(result.pixelCases).length} pixel gates passed.`);
console.log(
  `[planar-reflection] ${performanceBudget.checks.length} P95 checks `
  + `${performanceBudget.status === 'passed' ? 'passed' : 'recorded as diagnostic-only'} for ${selected.id}.`,
);
console.log(`[planar-reflection] Wrote ${relative(root, artifactPath)}.`);
