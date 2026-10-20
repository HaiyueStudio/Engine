import type { PrecompiledShaderPassV2, PrecompiledShaderPassV2Definition, PrecompiledShaderBindingV2, PrecompiledShaderUniformBlockV2 } from '../adapter/precompiled-v2';

export interface FullForwardModules {
  readonly abi: string;
  readonly lightingAo: string;
  readonly lights: string;
  readonly viewHeader: PrecompiledShaderUniformBlockV2;
}

function replaceOnce(code: string, before: string, after: string): string {
  if (code.split(before).length !== 2) throw new Error(`Full Forward PBR source contract changed: ${before}`);
  return code.replace(before, after);
}

/** Preserve each existing PBR BRDF/texture/deformation variant; replace only its light source. */
export function buildFullForwardPass(base: PrecompiledShaderPassV2, modules: FullForwardModules): PrecompiledShaderPassV2Definition {
  if (!['pbr', 'pbr-clearcoat', 'pbr-transmission', 'pbr-transmission-clearcoat'].includes(base.id)) {
    throw new Error(`Unsupported full Forward material pass: ${base.id}`);
  }
  let code = replaceOnce(base.code,
    'index < min(lights.countVec.x, 8u)', 'index < fullForwardLightCount()');
  code = replaceOnce(code, 'let light = lights.lights[index];', 'let light = fullForwardLight(index);');
  code = replaceOnce(code, 'light.typeVec.x == 1u && index < 3u', 'light.typeVec.x == 1u && light.typeVec.z < 3u');
  code = replaceOnce(code, 'shadowVisibility(index, input.worldPos, n, l)', 'shadowVisibility(light.typeVec.z, input.worldPos, n, l)');
  code = replaceOnce(code, '  let object = objects[input.objectIndex];',
    '  if (!fullForwardOpaqueVisible(input.clipPos)) { discard; }\n  let object = objects[input.objectIndex];');
  code = replaceOnce(code, '  let occlusion = surface.occlusion;',
    '  let occlusion = surface.occlusion * lightingAmbientVisibility(input.clipPos.xy);');
  // Ambient records are indirect light even though the legacy BRDF accumulates them in `direct`.
  code = replaceOnce(code, 'let ambientRadiance = light.color.rgb * light.color.a;',
    'let ambientRadiance = light.color.rgb * light.color.a * lightingAmbientVisibility(input.clipPos.xy);');
  code = `${modules.lightingAo.replace('__BINDING__', '15')}\n\n${modules.abi}\n\n${modules.lights.replaceAll('TRANSMISSION_ENABLED', String(base.id.includes('transmission')))}\n\n${code}`;
  const passGroup = base.bindGroups.find(group => group.physicalGroup === 3);
  if (!passGroup || passGroup.bindings.some(binding => binding.binding >= 12)) throw new Error('Full Forward pass bindings collide with PBR resources');
  const binding = (id: string, slot: number, bufferType: 'uniform' | 'read-only-storage', minBindingSize: number): PrecompiledShaderBindingV2 => ({
    id, binding: slot, visibility: ['fragment'], layout: { kind: 'buffer', bufferType, hasDynamicOffset: false, minBindingSize },
  });
  const id = `deferred-full-${base.id}`;
  return {
    ...base, id, code,
    bindGroups: base.bindGroups.map(group => group === passGroup ? {
      ...group, owner: 'artifact', bindings: [...group.bindings.map(entry => entry.binding === 0 && entry.layout.kind === 'buffer'
        ? { ...entry, layout: { ...entry.layout, hasDynamicOffset: true } } : entry),
        binding('pass.fullSource', 12, 'read-only-storage', 80),
        binding('pass.fullView', 13, 'uniform', 32),
        binding('pass.fullPointIndices', 14, 'read-only-storage', 4),
        binding('pass.lightingAo', 15, 'read-only-storage', 260),
      ],
    } : group),
    uniformBlocks: [...base.uniformBlocks, { ...modules.viewHeader, id: 'pass.fullView' }],
    passRequirements: [...base.passRequirements.filter(requirement => requirement !== 'eight-light-cap'),
      'deferred-lighting-abi-v1', 'complete-light-source', 'complete-transparent-light-list', 'opaque-proxy-mask-scene-color-slot'],
    sourceMap: [{ sourceId: id, sourceName: 'shader-language/src/deferred-lighting/full-forward-family.ts',
      generatedStartLine: 1, generatedEndLine: code.split('\n').length }],
  };
}
