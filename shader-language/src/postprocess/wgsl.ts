import type {
  ShaderResourceKind,
  ShaderResourceReflection,
  ShaderUniformBlockReflection,
  ShaderVaryingReflection,
} from '../contracts';
import { sha256Hex } from '../hash';
import type {
  CompileMotionBlurPostProcessV1Options,
  CompiledMotionBlurPassV1,
  CompiledMotionBlurPostProcessV1,
  MotionBlurPassReflection,
  MotionBlurPostProcessPass,
  MotionBlurPostProcessProgramV1,
} from './contracts';
import { shaderError } from '../diagnostics';

const FULLSCREEN_VERTEX = `struct VertexOutput {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> VertexOutput {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0),
  );
  var output : VertexOutput;
  output.pos = vec4<f32>(pos[vi], 0.0, 1.0);
  output.uv = uvs[vi];
  return output;
}`;

const RESOLVE_UNIFORM_BLOCK: ShaderUniformBlockReflection = Object.freeze({
  id: '@motion-blur-parameters',
  alignment: 16,
  byteSize: 48,
  fields: Object.freeze([
    field('resolution', 'vec4<f32>', 0, 16),
    field('settings', 'vec4<f32>', 16, 16),
    field('display', 'vec4<f32>', 32, 16),
  ]),
});

const TILE_UNIFORM_BLOCK: ShaderUniformBlockReflection = Object.freeze({
  id: '@motion-tile-parameters',
  alignment: 16,
  byteSize: 16,
  fields: Object.freeze([
    field('sourceSize', 'vec2<u32>', 0, 8),
    field('tileSize', 'u32', 8, 4),
    field('padding', 'u32', 12, 4),
  ]),
});

const VARYINGS: readonly ShaderVaryingReflection[] = Object.freeze([
  Object.freeze({ semantic: 'SCREEN_UV', location: 0, type: 'vec2<f32>', interpolation: 'perspective' as const }),
]);

export function compileMotionBlurPostProcessV1(
  program: MotionBlurPostProcessProgramV1,
  options: CompileMotionBlurPostProcessV1Options = {},
): CompiledMotionBlurPostProcessV1 {
  const passGroup = resolvePassGroup(options.passGroup);
  const typedModuleHash = sha256Hex(JSON.stringify({
    program: program.canonicalHash,
    operations: program.nodes.map(node => node.operation),
    velocityAbi: 'signed-uv',
    tileSize: 8,
    neighborhood: '3x3-tile',
  }));
  const compiled = [
    compilePass(program, 'motion-tile-max', typedModuleHash, emitTileMax(program, passGroup), passGroup),
    compilePass(program, 'motion-neighbor-max', typedModuleHash, emitNeighborMax(program, passGroup), passGroup),
    compilePass(program, 'motion-blur-resolve', typedModuleHash, emitResolve(program, passGroup), passGroup),
  ];
  const passes = Object.fromEntries(compiled.map(pass => [pass.pass, pass])) as
    Record<MotionBlurPostProcessPass, CompiledMotionBlurPassV1>;
  return Object.freeze({
    program,
    typedModuleHash,
    passes: Object.freeze(passes),
    plans: Object.freeze({
      centered: Object.freeze({
        mode: 'centered' as const,
        passes: Object.freeze(['motion-blur-resolve'] as const),
        activeIntermediateTextureCount: 0,
        allocatedIntermediateTextureCount: 2 as const,
        compilerSchedulesPasses: false as const,
      }),
      'tile-neighbor-max': Object.freeze({
        mode: 'tile-neighbor-max' as const,
        passes: Object.freeze([
          'motion-tile-max',
          'motion-neighbor-max',
          'motion-blur-resolve',
        ] as const),
        activeIntermediateTextureCount: 2,
        allocatedIntermediateTextureCount: 2 as const,
        compilerSchedulesPasses: false as const,
      }),
    }),
    variantPolicy: Object.freeze({
      dynamicParameters: Object.freeze([
        'shutter-angle',
        'intensity',
        'max-blur-pixels',
        'sample-count',
        'display-mode',
        'split-position',
      ] as const),
      displayModes: Object.freeze(['blur', 'split', 'velocity'] as const),
      specializationVariantCount: 0,
      pipelineCount: 3,
    }),
    generationPlacement: 'compile-or-warmup-only',
  });
}

function compilePass(
  program: MotionBlurPostProcessProgramV1,
  pass: MotionBlurPostProcessPass,
  typedModuleHash: string,
  fragmentSource: string,
  passGroup: number,
): CompiledMotionBlurPassV1 {
  const code = [
    `// haiyue:typed-ir ${program.canonicalHash}`,
    `// haiyue:postprocess-module ${typedModuleHash}`,
    FULLSCREEN_VERTEX,
    fragmentSource,
    '',
  ].join('\n\n');
  return Object.freeze({
    pass,
    code,
    typedModuleHash,
    canonicalHash: sha256Hex(`${program.canonicalHash}|${pass}|${code}`),
    reflection: createReflection(program, pass, passGroup),
  });
}

