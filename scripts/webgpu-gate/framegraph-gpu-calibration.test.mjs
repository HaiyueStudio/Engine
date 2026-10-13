import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { population } from './framegraph-sampling-test-fixtures.mjs';
import { createSamplingPlan, validateSamplingConfig, validateSamplingCapture, validateSamplingCorrectness, evaluateGpuCalibration, evaluateCalibration, evaluateSteadyBaseline } from './framegraph-sampling-policy.mjs';
import { summarizeTimingSamples } from '../benchmark/timing-cohorts.mjs';
const config = JSON.parse(readFileSync(new URL('../../config/framegraph-sampling-021.json', import.meta.url)));
const host = JSON.parse(readFileSync(new URL('../../config/framegraph-performance-021.json', import.meta.url)));
const budgets = { smallSceneCpuP95RegressionRatio: .05, smallSceneGpuP95RegressionRatio: .05 };

function gpuEntries(value = () => 1) {
  return createSamplingPlan(config).map(job => ({ job, result: { g09GpuCompletion: {
    frames: Array.from({ length: 10200 }, (_, i) => ({ passSumMs: value(job, i), spanMs: value(job, i) * 2 })),
  } } }));
}

// Complete synthetic evidence for rejection tests; no browser or GPU is mocked by production code.
function completion(warmup, samples, duration) {
  const frames = [], readbacks = []; let sequence = 0, time = 0;
  for (const [phase, count] of [['warmup', warmup], ['measurement', samples]]) {
    for (let first = 0; first < count; first += 8) {
      const ids = [];
      for (let i = first; i < Math.min(first + 8, count); i++) {
        const startMs = time; time += 1;
        const base = BigInt(sequence) * 1000000000n, dt = BigInt(Math.round(duration / 3 * 1e6));
        const ticks = [0n, dt, dt, 2n * dt, 2n * dt, 3n * dt].map(x => base + x);
        const passes = ['main', 'post', 'output'].map(label => ({ label, kind: 'render', durationMs: Number(dt) / 1e6 }));
        frames.push({ phase, index: i, sequence, slot: sequence % 8, startMs, endMs: time, submitAtMs: startMs,
          submitCalls: 1, inFlightUpperBound: i - first + 1, passSumMs: passes.reduce((s, p) => s + p.durationMs, 0),
          spanMs: Number(3n * dt) / 1e6, passes, timestampTicks: ticks.map(String), readbackBatchIndex: readbacks.length });
        ids.push(sequence++);
      }
      for (const id of ids) frames[id].completionObservedMs = time;
      readbacks.push({ index: readbacks.length, frames: ids, firstSubmitMs: frames[ids[0]].submitAtMs,
        lastSubmitMs: frames[ids.at(-1)].submitAtMs, startMs: time, fenceEndMs: time, mapStartMs: time,
        mappedMs: time, endMs: time, fenceWaitMs: 0, waitMs: 0, decodeMs: 0 });
    }
  }
  return { schemaVersion: 1, arm: 'B8', frames, readbacks, submitCalls: sequence, queueWaitRequests: sequence,
    nativeQueueWaitCalls: 0, engineQueueWaitCalls: sequence, batchQueueWaitCalls: readbacks.length, cleanupDrainCalls: 1,
    readbackMaps: readbacks.length, readbackBytes: 16384, readbackSlots: 8, inFlightCap: 8, peakInFlightUpperBound: 8,
    destroyed: true, hooksRestored: true, remainingInFlightUpperBound: 0 };
}
function fullPopulation(mode = 'baseline', gpuWarmup = 600, duration = job => job.variant === 'B4' ? 1.04 : 1) {
  return population(mode, mode === 'calibration' ? 120 : 1200).map(e => {
    const r = e.result, n = mode === 'calibration' ? 10200 - gpuWarmup : 300;
    r.g09Sampling.protocol = config.contractId; r.g09Sampling.gpuWarmup = gpuWarmup;
    r.g09GpuCompletion = completion(gpuWarmup, n, duration(e.job));
    r.gpuTimestamp.timing.rawSamples = r.g09GpuCompletion.frames.slice(gpuWarmup).map(f => f.passSumMs);
    r.g09WholeGpu.rawSamples = r.g09GpuCompletion.frames.slice(gpuWarmup).map(f => f.spanMs);
    r.g09WholeGpu.warmup = gpuWarmup; r.browserEvidence.disableDx12InfoCollection = true;
    return e;
  });
}

