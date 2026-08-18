import {
  LIGHTING_SCALING_EVIDENCE_METRICS,
  LIGHTING_SCALING_RESULT_FORMAT,
  LIGHTING_SCALING_RESULT_SCHEMA_VERSION,
  LIGHTING_SCALING_TIMING_METRICS,
  validateLightingScalingResult,
} from './lighting-scaling-contract.mjs';

export const LIGHTING_SCALING_FAILURE_CATEGORIES = Object.freeze([
  'scene-content-mismatch',
  'webgpu-validation',
  'light-cap-overflow',
  'missing-gpu-timestamp',
  'metric-unavailable',
  'owner-residual',
  'schema-invalid',
]);

const TIMING_UNAVAILABLE_REASONS = Object.freeze({
  cpuRecord: 'cpu-record-timing-was-not-collected',
  cpuSubmit: 'cpu-submit-timing-was-not-collected',
  cpuUpdate: 'cpu-update-timing-was-not-collected',
  sampleWall: 'sample-wall-timing-was-not-collected',
  queueWait: 'queue-wait-timing-was-not-collected',
  gpuTimestamp: 'gpu-timestamp-was-not-collected',
  sceneCulling:
    'current-renderer-does-not-expose-scene-culling-gpu-timestamps',
  lightCulling:
    'current-forward-renderer-does-not-have-a-separate-light-culling-pass',
  lightListBuild:
    'current-forward-renderer-does-not-have-a-separate-light-list-build-pass',
  lightUpload:
    'current-renderer-does-not-expose-a-light-upload-gpu-timestamp',
  opaqueShading:
    'current-renderer-does-not-expose-an-opaque-shading-gpu-timestamp',
  shadowPass:
    'current-renderer-does-not-expose-a-shadow-pass-gpu-timestamp',
});

const EVIDENCE_UNAVAILABLE_REASONS = Object.freeze({
  lightOverflow:
    'renderer-did-not-report-complete-authored-submitted-capacity-and-overflow-light-counts',
  perViewIsolation:
    'current-forward-fixture-does-not-instrument-per-view-light-list-isolation',
  clusteredTileDistribution:
    'forward-renderer-does-not-build-clustered-or-tiled-light-lists',
  gpuResidentAllocation:
    'current-renderer-metrics-do-not-expose-lighting-resident-and-allocated-bytes',
  sceneProvenance:
    'expected-and-observed-scene-fingerprints-were-not-both-provided',
});

/**
 * Creates the schema-v2 lighting result without mutating any input record.
 * Execution, renderer capability, and metric availability are deliberately
 * independent so a known light cap cannot be mistaken for a crashed benchmark.
 */
