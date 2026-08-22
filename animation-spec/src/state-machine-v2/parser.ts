import { isChannelPolicyExecutable } from './channel-policy.js';
import { stateMachineV2Fail } from './diagnostics.js';
import { resolveStateMachineV2Limits, type StateMachineV2Limits } from './limits.js';
import {
  HYA_STATE_MACHINE_V2_EXTENSION_ID,
  HYA_STATE_MACHINE_V2_FORMAT,
  type HyaChannelFamily,
  type HyaChannelPolicy,
  type HyaComparator,
  type HyaMachineInput,
  type HyaStateMachineV2Document,
  type HyaStateMotion,
  type HyaTimelineChannel,
  type TimelineInterpolation,
  type TimelineValue,
  type TimelineValueKind,
} from './types.js';

export interface ParseStateMachineV2Options { readonly limits?: Partial<StateMachineV2Limits> }

interface Totals {
  tracks: number; keyframes: number; inputs: number; layers: number; states: number;
  transitions: number; conditions: number;
}

export function parseHyaStateMachineV2(
  value: unknown,
  options: ParseStateMachineV2Options = {},
): HyaStateMachineV2Document {
  const limits = resolveStateMachineV2Limits(options.limits);
  let cloned: unknown;
  try { cloned = structuredClone(value); } catch { fail('E_STATE_MACHINE_V2_FORMAT', '$', 'document must be structured-cloneable data'); }
  const root = object(cloned, '$');
  keys(root, ['format', 'extension', 'channels', 'clips', 'stateMachines', 'components'], '$');
  literal(root.format, HYA_STATE_MACHINE_V2_FORMAT, '$.format');
  literal(root.extension, HYA_STATE_MACHINE_V2_EXTENSION_ID, '$.extension');

  const channelValues = array(root.channels, '$.channels');
  bounded(channelValues.length, limits.maxChannels, '$.channels');
  const channelIds = new Set<string>();
  const channels = new Map<string, HyaTimelineChannel>();
  channelValues.forEach((entry, index) => {
    const path = `$.channels[${index}]`, channel = object(entry, path);
    keys(channel, ['id', 'target', 'path', 'family', 'valueKind', 'valueSize', 'numericMode', 'defaultValue', 'policy', 'effectKind'], path);
    const id = uniqueIdentifier(channel.id, channelIds, `${path}.id`);
    const family = enumeration(channel.family, ['transform', 'paint-path', 'rig', 'text-layout', 'resource-data', 'visibility-order', 'event-audio-script'] as const, `${path}.family`);
    const valueKind = enumeration(channel.valueKind, ['number', 'vector', 'color', 'boolean', 'string', 'id', 'integer', 'unsigned', 'callback'] as const, `${path}.valueKind`);
    const policy = enumeration(channel.policy, ['override', 'additive', 'discrete', 'ownership'] as const, `${path}.policy`);
    if (!isChannelPolicyExecutable(family, valueKind, policy)) fail('E_STATE_MACHINE_V2_POLICY', path, `${family}/${valueKind}/${policy} has no executable policy`);
    const valueSize = validateValueSize(channel.valueSize, valueKind, `${path}.valueSize`);
    if (channel.numericMode !== undefined) { const mode = enumeration(channel.numericMode, ['linear', 'angle-radians'] as const, `${path}.numericMode`); if (mode === 'angle-radians' && (valueKind !== 'number' || family !== 'transform' && family !== 'rig')) fail('E_STATE_MACHINE_V2_POLICY', `${path}.numericMode`, 'angle-radians requires a scalar transform or rig channel'); }
    if (channel.defaultValue !== undefined) validateTimelineValue(channel.defaultValue, valueKind, valueSize, `${path}.defaultValue`, limits);
    if (valueKind === 'callback') {
      if (channel.effectKind === undefined) fail('E_STATE_MACHINE_V2_POLICY', `${path}.effectKind`, 'callback channel requires event, audio, or script effectKind');
      enumeration(channel.effectKind, ['event', 'audio', 'script'] as const, `${path}.effectKind`);
    } else if (channel.effectKind !== undefined) fail('E_STATE_MACHINE_V2_POLICY', `${path}.effectKind`, 'effectKind is only valid for callback channels');
    identifier(channel.target, `${path}.target`); identifier(channel.path, `${path}.path`);
    channels.set(id, channel as unknown as HyaTimelineChannel);
  });

  const totals: Totals = { tracks: 0, keyframes: 0, inputs: 0, layers: 0, states: 0, transitions: 0, conditions: 0 };
  const clipValues = array(root.clips, '$.clips'); bounded(clipValues.length, limits.maxClips, '$.clips');
  const clipIds = new Set<string>();
  clipValues.forEach((entry, clipIndex) => {
    const path = `$.clips[${clipIndex}]`, clip = object(entry, path);
    keys(clip, ['id', 'name', 'duration', 'fps', 'quantize', 'workArea', 'tracks'], path);
    uniqueIdentifier(clip.id, clipIds, `${path}.id`); optionalString(clip.name, `${path}.name`, limits);
    const duration = nonNegative(clip.duration, `${path}.duration`);
    if (clip.fps !== undefined) positive(clip.fps, `${path}.fps`);
    optionalBoolean(clip.quantize, `${path}.quantize`);
    if (clip.workArea !== undefined) {
      const work = object(clip.workArea, `${path}.workArea`); keys(work, ['start', 'end'], `${path}.workArea`);
      const start = nonNegative(work.start, `${path}.workArea.start`), end = nonNegative(work.end, `${path}.workArea.end`);
      if (end < start || end > duration) fail('E_STATE_MACHINE_V2_NUMBER', `${path}.workArea`, 'work area must be ordered inside clip duration');
    }
    const trackValues = array(clip.tracks, `${path}.tracks`); totals.tracks += trackValues.length; bounded(totals.tracks, limits.maxTracks, `${path}.tracks`);
    const trackIds = new Set<string>(), usedChannels = new Set<string>();
    trackValues.forEach((trackEntry, trackIndex) => {
      const trackPath = `${path}.tracks[${trackIndex}]`, track = object(trackEntry, trackPath);
      keys(track, ['id', 'channel', 'keys'], trackPath); uniqueIdentifier(track.id, trackIds, `${trackPath}.id`);
      const channelId = reference(track.channel, channels, `${trackPath}.channel`);
      if (usedChannels.has(channelId)) fail('E_STATE_MACHINE_V2_REFERENCE', `${trackPath}.channel`, `clip has two tracks for channel ${channelId}`);
      usedChannels.add(channelId);
      const channel = channels.get(channelId)!;
      const keyValues = array(track.keys, `${trackPath}.keys`);
      if (keyValues.length === 0) fail('E_STATE_MACHINE_V2_FORMAT', `${trackPath}.keys`, 'track requires at least one key');
      totals.keyframes += keyValues.length; bounded(totals.keyframes, limits.maxKeyframes, `${trackPath}.keys`);
      let prior = -Infinity;
      keyValues.forEach((keyEntry, keyIndex) => {
        const keyPath = `${trackPath}.keys[${keyIndex}]`, key = object(keyEntry, keyPath);
        keys(key, ['time', 'value', 'interpolation'], keyPath);
        const time = nonNegative(key.time, `${keyPath}.time`);
        if (time <= prior || time > duration) fail('E_STATE_MACHINE_V2_NUMBER', `${keyPath}.time`, 'key times must be strictly increasing and inside clip duration');
        prior = time;
        validateTimelineValue(key.value, channel.valueKind, channel.valueSize, `${keyPath}.value`, limits);
        if (keyIndex === keyValues.length - 1 && key.interpolation !== undefined) fail('E_STATE_MACHINE_V2_FORMAT', `${keyPath}.interpolation`, 'final key cannot declare outgoing interpolation');
        if (key.interpolation !== undefined) validateInterpolation(key.interpolation, channel, `${keyPath}.interpolation`);
      });
    });
  });

  const machineValues = array(root.stateMachines, '$.stateMachines'); bounded(machineValues.length, limits.maxStateMachines, '$.stateMachines');
  const machineIds = new Set<string>();
  machineValues.forEach((entry, machineIndex) => {
    const path = `$.stateMachines[${machineIndex}]`, machine = object(entry, path);
    keys(machine, ['id', 'inputs', 'layers'], path); uniqueIdentifier(machine.id, machineIds, `${path}.id`);
    const inputValues = array(machine.inputs, `${path}.inputs`); totals.inputs += inputValues.length; bounded(totals.inputs, limits.maxInputs, `${path}.inputs`);
    const inputs = new Map<string, HyaMachineInput['type']>();
    inputValues.forEach((inputEntry, inputIndex) => {
      const inputPath = `${path}.inputs[${inputIndex}]`, input = object(inputEntry, inputPath);
      keys(input, ['id', 'type', 'defaultValue'], inputPath);
      const id = uniqueIdentifier(input.id, new Set(inputs.keys()), `${inputPath}.id`);
      const type = enumeration(input.type, ['number', 'integer', 'boolean', 'trigger'] as const, `${inputPath}.type`); inputs.set(id, type);
      if (type === 'trigger') { if (input.defaultValue !== undefined) fail('E_STATE_MACHINE_V2_FORMAT', `${inputPath}.defaultValue`, 'trigger has no default value'); }
      else if (type === 'boolean') boolean(input.defaultValue, `${inputPath}.defaultValue`);
      else if (type === 'integer') safeInteger(input.defaultValue, `${inputPath}.defaultValue`);
      else finite(input.defaultValue, `${inputPath}.defaultValue`);
    });
    const layerValues = array(machine.layers, `${path}.layers`); if (layerValues.length === 0) fail('E_STATE_MACHINE_V2_GRAPH', `${path}.layers`, 'state machine requires a layer');
    totals.layers += layerValues.length; bounded(totals.layers, limits.maxLayers, `${path}.layers`);
    const layerIds = new Set<string>(), orders = new Set<number>();
    layerValues.forEach((layerEntry, layerIndex) => validateLayer(layerEntry, `${path}.layers[${layerIndex}]`, inputs, channels, clipIds, limits, totals, layerIds, orders));
  });

  const componentValues = root.components === undefined ? [] : array(root.components, '$.components'); bounded(componentValues.length, limits.maxComponents, '$.components');
  const componentIds = new Set<string>();
  componentValues.forEach((entry, index) => {
    const path = `$.components[${index}]`, component = object(entry, path);
    keys(component, ['id', 'target', 'source', 'playback', 'exposedInputs', 'exposedEvents'], path);
    uniqueIdentifier(component.id, componentIds, `${path}.id`); identifier(component.target, `${path}.target`);
    const source = object(component.source, `${path}.source`), kind = enumeration(source.kind, ['clip', 'state-machine'] as const, `${path}.source.kind`);
    keys(source, kind === 'clip' ? ['kind', 'clip'] : ['kind', 'machine'], `${path}.source`);
    if (kind === 'clip') reference(source.clip, clipIds, `${path}.source.clip`); else reference(source.machine, machineIds, `${path}.source.machine`);
    const playback = enumeration(component.playback, ['simple', 'remap', 'mix', 'state-machine'] as const, `${path}.playback`);
    if (playback === 'state-machine' && kind !== 'state-machine') fail('E_STATE_MACHINE_V2_GRAPH', `${path}.playback`, 'state-machine playback requires a state-machine source');
    stringList(component.exposedInputs, `${path}.exposedInputs`, limits); stringList(component.exposedEvents, `${path}.exposedEvents`, limits);
  });

  validateNestedReferences(machineValues, componentValues, componentIds, limits);
  return deepFreeze(root) as unknown as HyaStateMachineV2Document;
}

