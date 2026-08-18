import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { validateAmbientOcclusionGpuCostArtifact } from './webgpu-gate/ambient-occlusion-gpu-cost-contract.mjs';
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
const mode = process.argv.includes('--smoke') ? 'smoke' : 'full';
const warmup = integerArgument('warmup', mode === 'smoke' ? 2 : 8);
const samples = integerArgument('samples', mode === 'smoke' ? 3 : 30);
const artifactPath = resolve(root, 'artifacts/webgpu/ambient-occlusion-gpu-cost.json');
const benchmarkRoot = process.env.WEBGPU_BENCHMARK_ROOT ? resolve(process.env.WEBGPU_BENCHMARK_ROOT) : root;
const sourceFingerprint = createPerformanceSourceFingerprint(root, benchmarkRoot);
const performanceConfig = loadPerformanceBudgetConfig(root);
const suiteConfig = performanceConfig.suites['ambient-occlusion.gpu-cost'];
const enforcePerformanceBudget = shouldEnforceDevicePerformanceBudgets();
const result = await runChromeWebGpuFixture({
  root: benchmarkRoot,
  fixture: 'scripts/webgpu-gate/ambient-occlusion-gpu-cost-fixture.html',
  query: { warmup, samples },
  timeoutMs: integerArgument('timeout-ms', mode === 'smoke' ? 180_000 : 600_000),
  acceptedStatuses: ['passed', 'unavailable'],
});
if (createPerformanceSourceFingerprint(root, benchmarkRoot) !== sourceFingerprint) {
  throw new Error('Performance executable inputs changed while the AO fixture was running; discard this evidence and retry.');
}

result.mode = mode;
result.artifactValidation = validateAmbientOcclusionGpuCostArtifact(result, suiteConfig, { mode });
if (result.artifactValidation.status !== 'passed') {
  result.gate = { status: 'failed', artifactValidatorStatus: 'failed', performanceBudgetStatus: 'not-evaluated' };
  writeArtifact(result);
  throw new Error(`AO GPU cost artifact validation failed:\n- ${result.artifactValidation.violations.join('\n- ')}`);
}

if (result.status === 'unavailable') {
  result.gate = {
    status: mode === 'smoke' || !enforcePerformanceBudget ? 'unavailable' : 'failed',
    artifactValidatorStatus: 'passed',
    performanceBudgetStatus: 'unavailable',
    performanceBudgetRole: enforcePerformanceBudget ? 'blocking-diagnostic-run' : 'diagnostic-only',
    unavailableReason: result.capabilities.timestampQuery.reason,
  };
  writeArtifact(result);
  if (mode === 'full' && enforcePerformanceBudget) {
    throw new Error(`AO full performance evidence is unavailable: ${result.gate.unavailableReason}`);
  }
  console.warn(`[ambient-occlusion:performance] unavailable: ${result.gate.unavailableReason}`);
} else {
  const selected = selectPerformanceProfile(
    performanceConfig,
    { nodePlatform: process.platform, adapter: result.adapter },
    process.env.WEBGPU_DEVICE_PROFILE,
  );
  const performanceBudget = evaluatePerformanceBudget(
    performanceConfig,
    selected.id,
    result.suite,
    mode,
    result,
  );
  result.performanceBudget = performanceBudget;
  result.gate = {
    status: !enforcePerformanceBudget || performanceBudget.status === 'passed' ? 'passed' : 'failed',
    artifactValidatorStatus: 'passed',
    performanceBudgetStatus: performanceBudget.status,
    performanceBudgetRole: enforcePerformanceBudget ? 'blocking-diagnostic-run' : 'diagnostic-only',
    webgpuValidationStatus: result.validation.errorCount === 0 ? 'passed' : 'failed',
  };
  result.evidence = createPerformanceEvidence(root, selected, performanceBudget, result, sourceFingerprint);
  writeArtifact(result);
  if (shouldWriteFormalPerformanceEvidence(mode)) {
    const evidencePath = resolve(root, performanceEvidencePath(selected.id, result.suite));
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (performanceBudget.status !== 'passed') {
    const detail = performanceBudget.violations
      .map(item => `${item.caseId ?? item.rule}${item.channel ? ` [${item.channel}]` : ''}: ${item.reason}`)
      .join('\n');
    if (enforcePerformanceBudget) {
      throw new Error(`AO GPU performance budget failed for ${selected.id}:\n${detail}`);
    }
    console.warn(`[ambient-occlusion:performance] Diagnostic device budget exceeded for ${selected.id}:\n${detail}`);
  }
  printTimingTable(result);
  console.log(
    `[ambient-occlusion:performance] ${performanceBudget.checks.length} P95 checks `
    + `${performanceBudget.status === 'passed' ? 'passed' : 'recorded as diagnostic-only'} for ${selected.id}.`,
  );
}

function writeArtifact(artifact) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`[ambient-occlusion:performance] Wrote ${relative(root, artifactPath)}.`);
}

function printTimingTable(artifact) {
  console.log('AO GPU P50/P95 (ms)');
  console.log('case                         AO p50/p95       denoise p50/p95  upscale p50/p95');
  for (const item of artifact.cases) {
    console.log([
      item.id.padEnd(28),
      timingPair(item.gpu.occlusion).padEnd(16),
      timingPair(item.gpu.denoise).padEnd(16),
      timingPair(item.gpu.upscale),
    ].join(' '));
  }
  const selected = artifact.cases.find(item => item.id === '1080p.medium.r8unorm');
  console.log(
    `Selected r8unorm: ${formatBytes(selected.scratch.totalBytes)} total AO scratch at 1080p; `
    + `${selected.scratch.totalScratchReduction}x below the legacy single full-resolution rgba16float scratch target.`,
  );
}

function timingPair(timing) {
  return `${timing.p50.toFixed(3)}/${timing.p95.toFixed(3)}`;
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function integerArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.find(value => value.startsWith(prefix));
  if (!argument) return fallback;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}
