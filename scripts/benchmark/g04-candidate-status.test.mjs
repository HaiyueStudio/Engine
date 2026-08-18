import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const status = JSON.parse(readFileSync(new URL('./g04-candidate-status.json', import.meta.url), 'utf8'));

test('G04 handoff records a portable full comparison without claiming formal promotion', () => {
  assert.equal(status.schemaVersion, 2);
  assert.equal(status.goal, 'g04-performance-device-readiness');
  assert.equal(status.candidateState, 'portable-cross-engine-full-candidate-passed-formal-replay-required');
  assert.equal(status.formalBaselineUpdated, false);
  assert.equal(status.decisionContract.fixedHardwareRequired, false);
  assert.equal(status.decisionContract.nativeHardwareIdentityRecorded, true);
  assert.deepEqual(status.decisionContract.rankedEngines, ['haiyue', 'three', 'babylon', 'playcanvas']);
  assert.deepEqual(status.decisionContract.informationalEngines, ['galacean']);
  assert.equal(status.harness.fullCohorts, 3);
  assert.equal(status.latestCandidate.policy, 'passed');
  assert.equal(status.latestCandidate.robustCohortLead, true);
  assert.equal(status.latestCandidate.formal, false);
});

test('G04 handoff keeps diagnostic device profiles separate from G07 formal ordering', () => {
  assert.equal(status.legacyDeviceProfiles.releaseBlockingByMissingHardware, false);
  assert.deepEqual(status.legacyDeviceProfiles.profiles, [
    'apple-integrated',
    'windows-integrated',
    'windows-discrete',
  ]);
  assert.ok(status.handoff.g07.some(step => step.includes('performance:compare:formal')));
  assert.ok(status.handoff.g07.some(step => step.includes('all five screenshots')));
  assert.ok(status.handoff.g07.some(step => step.includes('correctness')));
});
