import type {
  AnimationStateMachineDefinition,
} from '../animation-state-machine/AnimationStateMachine.js';
import {
  AnimationStateMachineController,
  compileAnimationStateMachine,
  type AnimationStateMachineActionHandle,
  type AnimationStateMachineControllerOptions,
  type AnimationStateMachineMixerPort,
} from '../animation-state-machine/runtime/index.js';

export type Animation2DStateMachineActionHandle =
  AnimationStateMachineActionHandle;
export type Animation2DStateMachineMixerPort<
  TAction extends Animation2DStateMachineActionHandle =
    Animation2DStateMachineActionHandle,
> = AnimationStateMachineMixerPort<TAction>;

/**
 * Creates a shared state-machine controller for a 2D mixer adapter.
 *
 * Animation2DComponent remains a single-composition player. A port must own
 * the 2D pose sampling, blending, discrete-property policy, and side-effect
 * lifecycle; this factory intentionally does not emulate those semantics by
 * switching component timelines.
 */
export function createAnimation2DStateMachineController<
  TAction extends Animation2DStateMachineActionHandle,
>(
  definition: AnimationStateMachineDefinition,
  port: Animation2DStateMachineMixerPort<TAction>,
  options?: AnimationStateMachineControllerOptions,
): AnimationStateMachineController<TAction> {
  return new AnimationStateMachineController(
    compileAnimationStateMachine(definition),
    port,
    options,
  );
}
