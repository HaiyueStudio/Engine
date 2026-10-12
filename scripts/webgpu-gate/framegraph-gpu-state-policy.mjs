import { summarizeTimingSamples } from '../benchmark/timing-cohorts.mjs';
import { validateSamplingCapture } from './framegraph-sampling-policy.mjs';

export const GPU_STATE_PROTOCOL = Object.freeze({
  schemaVersion: 1, id: 'g09-single-light-gpu-state-v1', caseId: 'forward-small-1',
  cpuWarmup: 120, cpuSamples: 23880, gpuWarmup: 120, gpuSamples: 10080,
  intervalMs: 200, maximumTelemetryGapMs: 1000, windowFrames: 300,
  intervention: 'Identical continuous NVIDIA telemetry for A0 and B4; workload and v5 completion unchanged.',
  performanceQualified: false, createsBaseline: false,
});
export const GPU_STATE_FIELDS = Object.freeze(['uuid', 'name', 'driver_version', 'pstate',
  'clocks.current.graphics', 'clocks.current.memory', 'temperature.gpu', 'utilization.gpu',
  'utilization.memory', 'power.draw', 'clocks_event_reasons.sw_thermal_slowdown',
  'clocks_event_reasons.hw_thermal_slowdown', 'clocks_event_reasons.hw_power_brake_slowdown']);
