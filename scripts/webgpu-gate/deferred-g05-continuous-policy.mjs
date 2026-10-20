import { G05_ROOM_WORKLOADS } from './deferred-g05-cohort-policy.mjs';
import { validateG05RoomResult } from './deferred-g05-policy.mjs';
import { G05_INSTANCE_VARIANTS, validateG05InstanceResult } from './deferred-g05-instance-policy.mjs';
import { G05_FORWARD_CASES, validateG05ForwardResult } from './deferred-g05-forward-policy.mjs';
import { assessG01Stability } from '../benchmark/lighting-g01-policy.mjs';
import { validateG05ContinuousMemory } from './deferred-g05-continuous-memory.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = x => /^[a-f0-9]{64}$/.test(x ?? '');
export const g05P95 = values => values.toSorted((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
export function validateG05ContinuousConfig(c) {
  if (c?.schemaVersion !== 1 || c.protocolId !== 'g05-windows-continuous-v1' ||
      !same(c.browsers, ['chrome-windows', 'edge-windows']) ||
      !same(c.sampling, { warmupFrames: 120, cpuSamples: 300, gpuSamples: 300, cohorts: 3, interCaseIdleMs: 0, dropSlowSamples: false, retry: false }) ||
      !same(c.device, { platform: 'win32', gpu: 'NVIDIA GeForce GTX 1070 Ti', vendor: 'nvidia', architecture: 'pascal', cpu: 'Intel Core i7-7700' }) ||
      c.frozenBudget?.path !== 'config/lighting-performance-021.json' || c.frozenBudget.deviceId !== 'mac-amd-rdna1' ||
      c.frozenBudget.sha256 !== 'f35f2bb0955836ef3caf4d8219dd4137118c8deb323d66f1d0ad6ca45cce5a5a' ||
      c.forwardBaselineRevision !== '61d40f7bf75e05ec948754d85fdbf70512a21ca8') throw Error('Unregistered G05 continuous protocol');
  return c;
}
export function createG05ContinuousPlan(config, suite) {
  validateG05ContinuousConfig(config);
  if (!['rooms', 'instances', 'forward'].includes(suite)) throw Error('Unknown G05 suite');
  const workloads = suite === 'rooms' ? G05_ROOM_WORKLOADS : suite === 'forward' ? G05_FORWARD_CASES.map(c => ({ caseId: c.id })) :
    [1000, 10000].flatMap(count => [1, 4].flatMap(views => G05_INSTANCE_VARIANTS.map(variant => ({ count, views, variant }))));
  const plan = [];
  for (let cohort = 0; cohort < 3; cohort++) {
    for (const browserId of cohort % 2 ? [...config.browsers].reverse() : config.browsers) {
      const ordered = cohort % 2 ? [...workloads].reverse() : workloads;
      for (const [i, workload] of ordered.entries()) {
        let arms = suite === 'rooms' ? ['tiled', 'reference'] : suite === 'forward' ? ['baseline', 'candidate'] : ['candidate'];
        if ((cohort + i) % 2) arms = arms.toReversed();
        for (const arm of arms) plan.push({ suite, cohort, browserId, ...workload,
          ...(suite === 'rooms' ? { algorithm: arm } : { arm }), preference: 'high-performance', full: true, idleMs: 0 });
      }
    }
  }
  return plan;
}
export function validateG05ContinuousHost(host, config) {
  if (host?.platform !== config.device.platform || !host.cpu?.includes('i7-7700') || !host.hostname || !host.os ||
      !host.hardware?.gpu?.some(g => g.Name === config.device.gpu && typeof g.DriverVersion === 'string') || !host.hardware.power?.trim()) throw Error('Unregistered Windows host');
  return host;
}
export function validateG05ContinuousCapture(e, job, config, { smoke = false } = {}) {
  if (e.schemaVersion !== 1 || e.protocolId !== config.protocolId || !same(e.job, job) || !hash(e.inputs) || !hash(e.harness) ||
      !/^[a-f0-9]{40}$/.test(e.revision ?? '') || typeof e.dirty !== 'boolean' ||
      e.hostSamples?.length !== 2 || e.hostSamples.some(s => !Number.isFinite(s.busyPercent) || s.busyPercent < 0 || s.busyPercent > 100 || !Number.isFinite(Date.parse(s.at)))) throw Error('Unbound continuous capture');
  const r = e.result;
  if (r.adapter?.vendor !== config.device.vendor || r.adapter?.architecture !== config.device.architecture || r.adapter?.isFallbackAdapter !== false ||
      !r.browserEvidence?.nativeBackend || r.browserDiagnostics?.unclassifiedFailureCount !== 0) throw Error('Native browser identity or diagnostics failed');
  const product = r.browserEvidence.product ?? r.browserEvidence.browserProduct;
  if (typeof product !== 'string' || !(job.browserId === 'edge-windows' ? /Edg|Edge/ : /Chrome/).test(product)) throw Error('Wrong browser product');
  const options = { ...job, full: !smoke };
  if (job.suite === 'rooms') {
    validateG05RoomResult(r, options);
    if (!smoke) for (const phase of ['cpu', 'gpu']) {
      for (const key of ['renderPipelinesCreated', 'bindGroupsCreated', 'buffersCreated', 'bufferExpansions', 'bufferRetirements', 'poolMisses', 'hotObjectsCreated']) {
        if (r[`${phase}Metrics`][key] !== 0) throw Error(`Unstable room ${phase} ${key}`);
      }
      for (const type of ['buffer', 'texture']) if (r.resources[phase][type].created !== r.resources.warm[type].created) throw Error(`Unstable room ${type}`);
      if (r.sourceUploads?.[phase]?.after?.sourceUploads - r.sourceUploads?.[phase]?.before?.sourceUploads !== (job.moving ? r.samples : 0)) throw Error('Source upload conservation failed');
    }
  } else if (job.suite === 'instances') {
    validateG05InstanceResult(r, options);
    if (!smoke) for (const p of r.paths) {
      for (const m of [p.metrics, p.gpuMetrics]) for (const key of ['bindGroupsCreated', 'buffersCreated', 'renderPipelinesCreated']) if (m[key] !== 0) throw Error(`Unstable instance ${key}`);
      for (const type of ['buffer', 'texture']) if (p.resources[type].created !== p.resourcesBefore[type].created) throw Error(`Unstable instance ${type}`);
    }
  } else if (job.suite === 'forward') validateG05ForwardResult(r, options, config.device);
  else throw Error('Unknown capture suite');
}
export function validateG05ContinuousCoverage(entries, config, suite) {
  const plan = createG05ContinuousPlan(config, suite);
  if (entries.length !== plan.length) throw Error('Incomplete continuous matrix');
  const identities = new Map();
  for (const [i, e] of entries.entries()) {
    if (!same(e.job, plan[i])) throw Error(`Reordered/replaced G05 job ${i}`);
    validateG05ContinuousCapture(e, plan[i], config);
    const arm = suite === 'forward' ? e.job.arm : 'candidate', identity = [e.inputs, e.harness, e.revision, e.dirty];
    if (identities.has(arm) && !same(identities.get(arm), identity)) throw Error('Mixed source/harness identity');
    identities.set(arm, identity);
    if (arm === 'baseline' && (e.revision !== config.forwardBaselineRevision || e.dirty)) throw Error('Baseline source differs from frozen G01 revision');
  }
  return { captures: entries.length, cohorts: 3 };
}
export function evaluateG05ContinuousBudgets(entries, config, budget, suite) {
  validateG05ContinuousCoverage(entries, config, suite);
  if (budget.contractId !== 'engine-deferred-021-v1' || budget.sampling.aggregation !== 'pool-all-equal-sized-cohorts') throw Error('Unknown frozen budgets');
  const checks = [], stability = [], groups = new Map(), memory = [];
  for (const e of entries) {
    const { job, result: r } = e;
    if (suite === 'rooms') memory.push({ job, ...validateG05ContinuousMemory(r, budget) });
    const key = JSON.stringify([job.browserId, job.caseId, job.count, job.views, job.variant, job.moving, job.algorithm, job.arm]);
    const group = groups.get(key) ?? { job, reports: [] }; group.reports.push(r); groups.set(key, group);
  }
  const addCheck = (job, metric, observed, limit, extra = {}) => {
    if (!Number.isFinite(observed) || !Number.isFinite(limit) || limit <= 0) throw Error(`Missing budget or timing: ${metric}`);
    checks.push({ job, metric, observed, limit, passed: observed <= limit, ...extra });
  };
  const timing = p => ({ cpuP95Ms: g05P95(p.cpu.map(s => s.cpuRuntimeMs)), gpuP95Ms: g05P95(p.gpu.map(s => s.gpuSpanMs)), frameWallP95Ms: g05P95(p.cpu.map(s => s.frameWallMs)) });
  for (const { job, reports } of groups.values()) {
    const paths = suite === 'instances' ? ['candidate', 'reference'] : [suite === 'rooms' ? job.algorithm : job.arm];
    for (const path of paths) {
      const populations = reports.map(r => suite === 'instances' ? r.paths.find(p => p.path === path) : suite === 'rooms' ? r : {
        cpu: r.timing.rawSamples.map((cpuRuntimeMs, i) => ({ cpuRuntimeMs, frameWallMs: r.sampleWall.rawSamples[i] })), gpu: r.gpuTimestamp.timing.rawSamples.map(gpuSpanMs => ({ gpuSpanMs })) });
      for (const metric of suite === 'forward' ? ['cpuP95Ms', 'gpuP95Ms'] : ['cpuP95Ms', 'gpuP95Ms', 'frameWallP95Ms']) {
        const stats = assessG01Stability(populations.map(p => timing(p)[metric]));
        stability.push({ job, path, metric, ...stats, passed: stats.stable });
      }
      if (suite === 'instances' && path !== 'candidate') continue;
      const pooled = { cpu: populations.flatMap(p => p.cpu), gpu: populations.flatMap(p => p.gpu) }, values = timing(pooled);
      if (suite === 'forward') {
        if (job.arm !== 'candidate') continue;
        const base = [...groups.values()].find(g => g.job.browserId === job.browserId && g.job.caseId === job.caseId && g.job.arm === 'baseline');
        for (const metric of ['cpu', 'gpu']) {
          const samples = r => metric === 'cpu' ? r.timing.rawSamples : r.gpuTimestamp.timing.rawSamples;
          const reference = g05P95(base.reports.flatMap(samples)), observed = g05P95(reports.flatMap(samples));
          addCheck(job, `${metric}P95Ratio`, observed / reference, 1 + budget.relativeBudgets[metric === 'cpu' ? 'smallSceneCpuP95RegressionRatio' : 'smallSceneGpuP95RegressionRatio'], { observedP95Ms: observed, baselineP95Ms: reference });
        }
      } else {
        if (suite === 'rooms' && job.algorithm !== 'tiled') continue;
        const caseId = suite === 'instances' ? `instances-${job.count}-${job.views}v` : job.caseId;
        const spec = budget.cases.find(c => c.id === caseId), limits = spec?.absoluteBudgets?.find(b => b.deviceId === config.frozenBudget.deviceId);
        if ((suite === 'instances' || spec?.group === 'E') && !limits) throw Error(`Missing frozen absolute budget ${caseId}`);
        if (limits) for (const metric of ['cpuP95Ms', 'gpuP95Ms', 'frameWallP95Ms']) addCheck(job, metric, values[metric], limits[metric]);
        if (suite === 'rooms' && ['sparse-256', 'overlap-128'].includes(job.caseId)) {
          const reference = [...groups.values()].find(g => g.job.browserId === job.browserId && g.job.caseId === job.caseId && g.job.moving === job.moving && g.job.algorithm === 'reference');
          const sparse = job.caseId === 'sparse-256', metric = s => sparse ? s.cullMs + s.resolveMs : s.gpuSpanMs;
          addCheck(job, sparse ? 'cullLightingRatio' : 'wholeGpuRatio', g05P95(pooled.gpu.map(metric)) / g05P95(reference.reports.flatMap(r => r.gpu).map(metric)),
            sparse ? 1 - budget.relativeBudgets.sparse256CullLightingP95ImprovementRatio : 1 + budget.relativeBudgets.overlap128FrameGpuP95RegressionRatio);
        }
      }
    }
  }
  return { status: checks.every(c => c.passed) && stability.every(c => c.passed) && memory.every(c => c.status === 'passed') ? 'passed' : 'failed',
    checks, stability, memory, scope: `${suite} only; local evidence does not grant final release qualification` };
}