export function buildLightingScalingReport({
  fixture,
  timingSamples,
  rendererMetrics,
  sceneProvenance,
  execution = {},
  metadata = {},
}) {
  const failures = [];
  const addFailure = createFailureCollector(failures);
  const metricAvailability = {
    available: [],
    unavailable: [],
  };

  const timing = buildTimingMetrics(
    timingSamples,
    addFailure,
    metricAvailability,
  );
  const evidence = buildEvidenceMetrics({
    fixture,
    rendererMetrics,
    sceneProvenance,
    addFailure,
    metricAvailability,
  });
  const executionResult = buildExecution(
    execution,
    rendererMetrics,
    addFailure,
  );
  const capability = buildCapability(
    evidence.lightOverflow,
    rendererMetrics,
  );
  const report = {
    format: LIGHTING_SCALING_RESULT_FORMAT,
    schemaVersion: LIGHTING_SCALING_RESULT_SCHEMA_VERSION,
    suite: metadata.suite ?? 'lighting.scaling.real-fixture',
    caseId: fixture?.id ?? '',
    renderer: {
      name: metadata.rendererName
        ?? rendererMetrics?.rendererName
        ?? 'PbrRenderer/BlinnPhongRenderer',
      lightingStrategy: metadata.lightingStrategy ?? 'forward',
    },
    configuration: {
      fixtureFormat: fixture?.format ?? null,
      sourceGame: fixture?.sourceGame ?? null,
      sceneRevision: fixture?.sceneRevision ?? null,
      cameraReplayId: fixture?.cameraReplay?.id ?? null,
      cameraReplayFrameCount: fixture?.cameraReplay?.frameCount ?? null,
      authoredAmbientLightCount:
        rendererMetrics?.authoredAmbientLightCount ?? null,
      authoredDirectionalLightCount:
        rendererMetrics?.authoredDirectionalLightCount ?? null,
      authoredLocalLightCount: fixture?.localLightCount ?? null,
      authoredTotalLightCount:
        rendererMetrics?.authoredTotalLightCount ?? null,
      overlap: fixture?.overlap ?? null,
      dynamicRatio: fixture?.dynamicRatio ?? null,
      actualDynamicRatio: fixture?.actualDynamicRatio ?? null,
      viewCount: fixture?.viewCount ?? null,
      resolution: fixture?.resolution
        ? {
            id: fixture.resolution.id,
            width: fixture.resolution.width,
            height: fixture.resolution.height,
          }
        : null,
    },
    metrics: {
      timing,
      evidence,
    },
    environment: {
      adapter: metadata.adapter ?? null,
      browser: metadata.browser ?? null,
    },
    workload: {
      sourceSceneEntityCount:
        rendererMetrics?.sourceSceneEntityCount ?? null,
      runtimeWorldEntityCount:
        rendererMetrics?.runtimeWorldEntityCount ?? null,
      sceneHttpRequestCount: metadata.sceneHttpRequestCount ?? null,
      authoredLocalLightCount: fixture?.localLightCount ?? null,
      viewCount: fixture?.viewCount ?? null,
    },
    fixture: snapshotFixture(fixture),
    adapter: metadata.adapter ?? null,
    browser: metadata.browser ?? null,
    warmup: timingSamples?.warmup ?? null,
    timing: timingSamples?.timing ?? null,
    sampleWall: timingSamples?.sampleWall ?? null,
    queueWait: timingSamples?.queueWait ?? null,
    gpuTimestamp: timingSamples?.gpuTimestamp ?? null,
    setup: metadata.setup ?? null,
    matrix: metadata.matrix ?? null,
    sceneProvenance: sceneProvenanceReport(
      sceneProvenance,
      evidence.sceneProvenance,
    ),
    execution: executionResult,
    capability,
    metricCollection: summarizeMetricAvailability(metricAvailability),
    failures,
    failureSummary: null,
  };

  for (const error of validateLightingScalingResult(report)) {
    addFailure('schema-invalid', 'report', error);
  }
  report.failureSummary = summarizeFailures(failures);
  return report;
}

function buildTimingMetrics(
  timingSamples,
  addFailure,
  metricAvailability,
) {
  const timing = {};
  for (const name of LIGHTING_SCALING_TIMING_METRICS) {
    const source = timingSamples?.[name];
    if (name === 'gpuTimestamp') {
      timing[name] = buildGpuTimestampMetric(
        source,
        addFailure,
        metricAvailability,
      );
    } else {
      timing[name] = timingMetric(
        source,
        `metrics.timing.${name}`,
        TIMING_UNAVAILABLE_REASONS[name],
        addFailure,
        metricAvailability,
      );
    }
  }

  for (const [name, sourceName] of [
    ['frameCpu', 'timing'],
    ['warmup', 'warmup'],
  ]) {
    const source = timingSamples?.[sourceName];
    if (source === undefined) continue;
    timing[name] = timingMetric(
      source,
      `metrics.timing.${name}`,
      `${name}-timing-was-not-collected`,
      addFailure,
      metricAvailability,
    );
  }
  return timing;
}

function buildGpuTimestampMetric(
  source,
  addFailure,
  metricAvailability,
) {
  const path = 'metrics.timing.gpuTimestamp';
  if (source?.status === 'available' && isTimingStatistics(source.timing)) {
    markAvailable(metricAvailability, path);
    return {
      status: 'available',
      value: source.timing,
      passLabels: Array.isArray(source.passLabels)
        ? [...source.passLabels]
        : [],
    };
  }
  const reason = nonEmptyString(source?.reason)
    ?? (source?.status === 'available'
      ? 'gpu-timestamp-statistics-were-invalid'
      : TIMING_UNAVAILABLE_REASONS.gpuTimestamp);
  markUnavailable(metricAvailability, path, reason);
  addFailure('missing-gpu-timestamp', path, reason);
  return unavailable(reason);
}

