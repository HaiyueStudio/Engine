import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFrameGraphForwardPlan, evaluateFrameGraphForward, validateFrameGraphForwardConfig, validateFrameGraphForwardPixels } from './framegraph-forward-policy.mjs';
import { G05_FORWARD_CASES } from './deferred-g05-forward-policy.mjs';
import { summarizeTimingSamples } from '../benchmark/timing-cohorts.mjs';
import { validateFrameGraphWindowsHost } from './framegraph-windows-host.mjs';
const config = JSON.parse(readFileSync(new URL('../../config/framegraph-performance-021.json', import.meta.url)));
const budgets = { smallSceneCpuP95RegressionRatio: .05, smallSceneGpuP95RegressionRatio: .05 };
test('two black or single-pixel images cannot pass F0 parity', () => {
  const components = 1280 * 720 * 4, bytes = Buffer.alloc(components * 4);
  const image = () => [{ key: 'real-frame-view:0', ldr: { components, encoding: 'float32-le-base64', bytes: bytes.toString('base64') } }];
  assert.throws(() => validateFrameGraphForwardPixels(image()));
  bytes.writeFloatLE(1, 0); bytes.writeFloatLE(1, 12); assert.throws(() => validateFrameGraphForwardPixels(image()));
  for (let i = 3; i < components; i += 4) bytes.writeFloatLE(1, i * 4);
  validateFrameGraphForwardPixels(image());
});
function entries(ratio = 1, drift = false) {
  return createFrameGraphForwardPlan(config, true).map(job => {
    const c = G05_FORWARD_CASES.find(c => c.id === job.caseId), value = job.variant === 'A0' ? 1 : ratio * (drift && job.cohort === 2 ? 1.5 : 1);
    const stats = summarizeTimingSamples(Array(300).fill(value));
    const result = { suite: 'lighting.scaling.real-fixture', adapter: { vendor: 'nvidia', architecture: 'pascal', isFallbackAdapter: false },
      fixture: { localLightCount: c.lights, viewCount: c.views, dynamicRatio: c.dynamic, overlap: c.overlap, resolution: { width: 1280, height: 720 } },
      warmup: { rawSamples: Array(120).fill(1) }, timing: stats, sampleWall: stats, gpuTimestamp: { status: 'available', timing: stats },
      sceneProvenance: { matches: true }, execution: { validation: { errorCount: 0 }, ownerCleanup: { ownerResidual: { value: 0 } } }, renderer: { lightingStrategy: 'forward' },
      g09WholeGpu: { scope: 'render-and-compute-span-v1', warmup: 120, rawSamples: Array(300).fill(value) },
      g05Forward: { schemaVersion: 1, observedMethods: ['createBuffer', 'createTexture', 'createShaderModule', 'createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync'], allocations: [{ method: 'createBuffer', label: 'Forward.frame' }], deferredCreated: [], cleanup: { liveGpuResources: 0, ownerResidual: 0 } } };
    result.browserEvidence = { product: 'Chrome/153' };
    const host = { observedAt: '2026-10-06T00:00:00Z', hostname: config.runner.hostname, platform: 'win32', cpu: { model: config.runner.cpuModel, loadPercent: 1 }, gpu: { rows: [[config.runner.gpuName, config.runner.driverVersion, '50', '0', '139', 'Not Active', 'Not Active', 'Not Active']] }, powerScheme: { id: 'balanced' } };
    return { job, status: 'passed', cooldownMs: 120001, result, hostSamples: [host, { ...host, observedAt: '2026-10-06T00:01:00Z' }] };
  });
}
test('F0 has twelve captures, alternating same-host A0/B4, unchanged workload and protocol', () => {
  const plan = createFrameGraphForwardPlan(config, true);
  assert.equal(plan.length, 12); assert.deepEqual(plan.slice(4, 6).map(j => j.variant), ['B4', 'A0']);
  assert.equal(createFrameGraphForwardPlan(config, false).length, 4);
  for (const patch of [{ cases: ['forward-small-1'] }, { sampling: { ...config.sampling, cpuSamples: 30 } }, { runner: { ...config.runner, formalReleaseEnrolled: true } }])
    assert.throws(() => validateFrameGraphForwardConfig({ ...config, ...patch }));
});
test('a 5%+ regression or cohort drift fails, regardless of otherwise complete native captures', () => {
  assert.equal(evaluateFrameGraphForward(entries(1.04), config, budgets).status, 'passed');
  assert.equal(evaluateFrameGraphForward(entries(1.06), config, budgets).status, 'failed');
  assert.equal(evaluateFrameGraphForward(entries(.7, true), config, budgets).status, 'failed');
  assert.equal(evaluateFrameGraphForward(entries(), config, budgets).performanceQualified, false);
});
test('missing, reordered, stale-size, short cooling and lost timestamp populations cannot pass', () => {
  for (const mutate of [e => e.pop(), e => e.reverse(), e => { e[0].cooldownMs = 119999; }, e => { e[0].result.g09WholeGpu.rawSamples.pop(); },
    e => { e[0].result.fixture.localLightCount = 0; }, e => { e[0].result.g05Forward.cleanup.liveGpuResources = 1; },
    e => { e[0].hostSamples[0].cpu.loadPercent = 72; }, e => { e[0].result.browserEvidence.product = 'Chrome/154'; }]) {
    const e = entries(); mutate(e); assert.throws(() => evaluateFrameGraphForward(e, config, budgets));
  }
});
test('host checks reject background work, wrong hardware, thermal slowdown and power-plan changes', () => {
  const host = { observedAt: '2026-10-06T00:00:00Z', hostname: config.runner.hostname, platform: 'win32', cpu: { model: config.runner.cpuModel, loadPercent: 1 },
    gpu: { rows: [[config.runner.gpuName, config.runner.driverVersion, '50', '0', '139', 'Not Active', 'Not Active', 'Not Active']] }, powerScheme: { id: 'balanced' } };
  validateFrameGraphWindowsHost([host, host], config.runner);
  for (const mutate of [h => { h.cpu.loadPercent = 72; }, h => { h.gpu.rows[0][3] = '80'; }, h => { h.gpu.rows[0][5] = 'Active'; },
    h => { h.gpu.rows[0][1] = 'other-driver'; }, h => { h.powerScheme.id = 'other'; }]) {
    const changed = structuredClone(host); mutate(changed); assert.throws(() => validateFrameGraphWindowsHost([host, changed], config.runner));
  }
});
