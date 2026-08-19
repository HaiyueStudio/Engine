import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateCapabilityAdmissionPolicy } from './capability-admission-policy.mjs';

const policy = JSON.parse(await readFile(
  new URL('../config/capability-admission-policy.json', import.meta.url),
  'utf8',
));
const hash = `sha256:${'a'.repeat(64)}`;

test('all unproven P3 capabilities remain on hold without violations', () => {
  const result = evaluateCapabilityAdmissionPolicy(policyWithRayTracingHold());
  assert.equal(result.rayTracing.status, 'hold');
  assert.equal(result.webgl2Fallback.status, 'hold');
  assert.equal(result.layeredNavMesh.status, 'hold');
  assert.deepEqual(
    Object.values(result.clippingExtensions).map(entry => entry.status),
    ['hold', 'hold', 'hold', 'hold'],
  );
  assert.deepEqual(result.violations, []);
});

test('complete real-product cases can unlock only a ray-tracing prototype', () => {
  const approved = structuredClone(policy);
  approved.rayTracing.decision = 'prototype-approved';
  const result = evaluateCapabilityAdmissionPolicy(approved, {
    rayTracing: validRayTracingEvidence(),
  });
  assert.equal(result.rayTracing.status, 'eligible-for-prototype');
  assert.equal(result.webgl2Fallback.status, 'hold');
  assert.equal(result.layeredNavMesh.status, 'hold');
  assert.deepEqual(result.violations, []);
});

test('each ray-tracing effect requires independent replay and reference evidence', () => {
  const approved = structuredClone(policy);
  approved.rayTracing.decision = 'prototype-approved';
  const evidence = validRayTracingEvidence();
  evidence.cases = evidence.cases.filter(productCase => productCase.effectId !== 'hybrid-reflection');
  evidence.cases[0].referenceImageSha256 = evidence.cases[0].baselineImageSha256;
  evidence.unclassifiedFailureCount = 1;
  const result = evaluateCapabilityAdmissionPolicy(approved, { rayTracing: evidence });
  assert.equal(result.rayTracing.status, 'hold');
  assert.ok(result.rayTracing.reasons.includes('required-effect-case-missing:hybrid-reflection'));
  assert.ok(result.rayTracing.reasons.includes('reference-does-not-demonstrate-deficit:path-tracing'));
  assert.ok(result.rayTracing.reasons.includes('unclassified-failures-remain'));
  assert.equal(result.violations.length, 1);
});

test('real coverage demand can unlock only a WebGL2 prototype', () => {
  const approved = policyWithRayTracingHold();
  approved.webgl2Fallback.decision = 'prototype-approved';
  const result = evaluateCapabilityAdmissionPolicy(approved, {
    webgl2Fallback: validWebGl2Evidence(),
  });
  assert.equal(result.webgl2Fallback.status, 'eligible-for-prototype');
  assert.equal(result.layeredNavMesh.status, 'hold');
  assert.deepEqual(result.violations, []);
});

test('synthetic coverage claims and unclassified failures cannot unlock WebGL2', () => {
  const evidence = validWebGl2Evidence();
  evidence.demand = {
    telemetryWindowDays: 2,
    measuredSessions: 10,
    webGpuUnavailableSessionRatio: 0.001,
    mandatedTargetIds: [],
  };
  evidence.unclassifiedFailureCount = 1;
  const result = evaluateCapabilityAdmissionPolicy(policyWithRayTracingHold(), { webgl2Fallback: evidence });
  assert.equal(result.webgl2Fallback.status, 'hold');
  assert.ok(result.webgl2Fallback.reasons.includes('target-coverage-demand-not-proven'));
  assert.ok(result.webgl2Fallback.reasons.includes('unclassified-failures-remain'));
});

test('a real overlapping-surface route unlocks only layered NavMesh', () => {
  const approved = policyWithRayTracingHold();
  approved.layeredNavMesh.decision = 'prototype-approved';
  const result = evaluateCapabilityAdmissionPolicy(approved, {
    layeredNavMesh: validLayeredNavMeshEvidence(),
  });
  assert.equal(result.layeredNavMesh.status, 'eligible-for-prototype');
  assert.equal(result.webgl2Fallback.status, 'hold');
  assert.deepEqual(result.violations, []);
});

