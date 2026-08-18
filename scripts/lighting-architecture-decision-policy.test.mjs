import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateLightingArchitectureDecision } from './lighting-architecture-decision-policy.mjs';

const policy = JSON.parse(await readFile(
  new URL('../config/lighting-architecture-policy.json', import.meta.url),
  'utf8',
));
const currentLightingEvidence = JSON.parse(await readFile(
  new URL('../artifacts/webgpu/lighting-scaling.json', import.meta.url),
  'utf8',
));

test('current 128-light fixture observes the cap but does not authorize Forward+', () => {
  const result = evaluateLightingArchitectureDecision(policy, {
    lightingScaling: currentLightingEvidence,
    forwardPlusEvidence: null,
    csmEvidence: null,
  });
  assert.equal(result.forwardPlus.capObserved, true);
  assert.equal(result.forwardPlus.status, 'hold');
  assert.ok(result.forwardPlus.reasons.includes('product-content-requirement-missing'));
  assert.equal(result.csm.status, 'hold');
  assert.deepEqual(result.violations, []);
});

test('a real same-picture two-device product requirement can unlock only a Forward+ prototype', () => {
  const approvedPolicy = structuredClone(policy);
  approvedPolicy.forwardPlus.decision = 'prototype-approved';
  const result = evaluateLightingArchitectureDecision(approvedPolicy, {
    lightingScaling: currentLightingEvidence,
    forwardPlusEvidence: validForwardPlusEvidence(),
    csmEvidence: null,
  });
  assert.equal(result.forwardPlus.status, 'eligible-for-prototype');
  assert.equal(result.forwardPlus.productStatus, 'hold');
  assert.ok(result.forwardPlus.productReasons.includes('candidate-comparison-missing'));
  assert.equal(result.csm.status, 'hold');
  assert.deepEqual(result.violations, []);
});

test('candidate correctness and timing evidence is required separately for product adoption', () => {
  const approvedPolicy = structuredClone(policy);
  approvedPolicy.forwardPlus.decision = 'product-approved';
  const evidence = validForwardPlusEvidence();
  evidence.candidateComparison = {
    status: 'available',
    gpuP95ImprovementRatio: 0.2,
    smallSceneGpuP95RegressionRatio: 0.01,
    candidateOverflowCount: 0,
  };
  const result = evaluateLightingArchitectureDecision(approvedPolicy, {
    lightingScaling: currentLightingEvidence,
    forwardPlusEvidence: evidence,
    csmEvidence: null,
  });
  assert.equal(result.forwardPlus.productStatus, 'eligible-for-product');
  assert.deepEqual(result.violations, []);
});

test('CSM approval is independent from light-cap and Forward+ evidence', () => {
  const approvedPolicy = structuredClone(policy);
  approvedPolicy.csm.decision = 'prototype-approved';
  const result = evaluateLightingArchitectureDecision(approvedPolicy, {
    lightingScaling: null,
    forwardPlusEvidence: null,
    csmEvidence: {
      format: 'haiyue-csm-product-decision@1',
      contentRequirementId: 'outdoor-world-shadow-001',
      sourceGame: 'open-world-fixture',
      fixedCameraReplayId: 'outdoor-long-view-v1',
      nearFarReferenceId: 'near-far-pixel-reference-v1',
      requiredShadowDistanceMeters: 250,
      baselineDeficit: { nearQualityFailed: false, farCoverageFailed: true },
      deviceClasses: ['apple-integrated', 'windows-integrated'],
      unclassifiedFailureCount: 0,
    },
  });
  assert.equal(result.forwardPlus.status, 'hold');
  assert.equal(result.csm.status, 'eligible-for-prototype');
  assert.deepEqual(result.violations, []);
});

function validForwardPlusEvidence() {
  return {
    format: 'haiyue-lighting-product-decision@1',
    contentRequirementId: 'billiards-event-lighting-001',
    sourceGame: 'billiards-3d',
    requiredVisibleLightCount: 12,
    fixedCameraReplayId: 'billiards-3d-lighting-camera-v1',
    referencePixelHash: 'sha256:fixture',
    deviceClasses: ['apple-integrated', 'windows-integrated'],
    samePictureBaseline: { status: 'available' },
    unclassifiedFailureCount: 0,
  };
}