function validateLayer(value: unknown, path: string, inputs: ReadonlyMap<string, HyaMachineInput['type']>, channels: ReadonlyMap<string, HyaTimelineChannel>, clipIds: ReadonlySet<string>, limits: StateMachineV2Limits, totals: Totals, layerIds: Set<string>, orders: Set<number>): void {
  const layer = object(value, path); keys(layer, ['id', 'order', 'weight', 'weightInput', 'mode', 'mask', 'states', 'transitions'], path);
  uniqueIdentifier(layer.id, layerIds, `${path}.id`); const order = safeInteger(layer.order, `${path}.order`);
  if (orders.has(order)) fail('E_STATE_MACHINE_V2_GRAPH', `${path}.order`, `duplicate layer order ${order}`); orders.add(order);
  if (layer.weight !== undefined) unit(layer.weight, `${path}.weight`);
  if (layer.weightInput !== undefined) numericInput(layer.weightInput, inputs, `${path}.weightInput`);
  if (layer.mode !== undefined) enumeration(layer.mode, ['override', 'additive'] as const, `${path}.mode`);
  validateMask(layer.mask, `${path}.mask`);
  const stateValues = array(layer.states, `${path}.states`); if (stateValues.length === 0) fail('E_STATE_MACHINE_V2_GRAPH', `${path}.states`, 'layer requires a state');
  totals.states += stateValues.length; bounded(totals.states, limits.maxStates, `${path}.states`);
  const stateIds = new Set<string>();
  stateValues.forEach((entry, index) => {
    const statePath = `${path}.states[${index}]`, state = object(entry, statePath);
    keys(state, ['id', 'motion', 'entryEffects', 'exitEffects'], statePath); uniqueIdentifier(state.id, stateIds, `${statePath}.id`);
    validateMotion(state.motion, `${statePath}.motion`, inputs, clipIds, limits, 1);
    validateEffects(state.entryEffects, `${statePath}.entryEffects`, channels, limits); validateEffects(state.exitEffects, `${statePath}.exitEffects`, channels, limits);
  });
  const transitionValues = array(layer.transitions, `${path}.transitions`); totals.transitions += transitionValues.length; bounded(totals.transitions, limits.maxTransitions, `${path}.transitions`);
  const transitionIds = new Set<string>(); let entryTransitions = 0;
  transitionValues.forEach((entry, index) => {
    const transitionPath = `${path}.transitions[${index}]`, transition = object(entry, transitionPath);
    keys(transition, ['id', 'from', 'to', 'conditionGroups', 'exitTime', 'randomWeight', 'pauseWhenExiting', 'duration', 'destinationOffset', 'interruption', 'exitMotion', 'interpolation', 'effects'], transitionPath);
    uniqueIdentifier(transition.id, transitionIds, `${transitionPath}.id`);
    const from = endpoint(transition.from, `${transitionPath}.from`), to = endpoint(transition.to, `${transitionPath}.to`);
    if (from === '@entry') entryTransitions++; if (from === '@exit') fail('E_STATE_MACHINE_V2_GRAPH', `${transitionPath}.from`, 'exit cannot be a transition source');
    if (to === '@entry' || to === '@any') fail('E_STATE_MACHINE_V2_GRAPH', `${transitionPath}.to`, `${to} cannot be a transition destination`);
    if (!from.startsWith('@') && !stateIds.has(from)) fail('E_STATE_MACHINE_V2_REFERENCE', `${transitionPath}.from`, `unknown state ${from}`);
    if (!to.startsWith('@') && !stateIds.has(to)) fail('E_STATE_MACHINE_V2_REFERENCE', `${transitionPath}.to`, `unknown state ${to}`);
    if (from === '@entry' && (to === '@exit' || array(transition.conditionGroups, `${transitionPath}.conditionGroups`).length !== 0)) fail('E_STATE_MACHINE_V2_GRAPH', transitionPath, 'entry transition must be unconditional and target a state');
    const groups = array(transition.conditionGroups, `${transitionPath}.conditionGroups`);
    groups.forEach((groupValue, groupIndex) => {
      const group = array(groupValue, `${transitionPath}.conditionGroups[${groupIndex}]`); if (group.length === 0) fail('E_STATE_MACHINE_V2_GRAPH', `${transitionPath}.conditionGroups[${groupIndex}]`, 'OR group cannot be empty');
      totals.conditions += group.length; bounded(totals.conditions, limits.maxConditionTerms, `${transitionPath}.conditionGroups`);
      group.forEach((condition, conditionIndex) => validateCondition(condition, `${transitionPath}.conditionGroups[${groupIndex}][${conditionIndex}]`, inputs, limits));
    });
    if (transition.exitTime !== undefined) nonNegative(transition.exitTime, `${transitionPath}.exitTime`);
    if (transition.randomWeight !== undefined) unit(transition.randomWeight, `${transitionPath}.randomWeight`);
    optionalBoolean(transition.pauseWhenExiting, `${transitionPath}.pauseWhenExiting`); nonNegative(transition.duration, `${transitionPath}.duration`);
    if (transition.destinationOffset !== undefined) nonNegative(transition.destinationOffset, `${transitionPath}.destinationOffset`);
    if (transition.interruption !== undefined) enumeration(transition.interruption, ['none', 'source', 'destination', 'source-then-destination', 'destination-then-source'] as const, `${transitionPath}.interruption`);
    if (transition.exitMotion !== undefined) validateMotion(transition.exitMotion, `${transitionPath}.exitMotion`, inputs, clipIds, limits, 1);
    if (transition.interpolation !== undefined) validateInterpolationShape(transition.interpolation, 1, `${transitionPath}.interpolation`);
    validateEffects(transition.effects, `${transitionPath}.effects`, channels, limits);
  });
  if (entryTransitions !== 1) fail('E_STATE_MACHINE_V2_GRAPH', `${path}.transitions`, `layer requires exactly one @entry transition; received ${entryTransitions}`);
}

