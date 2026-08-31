import type {
  PrecompiledShaderBindingV2,
  PrecompiledShaderBindGroupV2,
  PrecompiledShaderPassV2Definition,
  PrecompiledShaderVertexBufferV2,
} from '../adapter/precompiled-v2';
import type { ShaderStage, ShaderUniformBlockReflection, ShaderVaryingReflection } from '../contracts';
import type { BuiltinRenderOperation } from './contracts';
import animation2d from './stdlib/2d-ui/animation-2d.wgsl';
import bitmapText from './stdlib/2d-ui/bitmap-text.wgsl';
import canvasText2d from './stdlib/2d-ui/canvas-text-2d.wgsl';
import guiImage from './stdlib/2d-ui/gui-image.wgsl';
import guiShape from './stdlib/2d-ui/gui-shape.wgsl';
import guiText from './stdlib/2d-ui/gui-text.wgsl';
import indexedSprite from './stdlib/2d-ui/indexed-sprite.wgsl';
import mesh2d from './stdlib/2d-ui/mesh2d.wgsl';
import particle2d from './stdlib/2d-ui/particle2d.wgsl';
import radialShadow from './stdlib/2d-ui/radial-shadow.wgsl';
import spine2d from './stdlib/2d-ui/spine2d.wgsl';
import tilemap2d from './stdlib/2d-ui/tilemap2d.wgsl';
import basicMaterialEntry from '../deformation/stdlib/forward.wgsl';
import basicMaterialSkinnedEntry from '../deformation/stdlib/forward-skinned.wgsl';
import fog from './stdlib/simple-3d/fog.wgsl';
import meshHelperEntry from './stdlib/simple-3d/mesh-helper.wgsl';
import morph from '../deformation/stdlib/morph.wgsl';
import normalMaterialEntry from './stdlib/simple-3d/normal-material.wgsl';
import particle3d from './stdlib/simple-3d/particle3d.wgsl';
import sceneFrame from './stdlib/simple-3d/scene-frame.wgsl';
import skinning from '../deformation/stdlib/skinning.wgsl';
import skinningBindings from '../deformation/stdlib/skinning-bindings.wgsl';
import skyEntry from './stdlib/simple-3d/sky.wgsl';
import clippingPlanes from './stdlib/simple-3d/clipping-planes.wgsl';

interface RenderDefinition {
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
const FLOAT_TEXTURE = Object.freeze({
  kind: 'texture' as const,
  sampleType: 'float' as const,
  viewDimension: '2d' as const,
  multisampled: false,
});
const FILTERING_SAMPLER = Object.freeze({ kind: 'sampler' as const, samplerType: 'filtering' as const });

const SIMPLE_SCENE = [fog, sceneFrame].join('\n\n');
const CLIPPED_SCENE = [SIMPLE_SCENE, clippingPlanes].join('\n\n');
const SIMPLE_SOURCES = Object.freeze({
  'basic-material': [CLIPPED_SCENE, morph, basicMaterialEntry].join('\n\n'),
  'basic-material-skinned': [CLIPPED_SCENE, morph, skinningBindings, skinning, basicMaterialSkinnedEntry].join('\n\n'),
  'mesh-helper': [SIMPLE_SCENE, meshHelperEntry].join('\n\n'),
  'normal-material': [CLIPPED_SCENE, normalMaterialEntry].join('\n\n'),
  particle3d,
  sky: [SIMPLE_SCENE, skyEntry].join('\n\n'),
});

export function emitBuiltinRenderPass(
  id: string,
  operation: BuiltinRenderOperation,
  sourcePath: string,
): { readonly code: string; readonly artifactPass: PrecompiledShaderPassV2Definition } {
  const definition = definitions()[operation];
  const code = `// haiyue:builtin-render ${operation}\n// source: ${sourcePath}\n\n${definition.code.trim()}\n`;
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
        sourceId: `builtin.${operation}`,
        sourceName: sourcePath,
        generatedStartLine: 1,
        generatedEndLine: code.split('\n').length,
      })]),
    }),
  });
}

