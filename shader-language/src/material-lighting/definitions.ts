import type {
  PrecompiledShaderBindGroupV2,
  PrecompiledShaderBindingV2,
  PrecompiledShaderPassV2Definition,
  PrecompiledShaderVertexBufferV2,
} from '../adapter/precompiled-v2';
import type { ShaderStage, ShaderUniformBlockReflection, ShaderVaryingReflection } from '../contracts';
import type { ProductionMaterialLightingOperation } from './contracts';
import sceneFrame from '../render-family/stdlib/simple-3d/scene-frame.wgsl';
import morph from '../deformation/stdlib/morph.wgsl';
import skinning from '../deformation/stdlib/skinning.wgsl';
import skinningBindings from '../deformation/stdlib/skinning-bindings.wgsl';
import pbrSkinningBindings from './stdlib/pbr-skinning-bindings.wgsl';
import fog from './stdlib/fog.wgsl';
import pbrBrdf from './stdlib/pbr-brdf.wgsl';
import pbrClearcoat from './stdlib/pbr-clearcoat.wgsl';
import pbrSheen from './stdlib/pbr-sheen.wgsl';
import pbrShadow from './stdlib/pbr-shadow.wgsl';
import pbr from './stdlib/pbr-metallic-roughness.wgsl';
import blinnPhong from './stdlib/blinn-phong.wgsl';
import toon from './stdlib/toon.wgsl';
import clippingPlanes from '../render-family/stdlib/simple-3d/clipping-planes.wgsl';

interface Definition {
  readonly code: string;
  readonly bindGroups: readonly PrecompiledShaderBindGroupV2[];
  readonly uniformBlocks: readonly ShaderUniformBlockReflection[];
  readonly vertexBuffers: readonly PrecompiledShaderVertexBufferV2[];
  readonly varyings: readonly ShaderVaryingReflection[];
  readonly capabilities: readonly string[];
  readonly requirements: readonly string[];
}

const VERTEX = Object.freeze(['vertex'] as const);
const FRAGMENT = Object.freeze(['fragment'] as const);
const VERTEX_FRAGMENT = Object.freeze(['vertex', 'fragment'] as const);
const MAX_LIGHTS = 8;
const MAX_DIRECTIONAL_SHADOWS = 3;
const PBR_MATERIAL_BYTES = 608;
const LIGHT_BYTES = 16 + MAX_LIGHTS * 64;
const PBR_SHADOW_BYTES = MAX_DIRECTIONAL_SHADOWS * 80;
const pbrSkinning = [pbrSkinningBindings, skinning].join('\n\n');

export function productionMaterialLightingModules(): {
  readonly fog: string;
  readonly pbrBrdf: string;
  readonly pbrClearcoat: string;
  readonly pbrSheen: string;
  readonly pbrShadow: string;
  readonly morph: string;
  readonly skinning: string;
} {
  return Object.freeze({
    fog: `${fog.trim()}\n`,
    pbrBrdf: `${pbrBrdf.trim()}\n`,
    pbrClearcoat: `${pbrClearcoat.trim()}\n`,
    pbrSheen: `${pbrSheen.trim()}\n`,
    pbrShadow: `${pbrShadow.trim()}\n`,
    morph: `${morph.trim()}\n`,
    skinning: `${skinningBindings.trim()}\n\n${skinning.trim()}\n`,
  });
}

export function emitProductionMaterialLightingPass(
  id: string,
  operation: ProductionMaterialLightingOperation,
  sourcePath: string,
  lightingModuleHash: string,
  deformationModuleHash: string,
): { readonly code: string; readonly artifactPass: PrecompiledShaderPassV2Definition } {
  const definition = definitions()[operation];
  const code = `// haiyue:material-lighting-pass ${operation}\n`
    + '// haiyue:material-lighting-abi 1\n'
    + `// haiyue:material-lighting-module ${lightingModuleHash}\n`
    + `// haiyue:deformation-module ${deformationModuleHash}\n`
    + `// source: ${sourcePath}\n\n${definition.code.trim()}\n`;
  return Object.freeze({
    code,
    artifactPass: Object.freeze({
      id,
      code,
      entryPoints: Object.freeze({ vertex: 'vs_main', fragment: 'fs_main' }),
      bindGroups: definition.bindGroups,
      uniformBlocks: definition.uniformBlocks,
      vertexBuffers: definition.vertexBuffers,
      varyings: definition.varyings,
      renderTargets: Object.freeze([Object.freeze({ location: 0, formatClass: 'color' })]),
      capabilities: definition.capabilities,
      passRequirements: definition.requirements,
      sourceMap: Object.freeze([Object.freeze({
        sourceId: `material-lighting.${operation}`,
        sourceName: sourcePath,
        generatedStartLine: 1,
        generatedEndLine: code.split('\n').length,
      })]),
    }),
  });
}

