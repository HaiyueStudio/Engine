import { decodePng } from '../visual-regression/png.mjs';
export const PRODUCTION_CONTRACT = 'g09-presented-production-v2';
const finitePositive = n => Number.isFinite(n) && n > 0;
export function validateProductionConfig(config) {
  if (config?.schemaVersion !== 1 || ![PRODUCTION_CONTRACT,'g09-presented-production-v1'].includes(config.contractId) || !config.device?.gpu ||
      !config.device?.vendor || !config.device?.architecture || !config.device?.cpu || !finitePositive(config.device?.refreshHz) ||
      !config.quality || !config.startupBoundary || !config.measurement) throw Error('Missing production identity');
  if (config.contractId === PRODUCTION_CONTRACT && (config.readiness?.mode !== 'submitted-frames-complete' || config.readiness.frames !== 2 || config.readiness.interactivePacingRequired !== true)) throw Error('Missing loading/readiness boundary');
  if (config.contractId !== PRODUCTION_CONTRACT && config.readiness) throw Error('Legacy profile cannot acquire a new readiness boundary');
  for (const key of ['targetFps','frameP95Ms','frameP99Ms','longFrameThresholdMs','maxLongFrameRatio','maxConsecutiveLongFrames','durationSeconds']) {
    if (!finitePositive(config[key])) throw Error(`Invalid production threshold ${key}`);
  }
  if (config.maxLongFrameRatio > 1 || config.frameP95Ms > config.frameP99Ms || config.frameP99Ms > config.longFrameThresholdMs ||
      config.durationSeconds < 30 || !finitePositive(config.warmupBoundary?.seconds) || config.warmupBoundary.seconds < 10 ||
      !Number.isSafeInteger(config.maxConsecutiveLongFrames) || config.cohortPlan?.rounds !== 2 || config.cohortPlan?.retry !== false ||
      JSON.stringify(config.browser) !== '["chrome-windows","edge-windows"]') throw Error('Incomplete production population');
  if (!Array.isArray(config.workloads) || new Set(config.workloads.map(w => w.id)).size !== config.workloads.length) throw Error('Duplicate/missing workloads');
  for (const group of ['F0','F1','F2','F3','F4','F5','F8']) if (!config.workloads.some(w => w.group === group)) throw Error(`Missing ${group}`);
  for (const w of config.workloads) if (!w.id || !['forward','reference','tiled'].includes(w.algorithm) || !['normal','stress'].includes(w.class) ||
      !['none','gtao','taa-blur','rtt','mirror'].includes(w.effect) || ![1,4].includes(w.views) || !Number.isSafeInteger(w.lights) || w.lights < 1 || w.lights > 1024 ||
      w.resolution?.length !== 2 || !w.resolution.every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Invalid production workload');
  return config;
}
export function productionPlan(config) {
  validateProductionConfig(config);
  return [1,2].flatMap(round => (round === 1 ? config.workloads : [...config.workloads].reverse()).flatMap(w =>
    (round === 1 ? config.browser : [...config.browser].reverse()).map(browserId => ({ round, caseId: w.id, browserId }))));
}
export function productionDiagnosticPlan(config) {
  validateProductionConfig(config);
  return config.workloads.filter(w => w.class === 'stress').flatMap(w =>
    config.browser.map(browserId => ({ round: 1, caseId: w.id, browserId })));
}
export function summarizePacing(intervals, threshold) {
  if (!intervals.length || !intervals.every(finitePositive)) throw Error('Missing/nonpositive frame intervals');
  const sorted = [...intervals].sort((a,b) => a-b), percentile = q => sorted[Math.ceil(q * sorted.length) - 1];
  let consecutive = 0, maxConsecutive = 0, longFrames = 0;
  for (const n of intervals) { consecutive = n > threshold ? consecutive + 1 : 0; if (n > threshold) longFrames++; maxConsecutive = Math.max(maxConsecutive, consecutive); }
  return { frames: intervals.length, averageFps: 1000 * intervals.length / intervals.reduce((a,b) => a+b,0),
    p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: sorted.at(-1), longFrames,
    longFrameRatio: longFrames / intervals.length, maxConsecutiveLongFrames: maxConsecutive };
}
export function validateProductionScreenshot(bytes) {
  const { width, height, data } = decodePng(bytes);
  if (width < 1280 || height < 720) throw Error('Screenshot clips production canvas');
  let colored = 0, lit = 0;
  for (let y=0;y<720;y++) for (let x=0;x<1280;x++) {
    const offset=(y*width+x)*4, rgb=[data[offset],data[offset+1],data[offset+2]];
    if (Math.max(...rgb)-Math.min(...rgb) > 12) colored++;
    if (rgb.reduce((a,b)=>a+b,0) > 30) lit++;
  }
  const result = { width,height,coloredRatio:colored/(1280*720),litRatio:lit/(1280*720) };
  // Independent empty/occluded-room guard, not an A0/B4 pixel-equivalence oracle.
  if (result.coloredRatio < .01 || result.litRatio < .1) throw Error('Empty or occluded production room');
  return result;
}
export function assessProductionCapture(raw, config, job) {
  validateProductionConfig(config);
  const spec = config.workloads.find(w => w.id === job.caseId);
  if (!spec || !config.browser.includes(job.browserId) || ![1,2].includes(job.round) || raw?.schemaVersion !== 1 ||
      raw.contractId !== config.contractId || raw.caseId !== spec.id || raw.status !== 'captured' ||
      raw.measurement !== 'engine-rAF-cadence-visible-canvas' || raw.browserEvidence?.presentationMode !== 'visible-window' ||
      !raw.browserEvidence?.nativeBackend || raw.adapter?.isFallbackAdapter !== false ||
      raw.adapter.vendor !== config.device.vendor || raw.adapter.architecture !== config.device.architecture ||
      !Array.isArray(raw.errors) || raw.errors.length || raw.browserDiagnostics?.unclassifiedFailureCount !== 0) throw Error('Invalid/non-native presented capture');
  const ua = raw.browserEvidence.userAgent ?? '';
  if (/Headless/i.test(ua) || (job.browserId === 'edge-windows' ? !/Edg\//.test(ua) : /Edg\//.test(ua) || !/Chrome\//.test(ua))) throw Error('Browser identity mismatch');
  if (raw.initial?.width !== spec.resolution[0] || raw.initial?.height !== spec.resolution[1] || raw.final?.width !== spec.resolution[0] ||
      raw.final?.height !== spec.resolution[1] || raw.final?.lights !== spec.lights || raw.final?.boxes !== 256 ||
      raw.final?.views !== spec.views + Number(spec.effect === 'rtt')) throw Error('Workload/resolution changed');
  if (spec.algorithm !== 'forward' && (!raw.final.lighting?.completeCoverage || raw.final.lighting.effective !== `deferred-${spec.algorithm}` || raw.final.lighting.submittedPoints !== spec.lights)) throw Error('Lighting coverage/fallback mismatch');
  const effects = spec.effect === 'gtao' ? ['GtaoPass'] : spec.effect === 'taa-blur' ? ['TaaPass','GaussianBlurPass'] : [];
  if (JSON.stringify(raw.final.effects) !== JSON.stringify(effects)) throw Error('Effect quality changed');
  if (raw.cleanup?.resources !== 0 || raw.cleanup?.estimatedBytes !== 0) throw Error('Cleanup resource residual');
  const f = raw.frames;
  if (!Array.isArray(raw.events) || !finitePositive(raw.screen?.innerWidth) || !finitePositive(raw.screen?.innerHeight) ||
      !Number.isFinite(Date.parse(raw.startedAt)) || !Number.isFinite(Date.parse(raw.finishedAt)) || Date.parse(raw.finishedAt) < Date.parse(raw.startedAt) ||
      !finitePositive(raw.startMs) || !finitePositive(raw.firstSubmissionMs) ||
      !Array.isArray(f) || f.length < 3 || !finitePositive(raw.firstFrameMs) || f[0][0] !== raw.firstFrameMs ||
      raw.firstSubmissionMs !== f[0][2] || raw.firstFrameMs < raw.startMs) throw Error('Missing startup/frames');
  for (let i=0;i<f.length;i++) if (f[i].length !== 5 || !f[i].every(Number.isFinite) || f[i][2] < f[i][1] ||
      (i && f[i][0] <= f[i-1][0]) || ![0,1].includes(f[i][3]) || ![0,1].includes(f[i][4])) throw Error('Corrupt/reordered frame');
  const start = raw.firstFrameMs + config.warmupBoundary.seconds*1000, end = start + config.durationSeconds*1000;
  if (f.at(-1)[0] < end || f.at(-2)[0] >= end) throw Error('Truncated or extended measurement window');
  const intervals = [], cold = [], cpu = [];
  for (let i=1;i<f.length;i++) { const delta=f[i][0]-f[i-1][0];
    if (f[i-1][0] >= start) { intervals.push(delta); cpu.push(f[i][2]-f[i][1]); } else cold.push(delta);
  }
  const steady = summarizePacing(intervals, config.longFrameThresholdMs), startup = summarizePacing(cold, config.longFrameThresholdMs);
  let loading;
  if (config.readiness) {
    if (!Number.isFinite(raw.sceneInitializedMs) || raw.sceneInitializedMs < raw.startMs || !Number.isFinite(raw.readyMs) ||
        raw.readyMs > raw.firstSubmissionMs || raw.preparation?.length !== config.readiness.frames) throw Error('Missing readiness evidence');
    let previous = raw.sceneInitializedMs;
    for (const row of raw.preparation) {
      if (![row.start,row.submitted,row.completed].every(Number.isFinite) || row.start < previous || row.submitted < row.start || row.completed < row.submitted) throw Error('Corrupt loading submission/completion');
      previous = row.completed;
    }
    if (raw.readyMs < previous) throw Error('Readiness precedes GPU completion');
    loading = { navigationToReadyMs:raw.readyMs, sceneInitializedMs:raw.sceneInitializedMs, preparation:raw.preparation };
  }
  const failures = ['frameP95Ms','frameP99Ms','maxLongFrameRatio','maxConsecutiveLongFrames'].filter((key,i) =>
    steady[['p95Ms','p99Ms','longFrameRatio','maxConsecutiveLongFrames'][i]] > config[key]);
  if (config.readiness) for (const [key,metric] of [['frameP95Ms','p95Ms'],['frameP99Ms','p99Ms'],['maxLongFrameRatio','longFrameRatio'],['maxConsecutiveLongFrames','maxConsecutiveLongFrames']]) {
    if (startup[metric] > config[key]) failures.push(`interactiveStartup:${key}`);
  }
  const contamination = [];
  if (f.some(row => !row[3] || !row[4]) || raw.events?.some(e => e.time >= raw.firstFrameMs && e.time <= f.at(-1)[2] && (e.visible !== 'visible' || !e.focused))) contamination.push('window-hidden-or-unfocused');
  if (raw.screen?.innerWidth < 1280 || raw.screen?.innerHeight < 720) contamination.push('canvas-not-fully-visible');
  if (raw.preparation?.some(row => row.visible !== 'visible' || row.focused !== true)) contamination.push('loading-window-hidden-or-unfocused');
  return { status: contamination.length ? 'inconclusive' : failures.length ? 'failed' : 'passed', class: spec.class, steady, startup,
    startupToFirstSubmissionMs: raw.firstSubmissionMs, ...(loading ? {loading} : {}), cpuFrame: summarizePacing(cpu.map(n => Math.max(.000001,n)), config.longFrameThresholdMs),
    failures, contamination, g09Complete: false, releaseQualified: false };
}
