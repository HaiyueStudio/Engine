import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_021_EVIDENCE_KINDS as kinds, validateEngine021EvidenceBindings, completeEngine021EvidenceAudit,
  assessEngine021G05Audit, validateEngine021CompiledEvidence, validateEngine021RevisionReuse } from './engine-021-evidence-policy.mjs';

function g05Audit(kind) {
  const [captures, checks, stability, memory] = { rooms: [156, 60, 156, 156], instances: [96, 96, 192, 0], forward: [24, 8, 16, 0] }[kind];
  return { status: 'passed', cleanCandidate: true, captures,
    checks: Array.from({ length: checks }, () => ({ passed: true, observed: 1, limit: kind === 'forward' ? 1.05 : 4 })),
    stability: Array.from({ length: stability }, () => ({ passed: true, stable: true, cohortP95: [1, 1, 1], relativeSpread: 0, cv: 0 })),
    memory: Array.from({ length: memory }, () => ({ status: 'passed', checks: [{ passed: true, observed: 1, limit: 2 }] })) };
}

function fixture() {
  const revision = 'a'.repeat(40), runtime = { sha256: 'b'.repeat(64), fileCount: 100 };
  const current = { revision, dirty: false, runtime, framegraphBaselineRevision: 'c'.repeat(40),
    qualification: { platform: 'win32', hostname: 'registered-host' },
    productionConfig: { contract: 'production' }, lightingConfig: { contract: 'continuous' },
    inputs: Object.fromEntries(kinds.filter(k => k !== 'correctness').map(k => [k, { source: k }])) };
  const manifest = { schemaVersion: 2, contractId: 'engine-021-evidence-v2', revision,
    reports: Object.fromEntries(kinds.map(k => [k, { file: `artifacts/${k}/report.json`, sha256: 'd'.repeat(64), captureRevision: revision }])) };
  const chunks = () => [{ file: 'fixture.js', sha256: '1'.repeat(64) }, { file: 'fixture-extra.js', sha256: '2'.repeat(64) }];
  const reports = Object.fromEntries(kinds.map(kind => {
    const continuous = ['rooms', 'instances', 'forward'].includes(kind);
    return [kind, { revision, dirty: false, status: 'passed', generatedAt: '2026-10-13T01:00:00Z', finishedAt: '2026-10-13T02:00:00Z',
      tier: kind === 'correctness' ? 'full' : kind === 'production' ? 'production-local' : 'local-full',
      inputs: kind === 'correctness' ? runtime : current.inputs[kind], mode: kind, suite: kind,
      build: kind === 'correctness' ? { outputs: chunks() } : chunks(),
      baseline: { revision: current.framegraphBaselineRevision }, config: continuous ? current.lightingConfig : current.productionConfig,
      qualification: current.qualification,
      host: { hostname: 'registered-host' }, hostBefore: { hostname: 'registered-host' } }];
  }));
  const audits = Object.fromEntries(kinds.map(kind => [kind, ['rooms', 'instances', 'forward'].includes(kind) ? g05Audit(kind) : { status: 'passed' }]));
  const builds = Object.fromEntries(['common', 'production', 'resources', 'ablation'].map(k => [k, chunks()]));
  return { current, manifest, reports, audits, builds };
}
const validate = data => validateEngine021EvidenceBindings(data.manifest, data.reports, data.current);

test('all seven bindings and independent audits remain a scoped prerequisite, not release approval', () => {
  const data = fixture(); validate(data);
  validateEngine021CompiledEvidence(data.reports, data.builds);
  const result = completeEngine021EvidenceAudit(data.audits, data.reports);
  assert.equal(result.status, 'passed'); assert.equal(result.releaseQualified, false); assert.equal(result.g09Complete, false);
});
test('old revision, dirty results and interrupted matrices cannot be spliced into a clean candidate', () => {
  for (const mutate of [d => { d.current.dirty = true; }, d => { d.reports.rooms.revision = 'e'.repeat(40); },
    d => { d.reports.production.dirty = true; }, d => { d.reports.resources.status = 'invalid'; },
    d => { delete d.reports.forward.finishedAt; }]) {
    const data = fixture(); mutate(data); assert.throws(() => validate(data));
  }
});
test('smoke renamed passed, swapped suites and missing reports fail identity checks', () => {
  for (const mutate of [d => { d.reports.ablation.tier = 'smoke'; }, d => { d.reports.instances.suite = 'rooms'; },
    d => { d.reports.resources.mode = 'ablation'; }, d => { delete d.manifest.reports.correctness; },
    d => { delete d.reports.forward; }]) {
    const data = fixture(); mutate(data); assert.throws(() => validate(data));
  }
});
test('source, harness, config, baseline and host identities remain bound', () => {
  for (const mutate of [d => { d.reports.production.inputs = { source: 'old-harness' }; },
    d => { d.reports.rooms.config = { relaxed: true }; }, d => { d.reports.correctness.inputs = {}; },
    d => { d.reports.correctness.baseline.revision = 'e'.repeat(40); }, d => { d.reports.ablation.host.hostname = 'another-host'; },
    d => { d.reports.correctness.qualification = { platform: 'darwin', hostname: 'another-host' }; }]) {
    const data = fixture(); mutate(data); assert.throws(() => validate(data));
  }
});
test('report aliasing, missing hashes and path traversal are rejected', () => {
  for (const mutate of [d => { d.manifest.reports.rooms.file = d.manifest.reports.forward.file; },
    d => { d.manifest.reports.production.sha256 = ''; }, d => { d.manifest.reports.resources.file = 'artifacts/../private/report.json'; },
    d => { d.manifest.reports.ablation.file = 'D:\\external\\report.json'; }]) {
    const data = fixture(); mutate(data); assert.throws(() => validate(data));
  }
});
test('a passed summary cannot override a missing, failed or inconclusive raw audit', () => {
  for (const status of ['failed', 'invalid', 'inconclusive', undefined]) {
    const data = fixture(); validate(data);
    if (status) data.audits.rooms.status = status; else delete data.audits.rooms;
    assert.throws(() => completeEngine021EvidenceAudit(data.audits, data.reports));
  }
});

