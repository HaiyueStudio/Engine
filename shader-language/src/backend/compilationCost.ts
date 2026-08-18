import type { ShaderIrOptimizationReport } from '../ir/optimizer';

export interface ShaderCompilationCostOptions {
  /** Number of source variants represented by this compilation cohort (defaults to this one artifact). */
  readonly variantCount?: number;
  /** Number of pipelines represented by this compilation cohort (defaults to this one artifact). */
  readonly pipelineCount?: number;
}

export interface ShaderCompilationPhaseTimings {
  readonly validation: number;
  readonly optimization: number;
  readonly bindingPlan: number;
  readonly codeGeneration: number;
  readonly total: number;
}

export interface ShaderCompilationCostEvidence {
  readonly schema: 'haiyue-shader-compilation-cost@1';
  readonly sourceBytes: number;
  readonly irNodeCountBeforeOptimization: number;
  readonly irReachableNodeCountBeforeOptimization: number;
  readonly irNodeCountAfterOptimization: number;
  readonly constantFoldedNodeCount: number;
  readonly commonSubexpressionEliminatedNodeCount: number;
  readonly protectedOperationCounts: ShaderIrOptimizationReport['protectedOperationCounts'];
  readonly variantCount: number;
  readonly pipelineCount: number;
  readonly phaseMs: ShaderCompilationPhaseTimings;
  readonly scope: Readonly<{
    compilerOwnedPbrFullSourceVariants: 'not-reduced';
    productionArtifactPooling: 'deferred';
    overrideSpecialization: 'deferred';
  }>;
}

export function createShaderCompilationCostEvidence(
  source: string,
  optimization: ShaderIrOptimizationReport,
  phaseMs: ShaderCompilationPhaseTimings,
  options: ShaderCompilationCostOptions,
): ShaderCompilationCostEvidence {
  return Object.freeze({
    schema: 'haiyue-shader-compilation-cost@1' as const,
    sourceBytes: new TextEncoder().encode(source).byteLength,
    irNodeCountBeforeOptimization: optimization.inputNodeCount,
    irReachableNodeCountBeforeOptimization: optimization.reachableNodeCountBeforeOptimization,
    irNodeCountAfterOptimization: optimization.outputNodeCount,
    constantFoldedNodeCount: optimization.constantFoldedNodeCount,
    commonSubexpressionEliminatedNodeCount: optimization.commonSubexpressionEliminatedNodeCount,
    protectedOperationCounts: optimization.protectedOperationCounts,
    variantCount: positiveCount(options.variantCount ?? 1, 'variantCount'),
    pipelineCount: positiveCount(options.pipelineCount ?? 1, 'pipelineCount'),
    phaseMs: Object.freeze({ ...phaseMs }),
    scope: Object.freeze({
      compilerOwnedPbrFullSourceVariants: 'not-reduced' as const,
      productionArtifactPooling: 'deferred' as const,
      overrideSpecialization: 'deferred' as const,
    }),
  });
}

export function compilationNowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function positiveCount(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}
