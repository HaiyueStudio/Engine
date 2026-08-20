import { createHash } from 'node:crypto';

export const RAY_G10_REVIEW_FORMAT = 'haiyue-ray-tracing-g10-human-review-candidate@1';

const EXPECTED_REPOSITORIES = Object.freeze(['Engine', 'Editor', 'Games', 'UI', 'milestones']);
const EXPECTED_CAPTURES = Object.freeze(new Map([
  ['example-material-raw', { file: 'example-material-raw.png', view: 'raw' }],
  ['example-material-denoised', { file: 'example-material-denoised.png', view: 'denoised' }],
  ['example-material-variance', { file: 'example-material-variance.png', view: 'variance' }],
  ['example-material-history-age', { file: 'example-material-history-age.png', view: 'history-age' }],
  ['example-material-feature', { file: 'example-material-feature.png', view: 'feature' }],
  ['gravity-maze-ray-tracing', { file: 'gravity-maze-ray-tracing.png', view: null }],
]));
const EXPECTED_REVIEW_CHECKS = Object.freeze([
  'raw-versus-denoised-detail-and-edge-preservation',
  'light-leaks-and-fireflies',
  'temporal-ghosting-and-history-age',
  'variance-and-convergence-quality',
  'large-product-scene-composition',
]);
const REVISION = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/u;

export function createPendingHumanReview() {
  return {
    status: 'pending',
    reviewer: null,
    reviewedAt: null,
    checks: EXPECTED_REVIEW_CHECKS.map(id => ({ id, status: 'pending', notes: '' })),
  };
}