function validateMotion(value: unknown, path: string, inputs: ReadonlyMap<string, HyaMachineInput['type']>, clipIds: ReadonlySet<string>, limits: StateMachineV2Limits, depth: number): void {
  if (depth > limits.maxMotionDepth) fail('E_STATE_MACHINE_V2_LIMIT', path, `motion depth exceeds ${limits.maxMotionDepth}`);
  const motion = object(value, path), kind = enumeration(motion.kind, ['clip', 'blend-1d', 'blend-2d', 'blend-additive', 'nested'] as const, `${path}.kind`);
  if (kind === 'clip') {
    keys(motion, ['kind', 'clip', 'speed', 'speedInput', 'playback', 'timeRemapInput'], path); reference(motion.clip, clipIds, `${path}.clip`);
    if (motion.speed !== undefined) finite(motion.speed, `${path}.speed`); if (motion.speedInput !== undefined) numericInput(motion.speedInput, inputs, `${path}.speedInput`);
    if (motion.playback !== undefined) enumeration(motion.playback, ['one-shot', 'loop', 'ping-pong'] as const, `${path}.playback`);
    if (motion.timeRemapInput !== undefined) numericInput(motion.timeRemapInput, inputs, `${path}.timeRemapInput`); return;
  }
  if (kind === 'blend-1d') {
    keys(motion, ['kind', 'input', 'children'], path); numericInput(motion.input, inputs, `${path}.input`);
    const children = nonEmptyArray(motion.children, `${path}.children`); let prior = -Infinity;
    children.forEach((entry, index) => { const childPath = `${path}.children[${index}]`, child = object(entry, childPath); keys(child, ['threshold', 'motion'], childPath); const threshold = finite(child.threshold, `${childPath}.threshold`); if (threshold <= prior) fail('E_STATE_MACHINE_V2_GRAPH', `${childPath}.threshold`, 'thresholds must be strictly increasing'); prior = threshold; validateMotion(child.motion, `${childPath}.motion`, inputs, clipIds, limits, depth + 1); }); return;
  }
  if (kind === 'blend-2d') {
    keys(motion, ['kind', 'algorithm', 'inputX', 'inputY', 'children'], path); enumeration(motion.algorithm, ['cartesian', 'directional'] as const, `${path}.algorithm`); numericInput(motion.inputX, inputs, `${path}.inputX`); numericInput(motion.inputY, inputs, `${path}.inputY`);
    nonEmptyArray(motion.children, `${path}.children`).forEach((entry, index) => { const childPath = `${path}.children[${index}]`, child = object(entry, childPath); keys(child, ['position', 'motion'], childPath); tuple(child.position, 2, `${childPath}.position`); validateMotion(child.motion, `${childPath}.motion`, inputs, clipIds, limits, depth + 1); }); return;
  }
  if (kind === 'blend-additive') {
    keys(motion, ['kind', 'base', 'children'], path); validateMotion(motion.base, `${path}.base`, inputs, clipIds, limits, depth + 1);
    nonEmptyArray(motion.children, `${path}.children`).forEach((entry, index) => { const childPath = `${path}.children[${index}]`, child = object(entry, childPath); keys(child, ['motion', 'weight', 'weightInput'], childPath); if (child.weight === undefined && child.weightInput === undefined) fail('E_STATE_MACHINE_V2_FORMAT', childPath, 'additive child requires weight or weightInput'); if (child.weight !== undefined) unit(child.weight, `${childPath}.weight`); if (child.weightInput !== undefined) numericInput(child.weightInput, inputs, `${childPath}.weightInput`); validateMotion(child.motion, `${childPath}.motion`, inputs, clipIds, limits, depth + 1); }); return;
  }
  keys(motion, ['kind', 'component', 'speed', 'timeRemapInput', 'mixInput', 'playingInput', 'inputBindings'], path); identifier(motion.component, `${path}.component`);
  if (motion.speed !== undefined) finite(motion.speed, `${path}.speed`); if (motion.timeRemapInput !== undefined) numericInput(motion.timeRemapInput, inputs, `${path}.timeRemapInput`);
  if (motion.mixInput !== undefined) numericInput(motion.mixInput, inputs, `${path}.mixInput`); if (motion.playingInput !== undefined) { const input = inputReference(motion.playingInput, inputs, `${path}.playingInput`); if (inputs.get(input) !== 'boolean') fail('E_STATE_MACHINE_V2_GRAPH', `${path}.playingInput`, 'playingInput must be boolean'); }
  if (motion.inputBindings !== undefined) for (const [port, input] of Object.entries(object(motion.inputBindings, `${path}.inputBindings`))) { identifier(port, `${path}.inputBindings.${port}`); inputReference(input, inputs, `${path}.inputBindings.${port}`); }
}

