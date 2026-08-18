import type { PrecompiledShaderArtifactV2 } from '../adapter/precompiled-v2';

export const BUILTIN_POSTPROCESS_OPERATIONS = [
  'present',
  'grayscale',
  'sobel',
  'fxaa',
  'gaussian-blur',
  'outline-edge',
  'outline-blur',
  'outline-overlay',
  'taa',
  'ssao',
  'sao',
  'gtao',
  'ao-denoise',
  'ao-upscale',
] as const;

export type BuiltinPostprocessOperation = typeof BUILTIN_POSTPROCESS_OPERATIONS[number];

export interface BuiltinPostprocessPassV1 {
  readonly id: string;
  readonly operation: BuiltinPostprocessOperation;
}

export interface BuiltinPostprocessFamilyV1 {
  readonly format: 'haiyue-builtin-postprocess-family';
  readonly version: 1;
  readonly id: string;
  readonly passes: readonly BuiltinPostprocessPassV1[];
  readonly canonicalHash: string;
}

export interface CompileBuiltinPostprocessFamilyV1Options {
  readonly sourcePath: string;
  readonly sourceSha256: string;
  /** Renderer-selected physical group. The logical resource space remains `pass`. */
  readonly passGroup?: number;
}

export interface CompiledBuiltinPostprocessPassV1 {
  readonly id: string;
  readonly operation: BuiltinPostprocessOperation;
  readonly fragmentSource: string;
  readonly code: string;
}

export interface CompiledBuiltinPostprocessFamilyV1 {
  readonly family: BuiltinPostprocessFamilyV1;
  readonly fullscreenVertexSource: string;
  readonly passes: Readonly<Record<string, CompiledBuiltinPostprocessPassV1>>;
  readonly artifact: PrecompiledShaderArtifactV2;
}