const check = (condition, message) => { if (!condition) throw Error(message); };
export function gpuStatePlan(smoke = false) {
  return (smoke ? [['A0', 'B4']] : [['A0', 'B4'], ['B4', 'A0'], ['A0', 'B4']])
    .flatMap((variants, cohort) => variants.map(variant => ({ cohort, caseId: GPU_STATE_PROTOCOL.caseId, variant })));
}
export function parseGpuStateLine(line, receivedMs, sequence) {
  const values = line.trim().split(',').map(s => s.trim());
  check(values.length === GPU_STATE_FIELDS.length && Number.isFinite(receivedMs) && Number.isInteger(sequence) && sequence >= 0, 'Invalid GPU telemetry row');
  const fields = Object.fromEntries(GPU_STATE_FIELDS.map((field, i) => [field, values[i]]));
  check(/^GPU-[\da-f-]+$/i.test(fields.uuid) && /^P\d+$/.test(fields.pstate), 'Missing GPU identity/P-state');
  for (const key of GPU_STATE_FIELDS.slice(4, 9)) check(fields[key] !== '' && Number.isFinite(Number(fields[key])) && Number(fields[key]) >= 0, `Missing numeric GPU field: ${key}`);
  check(Number(fields['clocks.current.graphics']) > 0 && Number(fields['clocks.current.memory']) > 0, 'Nonpositive GPU clock');
  for (const key of GPU_STATE_FIELDS.slice(10)) check(['Active', 'Not Active', 'N/A', '[N/A]'].includes(fields[key]), `Invalid throttle field: ${key}`);
  check(/^(?:\d+(?:\.\d+)?|\[?N\/A\]?)$/.test(fields['power.draw']), 'Invalid power reading');
  return { sequence, receivedMs, receivedAt: new Date(receivedMs).toISOString(), fields };
}
const stats = values => { const { rawSamples, ...s } = summarizeTimingSamples(values); return s; };
function stateSummary(rows) {
  const count = key => Object.fromEntries([...new Set(rows.map(r => r.fields[key]))].map(v => [v, rows.filter(r => r.fields[key] === v).length]));
  const ranges = Object.fromEntries(GPU_STATE_FIELDS.slice(4, 10).map(k => {
    const values = rows.map(r => Number(r.fields[k])).filter(Number.isFinite);
    return [k, { available: values.length, unavailable: rows.length - values.length,
      min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null }];
  }));
  return { readings: rows.length, pstate: count('pstate'), ranges,
    throttle: Object.fromEntries(GPU_STATE_FIELDS.slice(10).map(k => [k, count(k)])) };
}
export function analyzeGpuStateCapture(raw, rows, observer, job, config, host, identity) {
  validateSamplingCapture(raw, job, config, 'calibration', 120, 120);
  return analyzeGpuStateTimeline(raw.g09GpuCompletion.frames, raw.g09Sampling.timeline.cpu.length, rows, observer, job, identity);
}
export function analyzeGpuStateTimeline(frames, cpuFrames, rows, observer, job, identity) {
  check(job.caseId === GPU_STATE_PROTOCOL.caseId, 'GPU state diagnosis requires the single-light case');
  check(frames.length === 10200 && cpuFrames === 24000, 'Wrong diagnostic frame population');
  check(observer.stopped === true && observer.stopRequested === true && observer.unexpectedExit === false && !observer.error && observer.rows === rows.length, 'GPU observer failed or did not stop');
  check(rows.length >= 2 && new Set(rows.map(r => r.fields.uuid)).size === 1, 'Missing/mixed GPU telemetry');
  for (const [i, r] of rows.entries()) {
    const parsed = parseGpuStateLine(GPU_STATE_FIELDS.map(k => r.fields[k]).join(','), r.receivedMs, i);
    check(JSON.stringify(parsed) === JSON.stringify(r), 'Changed GPU telemetry shape/order');
    check(!i || r.receivedMs > rows[i - 1].receivedMs, 'Non-monotonic GPU telemetry clock');
    check(r.fields.name === identity.name && r.fields.driver_version === identity.driver, 'GPU telemetry/host device mismatch');
  }
  const begin = frames[0].startMs, end = frames.at(-1).completionObservedMs;
  const before = rows.findLastIndex(r => r.receivedMs <= begin), after = rows.findIndex(r => r.receivedMs >= end);
  check(before >= 0 && after > before, 'GPU phase is not bracketed by telemetry');
  const coverage = rows.slice(before, after + 1), gaps = coverage.slice(1).map((r, i) => r.receivedMs - coverage[i].receivedMs);
  check(Math.max(...gaps) <= GPU_STATE_PROTOCOL.maximumTelemetryGapMs, 'GPU telemetry gap exceeds coverage contract');
  const windows = [];
  // Warmup is reported separately; every measured frame belongs to one window, including the final partial window.
  for (const [phase, offset, count] of [['warmup', 0, 120], ['measurement', 120, 10080]]) {
    for (let n = 0; n < count; n += 300) {
      const group = frames.slice(offset + n, offset + Math.min(n + 300, count));
      const startMs = group[0].startMs, endMs = group.at(-1).completionObservedMs;
      const left = rows.findLastIndex(r => r.receivedMs <= startMs), right = rows.findIndex(r => r.receivedMs >= endMs);
      const inside = rows.filter(r => r.receivedMs >= startMs && r.receivedMs <= endMs);
      windows.push({ phase, startFrame: offset + n, frames: group.length, startMs, endMs,
        passSum: stats(group.map(f => f.passSumMs)), span: stats(group.map(f => f.spanMs)),
        passes: [0, 1, 2].map(i => ({ label: group[0].passes[i].label, timing: stats(group.map(f => f.passes[i].durationMs)) })),
        cpu: stats(group.map(f => f.cpuMs)), explicitQueueWait: stats(group.map(f => f.queueWaitMs)),
        telemetry: { firstSequence: left, lastSequence: right, insideReadings: inside.length,
          bracketBeforeMs: startMs - rows[left].receivedMs, bracketAfterMs: rows[right].receivedMs - endMs,
          ...stateSummary(rows.slice(left, right + 1)) } });
    }
  }
  return { job, frames: frames.length, cpuFrames,
    gpuStartMs: begin, gpuEndMs: end, gpuSeconds: (end - begin) / 1000,
    identity: { uuid: rows[0].fields.uuid, ...identity }, telemetry: { ...stateSummary(coverage), maximumGapMs: Math.max(...gaps) }, windows,
    interpretation: 'Host receipt timestamps bracket frame submission/completion, not GPU execution timestamps. 200 ms readings are sampled state evidence; they do not assign exact frequency to every frame or establish causality.',
    performanceQualified: false, createsBaseline: false };
}
export function validateGpuStatePopulation(entries, smoke = false) {
  check(JSON.stringify(entries.map(e => e.job)) === JSON.stringify(gpuStatePlan(smoke)), 'Incomplete/reordered GPU state diagnostic population');
  check(entries.every(e => e.status === 'passed' && e.analysis?.frames === 10200 && e.analysis.cpuFrames === 24000 && e.analysis.performanceQualified === false && e.analysis.createsBaseline === false), 'Incomplete diagnostic capture');
  check(new Set(entries.map(e => e.analysis.identity.uuid)).size === 1, 'Mixed diagnostic GPUs');
  return { status: 'diagnostic-complete', captures: entries.length, gpuFrames: entries.length * 10200,
    cpuFrames: entries.length * 24000, performanceQualified: false, createsBaseline: false,
    next: 'Review the single-light GPU state evidence before selecting a common intervention; fresh two-case calibration and baseline are still required.' };
}
