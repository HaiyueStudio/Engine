import { AnimationFormatError } from './errors';

export const HYA_STATE_MACHINE_EXTENSION_ID = 'org.haiyue.animation-state-machine@1' as const;

/**
 * Stable channel families shared by the HYA compiler, editor capability UI,
 * and runtime adapters. A family describes value semantics; concrete channel
 * ids below additionally describe whether the current shared runtime can
 * execute that binding without falling back to a second sampler.
 */
export type HyaStateMachineChannelKind =
  | 'continuous-number'
  | 'discrete-step'
  | 'shape-morph'
  | 'resource-switch'
  | 'particle-side-effect'
  | 'audio-side-effect'
  | 'pose-3d';

export type HyaStateMachineChannelSupport = 'full' | 'degraded' | 'unsupported';

export type HyaStateMachineChannelId =
  | 'core-transform'
  | 'sprite-uv'
  | 'vector-morph'
  | 'vector-paint'
  | 'text-animator'
  | 'visual-effect'
  | 'composite-expansion'
  | 'resource-switch'
  | 'particle-2d'
  | 'particle-3d'
  | 'audio'
  | 'pose-3d';

export interface HyaStateMachineChannelCapability {
  readonly id: HyaStateMachineChannelId;
  readonly kind: HyaStateMachineChannelKind;
  readonly support: HyaStateMachineChannelSupport;
  readonly sampling: 'numeric-track' | 'step-track' | 'effect-cue' | 'pose-buffer';
  readonly mixing:
    | 'override-additive-layer-mask'
    | 'dominant-weight-then-action-order'
    | 'shared-instance-lifecycle'
    | 'reject-overlap';
  readonly ownership: 'pose-buffer' | 'shared-visual' | 'shared-side-effect';
  readonly transition:
    | 'cross-fade'
    | 'switch-at-dominant-weight'
    | 'destination-takeover'
    | 'immediate-only'
    | 'rejected';
  /** Stable diagnostic emitted when support is not full. */
  readonly diagnosticCode?:
    | 'E_STATE_MACHINE_CHANNEL_ADVANCED_INLINE_UNSUPPORTED'
    | 'E_STATE_MACHINE_CHANNEL_RESOURCE_SWITCH_OVERLAP'
    | 'E_STATE_MACHINE_CHANNEL_AUDIO_UNMIXABLE_RANGE';
}

const STATE_MACHINE_CHANNEL_CAPABILITIES: readonly HyaStateMachineChannelCapability[] = Object.freeze([
  channel('core-transform', 'continuous-number', 'full', 'numeric-track', 'override-additive-layer-mask', 'pose-buffer', 'cross-fade'),
  channel('sprite-uv', 'discrete-step', 'full', 'step-track', 'dominant-weight-then-action-order', 'shared-visual', 'switch-at-dominant-weight'),
  channel('vector-morph', 'shape-morph', 'full', 'numeric-track', 'override-additive-layer-mask', 'shared-visual', 'cross-fade'),
  channel('vector-paint', 'continuous-number', 'unsupported', 'numeric-track', 'override-additive-layer-mask', 'shared-visual', 'rejected', 'E_STATE_MACHINE_CHANNEL_ADVANCED_INLINE_UNSUPPORTED'),
  channel('text-animator', 'continuous-number', 'unsupported', 'numeric-track', 'override-additive-layer-mask', 'shared-visual', 'rejected', 'E_STATE_MACHINE_CHANNEL_ADVANCED_INLINE_UNSUPPORTED'),
  channel('visual-effect', 'continuous-number', 'unsupported', 'numeric-track', 'override-additive-layer-mask', 'shared-visual', 'rejected', 'E_STATE_MACHINE_CHANNEL_ADVANCED_INLINE_UNSUPPORTED'),
  channel('composite-expansion', 'continuous-number', 'unsupported', 'numeric-track', 'override-additive-layer-mask', 'shared-visual', 'rejected', 'E_STATE_MACHINE_CHANNEL_ADVANCED_INLINE_UNSUPPORTED'),
  channel('resource-switch', 'resource-switch', 'degraded', 'step-track', 'dominant-weight-then-action-order', 'shared-visual', 'switch-at-dominant-weight', 'E_STATE_MACHINE_CHANNEL_RESOURCE_SWITCH_OVERLAP'),
  channel('particle-2d', 'particle-side-effect', 'full', 'effect-cue', 'shared-instance-lifecycle', 'shared-side-effect', 'destination-takeover'),
  channel('particle-3d', 'particle-side-effect', 'full', 'effect-cue', 'shared-instance-lifecycle', 'shared-side-effect', 'destination-takeover'),
  channel('audio', 'audio-side-effect', 'degraded', 'effect-cue', 'reject-overlap', 'shared-side-effect', 'immediate-only', 'E_STATE_MACHINE_CHANNEL_AUDIO_UNMIXABLE_RANGE'),
  channel('pose-3d', 'pose-3d', 'full', 'pose-buffer', 'override-additive-layer-mask', 'pose-buffer', 'cross-fade'),
]);