function definitions(): Readonly<Record<BuiltinRenderOperation, RenderDefinition>> {
  const camera = (id = 'frame.camera') => uniform(id, 0, VERTEX, 64);
  const object64 = (id = 'object.transform') => uniform(id, 0, VERTEX, 64);
  const textureGroup = (physical = 2, textureId = 'material.texture', samplerId = 'material.sampler') =>
    group('material', physical, [texture(textureId, 0), sampler(samplerId, 1)]);
  const quad2d = vertexBuffer(16, 'vertex', [
    attribute('POSITION', 0, 0, 'float32x2'),
    attribute('TEXCOORD_0', 1, 8, 'float32x2'),
  ]);
  const uvVarying = varying('TEXCOORD_0', 0, 'vec2<f32>');
  const colorVarying = varying('COLOR_0', 0, 'vec4<f32>');
  return Object.freeze({
    'animation-2d': definition(animation2d, [
      group('frame', 0, [camera()]),
      group('object', 1, [uniform('object.animation2d', 0, VERTEX_FRAGMENT, 1296)]),
      textureGroup(2, 'material.baseTexture', 'material.baseSampler'),
      group('pass', 3, [
        ...Array.from({ length: 8 }, (_, index) => texture(`pass.compositeTexture${index}`, index)),
        sampler('pass.compositeSampler', 8),
      ]),
    ], [
      block('frame.camera', 64, [matrix('viewProj', 0)]),
      block('object.animation2d', 1296, [
        matrix('model', 0), field('color', 'vec4<f32>', 64, 16),
        field('multiplyColor', 'vec4<f32>', 80, 16),
        field('screenColor', 'vec4<f32>', 96, 16),
        field('params', 'vec4<f32>', 112, 16), field('uvRect', 'vec4<f32>', 128, 16),
        field('compositeParams', 'array<vec4<f32>, 8>', 144, 128),
        field('compositeExpansion0', 'vec4<f32>', 272, 16),
        field('compositeExpansion1', 'vec4<f32>', 288, 16),
        field('gradientParams', 'vec4<f32>', 304, 16),
        field('gradientGeometry', 'vec4<f32>', 320, 16),
        field('gradientColors', 'array<vec4<f32>, 8>', 336, 128),
        field('gradientOffsets0', 'vec4<f32>', 464, 16),
        field('gradientOffsets1', 'vec4<f32>', 480, 16),
        field('effectKinds0', 'vec4<f32>', 496, 16),
        field('effectKinds1', 'vec4<f32>', 512, 16),
        field('effectData', 'array<EffectData, 8>', 528, 768),
      ]),
    ], [quad2d], [uvVarying, varying('TEXCOORD_1', 1, 'vec2<f32>')], ['texture-sample'], ['alpha-blend', 'ordered-composite-stack', 'ordered-effect-stack']),
    'bitmap-text': definition(bitmapText, [
      group('frame', 0, [camera()]),
      group('object', 1, [
        uniform('object.model', 0, VERTEX, 64),
        uniform('object.textParameters', 1, FRAGMENT, 32),
      ]),
      textureGroup(2, 'material.fontTexture', 'material.fontSampler'),
    ], [
      block('frame.camera', 64, [matrix('viewProj', 0)]),
      block('object.model', 64, [matrix('matrix', 0)]),
      block('object.textParameters', 32, [
        field('color', 'vec4<f32>', 0, 16), field('mode', 'u32', 16, 4),
        field('threshold', 'f32', 20, 4), field('smoothing', 'f32', 24, 4),
        field('_pad', 'f32', 28, 4),
      ]),
    ], [vertexBuffer(20, 'vertex', [
      attribute('POSITION', 0, 0, 'float32x3'), attribute('TEXCOORD_0', 1, 12, 'float32x2'),
    ])], [uvVarying], ['texture-sample', 'discard'], ['bitmap-sdf-msdf']),
    'canvas-text-2d': definition(canvasText2d, [
      group('frame', 0, [camera()]), group('object', 1, [object64()]), textureGroup(),
    ], cameraObjectBlocks(), [quad2d], [uvVarying], ['texture-sample'], ['alpha-blend']),
    'gui-image': definition(guiImage, [
      group('frame', 0, [uniform('frame.viewport', 0, VERTEX, 16)]),
      group('material', 1, [texture('material.imageTexture', 0), sampler('material.imageSampler', 1)]),
    ], [viewportBlock()], [guiBuffer()], guiVaryings(true), ['texture-sample', 'discard'], ['screen-space-clip']),
    'gui-shape': definition(guiShape, [
      group('frame', 0, [uniform('frame.viewport', 0, VERTEX, 16)]),
    ], [viewportBlock()], [vertexBuffer(60, 'vertex', [
      attribute('POSITION', 0, 0, 'float32x2'),
      attribute('COLOR_0', 1, 8, 'float32x4'),
      attribute('RECT', 2, 24, 'float32x4'),
      attribute('RADIUS', 3, 40, 'float32'),
      attribute('CLIP_RECT', 4, 44, 'float32x4'),
    ])], [
      varying('SCREEN_POSITION', 0, 'vec2<f32>'), varying('COLOR_0', 1, 'vec4<f32>'),
      varying('RECT', 2, 'vec4<f32>'), varying('RADIUS', 3, 'f32'),
      varying('CLIP_RECT', 4, 'vec4<f32>'),
    ], ['discard', 'signed-distance-field'], ['screen-space-clip']),
    'gui-text': definition(guiText, [
      group('frame', 0, [uniform('frame.viewport', 0, VERTEX, 16)]),
      group('material', 1, [texture('material.fontTexture', 0), sampler('material.fontSampler', 1)]),
    ], [viewportBlock()], [guiBuffer()], guiVaryings(true), ['texture-sample', 'discard'], ['screen-space-clip']),
    'indexed-sprite': definition(indexedSprite, [
      group('frame', 0, [uniform('frame.viewport', 0, VERTEX, 16), storage('frame.instances', 1, VERTEX)]),
      group('material', 1, [
        uintTexture('material.indexAtlas', 0), texture('material.colorAtlas', 1),
        texture('material.paletteBank', 2), sampler('material.colorSampler', 3),
      ]),
    ], [viewportBlock()], [], [
      varying('TEXCOORD_0', 0, 'vec2<f32>'), flatVarying('UV_RECT', 1, 'vec4<f32>'),
      flatVarying('SPRITE_META', 2, 'vec4<u32>'), flatVarying('COLOR_0', 3, 'vec4<f32>'),
    ], ['storage-buffer', 'texture-load', 'texture-sample', 'instancing'], ['indexed-palette-bank', 'truecolor-atlas', 'alpha-blend']),
    mesh2d: definition(mesh2d, [
      group('frame', 0, [camera()]),
      group('object', 1, [storage('object.table', 0, VERTEX)]),
    ], [block('frame.camera', 64, [matrix('viewProj', 0)])], [
      vertexBuffer(8, 'vertex', [attribute('POSITION', 0, 0, 'float32x2')]),
    ], [colorVarying], ['storage-buffer'], ['instanced-object-table']),
    particle2d: definition(particle2d, [
      group('frame', 0, [camera()]),
      group('object', 1, [uniform('object.particle2d', 0, VERTEX_FRAGMENT, 80)]),
      textureGroup(2, 'material.particleTexture', 'material.particleSampler'),
    ], [
      block('frame.camera', 64, [matrix('viewProj', 0)]),
      block('object.particle2d', 80, [matrix('model', 0), field('params', 'vec4<f32>', 64, 16)]),
    ], particle2dBuffers(), [uvVarying, varying('COLOR_0', 1, 'vec4<f32>')],
    ['texture-sample', 'instancing'], ['alpha-blend']),
    'radial-shadow': definition(radialShadow, [
      group('frame', 0, [camera()]), group('object', 1, [object64()]),
      group('material', 2, [uniform('material.shadowParameters', 0, FRAGMENT, 32)]),
    ], [
      block('frame.camera', 64, [matrix('viewProj', 0)]),
      block('object.transform', 64, [matrix('model', 0)]),
      block('material.shadowParameters', 32, [
        field('colorOpacity', 'vec4<f32>', 0, 16), field('settings', 'vec4<f32>', 16, 16),
      ]),
    ], positionUv3dBuffers(), [uvVarying], ['smoothstep'], ['alpha-blend']),
    spine2d: definition(spine2d, [
      group('frame', 0, [camera()]), group('object', 1, [object64()]),
      textureGroup(2, 'material.atlasTexture', 'material.atlasSampler'),
    ], cameraObjectBlocks(), [vertexBuffer(32, 'vertex', [
      attribute('POSITION', 0, 0, 'float32x2'), attribute('TEXCOORD_0', 1, 8, 'float32x2'),
      attribute('COLOR_0', 2, 16, 'float32x4'),
    ])], [uvVarying, varying('COLOR_0', 1, 'vec4<f32>')], ['texture-sample'], ['alpha-blend']),
    tilemap2d: definition(tilemap2d, [
      group('frame', 0, [camera()]), group('object', 1, [object64()]),
    ], cameraObjectBlocks(), [vertexBuffer(24, 'vertex', [
      attribute('POSITION', 0, 0, 'float32x2'), attribute('COLOR_0', 1, 8, 'float32x4'),
    ])], [colorVarying], [], ['alpha-blend']),
    'basic-material': basicDefinition(SIMPLE_SOURCES['basic-material'], false),
    'basic-material-skinned': basicDefinition(SIMPLE_SOURCES['basic-material-skinned'], true),
    'mesh-helper': definition(SIMPLE_SOURCES['mesh-helper'], [
      sceneFrameGroup(VERTEX), group('object', 1, [uniform('object.meshHelper', 0, VERTEX_FRAGMENT, 96)]),
    ], [
      sceneFrameBlock(), block('object.meshHelper', 96, [
        matrix('model', 0), field('color', 'vec4<f32>', 64, 16), field('line', 'vec4<f32>', 80, 16),
      ]),
    ], [vertexBuffer(24, 'vertex', [
      attribute('LINE_START', 0, 0, 'float32x3'), attribute('LINE_END', 1, 12, 'float32x3'),
    ])], [], [], ['screen-space-line']),
    'normal-material': definition(SIMPLE_SOURCES['normal-material'], [
      sceneFrameGroup(VERTEX),
      group('object', 1, [
        storage('object.normalTable', 0, VERTEX_FRAGMENT),
        storage('object.clippingPlanes', 1, FRAGMENT),
      ]),
      group('material', 2, [uniform('material.normalParameters', 0, VERTEX, 16)]),
    ], [
      sceneFrameBlock(), block('material.normalParameters', 16, [
        field('space', 'u32', 0, 4), field('_pad0', 'u32', 4, 4),
        field('_pad1', 'u32', 8, 4), field('_pad2', 'u32', 12, 4),
      ]),
    ], positionNormalBuffers(), [
      varying('NORMAL', 0, 'vec3<f32>'), varying('WORLD_POSITION', 1, 'vec3<f32>'),
      flatVarying('OBJECT_INDEX', 2, 'u32'),
    ], ['storage-buffer', 'discard'], ['normal-visualization', 'world-space-clipping']),
    particle3d: definition(SIMPLE_SOURCES.particle3d, [
      group('frame', 0, [uniform('frame.particleCamera', 0, VERTEX, 96)]),
      group('object', 1, [uniform('object.particle3d', 0, VERTEX_FRAGMENT, 80)]),
      textureGroup(2, 'material.particleTexture', 'material.particleSampler'),
    ], [
      block('frame.particleCamera', 96, [
        matrix('viewProj', 0), field('right', 'vec4<f32>', 64, 16), field('up', 'vec4<f32>', 80, 16),
      ]),
      block('object.particle3d', 80, [matrix('model', 0), field('params', 'vec4<f32>', 64, 16)]),
    ], particle3dBuffers(), [uvVarying, varying('COLOR_0', 1, 'vec4<f32>')],
    ['texture-sample', 'instancing'], ['camera-facing-billboard', 'alpha-blend']),
    sky: definition(SIMPLE_SOURCES.sky, [
      sceneFrameGroup(FRAGMENT),
      group('material', 1, [uniform('material.skyParameters', 0, FRAGMENT, 48)]),
    ], [
      sceneFrameBlock(), block('material.skyParameters', 48, [
        field('sunDirection', 'vec4<f32>', 0, 16), field('params', 'vec4<f32>', 16, 16),
        field('params2', 'vec4<f32>', 32, 16),
      ]),
    ], [], [varying('CLIP_XY', 0, 'vec2<f32>')], ['inverse-view-projection'], ['fullscreen-triangle']),
  });
}

