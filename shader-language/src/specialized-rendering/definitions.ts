import type {
  PrecompiledShaderBindGroupV2,
  PrecompiledShaderBindingV2,
  PrecompiledShaderPassV2Definition,
  PrecompiledShaderRenderTargetV2,
  PrecompiledShaderStageEntriesV2,
  PrecompiledShaderVertexBufferV2,
} from '../adapter/precompiled-v2';
import type { ShaderStage, ShaderUniformBlockReflection, ShaderVaryingReflection } from '../contracts';
import type { ProductionSpecializedRenderingOperation } from './contracts';
import fog from '../material-lighting/stdlib/fog.wgsl';
import pbrBrdf from '../material-lighting/stdlib/pbr-brdf.wgsl';
import sceneFrame from '../render-family/stdlib/simple-3d/scene-frame.wgsl';
import instancedMesh3d from './stdlib/instanced-mesh3d.wgsl';
import line3d from './stdlib/line3d.wgsl';
import planarMirror from './stdlib/planar-mirror-material.wgsl';
import volume from './stdlib/volume-material.wgsl';
import clippingPlanes from '../render-family/stdlib/simple-3d/clipping-planes.wgsl';
import textureConvolution from './stdlib/texture-convolution.wgsl';
import mipmap from './stdlib/mipmap.wgsl';
import equirectangularToCube from './stdlib/equirectangular-to-cube.wgsl';

interface Definition {
  readonly code: string;
  readonly entryPoints: PrecompiledShaderStageEntriesV2;
  readonly bindGroups: readonly PrecompiledShaderBindGroupV2[];
  readonly uniformBlocks: readonly ShaderUniformBlockReflection[];
  readonly vertexBuffers: readonly PrecompiledShaderVertexBufferV2[];
  readonly varyings: readonly ShaderVaryingReflection[];
  readonly renderTargets: readonly PrecompiledShaderRenderTargetV2[];
  readonly capabilities: readonly string[];
  readonly requirements: readonly string[];
}

const VERTEX = Object.freeze(['vertex'] as const);
const FRAGMENT = Object.freeze(['fragment'] as const);
const COMPUTE = Object.freeze(['compute'] as const);
const VERTEX_FRAGMENT = Object.freeze(['vertex', 'fragment'] as const);
const MAX_LIGHTS = 8;
const LIGHT_BYTES = 16 + MAX_LIGHTS * 64;
const SCENE_FRAME_BYTES = 272;

export function productionSpecializedRenderingModules(): Readonly<Record<string, string>> {
  return Object.freeze({
    fog: `${fog.trim()}\n`,
    sceneFrame: `${sceneFrame.trim()}\n`,
    pbrBrdf: `${pbrBrdf.trim()}\n`,
    instancedMesh3d: `${instancedMesh3d.trim()}\n`,
    line3d: `${line3d.trim()}\n`,
    planarMirror: `${planarMirror.trim()}\n`,
    volume: `${volume.trim()}\n`,
    textureConvolution: `${textureConvolution.trim()}\n`,
    mipmap: `${mipmap.trim()}\n`,
    equirectangularToCube: `${equirectangularToCube.trim()}\n`,
  });
}

export function emitProductionSpecializedRenderingPass(
  id: string,
  operation: ProductionSpecializedRenderingOperation,
  sourcePath: string,
  specializedModuleHash: string,
): { readonly code: string; readonly artifactPass: PrecompiledShaderPassV2Definition } {
  const selected = definitions()[operation];
  const code = `// haiyue:specialized-rendering-pass ${operation}\n`
    + '// haiyue:specialized-rendering-abi 1\n'
    + `// haiyue:specialized-rendering-module ${specializedModuleHash}\n`
    + `// source: ${sourcePath}\n\n${selected.code.trim()}\n`;
  return Object.freeze({
    code,
    artifactPass: Object.freeze({
      id,
      code,
      entryPoints: selected.entryPoints,
      bindGroups: selected.bindGroups,
      uniformBlocks: selected.uniformBlocks,
      vertexBuffers: selected.vertexBuffers,
      varyings: selected.varyings,
      renderTargets: selected.renderTargets,
      capabilities: selected.capabilities,
      passRequirements: selected.requirements,
      sourceMap: Object.freeze([Object.freeze({
        sourceId: `specialized-rendering.${operation}`,
        sourceName: sourcePath,
        generatedStartLine: 1,
        generatedEndLine: code.split('\n').length,
      })]),
    }),
  });
}

