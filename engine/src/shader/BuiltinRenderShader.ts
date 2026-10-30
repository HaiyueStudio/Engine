import {
  getPrecompiledShaderPassRuntime,
  type PrecompiledShaderPassRuntime,
} from './PrecompiledShaderRuntime';
import {
  BUILTIN_RENDER_SHADER_ARTIFACT as BUILTIN_2D_UI_SHADER_ARTIFACT,
  BUILTIN_RENDER_SHADER_METADATA,
  BUILTIN_RENDER_SHADER_PASS_GUI_IMAGE,
  BUILTIN_RENDER_SHADER_PASS_GUI_SHAPE,
  BUILTIN_RENDER_SHADER_PASS_GUI_TEXT,
} from '../shaders/generated/2d-ui-artifact.generated';

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

// A selected immutable family view, sharing exact pass objects/provenance/cache identity.
const guiArtifact = {...BUILTIN_RENDER_SHADER_METADATA, passes: {
  'gui-image': BUILTIN_RENDER_SHADER_PASS_GUI_IMAGE,
  'gui-shape': BUILTIN_RENDER_SHADER_PASS_GUI_SHAPE,
  'gui-text': BUILTIN_RENDER_SHADER_PASS_GUI_TEXT,
}};
export function getBuiltinGuiShader(device:GPUDevice, pass:keyof typeof guiArtifact.passes,
    layouts:readonly GPUBindGroupLayout[]):PrecompiledShaderPassRuntime {
  return getPrecompiledShaderPassRuntime(device,guiArtifact,pass,{rendererOwnedLayouts:rendererLayouts(layouts)});
}