function createReflection(
  program: MotionBlurPostProcessProgramV1,
  pass: MotionBlurPostProcessPass,
  passGroup: number,
): MotionBlurPassReflection {
  let resources: readonly ShaderResourceReflection[];
  let uniformBlocks: readonly ShaderUniformBlockReflection[];
  if (pass === 'motion-tile-max') {
    resources = Object.freeze([
      reflected(program.resources.velocity, 0, 'texture', passGroup),
      reflected(program.resources.tileParameters, 1, 'uniform-buffer', passGroup),
    ]);
    uniformBlocks = Object.freeze([
      Object.freeze({ ...TILE_UNIFORM_BLOCK, id: program.resources.tileParameters }),
    ]);
  } else if (pass === 'motion-neighbor-max') {
    resources = Object.freeze([reflected(program.resources.tileMax, 0, 'texture', passGroup)]);
    uniformBlocks = Object.freeze([]);
  } else {
    resources = Object.freeze([
      reflected(program.resources.sourceColor, 0, 'texture', passGroup),
      reflected(program.resources.velocity, 1, 'texture', passGroup),
      reflected(program.resources.neighborMax, 2, 'texture', passGroup),
      reflected(program.resources.sampler, 3, 'sampler', passGroup),
      reflected(program.resources.parameters, 4, 'uniform-buffer', passGroup),
    ]);
    uniformBlocks = Object.freeze([
      Object.freeze({ ...RESOLVE_UNIFORM_BLOCK, id: program.resources.parameters }),
    ]);
  }
  return Object.freeze({
    pass,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    resources,
    uniformBlocks,
    varyings: VARYINGS,
    targetFormatClass: pass === 'motion-blur-resolve' ? 'color' : 'velocity-rg16float',
  });
}

function emitTileMax(program: MotionBlurPostProcessProgramV1, passGroup: number): string {
  return `struct MotionTileMaxParams {
  sourceSize : vec2<u32>,
  tileSize : u32,
  padding : u32,
}

@group(${passGroup}) @binding(0) var motionTexture : texture_2d<f32>;
@group(${passGroup}) @binding(1) var<uniform> params : MotionTileMaxParams;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec2<f32> {
  let tile = vec2<u32>(input.pos.xy);
  let origin = tile * params.tileSize;
  var strongest = vec2<f32>(0.0);
  var strongestMagnitude = 0.0;
  for (var y = 0u; y < 8u; y += 1u) {
    for (var x = 0u; x < 8u; x += 1u) {
      if (x >= params.tileSize || y >= params.tileSize) { continue; }
      let sourcePixel = origin + vec2<u32>(x, y);
      if (sourcePixel.x >= params.sourceSize.x || sourcePixel.y >= params.sourceSize.y) { continue; }
      let candidate = textureLoad(motionTexture, vec2<i32>(sourcePixel), 0).xy;
      let magnitude = dot(candidate, candidate);
      if (magnitude > strongestMagnitude) {
        strongest = candidate;
        strongestMagnitude = magnitude;
      }
    }
  }
  return strongest;
}`;
}

function emitNeighborMax(program: MotionBlurPostProcessProgramV1, passGroup: number): string {
  return `@group(${passGroup}) @binding(0) var tileMaxTexture : texture_2d<f32>;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec2<f32> {
  let dimensions = vec2<i32>(textureDimensions(tileMaxTexture, 0));
  let tile = clamp(vec2<i32>(input.pos.xy), vec2<i32>(0), dimensions - vec2<i32>(1));
  var strongest = vec2<f32>(0.0);
  var strongestMagnitude = 0.0;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let candidateTile = clamp(tile + vec2<i32>(x, y), vec2<i32>(0), dimensions - vec2<i32>(1));
      let candidate = textureLoad(tileMaxTexture, candidateTile, 0).xy;
      let magnitude = dot(candidate, candidate);
      if (magnitude > strongestMagnitude) {
        strongest = candidate;
        strongestMagnitude = magnitude;
      }
    }
  }
  return strongest;
}`;
}

