import type { Animation3DBindingMask } from './Animation3DBinding.js';
import type {
  Animation3DBlendMode,
  Animation3DLoopMode,
} from './Animation3DAction.js';

export type Animation3DParameterDefinition =
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

export type Animation3DTransitionCondition =
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

export interface Animation3DClipMotion {
  readonly kind: 'clip';
  readonly clipId: string;
}

export interface Animation3DBlend1DChild {
  readonly threshold: number;
  readonly motion: Animation3DMotionDefinition;
}

export interface Animation3DBlend1DMotion {
  readonly kind: 'blend-1d';
  readonly parameter: string;
  readonly children: readonly Animation3DBlend1DChild[];
}

export interface Animation3DBlend2DChild {
  readonly position: readonly [number, number];
  readonly motion: Animation3DMotionDefinition;
}

export interface Animation3DBlend2DMotion {
  readonly kind: 'blend-2d';
  readonly algorithm: 'cartesian' | 'directional';
  readonly parameterX: string;
  readonly parameterY: string;
  readonly children: readonly Animation3DBlend2DChild[];
}

export type Animation3DMotionDefinition =
  | Animation3DClipMotion
  | Animation3DBlend1DMotion
  | Animation3DBlend2DMotion;

export interface Animation3DStateDefinition {
  readonly id: string;
  readonly name: string;
  readonly motion: Animation3DMotionDefinition;
  readonly speed?: number;
  readonly speedParameter?: string;
  readonly loop?: Animation3DLoopMode;
}

export type Animation3DTransitionInterruption =
  | 'none'
  | 'source'
  | 'destination'
  | 'source-then-destination'
  | 'destination-then-source';

export interface Animation3DTransitionDefinition {
  readonly id: string;
  /** '*' means any state in the same layer. */
  readonly from: string | '*';
  readonly to: string;
  readonly conditions: readonly Animation3DTransitionCondition[];
  readonly duration: number;
  readonly hasExitTime?: boolean;
  readonly exitTime?: number;
  readonly destinationOffset?: number;
  readonly interruption?: Animation3DTransitionInterruption;
}

export interface Animation3DStateMachineLayer {
  readonly id: string;
  readonly name: string;
  readonly initialStateId: string;
  readonly states: readonly Animation3DStateDefinition[];
  /** Declaration order is transition priority. */
  readonly transitions: readonly Animation3DTransitionDefinition[];
  readonly blendMode?: Animation3DBlendMode;
  readonly weight?: number;
  readonly mask?: Animation3DBindingMask;
}

/** Serializable definition; controller state is always stored separately. */
export interface Animation3DStateMachineDefinition {
  readonly format: 'haiyue-animation3d-state-machine@1';
  readonly id: string;
  readonly name: string;
  readonly parameters: readonly Animation3DParameterDefinition[];
  readonly layers: readonly Animation3DStateMachineLayer[];
}