function basicDefinition(code: string, skinned: boolean): RenderDefinition {
  const groups = [
    sceneFrameGroup(VERTEX_FRAGMENT),
    group('object', 1, [
      storage('object.basicTable', 0, VERTEX_FRAGMENT),
      storage('object.clippingPlanes', 1, FRAGMENT),
    ]),
    group('material', 2, [
      uniform('material.basicParameters', 0, FRAGMENT, 48),
      texture('material.baseTexture', 1), sampler('material.baseSampler', 2),
      texture('material.emissiveTexture', 3),
    ]),
  ];
  if (skinned) groups.push(group('object', 3, [
    storage('object.skinMatrices', 0, VERTEX),
    storage('object.skinJoints', 1, VERTEX),
    storage('object.skinWeights', 2, VERTEX),
  ]));
  return definition(code, groups, [
    sceneFrameBlock(),
    block('material.basicParameters', 48, [
      field('color', 'vec4<f32>', 0, 16), field('emissiveFactor', 'vec4<f32>', 16, 16),
      field('useTexture', 'u32', 32, 4), field('useEmissiveTexture', 'u32', 36, 4),
      field('_pad1', 'u32', 40, 4), field('_pad2', 'u32', 44, 4),
    ]),
  ], basicVertexBuffers(), [
    varying('TEXCOORD_0', 0, 'vec2<f32>'), varying('NORMAL', 1, 'vec3<f32>'),
    varying('WORLD_POSITION', 2, 'vec3<f32>'),
    flatVarying('OBJECT_INDEX', 3, 'u32'),
  ], ['texture-sample', 'storage-buffer', 'morph-targets', ...(skinned ? ['skinning'] : [])],
  ['scene-frame-fog', 'world-space-clipping', ...(skinned ? ['deformation-group-3'] : [])]);
}

