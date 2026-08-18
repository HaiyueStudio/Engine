import type { PrecompiledShaderArtifactV2 } from '../adapter/precompiled-v2';

export const BUILTIN_RENDER_FAMILY_KINDS = ['2d-ui', 'simple-3d'] as const;
export type BuiltinRenderFamilyKind = typeof BUILTIN_RENDER_FAMILY_KINDS[number];

export const BUILTIN_RENDER_OPERATIONS = {
  '2d-ui': [
    'animation-2d',
    'bitmap-text',
    'canvas-text-2d',
    'gui-image',
    'gui-shape',
    'gui-text',
    'mesh2d',
    'particle2d',
    'radial-shadow',
    'spine2d',
    'tilemap2d',
  ],
  'simple-3d': [
    'basic-material',
    'basic-material-skinned',
    'mesh-helper',
    'normal-material',
    'particle3d',
    'sky',
  ],
} as const;

export type BuiltinRenderOperation =
  typeof BUILTIN_RENDER_OPERATIONS[BuiltinRenderFamilyKind][number];

export interface BuiltinRenderFamilyPassV1 {
  readonly id: string;
  readonly operation: BuiltinRenderOperation;
}

export interface BuiltinRenderFamilyV1 {
  readonly format: 'haiyue-builtin-render-family';
  readonly version: 1;
  readonly id: string;
  readonly kind: BuiltinRenderFamilyKind;
  readonly passes: readonly BuiltinRenderFamilyPassV1[];
  readonly canonicalHash: string;
}

export interface CompileBuiltinRenderFamilyV1Options {
  readonly sourcePath: string;
  readonly sourceSha256: string;
}

export interface CompiledBuiltinRenderPassV1 {
  readonly id: string;
  readonly operation: BuiltinRenderOperation;
  readonly code: string;
}

export interface CompiledBuiltinRenderFamilyV1 {
  readonly family: BuiltinRenderFamilyV1;
  readonly passes: Readonly<Record<string, CompiledBuiltinRenderPassV1>>;
  readonly artifact: PrecompiledShaderArtifactV2;
}
