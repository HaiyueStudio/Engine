import { createHash } from 'node:crypto';
import { createRiveOracleChannelComparison } from './rive-oracle-channel-contract.mjs';
import { requiredRiveOracleTraceChannels, validateRiveOracleTrace } from './rive-oracle-trace-contract.mjs';

const HASH = /^[a-f0-9]{64}$/u;

export async function runRiveDifferentialTrace(options) {
  validateAdapter(options.officialAdapter, '@rive-app/webgl2@2.40.0', 'webgl2', 'officialAdapter');
  validateAdapter(options.hyaAdapter, 'haiyue-exact-hya', 'webgpu', 'hyaAdapter');
  const scenarioBytes = options.scenarioBytes ?? Buffer.from(`${JSON.stringify(options.scenario, null, 2)}\n`);
  const scenarioSha256 = hash(scenarioBytes);
  const artifactBytesByPath = new Map([[options.scenarioPath, Buffer.from(scenarioBytes)]]);
  const conversion = await options.convert(options.rivBytes, options.signal);
  const request = Object.freeze({
    assetId: options.assetId,
    rivSha256: options.rivSha256,
    scenario: options.scenario,
    scenarioSha256,
    artifactPrefix: options.artifactPrefix,
    environment: options.environment,
    signal: options.signal,
  });
  const official = await options.officialAdapter.capture(Object.freeze({ ...request, runtimeInput: Object.freeze({ kind: 'riv', bytes: Uint8Array.from(options.rivBytes) }) }));
  const hya = await options.hyaAdapter.capture(Object.freeze({
    ...request,
    runtimeInput: Object.freeze({
      kind: 'hya-package',
      hyaBytes: Uint8Array.from(conversion.hyaBytes),
      packageBytes: Uint8Array.from(conversion.packageBytes),
      sourceRivBytes: Uint8Array.from(options.rivBytes),
    }),
  }));
  validateCaptureEnvironment(official.environment, options.environment, 'official');
  validateCaptureEnvironment(hya.environment, options.environment, 'HYA');
  if (stableJson(official.environment) !== stableJson(hya.environment)) throw new Error('Official and HYA capture environments differ.');
  mergeArtifacts(artifactBytesByPath, official.artifactBytesByPath, 'official');
  mergeArtifacts(artifactBytesByPath, hya.artifactBytesByPath, 'hya');

  const officialChannels = {}; const hyaChannels = {}; const comparisons = {};
  let structuralDifferenceCount = 0;
  for (const channel of requiredRiveOracleTraceChannels()) {
    const officialCapture = official.channels?.[channel]; const hyaCapture = hya.channels?.[channel];
    if (!officialCapture || !hyaCapture) throw new Error(`Capture adapters did not return channel ${channel}.`);
    const generated = createRiveOracleChannelComparison({
      channel, officialCapture, hyaCapture,
      officialPath: `${options.artifactPrefix}/official-${channel}.json`,
      hyaPath: `${options.artifactPrefix}/hya-${channel}.json`,
      comparisonPath: `${options.artifactPrefix}/comparison-${channel}.json`,
      artifactBytesByPath, scenario: options.scenario, scenarioSha256,
      assetId: options.assetId, rivSha256: options.rivSha256,
    });
    artifactBytesByPath.set(generated.officialReference.path, generated.officialBytes);
    artifactBytesByPath.set(generated.hyaReference.path, generated.hyaBytes);
    artifactBytesByPath.set(generated.comparisonReference.path, generated.comparisonBytes);
    officialChannels[channel] = channelReference(generated.officialReference, officialCapture);
    hyaChannels[channel] = channelReference(generated.hyaReference, hyaCapture);
    comparisons[channel] = {
      status: generated.comparison.status,
      differenceCount: generated.comparison.differenceCount,
      artifact: generated.comparisonReference,
      ...(channel === 'pixels' ? {
        maxChannelDelta: generated.comparison.maxChannelDelta,
        changedPixelRatio: generated.comparison.changedPixelRatio,
        ssim: generated.comparison.ssim,
      } : {}),
    };
    if (channel !== 'pixels') structuralDifferenceCount += generated.comparison.differenceCount;
  }
  const deterministicReplay = captureIsDeterministic(official.channels, options.scenario)
    && captureIsDeterministic(hya.channels, options.scenario);
  const unclassifiedFailureCount = [...(official.diagnostics ?? []), ...(hya.diagnostics ?? [])]
    .filter(value => value?.classification === 'unclassified').length;
  const passed = Object.values(comparisons).every(value => value.status === 'passed')
    && structuralDifferenceCount === 0 && deterministicReplay && unclassifiedFailureCount === 0
    && official.ownerResidual === 0 && hya.ownerResidual === 0;
  const trace = {
    schemaVersion: 2,
    kind: 'haiyue-rive-oracle-differential-trace',
    status: passed ? 'passed' : 'failed',
    evidenceClass: options.evidenceClass,
    generatedAt: options.generatedAt,
    engineRevision: options.engineRevision,
    engineDirty: options.engineDirty,
    corpusManifestSha256: options.corpusManifestSha256,
    workloadPlanId: options.workloadPlan.id,
    workloadPlanSha256: options.workloadPlanSha256,
    tuple: options.tuple,
    adapters: {
      capabilityEvaluator: conversion.report?.tuple,
      officialCapture: options.officialAdapter.descriptor,
      hyaCapture: options.hyaAdapter.descriptor,
    },
    assetId: options.assetId,
    rivSha256: options.rivSha256,
    environment: official.environment,
    scenarioArtifact: reference(options.scenarioPath, scenarioBytes, 'application/json'),
    scenario: options.scenario,
    official: captureSummary('@rive-app/webgl2@2.40.0', official, officialChannels, options.scenario.replayCount),
    hya: captureSummary('haiyue-exact-hya', hya, hyaChannels, options.scenario.replayCount),
    comparison: {
      channels: comparisons,
      structuralDifferenceCount,
      unclassifiedFailureCount,
      deterministicReplay,
      sameActionStream: true,
      sameMachine: true,
      sameRevision: true,
    },
  };
  const validation = validateRiveOracleTrace(trace, {
    formal: options.formal === true,
    expectedRevision: options.engineRevision,
    expectedManifestSha256: options.corpusManifestSha256,
    workloadPlan: options.workloadPlan,
    artifactBytesByPath,
  });
  return Object.freeze({ trace: Object.freeze(trace), validation, artifactBytesByPath, conversion });
}

