export const RIVE_ORACLE_TRACE_KIND = 'haiyue-rive-oracle-differential-trace';
export const RIVE_ORACLE_TRACE_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/u;
const REQUIRED_CHANNELS = Object.freeze([
  'pixels',
  'geometryAndDrawOrder',
  'stateMachineState',
  'dataValues',
  'events',
  'pointerKeyboardGamepadFocus',
  'resizeAndDpr',
  'audioSchedule',
  'semanticTreeAndActions',
  'resourceReplacement',
  'errorsAndOwners',
]);

export const RIVE_ORACLE_PIXEL_THRESHOLDS = Object.freeze({
  maxChannelDelta: 2 / 255,
  changedPixelRatio: 0.001,
  minimumSsim: 0.9995,
});

export function validateRiveOracleTrace(trace, {
  formal = false,
  expectedRevision = null,
  expectedManifestSha256 = null,
} = {}) {
  const violations = [];
  equal(trace?.schemaVersion, RIVE_ORACLE_TRACE_VERSION, 'schemaVersion');
  equal(trace?.kind, RIVE_ORACLE_TRACE_KIND, 'kind');
  equal(trace?.tuple?.id, 'rive-7.3-webgl2-2.40.0', 'tuple id');
  equal(trace?.tuple?.oraclePackage, '@rive-app/webgl2@2.40.0', 'oracle package');
  match(trace?.tuple?.riveJsSha256, SHA256, 'oracle JS hash');
  match(trace?.tuple?.riveWasmSha256, SHA256, 'oracle WASM hash');
  match(trace?.corpusManifestSha256, SHA256, 'corpus manifest hash');
  if (expectedManifestSha256) equal(trace?.corpusManifestSha256, expectedManifestSha256, 'expected corpus manifest hash');
  requiredString(trace?.assetId, 'asset id');
  match(trace?.rivSha256, SHA256, 'RIV hash');
  match(trace?.engineRevision, /^[a-f0-9]{40}$/u, 'Engine revision');
  if (expectedRevision) equal(trace?.engineRevision, expectedRevision, 'expected Engine revision');
  if (typeof trace?.engineDirty !== 'boolean') violations.push('Engine dirty identity is missing');
  if (!Number.isFinite(Date.parse(trace?.generatedAt ?? ''))) violations.push('generatedAt is invalid');

  const environment = trace?.environment;
  for (const key of ['deviceClass', 'browser', 'browserVersion', 'os', 'gpu']) {
    requiredString(environment?.[key], `environment ${key}`);
  }
  if (!['chrome', 'edge'].includes(environment?.browser)) violations.push('browser must be chrome or edge');
  if (!Number.isFinite(environment?.dpr) || environment.dpr <= 0) violations.push('DPR must be positive');
  if (!Array.isArray(environment?.viewport) || environment.viewport.length !== 2
    || environment.viewport.some(value => !Number.isSafeInteger(value) || value < 1)) {
    violations.push('viewport must contain two positive safe integers');
  }
  positiveInteger(environment?.audioSampleRate, 'audio sample rate');
  if (!Array.isArray(environment?.fonts) || environment.fonts.some(font => !SHA256.test(font?.sha256 ?? ''))) {
    violations.push('font inventory is invalid');
  }
  if (!Array.isArray(environment?.externalAssets) || environment.externalAssets.some(asset => !SHA256.test(asset?.sha256 ?? ''))) {
    violations.push('external asset inventory is invalid');
  }

  const scenario = trace?.scenario;
  for (const key of ['artboard', 'animation', 'stateMachine']) requiredString(scenario?.selection?.[key], `scenario ${key}`);
  const steps = Array.isArray(scenario?.clockStepsMicros) ? scenario.clockStepsMicros : [];
  if (steps.length < 2 || steps.some(value => !Number.isSafeInteger(value) || value < 0)
    || steps.some((value, index) => index > 0 && value <= steps[index - 1])) {
    violations.push('clock steps must be strictly increasing non-negative integer microseconds');
  }
  const actions = Array.isArray(scenario?.actions) ? scenario.actions : [];
  if (actions.length < 1) violations.push('scenario action stream is empty');
  for (const [index, action] of actions.entries()) {
    if (!Number.isSafeInteger(action?.atMicros) || !steps.includes(action.atMicros)) {
      violations.push(`action ${index} is not bound to a declared clock step`);
    }
    requiredString(action?.kind, `action ${index} kind`);
    if (index > 0 && action.atMicros < actions[index - 1].atMicros) violations.push('scenario actions are not ordered');
  }
  if (!scenario?.initialData || typeof scenario.initialData !== 'object' || Array.isArray(scenario.initialData)) {
    violations.push('initial data snapshot is missing');
  }

  validateCapture('official', trace?.official);
  validateCapture('hya', trace?.hya);
  const comparisons = trace?.comparison?.channels;
  for (const channel of REQUIRED_CHANNELS) {
    const result = comparisons?.[channel];
    equal(result?.status, 'passed', `${channel} comparison status`);
    if (!Number.isInteger(result?.differenceCount) || result.differenceCount < 0) {
      violations.push(`${channel} differenceCount is invalid`);
    }
    if (channel !== 'pixels') equal(result?.differenceCount, 0, `${channel} difference count`);
  }
  const pixels = comparisons?.pixels;
  if (!Number.isFinite(pixels?.maxChannelDelta) || pixels.maxChannelDelta > RIVE_ORACLE_PIXEL_THRESHOLDS.maxChannelDelta) {
    violations.push('pixel max channel delta exceeds threshold');
  }
  if (!Number.isFinite(pixels?.changedPixelRatio) || pixels.changedPixelRatio > RIVE_ORACLE_PIXEL_THRESHOLDS.changedPixelRatio) {
    violations.push('pixel changed ratio exceeds threshold');
  }
  if (!Number.isFinite(pixels?.ssim) || pixels.ssim < RIVE_ORACLE_PIXEL_THRESHOLDS.minimumSsim) {
    violations.push('pixel SSIM is below threshold');
  }
  equal(trace?.comparison?.structuralDifferenceCount, 0, 'structural difference count');
  equal(trace?.comparison?.unclassifiedFailureCount, 0, 'unclassified failure count');
  equal(trace?.comparison?.deterministicReplay, true, 'deterministic replay');
  equal(trace?.official?.ownerResidual, 0, 'official owner residual');
  equal(trace?.hya?.ownerResidual, 0, 'HYA owner residual');

  if (formal) {
    equal(trace?.evidenceClass, 'clean-device-candidate', 'formal evidence class');
    equal(trace?.engineDirty, false, 'formal Engine dirty state');
    equal(trace?.status, 'passed', 'formal trace status');
  }

  return Object.freeze({
    schemaVersion: 1,
    contract: 'haiyue-rive-oracle-differential-trace@1',
    mode: formal ? 'formal' : 'diagnostic',
    status: violations.length === 0 ? 'passed' : 'failed',
    violations: Object.freeze(violations),
  });

  function validateCapture(label, capture) {
    equal(capture?.runtime, label === 'official' ? '@rive-app/webgl2@2.40.0' : 'haiyue-exact-hya', `${label} runtime`);
    const channels = capture?.channels;
    for (const channel of REQUIRED_CHANNELS) {
      const item = channels?.[channel];
      match(item?.sha256, SHA256, `${label} ${channel} hash`);
      positiveInteger(item?.byteLength, `${label} ${channel} bytes`);
      positiveInteger(item?.sampleCount, `${label} ${channel} sample count`);
    }
    if (!Array.isArray(capture?.diagnostics)) violations.push(`${label} diagnostics must be an array`);
    if ((capture?.diagnostics ?? []).some(value => value?.classification === 'unclassified')) {
      violations.push(`${label} contains an unclassified diagnostic`);
    }
  }

  function equal(actual, expected, label) {
    if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
  function match(actual, expression, label) {
    if (typeof actual !== 'string' || !expression.test(actual)) violations.push(`${label} is invalid`);
  }
  function requiredString(actual, label) {
    if (typeof actual !== 'string' || actual.trim().length === 0) violations.push(`${label} is missing`);
  }
  function positiveInteger(actual, label) {
    if (!Number.isInteger(actual) || actual < 1) violations.push(`${label} must be a positive integer`);
  }
}

export function requiredRiveOracleTraceChannels() {
  return REQUIRED_CHANNELS;
}
