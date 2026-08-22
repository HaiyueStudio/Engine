import { stateMachineV2Fail } from './diagnostics.js';
import { parseHyaStateMachineV2 } from './parser.js';
import {
  HYA_STATE_MACHINE_V2_EXTENSION_ID,
  HYA_STATE_MACHINE_V2_FORMAT,
  type HyaStateMachineV1MigrationResult,
  type HyaStateMotion,
  type HyaTimelineChannel,
  type HyaTimelineTrack,
  type TimelineValue,
} from './types.js';

export interface HyaStateMachineV1MigrationOptions {
  /** Caller-supplied executable v2 channel contracts for tracks in the parent HYA document. */
  readonly channels?: readonly HyaTimelineChannel[];
  /** Tracks already adapted from the parent HYA composition, keyed by the v1 named clip id. */
  readonly tracksByClip?: Readonly<Record<string, readonly HyaTimelineTrack[]>>;
}

/**
 * Deterministically migrates the built-in v1 graph without keeping a v1
 * execution branch. Parent HYA tracks are deliberately supplied by the
 * generic HYA compiler; this function never samples a source format.
 */
export function migrateHyaStateMachineV1(
  value: unknown,
  options: HyaStateMachineV1MigrationOptions = {},
): HyaStateMachineV1MigrationResult {
  const root = record(value, '$');
  exactKeys(root, ['clips', 'stateMachine'], '$');
  const clipValues = array(root.clips, '$.clips'), clipIds = new Set<string>();
  const clips = clipValues.map((entry, index) => {
    const path = `$.clips[${index}]`, clip = record(entry, path);
    exactKeys(clip, ['id', 'name', 'start', 'duration'], path, true);
    const id = unique(identifier(clip.id, `${path}.id`), clipIds, `${path}.id`);
    finiteNonNegative(clip.start, `${path}.start`);
    return {
      id,
      ...(clip.name === undefined ? {} : { name: string(clip.name, `${path}.name`) }),
      duration: finitePositive(clip.duration, `${path}.duration`),
      tracks: [...(options.tracksByClip?.[id] ?? [])],
    };
  });

  const source = record(root.stateMachine, '$.stateMachine');
  exactKeys(source, ['format', 'id', 'name', 'parameters', 'layers'], '$.stateMachine');
  if (source.format !== 'haiyue-animation-state-machine@1') migrationFail('$.stateMachine.format', 'expected haiyue-animation-state-machine@1');
  const inputs = array(source.parameters, '$.stateMachine.parameters').map((entry, index) => {
    const path = `$.stateMachine.parameters[${index}]`, parameter = record(entry, path);
    exactKeys(parameter, ['name', 'type', 'defaultValue'], path, true);
    const id = identifier(parameter.name, `${path}.name`), type = string(parameter.type, `${path}.type`);
    if (type === 'trigger') return { id, type } as const;
    if (type === 'boolean') return { id, type, defaultValue: boolean(parameter.defaultValue, `${path}.defaultValue`) } as const;
    if (type === 'integer') return { id, type, defaultValue: safeInteger(parameter.defaultValue, `${path}.defaultValue`) } as const;
    if (type === 'float') return { id, type: 'number' as const, defaultValue: finite(parameter.defaultValue, `${path}.defaultValue`) };
    migrationFail(`${path}.type`, `unsupported v1 parameter type ${type}`);
  });
  const inputTypes = new Map(inputs.map(input => [input.id, input.type]));

  const layers = array(source.layers, '$.stateMachine.layers').map((entry, layerIndex) => {
    const path = `$.stateMachine.layers[${layerIndex}]`, layer = record(entry, path);
    exactKeys(layer, ['id', 'name', 'initialStateId', 'states', 'transitions', 'blendMode', 'weight', 'mask'], path, true);
    const initialState = identifier(layer.initialStateId, `${path}.initialStateId`);
    const states = array(layer.states, `${path}.states`).map((stateEntry, stateIndex) => {
      const statePath = `${path}.states[${stateIndex}]`, state = record(stateEntry, statePath);
      exactKeys(state, ['id', 'name', 'motion', 'speed', 'speedParameter', 'loop'], statePath, true);
      return {
        id: identifier(state.id, `${statePath}.id`),
        motion: migrateMotion(state.motion, state, `${statePath}.motion`, inputTypes, clipIds),
      };
    });
    const transitions = array(layer.transitions, `${path}.transitions`).map((transitionEntry, transitionIndex) => {
      const transitionPath = `${path}.transitions[${transitionIndex}]`, transition = record(transitionEntry, transitionPath);
      exactKeys(transition, ['id', 'from', 'to', 'conditions', 'duration', 'hasExitTime', 'exitTime', 'destinationOffset', 'interruption'], transitionPath, true);
      const sourceConditions = array(transition.conditions, `${transitionPath}.conditions`);
      return {
        id: identifier(transition.id, `${transitionPath}.id`),
        from: transition.from === '*' ? '@any' : identifier(transition.from, `${transitionPath}.from`),
        to: identifier(transition.to, `${transitionPath}.to`),
        conditionGroups: sourceConditions.length === 0 ? [] : [sourceConditions.map((condition, conditionIndex) => migrateCondition(condition, `${transitionPath}.conditions[${conditionIndex}]`, inputTypes))],
        ...(transition.hasExitTime === true ? { exitTime: finiteNonNegative(transition.exitTime, `${transitionPath}.exitTime`) } : {}),
        duration: finiteNonNegative(transition.duration, `${transitionPath}.duration`),
        ...(transition.destinationOffset === undefined ? {} : { destinationOffset: finiteNonNegative(transition.destinationOffset, `${transitionPath}.destinationOffset`) }),
        ...(transition.interruption === undefined ? {} : { interruption: string(transition.interruption, `${transitionPath}.interruption`) }),
        interpolation: { kind: 'linear' as const },
      };
    });
    return {
      id: identifier(layer.id, `${path}.id`), order: layerIndex,
      ...(layer.weight === undefined ? {} : { weight: finite(layer.weight, `${path}.weight`) }),
      ...(layer.blendMode === undefined ? {} : { mode: string(layer.blendMode, `${path}.blendMode`) }),
      ...(layer.mask === undefined ? {} : { mask: structuredClone(layer.mask) }),
      states,
      transitions: [{ id: `@entry:${initialState}`, from: '@entry' as const, to: initialState, conditionGroups: [], duration: 0 }, ...transitions],
    };
  });

  const candidate = {
    format: HYA_STATE_MACHINE_V2_FORMAT,
    extension: HYA_STATE_MACHINE_V2_EXTENSION_ID,
    channels: [...(options.channels ?? [])], clips,
    stateMachines: [{ id: identifier(source.id, '$.stateMachine.id'), inputs, layers }],
  };
  const diagnostics: HyaStateMachineV1MigrationResult['diagnostics'][number][] = [{
    code: 'W_STATE_MACHINE_V1_MIGRATED', path: '$.stateMachine.format',
    message: 'The v1 graph was normalized to state-machine v2; runtime execution uses only the v2 sampler.',
  }];
  if (options.channels === undefined || options.tracksByClip === undefined) diagnostics.push({
    code: 'W_STATE_MACHINE_V1_CHANNEL_POLICY_REQUIRED', path: '$.clips',
    message: 'The graph is migrated, but parent HYA tracks require compiler-supplied v2 channel policies before visual execution.',
  });
  return Object.freeze({
    document: parseHyaStateMachineV2(candidate),
    diagnostics: Object.freeze(diagnostics.map(diagnostic => Object.freeze(diagnostic))),
  });
}

