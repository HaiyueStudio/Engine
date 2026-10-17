import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEngine021CandidateLock as validateLock, validateEngine021FreshQualification as validateFresh } from './engine-021-candidate-policy.mjs';
import { ENGINE_021_EVIDENCE_KINDS as kinds, ENGINE_021_READBACK_REUSE as repair } from './engine-021-evidence-policy.mjs';

function fixture() {
  const revision = 'a'.repeat(40), hash = 'b'.repeat(64), runtime = { sha256: 'c'.repeat(64), fileCount: 624 };
  return { config: { schemaVersion: 2, version: '0.2.1', scopeDecision: { guiToast: 'included-in-0.2.1' },
    candidate: { workspace: 'Engine', revisionLockFile: 'artifacts/engine-0.2.1/candidate-lock.json' } },
  lock: { schemaVersion: 1, version: '0.2.1', includesToast: true, revision, runtime, candidateManifestSha256: hash },
  current: { revision, dirty: false, runtime: { ...runtime }, candidateManifestSha256: hash },
  manifest: { schemaVersion: 2, contractId: 'engine-021-evidence-v2', revision,
    reports: Object.fromEntries(kinds.map(kind => [kind, { file: `artifacts/${kind}/report.json`, sha256: hash, captureRevision: revision }])) } };
}

test('Toast candidate scope and all seven fresh bindings remain prerequisite checks only', () => {
  const d = fixture(); validateLock(d.config, d.lock, d.current); validateFresh(d.manifest, d.current.revision);
});
test('the former non-Toast candidate, dirty worktrees and changed scope cannot pass', () => {
  for (const mutate of [d => { d.config.scopeDecision.guiToast = 'next-minor-only'; },
    d => { d.config.candidate.workspace = 'Engine-rc-021-20261014'; }, d => { d.lock.includesToast = false; },
    d => { d.current.revision = 'd'.repeat(40); }, d => { d.current.dirty = true; },
    d => { d.current.candidateManifestSha256 = 'e'.repeat(64); }]) {
    const d = fixture(); mutate(d); assert.throws(() => validateLock(d.config, d.lock, d.current));
  }
});
test('runtime drift or a lock redirected outside the candidate is rejected', () => {
  for (const mutate of [d => { d.current.runtime.sha256 = 'd'.repeat(64); },
    d => { d.current.runtime.fileCount++; }, d => { d.lock.runtime.sha256 = ''; },
    d => { d.config.candidate.revisionLockFile = '../old-lock.json'; }]) {
    const d = fixture(); mutate(d); assert.throws(() => validateLock(d.config, d.lock, d.current));
  }
});
test('old seven-report bundles cannot be relabeled with the new acceptance revision', () => {
  const d = fixture();
  d.manifest.reports.production.captureRevision = 'e'.repeat(40);
  assert.throws(() => validateFresh(d.manifest, d.current.revision), /old capture/);
  d.manifest.reports.production.captureRevision = d.current.revision;
  d.manifest.revision = 'e'.repeat(40);
  assert.throws(() => validateFresh(d.manifest, d.current.revision), /current candidate/);
});
test('a locked Toast capture may precede a prose-only acceptance revision without admitting the pre-Toast bundle', () => {
  const d = fixture(), capture = d.current.revision, acceptance = 'd'.repeat(40);
  d.manifest.revision = acceptance;
  validateFresh(d.manifest, acceptance, capture);
  d.manifest.reports.rooms.captureRevision = 'e'.repeat(40);
  assert.throws(() => validateFresh(d.manifest, acceptance, capture), /old capture/);
});
test('missing populations, duplicate paths, bad hashes and path escapes cannot fill the new manifest', () => {
  for (const mutate of [d => { delete d.manifest.reports.rooms; },
    d => { d.manifest.reports.rooms.file = d.manifest.reports.forward.file; },
    d => { d.manifest.reports.correctness.sha256 = ''; },
    d => { d.manifest.reports.ablation.file = 'artifacts/../old/report.json'; },
    d => { d.manifest.reports.resources.file = 'artifacts/C:/old.json'; }]) {
    const d = fixture(); mutate(d); assert.throws(() => validateFresh(d.manifest, d.current.revision));
  }
});

test('ADR 0129 binds exactly six retained reports and keeps correctness on the new capture', () => {
  const data = fixture(); data.manifest.reuseDecision = repair.decision;
  for (const [kind, row] of Object.entries(repair.reports)) data.manifest.reports[kind] = { ...row, captureRevision: repair.captureRevision };
  validateFresh(data.manifest, data.current.revision);
  for (const mutate of [
    d => { d.manifest.reports.correctness.captureRevision = repair.captureRevision; },
    d => { d.manifest.reports.forward.sha256 = '0'.repeat(64); },
    d => { d.manifest.reports.production.file = 'artifacts/another/report.json'; },
    d => { d.manifest.reports.instances.captureRevision = 'e'.repeat(40); },
    d => { delete d.manifest.reuseDecision; },
  ]) { const copy = structuredClone(data); mutate(copy); assert.throws(() => validateFresh(copy.manifest, copy.current.revision)); }
  assert.throws(() => validateFresh(data.manifest, data.current.revision, repair.captureRevision), /new correctness/);
});
