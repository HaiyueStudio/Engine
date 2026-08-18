import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeTimingSamples } from '../benchmark/timing-cohorts.mjs';
import {
  LIGHTING_SCALING_EVIDENCE_METRICS,
  LIGHTING_SCALING_RESULT_FORMAT,
  LIGHTING_SCALING_RESULT_SCHEMA_VERSION,
  LIGHTING_SCALING_TIMING_METRICS,
  assertLightingScalingResult,
  validateLightingScalingResult,
} from './lighting-scaling-contract.mjs';

function available(value) {
  return { status: 'available', value };
}

function unavailable(reason) {
  return { status: 'unavailable', reason };
}

function passingForwardResult() {
  const timing = Object.fromEntries(
    LIGHTING_SCALING_TIMING_METRICS.map((name, index) => [
      name,
      available(summarizeTimingSamples([index + 1, index + 2, index + 3])),
    ]),
  );
  timing.gpuTimestamp = unavailable(
    'timestamp-query is not exposed by this adapter',
  );
  return {
    format: LIGHTING_SCALING_RESULT_FORMAT,
    schemaVersion: LIGHTING_SCALING_RESULT_SCHEMA_VERSION,
    suite: 'lighting.scaling.real-renderer',
    caseId: 'lighting.billiards-3d.6l.medium.25pct.4v.1080p',
    renderer: {
      name: 'PbrRenderer',
      lightingStrategy: 'forward',
    },
    configuration: {
      authoredAmbientLightCount: 1,
      authoredDirectionalLightCount: 1,
      authoredLocalLightCount: 6,
      authoredTotalLightCount: 8,
      viewCount: 4,
    },
    workload: {
      sourceSceneEntityCount: 43,
      runtimeWorldEntityCount: 53,
      sceneHttpRequestCount: 1,
      authoredLocalLightCount: 6,
      viewCount: 4,
    },
    metrics: {
      timing,
      evidence: {
        lightOverflow: available({
          authoredAmbientLightCount: 1,
          authoredDirectionalLightCount: 1,
          authoredLocalLightCount: 6,
          authoredTotalLightCount: 8,
          submittedAmbientLightCount: 1,
          submittedDirectionalLightCount: 1,
          submittedLocalLightCount: 6,
          submittedTotalLightCount: 8,
          overflowLocalLightCount: 0,
          overflowTotalLightCount: 0,
          rendererTotalLightCapacity: 8,
          rendererLocalLightCapacity: 6,
          renderingComplete: true,
          capability: 'complete-for-selected-input',
        }),
        perViewIsolation: available({
          viewCount: 4,
          isolated: true,
          violationCount: 0,
        }),
        clusteredTileDistribution: unavailable(
          'Forward renderer does not build clustered or tiled light lists',
        ),
        gpuResidentAllocation: available({
          residentBytes: 4_096,
          allocatedBytes: 8_192,
          allocationCount: 2,
          resourceCount: 2,
        }),
        sceneProvenance: available({
          sourceGame: 'billiards-3d',
          sceneRevision: 'lighting-scale-v1',
          fixtureId: 'lighting.billiards-3d.8l.medium.25pct.4v.1080p',
          cameraReplayId: 'billiards-3d-lighting-camera-v1',
          sourceFingerprint: 'sha256:fixture',
          sourceSceneEntityCount: 43,
          runtimeWorldEntityCount: 53,
          skippedComponentCount: 17,
          intentionallySkippedComponentCount: 6,
          intentionallySkippedComponentTypes: [
            'Camera2D',
            'Camera3D',
            'CanvasTextComponent',
            'KeyboardComponent',
            'ScriptComponent',
          ],
          unsupportedMaterialMeshCount: 11,
          unsupportedMaterialAffectedEntityCount: 11,
          unsupportedMaterialDiagnostics: [{
            code: 'BILLIARDS_REAL_RENDERER_UNSUPPORTED_MATERIAL',
            skippedMeshComponentCount: 11,
            affectedEntityCount: 11,
          }],
        }),
      },
    },
  };
}

test('accepts a complete v2 Forward artifact with explicit unavailable metrics', () => {
  const result = passingForwardResult();
  assert.deepEqual(validateLightingScalingResult(result), []);
  assert.equal(assertLightingScalingResult(result), result);
});

test('accepts future metrics only when they keep the v2 availability envelope', () => {
  const result = passingForwardResult();
  result.metrics.timing.futureLightingPhase = available(
    summarizeTimingSamples([0.5, 0.75, 1]),
  );
  result.metrics.evidence.futureGpuEvidence = unavailable(
    'instrumentation is planned for the next renderer backend',
  );
  assert.deepEqual(validateLightingScalingResult(result), []);
});

test('rejects an artifact that does not identify the exact v2 contract', () => {
  const result = passingForwardResult();
  result.format = 'haiyue-lighting-scaling-result@1';
  result.schemaVersion = 1;
  const errors = validateLightingScalingResult(result);
  assert.equal(errors.some(error => error.includes('format must be')), true);
  assert.equal(errors.some(error => error.includes('schemaVersion must be 2')), true);
});