function definitions(): Readonly<Record<ProductionSpecializedRenderingOperation, Definition>> {
  const scene = [fog, sceneFrame].join('\n\n');
  return Object.freeze({
    'instanced-mesh3d': definition(
      [scene, pbrBrdf, specialize(instancedMesh3d, { MAX_LIGHTS: `${MAX_LIGHTS}u` })].join('\n\n'),
      renderEntries(),
      [
        group('frame', 0, 'renderer', [uniform('frame.scene', 0, VERTEX_FRAGMENT, SCENE_FRAME_BYTES, true)]),
        group('object', 1, 'renderer', [
          storage('object.transforms', 0, VERTEX),
          storage('object.colors', 1, VERTEX),
          storage('object.visibleIndices', 2, VERTEX),
          uniform('material.instancedParameters', 3, FRAGMENT, 16),
          uniform('pass.lights', 4, FRAGMENT, LIGHT_BYTES),
          uniform('pass.environment', 5, FRAGMENT, 48),
        ]),
      ],
      [sceneFrameBlock(), instancedMaterialBlock(), lightsBlock(), environmentBlock()],
      positionNormalUvBuffers(),
      [varying('COLOR', 0, 'vec4<f32>'), varying('TEXCOORD_0', 1, 'vec2<f32>'), varying('WORLD_POSITION', 2, 'vec3<f32>'), varying('WORLD_NORMAL', 3, 'vec3<f32>')],
      colorTarget(),
      ['storage-buffer', 'instancing', 'pbr-lighting', 'fog'],
      ['specialized-rendering-abi-v1', 'eight-light-cap', 'visible-index-indirection', 'fog-after-lighting'],
    ),
    line3d: definition(
      specialize(line3d, { CAP_SEGS: '8u', VERTS_PER_SEG: '54u' }),
      renderEntries(),
      [group('frame', 0, 'renderer', [
        uniform('frame.lineCamera', 0, VERTEX_FRAGMENT, 96),
        uniform('material.lineParameters', 1, VERTEX_FRAGMENT, 32),
        uniform('object.model', 2, VERTEX, 64),
        storage('geometry.linePoints', 3, VERTEX),
      ])],
      [lineCameraBlock(), lineParametersBlock(), matrixBlock('object.model')],
      Object.freeze([]),
      [varying('COLOR', 0, 'vec4<f32>'), varying('CAP_UV', 1, 'vec2<f32>')],
      colorTarget(),
      ['storage-buffer', 'procedural-vertex'],
      ['specialized-rendering-abi-v1', 'round-cap-segments-8', 'vertices-per-segment-54'],
    ),
    'planar-mirror': definition(
      [scene, planarMirror].join('\n\n'),
      renderEntries(),
      [
        group('frame', 0, 'renderer', [uniform('frame.scene', 0, VERTEX_FRAGMENT, SCENE_FRAME_BYTES, true)]),
        group('object', 1, 'renderer', [uniform('object.mirrorModel', 0, VERTEX, 64)]),
        group('material', 2, 'renderer', [
          uniform('material.planarMirror', 0, VERTEX_FRAGMENT, 80),
          texture('material.reflectionTexture', 1, FRAGMENT),
          sampler('material.reflectionSampler', 2, FRAGMENT),
        ]),
      ],
      [sceneFrameBlock(), matrixBlock('object.mirrorModel'), planarMirrorMaterialBlock()],
      [vertexBuffer(12, 'POSITION', 0, 'float32x3')],
      [varying('REFLECTION_CLIP', 0, 'vec4<f32>')],
      colorTarget(),
      ['texture-sample', 'explicit-lod', 'scene-frame'],
      ['specialized-rendering-abi-v1', 'reflection-clip-projection', 'single-mip-safe-sampling'],
    ),
    volume: definition(
      [scene, clippingPlanes, volume].join('\n\n'),
      renderEntries(),
      [
        group('frame', 0, 'renderer', [uniform('frame.scene', 0, VERTEX_FRAGMENT, SCENE_FRAME_BYTES, true)]),
        group('object', 1, 'renderer', [
          storage('object.volumeTable', 0, VERTEX_FRAGMENT),
          storage('object.clippingPlanes', 1, FRAGMENT),
        ]),
        group('material', 2, 'renderer', [
          texture('material.volumeTexture', 0, FRAGMENT, 'float', '3d'),
          sampler('material.volumeSampler', 1, FRAGMENT),
        ]),
      ],
      [sceneFrameBlock()],
      [vertexBuffer(12, 'POSITION', 0, 'float32x3')],
      [varying('LOCAL_POSITION', 0, 'vec3<f32>'), varying('OBJECT_SLOT', 1, 'u32', 'flat')],
      colorTarget(),
      ['storage-buffer', 'texture-3d', 'raymarch'],
      ['specialized-rendering-abi-v1', 'shared-volume-object-table', 'maximum-raymarch-steps-192', 'world-space-clipping'],
    ),
    'texture-convolution': definition(
      textureConvolution,
      computeEntries('main'),
      [group('pass', 0, 'artifact', [
        texture('pass.convolutionSource', 0, COMPUTE),
        storageTexture('pass.convolutionDestination', 1, COMPUTE, 'rgba8unorm'),
        uniform('pass.convolutionParameters', 2, COMPUTE, 64),
      ])],
      [convolutionParametersBlock()],
      Object.freeze([]),
      Object.freeze([]),
      Object.freeze([]),
      ['compute', 'storage-texture', 'texture-load'],
      ['specialized-rendering-abi-v1', 'rgba8unorm-output', 'workgroup-size-8x8', 'kernel-3x3'],
    ),
    mipmap: definition(
      mipmap,
      renderEntries(),
      [sampledTextureGroup()],
      Object.freeze([]),
      Object.freeze([]),
      [varying('TEXCOORD_0', 0, 'vec2<f32>')],
      colorTarget('runtime-renderable-format'),
      ['texture-sample', 'procedural-fullscreen-triangle'],
      ['specialized-rendering-abi-v1', 'one-level-per-pass', 'linear-clamp-sampler'],
    ),
    'equirectangular-to-cube': definition(
      equirectangularToCube,
      renderEntries(),
      [sampledTextureGroup()],
      Object.freeze([]),
      Object.freeze([]),
      [varying('TEXCOORD_0', 0, 'vec2<f32>'), varying('CUBE_FACE', 1, 'u32', 'flat')],
      colorTarget('rgba8unorm'),
      ['texture-sample', 'procedural-fullscreen-triangle', 'cube-projection'],
      ['specialized-rendering-abi-v1', 'six-face-instance-index', 'single-mip-output'],
    ),
  });
}

