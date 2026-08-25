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
const POINTER_PHASES = Object.freeze(['down', 'move', 'up', 'exit']);
const KEYBOARD_PHASES = Object.freeze(['down', 'up']);
const GAMEPAD_OPERATIONS = Object.freeze(['connect', 'sample', 'disconnect']);
const FOCUS_OPERATIONS = Object.freeze(['request', 'next', 'previous', 'clear']);
const RESOURCE_REPLACEMENT_OUTCOMES = Object.freeze(['applied', 'missing', 'integrity-failure']);
const SEMANTIC_ACTIONS = Object.freeze(['tap', 'increase', 'decrease', 'focus']);
const REDUCED_MOTION_STATES = Object.freeze([false, true]);
const ACTION_REQUIRED_CHANNELS = Object.freeze({
  initialize: CHANNELS,
  seek: ['pixels', 'geometryAndDrawOrder', 'stateMachineState', 'events', 'audioSchedule'],
  'data-mutation': ['dataValues'],
  pointer: ['pointerKeyboardGamepadFocus'],
  keyboard: ['pointerKeyboardGamepadFocus'],
  gamepad: ['pointerKeyboardGamepadFocus'],
  focus: ['pointerKeyboardGamepadFocus'],
  resize: ['resizeAndDpr'],
  'resource-replacement': ['resourceReplacement'],
  'semantic-action': ['semanticTreeAndActions'],
  'reduced-motion': ['semanticTreeAndActions'],
});

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
  const actionCoverage = plan?.actionCoverage;
  equal(actionCoverage?.payloadContractVersion, 1, 'action payload contract version');
  equal(actionCoverage?.unknownFields, 'reject', 'action payload unknown-field policy');
  equal(actionCoverage?.allViewportIds, true, 'action viewport coverage');
  exactSet(actionCoverage?.pointerPhases, POINTER_PHASES, 'pointer phase coverage');
  exactSet(actionCoverage?.keyboardPhases, KEYBOARD_PHASES, 'keyboard phase coverage');
  exactSet(actionCoverage?.gamepadOperations, GAMEPAD_OPERATIONS, 'gamepad operation coverage');
  exactSet(actionCoverage?.focusOperations, FOCUS_OPERATIONS, 'focus operation coverage');
  exactSet(actionCoverage?.resourceReplacementOutcomes, RESOURCE_REPLACEMENT_OUTCOMES, 'resource replacement coverage');
  exactSet(actionCoverage?.semanticActions, SEMANTIC_ACTIONS, 'semantic action coverage');
  exactSet(actionCoverage?.reducedMotionStates, REDUCED_MOTION_STATES, 'reduced motion coverage');

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
  exactKeys(scenario?.selection, ['artboard', 'animation', 'stateMachine'], 'selection');
  for (const key of ['artboard', 'animation', 'stateMachine']) requiredString(scenario?.selection?.[key], `selection ${key}`);
  if (!isBoundedJson(scenario?.initialData) || Array.isArray(scenario?.initialData) || scenario?.initialData === null) violations.push('initial data must be a bounded JSON object');
  const resources = array(scenario?.initialResources, 'initial resources');
  const resourceIds = new Set();
  for (const resource of resources) {
    exactKeys(resource, ['id', 'sha256', 'revision', 'mimeType', 'byteLength'], 'initial resource');
    requiredString(resource?.id, 'resource id');
    if (resourceIds.has(resource?.id)) violations.push(`duplicate resource ${String(resource?.id)}`);
    resourceIds.add(resource?.id);
    match(resource?.sha256, HASH, `${String(resource?.id)} resource hash`);
    requiredString(resource?.revision, `${String(resource?.id)} resource revision`);
    requiredString(resource?.mimeType, `${String(resource?.id)} resource media type`);
    nonnegativeInteger(resource?.byteLength, `${String(resource?.id)} resource bytes`);
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
  const payloadCoverage = {
    viewports: new Set(), pointerPhases: new Set(), keyboardPhases: new Set(), gamepadOperations: new Set(),
    focusOperations: new Set(), resourceReplacementOutcomes: new Set(), semanticActions: new Set(), reducedMotionStates: new Set(),
  };
  for (const [index, action] of actions.entries()) {
    exactKeys(action, ['id', 'kind', 'atMicros', 'payload', 'expectedChannels'], `action ${index}`);
    id(action?.id, `action ${index} id`);
    if (actionIds.has(action?.id)) violations.push(`duplicate action ${String(action?.id)}`);
    actionIds.add(action?.id);
    if (!ACTION_KINDS.includes(action?.kind)) violations.push(`action ${index} kind is invalid`);
    else observedKinds.add(action.kind);
    if (!steps.includes(action?.atMicros)) violations.push(`action ${index} is not bound to a clock step`);
    if (index > 0 && action.atMicros < actions[index - 1].atMicros) violations.push('actions are not ordered');
    if (!action?.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)) violations.push(`action ${index} payload must be an object`);
    else validateActionPayload(action, index, payloadCoverage);
    const channels = array(action?.expectedChannels, `action ${index} expected channels`);
    if (channels.length === 0) violations.push(`action ${index} has no expected channels`);
    if (new Set(channels).size !== channels.length) violations.push(`action ${index} repeats an expected channel`);
    for (const channel of channels) {
      if (!CHANNELS.includes(channel)) violations.push(`action ${index} contains unknown channel ${String(channel)}`);
      else observedChannels.add(channel);
    }
    for (const channel of ACTION_REQUIRED_CHANNELS[action?.kind] ?? []) if (!channels.includes(channel)) violations.push(`action ${index} must exercise ${channel}`);
  }
  if (actions[0]?.kind !== 'initialize') violations.push('first action must initialize the workload');
  for (const kind of ACTION_KINDS) if (!observedKinds.has(kind)) violations.push(`missing action kind ${kind}`);
  for (const channel of CHANNELS) if (!observedChannels.has(channel)) violations.push(`scenario does not exercise trace channel ${channel}`);
  exactSet([...payloadCoverage.viewports], plan?.viewportMatrix?.map(value => value.id) ?? [], 'scenario viewport action coverage');
  exactSet([...payloadCoverage.pointerPhases], plan?.actionCoverage?.pointerPhases ?? [], 'scenario pointer phase coverage');
  exactSet([...payloadCoverage.keyboardPhases], plan?.actionCoverage?.keyboardPhases ?? [], 'scenario keyboard phase coverage');
  exactSet([...payloadCoverage.gamepadOperations], plan?.actionCoverage?.gamepadOperations ?? [], 'scenario gamepad operation coverage');
  exactSet([...payloadCoverage.focusOperations], plan?.actionCoverage?.focusOperations ?? [], 'scenario focus operation coverage');
  exactSet([...payloadCoverage.resourceReplacementOutcomes], plan?.actionCoverage?.resourceReplacementOutcomes ?? [], 'scenario resource replacement coverage');
  exactSet([...payloadCoverage.semanticActions], plan?.actionCoverage?.semanticActions ?? [], 'scenario semantic action coverage');
  exactSet([...payloadCoverage.reducedMotionStates], plan?.actionCoverage?.reducedMotionStates ?? [], 'scenario reduced motion coverage');
  exactSet(scenario?.lifecyclePaths, LIFECYCLE_PATHS, 'lifecycle paths');
  if (!Number.isSafeInteger(scenario?.replayCount) || scenario.replayCount < Number(plan?.clock?.replayCount ?? Infinity)) violations.push('scenario replay count is below the plan minimum');

  return result('haiyue-rive-workload-scenario@1', violations);

  function validateActionPayload(action, index, coverage) {
    const payload = action.payload;
    const label = `action ${index} payload`;
    switch (action.kind) {
      case 'initialize':
        exactKeys(payload, ['viewportId', 'reducedMotion'], label);
        viewport(payload.viewportId, label, coverage);
        boolean(payload.reducedMotion, `${label} reducedMotion`);
        if (typeof payload.reducedMotion === 'boolean') coverage.reducedMotionStates.add(payload.reducedMotion);
        if (action.atMicros !== 0) violations.push(`${label} initialize must occur at zero`);
        return;
      case 'seek':
        exactKeys(payload, ['timeMicros'], label);
        if (!Number.isSafeInteger(payload.timeMicros) || payload.timeMicros < 0 || payload.timeMicros > (steps.at(-1) ?? 0)) violations.push(`${label} timeMicros is invalid`);
        return;
      case 'data-mutation':
        validateDataMutation(payload, label);
        return;
      case 'pointer':
        exactKeys(payload, ['phase', 'x', 'y', 'pointerId', 'buttons'], label);
        enumeration(payload.phase, POINTER_PHASES, `${label} phase`, coverage.pointerPhases);
        finite(payload.x, `${label} x`); finite(payload.y, `${label} y`);
        nonnegativeInteger(payload.pointerId, `${label} pointerId`); nonnegativeInteger(payload.buttons, `${label} buttons`);
        return;
      case 'keyboard':
        exactKeys(payload, ['phase', 'code', 'key', 'repeat', 'modifiers'], label);
        enumeration(payload.phase, KEYBOARD_PHASES, `${label} phase`, coverage.keyboardPhases);
        requiredString(payload.code, `${label} code`); requiredString(payload.key, `${label} key`); boolean(payload.repeat, `${label} repeat`);
        exactKeys(payload.modifiers, ['alt', 'ctrl', 'meta', 'shift'], `${label} modifiers`);
        for (const key of ['alt', 'ctrl', 'meta', 'shift']) boolean(payload.modifiers?.[key], `${label} modifiers ${key}`);
        return;
      case 'gamepad':
        exactKeys(payload, ['operation', 'index', 'axes', 'buttons'], label);
        enumeration(payload.operation, GAMEPAD_OPERATIONS, `${label} operation`, coverage.gamepadOperations);
        nonnegativeInteger(payload.index, `${label} index`);
        finiteArray(payload.axes, -1, 1, `${label} axes`); finiteArray(payload.buttons, 0, 1, `${label} buttons`);
        return;
      case 'focus':
        exactKeys(payload, payload.operation === 'request' ? ['operation', 'target'] : ['operation'], label);
        enumeration(payload.operation, FOCUS_OPERATIONS, `${label} operation`, coverage.focusOperations);
        if (payload.operation === 'request') requiredString(payload.target, `${label} target`);
        return;
      case 'resize':
        exactKeys(payload, ['viewportId'], label);
        viewport(payload.viewportId, label, coverage);
        return;
      case 'resource-replacement':
        exactKeys(payload, ['resourceId', 'outcome', 'expectedSha256', 'replacementSha256', 'revision'], label);
        requiredString(payload.resourceId, `${label} resourceId`); requiredString(payload.revision, `${label} revision`);
        enumeration(payload.outcome, RESOURCE_REPLACEMENT_OUTCOMES, `${label} outcome`, coverage.resourceReplacementOutcomes);
        match(payload.expectedSha256, HASH, `${label} expected hash`);
        if (payload.outcome === 'missing') {
          if (payload.replacementSha256 !== null) violations.push(`${label} missing outcome requires a null replacement hash`);
        } else {
          match(payload.replacementSha256, HASH, `${label} replacement hash`);
          if (payload.outcome === 'applied' && payload.expectedSha256 !== payload.replacementSha256) violations.push(`${label} applied hashes must match`);
          if (payload.outcome === 'integrity-failure' && payload.expectedSha256 === payload.replacementSha256) violations.push(`${label} integrity-failure hashes must differ`);
        }
        return;
      case 'semantic-action':
        exactKeys(payload, ['target', 'action'], label);
        requiredString(payload.target, `${label} target`);
        enumeration(payload.action, SEMANTIC_ACTIONS, `${label} action`, coverage.semanticActions);
        return;
      case 'reduced-motion':
        exactKeys(payload, ['enabled'], label);
        boolean(payload.enabled, `${label} enabled`);
        if (typeof payload.enabled === 'boolean') coverage.reducedMotionStates.add(payload.enabled);
        return;
      default:
        return;
    }
  }

  function validateDataMutation(payload, label) {
    const operation = payload.operation;
    const keys = operation === 'set' ? ['operation', 'path', 'value']
      : operation === 'trigger' ? ['operation', 'path']
        : operation === 'insert' ? ['operation', 'path', 'index', 'value']
          : operation === 'remove' ? ['operation', 'path', 'index']
            : operation === 'swap' ? ['operation', 'path', 'index', 'otherIndex']
              : ['operation', 'path'];
    exactKeys(payload, keys, label);
    enumeration(operation, ['set', 'trigger', 'insert', 'remove', 'swap'], `${label} operation`);
    requiredString(payload.path, `${label} path`);
    if (['insert', 'remove', 'swap'].includes(operation)) nonnegativeInteger(payload.index, `${label} index`);
    if (operation === 'swap') nonnegativeInteger(payload.otherIndex, `${label} otherIndex`);
    if (['set', 'insert'].includes(operation) && !isBoundedJson(payload.value)) violations.push(`${label} value is not bounded JSON`);
  }

  function viewport(value, label, coverage) {
    if (!(plan?.viewportMatrix ?? []).some(item => item.id === value)) violations.push(`${label} viewportId is unknown`);
    else coverage.viewports.add(value);
  }
  function exactKeys(value, expected, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { violations.push(`${label} must be an object`); return; }
    const actual = Object.keys(value).sort(); const ordered = [...expected].sort();
    if (actual.length !== ordered.length || actual.some((key, keyIndex) => key !== ordered[keyIndex])) violations.push(`${label} fields do not match the frozen contract`);
  }
  function enumeration(value, expected, label, observed) { if (!expected.includes(value)) violations.push(`${label} is invalid`); else observed?.add(value); }
  function boolean(value, label) { if (typeof value !== 'boolean') violations.push(`${label} must be boolean`); }
  function finite(value, label) { if (!Number.isFinite(value)) violations.push(`${label} must be finite`); }
  function nonnegativeInteger(value, label) { if (!Number.isSafeInteger(value) || value < 0) violations.push(`${label} must be a non-negative safe integer`); }
  function finiteArray(value, minimum, maximum, label) {
    if (!Array.isArray(value) || value.some(item => !Number.isFinite(item) || item < minimum || item > maximum)) violations.push(`${label} is invalid`);
  }

  function equal(actual, expected, label) { if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`); }
  function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) violations.push(`${label} is invalid`); }
  function match(value, expression, label) { if (typeof value !== 'string' || !expression.test(value)) violations.push(`${label} is invalid`); }
  function requiredString(value, label) { if (typeof value !== 'string' || value.trim().length === 0) violations.push(`${label} is missing`); }
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

function isBoundedJson(value, depth = 0, state = { nodes: 0 }) {
  state.nodes++;
  if (state.nodes > 1_024 || depth > 16) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 65_536;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_024 && value.every(item => isBoundedJson(item, depth + 1, state));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  return entries.length <= 1_024 && entries.every(([key, item]) => key.length <= 512 && isBoundedJson(item, depth + 1, state));
}
