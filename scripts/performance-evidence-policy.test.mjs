import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePerformanceEvidenceMode,
  shouldWriteFormalPerformanceEvidence,
} from './performance-evidence-policy.mjs';

test('ordinary full and smoke workloads remain diagnostic by default', () => {
  assert.equal(resolvePerformanceEvidenceMode('full', {}), 'diagnostic');
  assert.equal(resolvePerformanceEvidenceMode('smoke', {}), 'diagnostic');
  assert.equal(shouldWriteFormalPerformanceEvidence('full', {}), false);
  assert.equal(shouldWriteFormalPerformanceEvidence('smoke', {}), false);
});

test('the legacy record flag cannot implicitly promote formal evidence', () => {
  assert.throws(
    () => shouldWriteFormalPerformanceEvidence('full', {
      WEBGPU_RECORD_PERFORMANCE_EVIDENCE: '1',
    }),
    /no longer promotes formal evidence/,
  );
});

test('candidate full workloads never write the formal device path', () => {
  const environment = { WEBGPU_PERFORMANCE_EVIDENCE_MODE: 'candidate' };
  assert.equal(resolvePerformanceEvidenceMode('full', environment), 'candidate');
  assert.equal(shouldWriteFormalPerformanceEvidence('full', environment), false);
});

test('formal promotion remains an explicit G07-compatible mode', () => {
  const environment = { WEBGPU_PERFORMANCE_EVIDENCE_MODE: 'formal' };
  assert.equal(resolvePerformanceEvidenceMode('full', environment), 'formal');
  assert.equal(shouldWriteFormalPerformanceEvidence('full', environment), true);
});

test('formal promotion rejects smoke workloads even when explicitly requested', () => {
  assert.throws(
    () => resolvePerformanceEvidenceMode('smoke', {
      WEBGPU_PERFORMANCE_EVIDENCE_MODE: 'formal',
    }),
    /requires the full workload/,
  );
});

test('rejects misspelled evidence modes instead of silently promoting them', () => {
  assert.throws(
    () => resolvePerformanceEvidenceMode('full', { WEBGPU_PERFORMANCE_EVIDENCE_MODE: 'candiate' }),
    /must be candidate, formal, or diagnostic/,
  );
});
