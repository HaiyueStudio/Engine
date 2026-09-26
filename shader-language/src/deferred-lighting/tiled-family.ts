import type { PrecompiledShaderPassV2, PrecompiledShaderPassV2Definition, PrecompiledShaderBindingV2 } from '../adapter/precompiled-v2';

/** Specialize local-light selection and hoist invariant point-light terms. The complete reference shader remains unchanged. */
export function buildDeferredTiledPasses(reference: PrecompiledShaderPassV2, modules: {
  abi: string; scene: string; layout: string; cull: string; resolve: string; point: string;
}): readonly PrecompiledShaderPassV2Definition[] {
  const loop = '  for (var index = 0u; index < lightView.pointCount; index++) {\n    let local = pointIndices[index];';
  if (reference.code.split(loop).length !== 2) throw new Error('Deferred reference point loop contract changed.');
  const begin = reference.code.indexOf(loop);
  const end = reference.code.indexOf('  let dielectricF = fresnelSchlickRoughnessF90', begin);
  if (end < begin) throw new Error('Deferred reference point loop end changed.');
  const code = modules.layout + '\n' + modules.resolve + '\n' + modules.point + '\n'
    + reference.code.slice(0, begin)
    + `  let tileRange = deferredTileRange(pixel.xy);
  let pointSurface = deferredPointSurface(n, v, base, nDotV, metallic, roughness);
  if (tileRange.z != 0u) {
    for (var index = 0u; index < lightView.pointCount; index++) {
      let local = pointIndices[index];
      if (local < source.header.pointCount) {
        let sourceIndex = source.header.directionalCount + local;
        direct += deferredPoint(source.records[sourceIndex].positionRange, source.records[sourceIndex].radiance.rgb, position, pointSurface);
      }
    }
  } else {
    for (var index = 0u; index < tileRange.y; index++) {
      let local = tileWords[tileRange.x + index];
      if (local < source.header.pointCount) {
        let sourceIndex = source.header.directionalCount + local;
        direct += deferredPoint(source.records[sourceIndex].positionRange, source.records[sourceIndex].radiance.rgb, position, pointSurface);
      }
    }
  }
` + reference.code.slice(end);
  const tileBuffer: PrecompiledShaderBindingV2 = { id: 'pass.tiles', binding: 15, visibility: ['fragment'],
    layout: { kind: 'buffer', bufferType: 'read-only-storage', minBindingSize: 4, hasDynamicOffset: false } };
  const tileParameters: PrecompiledShaderBindingV2 = { id: 'pass.tileParameters', binding: 16, visibility: ['fragment'],
    layout: { kind: 'buffer', bufferType: 'uniform', minBindingSize: 32, hasDynamicOffset: false } };
  const parameters = { id: 'pass.tileParameters', alignment: 16, byteSize: 32, fields: [
    { name: 'grid', type: 'vec4<u32>', offset: 0, size: 16 },
    { name: 'viewport', type: 'vec4<f32>', offset: 16, size: 16 },
  ] };
  const cullCode = [modules.abi, modules.scene, modules.layout, modules.cull].join('\n\n');
  const computeBinding = (binding: PrecompiledShaderBindingV2): PrecompiledShaderBindingV2 => ({ ...binding, visibility: ['compute'] });
  return [
    { id: 'deferred-tile-cull', code: cullCode, entryPoints: { compute: 'cs_main' },
      bindGroups: reference.bindGroups.map(group => ({ ...group, owner: 'artifact',
        bindings: group.logicalGroup === 3
          ? [...group.bindings.filter(binding => binding.binding <= 2).map(computeBinding),
            { ...computeBinding(tileBuffer), layout: { ...tileBuffer.layout, kind: 'buffer', bufferType: 'storage', minBindingSize: 4, hasDynamicOffset: false } },
            computeBinding(tileParameters)]
          : group.bindings.map(computeBinding),
      })),
      uniformBlocks: [...reference.uniformBlocks.filter(block => ['frame.scene', 'pass.view'].includes(block.id)), parameters],
      vertexBuffers: [], varyings: [], renderTargets: [], capabilities: ['storage-buffer', 'compute'],
      passRequirements: ['deferred-lighting-abi-v1', 'tile-16x16-64-invocations', 'same-frame-full-list-overflow'],
      sourceMap: [{ sourceId: 'deferred-tile-cull', sourceName: 'shader-language/src/deferred-lighting/tile-cull.wgsl', generatedStartLine: 1, generatedEndLine: cullCode.split('\n').length }],
    },
    { ...reference, id: 'deferred-tiled', code,
      bindGroups: reference.bindGroups.map(group => group.logicalGroup === 3
        ? { ...group, bindings: [...group.bindings, tileBuffer, tileParameters] } : group),
      uniformBlocks: [...reference.uniformBlocks, parameters],
      passRequirements: [...reference.passRequirements, 'same-frame-full-list-overflow'],
      sourceMap: [{ sourceId: 'deferred-tiled', sourceName: 'shader-language/src/deferred-lighting/tile-resolve.wgsl', generatedStartLine: 1, generatedEndLine: code.split('\n').length }],
    },
  ];
}
