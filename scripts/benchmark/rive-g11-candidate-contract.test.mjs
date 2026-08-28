import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRiveG11Candidate } from './rive-g11-candidate-contract.mjs';

const HASH = 'a'.repeat(64);
const REVISION = 'b'.repeat(40);

function incompleteCandidate() {
  return {
    schemaVersion: 1,
    kind: 'haiyue-rive-g11-candidate',
    goal: 'm07/g11-corpus-version-fidelity-performance',
    status: 'incomplete',
    blockers: ['licensed formalAssets population is empty'],
    tupleId: 'rive-7.3-webgl2-2.40.0',
    generatedAt: '2026-08-24T00:00:00.000Z',
    engineRevision: REVISION,
    engineDirty: true,
    nodeVersion: 'v22.18.0',
    evidenceClass: 'dirty-worktree-diagnostic',
    evidenceIndex: { path: 'review/candidates/rive-g11-evidence-index.json', sha256: HASH, byteLength: 16 },
    corpus: { manifestSha256: HASH, censusSha256: HASH },
    workloadPlan: { id: 'rive-7-3-full-web-workload-v1', path: 'animation-spec/corpus/rive/rive-g11-workload-plan.json', sha256: HASH },
    coverage: {
      contractRevision: 2,
      sourceCensus: {
        objectTypes: 288,
        propertyKeys: 618,
        scriptModules: 48,
        scriptSymbols: 349,
        assetTypes: 14,
        unclassifiedFailureCount: 0,
      },
      binaryEvidence: {
        objectTypes: 288,
        propertyKeys: 565,
        assetTypes: 9,
        uncoveredObjects: 288,
        uncoveredProperties: 565,
        uncoveredAssets: 9,
      },
      behavioralEvidence: {
        featureFamilies: 8,
        scriptModules: 48,
        scriptSymbols: 349,
        uncoveredFeatureFamilies: 8,
        unclassifiedScriptCapabilities: 0,
        attributedScriptModules: 0,
        attributedScriptSymbols: 0,
      },
    },
    traceArtifacts: [],
    devices: [],
    performance: { fullWorkload: false, assets: [] },
    security: { cases: [] },
    browserClosure: {
      officialOracleBuildTimeOnly: true,
      unclassifiedFailureCount: 0,
      scans: ['packedPlayerTarball', 'browserBundle', 'sourceMap', 'networkRequests'].map(name => ({
        name,
        status: 'passed',
        sha256: HASH,
        forbiddenPackageCount: 0,
        forbiddenFileCount: 0,
        forbiddenStaticPatternCount: 0,
        forbiddenNetworkCount: 0,
        rawRivCount: 0,
        evidence: { path: `review/candidates/${name}.json`, sha256: HASH, byteLength: 16 },
      })),
    },
    licenses: { assets: [] },
  };
}

test('diagnostic candidate may honestly preserve acquisition and device blockers', () => {
  const result = validateRiveG11Candidate(incompleteCandidate());
  assert.equal(result.status, 'passed', result.violations.join('\n'));
});

test('the same incomplete candidate can never pass the formal contract', () => {
  const result = validateRiveG11Candidate(incompleteCandidate(), { formal: true, manifest: { formalAssets: [], securityCases: [] } });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('formal candidate status')));
  assert.ok(result.violations.some(value => value.includes('formal blocker count')));
  assert.ok(result.violations.some(value => value.includes('missing required device class')));
});

test('formal Rive evidence accepts every Node.js major at or above 22', () => {
  const candidate = incompleteCandidate();
  candidate.nodeVersion = 'v24.19.0';
  const accepted = validateRiveG11Candidate(candidate, { formal: true, manifest: { formalAssets: [], securityCases: [] } });
  assert.ok(!accepted.violations.some(value => value.includes('Node.js 22 or later')));
  candidate.nodeVersion = 'v21.7.3';
  const rejected = validateRiveG11Candidate(candidate, { formal: true, manifest: { formalAssets: [], securityCases: [] } });
  assert.ok(rejected.violations.some(value => value.includes('Node.js 22 or later')));
});

