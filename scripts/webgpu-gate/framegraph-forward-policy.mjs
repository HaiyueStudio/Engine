import { G05_FORWARD_CASES, validateG05ForwardResult } from './deferred-g05-forward-policy.mjs';
import { assessG01Stability } from '../benchmark/lighting-g01-policy.mjs';
import { summarizeTimingSamples } from '../benchmark/timing-cohorts.mjs';
import { validateFrameGraphWindowsHost } from './framegraph-windows-host.mjs';
const check = (v, message) => { if (!v) throw Error(message); };
export function validateFrameGraphForwardConfig(c) {
  check(c?.schemaVersion === 1 && c.contractId === 'framegraph-021-default-path-preflight-v1', 'Unknown F0 preflight contract');
  check(JSON.stringify(c.cases) === JSON.stringify(G05_FORWARD_CASES.map(c => c.id)), 'F0 case population changed');
  check(JSON.stringify(c.sampling) === JSON.stringify({ warmup: 120, cpuSamples: 300, gpuSamples: 300, cohorts: 3, idleMs: 120000, order: 'AB-BA-AB', dropSamples: false }), 'F0 sampling protocol changed');
  check(c.runner?.formalReleaseEnrolled === false && c.runner.browserId === 'chrome-windows' && c.runner.platform === 'win32', 'This development profile cannot grant formal release qualification');
  check(c.runner.maxBackgroundCpuPercent === 15 && c.runner.maxBackgroundGpuPercent === 10, 'Registered idle-host guards changed');
}
export function createFrameGraphForwardPlan(config, full) {
  validateFrameGraphForwardConfig(config);
  const jobs = [];
  for (let cohort = 0; cohort < (full ? 3 : 1); cohort++)
    for (const caseId of cohort % 2 ? [...config.cases].reverse() : config.cases)
      for (const variant of cohort % 2 ? ['B4', 'A0'] : ['A0', 'B4']) jobs.push({ cohort, caseId, variant, full });
  return jobs;
}
export function validateFrameGraphForwardCapture(raw, job, config) {
  validateG05ForwardResult(raw, job, config.runner);
  const n = job.full ? 300 : 3;
  check(raw.g09WholeGpu?.scope === 'render-and-compute-span-v1' && raw.g09WholeGpu.rawSamples?.length === n && raw.g09WholeGpu.rawSamples.every(v => Number.isFinite(v) && v > 0), 'Missing whole-frame GPU population');
  check(raw.g09WholeGpu.warmup === (job.full ? 120 : 2), 'Missing separate GPU warmup');
}
export function validateFrameGraphForwardPixels(images) {
  check(images?.length === 1 && images[0].key === 'real-frame-view:0', 'Missing F0 output view');
  const image = images[0].ldr, bytes = Buffer.from(image?.bytes ?? '', 'base64');
  check(image?.encoding === 'float32-le-base64' && image.components === 1280 * 720 * 4 && bytes.length === image.components * 4, 'Incomplete F0 output');
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, image.components);
  let rgbMax = 0, covered = 0;
  for (let i = 0; i < values.length; i++) {
    check(Number.isFinite(values[i]), 'Nonfinite F0 pixel');
    if (i % 4 === 3) { if (values[i] >= 1 - 1 / 255) covered++; }
    else rgbMax = Math.max(rgbMax, values[i]);
  }
  check(rgbMax > .1 && covered === 1280 * 720, 'F0 empty/incomplete output cannot furnish paired performance evidence');
}
export function evaluateFrameGraphForward(entries, config, budgets) {
  const plan = createFrameGraphForwardPlan(config, true);
  check(entries.length === plan.length, 'Incomplete F0 cohorts');
  for (const [i, entry] of entries.entries()) {
    check(JSON.stringify(entry.job) === JSON.stringify(plan[i]) && entry.status === 'passed', 'Failed/reordered F0 capture');
    validateFrameGraphForwardCapture(entry.result, entry.job, config);
    validateFrameGraphWindowsHost(entry.hostSamples, config.runner);
    check(Number.isFinite(entry.cooldownMs) && entry.cooldownMs >= config.sampling.idleMs, 'Insufficient measured cooldown');
  }
  check(new Set(entries.map(e => e.result.browserEvidence?.product)).size === 1 && entries[0].result.browserEvidence?.product, 'Mixed/missing F0 browser revisions');
  check(new Set(entries.flatMap(e => e.hostSamples.map(h => h.powerScheme.id))).size === 1, 'F0 cohorts changed power plan');
  check(budgets.smallSceneCpuP95RegressionRatio === .05 && budgets.smallSceneGpuP95RegressionRatio === .05, 'Frozen F0 regression limits changed');
  const rows = [];
  for (const caseId of config.cases) for (const metric of ['cpu', 'gpuPassSum', 'gpuSpan', 'frameWall']) {
    const values = r => metric === 'cpu' ? r.timing.rawSamples : metric === 'gpuPassSum' ? r.gpuTimestamp.timing.rawSamples : metric === 'gpuSpan' ? r.g09WholeGpu.rawSamples : r.sampleWall.rawSamples;
    const groups = Object.fromEntries(['A0', 'B4'].map(variant => {
      const captures = entries.filter(e => e.job.caseId === caseId && e.job.variant === variant);
      const rounds = captures.map(e => summarizeTimingSamples(values(e.result)));
      return [variant, { pooled: summarizeTimingSamples(captures.flatMap(e => values(e.result))), rounds, stability: assessG01Stability(rounds.map(r => r.p95)) }];
    }));
    const ratio = groups.B4.pooled.p95 / groups.A0.pooled.p95;
    rows.push({ caseId, metric, ...groups, ratio, limit: metric === 'frameWall' ? null : 1.05,
      passed: groups.A0.stability.stable && groups.B4.stability.stable && (metric === 'frameWall' || ratio <= 1.05) });
  }
  return { status: rows.every(r => r.passed) ? 'passed' : 'failed', rows, performanceQualified: false,
    scope: 'F0 development regression only; full F0-F8, CPU stage attribution and formal host enrollment remain required' };
}
