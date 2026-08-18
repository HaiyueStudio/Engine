import {
  getPrecompiledShaderPassRuntime,
  type PrecompiledShaderPassRuntime,
} from './PrecompiledShaderRuntime';
import { MATERIAL_LIGHTING_SHADER_ARTIFACT } from '../shaders/generated/material-lighting-artifact.generated';

export type BuiltinMaterialLightingPassId = keyof typeof MATERIAL_LIGHTING_SHADER_ARTIFACT.passes;

/** Internal adapter for the reviewed PBR/Blinn/Toon production family. */
export function getBuiltinMaterialLightingShader(
  device: GPUDevice,
  pass: BuiltinMaterialLightingPassId,
  layouts: readonly GPUBindGroupLayout[],
): PrecompiledShaderPassRuntime {
  return getPrecompiledShaderPassRuntime(
    device,
    MATERIAL_LIGHTING_SHADER_ARTIFACT,
    pass,
    { rendererOwnedLayouts: rendererLayouts(layouts) },
  );
}

function rendererLayouts(layouts: readonly GPUBindGroupLayout[]): Readonly<Record<number, GPUBindGroupLayout>> {
  return Object.freeze(Object.fromEntries(layouts.map((layout, index) => [index, layout])));
}
