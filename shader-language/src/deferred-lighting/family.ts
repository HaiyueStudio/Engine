import type { PrecompiledShaderPassV2, PrecompiledShaderPassV2Definition, PrecompiledShaderBindingV2, PrecompiledShaderUniformBlockV2 } from '../adapter/precompiled-v2';

export interface DeferredFamilyModules {
  readonly geometry: string;
  readonly resolve: string;
  readonly abi: string;
  readonly scene: string;
  readonly fog: string;
  readonly brdf: string;
  readonly shadow: string;
  readonly viewHeader: PrecompiledShaderUniformBlockV2;
}

/** Trusted WGSL specialization of the reviewed PBR family, retaining its exact surface/deformation ABI. */
export function buildDeferredLightingPasses(base: PrecompiledShaderPassV2, modules: DeferredFamilyModules): readonly PrecompiledShaderPassV2Definition[] {
  const entry = '@fragment\nfn fs_main';
  const parts = base.code.split(entry);
  if (parts.length !== 2 || !parts[0]!.includes('fn sampleStandardPbrSurface(')) {
    throw new Error('PBR family must expose the shared standard surface module before its fragment entry.');
  }
  const geometryCode = parts[0]! + modules.geometry;
  const shadow = modules.shadow.replaceAll('MAX_DIRECTIONAL_SHADOWS', '3u')
    .replace('@binding(5)', '@binding(12)').replace('@binding(6)', '@binding(13)').replace('@binding(7)', '@binding(14)');
  const resolveCode = [modules.fog, modules.scene, modules.brdf, modules.abi, shadow, modules.resolve].join('\n\n');
  const buffer = (id: string, binding: number, bufferType: 'uniform' | 'read-only-storage', minBindingSize: number): PrecompiledShaderBindingV2 => ({
    id, binding, visibility: ['fragment'], layout: { kind: 'buffer', bufferType, minBindingSize, hasDynamicOffset: false },
  });
  const texture = (id: string, binding: number, depth = false, viewDimension: '2d' | 'cube' | '2d-array' = '2d'): PrecompiledShaderBindingV2 => ({
    id, binding, visibility: ['fragment'], layout: { kind: 'texture', sampleType: depth ? 'depth' : 'float', viewDimension, multisampled: false },
  });
  const sampler = (id: string, binding: number, samplerType: 'filtering' | 'comparison'): PrecompiledShaderBindingV2 => ({
    id, binding, visibility: ['fragment'], layout: { kind: 'sampler', samplerType },
  });
  const frame = base.bindGroups[0]!;
  const reflection = base.uniformBlocks;
  return [
    { ...base, id: 'deferred-gbuffer', code: geometryCode,
      renderTargets: [0, 1, 2].map(location => ({ location, formatClass: 'rgba16float' })),
      passRequirements: ['deferred-lighting-abi-v1', 'deformation-abi-v1', 'standard-pbr-surface', 'sample-count-1'],
      sourceMap: [{ sourceId: 'deferred-gbuffer', sourceName: 'shader-language/src/deferred-lighting/gbuffer.wgsl', generatedStartLine: 1, generatedEndLine: geometryCode.split('\n').length }],
    },
    { id: 'deferred-reference', code: resolveCode, entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
      bindGroups: [
        frame,
        { logicalSpace: 'object', logicalGroup: 1, physicalGroup: 1, owner: 'artifact', bindings: [] },
        { logicalSpace: 'material', logicalGroup: 2, physicalGroup: 2, owner: 'artifact', bindings: [] },
        { logicalSpace: 'pass', logicalGroup: 3, physicalGroup: 3, owner: 'artifact', bindings: [
          buffer('pass.source', 0, 'read-only-storage', 80), buffer('pass.view', 1, 'uniform', 32),
          buffer('pass.pointIndices', 2, 'read-only-storage', 4),
          texture('pass.g0', 3), texture('pass.g1', 4), texture('pass.g2', 5), texture('pass.depth', 6, true),
          buffer('pass.resolve', 7, 'uniform', 32), buffer('pass.environment', 8, 'uniform', 48),
          texture('pass.diffuseEnvironment', 9, false, 'cube'), texture('pass.specularEnvironment', 10, false, 'cube'),
          sampler('pass.environmentSampler', 11, 'filtering'), buffer('pass.directionalShadows', 12, 'uniform', 240),
          texture('pass.shadowTexture', 13, true, '2d-array'), sampler('pass.shadowSampler', 14, 'comparison'),
        ] },
      ],
      uniformBlocks: [
        ...reflection.filter(b => ['frame.scene', 'pass.environment', 'pass.directionalShadows'].includes(b.id)),
        modules.viewHeader,
        { id: 'pass.resolve', alignment: 16, byteSize: 32, fields: [
          { name: 'viewport', type: 'vec4<f32>', offset: 0, size: 16 },
          { name: 'depth', type: 'vec4<f32>', offset: 16, size: 16 },
        ] },
      ],
      vertexBuffers: [], varyings: [], renderTargets: [{ location: 0, formatClass: 'rgba16float' }],
      capabilities: ['storage-buffer', 'texture-sample', 'cube-texture', 'directional-shadow-array'],
      passRequirements: ['deferred-lighting-abi-v1', 'complete-light-source', 'scene-linear-hdr', 'sample-count-1'],
      sourceMap: [{ sourceId: 'deferred-reference', sourceName: 'shader-language/src/deferred-lighting/resolve.wgsl', generatedStartLine: 1, generatedEndLine: resolveCode.split('\n').length }],
    },
  ];
}
