export const RIVE_WORKLOAD_PLAN_KIND = 'haiyue-rive-g11-workload-plan';
export const RIVE_WORKLOAD_PLAN_VERSION = 1;
export const RIVE_WORKLOAD_SCENARIO_KIND = 'haiyue-rive-workload-scenario';
export const RIVE_WORKLOAD_SCENARIO_VERSION = 1;

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[a-z0-9][a-z0-9-]*$/u;
const DEVICE_MATRIX = Object.freeze(new Map([
  ['windows-10-integrated', ['chrome', 'edge']],
  ['windows-11-discrete', ['chrome', 'edge']],
]));
const CHANNELS = Object.freeze([
  'pixels', 'geometryAndDrawOrder', 'stateMachineState', 'dataValues', 'events',
  'pointerKeyboardGamepadFocus', 'resizeAndDpr', 'audioSchedule',
  'semanticTreeAndActions', 'resourceReplacement', 'errorsAndOwners',
]);
const ACTION_KINDS = Object.freeze([
  'initialize', 'seek', 'data-mutation', 'pointer', 'keyboard', 'gamepad', 'focus',
  'resize', 'resource-replacement', 'semantic-action', 'reduced-motion',
]);
const LIFECYCLE_PATHS = Object.freeze([
  'normal', 'abort', 'reimport', 'project-close', 'device-loss', 'late-result',
]);
const METRICS = Object.freeze([
  'rawBytes', 'gzipBytes', 'networkBytes', 'networkMs', 'parseMs', 'firstFrameMs',
  'cpuFrameMs', 'gpuFrameMs', 'peakMemoryBytes', 'settleMs', 'energyMj',
]);

