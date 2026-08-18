import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAoCostMatrix } from '../benchmark/ambient-occlusion-cost-model.mjs';
import {
  evaluatePerformanceBudget,
  loadPerformanceBudgetConfig,
} from '../webgpu-performance-budget.mjs';
import { validateAmbientOcclusionGpuCostArtifact } from './ambient-occlusion-gpu-cost-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = loadPerformanceBudgetConfig(root);
const suite = config.suites['ambient-occlusion.gpu-cost'];

test('AO artifact validator covers identity, raw timing, scratch, and bandwidth evidence', () => {
  const artifact = fixtureArtifact();
  const validation = validateAmbientOcclusionGpuCostArtifact(artifact, suite, { mode: 'smoke' });
  assert.equal(validation.status, 'passed');
  const budget = evaluatePerformanceBudget(
    config,
    'apple-integrated',
    'ambient-occlusion.gpu-cost',
    'smoke',
    artifact,
  );
  assert.equal(budget.status, 'passed');
  assert.equal(budget.checks.length, 36);
});

test('AO artifact validator rejects timing, memory, and bandwidth drift', () => {
  const artifact = fixtureArtifact();
  artifact.cases[0].gpu.total.rawSamples[0] = 99;
  artifact.cases[0].scratch.totalBytes += 1;
  artifact.cases[0].estimatedBandwidth.totalBytes += 1;
  const validation = validateAmbientOcclusionGpuCostArtifact(artifact, suite, { mode: 'full' });
  assert.equal(validation.status, 'failed');
  assert.ok(validation.violations.some(item => item.includes('total sample')));
  assert.ok(validation.violations.some(item => item.includes('scratch bytes')));
  assert.ok(validation.violations.some(item => item.includes('estimated bandwidth bytes')));
});

test('AO unavailable artifacts retain an exact timestamp-query reason without fake timings', () => {
  const artifact = {
    schemaVersion: 2,
    suite: 'ambient-occlusion.gpu-cost',
    status: 'unavailable',
    generatedAt: '2026-07-30T00:00:00.000Z',
    browser: 'fixture browser',
    adapter: { vendor: 'fixture' },
    capabilities: {
      timestampQuery: { status: 'unavailable', reason: 'timestamp-query is not exposed' },
    },
    cases: [],
  };
  assert.equal(
    validateAmbientOcclusionGpuCostArtifact(artifact, suite, { mode: 'smoke' }).status,
    'passed',
  );
  artifact.capabilities.timestampQuery.reason = '';
  assert.equal(
    validateAmbientOcclusionGpuCostArtifact(artifact, suite, { mode: 'smoke' }).status,
    'failed',
  );
});

function fixtureArtifact() {
  const cases = createAoCostMatrix().map(cost => ({
    id: cost.id,
    resolution: cost.resolution,
    quality: cost.quality,
    scratchFormat: cost.scratchFormat,
    scratch: { ...cost.scratch },
    estimatedBandwidth: { ...cost.estimatedBandwidth },
    gpu: {
      occlusion: timing([1, 1, 1]),
      denoise: timing([1, 1, 1]),
      upscale: timing([1, 1, 1]),
      total: timing([3, 3, 3]),
    },
  }));
  return {
    schemaVersion: 2,
    suite: 'ambient-occlusion.gpu-cost',
    status: 'passed',
    generatedAt: '2026-07-30T00:00:00.000Z',
    browser: 'fixture browser',
    adapter: { vendor: 'apple' },
    capabilities: { timestampQuery: { status: 'available', reason: null } },
    configuration: {
      algorithm: 'gtao',
      sampleCount: 3,
      resolutionScale: 0.5,
      caseCount: 18,
    },
    formatDecision: {
      selected: 'r8unorm',
      optionalFloatFilteringRequired: false,
    },
    cases,
    validation: { errorCount: 0, errors: [] },
  };
}

function timing(rawSamples) {
  return {
    sampleCount: rawSamples.length,
    p50: rawSamples[1],
    p95: rawSamples[2],
    min: rawSamples[0],
    max: rawSamples[2],
    rawSamples: [...rawSamples],
  };
}
