import type {
  AnimationStateMachineBindingMask,
  AnimationStateMachineBlendMode,
  AnimationStateMachineLoopMode,
} from '../AnimationStateMachine.js';

/**
 * The only action shape the state-machine runtime needs. Concrete mixer
 * actions are adapted to this interface by the integration layer.
 */
export interface AnimationStateMachineActionHandle {
  /** Source clip duration in seconds. */
  readonly duration: number;
}

export interface AnimationStateMachineActionOptions {
  readonly layerId: string;
  readonly stateId: string;
  readonly loop: AnimationStateMachineLoopMode;
  readonly blendMode: AnimationStateMachineBlendMode;
  readonly mask: AnimationStateMachineBindingMask | null;
}

/**
 * Internal boundary between the state-machine controller and an animation
 * mixer. It deliberately has no dependency on Animation3DMixer or
 * Animation3DAction.
 */
export interface AnimationStateMachineMixerPort<
  TAction extends AnimationStateMachineActionHandle =
    AnimationStateMachineActionHandle,
> {
  createAction(
    clipId: string,
    options: AnimationStateMachineActionOptions,
  ): TAction;
  play(action: TAction): void;
  stop(action: TAction): void;
  fade(action: TAction, targetWeight: number, durationSeconds: number): void;
  setWeight(action: TAction, weight: number): void;
  setTime(action: TAction, timeSeconds: number): void;
  setTimeScale(action: TAction, timeScale: number): void;
  destroyAction(action: TAction): void;
}

/** Compatibility aliases for the original 3D-prefixed runtime boundary. */
export type Animation3DStateMachineActionHandle =
  AnimationStateMachineActionHandle;
export type Animation3DStateMachineActionOptions =
  AnimationStateMachineActionOptions;
export type Animation3DStateMachineMixerPort<
  TAction extends AnimationStateMachineActionHandle =
    AnimationStateMachineActionHandle,
> = AnimationStateMachineMixerPort<TAction>;
