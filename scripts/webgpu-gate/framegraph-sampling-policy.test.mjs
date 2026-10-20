import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSamplingPlan, validateSamplingConfig, validateSamplingCapture, evaluateCalibration, evaluateSteadyBaseline, validateSamplingPowerContinuity } from './framegraph-sampling-policy.mjs';
const config = JSON.parse(readFileSync(new URL('../../config/framegraph-sampling-021-v4.json', import.meta.url)));
const host = JSON.parse(readFileSync(new URL('../../config/framegraph-performance-021.json', import.meta.url)));
const budgets = { smallSceneCpuP95RegressionRatio: .05, smallSceneGpuP95RegressionRatio: .05 };
import { population } from './framegraph-sampling-test-fixtures.mjs';
test('protocol retains both cases, three AB/BA/AB cohorts, all raw frames and original limits', () => {
  assert.equal(createSamplingPlan(config).length, 12);
  assert.deepEqual(createSamplingPlan(config).slice(4, 6).map(j => j.variant), ['B4', 'A0']);
  for (const c of [ { ...config, regressionRatio: .06 }, { ...config, cases: [config.cases[0]] }, { ...config, sampling: { ...config.sampling, steadyCpuSamples: 300 } }, { ...config, calibration: { ...config.calibration, candidateWarmups: [6000] } }, { ...config, formalReleaseEnrolled: true } ]) assert.throws(() => validateSamplingConfig(c));
});
test('calibration chooses the earliest common plateau without comparing A0/B4 speed', () => {
  const stable = evaluateCalibration(population('calibration', 120, j => j.variant === 'B4' ? 3 : 1), config, host);
  assert.equal(stable.selectedWarmup, 1200);
  const later = evaluateCalibration(population('calibration', 120, (j, i) => j.caseId === 'forward-cap-8' && j.variant === 'B4' && i < 4500 ? 2 : 1), config, host);
  assert.equal(later.selectedWarmup, 6000);
});
test('continuing drift or one unstable cohort prevents a shared warmup', () => {
  const drift = evaluateCalibration(population('calibration', 120, (j, i) => Math.exp(i / 24000)), config, host);
  assert.equal(drift.status, 'failed'); assert.equal(drift.selectedWarmup, null);
  const unstable = evaluateCalibration(population('calibration', 120, j => j.cohort === 2 ? 2 : 1), config, host);
  assert.equal(unstable.status, 'failed');
});

