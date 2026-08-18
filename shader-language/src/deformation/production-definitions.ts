import type {
  PrecompiledShaderBindGroupV2,
  PrecompiledShaderBindingV2,
  PrecompiledShaderPassV2Definition,
  PrecompiledShaderVertexBufferV2,
} from '../adapter/precompiled-v2';
import type { ShaderStage, ShaderUniformBlockReflection, ShaderVaryingReflection } from '../contracts';
import type { ProductionDeformationOperation } from './production-contracts';
import fog from '../render-family/stdlib/simple-3d/fog.wgsl';
import sceneFrame from '../render-family/stdlib/simple-3d/scene-frame.wgsl';
import morph from './stdlib/morph.wgsl';
import skinning from './stdlib/skinning.wgsl';
import skinningBindings from './stdlib/skinning-bindings.wgsl';
import forward from './stdlib/forward.wgsl';
import forwardSkinned from './stdlib/forward-skinned.wgsl';
import depth from './stdlib/depth.wgsl';
import shadow from './stdlib/shadow.wgsl';
import shadowMorph from './stdlib/shadow-morph.wgsl';
import shadowSkinned from './stdlib/shadow-skinned.wgsl';
import shadowSkinnedMorph from './stdlib/shadow-skinned-morph.wgsl';
import motionVector from './stdlib/motion-vector.wgsl';
import outline from './stdlib/outline.wgsl';
import clippingPlanes from '../render-family/stdlib/simple-3d/clipping-planes.wgsl';

interface Definition {
  readonly code: string;
  readonly bindGroups: readonly PrecompiledShaderBindGroupV2[];
  readonly uniformBlocks: readonly ShaderUniformBlockReflection[];
  readonly vertexBuffers: readonly PrecompiledShaderVertexBufferV2[];
  readonly varyings: readonly ShaderVaryingReflection[];
  readonly target: string;
  readonly capabilities: readonly string[];
  readonly requirements: readonly string[];
}

const VERTEX = Object.freeze(['vertex'] as const);
const FRAGMENT = Object.freeze(['fragment'] as const);
const VERTEX_FRAGMENT = Object.freeze(['vertex', 'fragment'] as const);
const SIMPLE_SCENE = [fog, sceneFrame, clippingPlanes].join('\n\n');

export function productionDeformationFeatureModules(): { readonly morph: string; readonly skinning: string } {
  return Object.freeze({ morph: `${morph.trim()}\n`, skinning: `${skinningBindings.trim()}\n\n${skinning.trim()}\n` });
}

export function emitProductionDeformationPass(
  id: string,
  operation: ProductionDeformationOperation,
  sourcePath: string,
  deformationModuleHash: string,
): { readonly code: string; readonly artifactPass: PrecompiledShaderPassV2Definition } {
  const definition = definitions()[operation];
  const code = `// haiyue:deformation-pass ${operation}\n`
    + `// haiyue:deformation-abi 1\n`
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
      renderTargets: Object.freeze([Object.freeze({ location: 0, formatClass: definition.target })]),
      capabilities: definition.capabilities,
      passRequirements: definition.requirements,
      sourceMap: Object.freeze([Object.freeze({
        sourceId: `deformation.${operation}`,
        sourceName: sourcePath,
        generatedStartLine: 1,
        generatedEndLine: code.split('\n').length,
      })]),
    }),
  });
}