function definition(
  code: string,
  bindGroups: readonly PrecompiledShaderBindGroupV2[],
  uniformBlocks: readonly ShaderUniformBlockReflection[],
  vertexBuffers: readonly PrecompiledShaderVertexBufferV2[],
  varyings: readonly ShaderVaryingReflection[],
  capabilities: readonly string[],
  requirements: readonly string[],
): RenderDefinition {
  return Object.freeze({
    code, bindGroups: Object.freeze(bindGroups), uniformBlocks: Object.freeze(uniformBlocks),
    vertexBuffers: Object.freeze(vertexBuffers), varyings: Object.freeze(varyings),
    capabilities: Object.freeze(capabilities), requirements: Object.freeze(requirements),
  });
}

function group(
  logicalSpace: 'frame' | 'object' | 'material' | 'pass',
  physicalGroup: number,
  bindings: readonly PrecompiledShaderBindingV2[],
): PrecompiledShaderBindGroupV2 {
  const logicalGroup = { frame: 0, object: 1, material: 2, pass: 3 }[logicalSpace];
  return Object.freeze({
    logicalSpace, logicalGroup, physicalGroup, owner: 'renderer' as const,
    bindings: Object.freeze(bindings),
  });
}

function uniform(id: string, binding: number, visibility: readonly ShaderStage[], minBindingSize: number, dynamic = false): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id, binding, visibility,
    layout: Object.freeze({
      kind: 'buffer' as const, bufferType: 'uniform' as const,
      hasDynamicOffset: dynamic, minBindingSize,
    }),
  });
}

