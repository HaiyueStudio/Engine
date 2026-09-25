import { summarizeTimingSamples } from './timing-cohorts.mjs';

export const G01_SAMPLING = Object.freeze({ warmup: 120, samples: 300, cohorts: 3 });
export const canonicalInputPaths = paths => [...new Set(paths)].sort();

// Judge all cohorts; a fast pooled percentile does not excuse round-to-round drift.
export function assessG01Stability(cohortP95) {
  if (!Array.isArray(cohortP95) || cohortP95.length !== G01_SAMPLING.cohorts ||
      !cohortP95.every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Need three positive finite cohort P95 values');
  }
  const stats = summarizeTimingSamples(cohortP95);
  const relativeSpread = (stats.max - stats.min) / stats.p50;
  const cv = stats.relativeStandardDeviation;
  return { cohortP95: [...cohortP95], relativeSpread, cv, stable: relativeSpread <= 0.2 && cv <= 0.1 };
}

export function assessG01Readiness({ failures, unstableCases, contractFailures, hostFailures = [] }) {
  return {
    captureIntegrity: failures.length ? 'failed' : 'passed',
    budgetFreezeReadiness: failures.length || unstableCases.length || contractFailures.length || hostFailures.length ? 'not-ready' : 'ready',
  };
}
export const G01_BASELINE_CASES = Object.freeze([
  { id: 'forward-small-1', fixture: 'lighting', lights: 1, views: 1, dynamic: 0, overlap: 'low' },
  { id: 'forward-cap-8', fixture: 'lighting', lights: 8, views: 1, dynamic: 0, overlap: 'high' },
  { id: 'forward-overflow-128-four-view', fixture: 'lighting', lights: 128, views: 4, dynamic: 1, overlap: 'high' },
  { id: 'instances-1k', fixture: 'instances', count: 1000 },
  { id: 'instances-10k', fixture: 'instances', count: 10000 },
]);

export function validateG01Baseline(report, { samples = G01_SAMPLING.samples } = {}) {
  const errors = [];
  if (report.adapter?.isFallbackAdapter !== false || /swiftshader|software/i.test(JSON.stringify(report.adapter))) errors.push('software or unidentified native adapter');
  if (!report.adapter?.vendor || !report.adapter?.architecture) errors.push('missing adapter identity');
  const instances = report.suite === 'lighting.g01.existing-instances';
  const cpu = instances ? report.timing?.cpuRecord : report.timing;
  const gpu = instances ? report.timing?.gpuTimestamp?.timing : report.gpuTimestamp?.timing;
  for (const [name, timing] of [['CPU', cpu],['GPU',gpu]]) {
    if (timing?.rawSamples?.length !== samples) { errors.push(`${name} population mismatch`); continue; }
    try {
      const recomputed = summarizeTimingSamples(timing.rawSamples);
      if (recomputed.p95 !== timing.p95 || !timing.rawSamples.some(n => n > 0)) errors.push(`${name} invalid statistics`);
    } catch { errors.push(`${name} invalid sample`); }
  }
  if (instances) {
    if (report.validationErrors !== 0 || report.normalFrameInstanceReadbackBytes !== 0) errors.push('instance validation/readback');
    if (!Array.isArray(report.counts) || report.counts.reduce((a,b)=>a+b,0) !== report.count) errors.push('instance coverage');
  } else {
    if (report.execution?.validation?.errorCount !== 0 || report.execution?.ownerCleanup?.ownerResidual?.value !== 0) errors.push('lighting validation/cleanup');
    if (report.sceneProvenance?.matches !== true) errors.push('scene provenance');
  }
  return errors;
}