function validateCondition(value: unknown, path: string, inputs: ReadonlyMap<string, HyaMachineInput['type']>, limits: StateMachineV2Limits): void {
  const condition = object(value, path), kind = enumeration(condition.kind, ['input', 'trigger', 'observable', 'custom'] as const, `${path}.kind`);
  if (kind === 'trigger') { keys(condition, ['kind', 'input'], path); const input = inputReference(condition.input, inputs, `${path}.input`); if (inputs.get(input) !== 'trigger') fail('E_STATE_MACHINE_V2_GRAPH', `${path}.input`, 'trigger condition requires trigger input'); return; }
  if (kind === 'input') { keys(condition, ['kind', 'input', 'comparator', 'value'], path); const input = inputReference(condition.input, inputs, `${path}.input`), type = inputs.get(input)!; if (type === 'trigger') fail('E_STATE_MACHINE_V2_GRAPH', `${path}.input`, 'trigger input requires trigger condition'); const comparator = comparatorValue(condition.comparator, `${path}.comparator`); validateComparison(type, comparator, condition.value, `${path}.value`); return; }
  keys(condition, kind === 'observable' ? ['kind', 'protocol', 'port', 'comparator', 'value', 'arguments'] : ['kind', 'protocol', 'port', 'arguments'], path);
  identifier(condition.protocol, `${path}.protocol`); identifier(condition.port, `${path}.port`); validateArguments(condition.arguments, `${path}.arguments`, limits);
  if (kind === 'observable') { comparatorValue(condition.comparator, `${path}.comparator`); validateGenericValue(condition.value, `${path}.value`); }
}

