import type { PrecompiledShaderArtifactV2 } from '../adapter/precompiled-v2';

export const PRODUCTION_DEFORMATION_OPERATIONS = [
  'forward',
  'forward-skinned',
  'depth',
  'shadow',
  'shadow-morph',
  'shadow-skinned',
  'shadow-skinned-morph',
  'motion-vector',
  'outline',
] as const;

export type ProductionDeformationOperation = typeof PRODUCTION_DEFORMATION_OPERATIONS[number];

export interface ProductionDeformationFamilyPassV1 {
  readonly id: string;
  readonly operation: ProductionDeformationOperation;
}

export interface ProductionDeformationFamilyV1 {
  readonly format: 'haiyue-production-deformation-family';
  readonly version: 1;
  readonly id: string;
  readonly abiVersion: 1;
  readonly passes: readonly ProductionDeformationFamilyPassV1[];
  readonly canonicalHash: string;
}

export interface CompileProductionDeformationFamilyV1Options {
  readonly sourcePath: string;
  readonly sourceSha256: string;
}

export interface CompiledProductionDeformationPassV1 {
  readonly id: string;
  readonly operation: ProductionDeformationOperation;
  readonly code: string;
}

export interface CompiledProductionDeformationFamilyV1 {
  readonly family: ProductionDeformationFamilyV1;
  readonly deformationModuleHash: string;
  readonly passes: Readonly<Record<string, CompiledProductionDeformationPassV1>>;
  readonly artifact: PrecompiledShaderArtifactV2;
  readonly featureModules: {
    readonly morph: string;
    readonly skinning: string;
  };
}
