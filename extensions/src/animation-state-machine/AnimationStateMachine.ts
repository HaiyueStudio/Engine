export type AnimationStateMachineLoopMode =
  | 'once'
  | 'repeat'
  | 'ping-pong';

export type AnimationStateMachineBlendMode =
  | 'override'
  | 'additive';

/**
 * A state-machine mask addresses logical animation bindings. The concrete 2D
 * or 3D mixer decides how those stable ids resolve to runtime targets.
 */
export interface AnimationStateMachineBindingMask {
  /** Empty or omitted include means all bindings are eligible. */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export type AnimationStateMachineParameterDefinition =
  | Readonly<{
      name: string;
      type: 'float';
      defaultValue: number;
    }>
  | Readonly<{
      name: string;
      type: 'integer';
      defaultValue: number;
    }>
  | Readonly<{
      name: string;
      type: 'boolean';
      defaultValue: boolean;
    }>
  | Readonly<{
      name: string;
      type: 'trigger';
    }>;

export type AnimationStateMachineTransitionCondition =
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

export interface AnimationStateMachineClipMotion {
  readonly kind: 'clip';
  /**
   * Mixer-owned source id. It may identify a 3D clip, a HYA composition, or
   * another animation source understood by the selected mixer port.
   */
  readonly clipId: string;
}

export interface AnimationStateMachineBlend1DChild {
  readonly threshold: number;
  readonly motion: AnimationStateMachineMotionDefinition;
}

export interface AnimationStateMachineBlend1DMotion {
  readonly kind: 'blend-1d';
  readonly parameter: string;
  readonly children: readonly AnimationStateMachineBlend1DChild[];
}

export interface AnimationStateMachineBlend2DChild {
  readonly position: readonly [number, number];
  readonly motion: AnimationStateMachineMotionDefinition;
}

export interface AnimationStateMachineBlend2DMotion {
  readonly kind: 'blend-2d';
  readonly algorithm: 'cartesian' | 'directional';
  readonly parameterX: string;
  readonly parameterY: string;
  readonly children: readonly AnimationStateMachineBlend2DChild[];
}

export type AnimationStateMachineMotionDefinition =
  | AnimationStateMachineClipMotion
  | AnimationStateMachineBlend1DMotion
  | AnimationStateMachineBlend2DMotion;

export interface AnimationStateMachineStateDefinition {
  readonly id: string;
  readonly name: string;
  readonly motion: AnimationStateMachineMotionDefinition;
  readonly speed?: number;
  readonly speedParameter?: string;
  readonly loop?: AnimationStateMachineLoopMode;
}

export type AnimationStateMachineTransitionInterruption =
  | 'none'
  | 'source'
  | 'destination'
  | 'source-then-destination'
  | 'destination-then-source';

export interface AnimationStateMachineTransitionDefinition {
  readonly id: string;
  /** '*' means any state in the same layer. */
  readonly from: string | '*';
  readonly to: string;
  readonly conditions: readonly AnimationStateMachineTransitionCondition[];
  readonly duration: number;
  readonly hasExitTime?: boolean;
  readonly exitTime?: number;
  readonly destinationOffset?: number;
  readonly interruption?: AnimationStateMachineTransitionInterruption;
}

export interface AnimationStateMachineLayer {
  readonly id: string;
  readonly name: string;
  readonly initialStateId: string;
  readonly states: readonly AnimationStateMachineStateDefinition[];
  /** Declaration order is transition priority. */
  readonly transitions: readonly AnimationStateMachineTransitionDefinition[];
  readonly blendMode?: AnimationStateMachineBlendMode;
  readonly weight?: number;
  readonly mask?: AnimationStateMachineBindingMask;
}

/**
 * Dimension-neutral serializable state-machine definition. Runtime controller
 * state and concrete mixer objects are intentionally not stored here.
 */
export interface AnimationStateMachineDefinition {
  readonly format: 'haiyue-animation-state-machine@1';
  readonly id: string;
  readonly name: string;
  readonly parameters: readonly AnimationStateMachineParameterDefinition[];
  readonly layers: readonly AnimationStateMachineLayer[];
}
