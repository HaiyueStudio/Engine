import { readFileSync } from 'node:fs';
import { createSamplingPlan } from './framegraph-sampling-policy.mjs';
import { G05_FORWARD_CASES } from './deferred-g05-forward-policy.mjs';
import { summarizeTimingSamples } from '../benchmark/timing-cohorts.mjs';
const config = JSON.parse(readFileSync(new URL('../../config/framegraph-sampling-021-v4.json', import.meta.url)));
const host = JSON.parse(readFileSync(new URL('../../config/framegraph-performance-021.json', import.meta.url)));
export function population(mode = 'calibration', warmup = 120, change = () => 1) {
  return createSamplingPlan(config).map(job => {
    const f = G05_FORWARD_CASES.find(c => c.id === job.caseId), n = mode === 'calibration' ? config.calibration.totalCpuFrames : warmup + 3000;
    const cpu = Array.from({ length: n }, (_, i) => change(job, i));
    const timeline = Object.fromEntries(['cpu', 'cpuUpdate', 'cpuRecord', 'cpuSubmit', 'frameWall', 'queueWait'].map(k => [k, [...cpu]]));
    const result = { suite: 'lighting.scaling.real-fixture', fixture: { localLightCount: f.lights, dynamicRatio: f.dynamic, overlap: f.overlap, viewCount: f.views, resolution: { width: 1280, height: 720 } },
      adapter: { vendor: 'nvidia', architecture: 'pascal', isFallbackAdapter: false }, browserEvidence: { product: 'Chrome/153.0.8010.50' },
      g09Sampling: { protocol: config.contractId, mode, warmup, gpuWarmup: 120, coldFrames: 120, timeline },
      timing: summarizeTimingSamples(cpu.slice(warmup)), warmup: summarizeTimingSamples(cpu.slice(0, warmup)), sampleWall: summarizeTimingSamples(cpu.slice(warmup)),
      metrics: { timing: Object.fromEntries(['cpuUpdate', 'cpuRecord', 'cpuSubmit'].map(k => [k, { value: summarizeTimingSamples(timeline[k].slice(warmup)) }])) },
      gpuTimestamp: { status: 'available', timing: summarizeTimingSamples(Array(300).fill(1)) }, g09WholeGpu: { scope: 'render-and-compute-span-v1', warmup: 120, rawSamples: Array(300).fill(1) },
      sceneProvenance: { matches: true }, execution: { validation: { errorCount: 0 }, ownerCleanup: { ownerResidual: { value: 0 } } }, setup: { scenarioMs: 1, pipelineWarmupMs: 1 }, renderer: { lightingStrategy: 'forward' },
      g05Forward: { schemaVersion: 1, allocations: [{ method: 'createBuffer', label: 'Forward.frame' }], observedMethods: ['createBuffer', 'createTexture', 'createShaderModule', 'createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync'], deferredCreated: [], cleanup: { liveGpuResources: 0, ownerResidual: 0 } } };
    const sample = { observedAt: '2026-10-07T00:00:00Z', hostname: host.runner.hostname, platform: 'win32', cpu: { model: host.runner.cpuModel, loadPercent: 1 }, gpu: { rows: [[host.runner.gpuName, host.runner.driverVersion, '50', '0', '139', 'Not Active', 'Not Active', 'Not Active']] }, powerScheme: { id: 'balanced' } };
    sample.powerSettings = { schemaVersion: 1, schemeId: 'balanced', acLineStatus: 1, minimumAcPercent: 100, maximumAcPercent: 100 };
    sample.gpuPowerPolicy = { Found: true, ProfileName: 'Google Chrome', ApplicationName: 'chrome.exe', ApplicationCount: 1, SettingId: 274197361, Type: 0, Location: 0, CurrentPredefined: 0, Value: 1 };
    return { job, status: 'passed', cooldownMs: 120001, readiness: [structuredClone(sample), structuredClone(sample), sample], hostSamples: [sample, structuredClone(sample)], result };
  });
}
