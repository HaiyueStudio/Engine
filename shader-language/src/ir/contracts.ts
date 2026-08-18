import type {
  ShaderResourceDefinition,
  ShaderStage,
} from '../contracts';
import type {
  ShaderIrDataType,
  ShaderIrValueType,
  ShaderIrValueTypeDefinition,
} from './types';

export type ShaderIrEntryInputBuiltin =
  | 'vertex_index'
  | 'instance_index'
  | 'position'
  | 'front_facing'
  | 'global_invocation_id';

export type ShaderIrEntryOutputBuiltin = 'position' | 'frag_depth';
export type ShaderIrInterpolation = 'perspective' | 'linear' | 'flat';

export interface ShaderIrSource {
  readonly sourceId: string;
  readonly sourceName?: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

export type ShaderIrNodeOperation =
  | 'input'
  | 'literal'
  | 'uniform-field'
  | 'splat'
  | 'construct'
  | 'cast'
  | 'semantic'
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'dot'
  | 'cross'
  | 'normalize'
  | 'pow'
  | 'sqrt'
  | 'mix'
  | 'clamp'
  | 'sin'
  | 'swizzle'
  | 'texture-sample'
  | 'texture-sample-level'
  | 'derivative-x'
  | 'derivative-y'
  | 'transform-position'
  | 'transform-direction'
  | 'transform-normal'
  | 'srgb-to-linear';

export type ShaderIrPayloadValue = string | number | boolean | readonly number[] | null;

export interface ShaderIrNode {
  readonly id: number;
  readonly operation: ShaderIrNodeOperation;
  readonly type: ShaderIrValueType;
  readonly allowedStages: readonly ShaderStage[];
  readonly operands: readonly number[];
  readonly payload: Readonly<Record<string, ShaderIrPayloadValue>>;
  readonly source: ShaderIrSource;
  /** Additional authoring locations represented by a structurally deduplicated node. */
  readonly sourceAliases?: readonly ShaderIrSource[];
  /** Diagnostic-only provenance. It is deliberately excluded from the canonical hash. */
  readonly optimization?: 'constant-folded';
}

export interface ShaderIrValue {
  readonly type: ShaderIrValueType;
  readonly allowedStages: readonly ShaderStage[];
}

export interface ShaderIrEntryInputDefinition {
  readonly id: string;
  readonly type: ShaderIrValueTypeDefinition;
  readonly location?: number;
  readonly builtin?: ShaderIrEntryInputBuiltin;
  readonly interpolation?: ShaderIrInterpolation;
  readonly source?: ShaderIrSource;
}

export interface ShaderIrEntryInput {
  readonly id: string;
  readonly type: ShaderIrValueType;
  readonly location?: number;
  readonly builtin?: ShaderIrEntryInputBuiltin;
  readonly interpolation?: ShaderIrInterpolation;
  readonly nodeId: number;
  readonly source: ShaderIrSource;
}

export interface ShaderIrEntryOutputDefinition {
  readonly type: ShaderIrValueTypeDefinition;
  readonly location?: number;
  readonly builtin?: ShaderIrEntryOutputBuiltin;
  readonly source?: ShaderIrSource;
}

export interface ShaderIrEntryOutput {
  readonly type: ShaderIrValueType;
  readonly location?: number;
  readonly builtin?: ShaderIrEntryOutputBuiltin;
  readonly nodeId: number;
  readonly source: ShaderIrSource;
}

export interface ShaderIrTextureSampleOptions {
  readonly level?: ShaderIrValue;
  readonly source?: ShaderIrSource;
}

export interface ShaderIrBuilder {
  literal(type: ShaderIrValueTypeDefinition, value: boolean | number | readonly number[], source?: ShaderIrSource): ShaderIrValue;
  uniformField(resourceId: string, fieldId: string, source?: ShaderIrSource): ShaderIrValue;
  splat(value: ShaderIrValue, width: 2 | 3 | 4, source?: ShaderIrSource): ShaderIrValue;
  construct(type: ShaderIrValueTypeDefinition, values: readonly ShaderIrValue[], source?: ShaderIrSource): ShaderIrValue;
  cast(value: ShaderIrValue, dataType: ShaderIrDataType, source?: ShaderIrSource): ShaderIrValue;
  withSemantic(value: ShaderIrValue, type: ShaderIrValueTypeDefinition, source?: ShaderIrSource): ShaderIrValue;
  add(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  subtract(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  multiply(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  divide(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  dot(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  cross(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  normalize(value: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  pow(base: ShaderIrValue, exponent: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  sqrt(value: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  mix(left: ShaderIrValue, right: ShaderIrValue, factor: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  clamp(value: ShaderIrValue, low: ShaderIrValue, high: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  sin(value: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  swizzle(value: ShaderIrValue, pattern: string, source?: ShaderIrSource): ShaderIrValue;
  textureSample(textureId: string, samplerId: string, uv: ShaderIrValue, options?: ShaderIrTextureSampleOptions): ShaderIrValue;
  derivativeX(value: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  derivativeY(value: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
  transformPosition(matrix: ShaderIrValue, position: ShaderIrValue, toSpace: ShaderIrValueType['coordinateSpace'], source?: ShaderIrSource): ShaderIrValue;
  transformDirection(matrix: ShaderIrValue, direction: ShaderIrValue, toSpace: ShaderIrValueType['coordinateSpace'], source?: ShaderIrSource): ShaderIrValue;
  transformNormal(matrix: ShaderIrValue, normal: ShaderIrValue, toSpace: ShaderIrValueType['coordinateSpace'], source?: ShaderIrSource): ShaderIrValue;
  srgbToLinear(color: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue;
}

export interface ShaderIrEntryDefinition {
  readonly id: string;
  readonly stage: ShaderStage;
  readonly name: string;
  readonly inputs?: readonly ShaderIrEntryInputDefinition[];
  readonly output?: ShaderIrEntryOutputDefinition;
  readonly source?: ShaderIrSource;
  readonly build: (
    builder: ShaderIrBuilder,
    inputs: Readonly<Record<string, ShaderIrValue>>,
  ) => ShaderIrValue | null;
}

export interface ShaderIrEntry {
  readonly id: string;
  readonly stage: ShaderStage;
  readonly name: string;
  readonly inputs: readonly ShaderIrEntryInput[];
  readonly output: ShaderIrEntryOutput | null;
  readonly nodes: readonly ShaderIrNode[];
  readonly source: ShaderIrSource;
}

export interface ShaderIrProgram {
  readonly format: 'haiyue-typed-shader-ir';
  readonly version: 1;
  readonly id: string;
  readonly resources: readonly ShaderResourceDefinition[];
  readonly entries: readonly ShaderIrEntry[];
  readonly canonicalHash: string;
}

export interface ShaderIrProgramDefinition {
  readonly id: string;
  readonly resources?: readonly ShaderResourceDefinition[];
  readonly entries: readonly ShaderIrEntryDefinition[];
}
