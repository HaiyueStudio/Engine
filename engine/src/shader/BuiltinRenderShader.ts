import {
  getPrecompiledShaderPassRuntime,
  type PrecompiledShaderPassRuntime,
} from './PrecompiledShaderRuntime';
import { BUILTIN_RENDER_SHADER_ARTIFACT as BUILTIN_2D_UI_SHADER_ARTIFACT } from '../shaders/generated/2d-ui-artifact.generated';

export type Builtin2dUiPassId = keyof typeof BUILTIN_2D_UI_SHADER_ARTIFACT.passes;

/** Internal build-artifact adapter. Renderer-owned layouts keep the existing production ABI. */
export function getBuiltin2dUiShader(
  device: GPUDevice,
  pass: Builtin2dUiPassId,
  layouts: readonly GPUBindGroupLayout[],
): PrecompiledShaderPassRuntime {
  return getPrecompiledShaderPassRuntime(
    device,
    BUILTIN_2D_UI_SHADER_ARTIFACT,
    pass,
    { rendererOwnedLayouts: rendererLayouts(layouts) },
  );
}

function rendererLayouts(layouts: readonly GPUBindGroupLayout[]): Readonly<Record<number, GPUBindGroupLayout>> {
  return Object.freeze(Object.fromEntries(layouts.map((layout, index) => [index, layout])));
}
