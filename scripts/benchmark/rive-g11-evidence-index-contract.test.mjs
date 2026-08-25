import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateRiveG11EvidenceIndex } from './rive-g11-evidence-index-contract.mjs';

const index = JSON.parse(readFileSync('review/candidates/rive-g11-evidence-index.json', 'utf8'));

test('collecting evidence index is a valid empty starting point without pretending to be formal evidence', () => {
  const result = validateRiveG11EvidenceIndex(index);
  assert.equal(result.status, 'passed', result.violations.join('\n'));
});

test('complete evidence index must bind the exact revision and artifact bytes', () => {
  const changed = structuredClone(index);
  changed.status = 'complete';
  changed.engineRevision = '1'.repeat(40);
  changed.corpusManifestSha256 = '2'.repeat(64);
  changed.workloadPlanSha256 = '3'.repeat(64);
  changed.traceArtifacts.push({ path: 'missing.json', sha256: '4'.repeat(64), byteLength: 1 });
  const result = validateRiveG11EvidenceIndex(changed, {
    expectedEngineRevision: changed.engineRevision,
    expectedManifestSha256: changed.corpusManifestSha256,
    expectedWorkloadPlanSha256: changed.workloadPlanSha256,
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('bytes are unavailable')));
});

