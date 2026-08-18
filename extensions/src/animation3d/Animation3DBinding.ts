/**
 * Logical targets keep authored clips independent from a concrete ECS World.
 * A runtime resolver maps one of these stable references to an actual target.
 */
export type Animation3DBindingTarget =
  | Readonly<{
      kind: 'node-id';
      nodeId: string;
    }>
  | Readonly<{
      kind: 'node-path';
      segments: readonly string[];
    }>
  | Readonly<{
      kind: 'slot';
      slot: string;
    }>;

export type Animation3DFixedValueType =
  | 'scalar'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'quaternion';

export type Animation3DValueType =
  | Animation3DFixedValueType
  | 'weights';

export interface Animation3DTranslationBinding {
  readonly id: string;
  readonly target: Animation3DBindingTarget;
  readonly path: 'transform.translation';
  readonly valueType: 'vec3';
  readonly valueSize: 3;
}

export interface Animation3DRotationBinding {
  readonly id: string;
  readonly target: Animation3DBindingTarget;
  readonly path: 'transform.rotation';
  readonly valueType: 'quaternion';
  readonly valueSize: 4;
}

export interface Animation3DScaleBinding {
  readonly id: string;
  readonly target: Animation3DBindingTarget;
  readonly path: 'transform.scale';
  readonly valueType: 'vec3';
  readonly valueSize: 3;
}

export interface Animation3DMorphWeightsBinding {
  readonly id: string;
  readonly target: Animation3DBindingTarget;
  readonly path: 'morph.weights';
  readonly valueType: 'weights';
  /** Positive morph target count. Loaders must reject zero or negative values. */
  readonly valueSize: number;
}

export type Animation3DFixedValueSize = {
  readonly scalar: 1;
  readonly vec2: 2;
  readonly vec3: 3;
  readonly vec4: 4;
  readonly quaternion: 4;
};

export type Animation3DPropertyBinding = {
  [TValueType in Animation3DFixedValueType]: Readonly<{
    id: string;
    target: Animation3DBindingTarget;
    path: 'property';
    /** Stable component or adapter namespace, never a constructor reference. */
    component: string;
    property: string;
    valueType: TValueType;
    valueSize: Animation3DFixedValueSize[TValueType];
  }>;
}[Animation3DFixedValueType];

export type Animation3DBinding =
  | Animation3DTranslationBinding
  | Animation3DRotationBinding
  | Animation3DScaleBinding
  | Animation3DMorphWeightsBinding
  | Animation3DPropertyBinding;

export interface Animation3DResolvedBinding<
  TBinding extends Animation3DBinding = Animation3DBinding,
> {
  readonly binding: TBinding;
  /** Writes exactly binding.valueSize values into out. */
  read(out: Float32Array): void;
  /** Reads exactly binding.valueSize values from value. */
  write(value: ArrayLike<number>): void;
}

/**
 * Resolver revisions invalidate cached resolved bindings after hierarchy or
 * component structure changes.
 */
export interface Animation3DBindingResolver {
  readonly revision: number;
  resolve<TBinding extends Animation3DBinding>(
    binding: TBinding,
  ): Animation3DResolvedBinding<TBinding> | null;
}

export interface Animation3DBindingMask {
  /** Empty or omitted include means all bindings are eligible. */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}
