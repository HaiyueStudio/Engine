import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPendingHumanReview, validateRayG10ReviewManifest } from './ray-g10-review-contract.mjs';

test('G10 review contract accepts a complete pending diagnostic candidate', () => {
  assert.equal(validateRayG10ReviewManifest(fixtureManifest()).status, 'passed');
  assert.equal(validateRayG10ReviewManifest(fixtureManifest(), { formal: true }).status, 'failed');
});

test('G10 review contract requires an explicit complete human approval for formal evidence', () => {
  const manifest = fixtureManifest();
  manifest.evidenceClass = 'clean-revision-candidate';
  manifest.nodeVersion = 'v22.23.2';
  for (const repository of manifest.repositories) {
    repository.dirty = false;
    repository.changedPathCount = 0;
  }
  manifest.humanReviewStatus = 'approved';
  manifest.humanReview = {
    status: 'approved',
    reviewer: 'reviewer@example.test',
    reviewedAt: '2026-08-19T00:00:00.000Z',
    checks: manifest.requiredHumanReview.map(id => ({ id, status: 'approved', notes: 'reviewed' })),
  };
  assert.equal(validateRayG10ReviewManifest(manifest, { formal: true }).status, 'passed');
});

test('G10 review contract rejects missing captures, tampered files and partial approval', () => {
  const manifest = fixtureManifest();
  const files = new Map(manifest.captures.map(capture => [capture.file, Buffer.from(capture.id)]));
  manifest.captures[0].sha256 = '0'.repeat(64);
  manifest.captures.pop();
  manifest.humanReview.checks[0].status = 'approved';
  const validation = validateRayG10ReviewManifest(manifest, { captureFiles: files });
  assert.equal(validation.status, 'failed');
  for (const expected of ['capture count', 'file hash', 'missing capture', 'decided check']) {
    assert.ok(validation.violations.some(value => value.includes(expected)), expected);
  }
});

function fixtureManifest() {
  const requiredHumanReview = [
    'raw-versus-denoised-detail-and-edge-preservation',
    'light-leaks-and-fireflies',
    'temporal-ghosting-and-history-age',
    'variance-and-convergence-quality',
    'large-product-scene-composition',
  ];
  const captures = [
    ['example-material-raw', 'raw'],
    ['example-material-denoised', 'denoised'],
    ['example-material-variance', 'variance'],
    ['example-material-history-age', 'history-age'],
    ['example-material-feature', 'feature'],
    ['gravity-maze-ray-tracing', null],
  ].map(([id, view]) => ({
    id,
    file: `${id}.png`,
    bytes: id.length,
    sha256: 'a'.repeat(64),
    visual: view ? { view } : { sampleWidth: 32, sampleHeight: 20 },
    browserEvidence: { angleBackend: 'd3d11', nativeBackend: true },
    browserDiagnostics: {
      consoleErrorCount: 0,
      exceptionCount: 0,
      unclassifiedFailureCount: 0,
      profileCleanup: { status: 'passed', attempts: 1, durationMs: 1 },
    },
    httpProvenance: { transport: 'http', files: [] },
    candidateHashes: [`sha256:${'b'.repeat(64)}`],
  }));
  return {
    format: 'haiyue-ray-tracing-g10-human-review-candidate@1',
    evidenceClass: 'dirty-worktree-candidate',
    generatedAt: '2026-08-19T00:00:00.000Z',
    browser: 'chrome',
    backend: 'd3d11',
    nodeVersion: 'v24.19.0',
    repositories: ['Engine', 'Editor', 'Games', 'UI', 'milestones'].map(name => ({
      name,
      revision: 'a'.repeat(40),
      dirty: true,
      changedPathCount: 1,
    })),
    captures,
    requiredHumanReview,
    humanReviewStatus: 'pending',
    humanReview: createPendingHumanReview(),
  };
}