function timingMetric(
  source,
  path,
  missingReason,
  addFailure,
  metricAvailability,
) {
  if (isTimingStatistics(source)) {
    markAvailable(metricAvailability, path);
    return available(source);
  }
  const reason = source?.status === 'unavailable'
    ? nonEmptyString(source.reason) ?? missingReason
    : missingReason;
  markUnavailable(metricAvailability, path, reason);
  addFailure('metric-unavailable', path, reason);
  return unavailable(reason);
}

function buildEvidenceMetrics({
  fixture,
  rendererMetrics,
  sceneProvenance,
  addFailure,
  metricAvailability,
}) {
  const evidence = {};
  evidence.lightOverflow = buildLightOverflowEvidence(
    fixture,
    rendererMetrics,
    addFailure,
    metricAvailability,
  );
  evidence.perViewIsolation = copyEvidenceMetric(
    rendererMetrics?.perViewIsolation,
    'perViewIsolation',
    addFailure,
    metricAvailability,
  );
  evidence.clusteredTileDistribution = copyEvidenceMetric(
    rendererMetrics?.clusteredTileDistribution,
    'clusteredTileDistribution',
    addFailure,
    metricAvailability,
  );
  evidence.gpuResidentAllocation = copyEvidenceMetric(
    rendererMetrics?.gpuResidentAllocation,
    'gpuResidentAllocation',
    addFailure,
    metricAvailability,
  );
  evidence.sceneProvenance = buildSceneProvenanceEvidence(
    fixture,
    rendererMetrics,
    sceneProvenance,
    addFailure,
    metricAvailability,
  );
  if (rendererMetrics && typeof rendererMetrics === 'object') {
    evidence.rendererMetrics = available({ ...rendererMetrics });
    markAvailable(metricAvailability, 'metrics.evidence.rendererMetrics');
  } else {
    const path = 'metrics.evidence.rendererMetrics';
    const reason = 'renderer-metrics-were-not-provided';
    evidence.rendererMetrics = unavailable(reason);
    markUnavailable(metricAvailability, path, reason);
    addFailure('metric-unavailable', path, reason);
  }
  return evidence;
}

function buildLightOverflowEvidence(
  fixture,
  rendererMetrics,
  addFailure,
  metricAvailability,
) {
  const path = 'metrics.evidence.lightOverflow';
  const authoredAmbient = rendererMetrics?.authoredAmbientLightCount;
  const authoredDirectional = rendererMetrics?.authoredDirectionalLightCount;
  const authored = rendererMetrics?.authoredLocalLightCount;
  const authoredTotal = rendererMetrics?.authoredTotalLightCount;
  const submittedAmbient = rendererMetrics?.submittedAmbientLightCount;
  const submittedDirectional = rendererMetrics?.submittedDirectionalLightCount;
  const submitted = rendererMetrics?.submittedLocalLightCount;
  const submittedTotal = rendererMetrics?.submittedTotalLightCount
    ?? rendererMetrics?.submittedLightCount;
  const overflow = rendererMetrics?.unsubmittedLocalLightCount;
  const overflowTotal = rendererMetrics?.unsubmittedTotalLightCount;
  const rendererTotalLightCapacity =
    rendererMetrics?.rendererTotalLightCapacity;
  const rendererLocalLightCapacity =
    rendererMetrics?.rendererLocalLightCapacity;
  if (![
    authoredAmbient,
    authoredDirectional,
    authored,
    authoredTotal,
    submittedAmbient,
    submittedDirectional,
    submitted,
    submittedTotal,
    overflow,
    overflowTotal,
    rendererTotalLightCapacity,
    rendererLocalLightCapacity,
  ].every(isNonNegativeInteger)) {
    const reason = EVIDENCE_UNAVAILABLE_REASONS.lightOverflow;
    markUnavailable(metricAvailability, path, reason);
    addFailure('metric-unavailable', path, reason);
    return unavailable(reason);
  }

  const renderingComplete = overflowTotal === 0;
  const capability = renderingComplete
    ? 'complete-for-selected-input'
    : 'known-forward-light-cap';
  const value = {
    authoredAmbientLightCount: authoredAmbient,
    authoredDirectionalLightCount: authoredDirectional,
    authoredLocalLightCount: authored,
    authoredTotalLightCount: authoredTotal,
    submittedAmbientLightCount: submittedAmbient,
    submittedDirectionalLightCount: submittedDirectional,
    submittedLocalLightCount: submitted,
    submittedTotalLightCount: submittedTotal,
    overflowLocalLightCount: overflow,
    overflowTotalLightCount: overflowTotal,
    rendererTotalLightCapacity,
    rendererLocalLightCapacity,
    renderingComplete,
    capability,
  };
  markAvailable(metricAvailability, path);
  if (authored !== submitted + overflow
    || authoredTotal !== submittedTotal + overflowTotal) {
    addFailure(
      'schema-invalid',
      path,
      'submitted plus overflow lights must equal authored lights',
    );
  }
  if (isNonNegativeInteger(fixture?.localLightCount)
    && fixture.localLightCount !== authored) {
    addFailure(
      'scene-content-mismatch',
      `${path}.authoredLocalLightCount`,
      `renderer authored ${authored} local lights but fixture requested `
        + `${fixture.localLightCount}`,
    );
  }
  if (!renderingComplete) {
    addFailure(
      'light-cap-overflow',
      `${path}.overflowLocalLightCount`,
      `${overflow} authored local light(s) exceeded the renderer cap`,
    );
  }
  return available(value);
}