test('v5 freezes GPU candidates, completion, browser intervention and original acceptance budgets', () => {
  validateSamplingConfig(config);
  for (const change of [c => c.gpuCalibration.candidateWarmups.push(12000), c => c.gpuCalibration.totalFrames--,
    c => c.gpuCompletion.inFlightCap++, c => c.gpuCompletion.explicitFrameWait = true,
    c => c.browserControl.disableDx12InfoCollection = false, c => c.sampling.gpuSamples--,
    c => c.regressionRatio = .06, c => c.stability.cv = .2, c => c.sampling.dropSamples = true]) {
    const c = structuredClone(config); change(c); assert.throws(() => validateSamplingConfig(c));
  }
});
test('bounded correctness uses its own short population and still validates workload, timestamps and cleanup', () => {
  const { result: r, job } = population('baseline', 1200)[0];
  r.warmup = summarizeTimingSamples([1, 1]);
  r.timing = summarizeTimingSamples(Array(19).fill(1)); r.sampleWall = r.timing;
  r.g09GpuCompletion = completion(5, 19, 1);
  r.gpuTimestamp.timing = summarizeTimingSamples(r.g09GpuCompletion.frames.slice(5).map(f => f.passSumMs));
  r.g09WholeGpu = { scope: 'render-and-compute-span-v1', warmup: 5, rawSamples: r.g09GpuCompletion.frames.slice(5).map(f => f.spanMs) };
  r.browserEvidence.disableDx12InfoCollection = true;
  validateSamplingCorrectness(r, job, config, host);
  assert.throws(() => validateSamplingCorrectness(r, job, config, host, 'S8'));
  r.fixture.localLightCount++;
  assert.throws(() => validateSamplingCorrectness(r, job, config, host));
});
test('GPU selection is earliest shared plateau, independent of speedup and controlled by the last stable group', () => {
  assert.equal(evaluateGpuCalibration(gpuEntries(j => j.variant === 'B4' ? 3 : 1), config).selectedWarmup, 120);
  const late = gpuEntries((j, i) => j.variant === 'A0' && j.caseId === 'forward-cap-8' && i < 650 ? 2 : 1);
  assert.equal(evaluateGpuCalibration(late, config).selectedWarmup, 1200);
});
test('pooled cancellation cannot hide per-cohort GPU drift; either metric can veto calibration', () => {
  const p = gpuEntries((j, i) => {
    const w = i >= 9600 ? 9600 : config.gpuCalibration.candidateWarmups.find(c => i >= c && i < c + 600);
    return w && i >= w + 300 ? j.cohort === 0 ? 1.08 : j.cohort === 1 ? .92 : 1 : 1;
  });
  assert.equal(evaluateGpuCalibration(p, config).status, 'failed');
  const span = gpuEntries();
  for (const e of span) for (const [i, f] of e.result.g09GpuCompletion.frames.entries()) f.spanMs = Math.exp(i / 1000);
  assert.equal(evaluateGpuCalibration(span, config).status, 'failed');
  assert.throws(() => evaluateGpuCalibration(span.slice(1), config));
});
test('combined CPU/GPU calibration requires the complete separately captured v5 population', () => {
  const p = fullPopulation('calibration', 120, () => 1);
  const c = evaluateCalibration(p, config, host);
  assert.equal(c.status, 'passed'); assert.equal(c.selectedWarmup, 1200); assert.equal(c.selectedGpuWarmup, 120);
  p[0].result.g09GpuCompletion.frames.pop();
  assert.throws(() => evaluateCalibration(p, config, host));
});
test('fresh B8 baseline keeps 5% GPU regression gate and requires frozen shared GPU warmup', () => {
  const c = { status: 'passed', selectedWarmup: 1200, selectedGpuWarmup: 600, gpu: { status: 'passed', selectedWarmup: 600 } };
  assert.equal(evaluateSteadyBaseline(fullPopulation(), config, host, c, budgets).status, 'passed');
  assert.equal(evaluateSteadyBaseline(fullPopulation('baseline', 600, j => j.variant === 'B4' ? 1.06 : 1), config, host, c, budgets).status, 'failed');
  assert.throws(() => evaluateSteadyBaseline(fullPopulation(), config, host, { ...c, selectedGpuWarmup: 1200 }, budgets));
  assert.throws(() => evaluateSteadyBaseline(fullPopulation(), config, host, { ...c, gpu: { status: 'failed' } }, budgets));
});
test('dropping, replacing, reordering or misdecoding GPU frames and suppressing retirement fails', () => {
  const e = fullPopulation()[0];
  for (const change of [r => r.g09GpuCompletion.frames.splice(10, 1), r => r.gpuTimestamp.timing.rawSamples.reverse(),
    r => r.g09GpuCompletion.engineQueueWaitCalls--, r => r.g09GpuCompletion.frames[0].spanMs++,
    r => r.g09GpuCompletion.frames[0].timestampTicks[0] = 'bad', r => r.browserEvidence.disableDx12InfoCollection = false,
    r => r.g09GpuCompletion.readbacks.at(-1).frames.pop(), r => r.g09GpuCompletion.remainingInFlightUpperBound++]) {
    const r = structuredClone(e.result);
    // Distinguish reordered samples even when the synthetic steady timeline is flat.
    if (change.toString().includes('reverse')) r.gpuTimestamp.timing.rawSamples[0] += 1;
    change(r); assert.throws(() => validateSamplingCapture(r, e.job, config, 'baseline', 1200, 600));
  }
});