/** Canonical immutable channel registry for the built-in state machine. */
export const HYA_STATE_MACHINE_CHANNEL_REGISTRY: ReadonlyMap<
  HyaStateMachineChannelId,
  HyaStateMachineChannelCapability
> = immutableReadonlyMap(
  STATE_MACHINE_CHANNEL_CAPABILITIES.map(capability => [capability.id, capability] as const),
);

export function hyaStateMachineChannelCapability(
  id: HyaStateMachineChannelId,
): HyaStateMachineChannelCapability {
  return HYA_STATE_MACHINE_CHANNEL_REGISTRY.get(id)!;
}

function immutableReadonlyMap<K, V>(entries: readonly (readonly [K, V])[]): ReadonlyMap<K, V> {
  const source = new Map(entries);
  let view: ReadonlyMap<K, V>;
  view = Object.freeze({
    get size(): number { return source.size; },
    get: (key: K): V | undefined => source.get(key),
    has: (key: K): boolean => source.has(key),
    entries: (): MapIterator<[K, V]> => source.entries(),
    keys: (): MapIterator<K> => source.keys(),
    values: (): MapIterator<V> => source.values(),
    forEach: (
      callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
      thisArg?: unknown,
    ): void => source.forEach((value, key) => callbackfn.call(thisArg, value, key, view)),
    [Symbol.iterator]: (): MapIterator<[K, V]> => source[Symbol.iterator](),
  });
  return view;
}

export interface HyaAnimationClipRange {
  readonly id: string;
  readonly name?: string;
  /** Start in the document composition, in seconds. */
  readonly start: number;
  readonly duration: number;
}

export type HyaStateMachineLoopMode = 'once' | 'repeat' | 'ping-pong';
export type HyaStateMachineBlendMode = 'override' | 'additive';