function storage(id: string, binding: number, visibility: readonly ShaderStage[]): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id, binding, visibility,
    layout: Object.freeze({
      kind: 'buffer' as const, bufferType: 'read-only-storage' as const,
      hasDynamicOffset: false, minBindingSize: 0,
    }),
  });
}

function texture(id: string, binding: number): PrecompiledShaderBindingV2 {
  return Object.freeze({ id, binding, visibility: FRAGMENT, layout: FLOAT_TEXTURE });
}

function uintTexture(id: string, binding: number): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id, binding, visibility: FRAGMENT,
    layout: Object.freeze({ kind: 'texture' as const, sampleType: 'uint' as const, viewDimension: '2d' as const, multisampled: false }),
  });
}

function sampler(id: string, binding: number): PrecompiledShaderBindingV2 {
  return Object.freeze({ id, binding, visibility: FRAGMENT, layout: FILTERING_SAMPLER });
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

function vertexBuffer(
  arrayStride: number,
  stepMode: 'vertex' | 'instance',
  attributes: readonly PrecompiledShaderVertexBufferV2['attributes'][number][],
): PrecompiledShaderVertexBufferV2 {
  return Object.freeze({ arrayStride, stepMode, attributes: Object.freeze(attributes) });
}

function attribute(semantic: string, shaderLocation: number, offset: number, format: string): PrecompiledShaderVertexBufferV2['attributes'][number] {
  return Object.freeze({ semantic, shaderLocation, offset, format });
}

function varying(semantic: string, location: number, type: string): ShaderVaryingReflection {
  return Object.freeze({ semantic, location, type, interpolation: 'perspective' as const });
}

function flatVarying(semantic: string, location: number, type: string): ShaderVaryingReflection {
  return Object.freeze({ semantic, location, type, interpolation: 'flat' as const });
}

function sceneFrameGroup(visibility: readonly ShaderStage[]): PrecompiledShaderBindGroupV2 {
  return group('frame', 0, [uniform('frame.scene', 0, visibility, 272, true)]);
}

function sceneFrameBlock(): ShaderUniformBlockReflection {
  return block('frame.scene', 272, [
    matrix('viewProjection', 0), matrix('view', 64), matrix('inverseViewProjection', 128),
    field('eyePosition', 'vec4<f32>', 192, 16), field('viewport', 'vec4<f32>', 208, 16),
    field('fog', 'FogUniforms', 224, 48),
  ]);
}

function viewportBlock(): ShaderUniformBlockReflection {
  return block('frame.viewport', 16, [
    field('size', 'vec2<f32>', 0, 8), field('_pad', 'vec2<f32>', 8, 8),
  ]);
}

function cameraObjectBlocks(): readonly ShaderUniformBlockReflection[] {
  return Object.freeze([
    block('frame.camera', 64, [matrix('viewProj', 0)]),
    block('object.transform', 64, [matrix('model', 0)]),
  ]);
}

function guiBuffer(): PrecompiledShaderVertexBufferV2 {
  return vertexBuffer(48, 'vertex', [
    attribute('POSITION', 0, 0, 'float32x2'), attribute('TEXCOORD_0', 1, 8, 'float32x2'),
    attribute('COLOR_0', 2, 16, 'float32x4'), attribute('CLIP_RECT', 3, 32, 'float32x4'),
  ]);
}

function guiVaryings(withUv: boolean): readonly ShaderVaryingReflection[] {
  return Object.freeze([
    varying('SCREEN_POSITION', 0, 'vec2<f32>'),
    ...(withUv ? [varying('TEXCOORD_0', 1, 'vec2<f32>')] : []),
    varying('COLOR_0', 2, 'vec4<f32>'), varying('CLIP_RECT', 3, 'vec4<f32>'),
  ]);
}

function positionUv3dBuffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([
    vertexBuffer(12, 'vertex', [attribute('POSITION', 0, 0, 'float32x3')]),
    vertexBuffer(8, 'vertex', [attribute('TEXCOORD_0', 1, 0, 'float32x2')]),
  ]);
}

function positionNormalBuffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([
    vertexBuffer(12, 'vertex', [attribute('POSITION', 0, 0, 'float32x3')]),
    vertexBuffer(12, 'vertex', [attribute('NORMAL', 1, 0, 'float32x3')]),
  ]);
}

function basicVertexBuffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([
    vertexBuffer(12, 'vertex', [attribute('POSITION', 0, 0, 'float32x3')]),
    vertexBuffer(12, 'vertex', [attribute('NORMAL', 1, 0, 'float32x3')]),
    vertexBuffer(8, 'vertex', [attribute('TEXCOORD_0', 2, 0, 'float32x2')]),
    vertexBuffer(12, 'vertex', [attribute('MORPH_POSITION_0', 3, 0, 'float32x3')]),
    vertexBuffer(12, 'vertex', [attribute('MORPH_POSITION_1', 4, 0, 'float32x3')]),
    vertexBuffer(12, 'vertex', [attribute('MORPH_POSITION_2', 5, 0, 'float32x3')]),
    vertexBuffer(12, 'vertex', [attribute('MORPH_POSITION_3', 6, 0, 'float32x3')]),
  ]);
}

function particle2dBuffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([
    vertexBuffer(16, 'vertex', [
      attribute('CORNER', 0, 0, 'float32x2'), attribute('TEXCOORD_0', 1, 8, 'float32x2'),
    ]),
    vertexBuffer(32, 'instance', [
      attribute('CENTER', 2, 0, 'float32x2'), attribute('SIZE', 3, 8, 'float32'),
      attribute('ROTATION', 4, 12, 'float32'), attribute('COLOR_0', 5, 16, 'float32x4'),
    ]),
  ]);
}

function particle3dBuffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([
    vertexBuffer(16, 'vertex', [
      attribute('CORNER', 0, 0, 'float32x2'), attribute('TEXCOORD_0', 1, 8, 'float32x2'),
    ]),
    vertexBuffer(48, 'instance', [
      attribute('CENTER', 2, 0, 'float32x3'), attribute('SIZE', 3, 12, 'float32'),
      attribute('ROTATION', 4, 16, 'float32'), attribute('COLOR_0', 5, 32, 'float32x4'),
    ]),
  ]);
}