test('extended horizon preserves v1 identity and requires new complete v2 captures', () => {
  const legacy = JSON.parse(readFileSync(new URL('../../config/framegraph-sampling-021-v1.json', import.meta.url)));
  validateSamplingConfig(legacy);
  assert.throws(() => validateSamplingConfig({ ...legacy, calibration: config.calibration }));
  assert.throws(() => validateSamplingConfig({ ...config, calibration: legacy.calibration }));
  const later = population('calibration', 120, (j, i) => Math.exp(Math.max(10000 - i, 0) / 6000));
  assert.equal(evaluateCalibration(later, config, host).selectedWarmup, 12000);
  const latest = population('calibration', 120, (j, i) => Math.exp(Math.max(16000 - i, 0) / 6000));
  assert.equal(evaluateCalibration(latest, config, host).selectedWarmup, 18000);
  const shortened = structuredClone(later);
  shortened[0].result.g09Sampling.timeline.cpu.length = 12000;
  assert.throws(() => evaluateCalibration(shortened, config, host));
  const mislabelled = structuredClone(later);
  mislabelled[0].result.g09Sampling.protocol = legacy.contractId;
  assert.throws(() => evaluateCalibration(mislabelled, config, host));
});
test('fresh baseline rejects 5%+ regression and cannot use a failed calibration', () => {
  const calibration = { status: 'passed', selectedWarmup: 1200 };
  assert.equal(evaluateSteadyBaseline(population('baseline', 1200, j => j.variant === 'B4' ? 1.04 : 1), config, host, calibration, budgets).status, 'passed');
  assert.equal(evaluateSteadyBaseline(population('baseline', 1200, j => j.variant === 'B4' ? 1.06 : 1), config, host, calibration, budgets).status, 'failed');
  assert.throws(() => evaluateSteadyBaseline([], config, host, { status: 'failed', selectedWarmup: 1200 }, budgets));
});
test('host contamination, incomplete cohorts, dropped frames and mismatched populations fail closed', () => {
  for (const mutate of [p => p.pop(), p => p.reverse(), p => { p[0].hostSamples[0].cpu.loadPercent = 16; }, p => { p[0].readiness[0].cpu.loadPercent = 6; }, p => { p[0].readiness.pop(); }, p => { p[0].cooldownMs = 119999; }, p => { p[0].result.adapter.isFallbackAdapter = true; }, p => { p[0].result.g09Sampling.timeline.cpu.pop(); }, p => { p[0].result.timing.rawSamples[0] = 5; }, p => { p[0].result.browserEvidence.product = 'Chrome/154'; }]) {
    const p = population(); mutate(p); assert.throws(() => evaluateCalibration(p, config, host));
  }
});
test('GPU loss, resource leaks, changed scenes and missing startup data remain hard failures', () => {
  const { result, job } = population()[0];
  for (const mutate of [r => { r.g09WholeGpu.rawSamples[0] = 0; }, r => { r.gpuTimestamp.timing.rawSamples.pop(); }, r => { r.g05Forward.cleanup.liveGpuResources = 1; }, r => { r.fixture.dynamicRatio = .5; }, r => { r.setup.pipelineWarmupMs = null; }, r => { r.g09Sampling.timeline.cpuRecord.pop(); }]) {
    const r = structuredClone(result); mutate(r); assert.throws(() => validateSamplingCapture(r, job, config, 'calibration', 120));
  }
});
test('v3 requires controlled AC settings and cannot relabel v2 history', () => {
  const legacy = JSON.parse(readFileSync(new URL('../../config/framegraph-sampling-021-v2.json', import.meta.url)));
  validateSamplingConfig(legacy);
  assert.throws(() => validateSamplingConfig({ ...legacy, powerControl: config.powerControl }));
  assert.throws(() => validateSamplingConfig({ ...config, powerControl: undefined }));
  assert.throws(() => validateSamplingConfig({ ...config, powerControl: { ...config.powerControl, minimumAcPercent: 5 } }));
  for (const mutate of [s => { delete s.powerSettings; }, s => { s.powerSettings.acLineStatus = 0; }, s => { s.powerSettings.minimumAcPercent = 5; }, s => { s.powerSettings.maximumAcPercent = 99; }, s => { s.powerSettings.schemeId = 'other'; }]) {
    const p = population(); mutate(p[0].hostSamples[1]); assert.throws(() => evaluateCalibration(p, config, host), /power/);
  }
  const old = population(); old[0].result.g09Sampling.protocol = legacy.contractId;
  assert.throws(() => evaluateCalibration(old, config, host), /protocol/);
});
test('calibration and fresh baseline must use the same controlled scheme', () => {
  const a = population(), b = population('baseline', 1200);
  validateSamplingPowerContinuity(a, b, config);
  b[0].hostSamples[1].powerScheme.id = 'different';
  assert.throws(() => validateSamplingPowerContinuity(a, b, config), /same controlled/);
});

test('v4 records the Chrome-only policy and preserves v3 historical capture semantics', () => {
  const legacy = JSON.parse(readFileSync(new URL('../../config/framegraph-sampling-021-v3.json', import.meta.url)));
  validateSamplingConfig(legacy);
  assert.throws(() => validateSamplingConfig({ ...legacy, gpuControl: config.gpuControl }), /GPU/);
  for (const change of [undefined, { ...config.gpuControl, value: 0 }, { ...config.gpuControl, applicationCount: 2 }, { ...config.gpuControl, clockLock: true }])
    assert.throws(() => validateSamplingConfig({ ...config, gpuControl: change }), /GPU/);
  for (const mutate of [s => { delete s.gpuPowerPolicy; }, s => { s.gpuPowerPolicy.Found = false; }, s => { s.gpuPowerPolicy.Value = 0; }, s => { s.gpuPowerPolicy.Location = 1; }, s => { s.gpuPowerPolicy.CurrentPredefined = 1; }, s => { s.gpuPowerPolicy.ApplicationName = 'other.exe'; }, s => { s.gpuPowerPolicy.ApplicationCount = 2; }, s => { s.gpuPowerPolicy.SettingId++; }]) {
    const p = population(); mutate(p[0].hostSamples[1]);
    assert.throws(() => evaluateCalibration(p, config, host), /GPU/);
  }
  const p = population();
  p[0].hostSamples[1].gpu.rows[0][1] = '560.94';
  assert.throws(() => evaluateCalibration(p, config, host), /NVIDIA/);
});