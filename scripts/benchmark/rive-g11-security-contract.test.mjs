import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRiveG11SecurityReport } from './rive-g11-security-contract.mjs';

const manifest = { securityCases: [
  { id: 'parser-bomb', class: 'parser', expected: 'E_RIVE_LIMIT_EXCEEDED' },
  { id: 'script-bomb', class: 'script', expected: 'E_RIVE_SCRIPT_BUDGET' },
] };

function report() {
  const passed = manifest.securityCases.map(value => ({
    id: value.id, class: value.class, status: 'passed', expectedDiagnostic: value.expected,
    observedDiagnostic: value.expected, underlyingDiagnostic: value.id === 'script-bomb' ? 'E_SCRIPT_TIMEOUT' : value.expected,
    freshOwner: true, ownerResidual: 0, cpuMs: 1, peakMemoryBytes: 1024,
    limits: { cpuMs: 100, peakMemoryBytes: 1024 * 1024 }, runner: 'fixture',
  }));
  return {
    schemaVersion: 1, kind: 'haiyue-rive-g11-security-workload', tupleId: 'rive-7.3-webgl2-2.40.0', status: 'passed',
    evidenceClass: 'clean-revision-candidate', generatedAt: '2026-08-24T00:00:00.000Z', engineRevision: 'a'.repeat(40), engineDirty: false,
    nodeVersion: 'v22.18.0', manifestSha256: 'b'.repeat(64), runner: { id: 'scripts/benchmark/rive-g11-run-security.mjs@1' },
    unclassifiedFailureCount: 0, cases: passed, summary: { total: 2, passed: 2, failed: 0, notRun: 0 },
  };
}

test('security report binds every declared case to measured budgets and an underlying diagnostic', () => {
  const result = validateRiveG11SecurityReport(report(), manifest, { formal: true, expectedRevision: 'a'.repeat(40), expectedManifestSha256: 'b'.repeat(64) });
  assert.equal(result.status, 'passed', result.violations.join('\n'));
});

test('formal security cannot hide a not-run case', () => {
  const value = report();
  value.status = 'incomplete';
  value.cases[1] = { id: 'script-bomb', class: 'script', status: 'not-run', expectedDiagnostic: 'E_RIVE_SCRIPT_BUDGET', reason: 'runner unavailable' };
  value.summary = { total: 2, passed: 1, failed: 0, notRun: 1 };
  const diagnostic = validateRiveG11SecurityReport(value, manifest);
  const formal = validateRiveG11SecurityReport(value, manifest, { formal: true });
  assert.equal(diagnostic.status, 'passed', diagnostic.violations.join('\n'));
  assert.equal(formal.status, 'failed');
  assert.ok(formal.violations.some(item => item.includes('population')));
});

test('mapped Rive diagnostic cannot conceal the wrong underlying result or owner leak', () => {
  const value = report();
  value.cases[1].observedDiagnostic = 'E_RIVE_ABORTED';
  value.cases[1].ownerResidual = 1;
  const result = validateRiveG11SecurityReport(value, manifest);
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(item => item.includes('mapped diagnostic')));
  assert.ok(result.violations.some(item => item.includes('owner residual')));
});
