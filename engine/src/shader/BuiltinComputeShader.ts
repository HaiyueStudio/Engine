import {
  getPrecompiledShaderPassRuntime,
  PRECOMPILED_SHADER_STAGE_FLAGS,
  type PrecompiledShaderPassV2,
  type PrecompiledShaderPassRuntime,
} from './PrecompiledShaderRuntime';
import { COMPUTE_SHADER_ARTIFACT } from '../shaders/generated/compute-artifact.generated';

export type BuiltinComputePassId = keyof typeof COMPUTE_SHADER_ARTIFACT.passes;
export type BuiltinComputeRuntime = Omit<PrecompiledShaderPassRuntime, 'pass'> & {
  readonly pass: PrecompiledShaderPassV2;
};

/** Internal device adapter for compiler-owned production compute passes. */
export function getBuiltinComputeShader(device: GPUDevice, pass: BuiltinComputePassId): BuiltinComputeRuntime {
  return getPrecompiledShaderPassRuntime(device, COMPUTE_SHADER_ARTIFACT, pass) as BuiltinComputeRuntime;
}

/** Reflection-only adapter used by the lazy ComputePassBase lifecycle before a device is available. */
export function getBuiltinComputeShaderDefinition(passId: BuiltinComputePassId): {
  readonly pass: PrecompiledShaderPassV2;
  readonly shaderCode: string;
  readonly entryPoint: string;
  readonly bindGroupLayoutEntries: readonly GPUBindGroupLayoutEntry[];
} {
  const pass = COMPUTE_SHADER_ARTIFACT.passes[passId] as PrecompiledShaderPassV2;
  const group = pass.bindGroups[0];
  if (!group || group.owner !== 'artifact') throw new Error(`Builtin compute pass ${passId} must own group 0.`);
  return Object.freeze({
    pass,
    shaderCode: pass.code,
    entryPoint: pass.entryPoints.compute!,
    bindGroupLayoutEntries: Object.freeze(group.bindings.map(binding => {
      if (binding.layout.kind !== 'buffer') throw new Error(`Builtin compute binding ${binding.id} must be a buffer.`);
      return Object.freeze({
        binding: binding.binding,
        visibility: PRECOMPILED_SHADER_STAGE_FLAGS.compute,
        buffer: Object.freeze({
          type: binding.layout.bufferType,
          hasDynamicOffset: binding.layout.hasDynamicOffset,
          minBindingSize: binding.layout.minBindingSize,
        }),
      });
    })),
  });
}
