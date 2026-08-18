import type {
  AnimationStateMachineBindingMask as Animation3DBindingMask,
  AnimationStateMachineBlendMode as Animation3DBlendMode,
  AnimationStateMachineDefinition,
  AnimationStateMachineLoopMode as Animation3DLoopMode,
  AnimationStateMachineMotionDefinition as Animation3DMotionDefinition,
  AnimationStateMachineParameterDefinition as Animation3DParameterDefinition,
  AnimationStateMachineTransitionCondition as Animation3DTransitionCondition,
  AnimationStateMachineTransitionInterruption as Animation3DTransitionInterruption,
} from '../AnimationStateMachine.js';

type LegacyAnimation3DStateMachineDefinition =
  Omit<AnimationStateMachineDefinition, 'format'> & Readonly<{
    format: 'haiyue-animation3d-state-machine@1';
  }>;

type SupportedAnimationStateMachineDefinition =
  | AnimationStateMachineDefinition
  | LegacyAnimation3DStateMachineDefinition;

export type Animation3DStateMachineValidationCode =
  | 'invalid-value'
  | 'duplicate-id'
  | 'missing-reference'
  | 'parameter-type-mismatch'
  | 'invalid-operator'
  | 'empty-blend-tree'
  | 'invalid-thresholds'
  | 'recursive-motion';

export interface Animation3DStateMachineValidationIssue {
  readonly code: Animation3DStateMachineValidationCode;
  readonly path: string;
  readonly message: string;
}

export class AnimationStateMachineValidationError extends Error {
  readonly issues: readonly Animation3DStateMachineValidationIssue[];

