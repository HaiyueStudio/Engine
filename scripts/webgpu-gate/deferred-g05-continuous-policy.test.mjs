import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateG05ContinuousConfig, createG05ContinuousPlan, validateG05ContinuousCapture, validateG05ContinuousCoverage, evaluateG05ContinuousBudgets } from './deferred-g05-continuous-policy.mjs';
import { validateG05ContinuousMemory } from './deferred-g05-continuous-memory.mjs';
import { summarizeG05ResourceRecords } from './deferred-g05-memory-policy.mjs';
import { valid } from './deferred-g05-test-data.mjs';
import { instanceEvidence } from './deferred-g05-instance-test-data.mjs';
import { G05_FORWARD_CASES } from './deferred-g05-forward-policy.mjs';
import { summarizeTimingSamples } from '../benchmark/timing-cohorts.mjs';
import { auditG05ContinuousReport } from './deferred-g05-continuous-artifact.mjs';

const config = JSON.parse(readFileSync(new URL('../../config/lighting-continuous-021.json', import.meta.url)));
const bytes = readFileSync(new URL('../../config/lighting-performance-021.json', import.meta.url)), budget = JSON.parse(bytes);
const hash = x => createHash('sha256').update(x).digest('hex');
function forward(job) {
  const c = G05_FORWARD_CASES.find(c => c.id === job.caseId), stats = () => summarizeTimingSamples(Array(300).fill(1));
  return { suite: 'lighting.scaling.real-fixture', fixture: { localLightCount: c.lights, viewCount: c.views, dynamicRatio: c.dynamic, overlap: c.overlap, resolution: { width: 1280, height: 720 } },
    warmup: { rawSamples: Array(120).fill(1) }, timing: stats(), sampleWall: stats(), gpuTimestamp: { status: 'available', timing: stats() }, sceneProvenance: { matches: true },
    execution: { validation: { errorCount: 0 }, ownerCleanup: { ownerResidual: { value: 0 } } }, renderer: { lightingStrategy: 'forward' },
    g05Forward: { schemaVersion: 1, observedMethods: ['createBuffer', 'createTexture', 'createShaderModule', 'createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync'],
      allocations: [{ method: 'createBuffer', label: 'Forward.frame' }], deferredCreated: [], cleanup: { liveGpuResources: 0, ownerResidual: 0 } } };
}
function entries(suite) {
  return createG05ContinuousPlan(config, suite).map(job => {
    const r = suite === 'rooms' ? valid({ ...job, suite: 'g05-room' }) : suite === 'instances' ? instanceEvidence(job).result : forward(job);
    r.adapter = { vendor: 'nvidia', architecture: 'pascal', isFallbackAdapter: false };
    r.browserEvidence = { nativeBackend: true, product: job.browserId === 'edge-windows' ? 'Edg/155' : 'Chrome/154' };
    r.browserDiagnostics = { unclassifiedFailureCount: 0 };
    return { schemaVersion: 1, protocolId: config.protocolId, job, inputs: (job.arm === 'baseline' ? 'a' : 'b').repeat(64), harness: 'c'.repeat(64),
      revision: job.arm === 'baseline' ? config.forwardBaselineRevision : 'd'.repeat(40), dirty: job.arm !== 'baseline',
      hostSamples: Array.from({ length: 2 }, () => ({ busyPercent: 10, at: '2026-10-13T00:00:00.000Z' })), result: r };
  });
}
test('continuous protocol preserves frozen bytes, full workload populations and paired baseline order', () => {
  assert.equal(hash(bytes), config.frozenBudget.sha256); validateG05ContinuousConfig(config);
  for (const [suite, count] of [['rooms', 156], ['instances', 96], ['forward', 24]]) {
    const plan = createG05ContinuousPlan(config, suite); assert.equal(plan.length, count);
    for (const browserId of config.browsers) for (let cohort = 0; cohort < 3; cohort++) {
      assert.equal(plan.filter(j => j.browserId === browserId && j.cohort === cohort).length, count / 6);
    }
    assert.ok(plan.every(j => j.full && j.idleMs === 0 && j.preference === 'high-performance'));
  }
  for (const mutate of [c => c.sampling.cpuSamples = 299, c => c.sampling.dropSlowSamples = true, c => c.sampling.retry = true,
    c => c.browsers.pop(), c => c.device.vendor = 'amd', c => c.frozenBudget.sha256 = 'f'.repeat(64)]) {
    const c = structuredClone(config); mutate(c); assert.throws(() => validateG05ContinuousConfig(c), /Unregistered/);
  }
});
test('native capture validates raw samples, browser, cleanup and source upload conservation', () => {
  const e = entries('rooms')[0]; validateG05ContinuousCapture(e, e.job, config);
  for (const mutate of [e => e.result.adapter.vendor = 'amd', e => e.result.browserEvidence.nativeBackend = false, e => e.result.browserDiagnostics.unclassifiedFailureCount++,
    e => e.result.browserEvidence.product = 'Edg/155', e => e.result.cpu.pop(), e => e.result.cleanup.ownerResidual++, e => e.result.sourceUploads.cpu.after.sourceUploads++,
    e => e.result.cpuMetrics.buffersCreated++, e => e.hostSamples[1].busyPercent = 101, e => e.harness = '']) {
    const row = structuredClone(e); mutate(row); assert.throws(() => validateG05ContinuousCapture(row, e.job, config));
  }
});
test('coverage rejects dropped, reordered, mixed and wrong-baseline captures', () => {
  const all = entries('forward'); assert.equal(validateG05ContinuousCoverage(all, config, 'forward').captures, 24);
  assert.throws(() => validateG05ContinuousCoverage(all.slice(1), config, 'forward'), /Incomplete/);
  for (const mutate of [a => [a[0], a[1]] = [a[1], a[0]], a => a[1].inputs = 'e'.repeat(64), a => a[0].revision = 'e'.repeat(40), a => a[0].dirty = true]) {
    const rows = structuredClone(all); mutate(rows); assert.throws(() => validateG05ContinuousCoverage(rows, config, 'forward'));
  }
});
test('Forward retains 5% regression and all three cohort stability checks including baseline', () => {
  const all = entries('forward'); assert.equal(evaluateG05ContinuousBudgets(all, config, budget, 'forward').status, 'passed');
  for (const e of all.filter(e => e.job.arm === 'candidate')) e.result.timing = summarizeTimingSamples(Array(300).fill(1.06));
  const result = evaluateG05ContinuousBudgets(all, config, budget, 'forward'); assert.equal(result.status, 'failed');
  assert.ok(result.checks.some(c => c.limit === 1.05 && !c.passed));
  const drifting = entries('forward'); drifting[0].result.timing = summarizeTimingSamples(Array(300).fill(2));
  assert.ok(evaluateG05ContinuousBudgets(drifting, config, budget, 'forward').stability.some(c => c.job.arm === 'baseline' && !c.passed));
});
test('pooled room budgets retain slow samples, sparse benefit, stress cases and numerical ceilings', () => {
  const all = entries('rooms'), before = JSON.stringify(budget);
  const initial = evaluateG05ContinuousBudgets(all, config, budget, 'rooms');
  assert.ok(initial.checks.some(c => c.metric === 'cullLightingRatio' && !c.passed));
  assert.ok(initial.stability.some(c => c.job.caseId === 'stress-1024'));
  assert.ok(initial.checks.every(c => !c.job.caseId.startsWith('stress-')));
  const row = all.find(e => e.job.caseId === 'overlap-128' && e.job.algorithm === 'tiled');
  for (let i = 0; i < 60; i++) row.result.cpu[i].frameWallMs = 100;
  const changed = evaluateG05ContinuousBudgets(all, config, budget, 'rooms');
  assert.ok(changed.checks.some(c => c.metric === 'frameWallP95Ms' && c.observed === 100 && c.limit === 1000 / 60 && !c.passed));
  assert.equal(JSON.stringify(budget), before);
});
test('instances preserve all quality variants, resource checks and independent frozen budgets', () => {
  const all = entries('instances'); assert.equal(evaluateG05ContinuousBudgets(all, config, budget, 'instances').status, 'passed');
  all[0].result.paths[0].metrics.bindGroupsCreated = 1;
  assert.throws(() => evaluateG05ContinuousBudgets(all, config, budget, 'instances'), /Unstable instance/);
});
function remeasure(r) {
  for (const phase of ['warm', 'cpu', 'gpu']) {
    const snapshot = r.resourceAttribution[phase]; Object.assign(snapshot, summarizeG05ResourceRecords(snapshot.records));
    for (const type of ['buffer', 'texture']) {
      const rows = snapshot.records.filter(x => x.type === type); r.resources[phase][type].current = rows.length;
      r.resources[phase][type].estimatedBytes = rows.reduce((n, x) => n + x.estimatedBytes, 0);
    }
  }
}
test('physical G-buffer reuse keeps conservative logical-view budgets and rejects hidden bytes', () => {
  const r = entries('rooms').find(e => e.job.caseId === 'dynamic-128-four-view').result;
  for (const phase of ['warm', 'cpu', 'gpu']) r.resourceAttribution[phase].records = r.resourceAttribution[phase].records.filter(x => x.type === 'buffer' || x.id < 4);
  remeasure(r); const report = validateG05ContinuousMemory(r, budget); assert.equal(report.status, 'passed'); assert.equal(report.checks.length, 15);
  const malformed = structuredClone(r); malformed.resourceAttribution.cpu.records.pop(); assert.throws(() => validateG05ContinuousMemory(malformed, budget));
  const missing = structuredClone(r); for (const phase of ['warm', 'cpu', 'gpu']) missing.resourceAttribution[phase].records.shift(); remeasure(missing);
  assert.throws(() => validateG05ContinuousMemory(missing, budget), /generation/);
  const overflow = structuredClone(r); for (const phase of ['warm', 'cpu', 'gpu']) overflow.resourceAttribution[phase].records.find(x => x.type === 'buffer').estimatedBytes = 64 * 1024 * 1024;
  remeasure(overflow); assert.equal(validateG05ContinuousMemory(overflow, budget).status, 'failed');
});

