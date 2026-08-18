import type { PrecompiledShaderArtifactV2 } from '../adapter/precompiled-v2';

export const PRODUCTION_MATERIAL_LIGHTING_OPERATIONS = [
  'pbr',
  'pbr-clearcoat',
  'pbr-transmission',
  'pbr-transmission-clearcoat',
  'blinn-phong',
  'toon',
] as const;

export type ProductionMaterialLightingOperation = typeof PRODUCTION_MATERIAL_LIGHTING_OPERATIONS[number];

export interface ProductionMaterialLightingFamilyPassV1 {
  readonly id: string;
  readonly operation: ProductionMaterialLightingOperation;
}

export interface ProductionMaterialLightingFamilyV1 {
  readonly format: 'haiyue-production-material-lighting-family';
  readonly version: 1;
  readonly id: string;
  readonly abiVersion: 1;
  readonly passes: readonly ProductionMaterialLightingFamilyPassV1[];
  readonly canonicalHash: string;
}

export interface CompileProductionMaterialLightingFamilyV1Options {
  readonly sourcePath: string;
  readonly sourceSha256: string;
}

export interface CompiledProductionMaterialLightingPassV1 {
  readonly id: string;
  readonly operation: ProductionMaterialLightingOperation;
  readonly code: string;
}

export interface CompiledProductionMaterialLightingFamilyV1 {
  readonly family: ProductionMaterialLightingFamilyV1;
  readonly lightingModuleHash: string;
  readonly deformationModuleHash: string;
  readonly passes: Readonly<Record<string, CompiledProductionMaterialLightingPassV1>>;
  readonly artifact: PrecompiledShaderArtifactV2;
  readonly featureModules: {
    readonly fog: string;
    readonly pbrBrdf: string;
  };
}
