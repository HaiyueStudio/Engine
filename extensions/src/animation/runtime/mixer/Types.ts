import type {
  AnimationStateMachineBindingMask,
  AnimationStateMachineBlendMode,
  AnimationStateMachineLoopMode,
} from '../../../animation-state-machine/AnimationStateMachine.js';

export type Animation2DBindingStrategy =
  | 'continuous'
  | 'rotation'
  | 'discrete'
  | 'dominant';

export interface Animation2DBinding {
  /** Stable mask and pose channel id. */
  readonly id: string;
  /** Stable node, slot, component, or graph target id. */
  readonly targetId: string;
  /** Examples: transform.position, opacity, text, sprite, composite, mask. */
  readonly path: string;
  readonly strategy: Animation2DBindingStrategy;
  /** Required for continuous and rotation bindings; rotation must use one value. */
  readonly valueSize?: number;
  /** Base used when a continuous layer has less than unit weight. */
  readonly defaultValue?: Readonly<ArrayLike<number>> | unknown;
}

export type Animation2DInterpolation = 'step' | 'linear' | 'cubic-bezier';

export interface Animation2DNumericTrack {
  readonly id: string;
  readonly binding: Animation2DBinding;
  readonly interpolation: Animation2DInterpolation;
  readonly times: Float32Array;
  /** Tightly packed key values by binding.valueSize. */
  readonly values: Float32Array;
  /** Per-segment x1, y1, x2, y2 tuples for cubic-bezier interpolation. */
  readonly easings?: Float32Array;
  /** Relative outgoing/incoming spatial controls for transform.position. */
  readonly spatialTangents?: Float32Array;
}

export interface Animation2DDiscreteTrack {
  readonly id: string;
  readonly binding: Animation2DBinding;
  readonly interpolation: 'step';
  /** One immutable/reference-stable value per key. */
  readonly times: Float32Array;
  readonly values: readonly unknown[];
}

export type Animation2DTrack =
  | Animation2DNumericTrack
  | Animation2DDiscreteTrack;

export type Animation2DEffectKind = 'audio' | 'particle';
export type Animation2DEffectLoopBehavior = 'continue' | 'restart';

export interface Animation2DEffectCue {
  readonly id: string;
  readonly kind: Animation2DEffectKind;
  readonly start: number;
  /** Defaults to clip duration. The interval is [start, end). */
  readonly end?: number;
  /** Audio defaults to continue; particle defaults to restart. */
  readonly loopBehavior?: Animation2DEffectLoopBehavior;
  readonly payload?: unknown;
}

export interface Animation2DClip {
  readonly format: 'haiyue-animation2d-clip@1';
  readonly id: string;
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly Animation2DTrack[];
  readonly effects?: readonly Animation2DEffectCue[];
}

export type Animation2DEffectLifecycle =
  | 'enter'
  | 'exit'
  | 'restart'
  | 'loop'
  | 'seek';

export interface Animation2DEffectEvent {
  readonly actionId: string;
  readonly clipId: string;
  readonly cue: Animation2DEffectCue;
  readonly lifecycle: Animation2DEffectLifecycle;
}

export interface Animation2DPoseChannel {
  readonly binding: Animation2DBinding;
  /**
   * Continuous and rotation channels expose a reused Float32Array. Discrete
   * and dominant channels expose the winning authored value by reference.
   */
  readonly value: Readonly<Float32Array> | unknown;
}

export interface Animation2DPose {
  readonly sequence: number;
  readonly mixerTime: number;
  readonly channels: readonly Animation2DPoseChannel[];
  readonly effects: readonly Animation2DEffectEvent[];
}

export interface Animation2DMutablePose {
  reset(mixerTime: number): void;
  writeNumeric(binding: Animation2DBinding, value: ArrayLike<number>): void;
  writeDiscrete(binding: Animation2DBinding, value: unknown): void;
  emit(effect: Animation2DEffectEvent): void;
  seal(): Animation2DPose;
}

export interface Animation2DActionOptions {
  readonly id?: string;
  readonly loop?: AnimationStateMachineLoopMode;
  readonly repetitions?: number;
  readonly clampWhenFinished?: boolean;
  readonly timeScale?: number;
  readonly weight?: number;
  /** Ascending layers are applied in order; a higher layer overrides a lower one. */
  readonly layer?: number;
  readonly blendMode?: AnimationStateMachineBlendMode;
  readonly mask?: AnimationStateMachineBindingMask;
}

export type Animation2DActionStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'finished'
  | 'stopped';

export type Animation2DLoopMode = AnimationStateMachineLoopMode;
export type Animation2DBlendMode = AnimationStateMachineBlendMode;
export type Animation2DBindingMask = AnimationStateMachineBindingMask;