function definitions(): Readonly<Record<ProductionDeformationOperation, Definition>> {
  const currentObject = group('object', 1, [
    storage('object.deformationTable', 0, VERTEX_FRAGMENT),
    storage('object.clippingPlanes', 1, FRAGMENT),
  ]);
  const currentSkin = group('object', 3, [
    storage('object.currentJointMatrices', 0, VERTEX),
    storage('geometry.skinJoints', 1, VERTEX),
    storage('geometry.skinWeights', 2, VERTEX),
  ]);
  const emptyMaterial = group('material', 2, []);
  const scene = sceneFrameGroup(VERTEX_FRAGMENT);
  const basicGroups = [
    scene,
    currentObject,
    group('material', 2, [
      uniform('material.basicParameters', 0, FRAGMENT, 48),
      texture('material.baseTexture', 1),
      sampler('material.baseSampler', 2),
      texture('material.emissiveTexture', 3),
    ]),
  ];
  const shadowGroups = [
    group('frame', 0, [uniform('frame.shadowCamera', 0, VERTEX, 64)]),
    group('object', 1, [
      storage('object.deformationTable', 0, VERTEX_FRAGMENT),
      storage('object.clippingPlanes', 1, FRAGMENT),
    ]),
  ];
  return Object.freeze({
    forward: definition(
      [SIMPLE_SCENE, morph, forward].join('\n\n'),
      basicGroups,
      [sceneFrameBlock(), basicMaterialBlock()],
      basicVertexBuffers(),
      forwardVaryings(),
      'color',
      ['morph-targets', 'storage-buffer', 'texture-sample'],
      ['deformation-abi-v1', 'morph-before-skin', 'current-deformation-state', 'world-space-clipping'],
    ),
    'forward-skinned': definition(
      [SIMPLE_SCENE, morph, skinningBindings, skinning, forwardSkinned].join('\n\n'),
      [...basicGroups, currentSkin],
      [sceneFrameBlock(), basicMaterialBlock()],
      basicVertexBuffers(),
      forwardVaryings(),
      'color',
      ['morph-targets', 'skinning', 'storage-buffer', 'texture-sample'],
      ['deformation-abi-v1', 'morph-before-skin', 'current-deformation-state', 'world-space-clipping'],
    ),
    depth: definition(
      [SIMPLE_SCENE, morph, skinningBindings, skinning, depth].join('\n\n'),
      [sceneFrameGroup(VERTEX), currentObject, group('material', 2, [uniform('material.depthParameters', 0, FRAGMENT, 16)]), currentSkin],
      [sceneFrameBlock(), block('material.depthParameters', 16, [
        field('near', 'f32', 0, 4), field('far', 'f32', 4, 4),
        field('isOrthographic', 'u32', 8, 4), field('reverseZ', 'u32', 12, 4),
      ])],
      auxiliaryVertexBuffers(),
      [varying('VIEW_DEPTH', 0, 'f32'), varying('WORLD_POSITION', 1, 'vec3<f32>'), flatVarying('OBJECT_INDEX', 2, 'u32')],
      'color',
      ['morph-targets', 'skinning', 'storage-buffer'],
      ['deformation-abi-v1', 'morph-before-skin', 'current-deformation-state', 'world-space-clipping'],
    ),
    shadow: shadowDefinition([clippingPlanes, shadow].join('\n\n'), shadowGroups, false, false),
    'shadow-morph': shadowDefinition([clippingPlanes, morph, shadowMorph].join('\n\n'), shadowGroups, true, false),
    'shadow-skinned': shadowDefinition([clippingPlanes, morph, skinningBindings, skinning, shadowSkinned].join('\n\n'), [...shadowGroups, emptyMaterial, currentSkin], false, true),
    'shadow-skinned-morph': shadowDefinition([clippingPlanes, morph, skinningBindings, skinning, shadowSkinnedMorph].join('\n\n'), [...shadowGroups, emptyMaterial, currentSkin], true, true),
    'motion-vector': definition(
      [SIMPLE_SCENE, morph, motionVector].join('\n\n'),
      [
        sceneFrameGroup(VERTEX_FRAGMENT),
        group('object', 1, [
          uniform('object.deformationHistory', 0, VERTEX_FRAGMENT, 240),
          storage('object.clippingPlanes', 1, FRAGMENT),
        ]),
        group('object', 2, [
          storage('object.currentJointMatrices', 0, VERTEX),
          storage('object.previousJointMatrices', 1, VERTEX),
          storage('geometry.skinJoints', 2, VERTEX),
          storage('geometry.skinWeights', 3, VERTEX),
        ]),
      ],
      [sceneFrameBlock(), historyBlock()],
      auxiliaryVertexBuffers(),
      [varying('PREVIOUS_CLIP_POSITION', 0, 'vec4<f32>'), varying('WORLD_POSITION', 1, 'vec3<f32>')],
      'velocity-rg16float',
      ['morph-targets', 'skinning', 'history', 'storage-buffer'],
      ['deformation-abi-v1', 'current-and-previous-same-deformation', 'reset-previous-to-current', 'world-space-clipping'],
    ),
    outline: definition(
      [SIMPLE_SCENE, morph, skinningBindings, skinning, outline].join('\n\n'),
      [sceneFrameGroup(VERTEX), currentObject, emptyMaterial, currentSkin],
      [sceneFrameBlock()],
      auxiliaryVertexBuffers(),
      [varying('WORLD_POSITION', 0, 'vec3<f32>'), flatVarying('OBJECT_INDEX', 1, 'u32')],
      'mask',
      ['morph-targets', 'skinning', 'storage-buffer'],
      ['deformation-abi-v1', 'morph-before-skin', 'current-deformation-state', 'world-space-clipping'],
    ),
  });
}

