import type {
  AnimationDocument,
  AnimationParseLimits,
  AnimationResource,
  AnimationSource,
  ParsedAnimation,
} from '../types';

export const NATIVE_3D_ANIMATION_EXTENSION_ID = 'org.haiyue.animation-3d@1' as const;
export const NATIVE_3D_ANIMATION_FORMAT = 'haiyue-animation-3d@1' as const;
export const NATIVE_3D_CLIP_FORMAT = 'haiyue-animation3d-clip@1' as const;
export const NATIVE_3D_STATE_MACHINE_FORMAT = 'haiyue-animation3d-state-machine@1' as const;

export type Native3DVec2 = readonly [number, number];
export type Native3DVec3 = readonly [number, number, number];
export type Native3DVec4 = readonly [number, number, number, number];
export type Native3DQuaternion = Native3DVec4;
export type Native3DScalarRange = number | readonly [number, number];

export interface Native3DCoordinateSystem {
  readonly handedness: 'right';
  readonly upAxis: '+y';
  readonly forwardAxis: '-z';
  readonly unit: 'meter';
  readonly angles: 'radian';
  readonly rotationStorage: 'normalized-xyzw-quaternion';
}

export interface Native3DViewport {
  readonly width: number;
  readonly height: number;
}

export interface Native3DTransform {
  readonly translation: Native3DVec3;
  readonly rotation: Native3DQuaternion;
  readonly scale: Native3DVec3;
}

export interface Native3DMaterial {
  readonly id: string;
  readonly name: string;
  readonly baseColorFactor: Native3DVec4;
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly emissiveFactor: Native3DVec3;
  readonly alphaMode: 'opaque' | 'mask' | 'blend';
  readonly alphaCutoff?: number;
  readonly doubleSided: boolean;
  readonly baseColorTexture?: string;
  readonly normalTexture?: string;
  readonly metallicRoughnessTexture?: string;
  readonly emissiveTexture?: string;
}

export type Native3DCameraProjection =
  | Readonly<{
      kind: 'perspective';
      fovYRadians: number;
      near: number;
      far: number;
    }>
  | Readonly<{
      kind: 'orthographic';
      orthoHeight: number;
      near: number;
      far: number;
    }>;

export interface Native3DCameraComponent {
  readonly id: string;
  readonly kind: 'camera3d';
  readonly projection: Native3DCameraProjection;
}

export interface Native3DPrimitiveComponent {
  readonly id: string;
  readonly kind: 'primitive3d';
  readonly primitive: 'box' | 'sphere' | 'plane' | 'cylinder' | 'cone';
  readonly materialId: string;
}

export interface Native3DModelComponent {
  readonly id: string;
  readonly kind: 'model3d';
  readonly resource: string;
  readonly materialOverrides?: readonly Readonly<{ slot: string; materialId: string }>[];
}

export interface Native3DParticleDescriptor {
  readonly maxParticles: number;
  readonly emissionRate: number;
  readonly burst: number;
  readonly duration: number;
  readonly loop: boolean;
  readonly seed: number;
  readonly lifetime: Native3DScalarRange;
  readonly speed: Native3DScalarRange;
  readonly direction: Native3DVec3;
  readonly spread: number;
  readonly gravity: Native3DVec3;
  readonly startSize: Native3DScalarRange;
  readonly endSize: Native3DScalarRange;
  readonly rotation: Native3DScalarRange;
  readonly angularVelocity: Native3DScalarRange;
  readonly startColor: Native3DVec4;
  readonly endColor: Native3DVec4;
  readonly shape: 'point' | 'box' | 'sphere';
  readonly shapeSize?: Native3DVec3;
  readonly shapeRadius?: number;
  readonly blendMode: 'normal' | 'additive';
  readonly textureResource?: string;
  readonly radial: boolean;
  readonly opacity: number;
  readonly depthTest: boolean;
  readonly depthWrite: boolean;
  readonly sortMode: 'none' | 'back-to-front';
}

export interface Native3DParticleComponent {
  readonly id: string;
  readonly kind: 'particle3d';
  readonly descriptor: Native3DParticleDescriptor;
}

export type Native3DComponent =
  | Native3DCameraComponent
  | Native3DPrimitiveComponent
  | Native3DModelComponent
  | Native3DParticleComponent;

export interface Native3DNode {
  readonly id: string;
  readonly name: string;
  readonly parent?: string;
  readonly start?: number;
  readonly duration?: number;
  readonly transform: Native3DTransform;
  readonly components: readonly Native3DComponent[];
}

export type Native3DBindingTarget =
  | Readonly<{ kind: 'node-id'; nodeId: string }>
  | Readonly<{ kind: 'node-path'; segments: readonly string[] }>
  | Readonly<{ kind: 'slot'; slot: string }>;