export function validateRiveWorkloadPlan(plan) {
  const violations = [];
  equal(plan?.schemaVersion, RIVE_WORKLOAD_PLAN_VERSION, 'schemaVersion');
  equal(plan?.kind, RIVE_WORKLOAD_PLAN_KIND, 'kind');
  id(plan?.id, 'id');
  equal(plan?.compatibilityTupleId, 'rive-7.3-webgl2-2.40.0', 'tuple id');
  equal(plan?.traceContract, 'haiyue-rive-oracle-differential-trace@2', 'trace contract');
  equal(plan?.scenarioContract, 'haiyue-rive-workload-scenario@1', 'scenario contract');
  exactSet(plan?.requiredTraceChannels, CHANNELS, 'required trace channels');
  exactSet(plan?.requiredActionKinds, ACTION_KINDS, 'required action kinds');
  exactSet(plan?.requiredLifecyclePaths, LIFECYCLE_PATHS, 'required lifecycle paths');

  const viewports = array(plan?.viewportMatrix, 'viewport matrix');
  if (viewports.length < 3) violations.push('viewport matrix must contain at least three entries');
  const viewportIds = new Set();
  for (const viewport of viewports) {
    id(viewport?.id, 'viewport id');
    if (viewportIds.has(viewport?.id)) violations.push(`duplicate viewport ${String(viewport?.id)}`);
    viewportIds.add(viewport?.id);
    positiveInteger(viewport?.width, `${String(viewport?.id)} width`);
    positiveInteger(viewport?.height, `${String(viewport?.id)} height`);
    positiveNumber(viewport?.dpr, `${String(viewport?.id)} DPR`);
  }
  if (!viewports.some(value => value?.dpr === 1)) violations.push('viewport matrix must include DPR 1');
  if (!viewports.some(value => value?.dpr > 1)) violations.push('viewport matrix must include high DPR');

  const clock = plan?.clock;
  equal(clock?.unit, 'integer-microseconds', 'clock unit');
  if (!Number.isSafeInteger(clock?.minimumSteps) || clock.minimumSteps < 16) violations.push('clock minimumSteps must be at least 16');
  if (!Number.isSafeInteger(clock?.minimumDurationMicros) || clock.minimumDurationMicros < 2_000_000) violations.push('clock minimum duration must be at least two seconds');
  equal(clock?.strictlyIncreasing, true, 'clock ordering');
  if (!Number.isSafeInteger(clock?.replayCount) || clock.replayCount < 2) violations.push('clock replay count must be at least two');

  const measurement = plan?.measurement;
  equal(measurement?.workload, 'full', 'measurement workload');
  equal(measurement?.cachePolicy, 'fresh-owner-no-store-per-sample', 'cache policy');
  equal(measurement?.compression, 'gzip-9-per-file', 'compression policy');
  positiveInteger(measurement?.warmupIterations, 'warmup iterations');
  if (!Number.isSafeInteger(measurement?.measuredIterations) || measurement.measuredIterations < 30) violations.push('measured iterations must be at least 30');
  if (!Number.isSafeInteger(measurement?.frameSampleCount) || measurement.frameSampleCount < 120) violations.push('frame sample count must be at least 120');
  equal(measurement?.networkIncludesExternalAssets, true, 'external asset network accounting');
  equal(measurement?.queueCompletionRequired, true, 'queue completion policy');
  equal(measurement?.energySourceRequired, true, 'energy source policy');
  exactSet(measurement?.metrics, METRICS, 'measurement metrics');

  const matrix = array(plan?.browserDeviceMatrix, 'browser device matrix');
  const seenDevices = new Set();
  for (const entry of matrix) {
    const expected = DEVICE_MATRIX.get(entry?.deviceClass);
    if (!expected) violations.push(`unknown device class ${String(entry?.deviceClass)}`);
    if (seenDevices.has(entry?.deviceClass)) violations.push(`duplicate device class ${String(entry?.deviceClass)}`);
    seenDevices.add(entry?.deviceClass);
    exactSet(entry?.browsers, expected ?? [], `${String(entry?.deviceClass)} browsers`);
  }
  for (const device of DEVICE_MATRIX.keys()) if (!seenDevices.has(device)) violations.push(`missing device class ${device}`);

  for (const [key, expected] of Object.entries({
    sameCleanRevision: true,
    sameMachineOfficialAndHya: true,
    freshOwnerPerReplay: true,
    consoleErrorsAllowed: 0,
    exceptionsAllowed: 0,
    ownerResidualAllowed: 0,
    unclassifiedFailuresAllowed: 0,
  })) equal(plan?.formalRules?.[key], expected, `formal rule ${key}`);

  return result('haiyue-rive-g11-workload-plan@1', violations);

  function equal(actual, expected, label) { if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`); }
  function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) violations.push(`${label} is invalid`); }
  function positiveInteger(value, label) { if (!Number.isSafeInteger(value) || value < 1) violations.push(`${label} must be a positive safe integer`); }
  function positiveNumber(value, label) { if (!Number.isFinite(value) || value <= 0) violations.push(`${label} must be positive`); }
  function array(value, label) { if (!Array.isArray(value)) { violations.push(`${label} must be an array`); return []; } return value; }
  function exactSet(actual, expected, label) {
    const values = array(actual, label);
    const unique = new Set(values);
    if (unique.size !== values.length || unique.size !== expected.length || expected.some(value => !unique.has(value))) violations.push(`${label} does not match the frozen set`);
  }
}

export function validateRiveWorkloadScenario(scenario, plan, { expectedAssetId = null, expectedRivSha256 = null } = {}) {
  const violations = [];
  const planValidation = validateRiveWorkloadPlan(plan);
  if (planValidation.status !== 'passed') violations.push(...planValidation.violations.map(value => `plan: ${value}`));
  equal(scenario?.schemaVersion, RIVE_WORKLOAD_SCENARIO_VERSION, 'schemaVersion');
  equal(scenario?.kind, RIVE_WORKLOAD_SCENARIO_KIND, 'kind');
  id(scenario?.id, 'scenario id');
  id(scenario?.assetId, 'asset id');
  if (expectedAssetId) equal(scenario?.assetId, expectedAssetId, 'expected asset id');
  match(scenario?.rivSha256, HASH, 'RIV hash');
  if (expectedRivSha256) equal(scenario?.rivSha256, expectedRivSha256, 'expected RIV hash');
  equal(scenario?.compatibilityTupleId, plan?.compatibilityTupleId, 'tuple id');
  for (const key of ['artboard', 'animation', 'stateMachine']) requiredString(scenario?.selection?.[key], `selection ${key}`);
  plainObject(scenario?.initialData, 'initial data');
  const resources = array(scenario?.initialResources, 'initial resources');
  const resourceIds = new Set();
  for (const resource of resources) {
    requiredString(resource?.id, 'resource id');
    if (resourceIds.has(resource?.id)) violations.push(`duplicate resource ${String(resource?.id)}`);
    resourceIds.add(resource?.id);
    match(resource?.sha256, HASH, `${String(resource?.id)} resource hash`);
  }

  const steps = array(scenario?.clockStepsMicros, 'clock steps');
  if (steps.length < Number(plan?.clock?.minimumSteps ?? Infinity)) violations.push('clock step population is below the plan minimum');
  if (steps[0] !== 0) violations.push('clock steps must begin at zero');
  if (steps.some(value => !Number.isSafeInteger(value) || value < 0)) violations.push('clock steps must be non-negative safe integers');
  if (steps.some((value, index) => index > 0 && value <= steps[index - 1])) violations.push('clock steps must be strictly increasing');
  if ((steps.at(-1) ?? 0) < Number(plan?.clock?.minimumDurationMicros ?? Infinity)) violations.push('scenario duration is below the plan minimum');

  const actions = array(scenario?.actions, 'actions');
  const actionIds = new Set();
  const observedKinds = new Set();
  const observedChannels = new Set();
  for (const [index, action] of actions.entries()) {
    id(action?.id, `action ${index} id`);
    if (actionIds.has(action?.id)) violations.push(`duplicate action ${String(action?.id)}`);
    actionIds.add(action?.id);
    if (!ACTION_KINDS.includes(action?.kind)) violations.push(`action ${index} kind is invalid`);
    else observedKinds.add(action.kind);
    if (!steps.includes(action?.atMicros)) violations.push(`action ${index} is not bound to a clock step`);
    if (index > 0 && action.atMicros < actions[index - 1].atMicros) violations.push('actions are not ordered');
    plainObject(action?.payload, `action ${index} payload`);
    const channels = array(action?.expectedChannels, `action ${index} expected channels`);
    if (channels.length === 0) violations.push(`action ${index} has no expected channels`);
    for (const channel of channels) {
      if (!CHANNELS.includes(channel)) violations.push(`action ${index} contains unknown channel ${String(channel)}`);
      else observedChannels.add(channel);
    }
  }
  for (const kind of ACTION_KINDS) if (!observedKinds.has(kind)) violations.push(`missing action kind ${kind}`);
  for (const channel of CHANNELS) if (!observedChannels.has(channel)) violations.push(`scenario does not exercise trace channel ${channel}`);
  exactSet(scenario?.lifecyclePaths, LIFECYCLE_PATHS, 'lifecycle paths');
  if (!Number.isSafeInteger(scenario?.replayCount) || scenario.replayCount < Number(plan?.clock?.replayCount ?? Infinity)) violations.push('scenario replay count is below the plan minimum');

  return result('haiyue-rive-workload-scenario@1', violations);

  function equal(actual, expected, label) { if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`); }
  function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) violations.push(`${label} is invalid`); }
  function match(value, expression, label) { if (typeof value !== 'string' || !expression.test(value)) violations.push(`${label} is invalid`); }
  function requiredString(value, label) { if (typeof value !== 'string' || value.trim().length === 0) violations.push(`${label} is missing`); }
  function plainObject(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) violations.push(`${label} must be an object`); }
  function array(value, label) { if (!Array.isArray(value)) { violations.push(`${label} must be an array`); return []; } return value; }
  function exactSet(actual, expected, label) {
    const values = array(actual, label);
    const unique = new Set(values);
    if (unique.size !== values.length || unique.size !== expected.length || expected.some(value => !unique.has(value))) violations.push(`${label} does not match the frozen set`);
  }
}

export function riveWorkloadTraceChannels() { return CHANNELS; }
export function riveWorkloadActionKinds() { return ACTION_KINDS; }
export function riveWorkloadLifecyclePaths() { return LIFECYCLE_PATHS; }
export function riveWorkloadMetricNames() { return METRICS; }

function result(contract, violations) {
  return Object.freeze({ schemaVersion: 1, contract, status: violations.length === 0 ? 'passed' : 'failed', violations: Object.freeze(violations) });
}
