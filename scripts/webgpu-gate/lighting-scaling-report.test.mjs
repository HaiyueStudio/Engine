import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLightingScalingFixtureConfiguration,
} from '../benchmark/lighting-scaling-fixture.mjs';
import { summarizeTimingSamples } from '../benchmark/timing-cohorts.mjs';
import {
  LIGHTING_SCALING_RESULT_FORMAT,
  validateLightingScalingResult,
} from './lighting-scaling-contract.mjs';
import {
  LIGHTING_SCALING_FAILURE_CATEGORIES,
  buildLightingScalingReport,
} from './lighting-scaling-report.mjs';

test('one-local-light complete report separates execution, capability, and metrics', () => {
  const fixture = createFixture(1);
  const rendererMetrics = createRendererMetrics(fixture, {
    submittedLocalLightCount: 1,
    unsubmittedLocalLightCount: 0,
  });
  const report = createReport({ fixture, rendererMetrics });

  assert.equal(report.format, LIGHTING_SCALING_RESULT_FORMAT);
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(validateLightingScalingResult(report), []);
  assert.equal(report.execution.benchmarkSucceeded, true);
  assert.equal(report.capability.status, 'complete-for-selected-input');
  assert.equal(report.capability.rendererCoversAllLights, true);
  assert.equal(report.capability.rendererLocalLightCapacity, 6);
  assert.equal(report.capability.rendererTotalLightCapacity, 8);
  assert.equal(report.metrics.timing.cpuRecord.status, 'available');
  assert.deepEqual(
    report.metrics.timing.cpuRecord.value.rawSamples,
    [1, 1.5, 2],
  );
  assert.deepEqual(report.metrics.timing.sceneCulling, {
    status: 'unavailable',
    reason:
      'current-renderer-does-not-expose-scene-culling-gpu-timestamps',
  });
  assert.equal(report.metricCollection.status, 'partial');
  assert.equal(report.metrics.evidence.sceneProvenance.value.matchesExpectedSource, true);
  assert.equal(report.failureSummary.counts['light-cap-overflow'], 0);
  assert.ok(report.failureSummary.counts['metric-unavailable'] > 0);
  assert.equal(report.failureSummary.unclassifiedFailureCount, 0);
});

test('128-light known cap can execute successfully without claiming coverage', () => {
  const fixture = createFixture(128);
  const rendererMetrics = createRendererMetrics(fixture, {
    submittedLocalLightCount: 6,
    unsubmittedLocalLightCount: 122,
  });
  const report = createReport({ fixture, rendererMetrics });

  assert.deepEqual(validateLightingScalingResult(report), []);
  assert.equal(report.execution.status, 'passed');
  assert.equal(report.execution.benchmarkSucceeded, true);
  assert.equal(report.capability.status, 'known-forward-light-cap');
  assert.equal(report.capability.rendererCoversAllLights, false);
  assert.equal(report.capability.authoredLocalLightCount, 128);
  assert.equal(report.capability.submittedLocalLightCount, 6);
  assert.equal(report.capability.overflowLocalLightCount, 122);
  assert.equal(report.failureSummary.counts['light-cap-overflow'], 1);
  assert.equal(report.failureSummary.unclassifiedFailureCount, 0);
});

test('missing GPU timestamp retains exact reason and metric attribution', () => {
  const fixture = createFixture(8);
  const timingSamples = createTimingSamples();
  timingSamples.gpuTimestamp = {
    status: 'unavailable',
    reason: 'timestamp-query feature is unavailable on this adapter',
  };
  const report = createReport({
    fixture,
    timingSamples,
    rendererMetrics: createRendererMetrics(fixture),
  });

  assert.deepEqual(report.metrics.timing.gpuTimestamp, {
    status: 'unavailable',
    reason: 'timestamp-query feature is unavailable on this adapter',
  });
  assert.equal(report.execution.benchmarkSucceeded, true);
  assert.equal(report.metricCollection.status, 'partial');
  assert.equal(report.failureSummary.counts['missing-gpu-timestamp'], 1);
  assert.equal(report.failureSummary.unclassifiedFailureCount, 0);
});

test('scene hash mismatch is classified without rewriting execution outcome', () => {
  const fixture = createFixture(8);
  const rendererMetrics = createRendererMetrics(fixture);
  const sceneProvenance = createSceneProvenance();
  sceneProvenance.observed.sourceFingerprint = 'sha256:wrong-scene';
  const report = createReport({
    fixture,
    rendererMetrics,
    sceneProvenance,
  });

  assert.deepEqual(validateLightingScalingResult(report), []);
  assert.equal(
    report.metrics.evidence.sceneProvenance.value.matchesExpectedSource,
    false,
  );
  assert.equal(report.execution.benchmarkSucceeded, true);
  assert.equal(report.failureSummary.counts['scene-content-mismatch'], 1);
  assert.equal(report.failureSummary.unclassifiedFailureCount, 0);
});

