import type { Animation3DClip } from './Animation3DClip.js';
import { Animation3DMixer } from './Animation3DMixer.js';
import {
  animation3DMixerRuntime,
} from './runtime/mixer/Animation3DMixerRuntimeStore.js';
import type {
  Animation3DMutablePose,
  Animation3DPose,
} from './Animation3DPose.js';
import type { Animation3DStateMachineDefinition } from './Animation3DStateMachine.js';
import {
  compileAnimation3DStateMachineDefinition as compileInternalDefinition,
  validateAnimation3DStateMachineDefinition as validateInternalDefinition,
  type CompiledAnimation3DStateMachine as InternalCompiledStateMachine,
} from './runtime/state-machine/Animation3DStateMachineCompiler.js';
import {
  Animation3DStateMachineMixerIntegration,
} from './runtime/integration/Animation3DStateMachineMixerIntegration.js';

declare const COMPILED_ANIMATION3D_STATE_MACHINE: unique symbol;

/**
 * Opaque compiler output. Compiled nodes and lookup tables are deliberately
 * hidden so validation/compiler internals can evolve without expanding the
 * facade.
 */
export interface Animation3DCompiledStateMachine {
  readonly format: 'haiyue-animation-state-machine-compiled@1';
  readonly id: string;
  readonly name: string;
  readonly [COMPILED_ANIMATION3D_STATE_MACHINE]: true;
}

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

export class Animation3DStateMachineValidationError extends Error {
  readonly issues: readonly Animation3DStateMachineValidationIssue[];

  constructor(issues: readonly Animation3DStateMachineValidationIssue[]) {
    super(
      `Invalid Animation3D state-machine definition (${issues.length} ${
        issues.length === 1 ? 'issue' : 'issues'
      }).`,
    );
    this.name = 'Animation3DStateMachineValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

export function validateAnimation3DStateMachineDefinition(
  definition: Animation3DStateMachineDefinition,
): readonly Animation3DStateMachineValidationIssue[] {
  return validateInternalDefinition(definition);
}

export function compileAnimation3DStateMachineDefinition(
  definition: Animation3DStateMachineDefinition,
): Animation3DCompiledStateMachine {
  const issues = validateAnimation3DStateMachineDefinition(definition);
  if (issues.length > 0) {
    throw new Animation3DStateMachineValidationError(issues);
  }
  return compileInternalDefinition(definition) as unknown as Animation3DCompiledStateMachine;
}

export interface Animation3DStateMachineClipResolver {
  resolve(clipId: string): Animation3DClip | null;
}

export interface Animation3DStateMachineControllerOptions {
  readonly maxTransitionsPerUpdate?: number;
}

export type Animation3DStateMachineControllerStatus =
  | 'active'
  | 'destroyed';

export interface Animation3DStateMachineLayerSnapshot {
  readonly layerId: string;
  readonly currentStateId: string;
  readonly currentTime: number;
  readonly transitionId: string | null;
  readonly sourceStateId: string | null;
  readonly destinationStateId: string | null;
  readonly transitionProgress: number;
}

/**
 * Public closed-loop controller and minimal Mixer integration.
 *
 * The internal mixer port, action handles, controller transactions and
 * compiled nodes never cross this boundary.
 */
export class Animation3DStateMachineController {
  readonly mixer: Animation3DMixer;

  #integration: Animation3DStateMachineMixerIntegration;

  constructor(
    compiled: Animation3DCompiledStateMachine,
    mixer: Animation3DMixer,
    clipResolver: Animation3DStateMachineClipResolver,
    options: Animation3DStateMachineControllerOptions = {},
  ) {
    this.mixer = mixer;
    this.#integration = new Animation3DStateMachineMixerIntegration(
      compiled as unknown as InternalCompiledStateMachine,
      animation3DMixerRuntime(mixer),
      clipResolver,
      options,
    );
  }

  get status(): Animation3DStateMachineControllerStatus {
    return this.#integration.state;
  }

  get time(): number {
    return this.#integration.time;
  }

  get layerSnapshots(): readonly Animation3DStateMachineLayerSnapshot[] {
    return this.#integration.controller.layerSnapshots;
  }

  getLayerSnapshot(layerId: string): Animation3DStateMachineLayerSnapshot {
    return this.#integration.controller.getLayerSnapshot(layerId);
  }

  setFloat(name: string, value: number): this {
    this.#integration.controller.setFloat(name, value);
    return this;
  }

  setInteger(name: string, value: number): this {
    this.#integration.controller.setInteger(name, value);
    return this;
  }

  setBoolean(name: string, value: boolean): this {
    this.#integration.controller.setBoolean(name, value);
    return this;
  }

  setTrigger(name: string): this {
    this.#integration.controller.setTrigger(name);
    return this;
  }

  resetTrigger(name: string): this {
    this.#integration.controller.resetTrigger(name);
    return this;
  }

  getParameter(name: string): number | boolean {
    return this.#integration.controller.getParameter(name);
  }

  update(
    deltaSeconds: number,
    out: Animation3DMutablePose,
  ): Animation3DPose {
    return this.#integration.update(deltaSeconds, out);
  }

  evaluate(out: Animation3DMutablePose): Animation3DPose {
    return this.#integration.evaluate(out);
  }

  reset(out: Animation3DMutablePose): Animation3DPose {
    return this.#integration.reset(out);
  }

  destroy(): void {
    this.#integration.destroy();
  }
}