function validateInterpolation(value: unknown, channel: HyaTimelineChannel, path: string): void {
  const numeric = channel.valueKind === 'number' || channel.valueKind === 'vector' || channel.valueKind === 'color';
  const interpolation = object(value, path), kind = enumeration(interpolation.kind, ['linear', 'hold', 'cubic-ease', 'cubic-value', 'elastic'] as const, `${path}.kind`);
  if (!numeric && kind !== 'hold') fail('E_STATE_MACHINE_V2_POLICY', path, `${channel.valueKind} keys require hold interpolation`);
  validateInterpolationShape(value, channel.valueSize ?? 1, path);
}

function validateInterpolationShape(value: unknown, valueSize: number, path: string): TimelineInterpolation {
  const interpolation = object(value, path), kind = enumeration(interpolation.kind, ['linear', 'hold', 'cubic-ease', 'cubic-value', 'elastic'] as const, `${path}.kind`);
  if (kind === 'linear' || kind === 'hold') keys(interpolation, ['kind'], path);
  else if (kind === 'cubic-ease') { keys(interpolation, ['kind', 'controls'], path); const controls = tuple(interpolation.controls, 4, `${path}.controls`); if (controls[0]! < 0 || controls[0]! > 1 || controls[2]! < 0 || controls[2]! > 1) fail('E_STATE_MACHINE_V2_NUMBER', `${path}.controls`, 'cubic easing x controls must be in [0, 1]'); }
  else if (kind === 'cubic-value') {
    keys(interpolation, ['kind', 'outTangent', 'inTangent'], path);
    tuple(interpolation.outTangent, valueSize, `${path}.outTangent`);
    tuple(interpolation.inTangent, valueSize, `${path}.inTangent`);
  }
  else { keys(interpolation, ['kind', 'easing', 'amplitude', 'period'], path); enumeration(interpolation.easing, ['in', 'out', 'in-out'] as const, `${path}.easing`); nonNegative(interpolation.amplitude, `${path}.amplitude`); positive(interpolation.period, `${path}.period`); }
  return interpolation as unknown as TimelineInterpolation;
}