  constructor(issues: readonly Animation3DStateMachineValidationIssue[]) {
    super(
      `Invalid animation state-machine definition (${issues.length} ${
        issues.length === 1 ? 'issue' : 'issues'
      }).`,
    );
    this.name = 'AnimationStateMachineValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

export type CompiledAnimation3DParameterType =
  | 'float'
  | 'integer'
  | 'boolean'
  | 'trigger';

export interface CompiledAnimation3DParameter {
  readonly index: number;
  readonly name: string;
  readonly type: CompiledAnimation3DParameterType;
  /** Triggers and false booleans use 0; true booleans use 1. */
  readonly defaultValue: number;
}

export type CompiledAnimation3DConditionOperator =
  | 'greater'
  | 'greater-or-equal'
  | 'less'
  | 'less-or-equal'
  | 'equal'
  | 'not-equal'
  | 'is-true'
  | 'is-false'
  | 'triggered';

export interface CompiledAnimation3DCondition {
  readonly parameterIndex: number;
  readonly operator: CompiledAnimation3DConditionOperator;
  readonly value: number;
}

export interface CompiledAnimation3DClipMotion {
  readonly kind: 'clip';
  readonly clipId: string;
}

export interface CompiledAnimation3DBlend1DChild {
  readonly threshold: number;
  readonly motion: CompiledAnimation3DMotion;
}

export interface CompiledAnimation3DBlend1DMotion {
  readonly kind: 'blend-1d';
  readonly parameterIndex: number;
  readonly children: readonly CompiledAnimation3DBlend1DChild[];
}

export interface CompiledAnimation3DBlend2DChild {
  readonly position: readonly [number, number];
  readonly motion: CompiledAnimation3DMotion;
  readonly declarationIndex: number;
}

export interface CompiledAnimation3DBlend2DMotion {
  readonly kind: 'blend-2d';
  readonly algorithm: 'cartesian' | 'directional';
  readonly parameterXIndex: number;
  readonly parameterYIndex: number;
  readonly children: readonly CompiledAnimation3DBlend2DChild[];
}

export type CompiledAnimation3DMotion =
  | CompiledAnimation3DClipMotion
  | CompiledAnimation3DBlend1DMotion
  | CompiledAnimation3DBlend2DMotion;

export interface CompiledAnimation3DState {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly motion: CompiledAnimation3DMotion;
  readonly speed: number;
  readonly speedParameterIndex: number;
  readonly loop: Animation3DLoopMode;
}

export interface CompiledAnimation3DTransition {
  readonly index: number;
  readonly id: string;
  /** -1 denotes any-state. */
  readonly fromStateIndex: number;
  readonly toStateIndex: number;
  readonly conditions: readonly CompiledAnimation3DCondition[];
  readonly triggerParameterIndices: readonly number[];
  readonly duration: number;
  readonly hasExitTime: boolean;
  readonly exitTime: number;
  readonly destinationOffset: number;
  readonly interruption: Animation3DTransitionInterruption;
}

export interface CompiledAnimation3DLayer {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly initialStateIndex: number;
  readonly states: readonly CompiledAnimation3DState[];
  /** Preserves declaration order, which is transition priority. */
  readonly transitions: readonly CompiledAnimation3DTransition[];
  readonly blendMode: Animation3DBlendMode;
  readonly weight: number;
  readonly mask: Animation3DBindingMask | null;
  /** Compiler-created lookup; the update path uses numeric indices instead. */
  readonly stateIndexById: ReadonlyMap<string, number>;
}

export interface CompiledAnimation3DStateMachine {
  readonly format: 'haiyue-animation-state-machine-compiled@1';
  readonly id: string;
  readonly name: string;
  readonly parameters: readonly CompiledAnimation3DParameter[];
  readonly layers: readonly CompiledAnimation3DLayer[];
  /** Setter/query boundary lookup; the update path uses numeric indices. */
  readonly parameterIndexByName: ReadonlyMap<string, number>;
  readonly layerIndexById: ReadonlyMap<string, number>;
}

interface ValidationContext {
  readonly issues: Animation3DStateMachineValidationIssue[];
  readonly parameterByName: Map<string, Animation3DParameterDefinition>;
  readonly motionStack: Set<object>;
}

const INTERRUPTION_VALUES: readonly Animation3DTransitionInterruption[] = [
  'none',
  'source',
  'destination',
  'source-then-destination',
  'destination-then-source',
];

export function validateAnimationStateMachineDefinition(
  definition: SupportedAnimationStateMachineDefinition,
): readonly Animation3DStateMachineValidationIssue[] {
  const issues: Animation3DStateMachineValidationIssue[] = [];
  const parameterByName = new Map<string, Animation3DParameterDefinition>();
  const context: ValidationContext = {
    issues,
    parameterByName,
    motionStack: new Set<object>(),
  };

  if (
    definition.format !== 'haiyue-animation-state-machine@1'
    && definition.format !== 'haiyue-animation3d-state-machine@1'
  ) {
    issue(context, 'invalid-value', 'format', 'Unsupported state-machine format.');
  }
  validateNonEmptyString(context, definition.id, 'id');
  validateNonEmptyString(context, definition.name, 'name');

  definition.parameters.forEach((parameter, parameterIndex) => {
    const path = `parameters[${parameterIndex}]`;
    validateNonEmptyString(context, parameter.name, `${path}.name`);
    if (parameterByName.has(parameter.name)) {
      issue(
        context,
        'duplicate-id',
        `${path}.name`,
        `Duplicate parameter name "${parameter.name}".`,
      );
    } else {
      parameterByName.set(parameter.name, parameter);
    }
    if (parameter.type === 'float') {
      validateFinite(context, parameter.defaultValue, `${path}.defaultValue`);
    } else if (parameter.type === 'integer') {
      if (!Number.isSafeInteger(parameter.defaultValue)) {
        issue(
          context,
          'invalid-value',
          `${path}.defaultValue`,
          'Integer parameter defaults must be safe integers.',
        );
      }
    } else if (parameter.type === 'boolean') {
      if (typeof parameter.defaultValue !== 'boolean') {
        issue(
          context,
          'invalid-value',
          `${path}.defaultValue`,
          'Boolean parameter defaults must be boolean.',
        );
      }
    } else if (parameter.type === 'trigger') {
      // Triggers always compile with a cleared default.
    } else {
      issue(context, 'invalid-value', `${path}.type`, 'Unknown parameter type.');
    }
  });

  const layerIds = new Set<string>();
  definition.layers.forEach((layer, layerIndex) => {
    const layerPath = `layers[${layerIndex}]`;
    validateNonEmptyString(context, layer.id, `${layerPath}.id`);
    validateNonEmptyString(context, layer.name, `${layerPath}.name`);
    if (layerIds.has(layer.id)) {
      issue(context, 'duplicate-id', `${layerPath}.id`, `Duplicate layer id "${layer.id}".`);
    }
    layerIds.add(layer.id);
    validateUnitWeight(context, layer.weight ?? 1, `${layerPath}.weight`);
    if (
      layer.blendMode !== undefined
      && layer.blendMode !== 'override'
      && layer.blendMode !== 'additive'
    ) {
      issue(context, 'invalid-value', `${layerPath}.blendMode`, 'Unknown layer blend mode.');
    }

    const stateIds = new Set<string>();
    layer.states.forEach((state, stateIndex) => {
      const statePath = `${layerPath}.states[${stateIndex}]`;
      validateNonEmptyString(context, state.id, `${statePath}.id`);
      validateNonEmptyString(context, state.name, `${statePath}.name`);
      if (stateIds.has(state.id)) {
        issue(context, 'duplicate-id', `${statePath}.id`, `Duplicate state id "${state.id}".`);
      }
      stateIds.add(state.id);
      validateFinite(context, state.speed ?? 1, `${statePath}.speed`);
      if (
        state.loop !== undefined
        && state.loop !== 'once'
        && state.loop !== 'repeat'
        && state.loop !== 'ping-pong'
      ) {
        issue(context, 'invalid-value', `${statePath}.loop`, 'Unknown state loop mode.');
      }
      if (state.speedParameter !== undefined) {
        validateNumericParameter(context, state.speedParameter, `${statePath}.speedParameter`);
      }
      validateMotion(context, state.motion, `${statePath}.motion`);
    });

    if (!stateIds.has(layer.initialStateId)) {
      issue(
        context,
        'missing-reference',
        `${layerPath}.initialStateId`,
        `Initial state "${layer.initialStateId}" does not exist in this layer.`,
      );
    }

    const transitionIds = new Set<string>();
    layer.transitions.forEach((transition, transitionIndex) => {
      const transitionPath = `${layerPath}.transitions[${transitionIndex}]`;
      validateNonEmptyString(context, transition.id, `${transitionPath}.id`);
      if (transitionIds.has(transition.id)) {
        issue(
          context,
          'duplicate-id',
          `${transitionPath}.id`,
          `Duplicate transition id "${transition.id}".`,
        );
      }
      transitionIds.add(transition.id);
      if (transition.from !== '*' && !stateIds.has(transition.from)) {
        issue(
          context,
          'missing-reference',
          `${transitionPath}.from`,
          `Source state "${transition.from}" does not exist in this layer.`,
        );
      }
      if (!stateIds.has(transition.to)) {
        issue(
          context,
          'missing-reference',
          `${transitionPath}.to`,
          `Destination state "${transition.to}" does not exist in this layer.`,
        );
      }
      validateNonNegativeFinite(context, transition.duration, `${transitionPath}.duration`);
      if (
        transition.hasExitTime !== undefined
        && typeof transition.hasExitTime !== 'boolean'
      ) {
        issue(
          context,
          'invalid-value',
          `${transitionPath}.hasExitTime`,
          'hasExitTime must be boolean.',
        );
      }
      if (transition.hasExitTime === true && transition.exitTime === undefined) {
        issue(
          context,
          'invalid-value',
          `${transitionPath}.exitTime`,
          'exitTime is required when hasExitTime is true.',
        );
      }
      if (transition.exitTime !== undefined) {
        validateNonNegativeFinite(context, transition.exitTime, `${transitionPath}.exitTime`);
      }
      if (transition.destinationOffset !== undefined) {
        validateNonNegativeFinite(
          context,
          transition.destinationOffset,
          `${transitionPath}.destinationOffset`,
        );
      }
      if (
        transition.interruption !== undefined
        && !INTERRUPTION_VALUES.includes(transition.interruption)
      ) {
        issue(
          context,
          'invalid-value',
          `${transitionPath}.interruption`,
          'Unknown transition interruption strategy.',
        );
      }
      transition.conditions.forEach((condition, conditionIndex) => {
        validateCondition(
          context,
          condition,
          `${transitionPath}.conditions[${conditionIndex}]`,
        );
      });
    });
  });

  return Object.freeze(issues);
}

export function compileAnimationStateMachineDefinition(
  definition: SupportedAnimationStateMachineDefinition,
): CompiledAnimation3DStateMachine {
  const issues = validateAnimationStateMachineDefinition(definition);
  if (issues.length > 0) throw new AnimationStateMachineValidationError(issues);

  const parameterIndexByName = new Map<string, number>();
  const parameters: CompiledAnimation3DParameter[] = definition.parameters.map(
    (parameter, index) => {
      parameterIndexByName.set(parameter.name, index);
      return Object.freeze({
        index,
        name: parameter.name,
        type: parameter.type,
        defaultValue: parameter.type === 'trigger'
          ? 0
          : parameter.type === 'boolean'
            ? (parameter.defaultValue ? 1 : 0)
            : parameter.defaultValue,
      });
    },
  );

  const layerIndexById = new Map<string, number>();
  const layers: CompiledAnimation3DLayer[] = definition.layers.map((layer, layerIndex) => {
    layerIndexById.set(layer.id, layerIndex);
    const stateIndexById = new Map<string, number>();
    layer.states.forEach((state, stateIndex) => stateIndexById.set(state.id, stateIndex));
    const states: CompiledAnimation3DState[] = layer.states.map((state, stateIndex) =>
      Object.freeze({
        index: stateIndex,
        id: state.id,
        name: state.name,
        motion: compileMotion(state.motion, parameterIndexByName),
        speed: state.speed ?? 1,
        speedParameterIndex: state.speedParameter === undefined
          ? -1
          : parameterIndexByName.get(state.speedParameter)!,
        loop: state.loop ?? 'repeat',
      }),
    );
    const transitions: CompiledAnimation3DTransition[] = layer.transitions.map(
      (transition, transitionIndex) => {
        const conditions = transition.conditions.map(condition =>
          compileCondition(condition, parameterIndexByName));
        const triggerParameterIndices = conditions
          .filter(condition => condition.operator === 'triggered')
          .map(condition => condition.parameterIndex);
        return Object.freeze({
          index: transitionIndex,
          id: transition.id,
          fromStateIndex: transition.from === '*'
            ? -1
            : stateIndexById.get(transition.from)!,
          toStateIndex: stateIndexById.get(transition.to)!,
          conditions: Object.freeze(conditions),
          triggerParameterIndices: Object.freeze(triggerParameterIndices),
          duration: transition.duration,
          hasExitTime: transition.hasExitTime ?? false,
          exitTime: transition.exitTime ?? 0,
          destinationOffset: transition.destinationOffset ?? 0,
          interruption: transition.interruption ?? 'none',
        });
      },
    );
    return Object.freeze({
      index: layerIndex,
      id: layer.id,
      name: layer.name,
      initialStateIndex: stateIndexById.get(layer.initialStateId)!,
      states: Object.freeze(states),
      transitions: Object.freeze(transitions),
      blendMode: layer.blendMode ?? 'override',
      weight: layer.weight ?? 1,
      mask: compileMask(layer.mask),
      stateIndexById,
    });
  });

  return Object.freeze({
    format: 'haiyue-animation-state-machine-compiled@1',
    id: definition.id,
    name: definition.name,
    parameters: Object.freeze(parameters),
    layers: Object.freeze(layers),
    parameterIndexByName,
    layerIndexById,
  });
}

/** Compatibility aliases for the original 3D-prefixed runtime API. */
export {
  AnimationStateMachineValidationError as Animation3DStateMachineValidationError,
};
export const validateAnimation3DStateMachineDefinition =
  validateAnimationStateMachineDefinition;
export const compileAnimation3DStateMachineDefinition =
  compileAnimationStateMachineDefinition;
export const compileAnimation3DStateMachine =
  compileAnimationStateMachineDefinition;

function validateMotion(
  context: ValidationContext,
  motion: Animation3DMotionDefinition,
  path: string,
): void {
  if (typeof motion !== 'object' || motion === null) {
    issue(context, 'invalid-value', path, 'Motion must be an object.');
    return;
  }
  if (context.motionStack.has(motion)) {
    issue(context, 'recursive-motion', path, 'Recursive motion cycle detected.');
    return;
  }
  context.motionStack.add(motion);
  if (motion.kind === 'clip') {
    validateNonEmptyString(context, motion.clipId, `${path}.clipId`);
  } else if (motion.kind === 'blend-1d') {
    validateNumericParameter(context, motion.parameter, `${path}.parameter`);
    if (motion.children.length === 0) {
      issue(context, 'empty-blend-tree', `${path}.children`, '1D blend tree cannot be empty.');
    }
    let previousThreshold = -Infinity;
    motion.children.forEach((child, childIndex) => {
      const childPath = `${path}.children[${childIndex}]`;
      validateFinite(context, child.threshold, `${childPath}.threshold`);
      if (childIndex > 0 && child.threshold <= previousThreshold) {
        issue(
          context,
          'invalid-thresholds',
          `${childPath}.threshold`,
          child.threshold === previousThreshold
            ? '1D blend thresholds must be unique.'
            : '1D blend thresholds must be strictly increasing.',
        );
      }
      previousThreshold = child.threshold;
      validateMotion(context, child.motion, `${childPath}.motion`);
    });
  } else if (motion.kind === 'blend-2d') {
    validateNumericParameter(context, motion.parameterX, `${path}.parameterX`);
    validateNumericParameter(context, motion.parameterY, `${path}.parameterY`);
    if (motion.algorithm !== 'cartesian' && motion.algorithm !== 'directional') {
      issue(context, 'invalid-value', `${path}.algorithm`, 'Unknown 2D blend algorithm.');
    }
    if (motion.children.length === 0) {
      issue(context, 'empty-blend-tree', `${path}.children`, '2D blend tree cannot be empty.');
    }
    const positions = new Set<string>();
    motion.children.forEach((child, childIndex) => {
      const childPath = `${path}.children[${childIndex}]`;
      const x = child.position[0];
      const y = child.position[1];
      validateFinite(context, x, `${childPath}.position[0]`);
      validateFinite(context, y, `${childPath}.position[1]`);
      const key = `${x}\u0000${y}`;
      if (positions.has(key)) {
        issue(
          context,
          'invalid-value',
          `${childPath}.position`,
          '2D blend child positions must be unique.',
        );
      }
      positions.add(key);
      validateMotion(context, child.motion, `${childPath}.motion`);
    });
  } else {
    issue(context, 'invalid-value', `${path}.kind`, 'Unknown motion kind.');
  }
  context.motionStack.delete(motion);
}

function validateCondition(
  context: ValidationContext,
  condition: Animation3DTransitionCondition,
  path: string,
): void {
  const parameter = context.parameterByName.get(condition.parameter);
  if (!parameter) {
    issue(
      context,
      'missing-reference',
      `${path}.parameter`,
      `Parameter "${condition.parameter}" does not exist.`,
    );
    return;
  }
  const operator = condition.operator;
  if (parameter.type === 'float' || parameter.type === 'integer') {
    const valid = operator === 'greater'
      || operator === 'greater-or-equal'
      || operator === 'less'
      || operator === 'less-or-equal'
      || operator === 'equal'
      || operator === 'not-equal';
    if (!valid) {
      issue(
        context,
        'invalid-operator',
        `${path}.operator`,
        `Operator "${operator}" is invalid for ${parameter.type} parameters.`,
      );
      return;
    }
    const value = 'value' in condition ? condition.value : undefined;
    if (
      typeof value !== 'number'
      || !Number.isFinite(value)
      || (parameter.type === 'integer' && !Number.isSafeInteger(value))
    ) {
      issue(
        context,
        'parameter-type-mismatch',
        `${path}.value`,
        parameter.type === 'integer'
          ? 'Integer conditions require a safe integer value.'
          : 'Float conditions require a finite numeric value.',
      );
    }
    return;
  }
  if (parameter.type === 'boolean') {
    if (
      operator !== 'equal'
      && operator !== 'not-equal'
      && operator !== 'is-true'
      && operator !== 'is-false'
    ) {
      issue(
        context,
        'invalid-operator',
        `${path}.operator`,
        `Operator "${operator}" is invalid for boolean parameters.`,
      );
      return;
    }
    if (
      (operator === 'equal' || operator === 'not-equal')
      && (!('value' in condition) || typeof condition.value !== 'boolean')
    ) {
      issue(
        context,
        'parameter-type-mismatch',
        `${path}.value`,
        'Boolean equality conditions require a boolean value.',
      );
    }
    return;
  }
  if (operator !== 'triggered') {
    issue(
      context,
      'invalid-operator',
      `${path}.operator`,
      `Operator "${operator}" is invalid for trigger parameters.`,
    );
  }
}

function validateNumericParameter(
  context: ValidationContext,
  parameterName: string,
  path: string,
): void {
  const parameter = context.parameterByName.get(parameterName);
  if (!parameter) {
    issue(
      context,
      'missing-reference',
      path,
      `Parameter "${parameterName}" does not exist.`,
    );
  } else if (parameter.type !== 'float' && parameter.type !== 'integer') {
    issue(
      context,
      'parameter-type-mismatch',
      path,
      `Parameter "${parameterName}" must be float or integer.`,
    );
  }
}

function compileMotion(
  motion: Animation3DMotionDefinition,
  parameterIndexByName: ReadonlyMap<string, number>,
): CompiledAnimation3DMotion {
  if (motion.kind === 'clip') {
    return Object.freeze({ kind: 'clip', clipId: motion.clipId });
  }
  if (motion.kind === 'blend-1d') {
    return Object.freeze({
      kind: 'blend-1d',
      parameterIndex: parameterIndexByName.get(motion.parameter)!,
      children: Object.freeze(motion.children.map(child => Object.freeze({
        threshold: child.threshold,
        motion: compileMotion(child.motion, parameterIndexByName),
      }))),
    });
  }
  return Object.freeze({
    kind: 'blend-2d',
    algorithm: motion.algorithm,
    parameterXIndex: parameterIndexByName.get(motion.parameterX)!,
    parameterYIndex: parameterIndexByName.get(motion.parameterY)!,
    children: Object.freeze(motion.children.map((child, declarationIndex) =>
      Object.freeze({
        position: Object.freeze([child.position[0], child.position[1]]) as readonly [number, number],
        motion: compileMotion(child.motion, parameterIndexByName),
        declarationIndex,
      }))),
  });
}

function compileCondition(
  condition: Animation3DTransitionCondition,
  parameterIndexByName: ReadonlyMap<string, number>,
): CompiledAnimation3DCondition {
  const rawValue = 'value' in condition ? condition.value : 0;
  return Object.freeze({
    parameterIndex: parameterIndexByName.get(condition.parameter)!,
    operator: condition.operator,
    value: typeof rawValue === 'boolean' ? (rawValue ? 1 : 0) : rawValue,
  });
}

function compileMask(
  mask: Animation3DBindingMask | undefined,
): Animation3DBindingMask | null {
  if (!mask) return null;
  return Object.freeze({
    ...(mask.include === undefined
      ? {}
      : { include: Object.freeze([...mask.include]) }),
    ...(mask.exclude === undefined
      ? {}
      : { exclude: Object.freeze([...mask.exclude]) }),
  });
}

function validateNonEmptyString(
  context: ValidationContext,
  value: string,
  path: string,
): void {
  if (typeof value !== 'string' || value.length === 0) {
    issue(context, 'invalid-value', path, 'Expected a non-empty string.');
  }
}

function validateFinite(
  context: ValidationContext,
  value: number,
  path: string,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issue(context, 'invalid-value', path, 'Expected a finite number.');
  }
}

function validateNonNegativeFinite(
  context: ValidationContext,
  value: number,
  path: string,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    issue(context, 'invalid-value', path, 'Expected a finite number greater than or equal to zero.');
  }
}

function validateUnitWeight(
  context: ValidationContext,
  value: number,
  path: string,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    issue(context, 'invalid-value', path, 'Layer weight must be a finite number in [0, 1].');
  }
}

function issue(
  context: ValidationContext,
  code: Animation3DStateMachineValidationCode,
  path: string,
  message: string,
): void {
  context.issues.push(Object.freeze({ code, path, message }));
}
