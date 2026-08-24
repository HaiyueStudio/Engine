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
    corpus: { manifestSha256: HASH, censusSha256: HASH },
    coverage: {
      objectTypes: 288,
      propertyKeys: 611,
      scriptModules: 48,
      scriptSymbols: 349,
      assetTypes: 14,
      uncoveredObjects: 288,
      uncoveredProperties: 611,
      uncoveredScriptModules: 48,
      uncoveredScriptSymbols: 349,
      uncoveredAssets: 14,
      unclassifiedFailureCount: 0,
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
