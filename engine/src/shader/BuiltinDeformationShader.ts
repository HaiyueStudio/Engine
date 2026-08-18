import {
  getPrecompiledShaderPassRuntime,
  type PrecompiledShaderPassRuntime,
} from './PrecompiledShaderRuntime';
import { DEFORMATION_SHADER_ARTIFACT } from '../shaders/generated/deformation-artifact.generated';

export type BuiltinDeformationPassId = keyof typeof DEFORMATION_SHADER_ARTIFACT.passes;

/** Internal adapter kept separate so non-deformation renderers do not retain the family artifact. */
export function getBuiltinDeformationShader(
  device: GPUDevice,
  pass: BuiltinDeformationPassId,
  layouts: readonly GPUBindGroupLayout[],
): PrecompiledShaderPassRuntime {
  return getPrecompiledShaderPassRuntime(
    device,
    DEFORMATION_SHADER_ARTIFACT,
    pass,
    { rendererOwnedLayouts: rendererLayouts(layouts) },
  );
}

function rendererLayouts(layouts: readonly GPUBindGroupLayout[]): Readonly<Record<number, GPUBindGroupLayout>> {
  return Object.freeze(Object.fromEntries(layouts.map((layout, index) => [index, layout])));
}