function copyEvidenceMetric(
  source,
  name,
  addFailure,
  metricAvailability,
) {
  const path = `metrics.evidence.${name}`;
  if (source?.status === 'available') {
    markAvailable(metricAvailability, path);
    return available(source.value);
  }
  if (source !== undefined && source?.status !== 'unavailable') {
    markAvailable(metricAvailability, path);
    return available(source);
  }
  const reason = nonEmptyString(source?.reason)
    ?? EVIDENCE_UNAVAILABLE_REASONS[name];
  markUnavailable(metricAvailability, path, reason);
  addFailure('metric-unavailable', path, reason);
  return unavailable(reason);
}

function buildSceneProvenanceEvidence(
  fixture,
  rendererMetrics,
  sceneProvenance,
  addFailure,
  metricAvailability,
) {
  const path = 'metrics.evidence.sceneProvenance';
  const expected = sceneProvenance?.expected ?? {};
  const observed = sceneProvenance?.observed ?? sceneProvenance ?? {};
  const expectedFingerprint = nonEmptyString(expected.sourceFingerprint)
    ?? nonEmptyString(expected.hash)
    ?? nonEmptyString(sceneProvenance?.expectedSourceFingerprint);
  const observedFingerprint = nonEmptyString(observed.sourceFingerprint)
    ?? nonEmptyString(observed.hash)
    ?? nonEmptyString(sceneProvenance?.sourceFingerprint);
  if (!expectedFingerprint || !observedFingerprint) {
    const reason = EVIDENCE_UNAVAILABLE_REASONS.sceneProvenance;
    markUnavailable(metricAvailability, path, reason);
    addFailure('metric-unavailable', path, reason);
    return unavailable(reason);
  }

  const details = observed.details
    ?? rendererMetrics?.realContentProvenance
    ?? {};
  const value = {
    sourceGame: observed.sourceGame
      ?? rendererMetrics?.lightingSourceGame
      ?? fixture?.sourceGame,
    sceneRevision: observed.sceneRevision
      ?? rendererMetrics?.lightingSceneRevision
      ?? fixture?.sceneRevision,
    fixtureId: observed.fixtureId
      ?? rendererMetrics?.lightingFixtureId
      ?? fixture?.id,
    cameraReplayId: observed.cameraReplayId
      ?? rendererMetrics?.lightingCameraReplayId
      ?? fixture?.cameraReplay?.id,
    sourceFingerprint: observedFingerprint,
    expectedSourceFingerprint: expectedFingerprint,
    matchesExpectedSource: observedFingerprint === expectedFingerprint,
    sourcePath: observed.sourcePath
      ?? details.scenePath
      ?? details.sourcePath,
    byteLength: observed.byteLength
      ?? details.sceneByteLength
      ?? details.byteLength,
    sourceSceneEntityCount: rendererMetrics?.sourceSceneEntityCount
      ?? details.sourceSceneEntityCount,
    runtimeWorldEntityCount: rendererMetrics?.runtimeWorldEntityCount,
    meshCount: rendererMetrics?.realContentMeshCount
      ?? details.meshCount,
    geometryCount: rendererMetrics?.realContentGeometryCount
      ?? details.geometryCount,
    materialCount: rendererMetrics?.realContentMaterialCount
      ?? details.materialCount,
    physicsBodyCount: rendererMetrics?.realContentPhysicsBodyCount
      ?? details.physicsBodyCount,
    skippedComponentCount: rendererMetrics?.sourceSceneSkippedComponentCount
      ?? details.skippedComponentCount,
    intentionallySkippedComponentCount:
      rendererMetrics?.sourceSceneIntentionallySkippedComponentCount
      ?? details.intentionallySkippedComponentCount,
    intentionallySkippedComponentTypes:
      details.intentionallySkippedComponentTypes,
    unsupportedMaterialMeshCount:
      rendererMetrics?.sourceSceneUnsupportedMaterialMeshCount
      ?? details.unsupportedMaterialMeshCount,
    unsupportedMaterialAffectedEntityCount:
      rendererMetrics?.sourceSceneUnsupportedMaterialAffectedEntityCount
      ?? details.unsupportedMaterialAffectedEntityCount,
    unsupportedMaterialDiagnostics: details.unsupportedMaterialDiagnostics,
    physicsSyncChanged3DTransform:
      rendererMetrics?.physicsSyncChanged3DTransform
      ?? details.physicsSyncChanged3DTransform,
  };
  markAvailable(metricAvailability, path);
  if (!value.matchesExpectedSource) {
    addFailure(
      'scene-content-mismatch',
      `${path}.value.sourceFingerprint`,
      `observed scene fingerprint ${observedFingerprint} does not match `
        + expectedFingerprint,
    );
  }
  return available(value);
}

