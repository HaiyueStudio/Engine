import type {
  ShaderResourceReflection,
  ShaderUniformBlockReflection,
  ShaderVaryingReflection,
} from '../contracts';

export const DEFORMATION_PASS_KINDS = [
  'forward',
  'depth',
  'shadow',
  'motion-vector',
  'outline-selection',
] as const;

export type DeformationPassKind = typeof DEFORMATION_PASS_KINDS[number];

export interface NormalSineDisplacementV1 {
  readonly kind: 'normal-sine';
}

export interface DeformationProgramV1Definition {
  readonly id: string;
  readonly morphTargetCount: number;
  readonly jointCount: number;
  readonly displacement: NormalSineDisplacementV1;
}

export type DeformationIrOperation =
  | 'morph-target-blend'
  | 'linear-blend-skinning'
  | 'object-normal-sine-displacement';

export interface DeformationIrNode {
  readonly id: string;
  readonly operation: DeformationIrOperation;
  readonly input: string;
  readonly output: string;
}

/**
 * Aggregate vertex-deformation region of the canonical Typed Shader IR. It is
 * deliberately smaller than a material graph: authoring data contains no
 * WGSL, bindings, renderer handles, pass names, or animation sampler semantics.
 */
export interface DeformationProgramV1 {
  readonly format: 'haiyue-typed-shader-ir';
  readonly version: 1;
  readonly kind: 'vertex-deformation';
  readonly id: string;
  readonly morphTargetCount: number;
  readonly jointCount: number;
  readonly displacement: NormalSineDisplacementV1;
  readonly nodes: readonly DeformationIrNode[];
  readonly canonicalHash: string;
}

export interface DeformationVertexAttributeReflection {
  readonly semantic: string;
  readonly location: number;
  readonly format: DeformationVertexFormat;
  readonly shaderType: string;
}

export type DeformationVertexFormat = 'float32x3' | 'float32x4';

export interface DeformationPassReflection {
  readonly pass: DeformationPassKind;
  readonly vertexEntryPoint: string;
  readonly fragmentEntryPoint: string;
  readonly vertexAttributes: readonly DeformationVertexAttributeReflection[];
  readonly varyings: readonly ShaderVaryingReflection[];
  readonly resources: readonly ShaderResourceReflection[];
  readonly uniformBlocks: readonly ShaderUniformBlockReflection[];
  readonly historySemantics: 'current-only' | 'current-and-previous-same-ir';
  readonly alphaCoverage: 'opaque';
}

export interface CompiledDeformationPassV1 {
  readonly pass: DeformationPassKind;
  readonly code: string;
  /** Byte-identical prefix shared by every derived pass. */
  readonly sharedDeformationSource: string;
  readonly deformationModuleHash: string;
  readonly canonicalHash: string;
  readonly reflection: DeformationPassReflection;
}

export interface CompiledDeformationPassFamilyV1 {
  readonly program: DeformationProgramV1;
  readonly deformationModuleHash: string;
  readonly passes: Readonly<Record<DeformationPassKind, CompiledDeformationPassV1>>;
}

export interface DeformationHistoryState {
  readonly modelMatrix: ArrayLike<number>;
  readonly viewProjectionMatrix: ArrayLike<number>;
  readonly morphWeights: ArrayLike<number>;
  readonly jointMatrices: ArrayLike<number>;
  readonly displacement: ArrayLike<number>;
}

export interface DeformationHistorySample {
  readonly current: DeformationHistorySnapshot;
  readonly previous: DeformationHistorySnapshot;
  readonly reset: boolean;
  readonly resetReason: string | null;
}

export interface DeformationHistorySnapshot {
  readonly modelMatrix: Float32Array;
  readonly viewProjectionMatrix: Float32Array;
  readonly morphWeights: Float32Array;
  readonly jointMatrices: Float32Array;
  readonly displacement: Float32Array;
}

export interface DeformationHistoryAudit {
  readonly state: 'active' | 'disposed';
  readonly entryCount: number;
  readonly viewCount: number;
  readonly entityCount: number;
}