function validateValueSize(value: unknown, kind: TimelineValueKind, path: string): number | undefined {
  const requires = kind === 'vector' || kind === 'color';
  if (!requires) { if (value !== undefined) fail('E_STATE_MACHINE_V2_FORMAT', path, `${kind} channel cannot declare valueSize`); return undefined; }
  const size = safeInteger(value, path); if (size < 1 || (kind === 'color' && size !== 4)) fail('E_STATE_MACHINE_V2_NUMBER', path, kind === 'color' ? 'color valueSize must be 4' : 'valueSize must be positive'); return size;
}

function validateTimelineValue(value: unknown, kind: TimelineValueKind, size: number | undefined, path: string, limits: StateMachineV2Limits): asserts value is TimelineValue {
  if (kind === 'callback') { validatePayload(value, path, limits); if (Array.isArray(value) || typeof value === 'number' || typeof value === 'boolean') fail('E_STATE_MACHINE_V2_FORMAT', path, 'callback value must be null, string, or record'); return; }
  if (kind === 'number') { finite(value, path); return; } if (kind === 'integer') { safeInteger(value, path); return; }
  if (kind === 'unsigned') { const result = safeInteger(value, path); if (result < 0) fail('E_STATE_MACHINE_V2_NUMBER', path, 'unsigned value must be non-negative'); return; }
  if (kind === 'boolean') { boolean(value, path); return; } if (kind === 'string' || kind === 'id') { const result = string(value, path); if (result.length > limits.maxStringLength) fail('E_STATE_MACHINE_V2_LIMIT', path, 'string exceeds limit'); return; }
  tuple(value, size!, path); if (kind === 'color') for (const [index, component] of (value as number[]).entries()) if (component < 0 || component > 1) fail('E_STATE_MACHINE_V2_NUMBER', `${path}[${index}]`, 'color component must be in [0, 1]');
}