function shadowDefinition(
  code: string,
  bindGroups: readonly PrecompiledShaderBindGroupV2[],
  morphed: boolean,
  skinned: boolean,
): Definition {
  return definition(
    code,
    bindGroups,
    [block('frame.shadowCamera', 64, [matrix('viewProj', 0)])],
    morphed ? auxiliaryVertexBuffers() : positionVertexBuffers(),
    [varying('WORLD_POSITION', 0, 'vec3<f32>'), flatVarying('OBJECT_INDEX', 1, 'u32')],
    'depth-only',
    ['storage-buffer', ...(morphed ? ['morph-targets'] : []), ...(skinned ? ['skinning'] : [])],
    ['deformation-abi-v1', 'morph-before-skin', 'current-deformation-state', 'world-space-clipping'],
  );
}

function definition(
  code: string,
  bindGroups: readonly PrecompiledShaderBindGroupV2[],
  uniformBlocks: readonly ShaderUniformBlockReflection[],
  vertexBuffers: readonly PrecompiledShaderVertexBufferV2[],
  varyings: readonly ShaderVaryingReflection[],
  target: string,
  capabilities: readonly string[],
  requirements: readonly string[],
): Definition {
  return Object.freeze({
    code,
    bindGroups: Object.freeze(bindGroups),
    uniformBlocks: Object.freeze(uniformBlocks),
    vertexBuffers: Object.freeze(vertexBuffers),
    varyings: Object.freeze(varyings),
    target,
    capabilities: Object.freeze(capabilities),
    requirements: Object.freeze(requirements),
  });
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

function texture(id: string, binding: number): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id, binding, visibility: FRAGMENT,
    layout: Object.freeze({ kind: 'texture' as const, sampleType: 'float' as const, viewDimension: '2d' as const, multisampled: false }),
  });
}

function sampler(id: string, binding: number): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id, binding, visibility: FRAGMENT,
    layout: Object.freeze({ kind: 'sampler' as const, samplerType: 'filtering' as const }),
  });
}

function sceneFrameGroup(visibility: readonly ShaderStage[]): PrecompiledShaderBindGroupV2 {
  return group('frame', 0, [uniform('frame.scene', 0, visibility, 272)]);
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

function basicMaterialBlock(): ShaderUniformBlockReflection {
  return block('material.basicParameters', 48, [
    field('color', 'vec4<f32>', 0, 16), field('emissiveFactor', 'vec4<f32>', 16, 16),
    field('useTexture', 'u32', 32, 4), field('useEmissiveTexture', 'u32', 36, 4),
    field('_pad1', 'u32', 40, 4), field('_pad2', 'u32', 44, 4),
  ]);
}

function historyBlock(): ShaderUniformBlockReflection {
  return block('object.deformationHistory', 240, [
    matrix('currentModel', 0), matrix('previousModel', 64), matrix('previousViewProjection', 128),
    field('currentMorphWeights', 'vec4<f32>', 192, 16),
    field('previousMorphWeights', 'vec4<f32>', 208, 16),
    field('deformationFlags', 'vec4<f32>', 224, 16),
  ]);
}

function vertexBuffer(arrayStride: number, semantic: string, location: number, format: string): PrecompiledShaderVertexBufferV2 {
  return Object.freeze({
    arrayStride,
    stepMode: 'vertex' as const,
    attributes: Object.freeze([Object.freeze({ semantic, shaderLocation: location, offset: 0, format })]),
  });
}

function positionVertexBuffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([vertexBuffer(12, 'POSITION', 0, 'float32x3')]);
}

function auxiliaryVertexBuffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([
    vertexBuffer(12, 'POSITION', 0, 'float32x3'),
    ...Array.from({ length: 4 }, (_, index) => vertexBuffer(12, `MORPH_POSITION_${index}`, index + 1, 'float32x3')),
  ]);
}

function basicVertexBuffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([
    vertexBuffer(12, 'POSITION', 0, 'float32x3'),
    vertexBuffer(12, 'NORMAL', 1, 'float32x3'),
    vertexBuffer(8, 'TEXCOORD_0', 2, 'float32x2'),
    ...Array.from({ length: 4 }, (_, index) => vertexBuffer(12, `MORPH_POSITION_${index}`, index + 3, 'float32x3')),
  ]);
}

function varying(semantic: string, location: number, type: string): ShaderVaryingReflection {
  return Object.freeze({ semantic, location, type, interpolation: 'perspective' as const });
}

function flatVarying(semantic: string, location: number, type: string): ShaderVaryingReflection {
  return Object.freeze({ semantic, location, type, interpolation: 'flat' as const });
}

function forwardVaryings(): readonly ShaderVaryingReflection[] {
  return Object.freeze([
    varying('TEXCOORD_0', 0, 'vec2<f32>'),
    varying('NORMAL', 1, 'vec3<f32>'),
    varying('WORLD_POSITION', 2, 'vec3<f32>'),
    flatVarying('OBJECT_INDEX', 3, 'u32'),
  ]);
}
