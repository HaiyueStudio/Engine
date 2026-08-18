import {
  getPrecompiledShaderPassRuntime,
  type PrecompiledShaderPassV2,
  type PrecompiledShaderPassRuntime,
} from './PrecompiledShaderRuntime';
import { SPECIALIZED_RENDERING_SHADER_ARTIFACT } from '../shaders/generated/specialized-rendering-artifact.generated';

export type BuiltinSpecializedRenderingPassId = keyof typeof SPECIALIZED_RENDERING_SHADER_ARTIFACT.passes;
export type BuiltinSpecializedRenderingRuntime = Omit<PrecompiledShaderPassRuntime, 'pass'> & {
  readonly pass: PrecompiledShaderPassV2;
};

/** Internal adapter for the reviewed specialized render/texture utility family. */
export function getBuiltinSpecializedRenderingShader(
  device: GPUDevice,
  pass: BuiltinSpecializedRenderingPassId,
  layouts: readonly GPUBindGroupLayout[] = [],
): BuiltinSpecializedRenderingRuntime {
  return getPrecompiledShaderPassRuntime(
    device,
    SPECIALIZED_RENDERING_SHADER_ARTIFACT,
    pass,
    layouts.length === 0 ? {} : { rendererOwnedLayouts: rendererLayouts(layouts) },
  ) as BuiltinSpecializedRenderingRuntime;
}

function rendererLayouts(layouts: readonly GPUBindGroupLayout[]): Readonly<Record<number, GPUBindGroupLayout>> {
  return Object.freeze(Object.fromEntries(layouts.map((layout, index) => [index, layout])));
}