function definition(
  code: string,
  entryPoints: PrecompiledShaderStageEntriesV2,
  bindGroups: readonly PrecompiledShaderBindGroupV2[],
  uniformBlocks: readonly ShaderUniformBlockReflection[],
  vertexBuffers: readonly PrecompiledShaderVertexBufferV2[],
  varyings: readonly ShaderVaryingReflection[],
  renderTargets: readonly PrecompiledShaderRenderTargetV2[],
  capabilities: readonly string[],
  requirements: readonly string[],
): Definition {
  return Object.freeze({
    code,
    entryPoints: Object.freeze(entryPoints),
    bindGroups: Object.freeze(bindGroups),
    uniformBlocks: Object.freeze(uniformBlocks),
    vertexBuffers: Object.freeze(vertexBuffers),
    varyings: Object.freeze(varyings),
    renderTargets: Object.freeze(renderTargets),
    capabilities: Object.freeze(capabilities),
    requirements: Object.freeze(requirements),
  });
}

function renderEntries(): PrecompiledShaderStageEntriesV2 {
  return Object.freeze({ vertex: 'vs_main', fragment: 'fs_main' });
}

function computeEntries(entry: string): PrecompiledShaderStageEntriesV2 {
  return Object.freeze({ compute: entry });
}

function group(
  logicalSpace: 'frame' | 'object' | 'material' | 'pass',
  physicalGroup: number,
  owner: 'artifact' | 'renderer',
  bindings: readonly PrecompiledShaderBindingV2[],
): PrecompiledShaderBindGroupV2 {
  return Object.freeze({
    logicalSpace,
    logicalGroup: { frame: 0, object: 1, material: 2, pass: 3 }[logicalSpace],
    physicalGroup,
    owner,
    bindings: Object.freeze(bindings),
  });
}

function uniform(
  id: string,
  binding: number,
  visibility: readonly ShaderStage[],
  minBindingSize: number,
  hasDynamicOffset = false,
): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id,
    binding,
    visibility,
    layout: Object.freeze({ kind: 'buffer' as const, bufferType: 'uniform' as const, hasDynamicOffset, minBindingSize }),
  });
}

function storage(id: string, binding: number, visibility: readonly ShaderStage[]): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id,
    binding,
    visibility,
    layout: Object.freeze({ kind: 'buffer' as const, bufferType: 'read-only-storage' as const, hasDynamicOffset: false, minBindingSize: 0 }),
  });
}

function texture(
  id: string,
  binding: number,
  visibility: readonly ShaderStage[],
  sampleType: 'float' | 'unfilterable-float' | 'depth' | 'sint' | 'uint' = 'float',
  viewDimension: '1d' | '2d' | '2d-array' | 'cube' | 'cube-array' | '3d' = '2d',
): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id,
    binding,
    visibility,
    layout: Object.freeze({ kind: 'texture' as const, sampleType, viewDimension, multisampled: false }),
  });
}

