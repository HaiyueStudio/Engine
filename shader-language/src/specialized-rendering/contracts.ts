import type { PrecompiledShaderArtifactV2 } from '../adapter/precompiled-v2';

export const PRODUCTION_SPECIALIZED_RENDERING_OPERATIONS = [
  'instanced-mesh3d',
  'line3d',
  'planar-mirror',
  'volume',
  'texture-convolution',
  'mipmap',
  'equirectangular-to-cube',
] as const;

export type ProductionSpecializedRenderingOperation = typeof PRODUCTION_SPECIALIZED_RENDERING_OPERATIONS[number];

export interface ProductionSpecializedRenderingFamilyPassV1 {
  readonly id: string;
  readonly operation: ProductionSpecializedRenderingOperation;
}

export interface ProductionSpecializedRenderingFamilyV1 {
  readonly format: 'haiyue-production-specialized-rendering-family';
  readonly version: 1;
  readonly id: string;
  readonly abiVersion: 1;
  readonly passes: readonly ProductionSpecializedRenderingFamilyPassV1[];
  readonly canonicalHash: string;
}

export interface CompileProductionSpecializedRenderingFamilyV1Options {
  readonly sourcePath: string;
  readonly sourceSha256: string;
}

export interface CompiledProductionSpecializedRenderingPassV1 {
  readonly id: string;
  readonly operation: ProductionSpecializedRenderingOperation;
  readonly code: string;
}

export interface CompiledProductionSpecializedRenderingFamilyV1 {
  readonly family: ProductionSpecializedRenderingFamilyV1;
  readonly specializedModuleHash: string;
  readonly passes: Readonly<Record<string, CompiledProductionSpecializedRenderingPassV1>>;
  readonly artifact: PrecompiledShaderArtifactV2;
}
