import { getPrecompiledShaderPassRuntime, type PrecompiledShaderPassRuntime } from '../shader/PrecompiledShaderRuntime';
import { AMBIENT_OCCLUSION_SHADER_ARTIFACT } from '../shaders/generated/postprocess-ambient-occlusion-artifact.generated';

export type AmbientOcclusionShaderPassId = keyof typeof AMBIENT_OCCLUSION_SHADER_ARTIFACT.passes;

/** AO-only artifact adapter so unrelated postprocess consumers do not retain three large shader sources. */
export function getAmbientOcclusionShader(
  device: GPUDevice,
  pass: AmbientOcclusionShaderPassId,
): PrecompiledShaderPassRuntime {
  return getPrecompiledShaderPassRuntime(device, AMBIENT_OCCLUSION_SHADER_ARTIFACT, pass);
}