export interface HyaStateMachineBindingMask {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export type HyaStateMachineParameter =
  | Readonly<{ name: string; type: 'float'; defaultValue: number }>
  | Readonly<{ name: string; type: 'integer'; defaultValue: number }>
  | Readonly<{ name: string; type: 'boolean'; defaultValue: boolean }>
  | Readonly<{ name: string; type: 'trigger' }>;

export type HyaStateMachineCondition =
  | Readonly<{
      parameter: string;
      operator: 'greater' | 'greater-or-equal' | 'less' | 'less-or-equal';
      value: number;
    }>
  | Readonly<{
      parameter: string;
      operator: 'equal' | 'not-equal';
      value: number | boolean;
    }>
  | Readonly<{
      parameter: string;
      operator: 'is-true' | 'is-false' | 'triggered';
    }>;

export interface HyaStateMachineClipMotion {
  readonly kind: 'clip';
  readonly clipId: string;
}

export interface HyaStateMachineBlend1DMotion {
  readonly kind: 'blend-1d';
  readonly parameter: string;
  readonly children: readonly Readonly<{
    threshold: number;
    motion: HyaStateMachineMotion;
  }>[];
}

export interface HyaStateMachineBlend2DMotion {
  readonly kind: 'blend-2d';
  readonly algorithm: 'cartesian' | 'directional';
  readonly parameterX: string;
  readonly parameterY: string;
  readonly children: readonly Readonly<{
    position: readonly [number, number];
    motion: HyaStateMachineMotion;
  }>[];
}

export type HyaStateMachineMotion =
  | HyaStateMachineClipMotion
  | HyaStateMachineBlend1DMotion
  | HyaStateMachineBlend2DMotion;

export interface HyaStateMachineState {
  readonly id: string;
  readonly name: string;
  readonly motion: HyaStateMachineMotion;
  readonly speed?: number;
  readonly speedParameter?: string;
  readonly loop?: HyaStateMachineLoopMode;
}

export interface HyaStateMachineTransition {
  readonly id: string;
  readonly from: string | '*';
  readonly to: string;
  readonly conditions: readonly HyaStateMachineCondition[];
  readonly duration: number;
  readonly hasExitTime?: boolean;
  readonly exitTime?: number;
  readonly destinationOffset?: number;
  readonly interruption?:
    | 'none'
    | 'source'
    | 'destination'
    | 'source-then-destination'
    | 'destination-then-source';
}

export interface HyaStateMachineLayer {
  readonly id: string;
  readonly name: string;
  readonly initialStateId: string;
  readonly states: readonly HyaStateMachineState[];
  readonly transitions: readonly HyaStateMachineTransition[];
  readonly blendMode?: HyaStateMachineBlendMode;
  readonly weight?: number;
  readonly mask?: HyaStateMachineBindingMask;
}

export interface HyaStateMachineDefinition {
  readonly format: 'haiyue-animation-state-machine@1';
  readonly id: string;
  readonly name: string;
  readonly parameters: readonly HyaStateMachineParameter[];
  readonly layers: readonly HyaStateMachineLayer[];
}

export interface HyaStateMachineExtension {
  readonly clips: readonly HyaAnimationClipRange[];
  readonly stateMachine: HyaStateMachineDefinition;
}

const MAX_CLIPS = 10_000;
const MAX_PARAMETERS = 1_000;
const MAX_LAYERS = 128;
const MAX_STATES = 100_000;
const MAX_TRANSITIONS = 200_000;
const MAX_BLEND_DEPTH = 32;
const MAX_BLEND_CHILDREN = 4_096;

function channel(
  id: HyaStateMachineChannelId,
  kind: HyaStateMachineChannelKind,
  support: HyaStateMachineChannelSupport,
  sampling: HyaStateMachineChannelCapability['sampling'],
  mixing: HyaStateMachineChannelCapability['mixing'],
  ownership: HyaStateMachineChannelCapability['ownership'],
  transition: HyaStateMachineChannelCapability['transition'],
  diagnosticCode?: HyaStateMachineChannelCapability['diagnosticCode'],
): HyaStateMachineChannelCapability {
  return Object.freeze({
    id,
    kind,
    support,
    sampling,
    mixing,
    ownership,
    transition,
    ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
  });
}

/** Strictly validates and freezes the built-in HYA state-machine extension. */
export function parseHyaStateMachineExtension(
  value: unknown,
  compositionDuration: number,
  path = `$.extensions.${HYA_STATE_MACHINE_EXTENSION_ID}`,
): HyaStateMachineExtension {
  positive(compositionDuration, '$.duration');
  const root = record(value, path);
  knownKeys(root, ['clips', 'stateMachine'], path);
  const clipValues = array(root.clips, `${path}.clips`);
  bounded(clipValues.length, 1, MAX_CLIPS, 'clips', `${path}.clips`);
  const clipIds = new Set<string>();
  const clips = clipValues.map((entry, index) => {
    const clipPath = `${path}.clips[${index}]`;
    const clip = record(entry, clipPath);
    knownKeys(clip, ['id', 'name', 'start', 'duration'], clipPath);
    const id = identifier(clip.id, `${clipPath}.id`);
    unique(clipIds, id, `${clipPath}.id`, 'clip');
    const start = nonNegative(clip.start, `${clipPath}.start`);
    const duration = positive(clip.duration, `${clipPath}.duration`);
    if (start + duration > compositionDuration + 1e-6) {
      invalid('Clip range must fit inside the HYA composition duration.', clipPath);
    }
    return Object.freeze({
      id,
      ...(clip.name === undefined ? {} : { name: text(clip.name, `${clipPath}.name`) }),
      start,
      duration,
    });
  });

  const stateMachine = parseStateMachine(root.stateMachine, clipIds, `${path}.stateMachine`);
  return Object.freeze({ clips: Object.freeze(clips), stateMachine });
}

function parseStateMachine(
  value: unknown,
  clipIds: ReadonlySet<string>,
  path: string,
): HyaStateMachineDefinition {
  const root = record(value, path);
  knownKeys(root, ['format', 'id', 'name', 'parameters', 'layers'], path);
  if (root.format !== 'haiyue-animation-state-machine@1') {
    invalid('State machine format must be "haiyue-animation-state-machine@1".', `${path}.format`);
  }
  const parametersInput = array(root.parameters, `${path}.parameters`);
  bounded(parametersInput.length, 0, MAX_PARAMETERS, 'parameters', `${path}.parameters`);
  const parameterNames = new Set<string>();
  const parameterTypes = new Map<string, HyaStateMachineParameter['type']>();
  const parameters = parametersInput.map((entry, index) => {
    const parameterPath = `${path}.parameters[${index}]`;
    const parameter = record(entry, parameterPath);
    knownKeys(parameter, ['name', 'type', 'defaultValue'], parameterPath);
    const name = identifier(parameter.name, `${parameterPath}.name`);
    unique(parameterNames, name, `${parameterPath}.name`, 'parameter');
    const type = oneOf(parameter.type, ['float', 'integer', 'boolean', 'trigger'] as const, `${parameterPath}.type`);
    parameterTypes.set(name, type);
    if (type === 'float') return Object.freeze({ name, type, defaultValue: finite(parameter.defaultValue, `${parameterPath}.defaultValue`) });
    if (type === 'integer') return Object.freeze({ name, type, defaultValue: safeInteger(parameter.defaultValue, `${parameterPath}.defaultValue`) });
    if (type === 'boolean') return Object.freeze({ name, type, defaultValue: booleanValue(parameter.defaultValue, `${parameterPath}.defaultValue`) });
    if (parameter.defaultValue !== undefined) invalid('Trigger parameters do not have a defaultValue.', `${parameterPath}.defaultValue`);
    return Object.freeze({ name, type });
  });

  const layersInput = array(root.layers, `${path}.layers`);
  bounded(layersInput.length, 1, MAX_LAYERS, 'layers', `${path}.layers`);
  const layerIds = new Set<string>();
  let stateCount = 0;
  let transitionCount = 0;
  const layers = layersInput.map((entry, layerIndex) => {
    const layerPath = `${path}.layers[${layerIndex}]`;
    const layer = record(entry, layerPath);
    knownKeys(layer, [
      'id', 'name', 'initialStateId', 'states', 'transitions', 'blendMode', 'weight', 'mask',
    ], layerPath);
    const id = identifier(layer.id, `${layerPath}.id`);
    unique(layerIds, id, `${layerPath}.id`, 'layer');
    const stateInputs = array(layer.states, `${layerPath}.states`);
    bounded(stateInputs.length, 1, MAX_STATES, 'states', `${layerPath}.states`);
    stateCount += stateInputs.length;
    bounded(stateCount, 1, MAX_STATES, 'total states', `${layerPath}.states`);
    const stateIds = new Set<string>();
    const states = stateInputs.map((stateEntry, stateIndex) => {
      const statePath = `${layerPath}.states[${stateIndex}]`;
      const state = record(stateEntry, statePath);
      knownKeys(state, ['id', 'name', 'motion', 'speed', 'speedParameter', 'loop'], statePath);
      const stateId = identifier(state.id, `${statePath}.id`);
      unique(stateIds, stateId, `${statePath}.id`, 'state');
      const speed = state.speed === undefined ? undefined : finite(state.speed, `${statePath}.speed`);
      const speedParameter = state.speedParameter === undefined
        ? undefined
        : numericParameterReference(state.speedParameter, parameterTypes, `${statePath}.speedParameter`);
      return Object.freeze({
        id: stateId,
        name: text(state.name, `${statePath}.name`),
        motion: parseMotion(state.motion, clipIds, parameterTypes, `${statePath}.motion`, 0),
        ...(speed === undefined ? {} : { speed }),
        ...(speedParameter === undefined ? {} : { speedParameter }),
        ...(state.loop === undefined ? {} : { loop: oneOf(state.loop, ['once', 'repeat', 'ping-pong'] as const, `${statePath}.loop`) }),
      });
    });
    const initialStateId = identifier(layer.initialStateId, `${layerPath}.initialStateId`);
    if (!stateIds.has(initialStateId)) invalid(`Unknown initial state "${initialStateId}".`, `${layerPath}.initialStateId`);

    const transitionInputs = array(layer.transitions, `${layerPath}.transitions`);
    transitionCount += transitionInputs.length;
    bounded(transitionCount, 0, MAX_TRANSITIONS, 'total transitions', `${layerPath}.transitions`);
    const transitionIds = new Set<string>();
    const transitions = transitionInputs.map((transitionEntry, transitionIndex) => {
      const transitionPath = `${layerPath}.transitions[${transitionIndex}]`;
      const transition = record(transitionEntry, transitionPath);
      knownKeys(transition, [
        'id', 'from', 'to', 'conditions', 'duration', 'hasExitTime', 'exitTime',
        'destinationOffset', 'interruption',
      ], transitionPath);
      const transitionId = identifier(transition.id, `${transitionPath}.id`);
      unique(transitionIds, transitionId, `${transitionPath}.id`, 'transition');
      const from = transition.from === '*' ? '*' : identifier(transition.from, `${transitionPath}.from`);
      const to = identifier(transition.to, `${transitionPath}.to`);
      if (from !== '*' && !stateIds.has(from)) invalid(`Unknown source state "${from}".`, `${transitionPath}.from`);
      if (!stateIds.has(to)) invalid(`Unknown destination state "${to}".`, `${transitionPath}.to`);
      const conditions = array(transition.conditions, `${transitionPath}.conditions`).map((condition, conditionIndex) => (
        parseCondition(condition, parameterTypes, `${transitionPath}.conditions[${conditionIndex}]`)
      ));
      if (transition.hasExitTime === true && transition.exitTime === undefined) {
        invalid('exitTime is required when hasExitTime is true.', `${transitionPath}.exitTime`);
      }
      const exitTime = transition.exitTime === undefined ? undefined : nonNegative(transition.exitTime, `${transitionPath}.exitTime`);
      const destinationOffset = transition.destinationOffset === undefined
        ? undefined
        : nonNegative(transition.destinationOffset, `${transitionPath}.destinationOffset`);
      return Object.freeze({
        id: transitionId,
        from,
        to,
        conditions: Object.freeze(conditions),
        duration: nonNegative(transition.duration, `${transitionPath}.duration`),
        ...(transition.hasExitTime === undefined ? {} : { hasExitTime: booleanValue(transition.hasExitTime, `${transitionPath}.hasExitTime`) }),
        ...(exitTime === undefined ? {} : { exitTime }),
        ...(destinationOffset === undefined ? {} : { destinationOffset }),
        ...(transition.interruption === undefined ? {} : {
          interruption: oneOf(transition.interruption, [
            'none', 'source', 'destination', 'source-then-destination', 'destination-then-source',
          ] as const, `${transitionPath}.interruption`),
        }),
      });
    });
    const mask = layer.mask === undefined ? undefined : parseMask(layer.mask, `${layerPath}.mask`);
    return Object.freeze({
      id,
      name: text(layer.name, `${layerPath}.name`),
      initialStateId,
      states: Object.freeze(states),
      transitions: Object.freeze(transitions),
      ...(layer.blendMode === undefined ? {} : { blendMode: oneOf(layer.blendMode, ['override', 'additive'] as const, `${layerPath}.blendMode`) }),
      ...(layer.weight === undefined ? {} : { weight: unit(layer.weight, `${layerPath}.weight`) }),
      ...(mask === undefined ? {} : { mask }),
    });
  });

  return Object.freeze({
    format: 'haiyue-animation-state-machine@1',
    id: identifier(root.id, `${path}.id`),
    name: text(root.name, `${path}.name`),
    parameters: Object.freeze(parameters),
    layers: Object.freeze(layers),
  });
}

function parseMotion(
  value: unknown,
  clipIds: ReadonlySet<string>,
  parameterTypes: ReadonlyMap<string, HyaStateMachineParameter['type']>,
  path: string,
  depth: number,
): HyaStateMachineMotion {
  if (depth > MAX_BLEND_DEPTH) invalid(`Blend Tree depth exceeds ${MAX_BLEND_DEPTH}.`, path);
  const motion = record(value, path);
  const kind = oneOf(motion.kind, ['clip', 'blend-1d', 'blend-2d'] as const, `${path}.kind`);
  if (kind === 'clip') {
    knownKeys(motion, ['kind', 'clipId'], path);
    const clipId = identifier(motion.clipId, `${path}.clipId`);
    if (!clipIds.has(clipId)) invalid(`Unknown HYA clip "${clipId}".`, `${path}.clipId`);
    return Object.freeze({ kind, clipId });
  }
  const childInputs = array(motion.children, `${path}.children`);
  bounded(childInputs.length, 1, MAX_BLEND_CHILDREN, 'Blend Tree children', `${path}.children`);
  if (kind === 'blend-1d') {
    knownKeys(motion, ['kind', 'parameter', 'children'], path);
    const parameter = numericParameterReference(motion.parameter, parameterTypes, `${path}.parameter`);
    let previous = -Infinity;
    const children = childInputs.map((entry, index) => {
      const childPath = `${path}.children[${index}]`;
      const child = record(entry, childPath);
      knownKeys(child, ['threshold', 'motion'], childPath);
      const threshold = finite(child.threshold, `${childPath}.threshold`);
      if (threshold <= previous) invalid('Blend-1D thresholds must be strictly increasing.', `${childPath}.threshold`);
      previous = threshold;
      return Object.freeze({ threshold, motion: parseMotion(child.motion, clipIds, parameterTypes, `${childPath}.motion`, depth + 1) });
    });
    return Object.freeze({ kind, parameter, children: Object.freeze(children) });
  }
  const parameterX = numericParameterReference(motion.parameterX, parameterTypes, `${path}.parameterX`);
  const parameterY = numericParameterReference(motion.parameterY, parameterTypes, `${path}.parameterY`);
  knownKeys(motion, ['kind', 'algorithm', 'parameterX', 'parameterY', 'children'], path);
  const children = childInputs.map((entry, index) => {
    const childPath = `${path}.children[${index}]`;
    const child = record(entry, childPath);
    knownKeys(child, ['position', 'motion'], childPath);
    return Object.freeze({
      position: pair(child.position, `${childPath}.position`),
      motion: parseMotion(child.motion, clipIds, parameterTypes, `${childPath}.motion`, depth + 1),
    });
  });
  return Object.freeze({
    kind,
    algorithm: oneOf(motion.algorithm, ['cartesian', 'directional'] as const, `${path}.algorithm`),
    parameterX,
    parameterY,
    children: Object.freeze(children),
  });
}

function parseCondition(
  value: unknown,
  parameterTypes: ReadonlyMap<string, HyaStateMachineParameter['type']>,
  path: string,
): HyaStateMachineCondition {
  const condition = record(value, path);
  knownKeys(condition, ['parameter', 'operator', 'value'], path);
  const parameter = parameterReference(condition.parameter, parameterTypes, `${path}.parameter`);
  const parameterType = parameterTypes.get(parameter)!;
  const operator = oneOf(condition.operator, [
    'greater', 'greater-or-equal', 'less', 'less-or-equal',
    'equal', 'not-equal', 'is-true', 'is-false', 'triggered',
  ] as const, `${path}.operator`);
  const numericOperator = operator === 'greater' || operator === 'greater-or-equal'
    || operator === 'less' || operator === 'less-or-equal';
  if ((parameterType === 'float' || parameterType === 'integer')
    && (numericOperator || operator === 'equal' || operator === 'not-equal')) {
    const value = finite(condition.value, `${path}.value`);
    if (parameterType === 'integer' && !Number.isSafeInteger(value)) {
      invalid('Integer conditions require a safe integer value.', `${path}.value`);
    }
    return Object.freeze({ parameter, operator, value }) as HyaStateMachineCondition;
  }
  if (parameterType === 'boolean'
    && (operator === 'is-true' || operator === 'is-false')) {
    if (condition.value !== undefined) invalid(`Operator "${operator}" does not accept a value.`, `${path}.value`);
    return Object.freeze({ parameter, operator });
  }
  if (parameterType === 'boolean' && (operator === 'equal' || operator === 'not-equal')) {
    return Object.freeze({ parameter, operator, value: booleanValue(condition.value, `${path}.value`) });
  }
  if (parameterType === 'trigger' && operator === 'triggered') {
    if (condition.value !== undefined) invalid('Operator "triggered" does not accept a value.', `${path}.value`);
    return Object.freeze({ parameter, operator });
  }
  invalid(`Operator "${operator}" is invalid for ${parameterType} parameters.`, `${path}.operator`);
}

function parseMask(value: unknown, path: string): HyaStateMachineBindingMask {
  const mask = record(value, path);
  knownKeys(mask, ['include', 'exclude'], path);
  const include = mask.include === undefined ? undefined : stringList(mask.include, `${path}.include`);
  const exclude = mask.exclude === undefined ? undefined : stringList(mask.exclude, `${path}.exclude`);
  return Object.freeze({
    ...(include === undefined ? {} : { include }),
    ...(exclude === undefined ? {} : { exclude }),
  });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object.', path);
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid('Expected an array.', path);
  return value;
}

function identifier(value: unknown, path: string): string {
  const result = text(value, path);
  if (!result.trim()) invalid('Expected a non-empty identifier.', path);
  return result;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid('Expected a string.', path);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid('Expected a finite number.', path);
  return value;
}

function safeInteger(value: unknown, path: string): number {
  const result = finite(value, path);
  if (!Number.isSafeInteger(result)) invalid('Expected a safe integer.', path);
  return result;
}

function nonNegative(value: unknown, path: string): number {
  const result = finite(value, path);
  if (result < 0) invalid('Expected a non-negative number.', path);
  return result;
}

function positive(value: unknown, path: string): number {
  const result = finite(value, path);
  if (result <= 0) invalid('Expected a positive number.', path);
  return result;
}

function unit(value: unknown, path: string): number {
  const result = finite(value, path);
  if (result < 0 || result > 1) invalid('Expected a number in [0, 1].', path);
  return result;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid('Expected a boolean.', path);
  return value;
}

function pair(value: unknown, path: string): readonly [number, number] {
  const values = array(value, path);
  if (values.length !== 2) invalid('Expected two numbers.', path);
  return Object.freeze([finite(values[0], `${path}[0]`), finite(values[1], `${path}[1]`)]) as readonly [number, number];
}

function stringList(value: unknown, path: string): readonly string[] {
  const values = array(value, path);
  const seen = new Set<string>();
  return Object.freeze(values.map((entry, index) => {
    const result = identifier(entry, `${path}[${index}]`);
    unique(seen, result, `${path}[${index}]`, 'mask binding');
    return result;
  }));
}

function parameterReference(
  value: unknown,
  parameters: ReadonlyMap<string, HyaStateMachineParameter['type']>,
  path: string,
): string {
  const result = identifier(value, path);
  if (!parameters.has(result)) invalid(`Unknown state-machine parameter "${result}".`, path);
  return result;
}

function numericParameterReference(
  value: unknown,
  parameters: ReadonlyMap<string, HyaStateMachineParameter['type']>,
  path: string,
): string {
  const result = parameterReference(value, parameters, path);
  const type = parameters.get(result)!;
  if (type !== 'float' && type !== 'integer') {
    invalid(`State-machine parameter "${result}" must be float or integer.`, path);
  }
  return result;
}

function unique(values: Set<string>, value: string, path: string, kind: string): void {
  if (values.has(value)) invalid(`Duplicate ${kind} id "${value}".`, path);
  values.add(value);
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) invalid(`Unknown state-machine property "${key}".`, `${path}.${key}`);
  }
}

function bounded(value: number, minimum: number, maximum: number, label: string, path: string): void {
  if (value < minimum || value > maximum) invalid(`${label} count must be in [${minimum}, ${maximum}].`, path);
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid(`Expected one of ${allowed.join(', ')}.`, path);
  return value as T[number];
}

function invalid(message: string, path: string): never {
  throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', message, path);
}