function sampler(id: string, binding: number, visibility: readonly ShaderStage[]): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id,
    binding,
    visibility,
    layout: Object.freeze({ kind: 'sampler' as const, samplerType: 'filtering' as const }),
  });
}

function storageTexture(
  id: string,
  binding: number,
  visibility: readonly ShaderStage[],
  format: string,
): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id,
    binding,
    visibility,
    layout: Object.freeze({ kind: 'storage-texture' as const, access: 'write-only' as const, format, viewDimension: '2d' as const }),
  });
}

function sampledTextureGroup(): PrecompiledShaderBindGroupV2 {
  return group('pass', 0, 'artifact', [
    texture('pass.sourceTexture', 0, FRAGMENT),
    sampler('pass.sourceSampler', 1, FRAGMENT),
  ]);
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
  return block('frame.scene', SCENE_FRAME_BYTES, [
    matrix('viewProjection', 0), matrix('view', 64), matrix('inverseViewProjection', 128),
    field('eyePosition', 'vec4<f32>', 192, 16), field('viewport', 'vec4<f32>', 208, 16),
    field('fog', 'FogUniforms', 224, 48),
  ]);
}

function instancedMaterialBlock(): ShaderUniformBlockReflection {
  return block('material.instancedParameters', 16, [field('factors', 'vec4<f32>', 0, 16)]);
}

function lightsBlock(): ShaderUniformBlockReflection {
  return block('pass.lights', LIGHT_BYTES, [
    field('countVec', 'vec4<u32>', 0, 16), field('lights', 'array<LightData, 8>', 16, MAX_LIGHTS * 64),
  ]);
}

function environmentBlock(): ShaderUniformBlockReflection {
  return block('pass.environment', 48, [
    field('diffuseColor', 'vec4<f32>', 0, 16), field('specularColor', 'vec4<f32>', 16, 16), field('params', 'vec4<f32>', 32, 16),
  ]);
}

function lineCameraBlock(): ShaderUniformBlockReflection {
  return block('frame.lineCamera', 96, [
    matrix('viewProj', 0), field('camPos', 'vec3<f32>', 64, 12), field('viewport', 'vec2<f32>', 80, 8),
  ]);
}

function lineParametersBlock(): ShaderUniformBlockReflection {
  return block('material.lineParameters', 32, [
    field('color', 'vec4<f32>', 0, 16), field('width', 'f32', 16, 4),
    field('screenSpace', 'u32', 20, 4), field('capType', 'u32', 24, 4), field('numPoints', 'u32', 28, 4),
  ]);
}

function matrixBlock(id: string): ShaderUniformBlockReflection {
  return block(id, 64, [matrix(id === 'object.model' ? 'matrix' : 'model', 0)]);
}

function planarMirrorMaterialBlock(): ShaderUniformBlockReflection {
  return block('material.planarMirror', 80, [
    matrix('reflectionViewProjection', 0), field('tintReflectivity', 'vec4<f32>', 64, 16),
  ]);
}

function convolutionParametersBlock(): ShaderUniformBlockReflection {
  return block('pass.convolutionParameters', 64, [
    field('kernel0', 'vec4<f32>', 0, 16), field('kernel1', 'vec4<f32>', 16, 16), field('kernel2', 'vec4<f32>', 32, 16),
    field('size', 'vec2<u32>', 48, 8),
  ]);
}

function vertexBuffer(arrayStride: number, semantic: string, location: number, format: string): PrecompiledShaderVertexBufferV2 {
  return Object.freeze({
    arrayStride,
    stepMode: 'vertex' as const,
    attributes: Object.freeze([Object.freeze({ semantic, shaderLocation: location, offset: 0, format })]),
  });
}

function positionNormalUvBuffers(): readonly PrecompiledShaderVertexBufferV2[] {
  return Object.freeze([
    vertexBuffer(12, 'POSITION', 0, 'float32x3'),
    vertexBuffer(12, 'NORMAL', 1, 'float32x3'),
    vertexBuffer(8, 'TEXCOORD_0', 2, 'float32x2'),
  ]);
}

function varying(
  semantic: string,
  location: number,
  type: string,
  interpolation: 'perspective' | 'linear' | 'flat' = 'perspective',
): ShaderVaryingReflection {
  return Object.freeze({ semantic, location, type, interpolation });
}

function colorTarget(formatClass = 'color'): readonly PrecompiledShaderRenderTargetV2[] {
  return Object.freeze([Object.freeze({ location: 0, formatClass })]);
}

function specialize(source: string, values: Readonly<Record<string, string>>): string {
  let result = source;
  for (const [name, value] of Object.entries(values)) result = result.replace(new RegExp(`\\b${name}\\b`, 'g'), value);
  return result;
}
