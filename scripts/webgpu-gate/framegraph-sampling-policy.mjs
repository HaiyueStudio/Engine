import { summarizeTimingSamples } from '../benchmark/timing-cohorts.mjs';
import { assessG01Stability } from '../benchmark/lighting-g01-policy.mjs';
import { G05_FORWARD_CASES, validateG05ForwardAllocation } from './deferred-g05-forward-policy.mjs';
import { validateFrameGraphWindowsHost } from './framegraph-windows-host.mjs';
const check = (value, message) => { if (!value) throw Error(message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function validateSamplingConfig(c) {
  const horizons = {
    'g09-forward-cold-steady-v1': { total: 12000, candidates: [1200, 3600, 6000] },
    'g09-forward-cold-steady-v2': { total: 24000, candidates: [1200, 3600, 6000, 12000, 18000] },
    'g09-forward-cold-steady-v3': { total: 24000, candidates: [1200, 3600, 6000, 12000, 18000] },
  };
  const horizon = horizons[c?.contractId];
  check(c?.schemaVersion === 1 && horizon, 'Unknown cold/steady protocol');
  check(c.contractId === 'g09-forward-cold-steady-v3'
    ? equal(c.powerControl, { acLineStatus: 1, minimumAcPercent: 100, maximumAcPercent: 100 })
    : c.powerControl === undefined, 'Wrong cold/steady power contract');
  check(c.hostContract === 'config/framegraph-performance-021.json' && c.budgetSource === 'config/lighting-performance-021.json#relativeBudgets', 'Sampling policy ownership changed');
  check(equal(c.cases, G05_FORWARD_CASES.map(c => c.id)), 'Cold/steady workload population changed');
  check(equal(c.sampling, { cohorts: 3, order: 'AB-BA-AB', idleMs: 120000, entryQuietCpuPercent: 5, entryQuietSamples: 3, coldFrames: 120, steadyCpuSamples: 3000, gpuWarmup: 120, gpuSamples: 300, dropSamples: false }), 'Cold/steady sample population changed');
  check(c.calibration.totalCpuFrames === horizon.total && equal(c.calibration.candidateWarmups, horizon.candidates) && c.calibration.windowFrames === 3000 && c.calibration.plateauToleranceRatio === .05, 'Calibration selection rule changed');
  check(c.regressionRatio === .05 && c.stability.relativeSpread === .2 && c.stability.cv === .1 && c.formalReleaseEnrolled === false, 'Regression/stability budget or enrollment changed');
}
export function createSamplingPlan(c) {
  validateSamplingConfig(c);
  const jobs = [];
  for (let cohort = 0; cohort < 3; cohort++) for (const caseId of cohort % 2 ? [...c.cases].reverse() : c.cases)
    for (const variant of cohort % 2 ? ['B4', 'A0'] : ['A0', 'B4']) jobs.push({ cohort, caseId, variant });
  return jobs;
}
function series(values, n, label) {
  check(Array.isArray(values) && values.length === n && values.every(v => Number.isFinite(v) && v >= 0), `Invalid ${label} population (${n} required)`);
}
export function compactStats(values) {
  const { rawSamples, ...stats } = summarizeTimingSamples(values); return stats;
}
export function validateSamplingCapture(raw, job, config, mode, warmup) {
  validateSamplingConfig(config);
  const c = G05_FORWARD_CASES.find(c => c.id === job.caseId), f = raw.fixture, t = raw.g09Sampling;
  check(c && raw.suite === 'lighting.scaling.real-fixture' && f?.localLightCount === c.lights && f.dynamicRatio === c.dynamic && f.overlap === c.overlap && f.viewCount === c.views && f.resolution.width === 1280 && f.resolution.height === 720, 'Different cold/steady workload');
  check(t?.protocol === config.contractId && t.mode === mode && t.warmup === warmup && t.gpuWarmup === 120 && t.coldFrames === 120, 'Wrong cold/steady fixture protocol');
  const samples = mode === 'calibration' ? config.calibration.totalCpuFrames - warmup : config.sampling.steadyCpuSamples;
  check(mode === 'calibration' ? warmup === 120 : mode === 'baseline' && config.calibration.candidateWarmups.includes(warmup), 'Unregistered sampling phase/warmup');
  for (const key of ['cpu', 'cpuUpdate', 'cpuRecord', 'cpuSubmit', 'frameWall', 'queueWait']) series(t.timeline[key], warmup + samples, key);
  series(raw.warmup?.rawSamples, warmup, 'warmup wall');
  series(raw.timing?.rawSamples, samples, 'measured CPU');
  check(equal(raw.timing.rawSamples, t.timeline.cpu.slice(warmup)), 'CPU population is not the complete registered tail');
  check(equal(raw.sampleWall.rawSamples, t.timeline.frameWall.slice(warmup)), 'Frame-wall population mismatch');
  for (const key of ['cpuUpdate', 'cpuRecord', 'cpuSubmit']) check(equal(raw.metrics.timing[key].value.rawSamples, t.timeline[key].slice(warmup)), 'CPU stage population mismatch');
  series(raw.gpuTimestamp?.timing?.rawSamples, 300, 'GPU pass sum');
  series(raw.g09WholeGpu?.rawSamples, 300, 'GPU span');
  check(raw.gpuTimestamp.timing.rawSamples.every(v => v > 0) && raw.g09WholeGpu.rawSamples.every(v => v > 0), 'Zero GPU timestamps');
  check(raw.gpuTimestamp.status === 'available' && raw.g09WholeGpu.scope === 'render-and-compute-span-v1' && raw.g09WholeGpu.warmup === 120, 'Missing separate GPU warmup/span');
  check(raw.sceneProvenance?.matches === true && raw.execution?.validation?.errorCount === 0 && raw.execution?.ownerCleanup?.ownerResidual?.value === 0, 'Scene/validation/cleanup failure');
  check(Number.isFinite(raw.setup?.scenarioMs) && Number.isFinite(raw.setup?.pipelineWarmupMs), 'Missing cold setup timings');
  validateG05ForwardAllocation(raw);
}
function validatePopulation(entries, config, host, mode, warmup) {
  const plan = createSamplingPlan(config);
  check(entries.length === plan.length, 'Incomplete cold/steady cohorts');
  for (const [i, e] of entries.entries()) {
    check(equal(e.job, plan[i]) && e.status === 'passed' && e.cooldownMs >= config.sampling.idleMs, 'Failed/reordered/short-cooled cold/steady cohort');
    validateFrameGraphWindowsHost(e.hostSamples, host.runner, config.powerControl);
    check(e.readiness?.length >= 3 && e.readiness.slice(-3).every(s => s.cpu.loadPercent <= 5), 'Missing three quiet entry observations');
    for (const s of e.readiness.slice(-3)) validateFrameGraphWindowsHost([s, s], host.runner, config.powerControl);
    check(equal(e.readiness.at(-1), e.hostSamples[0]), 'Readiness and pre-capture observation differ');
    validateSamplingCapture(e.result, e.job, config, mode, warmup);
    check(e.result.adapter?.vendor === host.runner.vendor && e.result.adapter.architecture === host.runner.architecture && e.result.adapter.isFallbackAdapter === false, 'Different/software sampling adapter');
  }
  check(entries[0].result.browserEvidence?.product && new Set(entries.map(e => e.result.browserEvidence.product)).size === 1, 'Mixed/missing browser revisions');
  check(new Set(entries.flatMap(e => e.hostSamples.map(s => s.powerScheme.id))).size === 1, 'Mixed power schemes');
}
export function validateSamplingPowerContinuity(calibrationEntries, baselineEntries, config) {
  if (!config.powerControl) return;
  const schemes = [...calibrationEntries, ...baselineEntries].flatMap(e => e.hostSamples.map(s => s.powerScheme.id));
  check(calibrationEntries.length === 12 && baselineEntries.length === 12 && schemes.every(Boolean) && new Set(schemes).size === 1,
    'Calibration and fresh baseline must share the same controlled power scheme');
}
const summarizeGroup = arrays => ({ pooled: compactStats(arrays.flat()), rounds: arrays.map(compactStats), stability: assessG01Stability(arrays.map(v => compactStats(v).p95)) });
export function evaluateCalibration(entries, config, host) {
  validatePopulation(entries, config, host, 'calibration', 120);
  const candidates = config.calibration.candidateWarmups.map(warmup => {
    const rows = [];
    for (const caseId of config.cases) for (const variant of ['A0', 'B4']) {
      const captures = entries.filter(e => e.job.caseId === caseId && e.job.variant === variant);
      const windows = [0, 1].map(w => summarizeGroup(captures.map(e => e.result.g09Sampling.timeline.cpu.slice(warmup + w * 3000, warmup + (w + 1) * 3000))));
      const drift = { p50: windows[1].pooled.p50 / windows[0].pooled.p50 - 1, p95: windows[1].pooled.p95 / windows[0].pooled.p95 - 1 };
      rows.push({ caseId, variant, windows, drift, passed: windows.every(w => w.stability.stable) && Object.values(drift).every(v => Number.isFinite(v) && Math.abs(v) <= .05) });
    }
    return { warmup, rows, passed: rows.every(r => r.passed) };
  });
  const selectedWarmup = candidates.find(c => c.passed)?.warmup ?? null;
  return { status: selectedWarmup === null ? 'failed' : 'passed', selectedWarmup, candidates, performanceQualified: false };
}
export function evaluateSteadyBaseline(entries, config, host, calibration, budgets) {
  check(calibration.status === 'passed' && config.calibration.candidateWarmups.includes(calibration.selectedWarmup), 'A separately accepted calibration is required');
  validatePopulation(entries, config, host, 'baseline', calibration.selectedWarmup);
  check(budgets.smallSceneCpuP95RegressionRatio === .05 && budgets.smallSceneGpuP95RegressionRatio === .05, 'Original 5% budget changed');
  const rows = [];
  for (const caseId of config.cases) for (const metric of ['cpu', 'gpuPassSum', 'gpuSpan', 'frameWall', 'coldCpu']) {
    const values = r => metric === 'cpu' ? r.timing.rawSamples : metric === 'gpuPassSum' ? r.gpuTimestamp.timing.rawSamples : metric === 'gpuSpan' ? r.g09WholeGpu.rawSamples : metric === 'frameWall' ? r.sampleWall.rawSamples : r.g09Sampling.timeline.cpu.slice(0, 120);
    const groups = Object.fromEntries(['A0', 'B4'].map(v => [v, summarizeGroup(entries.filter(e => e.job.caseId === caseId && e.job.variant === v).map(e => values(e.result)))]));
    const gated = !['coldCpu'].includes(metric), ratio = groups.B4.pooled.p95 / groups.A0.pooled.p95;
    const limit = ['cpu', 'gpuPassSum', 'gpuSpan'].includes(metric) ? 1.05 : null;
    rows.push({ caseId, metric, ...groups, ratio, limit, gated,
      passed: groups.A0.stability.stable && groups.B4.stability.stable && (limit === null || ratio <= limit) });
  }
  return { status: rows.filter(r => r.gated).every(r => r.passed) ? 'passed' : 'failed', rows,
    baselineStable: rows.filter(r => r.gated).every(r => r.A0.stability.stable), performanceQualified: false,
    scope: config.scope, coldBudget: 'No pre-existing cold-start ceiling; report values and stability without inventing a waiver or a budget' };
}
