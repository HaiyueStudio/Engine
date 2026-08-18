export const READBACK_CHURN_SCHEMA_VERSION = 1;
export const READBACK_CHURN_SUITE = 'haiyue-real-webgpu-readback-churn';

export function validateReadbackChurnResult(result, options = {}) {
  const errors = [];
  const expectedProfile = options.profile;
  const fail = message => errors.push(message);

  if (!result || typeof result !== 'object') return ['result must be an object'];
  if (result.schemaVersion !== READBACK_CHURN_SCHEMA_VERSION) fail(`schemaVersion must be ${READBACK_CHURN_SCHEMA_VERSION}`);
  if (result.suite !== READBACK_CHURN_SUITE) fail(`suite must be ${READBACK_CHURN_SUITE}`);
  if (expectedProfile && result.profile !== expectedProfile) fail(`profile must be ${expectedProfile}`);
  const adapter = result.environment?.adapter ?? {};
  if (![adapter.vendor, adapter.architecture, adapter.device, adapter.description].some(Boolean)) fail('adapter identity is missing');
  if (!Number.isInteger(result.config?.frames) || result.config.frames < 1) fail('config.frames must be a positive integer');
  if (result.profile === 'long' && result.config?.frames < 1_000) fail('long profile must run at least 1000 frames');

  const readback = result.readback ?? {};
  requirePositive(readback.accepted, 'readback.accepted', fail);
  requirePositive(readback.delivered, 'readback.delivered', fail);
  requirePositive(readback.skipped, 'readback.skipped', fail);
  requireZero(readback.mappingsBeforeSubmit, 'readback.mappingsBeforeSubmit', fail);
  requireZero(readback.resultsBeforeSubmit, 'readback.resultsBeforeSubmit', fail);
  requireZero(readback.duplicateResults, 'readback.duplicateResults', fail);
  requireZero(readback.unknownResults, 'readback.unknownResults', fail);
  requireZero(readback.valueMismatches, 'readback.valueMismatches', fail);
  requireZero(readback.stalePublishedResults, 'readback.stalePublishedResults', fail);
  requireZero(readback.mapFailures, 'readback.mapFailures', fail);
  requireZero(readback.pendingAfterDrain, 'readback.pendingAfterDrain', fail);
  if (readback.mappingStarted !== readback.accepted) fail('every accepted readback must start mapping after submission');
  if (readback.accepted !== readback.delivered + readback.cancelled + readback.mapFailures) {
    fail('accepted readbacks must be fully accounted as delivered, cancelled, or failed');
  }
  if (readback.requests !== readback.accepted + readback.skipped) fail('readback request accounting is inconsistent');
  if (readback.maxRingOccupancy !== 2) fail(`readback.maxRingOccupancy must exercise both ring slots, received ${readback.maxRingOccupancy}`);
  if (readback.pendingDestroyEvents < 1) fail('pending-destroy lifecycle scenario did not run');
  if (readback.cancelled < readback.pendingDestroyEvents) fail('pending-destroy requests were not reported as cancelled');
  if (!Number.isFinite(readback.skipRate) || readback.skipRate < 0 || readback.skipRate > 0.9) fail(`readback.skipRate is outside [0, 0.9]: ${readback.skipRate}`);
  if (!Number.isFinite(readback.latencyFrames?.p95) || readback.latencyFrames.p95 > 10) fail(`readback latency P95 exceeds 10 frames: ${readback.latencyFrames?.p95}`);

  const churn = result.churn ?? {};
  requirePositive(churn.cycles, 'churn.cycles', fail);
  requirePositive(churn.resourcesCreated, 'churn.resourcesCreated', fail);
  requirePositive(churn.cacheHits, 'churn.cacheHits', fail);
  requirePositive(churn.cacheMisses, 'churn.cacheMisses', fail);
  for (const type of ['buffer', 'texture', 'bind-group', 'pipeline-layout', 'compute-pipeline']) {
    requirePositive(churn.resourceTypes?.[type]?.created, `churn.resourceTypes.${type}.created`, fail);
  }
  for (const label of ['renderer-resource', 'renderer-pipeline-layout']) {
    const cache = churn.caches?.find(candidate => candidate.label === label);
    requirePositive(cache?.hits, `churn.caches.${label}.hits`, fail);
    requirePositive(cache?.misses, `churn.caches.${label}.misses`, fail);
  }
  requireZero(churn.liveResourcesAfterDrain, 'churn.liveResourcesAfterDrain', fail);
  requireZero(churn.liveEstimatedBytesAfterDrain, 'churn.liveEstimatedBytesAfterDrain', fail);
  requireZero(churn.cacheEntriesAfterClear, 'churn.cacheEntriesAfterClear', fail);
  requireZero(churn.releasedOwnerResiduals, 'churn.releasedOwnerResiduals', fail);
  if (churn.deviceLost !== false) fail('GPU device was lost during the gate');

  if (!Array.isArray(result.validation?.errors)) fail('validation.errors must be an array');
  else if (result.validation.errors.length > 0) fail(`WebGPU validation errors: ${result.validation.errors.join('; ')}`);
  if (!Array.isArray(result.validation?.uncapturedErrors)) fail('validation.uncapturedErrors must be an array');
  else if (result.validation.uncapturedErrors.length > 0) fail(`uncaptured WebGPU errors: ${result.validation.uncapturedErrors.join('; ')}`);
  return errors;
}

function requireZero(value, label, fail) {
  if (value !== 0) fail(`${label} must be 0, received ${String(value)}`);
}

function requirePositive(value, label, fail) {
  if (!Number.isFinite(value) || value <= 0) fail(`${label} must be greater than 0, received ${String(value)}`);
}