function artifact() {
  const files = new Map(), store = (name, value) => { const bytes = typeof value === 'string' ? value : JSON.stringify(value); files.set(name, bytes); return { file: name, sha256: hash(bytes) }; };
  const fixture = store('candidate/fixture.js', 'synthetic test runtime, never native evidence');
  const build = [{ file: 'fixture.js', sha256: fixture.sha256 }];
  const host = { platform: 'win32', cpu: 'Intel Core i7-7700', hostname: 'test-host', os: '10.0.19045', hardware: { gpu: [{ Name: config.device.gpu, DriverVersion: 'test-only' }], power: 'test-power' } };
  const inputs = { runtime: { sha256: 'b'.repeat(64) }, files: [], harness: hash('[]') };
  const report = { schemaVersion: 1, protocolId: config.protocolId, config, suite: 'instances', tier: 'local-full', plan: createG05ContinuousPlan(config, 'instances'),
    inputs, inputsAfter: structuredClone(inputs), revision: 'd'.repeat(40), dirty: true, build, hostBefore: host, hostAfter: structuredClone(host), entries: [] };
  report.registration = store('registration.json', { ...report, registeredAt: '2026-10-12T23:00:00.000Z' });
  for (const [i, e] of entries('instances').entries()) {
    e.harness = inputs.harness; e.startedAt = '2026-10-13T00:00:00.000Z';
    e.result.httpProvenance = { files: [{ sourcePath: 'artifacts/engine-0.2.1/g05/fixture.js', sha256: fixture.sha256 }] };
    report.entries.push({ job: e.job, raw: store(`${i}.json`, e) });
  }
  return { report, files, read: async name => { if (!files.has(name)) throw Error('Missing file'); return Buffer.from(files.get(name)); } };
}
test('artifact audit rechecks raw populations and source binding without promoting a dirty diagnostic', async () => {
  const a = artifact(), result = await auditG05ContinuousReport(a.report, a.read, bytes);
  assert.equal(result.status, 'passed'); assert.equal(result.releaseQualified, false); assert.equal(result.cleanCandidate, false); assert.equal(result.captures, 96);
  a.files.set('0.json', a.files.get('0.json') + ' ');
  await assert.rejects(auditG05ContinuousReport(a.report, a.read, bytes), /Raw capture changed/);
});
test('artifact audit refuses wrong served runtime, late registration and missing compiled evidence', async () => {
  for (const mutate of [e => e.result.httpProvenance.files[0].sha256 = 'e'.repeat(64), e => e.startedAt = '2026-10-12T22:00:00.000Z']) {
    const a = artifact(), e = JSON.parse(a.files.get('0.json')); mutate(e); const raw = JSON.stringify(e);
    a.files.set('0.json', raw); a.report.entries[0].raw.sha256 = hash(raw);
    await assert.rejects(auditG05ContinuousReport(a.report, a.read, bytes));
  }
  const a = artifact(); a.files.delete('candidate/fixture.js'); await assert.rejects(auditG05ContinuousReport(a.report, a.read, bytes), /Missing file/);
});