function migrateMotion(value: unknown, state: Record<string, unknown>, path: string, inputs: ReadonlyMap<string, string>, clips: ReadonlySet<string>): HyaStateMotion {
  const motion = record(value, path), kind = string(motion.kind, `${path}.kind`);
  const decorate = <T extends Record<string, unknown>>(result: T): T & Record<string, unknown> => ({
    ...result,
    ...(state.speed === undefined ? {} : { speed: finite(state.speed, `${path}.__state.speed`) }),
    ...(state.speedParameter === undefined ? {} : { speedInput: inputReference(state.speedParameter, inputs, `${path}.__state.speedParameter`) }),
    ...(state.loop === undefined ? {} : { playback: migrateLoop(state.loop, `${path}.__state.loop`) }),
  });
  if (kind === 'clip') {
    const clip = identifier(motion.clipId, `${path}.clipId`); if (!clips.has(clip)) migrationFail(`${path}.clipId`, `unknown clip ${clip}`);
    return decorate({ kind: 'clip', clip }) as unknown as HyaStateMotion;
  }
  if (kind === 'blend-1d') return {
    kind, input: inputReference(motion.parameter, inputs, `${path}.parameter`),
    children: array(motion.children, `${path}.children`).map((entry, index) => { const child = record(entry, `${path}.children[${index}]`); return { threshold: finite(child.threshold, `${path}.children[${index}].threshold`), motion: migrateMotion(child.motion, state, `${path}.children[${index}].motion`, inputs, clips) }; }),
  };
  if (kind === 'blend-2d') return {
    kind, algorithm: string(motion.algorithm, `${path}.algorithm`) as 'cartesian' | 'directional',
    inputX: inputReference(motion.parameterX, inputs, `${path}.parameterX`), inputY: inputReference(motion.parameterY, inputs, `${path}.parameterY`),
    children: array(motion.children, `${path}.children`).map((entry, index) => { const child = record(entry, `${path}.children[${index}]`), position = array(child.position, `${path}.children[${index}].position`); if (position.length !== 2) migrationFail(`${path}.children[${index}].position`, 'expected two values'); return { position: [finite(position[0], `${path}.children[${index}].position[0]`), finite(position[1], `${path}.children[${index}].position[1]`)] as const, motion: migrateMotion(child.motion, state, `${path}.children[${index}].motion`, inputs, clips) }; }),
  };
  migrationFail(`${path}.kind`, `unsupported v1 motion ${kind}`);
}