test('ADR 0126 records stability warnings without changing raw reports or the 5% budget', () => {
  for (const kind of ['rooms', 'instances', 'forward']) {
    const data = fixture();
    data.reports[kind].status = data.audits[kind].status = 'failed';
    Object.assign(data.audits[kind].stability[0], { passed: false, stable: false, cohortP95: [1, 1.2, 1.5], relativeSpread: .4, cv: .2 });
    const before = JSON.stringify(data);
    validate(data);
    const result = completeEngine021EvidenceAudit(data.audits, data.reports);
    assert.equal(result.status, 'passed'); assert.equal(result.assessments[kind].warnings.length, 1);
    assert.equal(result.assessments[kind].originalStatus, 'failed'); assert.equal(result.releaseQualified, false);
    assert.equal(JSON.stringify(data), before);
  }
});

test('performance or resource failures never become stability warnings', () => {
  for (const mutate of [
    a => { a.checks[0].passed = false; a.checks[0].observed = 5; },
    a => { a.checks[0].observed = 5; },
    a => { a.checks[0].observed = NaN; },
    a => { a.memory[0].checks[0].passed = false; },
    a => { a.memory[0].checks[0].observed = 3; },
    a => { a.memory[0].status = 'failed'; },
  ]) {
    const audit = g05Audit('rooms'); mutate(audit); assert.throws(() => assessEngine021G05Audit('rooms', audit));
  }
  const forward = g05Audit('forward'); forward.checks[0].limit = 1.06;
  assert.throws(() => assessEngine021G05Audit('forward', forward), /original performance budget/);
});

test('missing, dirty, malformed and inconsistent raw populations cannot be waived', () => {
  for (const mutate of [a => { a.cleanCandidate = false; }, a => { a.captures--; }, a => { a.checks = []; },
    a => { a.stability.pop(); }, a => { a.memory.pop(); }, a => { a.stability[0].cohortP95.pop(); },
    a => { a.stability[0].cv = NaN; }, a => { a.stability[0].passed = false; }, a => { a.status = 'failed'; }]) {
    const audit = g05Audit('rooms'); mutate(audit); assert.throws(() => assessEngine021G05Audit('rooms', audit));
  }
});

test('reuse binds capture and acceptance revisions and permits only Git-verified prose/acceptance changes', () => {
  const data = fixture(), old = 'e'.repeat(40);
  data.reports.rooms.revision = data.manifest.reports.rooms.captureRevision = old;
  data.current.reuseChanges = { [old]: ['docs/for-ai/adr/0126-example.md', 'review/engine-0.2.1/README.md', 'scripts/engine-021-evidence-policy.mjs'] };
  validate(data);
  data.manifest.reports.rooms.captureRevision = data.current.revision;
  assert.throws(() => validate(data), /complete clean capture/);
  for (const path of ['engine/src/index.ts', 'scripts/webgpu-gate/chrome-runner.mjs', 'config/lighting-continuous-021.json',
    'package-lock.json', 'package.json', 'docs/../engine/src/index.ts', 'docs/runtime.js', 'review/baseline.json', 'scripts/other-policy.mjs']) {
    assert.throws(() => validateEngine021RevisionReuse(old, { revision: data.current.revision, reuseChanges: { [old]: [path] } }), /non-acceptance change/);
  }
  assert.throws(() => validateEngine021RevisionReuse(old, data.manifest), /Git comparison/);
});

test('all candidate executable chunks must match fresh builds, including lazily loaded chunks', () => {
  for (const mutate of [
    d => { d.builds.resources[0].sha256 = '3'.repeat(64); },
    d => { d.builds.production.pop(); },
    d => { d.reports.forward.build[1].sha256 = '3'.repeat(64); },
    d => { d.reports.correctness.build.outputs = []; },
    d => { d.reports.ablation.build.push({ ...d.reports.ablation.build[0] }); },
    d => { d.builds.common[0].sha256 = 'unknown'; },
  ]) {
    const data = fixture(); mutate(data); assert.throws(() => validateEngine021CompiledEvidence(data.reports, data.builds));
  }
});
