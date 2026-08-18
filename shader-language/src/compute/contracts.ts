import type { PrecompiledShaderArtifactV2 } from '../adapter/precompiled-v2';

export const PRODUCTION_COMPUTE_OPERATIONS = [
  'gpu-draw-command',
  'gpu-sort-bitonic',
  'instanced-cull',
  'instanced-depth-sort-key',
  'mesh3d-cull',
] as const;

export type ProductionComputeOperation = typeof PRODUCTION_COMPUTE_OPERATIONS[number];
export type ComputeResourceKindV1 = 'uniform-buffer' | 'storage-buffer';
export type ComputeResourceAccessV1 = 'read' | 'read-write' | 'atomic-read-write';
export type ComputeEffectKindV1 = 'store' | 'atomic-add';
export type ComputeDispatchDomainV1 = 'command-count' | 'padded-count' | 'instance-count';
export type ComputeDispatchScheduleV1 = 'single' | 'bitonic-network';

export interface ComputeResourceIrV1 {
  readonly id: string;
  readonly binding: number;
  readonly kind: ComputeResourceKindV1;
  readonly access: ComputeResourceAccessV1;
  readonly minBindingSize: number;
}

export interface ComputeEffectIrV1 {
  readonly kind: ComputeEffectKindV1;
  readonly resource: string;
}

export interface ComputeDispatchIrV1 {
  readonly domain: ComputeDispatchDomainV1;
  readonly schedule: ComputeDispatchScheduleV1;
  readonly ceilDivisor: readonly [number, number, number];
}

/** Compiler-owned representation of a compute pass with explicit side effects and dispatch semantics. */
export interface ProductionComputePassIrV1 {
  readonly id: string;
  readonly operation: ProductionComputeOperation;
  readonly entryPoint: 'cs_main';
  readonly workgroupSize: readonly [number, number, number];
  readonly dispatch: ComputeDispatchIrV1;
  readonly resources: readonly ComputeResourceIrV1[];
  readonly effects: readonly ComputeEffectIrV1[];
  readonly canonicalHash: string;
}

export interface ProductionComputeFamilyV1 {
  readonly format: 'haiyue-production-compute-family';
  readonly version: 1;
  readonly id: string;
  readonly abiVersion: 1;
  readonly passes: readonly ProductionComputePassIrV1[];
  readonly canonicalHash: string;
}

export interface CompileProductionComputeFamilyV1Options {
  readonly sourcePath: string;
  readonly sourceSha256: string;
}

export interface CompiledProductionComputePassV1 {
  readonly id: string;
  readonly operation: ProductionComputeOperation;
  readonly ir: ProductionComputePassIrV1;
  readonly code: string;
}

export interface CompiledProductionComputeFamilyV1 {
  readonly family: ProductionComputeFamilyV1;
  readonly computeModuleHash: string;
  readonly passes: Readonly<Record<string, CompiledProductionComputePassV1>>;
  readonly artifact: PrecompiledShaderArtifactV2;
}
