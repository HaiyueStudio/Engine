import {
  getPrecompiledShaderPassRuntime,
  type PrecompiledShaderPassRuntime,
} from './PrecompiledShaderRuntime';
import { BUILTIN_RENDER_SHADER_ARTIFACT as BUILTIN_SIMPLE_3D_SHADER_ARTIFACT } from '../shaders/generated/simple3d-artifact.generated';

export type BuiltinSimple3dPassId = keyof typeof BUILTIN_SIMPLE_3D_SHADER_ARTIFACT.passes;

/** Internal adapter isolated from 2D so each renderer retains only its own family artifact. */
export function getBuiltinSimple3dShader(
  device: GPUDevice,
  pass: BuiltinSimple3dPassId,
  layouts: readonly GPUBindGroupLayout[],
): PrecompiledShaderPassRuntime {
  return getPrecompiledShaderPassRuntime(
    device,
    BUILTIN_SIMPLE_3D_SHADER_ARTIFACT,
    pass,
    { rendererOwnedLayouts: rendererLayouts(layouts) },
  );
}

function rendererLayouts(layouts: readonly GPUBindGroupLayout[]): Readonly<Record<number, GPUBindGroupLayout>> {
  return Object.freeze(Object.fromEntries(layouts.map((layout, index) => [index, layout])));
}
