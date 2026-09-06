import type { PrecompiledShaderBindingV2 } from '../adapter/precompiled-v2';
import type { ShaderUniformBlockReflection } from '../contracts';

export const materialCoverageBindings: readonly PrecompiledShaderBindingV2[] = [
  { id: 'material.coverage', binding: 1, visibility: ['fragment'], layout: {
    kind: 'buffer', bufferType: 'uniform', hasDynamicOffset: false, minBindingSize: 192,
  } },
  { id: 'material.coverageTexture', binding: 2, visibility: ['fragment'], layout: {
    kind: 'texture', sampleType: 'float', viewDimension: '2d', multisampled: false,
  } },
  { id: 'material.coverageSampler', binding: 3, visibility: ['fragment'], layout: {
    kind: 'sampler', samplerType: 'filtering',
  } },
];

export const materialCoverageBlock: ShaderUniformBlockReflection = {
  id: 'material.coverage', alignment: 16, byteSize: 192, fields: [
    { name: 'baseColor', type: 'vec4<f32>', offset: 0, size: 16 },
    { name: 'emissiveAndNormalScale', type: 'vec4<f32>', offset: 16, size: 16 },
    { name: 'surfaceAndCutoff', type: 'vec4<f32>', offset: 32, size: 16 },
    { name: 'flags', type: 'vec4<u32>', offset: 48, size: 16 },
    { name: 'extensions', type: 'array<vec4<f32>,6>', offset: 64, size: 96, arrayStride: 16 },
    { name: 'baseMapping0', type: 'vec4<f32>', offset: 160, size: 16 },
    { name: 'baseMapping1', type: 'vec4<f32>', offset: 176, size: 16 },
  ],
};
