/** ADR 0109 ABI v1. The generator derives host writes, reflection and WGSL from these fields. */
export const DEFERRED_LIGHTING_ABI = {
  version: 1,
  maxPoints: 1024,
  maxDirectionals: 8,
  noShadow: 0xffffffff,
  blocks: {
    sourceHeader: {
      name: 'DeferredSourceHeader', alignment: 16, byteSize: 16,
      fields: [
        { name: 'abiVersion', type: 'u32', offset: 0 },
        { name: 'sourceGeneration', type: 'u32', offset: 4 },
        { name: 'pointCount', type: 'u32', offset: 8 },
        { name: 'directionalCount', type: 'u32', offset: 12 },
      ],
    },
    light: {
      name: 'DeferredLightRecord', alignment: 16, byteSize: 64,
      fields: [
        { name: 'positionRange', type: 'vec4<f32>', offset: 0 },
        { name: 'radiance', type: 'vec4<f32>', offset: 16 },
        { name: 'direction', type: 'vec4<f32>', offset: 32 },
        { name: 'identity', type: 'vec4<u32>', offset: 48 },
      ],
    },
    viewHeader: {
      name: 'DeferredViewHeader', alignment: 16, byteSize: 32,
      fields: [
        { name: 'sourceGeneration', type: 'u32', offset: 0 },
        { name: 'pointCount', type: 'u32', offset: 4 },
        { name: 'directionalCount', type: 'u32', offset: 8 },
        { name: 'flags', type: 'u32', offset: 12 },
        { name: 'ambientRadiance', type: 'vec4<f32>', offset: 16 },
      ],
    },
  },
} as const;