function validateComparison(type: Exclude<HyaMachineInput['type'], 'trigger'>, comparator: HyaComparator, value: unknown, path: string): void {
  if (type === 'boolean') { if (comparator !== 'equal' && comparator !== 'not-equal') fail('E_STATE_MACHINE_V2_GRAPH', path, 'boolean input only supports equality comparators'); boolean(value, path); }
  else if (type === 'integer') safeInteger(value, path); else finite(value, path);
}
function validateGenericValue(value: unknown, path: string): void { if (value === null || typeof value === 'boolean' || typeof value === 'string') return; if (typeof value === 'number') { finite(value, path); return; } if (Array.isArray(value)) { value.forEach((entry, index) => finite(entry, `${path}[${index}]`)); return; } fail('E_STATE_MACHINE_V2_FORMAT', path, 'unsupported comparison value'); }
function validateArguments(value: unknown, path: string, limits: StateMachineV2Limits): void { if (value === undefined) return; for (const [name, entry] of Object.entries(object(value, path))) { identifier(name, `${path}.${name}`); if (typeof entry === 'string' && entry.length > limits.maxStringLength) fail('E_STATE_MACHINE_V2_LIMIT', `${path}.${name}`, 'argument string exceeds limit'); validateGenericValue(entry, `${path}.${name}`); } }
function validateEffects(value: unknown, path: string, channels: ReadonlyMap<string, HyaTimelineChannel>, limits: StateMachineV2Limits): void { if (value === undefined) return; array(value, path).forEach((entry, index) => { const effectPath = `${path}[${index}]`, effect = object(entry, effectPath); keys(effect, ['channel', 'phase', 'payload'], effectPath); const channel = channels.get(reference(effect.channel, channels, `${effectPath}.channel`))!; if (channel.valueKind !== 'callback' || channel.policy !== 'ownership') fail('E_STATE_MACHINE_V2_POLICY', `${effectPath}.channel`, 'transition effect requires callback ownership channel'); enumeration(effect.phase, ['start', 'complete'] as const, `${effectPath}.phase`); if (effect.payload !== undefined) validatePayload(effect.payload, `${effectPath}.payload`, limits); }); }
function validatePayload(value: unknown, path: string, limits: StateMachineV2Limits, depth = 0, seen = new Set<object>()): void { if (depth > limits.maxMotionDepth) fail('E_STATE_MACHINE_V2_LIMIT', path, 'payload depth exceeds limit'); if (value === null || typeof value === 'boolean') return; if (typeof value === 'number') { finite(value, path); return; } if (typeof value === 'string') { if (value.length > limits.maxStringLength) fail('E_STATE_MACHINE_V2_LIMIT', path, 'payload string exceeds limit'); return; } if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) fail('E_STATE_MACHINE_V2_FORMAT', path, 'payload must contain JSON-compatible values'); if (seen.has(value)) fail('E_STATE_MACHINE_V2_FORMAT', path, 'payload cycle is not allowed'); seen.add(value); if (Array.isArray(value)) value.forEach((entry, index) => validatePayload(entry, `${path}[${index}]`, limits, depth + 1, seen)); else for (const [key, entry] of Object.entries(value)) { identifier(key, `${path}.${key}`); validatePayload(entry, `${path}.${key}`, limits, depth + 1, seen); } seen.delete(value); }
function validateMask(value: unknown, path: string): void { if (value === undefined) return; const mask = object(value, path); keys(mask, ['include', 'exclude'], path); stringList(mask.include, `${path}.include`); stringList(mask.exclude, `${path}.exclude`); }
function validateNestedReferences(machineValues: unknown[], componentValues: unknown[], componentIds: ReadonlySet<string>, limits: StateMachineV2Limits): void {
  const edges = new Map<string, { to: string; path: string }[]>(), add = (from: string, to: string, path: string): void => { const list = edges.get(from) ?? []; list.push({ to, path }); edges.set(from, list); };
  const visit = (motionValue: unknown, path: string, machineNode: string): void => { const motion = object(motionValue, path); if (motion.kind === 'nested') { const component = String(motion.component); if (!componentIds.has(component)) fail('E_STATE_MACHINE_V2_REFERENCE', `${path}.component`, `unknown component ${component}`); add(machineNode, `component:${component}`, `${path}.component`); } if (motion.kind === 'blend-1d' || motion.kind === 'blend-2d') array(motion.children, `${path}.children`).forEach((child, index) => visit(object(child, `${path}.children[${index}]`).motion, `${path}.children[${index}].motion`, machineNode)); else if (motion.kind === 'blend-additive') { visit(motion.base, `${path}.base`, machineNode); array(motion.children, `${path}.children`).forEach((child, index) => visit(object(child, `${path}.children[${index}]`).motion, `${path}.children[${index}].motion`, machineNode)); } };
  machineValues.forEach((machineValue, machineIndex) => {
    const machine = object(machineValue, `$.stateMachines[${machineIndex}]`), machineNode = `machine:${String(machine.id)}`; edges.set(machineNode, edges.get(machineNode) ?? []);
    array(machine.layers, `$.stateMachines[${machineIndex}].layers`).forEach((layerValue, layerIndex) => {
      const layer = object(layerValue, '$layer');
      array(layer.states, '$layer.states').forEach((stateValue, stateIndex) => visit(object(stateValue, '$state').motion, `$.stateMachines[${machineIndex}].layers[${layerIndex}].states[${stateIndex}].motion`, machineNode));
      array(layer.transitions, '$layer.transitions').forEach((transitionValue, transitionIndex) => { const transition = object(transitionValue, '$transition'); if (transition.exitMotion !== undefined) visit(transition.exitMotion, `$.stateMachines[${machineIndex}].layers[${layerIndex}].transitions[${transitionIndex}].exitMotion`, machineNode); });
    });
  });
  componentValues.forEach((componentValue, index) => { const component = object(componentValue, `$.components[${index}]`), node = `component:${String(component.id)}`, source = object(component.source, `$.components[${index}].source`); edges.set(node, edges.get(node) ?? []); if (source.kind === 'state-machine') add(node, `machine:${String(source.machine)}`, `$.components[${index}].source.machine`); });
  const visiting = new Set<string>(), visited = new Set<string>(); const walk = (node: string, depth: number, path: string): void => { if (depth > limits.maxMotionDepth) fail('E_STATE_MACHINE_V2_LIMIT', path, `nested graph depth exceeds ${limits.maxMotionDepth}`); if (visiting.has(node)) fail('E_STATE_MACHINE_V2_GRAPH', path, `nested component cycle includes ${node}`); if (visited.has(node)) return; visiting.add(node); for (const edge of edges.get(node) ?? []) walk(edge.to, depth + 1, edge.path); visiting.delete(node); visited.add(node); }; for (const node of edges.keys()) walk(node, 1, '$.components');
}

