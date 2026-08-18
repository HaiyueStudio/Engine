import type {
  ShaderResourceReflection,
  ShaderUniformBlockReflection,
  ShaderVaryingReflection,
} from '../contracts';
import type { ShaderGraphV1 } from '../graph/contracts';

export const MOTION_BLUR_POSTPROCESS_PASSES = [
  'motion-tile-max',
  'motion-neighbor-max',
  'motion-blur-resolve',
] as const;

export type MotionBlurPostProcessPass = typeof MOTION_BLUR_POSTPROCESS_PASSES[number];
export type MotionBlurDisplayMode = 'blur' | 'split' | 'velocity';
export type MotionBlurReconstructionMode = 'centered' | 'tile-neighbor-max';

export interface MotionBlurPostProcessResourceIds {
  readonly sourceColor: string;
  readonly velocity: string;
  readonly tileMax: string;
  readonly neighborMax: string;
  readonly sampler: string;
  readonly parameters: string;
  readonly tileParameters: string;
}

export interface MotionBlurPostProcessProgramV1Definition {
  readonly id: string;
  readonly resources: MotionBlurPostProcessResourceIds;
}

export interface CompileMotionBlurPostProcessV1Options {
  /** Physical bind group selected by a renderer adapter. Logical resource space remains `pass`. */
  readonly passGroup?: number;
}

export type MotionBlurPostProcessIrOperation =
  | 'signed-uv-velocity'
  | 'tile-maximum-8x8'
  | 'neighbor-maximum-3x3'
  | 'centered-or-stable-reconstruction'
  | 'dynamic-display-mode';

export interface MotionBlurPostProcessIrNode {
  readonly id: string;
  readonly operation: MotionBlurPostProcessIrOperation;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

/** Aggregate postprocess region of the one canonical Typed Shader IR. */
export interface MotionBlurPostProcessProgramV1 {
  readonly format: 'haiyue-typed-shader-ir';
  readonly version: 1;
  readonly kind: 'postprocess';
  readonly id: string;
  readonly resources: MotionBlurPostProcessResourceIds;
  readonly nodes: readonly MotionBlurPostProcessIrNode[];
  readonly canonicalHash: string;
}

export interface MotionBlurPassReflection {
  readonly pass: MotionBlurPostProcessPass;
  readonly vertexEntryPoint: 'vs_main';
  readonly fragmentEntryPoint: 'fs_main';
  readonly resources: readonly ShaderResourceReflection[];
  readonly uniformBlocks: readonly ShaderUniformBlockReflection[];
  readonly varyings: readonly ShaderVaryingReflection[];
  readonly targetFormatClass: 'color' | 'velocity-rg16float';
}

export interface CompiledMotionBlurPassV1 {
  readonly pass: MotionBlurPostProcessPass;
  readonly code: string;
  readonly canonicalHash: string;
  readonly typedModuleHash: string;
  readonly reflection: MotionBlurPassReflection;
}

export interface MotionBlurPassPlan {
  readonly mode: MotionBlurReconstructionMode;
  readonly passes: readonly MotionBlurPostProcessPass[];
  readonly activeIntermediateTextureCount: number;
  readonly allocatedIntermediateTextureCount: 2;
  readonly compilerSchedulesPasses: false;
}

export interface MotionBlurVariantPolicy {
  readonly dynamicParameters: readonly [
    'shutter-angle',
    'intensity',
    'max-blur-pixels',
    'sample-count',
    'display-mode',
    'split-position',
  ];
  readonly displayModes: readonly ['blur', 'split', 'velocity'];
  readonly specializationVariantCount: 0;
  readonly pipelineCount: 3;
}

export interface CompiledMotionBlurPostProcessV1 {
  readonly program: MotionBlurPostProcessProgramV1;
  readonly typedModuleHash: string;
  readonly passes: Readonly<Record<MotionBlurPostProcessPass, CompiledMotionBlurPassV1>>;
  readonly plans: Readonly<Record<MotionBlurReconstructionMode, MotionBlurPassPlan>>;
  readonly variantPolicy: MotionBlurVariantPolicy;
  readonly generationPlacement: 'compile-or-warmup-only';
}

export interface CompileMotionBlurGraphV1Options {
  readonly id?: string;
  readonly sourceName?: string;
  /** Physical bind group selected by a renderer adapter. Defaults to the logical pass group, 3. */
  readonly passGroup?: number;
}

export interface CompiledMotionBlurGraphV1 {
  readonly graph: ShaderGraphV1;
  readonly program: MotionBlurPostProcessProgramV1;
  readonly compilation: CompiledMotionBlurPostProcessV1;
  readonly eliminatedResourceIds: readonly string[];
}
