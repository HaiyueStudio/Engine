export const LIGHTING_SCALING_RESULT_FORMAT =
  'haiyue-lighting-scaling-result@2';
export const LIGHTING_SCALING_RESULT_SCHEMA_VERSION = 2;

export const LIGHTING_SCALING_TIMING_METRICS = Object.freeze([
  'cpuRecord',
  'cpuSubmit',
  'cpuUpdate',
  'sampleWall',
  'queueWait',
  'gpuTimestamp',
  'sceneCulling',
  'lightCulling',
  'lightListBuild',
  'lightUpload',
  'opaqueShading',
  'shadowPass',
]);

export const LIGHTING_SCALING_EVIDENCE_METRICS = Object.freeze([
  'lightOverflow',
  'perViewIsolation',
  'clusteredTileDistribution',
  'gpuResidentAllocation',
  'sceneProvenance',
]);

const LIGHTING_STRATEGIES = Object.freeze([
  'forward',
  'clustered',
  'tiled',
]);

/**
 * Validates one lighting-scaling measurement without mutating the artifact.
 *
 * Required metrics cannot be omitted. Additional timing/evidence metrics are
 * allowed for forward-compatible instrumentation, but must use the same
 * explicit available/unavailable envelope.
 */
export function validateLightingScalingResult(result) {
  const errors = [];
  const fail = message => errors.push(message);

  if (!isRecord(result)) return ['result must be an object'];
  if (result.format !== LIGHTING_SCALING_RESULT_FORMAT) {
    fail(`format must be ${LIGHTING_SCALING_RESULT_FORMAT}`);
  }
  if (result.schemaVersion !== LIGHTING_SCALING_RESULT_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${LIGHTING_SCALING_RESULT_SCHEMA_VERSION}`);
  }
  requireNonEmptyString(result.suite, 'suite', fail);
  requireNonEmptyString(result.caseId, 'caseId', fail);

  const renderer = requireRecord(result.renderer, 'renderer', fail);
  const lightingStrategy = renderer?.lightingStrategy;
  if (!LIGHTING_STRATEGIES.includes(lightingStrategy)) {
    fail(
      'renderer.lightingStrategy must be forward, clustered, or tiled',
    );
  }
  requireNonEmptyString(renderer?.name, 'renderer.name', fail);

  const configuration = requireRecord(
    result.configuration,
    'configuration',
    fail,
  );
  requireNonNegativeInteger(
    configuration?.authoredLocalLightCount,
    'configuration.authoredLocalLightCount',
    fail,
  );
  requireNonNegativeInteger(
    configuration?.authoredAmbientLightCount,
    'configuration.authoredAmbientLightCount',
    fail,
  );
  requireNonNegativeInteger(
    configuration?.authoredDirectionalLightCount,
    'configuration.authoredDirectionalLightCount',
    fail,
  );
  requireNonNegativeInteger(
    configuration?.authoredTotalLightCount,
    'configuration.authoredTotalLightCount',
    fail,
  );
  if (Number.isInteger(configuration?.authoredAmbientLightCount)
    && Number.isInteger(configuration?.authoredDirectionalLightCount)
    && Number.isInteger(configuration?.authoredLocalLightCount)
    && Number.isInteger(configuration?.authoredTotalLightCount)
    && configuration.authoredAmbientLightCount
      + configuration.authoredDirectionalLightCount
      + configuration.authoredLocalLightCount
      !== configuration.authoredTotalLightCount) {
    fail(
      'configuration authored ambient + directional + local lights '
      + 'must equal authoredTotalLightCount',
    );
  }
  requirePositiveInteger(
    configuration?.viewCount,
    'configuration.viewCount',
    fail,
  );
  const workload = requireRecord(result.workload, 'workload', fail);
  requirePositiveInteger(
    workload?.sourceSceneEntityCount,
    'workload.sourceSceneEntityCount',
    fail,
  );
  requirePositiveInteger(
    workload?.runtimeWorldEntityCount,
    'workload.runtimeWorldEntityCount',
    fail,
  );
  requirePositiveInteger(
    workload?.sceneHttpRequestCount,
    'workload.sceneHttpRequestCount',
    fail,
  );
  if (workload?.sceneHttpRequestCount !== 1) {
    fail('workload.sceneHttpRequestCount must equal 1');
  }
  requireNonNegativeInteger(
    workload?.authoredLocalLightCount,
    'workload.authoredLocalLightCount',
    fail,
  );
  requirePositiveInteger(workload?.viewCount, 'workload.viewCount', fail);
  if (Number.isInteger(workload?.runtimeWorldEntityCount)
    && Number.isInteger(workload?.sourceSceneEntityCount)
    && workload.runtimeWorldEntityCount < workload.sourceSceneEntityCount) {
    fail('workload.runtimeWorldEntityCount cannot be below sourceSceneEntityCount');
  }
  if (Number.isInteger(configuration?.authoredLocalLightCount)
    && workload?.authoredLocalLightCount
      !== configuration.authoredLocalLightCount) {
    fail(
      'workload.authoredLocalLightCount must match '
      + 'configuration.authoredLocalLightCount',
    );
  }
  if (Number.isInteger(configuration?.viewCount)
    && workload?.viewCount !== configuration.viewCount) {
    fail('workload.viewCount must match configuration.viewCount');
  }

  const metrics = requireRecord(result.metrics, 'metrics', fail);
  const timing = requireRecord(metrics?.timing, 'metrics.timing', fail);
  const evidence = requireRecord(metrics?.evidence, 'metrics.evidence', fail);

  validateMetricGroup(
    timing,
    'metrics.timing',
    fail,
    validateTimingStatistics,
  );
  validateMetricGroup(evidence, 'metrics.evidence', fail);
  for (const metricName of LIGHTING_SCALING_TIMING_METRICS) {
    const path = `metrics.timing.${metricName}`;
    if (!hasOwn(timing, metricName)) {
      fail(`${path} is required`);
    }
  }
  for (const metricName of LIGHTING_SCALING_EVIDENCE_METRICS) {
    const path = `metrics.evidence.${metricName}`;
    if (!hasOwn(evidence, metricName)) fail(`${path} is required`);
  }

  validateLightOverflow(
    evidence?.lightOverflow,
    configuration,
    lightingStrategy,
    fail,
  );
  validatePerViewIsolation(
    evidence?.perViewIsolation,
    configuration,
    fail,
  );
  validateClusteredTileDistribution(
    evidence?.clusteredTileDistribution,
    lightingStrategy,
    fail,
  );
  validateGpuResidentAllocation(
    evidence?.gpuResidentAllocation,
    fail,
  );
  validateSceneProvenance(evidence?.sceneProvenance, workload, fail);

  return errors;
}

export function assertLightingScalingResult(result) {
  const errors = validateLightingScalingResult(result);
  if (errors.length === 0) return result;
  throw new TypeError(
    `Invalid ${LIGHTING_SCALING_RESULT_FORMAT}:\n`
    + errors.map(error => `- ${error}`).join('\n'),
  );
}

function validateMetricGroup(group, path, fail, validateAvailableValue = null) {
  if (!group) return;
  for (const [metricName, metric] of Object.entries(group)) {
    const metricPath = `${path}.${metricName}`;
    validateMetricEnvelope(metric, metricPath, fail);
    if (metric?.status === 'available' && validateAvailableValue) {
      validateAvailableValue(metric.value, `${metricPath}.value`, fail);
    }
  }
}

function validateMetricEnvelope(metric, path, fail) {
  if (!isRecord(metric)) {
    fail(
      `${path} must be { status: 'available', value } or `
      + `{ status: 'unavailable', reason }`,
    );
    return;
  }
  if (metric.status === 'available') {
    if (!hasOwn(metric, 'value')) fail(`${path}.value is required when available`);
    if (hasOwn(metric, 'reason')) {
      fail(`${path}.reason is not allowed when available`);
    }
    return;
  }
  if (metric.status === 'unavailable') {
    requireNonEmptyString(metric.reason, `${path}.reason`, fail);
    if (hasOwn(metric, 'value')) {
      fail(`${path}.value is not allowed when unavailable`);
    }
    return;
  }
  fail(`${path}.status must be available or unavailable`);
}

function validateTimingStatistics(statistics, path, fail) {
  if (!isRecord(statistics)) {
    fail(`${path} must be timing statistics`);
    return;
  }
  if (statistics.unit !== 'ms') fail(`${path}.unit must be ms`);
  for (const field of ['p50', 'p95', 'p99', 'min', 'max', 'mean']) {
    requireNonNegativeFinite(statistics[field], `${path}.${field}`, fail);
  }
  requirePositiveInteger(statistics.sampleCount, `${path}.sampleCount`, fail);
  if (hasOwn(statistics, 'samples')
    && statistics.samples !== statistics.sampleCount) {
    fail(`${path}.samples must equal sampleCount when present`);
  }
  if (Array.isArray(statistics.rawSamples)) {
    if (statistics.rawSamples.length !== statistics.sampleCount) {
      fail(`${path}.rawSamples length must equal sampleCount`);
    }
    statistics.rawSamples.forEach((sample, index) => {
      requireNonNegativeFinite(
        sample,
        `${path}.rawSamples[${index}]`,
        fail,
      );
    });
  }

  if (isFiniteNumber(statistics.min)
    && isFiniteNumber(statistics.p50)
    && statistics.p50 < statistics.min) {
    fail(`${path}.p50 must be greater than or equal to min`);
  }
  if (isFiniteNumber(statistics.p50)
    && isFiniteNumber(statistics.p95)
    && statistics.p95 < statistics.p50) {
    fail(`${path}.p95 must be greater than or equal to p50`);
  }
  if (isFiniteNumber(statistics.p95)
    && isFiniteNumber(statistics.p99)
    && statistics.p99 < statistics.p95) {
    fail(`${path}.p99 must be greater than or equal to p95`);
  }
  if (isFiniteNumber(statistics.p99)
    && isFiniteNumber(statistics.max)
    && statistics.max < statistics.p99) {
    fail(`${path}.max must be greater than or equal to p99`);
  }
  if (isFiniteNumber(statistics.min)
    && isFiniteNumber(statistics.mean)
    && statistics.mean < statistics.min) {
    fail(`${path}.mean must be greater than or equal to min`);
  }
  if (isFiniteNumber(statistics.max)
    && isFiniteNumber(statistics.mean)
    && statistics.mean > statistics.max) {
    fail(`${path}.mean must be less than or equal to max`);
  }

  if (statistics.p99 === 0) {
    if (statistics.onePercentLowFps !== null) {
      fail(`${path}.onePercentLowFps must be null when p99 is zero`);
    }
  } else if (isFiniteNumber(statistics.p99) && statistics.p99 > 0) {
    requireNonNegativeFinite(
      statistics.onePercentLowFps,
      `${path}.onePercentLowFps`,
      fail,
    );
    if (isFiniteNumber(statistics.onePercentLowFps)) {
      const expected = 1_000 / statistics.p99;
      const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-9);
      if (Math.abs(statistics.onePercentLowFps - expected) > tolerance) {
        fail(`${path}.onePercentLowFps must equal 1000 / p99`);
      }
    }
  }
}

function validateLightOverflow(metric, configuration, lightingStrategy, fail) {
  const path = 'metrics.evidence.lightOverflow';
  if (metric?.status !== 'available') {
    fail(`${path} must be available to account for renderer capability`);
    return;
  }
  const value = requireRecord(metric.value, `${path}.value`, fail);
  if (!value) return;
  for (const field of [
    'authoredAmbientLightCount',
    'authoredDirectionalLightCount',
    'authoredLocalLightCount',
    'authoredTotalLightCount',
    'submittedAmbientLightCount',
    'submittedDirectionalLightCount',
    'submittedLocalLightCount',
    'submittedTotalLightCount',
    'overflowLocalLightCount',
    'overflowTotalLightCount',
    'rendererTotalLightCapacity',
    'rendererLocalLightCapacity',
  ]) {
    requireNonNegativeInteger(value[field], `${path}.value.${field}`, fail);
  }
  if (typeof value.renderingComplete !== 'boolean') {
    fail(`${path}.value.renderingComplete must be boolean`);
  }
  requireNonEmptyString(value.capability, `${path}.value.capability`, fail);

  const authoredAmbient = value.authoredAmbientLightCount;
  const authoredDirectional = value.authoredDirectionalLightCount;
  const authored = value.authoredLocalLightCount;
  const authoredTotal = value.authoredTotalLightCount;
  const submittedAmbient = value.submittedAmbientLightCount;
  const submittedDirectional = value.submittedDirectionalLightCount;
  const submitted = value.submittedLocalLightCount;
  const submittedTotal = value.submittedTotalLightCount;
  const overflow = value.overflowLocalLightCount;
  const overflowTotal = value.overflowTotalLightCount;
  const totalCapacity = value.rendererTotalLightCapacity;
  const localCapacity = value.rendererLocalLightCapacity;
  for (const [field, configurationField] of [
    ['authoredAmbientLightCount', 'authoredAmbientLightCount'],
    ['authoredDirectionalLightCount', 'authoredDirectionalLightCount'],
    ['authoredLocalLightCount', 'authoredLocalLightCount'],
    ['authoredTotalLightCount', 'authoredTotalLightCount'],
  ]) {
    if (Number.isInteger(configuration?.[configurationField])
      && value[field] !== configuration[configurationField]) {
      fail(
        `${path}.value.${field} must match `
        + `configuration.${configurationField}`,
      );
    }
  }
  if ([
    authoredAmbient,
    authoredDirectional,
    authored,
    authoredTotal,
  ].every(Number.isInteger)
    && authoredAmbient + authoredDirectional + authored !== authoredTotal) {
    fail(
      `${path}.value authored ambient + directional + local lights `
      + 'must equal authoredTotalLightCount',
    );
  }
  if ([
    submittedAmbient,
    submittedDirectional,
    submitted,
    submittedTotal,
  ].every(Number.isInteger)
    && submittedAmbient + submittedDirectional + submitted !== submittedTotal) {
    fail(
      `${path}.value submitted ambient + directional + local lights `
      + 'must equal submittedTotalLightCount',
    );
  }
  if (Number.isInteger(authored)
    && Number.isInteger(submitted)
    && Number.isInteger(overflow)
    && submitted + overflow !== authored) {
    fail(`${path}.value submitted + overflow lights must equal authored lights`);
  }
  for (const [submittedCount, authoredCount, label] of [
    [submittedAmbient, authoredAmbient, 'ambient'],
    [submittedDirectional, authoredDirectional, 'directional'],
    [submitted, authored, 'local'],
  ]) {
    if (Number.isInteger(submittedCount)
      && Number.isInteger(authoredCount)
      && submittedCount > authoredCount) {
      fail(`${path}.value submitted ${label} lights exceed authored lights`);
    }
  }
  if (Number.isInteger(submitted)
    && Number.isInteger(localCapacity)
    && submitted > localCapacity) {
    fail(`${path}.value.submittedLocalLightCount exceeds renderer local capacity`);
  }
  if (Number.isInteger(submittedTotal)
    && Number.isInteger(totalCapacity)
    && submittedTotal > totalCapacity) {
    fail(`${path}.value.submittedTotalLightCount exceeds renderer total capacity`);
  }
  if (Number.isInteger(authoredTotal)
    && Number.isInteger(submittedTotal)
    && Number.isInteger(overflowTotal)
    && submittedTotal + overflowTotal !== authoredTotal) {
    fail(
      `${path}.value submitted total + overflow total lights `
      + 'must equal authored total lights',
    );
  }
  if ([
    authoredAmbient,
    authoredDirectional,
    submittedAmbient,
    submittedDirectional,
    overflow,
    overflowTotal,
  ].every(Number.isInteger)
    && overflowTotal !== overflow
      + authoredAmbient - submittedAmbient
      + authoredDirectional - submittedDirectional) {
    fail(
      `${path}.value.overflowTotalLightCount must include local, ambient, `
      + 'and directional overflow',
    );
  }
  if ([
    totalCapacity,
    localCapacity,
    authoredAmbient,
    authoredDirectional,
  ].every(Number.isInteger)) {
    const expectedLocalCapacity = Math.max(
      0,
      totalCapacity - authoredAmbient - authoredDirectional,
    );
    if (localCapacity !== expectedLocalCapacity) {
      fail(
        `${path}.value.rendererLocalLightCapacity must reserve authored `
        + 'ambient and directional lights from rendererTotalLightCapacity',
      );
    }
  }
  if (overflowTotal === 0 && value.renderingComplete !== true) {
    fail(`${path}.value.renderingComplete must be true when no lights overflow`);
  }
  if (overflowTotal === 0
    && value.capability !== 'complete'
    && value.capability !== 'complete-for-selected-input') {
    fail(`${path}.value.capability must report complete when no lights overflow`);
  }
  if (overflowTotal > 0 && value.renderingComplete !== false) {
    fail(`${path}.value.renderingComplete must be false when lights overflow`);
  }

  if (lightingStrategy === 'forward'
    && Number.isInteger(authoredTotal)
    && Number.isInteger(totalCapacity)
    && authoredTotal > totalCapacity) {
    if (overflowTotal <= 0) {
      fail(
        `${path} must report overflow when authored Forward lights exceed `
        + 'renderer total capacity',
      );
    }
    if (value.renderingComplete !== false) {
      fail(
        `${path} cannot report complete Forward rendering above renderer capacity`,
      );
    }
    if (value.capability !== 'known-forward-light-cap') {
      fail(
        `${path}.value.capability must be known-forward-light-cap`,
      );
    }
  }
  if (lightingStrategy === 'forward'
    && Number.isInteger(authoredTotal)
    && Number.isInteger(totalCapacity)
    && authoredTotal <= totalCapacity
    && overflowTotal !== 0) {
    fail(
      `${path} cannot report Forward overflow when authored total lights fit `
      + 'renderer total capacity',
    );
  }
}

function validatePerViewIsolation(metric, configuration, fail) {
  if (metric?.status !== 'available') return;
  const path = 'metrics.evidence.perViewIsolation.value';
  const value = requireRecord(metric.value, path, fail);
  if (!value) return;
  requirePositiveInteger(value.viewCount, `${path}.viewCount`, fail);
  if (typeof value.isolated !== 'boolean') {
    fail(`${path}.isolated must be boolean`);
  }
  requireNonNegativeInteger(value.violationCount, `${path}.violationCount`, fail);
  if (Number.isInteger(configuration?.viewCount)
    && value.viewCount !== configuration.viewCount) {
    fail(`${path}.viewCount must match configuration.viewCount`);
  }
  if (value.isolated === true && value.violationCount !== 0) {
    fail(`${path}.violationCount must be zero when isolated is true`);
  }
}

function validateClusteredTileDistribution(metric, lightingStrategy, fail) {
  const path = 'metrics.evidence.clusteredTileDistribution';
  if (lightingStrategy === 'forward') {
    if (metric?.status !== 'unavailable') {
      fail(`${path} must be unavailable for the Forward renderer`);
    }
    return;
  }
  if ((lightingStrategy === 'clustered' || lightingStrategy === 'tiled')
    && metric?.status !== 'available') {
    fail(`${path} must be available for ${lightingStrategy} lighting`);
    return;
  }
  if (metric?.status !== 'available') return;

  const value = requireRecord(metric.value, `${path}.value`, fail);
  if (!value) return;
  if (value.strategy !== lightingStrategy) {
    fail(`${path}.value.strategy must match renderer.lightingStrategy`);
  }
  for (const field of [
    'bucketCount',
    'nonEmptyBucketCount',
    'maxLightsPerBucket',
    'overflowBucketCount',
  ]) {
    requireNonNegativeInteger(value[field], `${path}.value.${field}`, fail);
  }
  requireNonNegativeFinite(
    value.meanLightsPerBucket,
    `${path}.value.meanLightsPerBucket`,
    fail,
  );
  if (Number.isInteger(value.nonEmptyBucketCount)
    && Number.isInteger(value.bucketCount)
    && value.nonEmptyBucketCount > value.bucketCount) {
    fail(`${path}.value.nonEmptyBucketCount exceeds bucketCount`);
  }
}

function validateGpuResidentAllocation(metric, fail) {
  if (metric?.status !== 'available') return;
  const path = 'metrics.evidence.gpuResidentAllocation.value';
  const value = requireRecord(metric.value, path, fail);
  if (!value) return;
  for (const field of [
    'residentBytes',
    'allocatedBytes',
    'allocationCount',
    'resourceCount',
  ]) {
    requireNonNegativeInteger(value[field], `${path}.${field}`, fail);
  }
  if (Number.isInteger(value.residentBytes)
    && Number.isInteger(value.allocatedBytes)
    && value.residentBytes > value.allocatedBytes) {
    fail(`${path}.residentBytes cannot exceed allocatedBytes`);
  }
}

function validateSceneProvenance(metric, workload, fail) {
  if (metric?.status !== 'available') return;
  const path = 'metrics.evidence.sceneProvenance.value';
  const value = requireRecord(metric.value, path, fail);
  if (!value) return;
  for (const field of [
    'sourceGame',
    'sceneRevision',
    'fixtureId',
    'cameraReplayId',
    'sourceFingerprint',
  ]) {
    requireNonEmptyString(value[field], `${path}.${field}`, fail);
  }
  requirePositiveInteger(
    value.sourceSceneEntityCount,
    `${path}.sourceSceneEntityCount`,
    fail,
  );
  requirePositiveInteger(
    value.runtimeWorldEntityCount,
    `${path}.runtimeWorldEntityCount`,
    fail,
  );
  for (const field of [
    'skippedComponentCount',
    'intentionallySkippedComponentCount',
    'unsupportedMaterialMeshCount',
    'unsupportedMaterialAffectedEntityCount',
  ]) {
    requireNonNegativeInteger(value[field], `${path}.${field}`, fail);
  }
  if (Number.isInteger(value.skippedComponentCount)
    && Number.isInteger(value.intentionallySkippedComponentCount)
    && Number.isInteger(value.unsupportedMaterialMeshCount)
    && value.skippedComponentCount
      !== value.intentionallySkippedComponentCount
        + value.unsupportedMaterialMeshCount) {
    fail(
      `${path}.skippedComponentCount must be fully attributed to intentional `
      + 'skips and unsupported-material Mesh3D components',
    );
  }
  if (!Array.isArray(value.intentionallySkippedComponentTypes)) {
    fail(`${path}.intentionallySkippedComponentTypes must be an array`);
  } else {
    value.intentionallySkippedComponentTypes.forEach((type, index) => {
      requireNonEmptyString(
        type,
        `${path}.intentionallySkippedComponentTypes[${index}]`,
        fail,
      );
    });
  }
  if (!Array.isArray(value.unsupportedMaterialDiagnostics)) {
    fail(`${path}.unsupportedMaterialDiagnostics must be an array`);
  } else {
    value.unsupportedMaterialDiagnostics.forEach((diagnostic, index) => {
      const diagnosticPath = `${path}.unsupportedMaterialDiagnostics[${index}]`;
      const record = requireRecord(diagnostic, diagnosticPath, fail);
      if (!record) return;
      requireNonEmptyString(record.code, `${diagnosticPath}.code`, fail);
      requireNonNegativeInteger(
        record.skippedMeshComponentCount,
        `${diagnosticPath}.skippedMeshComponentCount`,
        fail,
      );
      requireNonNegativeInteger(
        record.affectedEntityCount,
        `${diagnosticPath}.affectedEntityCount`,
        fail,
      );
    });
  }
  if (Number.isInteger(workload?.sourceSceneEntityCount)
    && value.sourceSceneEntityCount !== workload.sourceSceneEntityCount) {
    fail(`${path}.sourceSceneEntityCount must match workload`);
  }
  if (Number.isInteger(workload?.runtimeWorldEntityCount)
    && value.runtimeWorldEntityCount !== workload.runtimeWorldEntityCount) {
    fail(`${path}.runtimeWorldEntityCount must match workload`);
  }
}

function requireRecord(value, path, fail) {
  if (!isRecord(value)) {
    fail(`${path} must be an object`);
    return null;
  }
  return value;
}

function requireNonEmptyString(value, path, fail) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${path} must be a non-empty string`);
  }
}

function requireNonNegativeFinite(value, path, fail) {
  if (!isFiniteNumber(value) || value < 0) {
    fail(`${path} must be finite and non-negative`);
  }
}

function requireNonNegativeInteger(value, path, fail) {
  if (!Number.isInteger(value) || value < 0) {
    fail(`${path} must be a non-negative integer`);
  }
}

function requirePositiveInteger(value, path, fail) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${path} must be a positive integer`);
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return value !== null
    && value !== undefined
    && Object.prototype.hasOwnProperty.call(value, key);
}