test('each clipping extension requires its own renderer-specific evidence', () => {
  for (const feature of ['caps', 'instanced', 'line', 'planarMirror']) {
    const approved = policyWithRayTracingHold();
    approved.clippingExtensions[feature].decision = 'prototype-approved';
    const result = evaluateCapabilityAdmissionPolicy(approved, {
      clippingExtensions: { [feature]: validClippingEvidence(feature) },
    });
    assert.equal(result.clippingExtensions[feature].status, 'eligible-for-prototype');
    for (const other of ['caps', 'instanced', 'line', 'planarMirror']) {
      if (other !== feature) assert.equal(result.clippingExtensions[other].status, 'hold');
    }
    assert.deepEqual(result.violations, []);
  }
});

test('approval without complete evidence is a gate violation', () => {
  const approved = policyWithRayTracingHold();
  approved.layeredNavMesh.decision = 'prototype-approved';
  const result = evaluateCapabilityAdmissionPolicy(approved);
  assert.deepEqual(result.violations, [
    'layeredNavMesh decision prototype-approved does not match evaluated status hold.',
  ]);
});

test('check:fast executes the unified admission checker', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.scripts['capability:admission:check'],
    'node scripts/check-capability-admission.mjs',
  );
  assert.match(packageJson.scripts['check:fast'], /npm run capability:admission:check/);
});

function validWebGl2Evidence() {
  return {
    format: 'haiyue-webgl2-product-decision@1',
    productRequirementId: 'public-web-player-coverage-001',
    sourceProduct: 'haiyue-player',
    baselineDeficit: { webGpuOnlyBlocksRelease: true },
    demand: {
      telemetryWindowDays: 30,
      measuredSessions: 10_000,
      webGpuUnavailableSessionRatio: 0.08,
      mandatedTargetIds: [],
    },
    representativeSceneIds: ['golden-path', 'pbr-character', 'gltf-scene'],
    fixedReplayIds: ['golden-v1', 'pbr-v1', 'gltf-v1'],
    deviceClasses: ['windows-integrated', 'android-mobile'],
    requiredParityAreas: ['golden-path', 'pbr', 'asset-loading'],
    contentManifestSha256: hash,
    unclassifiedFailureCount: 0,
  };
}

function policyWithRayTracingHold() {
  const unproven = structuredClone(policy);
  unproven.rayTracing.decision = 'hold';
  return unproven;
}

function validRayTracingEvidence() {
  const referenceHash = `sha256:${'b'.repeat(64)}`;
  return {
    format: 'haiyue-ray-tracing-product-decision@1',
    productRequirementId: 'studio-rendering-quality-001',
    contentManifestSha256: hash,
    cases: policy.rayTracing.requiredEffectIds.map(effectId => ({
      effectId,
      sourceProduct: `haiyue-product-${effectId}`,
      sourceRevision: {
        commitSha: 'c'.repeat(40),
        dirty: false,
      },
      fixedSceneId: `${effectId}-scene-v1`,
      fixedCameraReplayId: `${effectId}-camera-v1`,
      sceneSha256: hash,
      baselineImageSha256: hash,
      referenceImageSha256: referenceHash,
      referenceKind: 'offline-path-traced',
      baselineDeficit: {
        currentPathFailed: true,
        kind: policy.rayTracing.acceptedDeficitKinds[effectId][0],
      },
      deviceClasses: ['windows-discrete'],
      capture: {
        browser: 'Chrome',
        browserVersion: '140.0.0.0',
        backend: 'D3D12',
        adapterName: 'representative discrete GPU',
        softwareAdapter: false,
      },
    })),
    unclassifiedFailureCount: 0,
  };
}

function validLayeredNavMeshEvidence() {
  return {
    format: 'haiyue-layered-navmesh-product-decision@1',
    contentRequirementId: 'cave-route-001',
    sourceGame: 'layered-world-fixture',
    fixedRouteReplayId: 'cave-route-v1',
    sceneSha256: hash,
    topologyKind: 'cave',
    maximumSurfaceCountAtSameXZ: 3,
    heightfieldBaseline: { unsupportedRouteObserved: true },
    deviceClasses: ['apple-integrated'],
    unclassifiedFailureCount: 0,
  };
}

function validClippingEvidence(feature) {
  const entry = policy.clippingExtensions[feature];
  return {
    format: 'haiyue-clipping-extension-decision@1',
    feature,
    contentRequirementId: `${feature}-workflow-001`,
    sourceProject: 'representative-content-project',
    fixedCameraReplayId: `${feature}-camera-v1`,
    sceneSha256: hash,
    referenceImageSha256: hash,
    useCase: entry.acceptedUseCases[0],
    baselineDeficit: { currentPathFailed: true },
    [entry.workloadMetric]: entry.minimumWorkload,
    deviceClasses: entry.minimumDeviceClassCount === 1
      ? ['apple-integrated']
      : ['apple-integrated', 'windows-integrated'],
    unclassifiedFailureCount: 0,
  };
}