function definitions(): Readonly<Record<ProductionMaterialLightingOperation, Definition>> {
  const scene = [fog, sceneFrame].join('\n\n');
  const pbrModules = [scene, clippingPlanes, morph, pbrSkinning, pbrBrdf, pbrClearcoat, pbrSheen];
  const pbrDefinition = (clearcoat: boolean, transmission: boolean) => definition(
    [...pbrModules, specialize(pbrShadow, {
      MAX_DIRECTIONAL_SHADOWS: `${MAX_DIRECTIONAL_SHADOWS}u`,
    }), specialize(pbr, {
      MAX_LIGHTS: `${MAX_LIGHTS}u`,
      MAX_DIRECTIONAL_SHADOWS: `${MAX_DIRECTIONAL_SHADOWS}u`,
      CLEARCOAT_ENABLED: String(clearcoat),
      TRANSMISSION_ENABLED: String(transmission),
    })].join('\n\n'),
    pbrGroups(),
    pbrBlocks(),
    pbrVertexBuffers(),
    pbrVaryings(),
    [
      'storage-buffer', 'texture-sample', 'cube-texture', 'derivatives',
      'morph-targets', 'skinning', 'directional-shadow-array',
      ...(clearcoat ? ['clearcoat'] : []),
      ...(transmission ? ['framebuffer-transmission'] : []),
    ],
    [
      'material-lighting-abi-v1', 'deformation-abi-v1', 'eight-light-cap',
      'three-directional-shadow-cap', 'morph-before-skin', 'world-space-clipping',
      `clearcoat-${clearcoat ? 'enabled' : 'disabled'}`,
      `transmission-${transmission ? 'enabled' : 'disabled'}`,
    ],
  );
  return Object.freeze({
    pbr: pbrDefinition(false, false),
    'pbr-clearcoat': pbrDefinition(true, false),
    'pbr-transmission': pbrDefinition(false, true),
    'pbr-transmission-clearcoat': pbrDefinition(true, true),
    'blinn-phong': definition(
      [scene, clippingPlanes, specialize(blinnPhong, { BLINN_PHONG_MAX_LIGHTS: `${MAX_LIGHTS}u` })].join('\n\n'),
      blinnGroups(),
      [sceneFrameBlock(), blinnMaterialBlock(), lightsBlock('pass.lights')],
      positionNormalUvBuffers(),
      litVaryings(false),
      ['storage-buffer'],
      ['material-lighting-abi-v1', 'eight-light-cap', 'fog-after-lighting', 'world-space-clipping'],
    ),
    toon: definition(
      [scene, clippingPlanes, specialize(pbrShadow, { MAX_DIRECTIONAL_SHADOWS: '1u' }), specialize(toon, {
        TOON_MAX_LIGHTS: `${MAX_LIGHTS}u`,
      })].join('\n\n'),
      toonGroups(),
      [sceneFrameBlock(), toonMaterialBlock(), lightsBlock('pass.lights'), shadowBlock('pass.directionalShadows', 1)],
      positionNormalUv1Buffers(),
      litVaryings(true),
      ['storage-buffer', 'texture-sample', 'derivatives', 'directional-shadow-array'],
      ['material-lighting-abi-v1', 'eight-light-cap', 'one-effective-directional-shadow', 'fog-after-lighting', 'world-space-clipping'],
    ),
  });
}