test('Rive runtime, raw RIV or network leakage fails even diagnostic candidate validation', () => {
  const candidate = incompleteCandidate();
  candidate.browserClosure.scans[1].forbiddenPackageCount = 1;
  candidate.browserClosure.scans[1].status = 'failed';
  candidate.browserClosure.scans[3].rawRivCount = 1;
  candidate.browserClosure.scans[3].status = 'failed';
  const result = validateRiveG11Candidate(candidate);
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('forbidden package count')));
  assert.ok(result.violations.some(value => value.includes('raw RIV count')));
});

test('formal candidate revalidates referenced security workload as formal evidence', () => {
  const candidate = incompleteCandidate();
  const evidencePath = 'review/candidates/rive-g11-security-diagnostic.json';
  const securityCase = {
    id: 'invalid-fingerprint', class: 'parser', status: 'passed',
    expectedDiagnostic: 'E_RIVE_INVALID_FINGERPRINT', observedDiagnostic: 'E_RIVE_INVALID_FINGERPRINT',
    underlyingDiagnostic: 'E_RIVE_INVALID_FINGERPRINT', freshOwner: true, ownerResidual: 0,
    cpuMs: 1, peakMemoryBytes: 1, limits: { cpuMs: 100, peakMemoryBytes: 100 }, runner: 'fixture',
  };
  const report = {
    schemaVersion: 1, kind: 'haiyue-rive-g11-security-workload', tupleId: 'rive-7.3-webgl2-2.40.0',
    status: 'passed', evidenceClass: 'dirty-worktree-diagnostic', generatedAt: '2026-08-24T00:00:00.000Z',
    engineRevision: REVISION, engineDirty: true, nodeVersion: 'v24.19.0', manifestSha256: HASH,
    runner: { id: 'scripts/benchmark/rive-g11-run-security.mjs@1' }, unclassifiedFailureCount: 0,
    cases: [securityCase], summary: { total: 1, passed: 1, failed: 0, notRun: 0 },
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(report)}\n`);
  candidate.security.cases = [{
    ...securityCase,
    evidence: { path: evidencePath, sha256: 'c'.repeat(64), byteLength: bytes.byteLength },
  }];
  const result = validateRiveG11Candidate(candidate, {
    formal: true,
    manifest: { formalAssets: [], securityCases: [{ id: securityCase.id, class: securityCase.class, expected: securityCase.expectedDiagnostic }] },
    artifactBytesByPath: new Map([[evidencePath, bytes]]),
  });
  assert.ok(result.violations.some(value => value.includes('failed formal validation') && value.includes('formal Engine dirty state')));
});

test('formal candidate revalidates referenced browser closure as clean formal evidence', () => {
  const candidate = incompleteCandidate();
  const evidencePath = 'review/candidates/rive-g11-browser-closure-diagnostic.json';
  const report = {
    schemaVersion: 1,
    kind: 'haiyue-rive-browser-closure-scan',
    status: 'passed',
    formalEvidence: false,
    generatedAt: '2026-08-27T00:00:00.000Z',
    engineRevision: REVISION,
    engineDirty: true,
    evidenceClass: 'dirty-worktree-diagnostic',
    nodeVersion: 'v24.19.0',
    denyListSha256: HASH,
    officialOracleBuildTimeOnly: true,
    unclassifiedFailureCount: 0,
    scans: ['packedPlayerTarball', 'browserBundle', 'sourceMap', 'networkRequests'].map(name => ({
      name,
      status: 'passed',
      sha256: HASH,
      forbiddenPackageCount: 0,
      forbiddenFileCount: 0,
      forbiddenStaticPatternCount: 0,
      forbiddenNetworkCount: 0,
      rawRivCount: 0,
    })),
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(report)}\n`);
  for (const scan of candidate.browserClosure.scans) {
    scan.evidence = { path: evidencePath, sha256: HASH, byteLength: bytes.byteLength };
  }
  const result = validateRiveG11Candidate(candidate, {
    formal: true,
    manifest: { formalAssets: [], securityCases: [] },
    artifactBytesByPath: new Map([[evidencePath, bytes]]),
  });
  assert.ok(result.violations.some(value => value.includes('browser closure evidence') && value.includes('formal Engine dirty state')));
});