export function poolG01Cohorts(reports, samples = G01_SAMPLING.samples) {
  if (reports.length !== G01_SAMPLING.cohorts) throw new Error('Need all three cohorts');
  const identity = JSON.stringify(reports[0].adapter);
  const inputIdentity = report => JSON.stringify(report.httpProvenance?.files?.map(f => [f.sourcePath,f.sha256,f.byteLength]));
  const inputs = inputIdentity(reports[0]);
  for (const r of reports) {
    const errors = validateG01Baseline(r, { samples });
    if (errors.length) throw new Error(errors.join('; '));
    if (JSON.stringify(r.adapter) !== identity) throw new Error('Adapter changed');
    if (inputs && inputIdentity(r) !== inputs) throw new Error('Served inputs changed');
  }
  const instances = reports[0].suite === 'lighting.g01.existing-instances';
  const cpu = reports.flatMap(r => (instances ? r.timing.cpuRecord : r.timing).rawSamples);
  const gpu = reports.flatMap(r => (instances ? r.timing.gpuTimestamp.timing : r.gpuTimestamp.timing).rawSamples);
  return { adapter: reports[0].adapter, cpu: summarizeTimingSamples(cpu), gpu: summarizeTimingSamples(gpu) };
}

export function validateDeferred021Contract(c, { requireFrozen = false } = {}) {
  const e=[];
  if(!c || typeof c!=='object' || !c.layout || !c.memory || !Array.isArray(c.devices) || !Array.isArray(c.cases)) return ['schema'];
  if(c.schemaVersion!==1 || c.contractId!=='engine-deferred-021-v1') e.push('schema');
  if(requireFrozen && c.state!=='frozen') e.push('not frozen');
  if(c.sampling?.warmupFrames<120 || c.sampling?.samplesPerCohort<300 || c.sampling?.cohorts<3 || c.sampling?.dropSlowSamples!==false) e.push('sampling');
  const host=c.sampling?.hostEvidence;
  if(host?.command!=='pmset -g therm' || host.when!=='before-and-after-each-capture' || host.cpuSpeedLimit!==100 || host.cpuSchedulerLimit!==100) e.push('host evidence policy');
  if(c.devices?.length!==2 || new Set(c.devices.map(d=>d.class)).size!==2) e.push('device classes');
  if(requireFrozen && c.devices.some(d=>d.absoluteBudgetStatus!=='frozen' || ![d.cpuP95Ms,d.gpuP95Ms].every(v=>Number.isFinite(v)&&v>0))) e.push('unfrozen absolute budget');
  const l=c.layout,m=c.memory;
  if(JSON.stringify(l?.gbufferColorFormats)!==JSON.stringify(['rgba16float','rgba16float','rgba16float']) || l.depthFormat!=='depth32float' || l.colorBytesPerPixel!==24 || l.depthBytesPerPixel!==4 || l.sampleCount!==1) e.push('G-buffer layout');
  if(l.localCapacity<1024 || l.lightStrideBytes!==64 || l.tileSizePixels!==16 || l.tileIndexCapacity!==128 || l.tileHeaderBytes!==16 || l.indexStrideBytes!==4 || l.overflow!=='same-frame-full-view-list' || l.viewHeaderBytes!==32 || l.viewAmbientAggregateCapacity!==1) e.push('light ABI');
  const bytes=(l.colorBytesPerPixel+l.depthBytesPerPixel)*m.maxWidth*m.maxHeight + Math.ceil(m.maxWidth/l.tileSizePixels)*Math.ceil(m.maxHeight/l.tileSizePixels)*(l.tileHeaderBytes+l.tileIndexCapacity*l.indexStrideBytes) + l.localCapacity*4+l.viewHeaderBytes;
  if(bytes>m.maxDeferredBytesPerViewGeneration || m.maxDeferredBytesPerViewGeneration*m.maxViews*m.maxLiveTargetGenerations>m.maxDeferredTargetBytesTotal) e.push('memory budget');
  if(c.correctness?.eligibleLightOmissions!==0 || c.correctness?.validationErrors!==0 || c.correctness?.ownerResidual!==0) e.push('correctness');
  if(c.relativeBudgets?.smallSceneGpuP95RegressionRatio>.05 || c.relativeBudgets?.smallSceneCpuP95RegressionRatio>.05) e.push('small scene regression');
  const ids=c.cases?.map(x=>x.id)??[];
  if(ids.length!==new Set(ids).size || !['A','B','C','D','E','F','G'].every(g=>c.cases.some(x=>x.group===g)))e.push('case coverage');
  for(const id of ['lights-9','lights-128','lights-256','cull-forced-tile-overflow','material-transparent','dynamic-128-four-view','instances-10000-4v','stress-1024']) if(!ids.includes(id))e.push(`missing ${id}`);
  return e;
}