function buildExecution(execution, rendererMetrics, addFailure) {
  const validationErrors = normalizeValidationErrors(
    execution?.validationErrors,
  );
  if (validationErrors.length > 0) {
    addFailure(
      'webgpu-validation',
      'execution.validation',
      `${validationErrors.length} WebGPU validation error(s) were reported`,
      { errors: validationErrors },
    );
  }

  const ownerResidual = execution?.ownerResidual
    ?? rendererMetrics?.ownerResidual;
  if (!isNonNegativeInteger(ownerResidual)) {
    addFailure(
      'metric-unavailable',
      'execution.ownerResidual',
      'owner-residual-metric-was-not-reported',
    );
  } else if (ownerResidual > 0) {
    addFailure(
      'owner-residual',
      'execution.ownerResidual',
      `${ownerResidual} owner resource(s) remained after destroy`,
    );
  }

  const explicitlyFailed = execution?.status === 'failed'
    || execution?.benchmarkSucceeded === false;
  const benchmarkSucceeded = !explicitlyFailed
    && validationErrors.length === 0;
  return {
    status: benchmarkSucceeded ? 'passed' : 'failed',
    benchmarkSucceeded,
    validation: {
      status: validationErrors.length === 0 ? 'passed' : 'failed',
      errorCount: validationErrors.length,
      errors: validationErrors,
    },
    ownerCleanup: isNonNegativeInteger(ownerResidual)
      ? {
          status: ownerResidual === 0 ? 'passed' : 'failed',
          ownerResidual: available(ownerResidual),
        }
      : {
          status: 'unavailable',
          reason: 'owner-residual-metric-was-not-reported',
          ownerResidual: unavailable(
            'owner-residual-metric-was-not-reported',
          ),
        },
  };
}

function buildCapability(lightOverflow, rendererMetrics) {
  if (lightOverflow.status !== 'available') {
    return {
      status: 'unavailable',
      rendererCoversAllLights: null,
    };
  }
  const value = lightOverflow.value;
  return {
    status: value.capability,
    rendererCoversAllLights: value.renderingComplete,
    authoredLocalLightCount: value.authoredLocalLightCount,
    authoredTotalLightCount: value.authoredTotalLightCount,
    submittedLocalLightCount: value.submittedLocalLightCount,
    submittedTotalLightCount: value.submittedTotalLightCount,
    overflowLocalLightCount: value.overflowLocalLightCount,
    unsubmittedLocalLightCount: value.overflowLocalLightCount,
    overflowTotalLightCount: value.overflowTotalLightCount,
    rendererLocalLightCapacity: value.rendererLocalLightCapacity,
    rendererTotalLightCapacity: value.rendererTotalLightCapacity,
    rendererAbiChanged: rendererMetrics?.rendererAbiChanged ?? null,
  };
}

