export const PARAMETERIZED_RIG_EXTENSION_ID = 'org.haiyue.deformable-mesh-2d@2' as const;
export const PARAMETERIZED_RIG_FORMAT = 'haiyue-parameterized-rig-2d' as const;
export const PARAMETERIZED_RIG_VERSION = 2 as const;

export type RigNumericArray = readonly number[] | Float32Array;
export type RigIndexArray = readonly number[] | Uint32Array;
export type RigSpace = 'local' | 'world';
export type RigBlendMode = 'normal' | 'additive' | 'multiplicative';

export interface RigLimits {
  readonly maxInputBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxRigs: number;
  readonly maxInstances: number;
  readonly maxBones: number;
  readonly maxMeshes: number;
  readonly maxDrawables: number;
  readonly maxVertices: number;
  readonly maxIndices: number;
  readonly maxInfluences: number;
  readonly maxInfluencesPerVertex: number;
  readonly maxConstraints: number;
  readonly maxConstraintIterations: number;
  readonly maxPaths: number;
  readonly maxPathPoints: number;
  readonly maxParameters: number;
  readonly maxDrivers: number;
  readonly maxNestingDepth: number;
  readonly maxGpuBytes: number;
}

export interface RigTransform {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly skew?: number;
}

export interface RigParameter {
  readonly id: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export interface RigBone {
  readonly id: string;
  readonly parent?: string;
  readonly length: number;
  readonly bind: RigTransform;
  readonly inverseBind: readonly [number, number, number, number, number, number];
}

export interface RigMesh {
  readonly id: string;
  readonly positions: RigNumericArray;
  readonly uvs: RigNumericArray;
  readonly indices: RigIndexArray;
  /** CSR offsets: vertexCount + 1 entries into jointIndices/weights. */
  readonly influenceOffsets: RigIndexArray;
  readonly jointIndices: RigIndexArray;
  readonly weights: RigNumericArray;
}

export interface RigDrawable {
  readonly id: string;
  readonly mesh: string;
  readonly texture?: string;
  readonly visible?: boolean;
  readonly solo?: boolean;
  readonly drawOrder: number;
  readonly opacity?: number;
  readonly blendMode?: RigBlendMode;
  readonly culling?: boolean;
  readonly multiplyColor?: readonly [number, number, number, number];
  readonly screenColor?: readonly [number, number, number, number];
  readonly masks?: readonly string[];
  readonly maskMode?: 'alpha' | 'alpha-inverted';
}

export interface RigPath {
  readonly id: string;
  readonly points: RigNumericArray;
  readonly closed?: boolean;
}

export interface RigConstraintBase {
  readonly id: string;
  readonly order: number;
  readonly enabled?: boolean;
  readonly strength: number;
  readonly constrained: string;
  readonly sourceSpace?: RigSpace;
  readonly destinationSpace?: RigSpace;
}

export interface RigIKConstraint extends RigConstraintBase {
  readonly kind: 'ik'; readonly target: string; readonly chainLength: number; readonly invertDirection?: boolean;
  readonly iterations?: number; readonly tolerance?: number; readonly nonConvergence?: 'error' | 'clamp';
}
export interface RigDistanceConstraint extends RigConstraintBase { readonly kind: 'distance'; readonly target: string; readonly distance: number; readonly mode?: 'exact' | 'minimum' | 'maximum'; }
export interface RigTransformConstraint extends RigConstraintBase { readonly kind: 'transform'; readonly target: string; readonly copyFactor?: number; readonly copyFactorY?: number; readonly offset?: RigTransform; readonly min?: RigTransform; readonly max?: RigTransform; }
export interface RigTranslationConstraint extends RigConstraintBase { readonly kind: 'translation'; readonly target: string; readonly copyFactor?: number; readonly copyFactorY?: number; readonly offsetX?: number; readonly offsetY?: number; readonly minX?: number; readonly maxX?: number; readonly minY?: number; readonly maxY?: number; readonly limitSpace?: RigSpace; }
export interface RigScaleConstraint extends RigConstraintBase { readonly kind: 'scale'; readonly target: string; readonly copyFactor?: number; readonly copyFactorY?: number; readonly offsetX?: number; readonly offsetY?: number; readonly minX?: number; readonly maxX?: number; readonly minY?: number; readonly maxY?: number; }
export interface RigRotationConstraint extends RigConstraintBase { readonly kind: 'rotation'; readonly target: string; readonly copyFactor?: number; readonly offset?: number; readonly min?: number; readonly max?: number; }
export interface RigFollowPathConstraint extends RigConstraintBase { readonly kind: 'follow-path'; readonly path: string; readonly distance: number; readonly distanceEnd?: number; readonly offset?: number; readonly orient?: boolean; }
export interface RigScrollConstraint extends RigConstraintBase {
  readonly kind: 'scroll';
  readonly axis: 'x' | 'y' | 'both';
  readonly offsetParameterX?: string;
  readonly offsetParameterY?: string;
  readonly percentParameterX?: string;
  readonly percentParameterY?: string;
  readonly indexParameter?: string;
  readonly velocityParameterX?: string;
  readonly velocityParameterY?: string;
  readonly activeParameter?: string;
  readonly viewport: readonly [number, number];
  readonly content: readonly [number, number];
  readonly infinite?: boolean;
  readonly virtualize?: boolean;
  readonly virtualizeBuffer?: number;
  readonly interactive?: boolean;
  readonly threshold?: number;
  readonly dragMultiplier?: number;
  readonly snap?: number;
  readonly physics?: { readonly kind: 'clamped' | 'elastic'; readonly friction: number; readonly speedMultiplier: number; readonly elasticFactor?: number; readonly threshold?: number };
}
export interface RigScrollBarConstraint extends RigConstraintBase { readonly kind: 'scrollbar'; readonly scrollConstraint: string; readonly autoSize?: boolean; }
export type RigConstraint = RigIKConstraint | RigDistanceConstraint | RigTransformConstraint | RigTranslationConstraint | RigScaleConstraint | RigRotationConstraint | RigFollowPathConstraint | RigScrollConstraint | RigScrollBarConstraint;

export interface RigDriver {
  readonly id: string;
  readonly parameter: string;
  readonly input: readonly [number, number];
  readonly output: readonly [number, number];
  readonly clamp?: boolean;
  readonly mode?: 'replace' | 'add';
  readonly target:
    | { readonly kind: 'bone'; readonly id: string; readonly property: 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY' | 'skew' }
    | { readonly kind: 'constraint'; readonly id: string; readonly property: 'strength' | 'distance' | 'offset' }
    | { readonly kind: 'drawable'; readonly id: string; readonly property: 'opacity' | 'drawOrder' | 'visibility' };
}

export interface RigJoystick {
  readonly id: string;
  readonly xParameter?: string;
  readonly yParameter?: string;
  readonly center: readonly [number, number];
  readonly size: readonly [number, number];
  readonly origin?: readonly [number, number];
  readonly handleDrawable?: string;
  readonly invertX?: boolean;
  readonly invertY?: boolean;
}

export interface ParameterizedRigDefinition {
  readonly id: string;
  readonly bones: readonly RigBone[];
  readonly meshes: readonly RigMesh[];
  readonly drawables: readonly RigDrawable[];
  readonly constraints?: readonly RigConstraint[];
  readonly paths?: readonly RigPath[];
  readonly drivers?: readonly RigDriver[];
  readonly joysticks?: readonly RigJoystick[];
}

export interface RigInstance {
  readonly id: string;
  readonly rig: string;
  readonly parentInstance?: string;
  readonly parentBone?: string;
  readonly transform?: RigTransform;
  readonly parameterMap?: Readonly<Record<string, string>>;
}

export interface ParameterizedRigDocument {
  readonly format: typeof PARAMETERIZED_RIG_FORMAT;
  readonly version: typeof PARAMETERIZED_RIG_VERSION;
  readonly extension: typeof PARAMETERIZED_RIG_EXTENSION_ID;
  readonly width: number;
  readonly height: number;
  readonly duration?: number;
  readonly parameters: readonly RigParameter[];
  readonly rigs: readonly ParameterizedRigDefinition[];
  readonly instances: readonly RigInstance[];
}

export interface ParameterizedRigParseOptions { readonly limits?: Partial<RigLimits>; }