test('rejects every missing required timing or evidence metric', () => {
  for (const metricName of LIGHTING_SCALING_TIMING_METRICS) {
    const result = passingForwardResult();
    delete result.metrics.timing[metricName];
    assert.equal(
      validateLightingScalingResult(result).some(error =>
        error.includes(`metrics.timing.${metricName} is required`)),
      true,
      metricName,
    );
  }
  for (const metricName of LIGHTING_SCALING_EVIDENCE_METRICS) {
    const result = passingForwardResult();
    delete result.metrics.evidence[metricName];
    assert.equal(
      validateLightingScalingResult(result).some(error =>
        error.includes(`metrics.evidence.${metricName} is required`)),
      true,
      metricName,
    );
  }
});

test('rejects illegal metric status and unavailable metrics without a reason', () => {
  const illegal = passingForwardResult();
  illegal.metrics.timing.cpuRecord = {
    status: 'pending',
    value: summarizeTimingSamples([1]),
  };
  assert.equal(
    validateLightingScalingResult(illegal).some(error =>
      error.includes('cpuRecord.status must be available or unavailable')),
    true,
  );

  const noReason = passingForwardResult();
  noReason.metrics.timing.gpuTimestamp = { status: 'unavailable' };
  assert.equal(
    validateLightingScalingResult(noReason).some(error =>
      error.includes('gpuTimestamp.reason must be a non-empty string')),
    true,
  );

  const extension = passingForwardResult();
  extension.metrics.evidence.futureMetric = { status: 'unknown' };
  assert.equal(
    validateLightingScalingResult(extension).some(error =>
      error.includes('futureMetric.status must be available or unavailable')),
    true,
  );
});

test('rejects timing statistics whose P99 is lower than P95', () => {
  const result = passingForwardResult();
  result.metrics.timing.cpuSubmit.value.p99 =
    result.metrics.timing.cpuSubmit.value.p95 - 0.1;
  const errors = validateLightingScalingResult(result);
  assert.equal(
    errors.some(error =>
      error.includes('cpuSubmit.value.p99 must be greater than or equal to p95')),
    true,
  );
});

test('requires Forward cluster data to be unavailable with an explicit reason', () => {
  const result = passingForwardResult();
  result.metrics.evidence.clusteredTileDistribution = available({
    strategy: 'clustered',
    bucketCount: 64,
    nonEmptyBucketCount: 32,
    maxLightsPerBucket: 8,
    meanLightsPerBucket: 4,
    overflowBucketCount: 0,
  });
  assert.equal(
    validateLightingScalingResult(result).some(error =>
      error.includes('must be unavailable for the Forward renderer')),
    true,
  );
});

test('cannot report complete Forward rendering when total lights exceed capacity', () => {
  const result = passingForwardResult();
  result.configuration.authoredLocalLightCount = 8;
  result.configuration.authoredTotalLightCount = 10;
  result.workload.authoredLocalLightCount = 8;
  result.workload.runtimeWorldEntityCount = 55;
  result.metrics.evidence.sceneProvenance.value.runtimeWorldEntityCount = 55;
  result.metrics.evidence.lightOverflow = available({
    authoredAmbientLightCount: 1,
    authoredDirectionalLightCount: 1,
    authoredLocalLightCount: 8,
    authoredTotalLightCount: 10,
    submittedAmbientLightCount: 1,
    submittedDirectionalLightCount: 1,
    submittedLocalLightCount: 8,
    submittedTotalLightCount: 10,
    overflowLocalLightCount: 0,
    overflowTotalLightCount: 0,
    rendererTotalLightCapacity: 8,
    rendererLocalLightCapacity: 6,
    renderingComplete: true,
    capability: 'complete',
  });
  const errors = validateLightingScalingResult(result);
  assert.equal(
    errors.some(error => error.includes('must report overflow')),
    true,
  );
  assert.equal(
    errors.some(error => error.includes('cannot report complete Forward rendering')),
    true,
  );
  assert.equal(
    errors.some(error => error.includes('must be known-forward-light-cap')),
    true,
  );

  result.metrics.evidence.lightOverflow = available({
    authoredAmbientLightCount: 1,
    authoredDirectionalLightCount: 1,
    authoredLocalLightCount: 8,
    authoredTotalLightCount: 10,
    submittedAmbientLightCount: 1,
    submittedDirectionalLightCount: 1,
    submittedLocalLightCount: 6,
    submittedTotalLightCount: 8,
    overflowLocalLightCount: 2,
    overflowTotalLightCount: 2,
    rendererTotalLightCapacity: 8,
    rendererLocalLightCapacity: 6,
    renderingComplete: false,
    capability: 'known-forward-light-cap',
  });
  assert.deepEqual(validateLightingScalingResult(result), []);
});

test('rejects local capacity that fails to reserve ambient and directional slots', () => {
  const result = passingForwardResult();
  result.metrics.evidence.lightOverflow.value.rendererLocalLightCapacity = 8;
  assert.equal(
    validateLightingScalingResult(result).some(error =>
      error.includes('must reserve authored ambient and directional lights')),
    true,
  );
});

test('clustered and tiled renderers must publish distribution evidence', () => {
  const result = passingForwardResult();
  result.renderer.lightingStrategy = 'clustered';
  assert.equal(
    validateLightingScalingResult(result).some(error =>
      error.includes('must be available for clustered lighting')),
    true,
  );

  result.metrics.evidence.clusteredTileDistribution = available({
    strategy: 'clustered',
    bucketCount: 64,
    nonEmptyBucketCount: 32,
    maxLightsPerBucket: 8,
    meanLightsPerBucket: 4,
    overflowBucketCount: 0,
  });
  assert.deepEqual(validateLightingScalingResult(result), []);
});