export function validateRayG10ReviewManifest(manifest, {
  formal = false,
  captureFiles = null,
} = {}) {
  const violations = [];
  equal(manifest?.format, RAY_G10_REVIEW_FORMAT, 'format');
  if (!Number.isFinite(Date.parse(manifest?.generatedAt ?? ''))) violations.push('generatedAt is invalid');
  equal(manifest?.browser, 'chrome', 'review browser');
  equal(manifest?.backend, 'd3d11', 'review backend');
  if (typeof manifest?.nodeVersion !== 'string' || !/^v\d+\./u.test(manifest.nodeVersion)) {
    violations.push('Node version identity is missing');
  }

  const repositories = Array.isArray(manifest?.repositories) ? manifest.repositories : [];
  equal(repositories.length, EXPECTED_REPOSITORIES.length, 'repository count');
  const seenRepositories = new Set();
  for (const repository of repositories) {
    if (!EXPECTED_REPOSITORIES.includes(repository?.name)) violations.push(`unknown repository ${String(repository?.name)}`);
    if (seenRepositories.has(repository?.name)) violations.push(`duplicate repository ${String(repository?.name)}`);
    seenRepositories.add(repository?.name);
    if (!REVISION.test(repository?.revision ?? '')) violations.push(`${repository?.name} revision is invalid`);
    if (typeof repository?.dirty !== 'boolean') violations.push(`${repository?.name} dirty state is missing`);
    if (!Number.isInteger(repository?.changedPathCount) || repository.changedPathCount < 0) {
      violations.push(`${repository?.name} changed path count is invalid`);
    }
  }
  for (const name of EXPECTED_REPOSITORIES) {
    if (!seenRepositories.has(name)) violations.push(`missing repository ${name}`);
  }
  const anyDirty = repositories.some(repository => repository?.dirty);
  equal(
    manifest?.evidenceClass,
    anyDirty ? 'dirty-worktree-candidate' : 'clean-revision-candidate',
    'evidence class',
  );

  const captures = Array.isArray(manifest?.captures) ? manifest.captures : [];
  equal(captures.length, EXPECTED_CAPTURES.size, 'capture count');
  const seenCaptures = new Set();
  for (const capture of captures) {
    const expected = EXPECTED_CAPTURES.get(capture?.id);
    if (!expected) {
      violations.push(`unknown capture ${String(capture?.id)}`);
      continue;
    }
    if (seenCaptures.has(capture.id)) violations.push(`duplicate capture ${capture.id}`);
    seenCaptures.add(capture.id);
    equal(capture?.file, expected.file, `${capture.id} file`);
    if (expected.view) equal(capture?.visual?.view, expected.view, `${capture.id} view`);
    positiveInteger(capture?.bytes, `${capture.id} bytes`);
    if (!SHA256.test(capture?.sha256 ?? '')) violations.push(`${capture.id} sha256 is invalid`);
    if (!Array.isArray(capture?.candidateHashes) || capture.candidateHashes.length < 1
      || capture.candidateHashes.some(value => !PREFIXED_SHA256.test(value))) {
      violations.push(`${capture.id} candidate hashes are invalid`);
    }
    equal(capture?.browserEvidence?.angleBackend, 'd3d11', `${capture.id} ANGLE backend`);
    equal(capture?.browserEvidence?.nativeBackend, true, `${capture.id} native backend`);
    equal(capture?.browserDiagnostics?.consoleErrorCount, 0, `${capture.id} console errors`);
    equal(capture?.browserDiagnostics?.exceptionCount, 0, `${capture.id} exceptions`);
    equal(capture?.browserDiagnostics?.unclassifiedFailureCount, 0, `${capture.id} unclassified failures`);
    equal(capture?.browserDiagnostics?.profileCleanup?.status, 'passed', `${capture.id} profile cleanup`);
    positiveInteger(capture?.browserDiagnostics?.profileCleanup?.attempts, `${capture.id} cleanup attempts`);
    equal(capture?.httpProvenance?.transport, 'http', `${capture.id} HTTP transport`);
    if (captureFiles) {
      const bytes = captureFiles.get(capture.file);
      if (!bytes) violations.push(`${capture.id} PNG is missing`);
      else {
        equal(bytes.byteLength, capture.bytes, `${capture.id} file bytes`);
        equal(createHash('sha256').update(bytes).digest('hex'), capture.sha256, `${capture.id} file hash`);
      }
    }
  }
  for (const id of EXPECTED_CAPTURES.keys()) {
    if (!seenCaptures.has(id)) violations.push(`missing capture ${id}`);
  }

  const requiredReview = manifest?.requiredHumanReview ?? [];
  equal(requiredReview.length, EXPECTED_REVIEW_CHECKS.length, 'required human review count');
  for (const id of EXPECTED_REVIEW_CHECKS) {
    if (!requiredReview.includes(id)) violations.push(`missing required human review ${id}`);
  }
  const humanReview = manifest?.humanReview;
  if (!['pending', 'approved', 'rejected'].includes(humanReview?.status)) violations.push('human review status is invalid');
  equal(manifest?.humanReviewStatus, humanReview?.status, 'legacy human review status');
  const reviewChecks = Array.isArray(humanReview?.checks) ? humanReview.checks : [];
  equal(reviewChecks.length, EXPECTED_REVIEW_CHECKS.length, 'human review check count');
  for (const id of EXPECTED_REVIEW_CHECKS) {
    const matches = reviewChecks.filter(check => check?.id === id);
    equal(matches.length, 1, `human review check ${id} count`);
    if (matches[0] && !['pending', 'approved', 'rejected'].includes(matches[0].status)) {
      violations.push(`human review check ${id} status is invalid`);
    }
  }
  if (humanReview?.status === 'pending') {
    if (humanReview?.reviewer !== null || humanReview?.reviewedAt !== null) {
      violations.push('pending human review must not claim reviewer or timestamp');
    }
    if (reviewChecks.some(check => check?.status !== 'pending')) violations.push('pending human review contains a decided check');
  } else {
    if (typeof humanReview?.reviewer !== 'string' || humanReview.reviewer.trim().length === 0) {
      violations.push('decided human review reviewer is missing');
    }
    if (!Number.isFinite(Date.parse(humanReview?.reviewedAt ?? ''))) violations.push('decided human review timestamp is invalid');
    const expectedCheckStatus = humanReview.status === 'approved' ? 'approved' : 'rejected';
    if (reviewChecks.some(check => check?.status !== expectedCheckStatus)) {
      violations.push(`decided human review checks must all be ${expectedCheckStatus}`);
    }
  }

  if (formal) {
    equal(manifest?.evidenceClass, 'clean-revision-candidate', 'formal evidence class');
    if (repositories.some(repository => repository?.dirty)) violations.push('formal review contains a dirty repository');
    if (!/^v22\./u.test(manifest?.nodeVersion ?? '')) violations.push('formal review must use Node 22');
    equal(humanReview?.status, 'approved', 'formal human review status');
  }

  return {
    schemaVersion: 1,
    contract: 'haiyue-ray-g10-human-review@1',
    mode: formal ? 'formal' : 'diagnostic',
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
  };

  function equal(actual, expected, label) {
    if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
  function positiveInteger(actual, label) {
    if (!Number.isInteger(actual) || actual < 1) violations.push(`${label} must be a positive integer`);
  }
}