function comparatorValue(value: unknown, path: string): HyaComparator { return enumeration(value, ['equal', 'not-equal', 'greater', 'greater-or-equal', 'less', 'less-or-equal'] as const, path); }
function endpoint(value: unknown, path: string): string { const result = identifier(value, path); if (result.startsWith('@') && result !== '@entry' && result !== '@any' && result !== '@exit') fail('E_STATE_MACHINE_V2_GRAPH', path, `unknown pseudo state ${result}`); return result; }
function numericInput(value: unknown, inputs: ReadonlyMap<string, HyaMachineInput['type']>, path: string): string { const id = inputReference(value, inputs, path), type = inputs.get(id); if (type !== 'number' && type !== 'integer') fail('E_STATE_MACHINE_V2_GRAPH', path, `input ${id} must be numeric`); return id; }
function inputReference(value: unknown, inputs: ReadonlyMap<string, HyaMachineInput['type']>, path: string): string { return reference(value, inputs, path); }
function reference<T>(value: unknown, values: ReadonlyMap<string, T> | ReadonlySet<string>, path: string): string { const id = identifier(value, path); if (!values.has(id)) fail('E_STATE_MACHINE_V2_REFERENCE', path, `unknown reference ${id}`); return id; }
function uniqueIdentifier(value: unknown, values: Set<string>, path: string): string { const id = identifier(value, path); if (values.has(id)) fail('E_STATE_MACHINE_V2_REFERENCE', path, `duplicate id ${id}`); values.add(id); return id; }
function identifier(value: unknown, path: string): string { const result = string(value, path); if (result.length === 0 || result.length > 1024) fail('E_STATE_MACHINE_V2_FORMAT', path, 'identifier length must be 1..1024'); return result; }
function stringList(value: unknown, path: string, limits?: StateMachineV2Limits): void { if (value === undefined) return; const seen = new Set<string>(); array(value, path).forEach((entry, index) => { const id = uniqueIdentifier(entry, seen, `${path}[${index}]`); if (limits && id.length > limits.maxStringLength) fail('E_STATE_MACHINE_V2_LIMIT', `${path}[${index}]`, 'string exceeds limit'); }); }
function optionalString(value: unknown, path: string, limits: StateMachineV2Limits): void { if (value === undefined) return; const result = string(value, path); if (result.length > limits.maxStringLength) fail('E_STATE_MACHINE_V2_LIMIT', path, 'string exceeds limit'); }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value); }
function object(value: unknown, path: string): Record<string, unknown> { if (!isPlainRecord(value)) fail('E_STATE_MACHINE_V2_FORMAT', path, 'expected object'); return value; }
function array(value: unknown, path: string): unknown[] { if (!Array.isArray(value)) fail('E_STATE_MACHINE_V2_FORMAT', path, 'expected array'); return value; }
function nonEmptyArray(value: unknown, path: string): unknown[] { const result = array(value, path); if (result.length === 0) fail('E_STATE_MACHINE_V2_GRAPH', path, 'expected a non-empty array'); return result; }
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('E_STATE_MACHINE_V2_FORMAT', `${path}.${key}`, 'unknown property'); }
function string(value: unknown, path: string): string { if (typeof value !== 'string') fail('E_STATE_MACHINE_V2_FORMAT', path, 'expected string'); return value; }
function finite(value: unknown, path: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) fail('E_STATE_MACHINE_V2_NUMBER', path, 'expected finite number'); return value; }
function safeInteger(value: unknown, path: string): number { const result = finite(value, path); if (!Number.isSafeInteger(result)) fail('E_STATE_MACHINE_V2_NUMBER', path, 'expected safe integer'); return result; }
function nonNegative(value: unknown, path: string): number { const result = finite(value, path); if (result < 0) fail('E_STATE_MACHINE_V2_NUMBER', path, 'expected non-negative number'); return result; }
function positive(value: unknown, path: string): number { const result = finite(value, path); if (result <= 0) fail('E_STATE_MACHINE_V2_NUMBER', path, 'expected positive number'); return result; }
function unit(value: unknown, path: string): number { const result = finite(value, path); if (result < 0 || result > 1) fail('E_STATE_MACHINE_V2_NUMBER', path, 'expected number in [0, 1]'); return result; }
function boolean(value: unknown, path: string): boolean { if (typeof value !== 'boolean') fail('E_STATE_MACHINE_V2_FORMAT', path, 'expected boolean'); return value; }
function optionalBoolean(value: unknown, path: string): void { if (value !== undefined) boolean(value, path); }
function tuple(value: unknown, length: number, path: string): number[] { const result = array(value, path); if (result.length !== length) fail('E_STATE_MACHINE_V2_FORMAT', path, `expected ${length}-tuple`); return result.map((entry, index) => finite(entry, `${path}[${index}]`)); }
function literal(value: unknown, expected: string, path: string): void { if (value !== expected) fail('E_STATE_MACHINE_V2_FORMAT', path, `expected ${expected}`); }
function enumeration<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] { if (typeof value !== 'string' || !allowed.includes(value)) fail('E_STATE_MACHINE_V2_FORMAT', path, `expected ${allowed.join('|')}`); return value as T[number]; }
function bounded(value: number, maximum: number, path: string): void { if (value > maximum) fail('E_STATE_MACHINE_V2_LIMIT', path, `count ${value} exceeds ${maximum}`); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
function fail(code: Parameters<typeof stateMachineV2Fail>[0], path: string, message: string): never { return stateMachineV2Fail(code, path, message); }