function sceneProvenanceReport(sceneProvenance, metric) {
  const expected = sceneProvenance?.expected ?? {};
  const observed = sceneProvenance?.observed ?? sceneProvenance ?? {};
  if (metric.status !== 'available') {
    return {
      status: 'unavailable',
      reason: metric.reason,
      hashAlgorithm: sceneProvenance?.hashAlgorithm ?? null,
      expected,
      observed,
      matches: null,
    };
  }
  return {
    status: 'available',
    hashAlgorithm: sceneProvenance?.hashAlgorithm ?? null,
    expected: {
      ...expected,
      hash: expected.hash ?? expected.sourceFingerprint,
    },
    observed: {
      ...observed,
      hash: observed.hash ?? observed.sourceFingerprint,
    },
    matches: metric.value.matchesExpectedSource,
  };
}

function snapshotFixture(fixture) {
  return {
    id: fixture?.id ?? null,
    format: fixture?.format ?? null,
    sourceGame: fixture?.sourceGame ?? null,
    sceneRevision: fixture?.sceneRevision ?? null,
    cameraReplayId: fixture?.cameraReplay?.id ?? null,
    cameraReplayFrames: fixture?.cameraReplay?.frameCount ?? null,
    localLightCount: fixture?.localLightCount ?? null,
    overlap: fixture?.overlap ?? null,
    dynamicRatio: fixture?.dynamicRatio ?? null,
    actualDynamicRatio: fixture?.actualDynamicRatio ?? null,
    viewCount: fixture?.viewCount ?? null,
    resolution: fixture?.resolution
      ? {
          id: fixture.resolution.id,
          width: fixture.resolution.width,
          height: fixture.resolution.height,
        }
      : null,
  };
}

function summarizeMetricAvailability(metricAvailability) {
  const availableMetricPaths = [...metricAvailability.available];
  const unavailableMetrics = [...metricAvailability.unavailable];
  return {
    status: unavailableMetrics.length === 0
      ? 'complete'
      : availableMetricPaths.length === 0
        ? 'unavailable'
        : 'partial',
    allMetricsAvailable: unavailableMetrics.length === 0,
    availableMetricCount: availableMetricPaths.length,
    unavailableMetricCount: unavailableMetrics.length,
    availableMetricPaths,
    unavailableMetrics,
  };
}

function summarizeFailures(failures) {
  const counts = Object.fromEntries(
    LIGHTING_SCALING_FAILURE_CATEGORIES.map(category => [category, 0]),
  );
  for (const failure of failures) counts[failure.category]++;
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    failureCount: failures.length,
    counts,
    unclassifiedFailureCount: 0,
  };
}

function isTimingStatistics(value) {
  return value
    && value.unit === 'ms'
    && Number.isInteger(value.sampleCount)
    && value.sampleCount > 0
    && Number.isFinite(value.p50)
    && Number.isFinite(value.p95)
    && Number.isFinite(value.p99)
    && Number.isFinite(value.variance);
}

function normalizeValidationErrors(value) {
  if (Array.isArray(value)) {
    return value.map(error => error instanceof Error
      ? error.message
      : String(error));
  }
  if (Number.isInteger(value) && value > 0) {
    return Array.from(
      { length: value },
      () => 'WebGPU validation error detail unavailable',
    );
  }
  return [];
}

function markAvailable(metricAvailability, path) {
  metricAvailability.available.push(path);
}

function markUnavailable(metricAvailability, path, reason) {
  metricAvailability.unavailable.push({ path, reason });
}

function available(value) {
  return { status: 'available', value };
}

function unavailable(reason) {
  return { status: 'unavailable', reason };
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : null;
}

function createFailureCollector(failures) {
  const keys = new Set();
  return (category, path, message, detail = undefined) => {
    if (!LIGHTING_SCALING_FAILURE_CATEGORIES.includes(category)) {
      throw new Error(`Unknown lighting failure category "${category}".`);
    }
    const key = `${category}\u001f${path}\u001f${message}`;
    if (keys.has(key)) return;
    keys.add(key);
    failures.push({
      category,
      path,
      message,
      ...(detail === undefined ? {} : { detail }),
    });
  };
}
