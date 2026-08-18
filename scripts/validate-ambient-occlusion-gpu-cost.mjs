import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAmbientOcclusionGpuCostArtifact } from './webgpu-gate/ambient-occlusion-gpu-cost-contract.mjs';
import {
  evaluatePerformanceBudget,
  loadPerformanceBudgetConfig,
  selectPerformanceProfile,
} from './webgpu-performance-budget.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = resolve(root, argumentValue('--artifact') ?? 'artifacts/webgpu/ambient-occlusion-gpu-cost.json');
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const config = loadPerformanceBudgetConfig(root);
const suite = config.suites['ambient-occlusion.gpu-cost'];
const mode = argumentValue('--mode') ?? artifact.mode ?? 'smoke';
if (!['smoke', 'full'].includes(mode)) throw new Error(`Unknown AO validation mode ${mode}.`);
const validation = validateAmbientOcclusionGpuCostArtifact(artifact, suite, { mode });
if (validation.status !== 'passed') {
  throw new Error(`AO artifact contract failed:\n- ${validation.violations.join('\n- ')}`);
}
if (artifact.status === 'unavailable') {
  if (mode === 'full') throw new Error(`AO full evidence is unavailable: ${artifact.capabilities.timestampQuery.reason}`);
  console.warn(`[ambient-occlusion:artifact] valid unavailable smoke artifact: ${artifact.capabilities.timestampQuery.reason}`);
} else {
  const profileId = argumentValue('--profile') ?? artifact.evidence?.profile ?? process.env.WEBGPU_DEVICE_PROFILE;
  const selected = selectPerformanceProfile(
    config,
    { nodePlatform: artifact.evidence?.nodePlatform ?? process.platform, adapter: artifact.adapter },
    profileId,
  );
  const budget = evaluatePerformanceBudget(config, selected.id, artifact.suite, mode, artifact);
  if (budget.status !== 'passed') {
    throw new Error(`AO artifact exceeds ${selected.id} budget:\n- ${budget.violations.map(item => `${item.caseId ?? item.rule}: ${item.reason}`).join('\n- ')}`);
  }
  if (artifact.gate?.artifactValidatorStatus !== 'passed'
    || artifact.gate?.performanceBudgetStatus !== 'passed') {
    throw new Error('AO artifact gate summary does not report validator and performance-budget success.');
  }
  console.log(`[ambient-occlusion:artifact] ${budget.checks.length} P95 checks passed for ${selected.id}.`);
}
console.log(`[ambient-occlusion:artifact] Validated ${relative(root, artifactPath)} as ${mode}.`);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