test('validation, owner residual, and schema errors stay fully classified', () => {
  const fixture = createFixture(8);
  const rendererMetrics = createRendererMetrics(fixture, {
    ownerResidual: 2,
  });
  const report = createReport({
    fixture: { ...fixture, id: '' },
    rendererMetrics,
    execution: {
      status: 'passed',
      validationErrors: ['bind group validation failed'],
      ownerResidual: 2,
    },
  });

  assert.equal(report.execution.benchmarkSucceeded, false);
  assert.equal(report.execution.validation.status, 'failed');
  assert.equal(report.execution.ownerCleanup.status, 'failed');
  assert.equal(report.failureSummary.counts['webgpu-validation'], 1);
  assert.equal(report.failureSummary.counts['owner-residual'], 1);
  assert.ok(report.failureSummary.counts['schema-invalid'] > 0);
  assert.equal(report.failureSummary.unclassifiedFailureCount, 0);
  assert.ok(report.failures.every(failure =>
    LIGHTING_SCALING_FAILURE_CATEGORIES.includes(failure.category)));
});

function createReport({
  fixture,
  timingSamples = createTimingSamples(),
  rendererMetrics,
  sceneProvenance = createSceneProvenance(),
  execution = {
    status: 'passed',
    validationErrors: [],
    ownerResidual: rendererMetrics.ownerResidual,
  },
}) {
  return buildLightingScalingReport({
    fixture,
    timingSamples,
    rendererMetrics,
    sceneProvenance,
    execution,
    metadata: {
      matrix: {
        localLightCounts: [1, 8, 32, 128],
        caseCount: 216,
      },
      adapter: { vendor: 'test-vendor' },
      browser: 'test-browser',
      sceneHttpRequestCount: 1,
      setup: { scenarioMs: 3, pipelineWarmupMs: 7 },
    },
  });
}

function createFixture(localLightCount) {
  return createLightingScalingFixtureConfiguration({
    localLightCount,
    overlap: 'high',
    dynamicRatio: 0.25,
    viewCount: 1,
    resolution: '720p',
  });
}

function createRendererMetrics(fixture, overrides = {}) {
  const submittedLocalLightCount = overrides.submittedLocalLightCount
    ?? Math.min(fixture.localLightCount, 6);
  const submittedAmbientLightCount = 1;
  const submittedDirectionalLightCount = 1;
  const submittedTotalLightCount = submittedAmbientLightCount
    + submittedDirectionalLightCount
    + submittedLocalLightCount;
  const authoredTotalLightCount = fixture.localLightCount + 2;
  return {
    lightingFixtureId: fixture.id,
    lightingFixtureFormat: fixture.format,
    lightingSourceGame: fixture.sourceGame,
    lightingSceneRevision: fixture.sceneRevision,
    lightingCameraReplayId: fixture.cameraReplay.id,
    authoredAmbientLightCount: 1,
    authoredDirectionalLightCount: 1,
    authoredLocalLightCount: fixture.localLightCount,
    authoredTotalLightCount,
    submittedAmbientLightCount,
    submittedDirectionalLightCount,
    submittedLocalLightCount,
    submittedLightCount: submittedTotalLightCount,
    submittedTotalLightCount,
    unsubmittedLocalLightCount:
      overrides.unsubmittedLocalLightCount
      ?? fixture.localLightCount - submittedLocalLightCount,
    unsubmittedTotalLightCount:
      authoredTotalLightCount - submittedTotalLightCount,
    rendererTotalLightCapacity: 8,
    rendererLocalLightCapacity: 6,
    sourceSceneEntityCount: 43,
    runtimeWorldEntityCount:
      43 + fixture.localLightCount + fixture.viewCount,
    sourceSceneSkippedComponentCount: 17,
    sourceSceneIntentionallySkippedComponentCount: 6,
    sourceSceneUnsupportedMaterialMeshCount: 11,
    sourceSceneUnsupportedMaterialAffectedEntityCount: 11,
    realContentProvenance: {
      intentionallySkippedComponentTypes: [
        'Camera2D',
        'Camera3D',
        'CanvasTextComponent',
        'KeyboardComponent',
        'ScriptComponent',
      ],
      unsupportedMaterialDiagnostics: [{
        code: 'BILLIARDS_REAL_RENDERER_UNSUPPORTED_MATERIAL',
        skippedMeshComponentCount: 11,
        affectedEntityCount: 11,
      }],
    },
    rendererAbiChanged: false,
    ownerResidual: 0,
    drawsPerFrame: 14,
    renderPassesPerFrame: 3,
    ...overrides,
  };
}

function createTimingSamples() {
  return {
    warmup: summarizeTimingSamples([8, 7]),
    timing: summarizeTimingSamples([4, 5, 6]),
    cpuRecord: summarizeTimingSamples([1, 1.5, 2]),
    cpuSubmit: summarizeTimingSamples([0.1, 0.12, 0.11]),
    cpuUpdate: summarizeTimingSamples([2, 2.5, 3]),
    sampleWall: summarizeTimingSamples([4.5, 5.5, 6.5]),
    queueWait: summarizeTimingSamples([0.5, 0.75, 1]),
    gpuTimestamp: {
      status: 'available',
      timing: summarizeTimingSamples([2.5, 2.75, 3]),
      passLabels: ['shadow', 'main-scene'],
    },
  };
}

function createSceneProvenance() {
  return {
    expected: {
      sourceFingerprint: 'sha256:billiards-scene',
    },
    observed: {
      sourceGame: 'billiards-3d',
      sceneRevision: 'lighting-scale-v1',
      fixtureId: 'lighting.billiards-3d',
      cameraReplayId: 'billiards-3d-lighting-camera-v1',
      sourceFingerprint: 'sha256:billiards-scene',
    },
  };
}