function pbrGroups(): readonly PrecompiledShaderBindGroupV2[] {
  return Object.freeze([
    sceneFrameGroup(),
    group('object', 1, [
      storage('object.pbrTable', 0, VERTEX_FRAGMENT),
      storage('object.clippingPlanes', 1, FRAGMENT),
    ]),
    group('material', 2, [
      uniform('material.pbrParameters', 0, FRAGMENT, PBR_MATERIAL_BYTES),
      ...Array.from({ length: 12 }, (_, index) => texture(`material.texture${index}`, index + 1)),
      ...Array.from({ length: 12 }, (_, index) => sampler(`material.sampler${index}`, index + 13)),
    ]),
    group('pass', 3, [
      uniform('pass.lights', 0, FRAGMENT, LIGHT_BYTES),
      uniform('pass.environment', 1, FRAGMENT, 48),
      texture('pass.diffuseEnvironment', 2, 'float', 'cube'),
      texture('pass.specularEnvironment', 3, 'float', 'cube'),
      sampler('pass.environmentSampler', 4),
      uniform('pass.directionalShadows', 5, VERTEX_FRAGMENT, PBR_SHADOW_BYTES),
      texture('pass.shadowTexture', 6, 'depth', '2d-array'),
      sampler('pass.shadowSampler', 7, 'comparison'),
      storage('object.currentJointMatrices', 8, VERTEX),
      storage('geometry.skinJoints', 9, VERTEX),
      storage('geometry.skinWeights', 10, VERTEX),
      texture('pass.transmissionFramebuffer', 11),
    ]),
  ]);
}

function blinnGroups(): readonly PrecompiledShaderBindGroupV2[] {
  return Object.freeze([
    sceneFrameGroup(),
    group('object', 1, [
      storage('object.blinnPhongTable', 0, VERTEX_FRAGMENT),
      storage('object.clippingPlanes', 1, FRAGMENT),
    ]),
    group('material', 2, [uniform('material.blinnPhongParameters', 0, FRAGMENT, 64)]),
    group('pass', 3, [uniform('pass.lights', 0, FRAGMENT, LIGHT_BYTES)]),
  ]);
}

function toonGroups(): readonly PrecompiledShaderBindGroupV2[] {
  return Object.freeze([
    sceneFrameGroup(),
    group('object', 1, [
      storage('object.toonTable', 0, VERTEX_FRAGMENT),
      storage('object.clippingPlanes', 1, FRAGMENT),
    ]),
    group('material', 2, [
      uniform('material.toonParameters', 0, FRAGMENT, 240),
      ...Array.from({ length: 4 }, (_, index) => texture(`material.layerTexture${index}`, index + 1)),
      ...Array.from({ length: 4 }, (_, index) => sampler(`material.layerSampler${index}`, index + 5)),
    ]),
    group('pass', 3, [
      uniform('pass.lights', 0, FRAGMENT, LIGHT_BYTES),
      uniform('pass.directionalShadows', 5, VERTEX_FRAGMENT, 80),
      texture('pass.shadowTexture', 6, 'depth', '2d-array'),
      sampler('pass.shadowSampler', 7, 'comparison'),
    ]),
  ]);
}

function definition(
  code: string,
  bindGroups: readonly PrecompiledShaderBindGroupV2[],
  uniformBlocks: readonly ShaderUniformBlockReflection[],
  vertexBuffers: readonly PrecompiledShaderVertexBufferV2[],
  varyings: readonly ShaderVaryingReflection[],
  capabilities: readonly string[],
  requirements: readonly string[],
): Definition {
  return Object.freeze({
    code,
    bindGroups,
    uniformBlocks: Object.freeze(uniformBlocks),
    vertexBuffers: Object.freeze(vertexBuffers),
    varyings: Object.freeze(varyings),
    capabilities: Object.freeze(capabilities),
    requirements: Object.freeze(requirements),
  });
}