function validateAdapter(adapter, runtime, backend, label) {
  if (!adapter || typeof adapter.capture !== 'function') throw new TypeError(`${label} must implement capture().`);
  const descriptor = adapter.descriptor;
  if (descriptor?.runtime !== runtime || descriptor?.backend !== backend || descriptor?.nativeBackend !== true
    || typeof descriptor?.id !== 'string' || !HASH.test(descriptor?.revisionSha256 ?? '')) {
    throw new TypeError(`${label} descriptor is not a revision-pinned native ${runtime}/${backend} adapter.`);
  }
}

function validateCaptureEnvironment(actual, expected, label) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) throw new TypeError(`${label} capture environment is missing.`);
  if (stableJson(actual) !== stableJson(expected)) throw new Error(`${label} capture environment differs from the requested physical browser environment.`);
}

function mergeArtifacts(target, source, label) {
  const entries = source instanceof Map ? source.entries() : source ?? [];
  for (const [path, bytes] of entries) {
    if (target.has(path)) throw new Error(`${label} capture returned duplicate artifact path ${path}.`);
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label} artifact ${path} is not bytes.`);
    target.set(path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
}

function channelReference(value, capture) {
  return { ...value, sampleCount: capture.samples.length, normalization: capture.normalization };
}

function captureSummary(runtime, capture, channels, replayCount) {
  return {
    runtime, freshOwnerPerReplay: capture.freshOwnerPerReplay, replayCount, channels,
    metrics: capture.metrics, measurement: capture.measurement,
    diagnostics: capture.diagnostics ?? [], lifecycle: capture.lifecycle ?? [], ownerResidual: capture.ownerResidual,
  };
}

export function captureIsDeterministic(channels, scenario) {
  for (const channel of requiredRiveOracleTraceChannels()) {
    const samples = channels[channel]?.samples ?? [];
    for (let clockIndex = 0; clockIndex < scenario.clockStepsMicros.length; clockIndex++) {
      const baseline = samples[clockIndex];
      for (let replayIndex = 1; replayIndex < scenario.replayCount; replayIndex++) {
        const candidate = samples[replayIndex * scenario.clockStepsMicros.length + clockIndex];
        if (stableJson(deterministicValue(channel, baseline?.value)) !== stableJson(deterministicValue(channel, candidate?.value))
          || stableJson(baseline?.actionIds) !== stableJson(candidate?.actionIds)) return false;
      }
    }
  }
  return true;
}

function deterministicValue(channel, value) {
  if (channel !== 'pixels' || !value?.rgba || typeof value.rgba !== 'object') return value;
  const { path: _replaySpecificPath, ...contentIdentity } = value.rgba;
  return { ...value, rgba: contentIdentity };
}

function reference(path, bytes, mediaType) {
  return { path, sha256: hash(bytes), byteLength: bytes.byteLength, mediaType };
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