function emitResolve(program: MotionBlurPostProcessProgramV1, passGroup: number): string {
  return `struct MotionBlurParams {
  resolution : vec4<f32>,
  settings : vec4<f32>,
  display : vec4<f32>,
}

@group(${passGroup}) @binding(0) var sourceTexture : texture_2d<f32>;
@group(${passGroup}) @binding(1) var motionTexture : texture_2d<f32>;
@group(${passGroup}) @binding(2) var neighborMaxTexture : texture_2d<f32>;
@group(${passGroup}) @binding(3) var linearSampler : sampler;
@group(${passGroup}) @binding(4) var<uniform> params : MotionBlurParams;

fn clampPixel(pixel : vec2<i32>, dimensions : vec2<i32>) -> vec2<i32> {
  return clamp(pixel, vec2<i32>(0), dimensions - vec2<i32>(1));
}

fn capVelocity(velocity : vec2<f32>) -> vec2<f32> {
  let velocityPixels = velocity * params.resolution.xy;
  let pixelLength = length(velocityPixels);
  if (pixelLength > params.settings.z && pixelLength > 0.000001) {
    return velocity * params.settings.z / pixelLength;
  }
  return velocity;
}

fn velocityHeatmap(velocity : vec2<f32>) -> vec4<f32> {
  let velocityPixels = velocity * params.resolution.xy;
  let magnitude = length(velocityPixels);
  if (magnitude < 0.15) { return vec4<f32>(0.012, 0.018, 0.035, 1.0); }
  let direction = atan2(velocityPixels.y, velocityPixels.x);
  let phase = vec3<f32>(0.0, 2.0943951, 4.1887902);
  let hue = 0.5 + 0.5 * cos(vec3<f32>(direction) + phase);
  let brightness = sqrt(clamp(magnitude / max(params.settings.z, 1.0), 0.0, 1.0));
  return vec4<f32>(hue * (0.06 + brightness * 0.94), 1.0);
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let dimensions = vec2<i32>(textureDimensions(sourceTexture, 0));
  let pixel = clampPixel(vec2<i32>(input.pos.xy), dimensions);
  let source = textureLoad(sourceTexture, pixel, 0);
  let velocityScale = params.settings.x * params.settings.y;
  let currentVelocity = textureLoad(motionTexture, pixel, 0).xy * velocityScale;
  if (params.display.x > 1.5) { return velocityHeatmap(currentVelocity); }

  let sampleCount = u32(clamp(round(params.settings.w), 1.0, 32.0));
  let currentPixels = length(currentVelocity * params.resolution.xy);
  var velocity = currentVelocity;
  if (params.display.y > 0.5 && currentPixels < 0.5) {
    let tileSize = max(1u, u32(round(params.display.w)));
    let tile = vec2<i32>(vec2<u32>(pixel) / tileSize);
    velocity = textureLoad(neighborMaxTexture, tile, 0).xy * velocityScale;
  }
  velocity = capVelocity(velocity);
  if (sampleCount <= 1u || dot(velocity, velocity) < 0.0000000001) { return source; }

  let reconstruction = params.display.y > 0.5;
  let stationaryReceiver = reconstruction && currentPixels < 0.5;
  let direction = normalize(velocity * params.resolution.xy);
  var accumulated = select(vec4<f32>(0.0), source, stationaryReceiver);
  var totalWeight = select(0.0, 1.0, stationaryReceiver);
  for (var sampleIndex = 0u; sampleIndex < 32u; sampleIndex += 1u) {
    if (sampleIndex >= sampleCount) { break; }
    let t = f32(sampleIndex) / f32(sampleCount - 1u) - 0.5;
    let sampleUv = clamp(input.uv + velocity * t, vec2<f32>(0.0), vec2<f32>(1.0));
    var weight = 1.0;
    if (stationaryReceiver) {
      let samplePixel = clampPixel(vec2<i32>(sampleUv * params.resolution.xy), dimensions);
      let sampleVelocity = textureLoad(motionTexture, samplePixel, 0).xy * velocityScale * params.resolution.xy;
      let sampleMagnitude = length(sampleVelocity);
      let alignment = select(0.0, dot(sampleVelocity / sampleMagnitude, direction), sampleMagnitude > 0.0001);
      let motionContribution = smoothstep(0.5, 1.5, sampleMagnitude);
      weight = motionContribution * smoothstep(0.2, 0.75, alignment) * (1.0 - abs(t) * 0.35);
    }
    accumulated += textureSampleLevel(sourceTexture, linearSampler, sampleUv, 0.0) * weight;
    totalWeight += weight;
  }
  let blurred = select(source, accumulated / totalWeight, totalWeight > 0.000001);
  if (params.display.x > 0.5) {
    let divider = abs(input.uv.x - params.display.z) * params.resolution.x;
    if (divider < 1.0) { return vec4<f32>(0.94, 0.98, 1.0, 1.0); }
    return select(source, blurred, input.uv.x >= params.display.z);
  }
  return blurred;
}`;
}

function reflected(
  id: string,
  binding: number,
  kind: ShaderResourceKind,
  group: number,
): ShaderResourceReflection {
  return Object.freeze({
    id,
    space: 'pass',
    group,
    binding,
    kind,
    visibility: Object.freeze(['fragment'] as const),
  });
}

function resolvePassGroup(value: number | undefined): number {
  const group = value ?? 3;
  if (!Number.isInteger(group) || group < 0 || group > 3) {
    shaderError('E_SHADER_RESOURCE_LIMIT', `Motion blur physical pass group ${group} must be an integer in [0, 3].`, {
      moduleId: '@motion-blur-postprocess-v1',
      path: 'options.passGroup',
    });
  }
  return group;
}

function field(
  name: string,
  type: string,
  offset: number,
  size: number,
): ShaderUniformBlockReflection['fields'][number] {
  return Object.freeze({ name, type, offset, size });
}
