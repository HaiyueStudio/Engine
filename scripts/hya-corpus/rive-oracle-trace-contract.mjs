import { createHash } from 'node:crypto';
import {
  riveWorkloadMetricNames,
  riveWorkloadTraceChannels,
  validateRiveWorkloadPlan,
  validateRiveWorkloadScenario,
} from './rive-workload-contract.mjs';
import { validateRiveOracleChannelEvidence } from './rive-oracle-channel-contract.mjs';

export const RIVE_ORACLE_TRACE_KIND = 'haiyue-rive-oracle-differential-trace';
export const RIVE_ORACLE_TRACE_VERSION = 2;

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const REQUIRED_CHANNELS = riveWorkloadTraceChannels();
const METRICS = riveWorkloadMetricNames();
const DEVICE_CLASSES = Object.freeze(['windows-10-plus-device-a', 'windows-10-plus-device-b']);

export const RIVE_ORACLE_PIXEL_THRESHOLDS = Object.freeze({
  maxChannelDelta: 2 / 255,
  changedPixelRatio: 0.001,
  minimumSsim: 0.9995,
});

export function validateRiveOracleTrace(trace, {
  formal = false,
  expectedRevision = null,
  expectedManifestSha256 = null,
  workloadPlan = null,
  artifactBytesByPath = null,
} = {}) {
  const violations = [];
  equal(trace?.schemaVersion, RIVE_ORACLE_TRACE_VERSION, 'schemaVersion');
  equal(trace?.kind, RIVE_ORACLE_TRACE_KIND, 'kind');
  equal(trace?.tuple?.id, 'rive-7.3-webgl2-2.40.0', 'tuple id');
  equal(trace?.tuple?.oraclePackage, '@rive-app/webgl2@2.40.0', 'oracle package');
  match(trace?.tuple?.riveJsSha256, SHA256, 'oracle JS hash');
  match(trace?.tuple?.riveWasmSha256, SHA256, 'oracle WASM hash');
  validateCapabilityDescriptor(trace?.adapters?.capabilityEvaluator, 'capability evaluator descriptor');
  validateCaptureDescriptor(trace?.adapters?.officialCapture, {
    label: 'official capture descriptor', runtime: '@rive-app/webgl2@2.40.0', backend: 'webgl2',
  });
  validateCaptureDescriptor(trace?.adapters?.hyaCapture, {
    label: 'HYA capture descriptor', runtime: 'haiyue-exact-hya', backend: 'webgpu',
  });
  match(trace?.corpusManifestSha256, SHA256, 'corpus manifest hash');
  if (expectedManifestSha256) equal(trace?.corpusManifestSha256, expectedManifestSha256, 'expected corpus manifest hash');
  match(trace?.workloadPlanSha256, SHA256, 'workload plan hash');
  requiredString(trace?.workloadPlanId, 'workload plan id');
  requiredString(trace?.assetId, 'asset id');
  match(trace?.rivSha256, SHA256, 'RIV hash');
  match(trace?.engineRevision, REVISION, 'Engine revision');
  if (expectedRevision) equal(trace?.engineRevision, expectedRevision, 'expected Engine revision');
  if (typeof trace?.engineDirty !== 'boolean') violations.push('Engine dirty identity is missing');
  if (!Number.isFinite(Date.parse(trace?.generatedAt ?? ''))) violations.push('generatedAt is invalid');

  if (workloadPlan) {
    const planResult = validateRiveWorkloadPlan(workloadPlan);
    if (planResult.status !== 'passed') violations.push(...planResult.violations.map(value => `workload plan: ${value}`));
    equal(trace?.workloadPlanId, workloadPlan.id, 'expected workload plan id');
    equal(trace?.tuple?.id, workloadPlan.compatibilityTupleId, 'workload tuple id');
  } else if (formal) {
    violations.push('formal trace workload plan is unavailable');
  }

  const environment = trace?.environment;
  for (const key of ['deviceClass', 'browser', 'browserVersion', 'os', 'osBuild', 'gpu', 'machineIdSha256']) requiredString(environment?.[key], `environment ${key}`);
  if (!DEVICE_CLASSES.includes(environment?.deviceClass)) violations.push('device class is outside the formal matrix');
  if (!isWindows10Plus(environment?.os)) violations.push('physical device OS must be Windows 10 or later');
  equal(environment?.physicalDevice, true, 'physical device identity');
  if (!['chrome', 'edge'].includes(environment?.browser)) violations.push('browser must be chrome or edge');
  match(environment?.machineIdSha256, SHA256, 'machine identity');
  equal(environment?.officialBackend, 'webgl2', 'official backend');
  equal(environment?.hyaBackend, 'webgpu', 'HYA backend');
  equal(environment?.nativeBackend, true, 'native backend');
  if (typeof environment?.browserLogCaptured !== 'boolean') violations.push('browser log capture identity is missing');
  nonnegativeInteger(environment?.consoleErrorCount, 'console error count');
  nonnegativeInteger(environment?.exceptionCount, 'exception count');
  for (const key of ['vendor', 'architecture', 'device', 'description']) requiredString(environment?.adapter?.[key], `adapter ${key}`);
  if (!Number.isFinite(environment?.dpr) || environment.dpr <= 0) violations.push('DPR must be positive');
  if (!Array.isArray(environment?.viewport) || environment.viewport.length !== 2 || environment.viewport.some(value => !Number.isSafeInteger(value) || value < 1)) violations.push('viewport must contain two positive safe integers');
  positiveInteger(environment?.audioSampleRate, 'audio sample rate');
  if (!Array.isArray(environment?.fonts) || environment.fonts.some(font => !SHA256.test(font?.sha256 ?? ''))) violations.push('font inventory is invalid');
  if (!Array.isArray(environment?.externalAssets) || environment.externalAssets.some(asset => !SHA256.test(asset?.sha256 ?? ''))) violations.push('external asset inventory is invalid');

  const scenarioArtifact = trace?.scenarioArtifact;
  validateArtifactReference(scenarioArtifact, 'scenario artifact', { formal, artifactBytesByPath, mediaType: 'application/json' });
  const scenario = trace?.scenario;
  if (workloadPlan) {
    const scenarioResult = validateRiveWorkloadScenario(scenario, workloadPlan, { expectedAssetId: trace?.assetId, expectedRivSha256: trace?.rivSha256 });
    if (scenarioResult.status !== 'passed') violations.push(...scenarioResult.violations.map(value => `scenario: ${value}`));
  }
  const scenarioBytes = artifactBytesByPath?.get(scenarioArtifact?.path);
  if (scenarioBytes) {
    try {
      const artifactScenario = JSON.parse(asBytes(scenarioBytes).toString('utf8'));
      if (stableJson(artifactScenario) !== stableJson(scenario)) violations.push('inline scenario differs from its pinned artifact');
    } catch (error) {
      violations.push(`scenario artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  validateCapture('official', trace?.official, scenario, { formal, artifactBytesByPath });
  validateCapture('hya', trace?.hya, scenario, { formal, artifactBytesByPath });
  const comparisons = trace?.comparison?.channels;
  let recomputedStructuralDifferences = 0;
  for (const channel of REQUIRED_CHANNELS) {
    const result = comparisons?.[channel];
    equal(result?.status, 'passed', `${channel} comparison status`);
    if (!Number.isInteger(result?.differenceCount) || result.differenceCount < 0) violations.push(`${channel} differenceCount is invalid`);
    if (channel !== 'pixels') equal(result?.differenceCount, 0, `${channel} difference count`);
    validateArtifactReference(result?.artifact, `${channel} comparison artifact`, { formal, artifactBytesByPath, mediaType: 'application/json' });
    if (formal || artifactBytesByPath) {
      const channelEvidence = validateRiveOracleChannelEvidence({
        channel,
        officialReference: trace?.official?.channels?.[channel],
        hyaReference: trace?.hya?.channels?.[channel],
        comparisonReference: result?.artifact,
        artifactBytesByPath,
        scenario,
        scenarioSha256: scenarioArtifact?.sha256,
        assetId: trace?.assetId,
        rivSha256: trace?.rivSha256,
        formal,
      });
      if (channelEvidence.status !== 'passed') violations.push(...channelEvidence.violations.map(value => `${channel} evidence: ${value}`));
      if (channelEvidence.recomputed) {
        equal(result?.status, channelEvidence.recomputed.status, `${channel} recomputed status`);
        equal(result?.differenceCount, channelEvidence.recomputed.differenceCount, `${channel} recomputed difference count`);
        if (channel === 'pixels') {
          equal(result?.maxChannelDelta, channelEvidence.recomputed.maxChannelDelta, 'pixels recomputed max channel delta');
          equal(result?.changedPixelRatio, channelEvidence.recomputed.changedPixelRatio, 'pixels recomputed changed ratio');
          equal(result?.ssim, channelEvidence.recomputed.ssim, 'pixels recomputed SSIM');
        } else recomputedStructuralDifferences += channelEvidence.recomputed.differenceCount;
      }
    }
  }
  const pixels = comparisons?.pixels;
  if (!Number.isFinite(pixels?.maxChannelDelta) || pixels.maxChannelDelta > RIVE_ORACLE_PIXEL_THRESHOLDS.maxChannelDelta) violations.push('pixel max channel delta exceeds threshold');
  if (!Number.isFinite(pixels?.changedPixelRatio) || pixels.changedPixelRatio > RIVE_ORACLE_PIXEL_THRESHOLDS.changedPixelRatio) violations.push('pixel changed ratio exceeds threshold');
  if (!Number.isFinite(pixels?.ssim) || pixels.ssim < RIVE_ORACLE_PIXEL_THRESHOLDS.minimumSsim) violations.push('pixel SSIM is below threshold');
  equal(trace?.comparison?.structuralDifferenceCount, 0, 'structural difference count');
  if (formal || artifactBytesByPath) equal(trace?.comparison?.structuralDifferenceCount, recomputedStructuralDifferences, 'recomputed structural difference count');
  equal(trace?.comparison?.unclassifiedFailureCount, 0, 'unclassified failure count');
  equal(trace?.comparison?.deterministicReplay, true, 'deterministic replay');
  equal(trace?.comparison?.sameActionStream, true, 'action stream identity');
  equal(trace?.comparison?.sameMachine, true, 'same-machine identity');
  equal(trace?.comparison?.sameRevision, true, 'same-revision identity');
  equal(trace?.official?.ownerResidual, 0, 'official owner residual');
  equal(trace?.hya?.ownerResidual, 0, 'HYA owner residual');

  if (formal) {
    equal(trace?.evidenceClass, 'clean-device-candidate', 'formal evidence class');
    equal(trace?.engineDirty, false, 'formal Engine dirty state');
    equal(trace?.status, 'passed', 'formal trace status');
    equal(environment?.browserLogCaptured, true, 'formal browser log capture');
    equal(environment?.consoleErrorCount, 0, 'formal console error count');
    equal(environment?.exceptionCount, 0, 'formal exception count');
    if (!artifactBytesByPath) violations.push('formal trace artifact bytes were not supplied');
  }

  return Object.freeze({ schemaVersion: 1, contract: 'haiyue-rive-oracle-differential-trace@2', mode: formal ? 'formal' : 'diagnostic', status: violations.length === 0 ? 'passed' : 'failed', violations: Object.freeze(violations) });

  function validateCapture(label, capture, scenarioValue, artifactOptions) {
    equal(capture?.runtime, label === 'official' ? '@rive-app/webgl2@2.40.0' : 'haiyue-exact-hya', `${label} runtime`);
    equal(capture?.freshOwnerPerReplay, true, `${label} fresh owner policy`);
    equal(capture?.replayCount, scenarioValue?.replayCount, `${label} replay count`);
    for (const channel of REQUIRED_CHANNELS) {
      const item = capture?.channels?.[channel];
      validateArtifactReference(item, `${label} ${channel}`, artifactOptions);
      const expectedSamples = Number(scenarioValue?.replayCount ?? 0) * Number(scenarioValue?.clockStepsMicros?.length ?? 0);
      if (!Number.isSafeInteger(item?.sampleCount) || item.sampleCount !== expectedSamples) violations.push(`${label} ${channel} sample population is incomplete`);
      requiredString(item?.normalization, `${label} ${channel} normalization`);
    }
    for (const metric of METRICS) nonnegativeNumber(capture?.metrics?.[metric], `${label} ${metric}`);
    positiveInteger(capture?.measurement?.warmupIterations, `${label} warmup iterations`);
    positiveInteger(capture?.measurement?.measuredIterations, `${label} measured iterations`);
    positiveInteger(capture?.measurement?.frameSampleCount, `${label} frame sample count`);
    equal(capture?.measurement?.queueCompleted, true, `${label} queue completion`);
    requiredString(capture?.measurement?.energySource, `${label} energy source`);
    if (formal && String(capture?.measurement?.energySource ?? '').startsWith('unavailable:')) violations.push(`${label} formal energy source is unavailable`);
    if (!Array.isArray(capture?.diagnostics)) violations.push(`${label} diagnostics must be an array`);
    if ((capture?.diagnostics ?? []).some(value => value?.classification === 'unclassified')) violations.push(`${label} contains an unclassified diagnostic`);
    if (formal && (capture?.diagnostics ?? []).some(value => ['oracle-proxy', 'metric-unavailable'].includes(value?.classification))) violations.push(`${label} contains a formal-admission blocker diagnostic`);
    const lifecycle = Array.isArray(capture?.lifecycle) ? capture.lifecycle : [];
    for (const path of scenarioValue?.lifecyclePaths ?? []) {
      const item = lifecycle.find(value => value?.path === path);
      if (!item) violations.push(`${label} missing lifecycle path ${String(path)}`);
      else {
        equal(item?.status, 'passed', `${label} ${String(path)} lifecycle status`);
        equal(item?.ownerResidual, 0, `${label} ${String(path)} lifecycle owner residual`);
      }
    }
  }
  function validateCapabilityDescriptor(value, label) {
    const keys = ['adapterId', 'adapterRevisionSha256', 'evaluatorId', 'evaluatorRevisionSha256', 'optionsRevision'];
    exactObjectKeys(value, keys, label);
    for (const key of ['adapterId', 'evaluatorId', 'optionsRevision']) requiredString(value?.[key], `${label} ${key}`);
    match(value?.adapterRevisionSha256, SHA256, `${label} adapter revision`);
    match(value?.evaluatorRevisionSha256, SHA256, `${label} evaluator revision`);
  }
  function validateCaptureDescriptor(value, { label, runtime, backend }) {
    const keys = ['id', 'revisionSha256', 'runtime', 'backend', 'nativeBackend'];
    exactObjectKeys(value, keys, label);
    requiredString(value?.id, `${label} id`);
    match(value?.revisionSha256, SHA256, `${label} revision`);
    equal(value?.runtime, runtime, `${label} runtime`);
    equal(value?.backend, backend, `${label} backend`);
    equal(value?.nativeBackend, true, `${label} native backend`);
  }
  function exactObjectKeys(value, expected, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { violations.push(`${label} is missing`); return; }
    const actual = Object.keys(value).sort(); const sortedExpected = [...expected].sort();
    if (stableJson(actual) !== stableJson(sortedExpected)) violations.push(`${label} fields do not match the production protocol`);
  }

  function validateArtifactReference(reference, label, { formal: requireBytes, artifactBytesByPath: bytesByPath, mediaType } = {}) {
    requiredString(reference?.path, `${label} path`);
    match(reference?.sha256, SHA256, `${label} hash`);
    positiveInteger(reference?.byteLength, `${label} bytes`);
    if (mediaType) equal(reference?.mediaType, mediaType, `${label} media type`);
    const supplied = bytesByPath?.get(reference?.path);
    if (!supplied) {
      if (requireBytes) violations.push(`${label} bytes are unavailable`);
      return;
    }
    const bytes = asBytes(supplied);
    equal(bytes.byteLength, reference?.byteLength, `${label} byte length`);
    equal(createHash('sha256').update(bytes).digest('hex'), reference?.sha256, `${label} content hash`);
  }

  function equal(actual, expected, label) { if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`); }
  function match(actual, expression, label) { if (typeof actual !== 'string' || !expression.test(actual)) violations.push(`${label} is invalid`); }
  function requiredString(actual, label) { if (typeof actual !== 'string' || actual.trim().length === 0) violations.push(`${label} is missing`); }
  function positiveInteger(actual, label) { if (!Number.isSafeInteger(actual) || actual < 1) violations.push(`${label} must be a positive safe integer`); }
  function nonnegativeInteger(actual, label) { if (!Number.isSafeInteger(actual) || actual < 0) violations.push(`${label} must be a non-negative safe integer`); }
  function nonnegativeNumber(actual, label) { if (!Number.isFinite(actual) || actual < 0) violations.push(`${label} must be a finite non-negative number`); }
}

export function requiredRiveOracleTraceChannels() { return REQUIRED_CHANNELS; }

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Artifact bytes must be a Buffer or Uint8Array.');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function isWindows10Plus(value) {
  const match = /^Windows\s+(\d+)(?:\D|$)/iu.exec(String(value));
  return match !== null && Number(match[1]) >= 10;
}