export type Native3DBinding =
  | Readonly<{
      id: string;
      target: Native3DBindingTarget;
      path: 'transform.translation';
      valueType: 'vec3';
      valueSize: 3;
    }>
  | Readonly<{
      id: string;
      target: Native3DBindingTarget;
      path: 'transform.rotation';
      valueType: 'quaternion';
      valueSize: 4;
    }>
  | Readonly<{
      id: string;
      target: Native3DBindingTarget;
      path: 'transform.scale';
      valueType: 'vec3';
      valueSize: 3;
    }>
  | Readonly<{
      id: string;
      target: Native3DBindingTarget;
      path: 'morph.weights';
      valueType: 'weights';
      valueSize: number;
    }>
  | Readonly<{
      id: string;
      target: Native3DBindingTarget;
      path: 'property';
      component: 'material3d' | 'camera3d';
      property:
        | 'baseColorFactor'
        | 'metallicFactor'
        | 'roughnessFactor'
        | 'emissiveFactor'
        | 'alphaCutoff'
        | 'fovYRadians'
        | 'near'
        | 'far'
        | 'orthoHeight';
      valueType: 'scalar' | 'vec3' | 'vec4';
      valueSize: 1 | 3 | 4;
    }>;

export interface Native3DTrack {
  readonly id: string;
  readonly binding: Native3DBinding;
  readonly interpolation: 'step' | 'linear' | 'cubic-spline';
  readonly times: readonly number[];
  readonly values: readonly number[];
}

export interface Native3DEvent {
  readonly id: string;
  readonly time: number;
  readonly name: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface Native3DClip {
  readonly format: typeof NATIVE_3D_CLIP_FORMAT;
  readonly id: string;
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly Native3DTrack[];
  readonly events: readonly Native3DEvent[];
}

export type Native3DStateMachineParameter =
  | Readonly<{ name: string; type: 'float'; defaultValue: number }>
  | Readonly<{ name: string; type: 'integer'; defaultValue: number }>
  | Readonly<{ name: string; type: 'boolean'; defaultValue: boolean }>
  | Readonly<{ name: string; type: 'trigger' }>;

export type Native3DStateMachineMotion =
  | Readonly<{ kind: 'clip'; clipId: string }>
  | Readonly<{
      kind: 'blend-1d';
      parameter: string;
      children: readonly Readonly<{ threshold: number; motion: Native3DStateMachineMotion }>[];
    }>
  | Readonly<{
      kind: 'blend-2d';
      algorithm: 'cartesian' | 'directional';
      parameterX: string;
      parameterY: string;
      children: readonly Readonly<{ position: Native3DVec2; motion: Native3DStateMachineMotion }>[];
    }>;

export interface Native3DStateMachineCondition {
  readonly parameter: string;
  readonly operator:
    | 'greater'
    | 'greater-or-equal'
    | 'less'
    | 'less-or-equal'
    | 'equal'
    | 'not-equal'
    | 'is-true'
    | 'is-false'
    | 'triggered';
  readonly value?: number | boolean;
}

export interface Native3DStateMachineState {
  readonly id: string;
  readonly name: string;
  readonly motion: Native3DStateMachineMotion;
  readonly speed?: number;
  readonly speedParameter?: string;
  readonly loop?: 'once' | 'repeat' | 'ping-pong';
}

export interface Native3DStateMachineTransition {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly conditions: readonly Native3DStateMachineCondition[];
  readonly duration: number;
  readonly hasExitTime?: boolean;
  readonly exitTime?: number;
  readonly destinationOffset?: number;
  readonly interruption?: 'none' | 'source' | 'destination' | 'source-then-destination' | 'destination-then-source';
}

export interface Native3DStateMachineLayer {
  readonly id: string;
  readonly name: string;
  readonly initialStateId: string;
  readonly states: readonly Native3DStateMachineState[];
  readonly transitions: readonly Native3DStateMachineTransition[];
  readonly blendMode?: 'override' | 'additive';
  readonly weight?: number;
  readonly mask?: Readonly<{ include?: readonly string[]; exclude?: readonly string[] }>;
}

export interface Native3DStateMachine {
  readonly format: typeof NATIVE_3D_STATE_MACHINE_FORMAT;
  readonly id: string;
  readonly name: string;
  readonly parameters: readonly Native3DStateMachineParameter[];
  readonly layers: readonly Native3DStateMachineLayer[];
}

export interface Native3DAnimationPayload {
  readonly format: typeof NATIVE_3D_ANIMATION_FORMAT;
  readonly mode: 'native-3d';
  readonly coordinateSystem: Native3DCoordinateSystem;
  readonly viewport: Native3DViewport;
  readonly materials: readonly Native3DMaterial[];
  readonly nodes: readonly Native3DNode[];
  readonly clips: readonly Native3DClip[];
  readonly stateMachine?: Native3DStateMachine | null;
}

export interface Native3DParseLimits {
  readonly maxMaterials?: number;
  readonly maxClips?: number;
  readonly maxStateMachineDepth?: number;
}

export interface Native3DAnimationParseOptions extends AnimationParseLimits, Native3DParseLimits {
  readonly copyFloatData?: boolean;
}

export interface ParsedNative3DAnimation {
  readonly document: ParsedAnimation;
  readonly payload: Native3DAnimationPayload;
  readonly resources: readonly Readonly<AnimationResource>[];
}

export type Native3DAnimationSource = AnimationSource | AnimationDocument;
