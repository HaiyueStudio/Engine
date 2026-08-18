import { getPrecompiledShaderPassRuntime, type PrecompiledShaderPassRuntime } from '../shader/PrecompiledShaderRuntime';
import { BUILTIN_POSTPROCESS_SHADER_ARTIFACT } from '../shaders/generated/postprocess-builtins-artifact.generated';

export type BuiltinPostprocessPassId = keyof typeof BUILTIN_POSTPROCESS_SHADER_ARTIFACT.passes;

/** Internal build-artifact adapter. No compiler or WGSL assembly is allowed on this path. */
export function getBuiltinPostprocessShader(
  device: GPUDevice,
  pass: BuiltinPostprocessPassId,
): PrecompiledShaderPassRuntime {
  return getPrecompiledShaderPassRuntime(device, BUILTIN_POSTPROCESS_SHADER_ARTIFACT, pass);
}
