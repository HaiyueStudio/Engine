import { ENGINE_021_EVIDENCE_KINDS } from './engine-021-evidence-policy.mjs';

const check = (ok, message) => { if (!ok) throw Error(message); };
const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');
const revision = value => /^[a-f0-9]{40}$/.test(value ?? '');

export function validateEngine021CandidateLock(config, lock, current) {
  check(config?.schemaVersion === 2 && config.version === '0.2.1' &&
    config.scopeDecision?.guiToast === 'included-in-0.2.1', 'Expected the Toast-inclusive 0.2.1 scope');
  check(config.candidate?.workspace === 'Engine' &&
    config.candidate.revisionLockFile === 'artifacts/engine-0.2.1/candidate-lock.json', 'Unexpected candidate workspace/lock path');
  check(lock?.schemaVersion === 1 && lock.version === '0.2.1' && lock.includesToast === true &&
    revision(lock.revision) && lock.revision === current.revision && current.dirty === false,
  'Candidate requires its exact clean Toast revision');
  check(digest(lock.candidateManifestSha256) && lock.candidateManifestSha256 === current.candidateManifestSha256,
    'Candidate scope changed after freezing');
  check(digest(lock.runtime?.sha256) && lock.runtime.sha256 === current.runtime?.sha256 &&
    Number.isSafeInteger(lock.runtime.fileCount) && lock.runtime.fileCount > 0 && lock.runtime.fileCount === current.runtime.fileCount,
  'Candidate runtime inputs changed after freezing');
}

/** Require the locked Toast capture; the existing raw auditor still governs prose-only acceptance reuse. */
export function validateEngine021FreshQualification(manifest, expectedRevision, captureRevision = expectedRevision) {
  check(revision(expectedRevision) && revision(captureRevision), 'Missing current acceptance/capture revision');
  check(manifest?.schemaVersion === 2 && manifest.contractId === 'engine-021-evidence-v2' &&
    manifest.revision === expectedRevision, 'Fresh qualification must bind the current candidate');
  check(JSON.stringify(Object.keys(manifest.reports ?? {}).sort()) === JSON.stringify([...ENGINE_021_EVIDENCE_KINDS].sort()),
    'Seven fresh complete report bindings are required');
  const paths = new Set();
  for (const kind of ENGINE_021_EVIDENCE_KINDS) {
    const report = manifest.reports[kind];
    check(report?.captureRevision === captureRevision, `${kind}: old capture cannot qualify the Toast runtime`);
    check(digest(report.sha256) && typeof report.file === 'string' && report.file.startsWith('artifacts/') &&
      report.file.split('/').every(p => p && p !== '.' && p !== '..') && !/[\\:\x00-\x1f]/.test(report.file) &&
      !paths.has(report.file), `${kind}: invalid or duplicate fresh report binding`);
    paths.add(report.file);
  }
}