function migrateCondition(value: unknown, path: string, inputs: ReadonlyMap<string, string>): Record<string, unknown> {
  const condition = record(value, path), input = inputReference(condition.parameter, inputs, `${path}.parameter`), operator = string(condition.operator, `${path}.operator`), type = inputs.get(input);
  if (operator === 'triggered') return { kind: 'trigger', input };
  if (operator === 'is-true' || operator === 'is-false') return { kind: 'input', input, comparator: 'equal', value: operator === 'is-true' };
  const comparator = ({ greater: 'greater', 'greater-or-equal': 'greater-or-equal', less: 'less', 'less-or-equal': 'less-or-equal', equal: 'equal', 'not-equal': 'not-equal' } as Record<string, string>)[operator];
  if (!comparator) migrationFail(`${path}.operator`, `unsupported operator ${operator}`);
  const compared = condition.value as TimelineValue;
  if (type === 'boolean') boolean(compared, `${path}.value`); else if (type === 'integer') safeInteger(compared, `${path}.value`); else finite(compared, `${path}.value`);
  return { kind: 'input', input, comparator, value: compared };
}

function migrateLoop(value: unknown, path: string): 'one-shot' | 'loop' | 'ping-pong' { const loop = string(value, path); if (loop === 'once') return 'one-shot'; if (loop === 'repeat') return 'loop'; if (loop === 'ping-pong') return loop; migrationFail(path, `unsupported loop ${loop}`); }
function inputReference(value: unknown, inputs: ReadonlyMap<string, string>, path: string): string { const input = identifier(value, path); if (!inputs.has(input)) migrationFail(path, `unknown input ${input}`); return input; }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, optional = false): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) migrationFail(`${path}.${key}`, 'unknown v1 property'); if (!optional) for (const key of allowed) if (!(key in value)) migrationFail(`${path}.${key}`, 'missing v1 property'); }
function unique(value: string, values: Set<string>, path: string): string { if (values.has(value)) migrationFail(path, `duplicate id ${value}`); values.add(value); return value; }
function record(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) migrationFail(path, 'expected object'); return value as Record<string, unknown>; }
function array(value: unknown, path: string): unknown[] { if (!Array.isArray(value)) migrationFail(path, 'expected array'); return value; }
function string(value: unknown, path: string): string { if (typeof value !== 'string') migrationFail(path, 'expected string'); return value; }
function identifier(value: unknown, path: string): string { const result = string(value, path); if (!result) migrationFail(path, 'expected non-empty identifier'); return result; }
function finite(value: unknown, path: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) migrationFail(path, 'expected finite number'); return value; }
function finiteNonNegative(value: unknown, path: string): number { const result = finite(value, path); if (result < 0) migrationFail(path, 'expected non-negative number'); return result; }
function finitePositive(value: unknown, path: string): number { const result = finite(value, path); if (result <= 0) migrationFail(path, 'expected positive number'); return result; }
function safeInteger(value: unknown, path: string): number { const result = finite(value, path); if (!Number.isSafeInteger(result)) migrationFail(path, 'expected safe integer'); return result; }
function boolean(value: unknown, path: string): boolean { if (typeof value !== 'boolean') migrationFail(path, 'expected boolean'); return value; }
function migrationFail(path: string, message: string): never { return stateMachineV2Fail('E_STATE_MACHINE_V2_MIGRATION', path, message); }