function specialize(source: string, values: Readonly<Record<string, string>>): string {
  let result = source;
  for (const [name, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\b${name}\\b`, 'g'), value);
  }
  return result;
}

function group(
  logicalSpace: 'frame' | 'object' | 'material' | 'pass',
  physicalGroup: number,
  bindings: readonly PrecompiledShaderBindingV2[],
): PrecompiledShaderBindGroupV2 {
  return Object.freeze({
    logicalSpace,
    logicalGroup: { frame: 0, object: 1, material: 2, pass: 3 }[logicalSpace],
    physicalGroup,
    owner: 'renderer' as const,
    bindings: Object.freeze(bindings),
  });
}

function uniform(id: string, binding: number, visibility: readonly ShaderStage[], minBindingSize: number): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id, binding, visibility,
    layout: Object.freeze({ kind: 'buffer' as const, bufferType: 'uniform' as const, hasDynamicOffset: id === 'frame.scene', minBindingSize }),
  });
}

function storage(id: string, binding: number, visibility: readonly ShaderStage[]): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id, binding, visibility,
    layout: Object.freeze({ kind: 'buffer' as const, bufferType: 'read-only-storage' as const, hasDynamicOffset: false, minBindingSize: 0 }),
  });
}

function texture(
  id: string,
  binding: number,
  sampleType: 'float' | 'depth' = 'float',
  viewDimension: '2d' | '2d-array' | 'cube' = '2d',
): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id, binding, visibility: FRAGMENT,
    layout: Object.freeze({ kind: 'texture' as const, sampleType, viewDimension, multisampled: false }),
  });
}

function sampler(id: string, binding: number, samplerType: 'filtering' | 'comparison' = 'filtering'): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id, binding, visibility: FRAGMENT,
    layout: Object.freeze({ kind: 'sampler' as const, samplerType }),
  });
}

function sceneFrameGroup(): PrecompiledShaderBindGroupV2 {
  return group('frame', 0, [uniform('frame.scene', 0, VERTEX_FRAGMENT, 272)]);
}

function block(id: string, byteSize: number, fields: readonly ShaderUniformBlockReflection['fields'][number][]): ShaderUniformBlockReflection {
  return Object.freeze({ id, alignment: 16, byteSize, fields: Object.freeze(fields) });
}

function field(name: string, type: string, offset: number, size: number): ShaderUniformBlockReflection['fields'][number] {
  return Object.freeze({ name, type, offset, size });
}

function matrix(name: string, offset: number): ShaderUniformBlockReflection['fields'][number] {
  return Object.freeze({ name, type: 'mat4x4<f32>', offset, size: 64, matrixStride: 16 });
}

function sceneFrameBlock(): ShaderUniformBlockReflection {
  return block('frame.scene', 272, [
    matrix('viewProjection', 0), matrix('view', 64), matrix('inverseViewProjection', 128),
    field('eyePosition', 'vec4<f32>', 192, 16), field('viewport', 'vec4<f32>', 208, 16),
    field('fog', 'FogUniforms', 224, 48),
  ]);
}

function pbrBlocks(): readonly ShaderUniformBlockReflection[] {
  return Object.freeze([
    sceneFrameBlock(),
    block('material.pbrParameters', PBR_MATERIAL_BYTES, [
      field('baseColor', 'vec4<f32>', 0, 16),
      field('emissiveNormalScale', 'vec4<f32>', 16, 16),
      field('factors', 'vec4<f32>', 32, 16),
      field('flags', 'vec4<u32>', 48, 16),
      field('extensionFactors', 'array<vec4<f32>, 6>', 64, 96),
      field('textureMappings', 'array<TextureMapping, 14>', 160, 448),
    ]),
    lightsBlock('pass.lights'),
    block('pass.environment', 48, [
      field('diffuseColor', 'vec4<f32>', 0, 16),
      field('specularColor', 'vec4<f32>', 16, 16),
      field('params', 'vec4<f32>', 32, 16),
    ]),
    shadowBlock('pass.directionalShadows', MAX_DIRECTIONAL_SHADOWS),
  ]);
}

function blinnMaterialBlock(): ShaderUniformBlockReflection {
  return block('material.blinnPhongParameters', 64, [
    field('ambient', 'vec4<f32>', 0, 16), field('diffuse', 'vec4<f32>', 16, 16),
    field('specular', 'vec4<f32>', 32, 16), field('shininess', 'f32', 48, 4),
  ]);
}

function toonMaterialBlock(): ShaderUniformBlockReflection {
  return block('material.toonParameters', 240, [
    field('baseColor', 'vec4<f32>', 0, 16), field('thresholds', 'vec4<f32>', 16, 16),
    field('layerColors', 'array<vec4<f32>, 4>', 32, 64), field('params', 'vec4<f32>', 96, 16),
    field('uvRows', 'array<vec4<f32>, 8>', 112, 128),
  ]);
}

function lightsBlock(id: string): ShaderUniformBlockReflection {
  return block(id, LIGHT_BYTES, [
    field('countVec', 'vec4<u32>', 0, 16), field('lights', 'array<LightData, 8>', 16, MAX_LIGHTS * 64),
  ]);
}

function shadowBlock(id: string, count: number): ShaderUniformBlockReflection {
  return block(id, count * 80, [field('shadows', `array<DirectionalShadowData, ${count}>`, 0, count * 80)]);
}

function vertexBuffer(arrayStride: number, semantic: string, location: number, format: string): PrecompiledShaderVertexBufferV2 {
  return Object.freeze({
    arrayStride,
    stepMode: 'vertex' as const,
    attributes: Object.freeze([Object.freeze({ semantic, shaderLocation: location, offset: 0, format })]),
  });
}

function pbrVertexBuffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([
    vertexBuffer(12, 'POSITION', 0, 'float32x3'),
    vertexBuffer(12, 'NORMAL', 1, 'float32x3'),
    vertexBuffer(8, 'TEXCOORD_0', 2, 'float32x2'),
    vertexBuffer(8, 'TEXCOORD_1', 3, 'float32x2'),
    ...Array.from({ length: 4 }, (_, index): PrecompiledShaderVertexBufferV2 => Object.freeze({
      arrayStride: 24,
      stepMode: 'vertex' as const,
      attributes: Object.freeze([
        Object.freeze({ semantic: `MORPH_POSITION_${index}`, shaderLocation: index * 2 + 4, offset: 0, format: 'float32x3' }),
        Object.freeze({ semantic: `MORPH_NORMAL_${index}`, shaderLocation: index * 2 + 5, offset: 12, format: 'float32x3' }),
      ]),
    })),
  ]);
}

function positionNormalUvBuffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([
    vertexBuffer(12, 'POSITION', 0, 'float32x3'),
    vertexBuffer(12, 'NORMAL', 1, 'float32x3'),
    vertexBuffer(8, 'TEXCOORD_0', 2, 'float32x2'),
  ]);
}

function positionNormalUv1Buffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([...positionNormalUvBuffers(), vertexBuffer(8, 'TEXCOORD_1', 3, 'float32x2')]);
}

function varying(semantic: string, location: number, type: string): ShaderVaryingReflection {
  return Object.freeze({ semantic, location, type, interpolation: 'perspective' as const });
}

function flatVarying(semantic: string, location: number, type: string): ShaderVaryingReflection {
  return Object.freeze({ semantic, location, type, interpolation: 'flat' as const });
}

function pbrVaryings(): readonly ShaderVaryingReflection[] {
  return Object.freeze([
    varying('WORLD_POSITION', 0, 'vec3<f32>'), varying('WORLD_NORMAL', 1, 'vec3<f32>'),
    varying('TEXCOORD_0', 2, 'vec2<f32>'), varying('TEXCOORD_1', 3, 'vec2<f32>'),
    varying('WORLD_SCALE', 4, 'f32'),
    flatVarying('OBJECT_INDEX', 5, 'u32'),
  ]);
}

function litVaryings(uv1: boolean): readonly ShaderVaryingReflection[] {
  return Object.freeze([
    varying('WORLD_POSITION', 0, 'vec3<f32>'), varying('WORLD_NORMAL', 1, 'vec3<f32>'),
    ...(uv1 ? [varying('TEXCOORD_0', 2, 'vec2<f32>'), varying('TEXCOORD_1', 3, 'vec2<f32>')] : []),
    flatVarying('OBJECT_INDEX', uv1 ? 4 : 2, 'u32'),
  ]);
}
