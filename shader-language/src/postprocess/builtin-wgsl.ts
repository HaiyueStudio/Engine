import type {
  PrecompiledShaderBindingV2,
  PrecompiledShaderPassV2Definition,
} from '../adapter/precompiled-v2';
import type { ShaderUniformBlockReflection } from '../contracts';
import type { BuiltinPostprocessOperation } from './builtin-contracts';

export const FULLSCREEN_POSTPROCESS_VERTEX_WGSL = `struct VertexOutput {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0,  1.0),
    vec2<f32>(2.0,  1.0),
    vec2<f32>(0.0, -1.0),
  );
  var output : VertexOutput;
  output.pos = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}`;

interface BuiltinPassEmission {
  readonly id: string;
  readonly operation: BuiltinPostprocessOperation;
  readonly fragmentSource: string;
  readonly artifactPass: PrecompiledShaderPassV2Definition;
}

interface BuiltinPassDefinition {
  readonly fragment: string;
  readonly bindings: readonly PrecompiledShaderBindingV2[];
  readonly uniformBlocks: readonly ShaderUniformBlockReflection[];
  readonly renderTargetCount: 1 | 2;
  readonly capabilities: readonly string[];
  readonly requirements: readonly string[];
}

const TEXTURE = Object.freeze({
  kind: 'texture' as const,
  sampleType: 'float' as const,
  viewDimension: '2d' as const,
  multisampled: false,
});
const UNFILTERABLE_TEXTURE = Object.freeze({ ...TEXTURE, sampleType: 'unfilterable-float' as const });
const FILTERING_SAMPLER = Object.freeze({ kind: 'sampler' as const, samplerType: 'filtering' as const });

function getDefinitions(): Readonly<Record<BuiltinPostprocessOperation, BuiltinPassDefinition>> {
  return Object.freeze({
  present: definition(PRESENT_FRAGMENT, [texture('pass.sourceColor', 0)], [], 1, ['texture-load']),
  grayscale: definition(GRAYSCALE_FRAGMENT, [
    texture('pass.sourceColor', 0), sampler('pass.linearSampler', 1),
  ]),
  sobel: definition(SOBEL_FRAGMENT, [
    texture('pass.sourceColor', 0), sampler('pass.linearSampler', 1), uniform('pass.sobelParameters', 2, 32),
  ], [block('pass.sobelParameters', 32, [
    field('edgeColorStrength', 'vec4<f32>', 0, 16),
    field('thresholdBlendMode', 'vec4<f32>', 16, 16),
  ])], 1, ['texture-load', 'texture-sample']),
  fxaa: definition(FXAA_FRAGMENT, [
    texture('pass.sourceColor', 0), sampler('pass.linearSampler', 1),
  ], [], 1, ['texture-sample']),
  'gaussian-blur': definition(GAUSSIAN_BLUR_FRAGMENT, [
    texture('pass.sourceColor', 0), sampler('pass.linearSampler', 1), uniform('pass.gaussianBlurParameters', 2, 32),
  ], [block('pass.gaussianBlurParameters', 32, [
    field('direction', 'vec2<f32>', 0, 8),
    field('texelSize', 'vec2<f32>', 8, 8),
    field('sigma', 'f32', 16, 4),
    field('radius', 'i32', 20, 4),
    field('padding', 'vec2<u32>', 24, 8),
  ])], 1, ['texture-sample-level', 'dynamic-loop']),
  'outline-edge': definition(OUTLINE_EDGE_FRAGMENT, [
    texture('pass.outlineMask', 0),
    texture('pass.outlineVisibleMask', 1),
    sampler('pass.linearSampler', 2),
    uniform('pass.outlineParameters', 3, 48),
  ], [outlineParameters('_padding')], 1, ['texture-sample-level'], ['outline-mask', 'outline-visible-mask']),
  'outline-blur': definition(OUTLINE_BLUR_FRAGMENT, [
    texture('pass.outlineColor', 0),
    sampler('pass.linearSampler', 1),
    uniform('pass.outlineBlurParameters', 2, 32),
  ], [block('pass.outlineBlurParameters', 32, [
    field('direction', 'vec2<f32>', 0, 8),
    field('texelSize', 'vec2<f32>', 8, 8),
    field('radius', 'f32', 16, 4),
    field('padding0', 'f32', 20, 4),
    field('padding1', 'f32', 24, 4),
    field('padding2', 'f32', 28, 4),
  ])], 1, ['texture-sample-level', 'bounded-loop']),
  'outline-overlay': definition(OUTLINE_OVERLAY_FRAGMENT, [
    texture('pass.sourceColor', 0),
    texture('pass.outlineEdge', 1),
    texture('pass.outlineGlow', 2),
    sampler('pass.linearSampler', 3),
    uniform('pass.outlineParameters', 4, 48),
    texture('pass.outlineMask', 5),
  ], [outlineParameters('blendMode')], 1, ['texture-sample-level'], ['outline-mask']),
  taa: definition(TAA_FRAGMENT, [
    texture('pass.currentColor', 0),
    texture('pass.historyColor', 1),
    texture('pass.currentDepth', 2, true),
    sampler('pass.linearSampler', 3),
    uniform('pass.taaParameters', 4, 176),
  ], [block('pass.taaParameters', 176, [
    matrixField('currentInverseViewProjection', 0),
    matrixField('previousViewProjection', 64),
    field('resolutionFeedback', 'vec4<f32>', 128, 16),
    field('depthHistory', 'vec4<f32>', 144, 16),
    field('projection', 'vec4<f32>', 160, 16),
  ])], 2, ['texture-load', 'texture-sample-level', 'multiple-render-targets'], ['linear-depth', 'view-local-history']),
  ssao: ambientOcclusionDefinition(SSAO_FRAGMENT),
  sao: ambientOcclusionDefinition(SAO_FRAGMENT),
  gtao: ambientOcclusionDefinition(GTAO_FRAGMENT),
  'ao-denoise': ambientOcclusionDenoiseDefinition(AO_DENOISE_FRAGMENT),
  'ao-upscale': ambientOcclusionDenoiseDefinition(AO_UPSCALE_FRAGMENT),
  });
}

function ambientOcclusionDefinition(fragment: string): BuiltinPassDefinition {
  return definition(fragment, [
    texture('pass.sourceColor', 0),
    texture('pass.linearDepth', 1, true),
    texture('pass.viewNormal', 2),
    sampler('pass.linearSampler', 3),
    uniform('pass.ambientOcclusionParameters', 4, 192),
  ], [block('pass.ambientOcclusionParameters', 192, [
    field('resolution', 'vec4<f32>', 0, 16),
    field('radiusIntensityBiasPower', 'vec4<f32>', 16, 16),
    field('camera', 'vec4<f32>', 32, 16),
    field('settings', 'vec4<f32>', 48, 16),
    matrixField('projectionMatrix', 64),
    matrixField('inverseProjectionMatrix', 128),
  ])], 1, ['texture-load', 'texture-sample-level', 'bounded-loop'], ['linear-depth', 'view-normal']);
}

function ambientOcclusionDenoiseDefinition(fragment: string): BuiltinPassDefinition {
  return definition(fragment, [
    texture('pass.sourceColor', 0),
    texture('pass.ambientOcclusion', 1, true),
    texture('pass.linearDepth', 2, true),
    texture('pass.viewNormal', 3),
    sampler('pass.linearSampler', 4),
    uniform('pass.ambientOcclusionParameters', 5, 192),
  ], [block('pass.ambientOcclusionParameters', 192, [
    field('resolution', 'vec4<f32>', 0, 16),
    field('radiusIntensityBiasPower', 'vec4<f32>', 16, 16),
    field('camera', 'vec4<f32>', 32, 16),
    field('settings', 'vec4<f32>', 48, 16),
    matrixField('projectionMatrix', 64),
    matrixField('inverseProjectionMatrix', 128),
  ])], 1, ['texture-load', 'texture-sample-level', 'bounded-loop'], ['ambient-occlusion', 'linear-depth', 'view-normal']);
}

export function emitBuiltinPostprocessPass(
  id: string,
  operation: BuiltinPostprocessOperation,
  vertexSource: string,
  physicalGroup: number,
  sourcePath: string,
): BuiltinPassEmission {
  const definition = getDefinitions()[operation];
  const fragmentSource = definition.fragment.replaceAll('__GROUP__', String(physicalGroup));
  const code = [
    `// haiyue:builtin-postprocess ${operation}`,
    vertexSource,
    fragmentSource,
    '',
  ].join('\n\n');
  const lineCount = code.split('\n').length;
  return Object.freeze({
    id,
    operation,
    fragmentSource,
    artifactPass: Object.freeze({
      id,
      code,
      entryPoints: Object.freeze({ vertex: 'vs_main', fragment: 'fs_main' }),
      bindGroups: Object.freeze([Object.freeze({
        logicalSpace: 'pass' as const,
        logicalGroup: 3,
        physicalGroup,
        owner: 'artifact' as const,
        bindings: definition.bindings,
      })]),
      uniformBlocks: definition.uniformBlocks,
      vertexBuffers: Object.freeze([]),
      varyings: Object.freeze([Object.freeze({
        semantic: 'SCREEN_UV', location: 0, type: 'vec2<f32>', interpolation: 'perspective' as const,
      })]),
      renderTargets: Object.freeze(Array.from({ length: definition.renderTargetCount }, (_value, location) => Object.freeze({
        location, formatClass: 'color',
      }))),
      capabilities: definition.capabilities,
      passRequirements: Object.freeze(['fullscreen-triangle', ...definition.requirements]),
      sourceMap: Object.freeze([Object.freeze({
        sourceId: `builtin.${operation}`,
        sourceName: sourcePath,
        generatedStartLine: 1,
        generatedEndLine: lineCount,
      })]),
    }),
  });
}

function definition(
  fragment: string,
  bindings: readonly PrecompiledShaderBindingV2[],
  uniformBlocks: readonly ShaderUniformBlockReflection[] = [],
  renderTargetCount: 1 | 2 = 1,
  capabilities: readonly string[] = ['texture-sample'],
  requirements: readonly string[] = [],
): BuiltinPassDefinition {
  return Object.freeze({
    fragment,
    bindings: Object.freeze(bindings),
    uniformBlocks: Object.freeze(uniformBlocks),
    renderTargetCount,
    capabilities: Object.freeze(capabilities),
    requirements: Object.freeze(requirements),
  });
}

function texture(id: string, binding: number, unfilterable = false): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id, binding, visibility: Object.freeze(['fragment'] as const),
    layout: unfilterable ? UNFILTERABLE_TEXTURE : TEXTURE,
  });
}

function sampler(id: string, binding: number): PrecompiledShaderBindingV2 {
  return Object.freeze({ id, binding, visibility: Object.freeze(['fragment'] as const), layout: FILTERING_SAMPLER });
}

function uniform(id: string, binding: number, minBindingSize: number): PrecompiledShaderBindingV2 {
  return Object.freeze({
    id, binding, visibility: Object.freeze(['fragment'] as const),
    layout: Object.freeze({
      kind: 'buffer' as const,
      bufferType: 'uniform' as const,
      hasDynamicOffset: false,
      minBindingSize,
    }),
  });
}

function block(
  id: string,
  byteSize: number,
  fields: readonly ShaderUniformBlockReflection['fields'][number][],
): ShaderUniformBlockReflection {
  return Object.freeze({ id, alignment: 16, byteSize, fields: Object.freeze(fields) });
}

function outlineParameters(lastField: '_padding' | 'blendMode'): ShaderUniformBlockReflection {
  return block('pass.outlineParameters', 48, [
    field('visibleEdgeColor', 'vec4<f32>', 0, 16),
    field('hiddenEdgeColor', 'vec4<f32>', 16, 16),
    field('edgeStrength', 'f32', 32, 4),
    field('edgeThickness', 'f32', 36, 4),
    field('edgeGlow', 'f32', 40, 4),
    field(lastField, 'f32', 44, 4),
  ]);
}

function field(name: string, type: string, offset: number, size: number): ShaderUniformBlockReflection['fields'][number] {
  return Object.freeze({ name, type, offset, size });
}

function matrixField(name: string, offset: number): ShaderUniformBlockReflection['fields'][number] {
  return Object.freeze({ name, type: 'mat4x4<f32>', offset, size: 64, matrixStride: 16 });
}

const PRESENT_FRAGMENT = `@group(__GROUP__) @binding(0) var sourceTexture : texture_2d<f32>;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  return textureLoad(sourceTexture, vec2<i32>(input.pos.xy), 0);
}`;

const GRAYSCALE_FRAGMENT = `@group(__GROUP__) @binding(0) var sourceTexture : texture_2d<f32>;
@group(__GROUP__) @binding(1) var linearSampler : sampler;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(sourceTexture, linearSampler, input.uv);
  let luma = dot(color.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  return vec4<f32>(luma, luma, luma, color.a);
}`;

const SOBEL_FRAGMENT = `struct SobelParams {
  edgeColorStrength : vec4<f32>,
  thresholdBlendMode : vec4<f32>,
}

@group(__GROUP__) @binding(0) var sourceTexture : texture_2d<f32>;
@group(__GROUP__) @binding(1) var linearSampler : sampler;
@group(__GROUP__) @binding(2) var<uniform> params : SobelParams;

fn luma(color : vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn sampleLuma(coordinate : vec2<i32>, dimensions : vec2<i32>) -> f32 {
  let pixel = clamp(coordinate, vec2<i32>(0), dimensions - vec2<i32>(1));
  return luma(textureLoad(sourceTexture, pixel, 0).rgb);
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let dimensionsU = textureDimensions(sourceTexture, 0);
  let dimensions = vec2<i32>(i32(dimensionsU.x), i32(dimensionsU.y));
  let coordinate = clamp(vec2<i32>(input.uv * vec2<f32>(dimensionsU)), vec2<i32>(0), dimensions - vec2<i32>(1));
  let topLeft = sampleLuma(coordinate + vec2<i32>(-1, -1), dimensions);
  let topCenter = sampleLuma(coordinate + vec2<i32>(0, -1), dimensions);
  let topRight = sampleLuma(coordinate + vec2<i32>(1, -1), dimensions);
  let middleLeft = sampleLuma(coordinate + vec2<i32>(-1, 0), dimensions);
  let middleRight = sampleLuma(coordinate + vec2<i32>(1, 0), dimensions);
  let bottomLeft = sampleLuma(coordinate + vec2<i32>(-1, 1), dimensions);
  let bottomCenter = sampleLuma(coordinate + vec2<i32>(0, 1), dimensions);
  let bottomRight = sampleLuma(coordinate + vec2<i32>(1, 1), dimensions);
  let gradientX = -topLeft - 2.0 * middleLeft - bottomLeft + topRight + 2.0 * middleRight + bottomRight;
  let gradientY = -topLeft - 2.0 * topCenter - topRight + bottomLeft + 2.0 * bottomCenter + bottomRight;
  let strength = max(params.edgeColorStrength.w, 0.0);
  let threshold = max(params.thresholdBlendMode.x, 0.0);
  let blend = clamp(params.thresholdBlendMode.y, 0.0, 1.0);
  let edgeOnly = params.thresholdBlendMode.z > 0.5;
  let edge = smoothstep(threshold, threshold + 0.12, length(vec2<f32>(gradientX, gradientY)) * strength);
  let edgeColor = params.edgeColorStrength.rgb;
  if (edgeOnly) { return vec4<f32>(edgeColor * edge, 1.0); }
  let base = textureSample(sourceTexture, linearSampler, input.uv);
  return vec4<f32>(mix(base.rgb, edgeColor, edge * blend), base.a);
}`;

const FXAA_FRAGMENT = `@group(__GROUP__) @binding(0) var sourceTexture : texture_2d<f32>;
@group(__GROUP__) @binding(1) var linearSampler : sampler;

const FXAA_REDUCE_MIN : f32 = 0.0078125;
const FXAA_REDUCE_MUL : f32 = 0.125;
const FXAA_SPAN_MAX : f32 = 8.0;

fn luma(color : vec3<f32>) -> f32 { return dot(color, vec3<f32>(0.299, 0.587, 0.114)); }

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let dimensions = textureDimensions(sourceTexture, 0);
  let reciprocalFrame = vec2<f32>(1.0 / f32(dimensions.x), 1.0 / f32(dimensions.y));
  let uv = input.uv;
  let rgbNW = textureSample(sourceTexture, linearSampler, uv + vec2<f32>(-1.0, -1.0) * reciprocalFrame).rgb;
  let rgbNE = textureSample(sourceTexture, linearSampler, uv + vec2<f32>(1.0, -1.0) * reciprocalFrame).rgb;
  let rgbSW = textureSample(sourceTexture, linearSampler, uv + vec2<f32>(-1.0, 1.0) * reciprocalFrame).rgb;
  let rgbSE = textureSample(sourceTexture, linearSampler, uv + vec2<f32>(1.0, 1.0) * reciprocalFrame).rgb;
  let rgbM = textureSample(sourceTexture, linearSampler, uv).rgb;
  let lumaNW = luma(rgbNW);
  let lumaNE = luma(rgbNE);
  let lumaSW = luma(rgbSW);
  let lumaSE = luma(rgbSE);
  let lumaM = luma(rgbM);
  let lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  let lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
  var direction = vec2<f32>(
    -((lumaNW + lumaNE) - (lumaSW + lumaSE)),
    ((lumaNW + lumaSW) - (lumaNE + lumaSE)),
  );
  let directionReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * (0.25 * FXAA_REDUCE_MUL), FXAA_REDUCE_MIN);
  let reciprocalDirectionMin = 1.0 / (min(abs(direction.x), abs(direction.y)) + directionReduce);
  direction = clamp(direction * reciprocalDirectionMin, vec2<f32>(-FXAA_SPAN_MAX), vec2<f32>(FXAA_SPAN_MAX)) * reciprocalFrame;
  let rgbA = 0.5 * (
    textureSample(sourceTexture, linearSampler, uv + direction * (1.0 / 3.0 - 0.5)).rgb +
    textureSample(sourceTexture, linearSampler, uv + direction * (2.0 / 3.0 - 0.5)).rgb
  );
  let rgbB = rgbA * 0.5 + 0.25 * (
    textureSample(sourceTexture, linearSampler, uv + direction * -0.5).rgb +
    textureSample(sourceTexture, linearSampler, uv + direction * 0.5).rgb
  );
  let lumaB = luma(rgbB);
  if (lumaB < lumaMin || lumaB > lumaMax) { return vec4<f32>(rgbA, 1.0); }
  return vec4<f32>(rgbB, 1.0);
}`;

const GAUSSIAN_BLUR_FRAGMENT = `struct BlurParams {
  direction : vec2<f32>,
  texelSize : vec2<f32>,
  sigma : f32,
  radius : i32,
  padding : vec2<u32>,
}

@group(__GROUP__) @binding(0) var sourceTexture : texture_2d<f32>;
@group(__GROUP__) @binding(1) var linearSampler : sampler;
@group(__GROUP__) @binding(2) var<uniform> params : BlurParams;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  var color = vec4<f32>(0.0);
  var totalWeight = 0.0;
  let sigmaSquared = params.sigma * params.sigma;
  for (var index = -params.radius; index <= params.radius; index += 1) {
    let offset = params.direction * params.texelSize * f32(index);
    let weight = exp(-0.5 * f32(index * index) / sigmaSquared);
    color += textureSampleLevel(sourceTexture, linearSampler, input.uv + offset, 0.0) * weight;
    totalWeight += weight;
  }
  return color / totalWeight;
}`;

const OUTLINE_BLUR_FRAGMENT = `struct BlurParams {
  direction : vec2<f32>,
  texelSize : vec2<f32>,
  radius : f32,
  padding0 : f32,
  padding1 : f32,
  padding2 : f32,
}

@group(__GROUP__) @binding(0) var outlineColor : texture_2d<f32>;
@group(__GROUP__) @binding(1) var linearSampler : sampler;
@group(__GROUP__) @binding(2) var<uniform> params : BlurParams;

fn gaussianPdf(value : f32, sigma : f32) -> f32 {
  return 0.39894 * exp(-0.5 * value * value / (sigma * sigma)) / sigma;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let radius = clamp(params.radius, 1.0, 12.0);
  let sigma = max(radius * 0.5, 0.0001);
  var sum = textureSampleLevel(outlineColor, linearSampler, input.uv, 0.0) * gaussianPdf(0.0, sigma);
  var weightSum = gaussianPdf(0.0, sigma);
  for (var index = 1; index <= 12; index += 1) {
    let distance = f32(index);
    if (distance <= radius) {
      let weight = gaussianPdf(distance, sigma);
      let offset = params.direction * params.texelSize * distance;
      sum += textureSampleLevel(outlineColor, linearSampler, input.uv + offset, 0.0) * weight;
      sum += textureSampleLevel(outlineColor, linearSampler, input.uv - offset, 0.0) * weight;
      weightSum += 2.0 * weight;
    }
  }
  return sum / weightSum;
}`;

const OUTLINE_EDGE_FRAGMENT = `struct OutlineParams {
  visibleEdgeColor : vec4<f32>,
  hiddenEdgeColor : vec4<f32>,
  edgeStrength : f32,
  edgeThickness : f32,
  edgeGlow : f32,
  padding : f32,
}

@group(__GROUP__) @binding(0) var outlineMask : texture_2d<f32>;
@group(__GROUP__) @binding(1) var visibleOutlineMask : texture_2d<f32>;
@group(__GROUP__) @binding(2) var linearSampler : sampler;
@group(__GROUP__) @binding(3) var<uniform> params : OutlineParams;

fn maskAt(uv : vec2<f32>) -> f32 { return textureSampleLevel(outlineMask, linearSampler, uv, 0.0).r; }
fn visibleAt(uv : vec2<f32>) -> f32 { return textureSampleLevel(visibleOutlineMask, linearSampler, uv, 0.0).r; }

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let dimensions = textureDimensions(outlineMask, 0);
  let texel = vec2<f32>(1.0 / f32(dimensions.x), 1.0 / f32(dimensions.y));
  let radius = max(params.edgeThickness, 1.0);
  let offsetX = vec2<f32>(texel.x * radius, 0.0);
  let offsetY = vec2<f32>(0.0, texel.y * radius);
  let uvRight = clamp(input.uv + offsetX, vec2<f32>(0.0), vec2<f32>(1.0));
  let uvLeft = clamp(input.uv - offsetX, vec2<f32>(0.0), vec2<f32>(1.0));
  let uvUp = clamp(input.uv + offsetY, vec2<f32>(0.0), vec2<f32>(1.0));
  let uvDown = clamp(input.uv - offsetY, vec2<f32>(0.0), vec2<f32>(1.0));
  let gradientX = (maskAt(uvRight) - maskAt(uvLeft)) * 0.5;
  let gradientY = (maskAt(uvUp) - maskAt(uvDown)) * 0.5;
  let weightX = abs(gradientX);
  let weightY = abs(gradientY);
  let visibleX = select(visibleAt(uvLeft), visibleAt(uvRight), gradientX > 0.0);
  let visibleY = select(visibleAt(uvDown), visibleAt(uvUp), gradientY > 0.0);
  let visibility = (visibleX * weightX + visibleY * weightY) / max(weightX + weightY, 0.0001);
  let alpha = clamp(length(vec2<f32>(gradientX, gradientY)) * 2.0, 0.0, 1.0);
  let visibleEdge = alpha * clamp(visibility, 0.0, 1.0);
  let hiddenEdge = alpha * (1.0 - clamp(visibility, 0.0, 1.0));
  return vec4<f32>(visibleEdge, hiddenEdge, 0.0, alpha);
}`;

const OUTLINE_OVERLAY_FRAGMENT = `struct OutlineParams {
  visibleEdgeColor : vec4<f32>,
  hiddenEdgeColor : vec4<f32>,
  edgeStrength : f32,
  edgeThickness : f32,
  edgeGlow : f32,
  blendMode : f32,
}

@group(__GROUP__) @binding(0) var sourceTexture : texture_2d<f32>;
@group(__GROUP__) @binding(1) var outlineEdge : texture_2d<f32>;
@group(__GROUP__) @binding(2) var outlineGlow : texture_2d<f32>;
@group(__GROUP__) @binding(3) var linearSampler : sampler;
@group(__GROUP__) @binding(4) var<uniform> params : OutlineParams;
@group(__GROUP__) @binding(5) var outlineMask : texture_2d<f32>;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let base = textureSampleLevel(sourceTexture, linearSampler, input.uv, 0.0);
  let edge = textureSampleLevel(outlineEdge, linearSampler, input.uv, 0.0);
  let glow = textureSampleLevel(outlineGlow, linearSampler, input.uv, 0.0);
  let selected = textureSampleLevel(outlineMask, linearSampler, input.uv, 0.0).r;
  let outside = 1.0 - smoothstep(0.001, 0.5, selected);
  let visibleAmount = clamp(edge.r + glow.r * outside * params.edgeGlow, 0.0, 1.0);
  let hiddenAmount = clamp(edge.g + glow.g * outside * params.edgeGlow, 0.0, 1.0);
  let visibleWeight = clamp(visibleAmount * params.edgeStrength, 0.0, 1.0);
  let hiddenWeight = clamp(hiddenAmount * params.edgeStrength, 0.0, 1.0);
  var rgb = base.rgb;
  if (params.blendMode < 0.5) {
    rgb += params.visibleEdgeColor.rgb * visibleAmount * params.edgeStrength;
    rgb += params.hiddenEdgeColor.rgb * hiddenAmount * params.edgeStrength;
  } else if (params.blendMode < 1.5) {
    rgb = mix(rgb, params.visibleEdgeColor.rgb, visibleWeight);
    rgb = mix(rgb, params.hiddenEdgeColor.rgb, hiddenWeight);
  } else {
    rgb *= mix(vec3<f32>(1.0), params.visibleEdgeColor.rgb, visibleWeight);
    rgb *= mix(vec3<f32>(1.0), params.hiddenEdgeColor.rgb, hiddenWeight);
  }
  return vec4<f32>(rgb, base.a);
}`;

const TAA_FRAGMENT = `struct TaaParams {
  currentInverseViewProjection : mat4x4<f32>,
  previousViewProjection : mat4x4<f32>,
  resolutionFeedback : vec4<f32>,
  depthHistory : vec4<f32>,
  projection : vec4<f32>,
}

@group(__GROUP__) @binding(0) var currentColor : texture_2d<f32>;
@group(__GROUP__) @binding(1) var historyColor : texture_2d<f32>;
@group(__GROUP__) @binding(2) var currentDepth : texture_2d<f32>;
@group(__GROUP__) @binding(3) var linearSampler : sampler;
@group(__GROUP__) @binding(4) var<uniform> params : TaaParams;

struct TaaOutput {
  @location(0) display : vec4<f32>,
  @location(1) history : vec4<f32>,
}

fn deviceDepthFromLinear(linearDepth : f32) -> f32 {
  let near = params.depthHistory.z;
  let far = params.depthHistory.w;
  var standardDepth = linearDepth;
  if (params.projection.x < 0.5) {
    let viewDepth = near + linearDepth * (far - near);
    standardDepth = (far - near * far / max(viewDepth, near)) / (far - near);
  }
  if (params.projection.y > 0.5) { return 1.0 - standardDepth; }
  return standardDepth;
}

fn linearDepthFromDevice(deviceDepth : f32) -> f32 {
  let near = params.depthHistory.z;
  let far = params.depthHistory.w;
  let standardDepth = select(deviceDepth, 1.0 - deviceDepth, params.projection.y > 0.5);
  if (params.projection.x > 0.5) { return clamp(standardDepth, 0.0, 1.0); }
  let viewDepth = near * far / max(far - standardDepth * (far - near), 0.000001);
  return clamp((viewDepth - near) / (far - near), 0.0, 1.0);
}

fn loadCurrent(pixel : vec2<i32>, dimensions : vec2<i32>) -> vec3<f32> {
  return textureLoad(currentColor, clamp(pixel, vec2<i32>(0), dimensions - vec2<i32>(1)), 0).rgb;
}

@fragment
fn fs_main(input : VertexOutput) -> TaaOutput {
  let dimensions = vec2<i32>(textureDimensions(currentColor, 0));
  let pixel = clamp(vec2<i32>(input.pos.xy), vec2<i32>(0), dimensions - vec2<i32>(1));
  let current = textureLoad(currentColor, pixel, 0);
  let linearDepth = textureLoad(currentDepth, pixel, 0).r;
  var neighborhoodMin = current.rgb;
  var neighborhoodMax = current.rgb;
  var neighborhoodSum = vec3<f32>(0.0);
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let sampleColor = loadCurrent(pixel + vec2<i32>(x, y), dimensions);
      neighborhoodMin = min(neighborhoodMin, sampleColor);
      neighborhoodMax = max(neighborhoodMax, sampleColor);
      neighborhoodSum += sampleColor;
    }
  }
  var resolved = current.rgb;
  if (params.depthHistory.y > 0.5) {
    let clip = vec4<f32>(
      input.uv.x * 2.0 - 1.0,
      1.0 - input.uv.y * 2.0,
      deviceDepthFromLinear(linearDepth),
      1.0,
    );
    let worldHomogeneous = params.currentInverseViewProjection * clip;
    let world = worldHomogeneous.xyz / max(abs(worldHomogeneous.w), 0.000001) * sign(worldHomogeneous.w);
    let previousClip = params.previousViewProjection * vec4<f32>(world, 1.0);
    if (previousClip.w > 0.000001) {
      let previousNdc = previousClip.xyz / previousClip.w;
      let previousUv = vec2<f32>(previousNdc.x * 0.5 + 0.5, 0.5 - previousNdc.y * 0.5);
      let inside = all(previousUv >= vec2<f32>(0.0)) && all(previousUv <= vec2<f32>(1.0));
      if (inside && previousNdc.z >= 0.0 && previousNdc.z <= 1.0) {
        let history = textureSampleLevel(historyColor, linearSampler, previousUv, 0.0);
        let expectedDepth = linearDepthFromDevice(previousNdc.z);
        let depthTolerance = params.depthHistory.x * max(1.0, expectedDepth * 8.0);
        if (abs(history.a - expectedDepth) <= depthTolerance) {
          let clippedHistory = clamp(history.rgb, neighborhoodMin, neighborhoodMax);
          resolved = mix(current.rgb, clippedHistory, params.resolutionFeedback.z);
        }
      }
    }
  }
  let neighborhoodMean = neighborhoodSum / 9.0;
  let displayColor = max(resolved + (resolved - neighborhoodMean) * params.resolutionFeedback.w, vec3<f32>(0.0));
  var output : TaaOutput;
  output.display = vec4<f32>(displayColor, current.a);
  output.history = vec4<f32>(resolved, linearDepth);
  return output;
}`;

const AO_FRAGMENT_HEADER = `struct AmbientOcclusionParams {
  resolution : vec4<f32>,
  radiusIntensityBiasPower : vec4<f32>,
  camera : vec4<f32>,
  settings : vec4<f32>,
  projectionMatrix : mat4x4<f32>,
  inverseProjectionMatrix : mat4x4<f32>,
}

@group(__GROUP__) @binding(0) var sourceColor : texture_2d<f32>;
@group(__GROUP__) @binding(1) var linearDepthTexture : texture_2d<f32>;
@group(__GROUP__) @binding(2) var viewNormalTexture : texture_2d<f32>;
@group(__GROUP__) @binding(3) var linearSampler : sampler;
@group(__GROUP__) @binding(4) var<uniform> params : AmbientOcclusionParams;

const AO_PI : f32 = 3.141592653589793;
const AO_GOLDEN_ANGLE : f32 = 2.399963229728653;

fn aoPixel(uv : vec2<f32>) -> vec2<i32> {
  let dimensions = vec2<i32>(textureDimensions(linearDepthTexture, 0));
  return clamp(vec2<i32>(uv * vec2<f32>(params.resolution.xy)), vec2<i32>(0), dimensions - vec2<i32>(1));
}

fn aoDepth(uv : vec2<f32>) -> f32 {
  return textureLoad(linearDepthTexture, aoPixel(uv), 0).r;
}

fn aoNormal(uv : vec2<f32>) -> vec3<f32> {
  let encoded = textureLoad(viewNormalTexture, aoPixel(uv), 0).xyz;
  return normalize(encoded * 2.0 - vec3<f32>(1.0));
}

fn aoDeviceDepth(linearDepth : f32) -> f32 {
  let near = params.camera.x;
  let far = params.camera.y;
  var standardDepth = linearDepth;
  if (params.camera.w < 0.5) {
    let viewDepth = near + linearDepth * (far - near);
    standardDepth = (far - near * far / max(viewDepth, near)) / (far - near);
  }
  return select(standardDepth, 1.0 - standardDepth, params.camera.z > 0.5);
}

fn aoViewPosition(uv : vec2<f32>, linearDepth : f32) -> vec3<f32> {
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let view = params.inverseProjectionMatrix * vec4<f32>(ndc, aoDeviceDepth(linearDepth), 1.0);
  let safeW = select(-max(abs(view.w), 0.000001), max(abs(view.w), 0.000001), view.w >= 0.0);
  return view.xyz / safeW;
}

fn aoRotation(pixel : vec2<i32>) -> f32 {
  let interleaved = fract(52.9829189 * fract(0.06711056 * f32(pixel.x) + 0.00583715 * f32(pixel.y)));
  return interleaved * 2.0 * AO_PI;
}

fn aoViewRadius() -> f32 {
  return max(params.radiusIntensityBiasPower.x, 0.0001);
}

fn aoProjectUv(viewPosition : vec3<f32>) -> vec2<f32> {
  let clip = params.projectionMatrix * vec4<f32>(viewPosition, 1.0);
  if (clip.w <= 0.000001) { return vec2<f32>(-1.0); }
  let ndc = clip.xy / clip.w;
  return vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

fn aoInside(uv : vec2<f32>) -> bool {
  return all(uv > vec2<f32>(0.0)) && all(uv < vec2<f32>(1.0));
}

fn aoVisibilityOutput(visibility : f32) -> vec4<f32> {
  let value = clamp(visibility, 0.0, 1.0);
  return vec4<f32>(value, value, value, 1.0);
}`;

const SSAO_FRAGMENT = `${AO_FRAGMENT_HEADER}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let centerDepth = aoDepth(input.uv);
  if (centerDepth >= 0.99999) { return aoVisibilityOutput(1.0); }
  let center = aoViewPosition(input.uv, centerDepth);
  let normal = aoNormal(input.uv);
  let radiusView = aoViewRadius();
  let sampleCount = i32(clamp(params.settings.z, 4.0, 32.0));
  let rotation = aoRotation(aoPixel(input.uv));
  let axis = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(normal.y) > 0.9);
  let tangent = normalize(cross(axis, normal));
  let bitangent = cross(normal, tangent);
  var occlusion = 0.0;
  for (var index = 0; index < 32; index += 1) {
    if (index >= sampleCount) { continue; }
    let fraction = (f32(index) + 0.5) / f32(sampleCount);
    let angle = f32(index) * AO_GOLDEN_ANGLE + rotation;
    let hemisphereZ = mix(0.1, 0.98, fract(fraction * 7.754877666));
    let hemisphereRadius = sqrt(max(1.0 - hemisphereZ * hemisphereZ, 0.0));
    let direction = tangent * (cos(angle) * hemisphereRadius)
      + bitangent * (sin(angle) * hemisphereRadius)
      + normal * hemisphereZ;
    let radialScale = mix(0.12, 1.0, fraction * fraction);
    let probe = center + direction * radiusView * radialScale;
    let sampleUv = aoProjectUv(probe);
    if (!aoInside(sampleUv)) { continue; }
    let sampleDepth = aoDepth(sampleUv);
    if (sampleDepth >= 0.99999) { continue; }
    let surface = aoViewPosition(sampleUv, sampleDepth);
    let depthDelta = (-probe.z) - (-surface.z);
    let minDistance = max(params.radiusIntensityBiasPower.z, radiusView * 0.005);
    let maxDistance = max(minDistance * 2.0, min(params.settings.x, radiusView * 1.5));
    if (depthDelta > minDistance && depthDelta < maxDistance) { occlusion += 1.0; }
  }
  let obscurance = occlusion / f32(sampleCount);
  return aoVisibilityOutput(1.0 - obscurance * params.radiusIntensityBiasPower.y);
}`;

const SAO_FRAGMENT = `${AO_FRAGMENT_HEADER}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let centerDepth = aoDepth(input.uv);
  if (centerDepth >= 0.99999) { return aoVisibilityOutput(1.0); }
  let center = aoViewPosition(input.uv, centerDepth);
  let normal = aoNormal(input.uv);
  let radiusView = aoViewRadius();
  let sampleCount = i32(clamp(params.settings.z, 4.0, 32.0));
  let rotation = aoRotation(aoPixel(input.uv));
  var obscurance = 0.0;
  var validSamples = 0.0;
  for (var index = 0; index < 32; index += 1) {
    if (index >= sampleCount) { continue; }
    let ring = f32(index + 1) / f32(sampleCount);
    let angle = rotation + f32(index) * (8.0 * AO_PI / f32(sampleCount));
    let sampleDirection = vec3<f32>(cos(angle), sin(angle), 0.0);
    let sampleUv = aoProjectUv(center + sampleDirection * ring * radiusView);
    if (!aoInside(sampleUv)) { continue; }
    let sampleDepth = aoDepth(sampleUv);
    if (sampleDepth >= 0.99999) { continue; }
    let delta = aoViewPosition(sampleUv, sampleDepth) - center;
    let viewDistance = length(delta);
    let scaledDistance = viewDistance / max(params.settings.x, 0.0001);
    let numerator = (dot(normal, delta) - params.radiusIntensityBiasPower.z) / max(scaledDistance, 0.0001);
    obscurance += max(numerator, 0.0) / (1.0 + scaledDistance * scaledDistance);
    validSamples += 1.0;
  }
  let normalized = clamp(obscurance * params.radiusIntensityBiasPower.y / max(validSamples, 1.0), 0.0, 1.0);
  return aoVisibilityOutput(1.0 - normalized);
}`;

const GTAO_FRAGMENT = `${AO_FRAGMENT_HEADER}

fn gtaoUpdateHorizon(
  center : vec3<f32>,
  viewDirection : vec3<f32>,
  samplePosition : vec3<f32>,
  previousHorizon : f32,
  radiusView : f32,
  thickness : f32,
  horizonBias : f32,
) -> f32 {
  let sampleUv = aoProjectUv(samplePosition);
  if (!aoInside(sampleUv)) { return previousHorizon; }
  let sampleDepth = aoDepth(sampleUv);
  if (sampleDepth >= 0.99999) { return previousHorizon; }
  let delta = aoViewPosition(sampleUv, sampleDepth) - center;
  let deltaLength = length(delta);
  if (deltaLength < 0.0001 || abs(delta.z) >= thickness) { return previousHorizon; }
  let sampleHorizon = dot(viewDirection, delta) / deltaLength - horizonBias;
  let distanceFactor = min(deltaLength / radiusView, 1.0);
  return mix(max(previousHorizon, sampleHorizon), previousHorizon, distanceFactor * distanceFactor);
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let centerDepth = aoDepth(input.uv);
  if (centerDepth >= 0.99999) { return aoVisibilityOutput(1.0); }
  let center = aoViewPosition(input.uv, centerDepth);
  let normal = aoNormal(input.uv);
  let radiusView = aoViewRadius();
  let thickness = max(params.radiusIntensityBiasPower.z * 2.0, min(params.settings.x, radiusView * 1.25));
  let horizonBias = params.radiusIntensityBiasPower.z / radiusView;
  let sampleCount = i32(clamp(params.settings.z, 4.0, 32.0));
  var directionCount = 3;
  if (sampleCount >= 30) { directionCount = 5; }
  let stepCount = (sampleCount + directionCount - 1) / directionCount;
  let rotation = aoRotation(aoPixel(input.uv));
  let stepJitter = fract(0.754877666 * f32(aoPixel(input.uv).x) + 0.569840296 * f32(aoPixel(input.uv).y));
  let viewDirection = normalize(-center);
  var integratedVisibility = 0.0;
  for (var directionIndex = 0; directionIndex < 5; directionIndex += 1) {
    if (directionIndex >= directionCount) { continue; }
    let angle = f32(directionIndex) * AO_PI / f32(directionCount) + rotation;
    let sampleDirection = vec3<f32>(cos(angle), sin(angle), 0.0);
    let sliceBitangentRaw = cross(sampleDirection, viewDirection);
    let sliceBitangent = sliceBitangentRaw / max(length(sliceBitangentRaw), 0.0001);
    let sliceTangent = cross(sliceBitangent, viewDirection);
    let projectedNormalRaw = normal - sliceBitangent * dot(normal, sliceBitangent);
    let projectedNormalLength = length(projectedNormalRaw);
    let projectedNormal = projectedNormalRaw / max(projectedNormalLength, 0.0001);
    let normalSin = dot(projectedNormal, sliceTangent);
    let normalCos = clamp(dot(projectedNormal, viewDirection), 0.0, 1.0);
    let tangentToNormal = cross(projectedNormal, sliceBitangent);
    let initialHorizon = dot(viewDirection, tangentToNormal);
    var horizons = vec2<f32>(initialHorizon, -initialHorizon);
    for (var stepIndex = 0; stepIndex < 11; stepIndex += 1) {
      if (stepIndex >= stepCount) { continue; }
      let stepFraction = (f32(stepIndex) + 1.0 + stepJitter) / f32(stepCount);
      let sampleDistance = stepFraction * stepFraction * radiusView;
      let sampleOffset = sampleDirection * sampleDistance;
      horizons.x = gtaoUpdateHorizon(center, viewDirection, center + sampleOffset, horizons.x, radiusView, thickness, horizonBias);
      horizons.y = gtaoUpdateHorizon(center, viewDirection, center - sampleOffset, horizons.y, radiusView, thickness, horizonBias);
    }
    let clampedHorizons = clamp(horizons, vec2<f32>(-1.0), vec2<f32>(1.0));
    let sinHorizons = sqrt(max(vec2<f32>(1.0) - clampedHorizons * clampedHorizons, vec2<f32>(0.0)));
    let nxb = 0.5 * (
      acos(clampedHorizons.y) - acos(clampedHorizons.x)
      + sinHorizons.x * clampedHorizons.x
      - sinHorizons.y * clampedHorizons.y
    );
    let nyb = 0.5 * (2.0 - clampedHorizons.x * clampedHorizons.x - clampedHorizons.y * clampedHorizons.y);
    integratedVisibility += projectedNormalLength * (normalSin * nxb + normalCos * nyb);
  }
  let visibility = clamp(integratedVisibility / f32(directionCount), 0.0, 1.0);
  return aoVisibilityOutput(1.0 - (1.0 - visibility) * params.radiusIntensityBiasPower.y);
}`;

const AO_DENOISE_FRAGMENT = `struct AmbientOcclusionParams {
  resolution : vec4<f32>,
  radiusIntensityBiasPower : vec4<f32>,
  camera : vec4<f32>,
  settings : vec4<f32>,
  projectionMatrix : mat4x4<f32>,
  inverseProjectionMatrix : mat4x4<f32>,
}

@group(__GROUP__) @binding(0) var sourceColor : texture_2d<f32>;
@group(__GROUP__) @binding(1) var ambientOcclusionTexture : texture_2d<f32>;
@group(__GROUP__) @binding(2) var linearDepthTexture : texture_2d<f32>;
@group(__GROUP__) @binding(3) var viewNormalTexture : texture_2d<f32>;
@group(__GROUP__) @binding(4) var linearSampler : sampler;
@group(__GROUP__) @binding(5) var<uniform> params : AmbientOcclusionParams;

fn denoisePixel(pixel : vec2<i32>, dimensions : vec2<i32>) -> vec2<i32> {
  return clamp(pixel, vec2<i32>(0), dimensions - vec2<i32>(1));
}

fn denoiseNormal(pixel : vec2<i32>, dimensions : vec2<i32>) -> vec3<f32> {
  return normalize(textureLoad(viewNormalTexture, denoisePixel(pixel, dimensions), 0).xyz * 2.0 - vec3<f32>(1.0));
}

fn denoiseDeviceDepth(linearDepth : f32) -> f32 {
  let near = params.camera.x;
  let far = params.camera.y;
  var standardDepth = linearDepth;
  if (params.camera.w < 0.5) {
    let viewDepth = near + linearDepth * (far - near);
    standardDepth = (far - near * far / max(viewDepth, near)) / (far - near);
  }
  return select(standardDepth, 1.0 - standardDepth, params.camera.z > 0.5);
}

fn denoiseViewPosition(uv : vec2<f32>, linearDepth : f32) -> vec3<f32> {
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let view = params.inverseProjectionMatrix * vec4<f32>(ndc, denoiseDeviceDepth(linearDepth), 1.0);
  let safeW = select(-max(abs(view.w), 0.000001), max(abs(view.w), 0.000001), view.w >= 0.0);
  return view.xyz / safeW;
}

fn denoiseProjectUv(viewPosition : vec3<f32>) -> vec2<f32> {
  let clip = params.projectionMatrix * vec4<f32>(viewPosition, 1.0);
  if (clip.w <= 0.000001) { return vec2<f32>(-1.0); }
  let ndc = clip.xy / clip.w;
  return vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let aoDimensions = vec2<i32>(textureDimensions(ambientOcclusionTexture, 0));
  let sceneDimensions = vec2<i32>(textureDimensions(linearDepthTexture, 0));
  let centerAoPixel = denoisePixel(vec2<i32>(input.pos.xy), aoDimensions);
  let centerUv = (vec2<f32>(centerAoPixel) + vec2<f32>(0.5)) / vec2<f32>(aoDimensions);
  let centerScenePixel = denoisePixel(vec2<i32>(centerUv * vec2<f32>(sceneDimensions)), sceneDimensions);
  let centerDepth = textureLoad(linearDepthTexture, centerScenePixel, 0).r;
  if (centerDepth >= 0.99999) { return vec4<f32>(1.0); }
  let centerNormal = denoiseNormal(centerScenePixel, sceneDimensions);
  let centerPosition = denoiseViewPosition(centerUv, centerDepth);
  let centerVisibility = textureLoad(ambientOcclusionTexture, centerAoPixel, 0).r;
  let viewRadius = max(params.radiusIntensityBiasPower.x, 0.0001);
  let radiusUv = denoiseProjectUv(centerPosition + vec3<f32>(viewRadius, 0.0, 0.0));
  let projectedRadiusPixels = length((radiusUv - centerUv) * vec2<f32>(aoDimensions));
  let depthPhi = max(viewRadius, params.radiusIntensityBiasPower.z * 4.0);
  let filterRadius = clamp(projectedRadiusPixels * 0.2, 2.0, 8.0);
  let rotation = fract(52.9829189 * fract(0.06711056 * f32(centerAoPixel.x) + 0.00583715 * f32(centerAoPixel.y))) * 2.0 * 3.141592653589793;
  var visibility = centerVisibility;
  var totalWeight = 1.0;
  for (var index = 0; index < 16; index += 1) {
    let sampleAngle = rotation + f32(index) * 0.7853981633974483;
    let radialFraction = f32(index) / 15.0;
    let pixelRadius = 1.0 + radialFraction * (filterRadius - 1.0);
    let sampleUv = centerUv + vec2<f32>(cos(sampleAngle), sin(sampleAngle)) * pixelRadius / vec2<f32>(aoDimensions);
    if (any(sampleUv <= vec2<f32>(0.0)) || any(sampleUv >= vec2<f32>(1.0))) { continue; }
    let sampleAoPixel = denoisePixel(vec2<i32>(sampleUv * vec2<f32>(aoDimensions)), aoDimensions);
    let sampleScenePixel = denoisePixel(vec2<i32>(sampleUv * vec2<f32>(sceneDimensions)), sceneDimensions);
    let sampleDepth = textureLoad(linearDepthTexture, sampleScenePixel, 0).r;
    if (sampleDepth >= 0.99999) { continue; }
    let sampleNormal = denoiseNormal(sampleScenePixel, sceneDimensions);
    let samplePosition = denoiseViewPosition(sampleUv, sampleDepth);
    let sampleVisibility = textureLoad(ambientOcclusionTexture, sampleAoPixel, 0).r;
    let lumaWeight = max(1.0 - abs(sampleVisibility - centerVisibility) / 10.0, 0.0);
    let depthDifference = abs(dot(centerPosition - samplePosition, centerNormal));
    let depthWeight = max(1.0 - depthDifference / depthPhi, 0.0);
    let normalWeight = pow(max(dot(centerNormal, sampleNormal), 0.0), 3.0);
    let weight = lumaWeight * depthWeight * normalWeight;
    visibility += sampleVisibility * weight;
    totalWeight += weight;
  }
  let filtered = visibility / max(totalWeight, 0.0001);
  return vec4<f32>(clamp(filtered, 0.0, 1.0));
}`;

const AO_UPSCALE_FRAGMENT = `struct AmbientOcclusionParams {
  resolution : vec4<f32>,
  radiusIntensityBiasPower : vec4<f32>,
  camera : vec4<f32>,
  settings : vec4<f32>,
  projectionMatrix : mat4x4<f32>,
  inverseProjectionMatrix : mat4x4<f32>,
}

@group(__GROUP__) @binding(0) var sourceColor : texture_2d<f32>;
@group(__GROUP__) @binding(1) var ambientOcclusionTexture : texture_2d<f32>;
@group(__GROUP__) @binding(2) var linearDepthTexture : texture_2d<f32>;
@group(__GROUP__) @binding(3) var viewNormalTexture : texture_2d<f32>;
@group(__GROUP__) @binding(4) var linearSampler : sampler;
@group(__GROUP__) @binding(5) var<uniform> params : AmbientOcclusionParams;

fn upscalePixel(pixel : vec2<i32>, dimensions : vec2<i32>) -> vec2<i32> {
  return clamp(pixel, vec2<i32>(0), dimensions - vec2<i32>(1));
}

fn upscaleNormal(pixel : vec2<i32>, dimensions : vec2<i32>) -> vec3<f32> {
  return normalize(textureLoad(viewNormalTexture, upscalePixel(pixel, dimensions), 0).xyz * 2.0 - vec3<f32>(1.0));
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let sceneDimensions = vec2<i32>(textureDimensions(linearDepthTexture, 0));
  let aoDimensions = vec2<i32>(textureDimensions(ambientOcclusionTexture, 0));
  let centerScenePixel = upscalePixel(vec2<i32>(input.pos.xy), sceneDimensions);
  let centerDepth = textureLoad(linearDepthTexture, centerScenePixel, 0).r;
  let base = textureSampleLevel(sourceColor, linearSampler, input.uv, 0.0);
  if (centerDepth >= 0.99999) {
    if (params.settings.y > 0.5) { return vec4<f32>(1.0); }
    return base;
  }
  let centerNormal = upscaleNormal(centerScenePixel, sceneDimensions);
  let aoPosition = input.uv * vec2<f32>(aoDimensions) - vec2<f32>(0.5);
  let aoBase = vec2<i32>(floor(aoPosition));
  let fraction = fract(aoPosition);
  var visibility = 0.0;
  var totalWeight = 0.0;
  for (var y = 0; y < 2; y += 1) {
    for (var x = 0; x < 2; x += 1) {
      let aoPixel = upscalePixel(aoBase + vec2<i32>(x, y), aoDimensions);
      let sampleUv = (vec2<f32>(aoPixel) + vec2<f32>(0.5)) / vec2<f32>(aoDimensions);
      let sampleScenePixel = upscalePixel(vec2<i32>(sampleUv * vec2<f32>(sceneDimensions)), sceneDimensions);
      let sampleDepth = textureLoad(linearDepthTexture, sampleScenePixel, 0).r;
      let sampleNormal = upscaleNormal(sampleScenePixel, sceneDimensions);
      let spatial = select(1.0 - fraction.x, fraction.x, x == 1)
        * select(1.0 - fraction.y, fraction.y, y == 1);
      let depthWeight = exp2(-abs(sampleDepth - centerDepth) * 2048.0);
      let normalWeight = pow(max(dot(centerNormal, sampleNormal), 0.0), 8.0);
      let weight = spatial * depthWeight * normalWeight;
      visibility += textureLoad(ambientOcclusionTexture, aoPixel, 0).r * weight;
      totalWeight += weight;
    }
  }
  let nearestAoPixel = upscalePixel(vec2<i32>(input.uv * vec2<f32>(aoDimensions)), aoDimensions);
  let nearestVisibility = textureLoad(ambientOcclusionTexture, nearestAoPixel, 0).r;
  let resolved = select(nearestVisibility, visibility / totalWeight, totalWeight > 0.0001);
  let shaped = pow(clamp(resolved, 0.0, 1.0), max(params.radiusIntensityBiasPower.w, 0.01));
  if (params.settings.y > 0.5) { return vec4<f32>(vec3<f32>(shaped), 1.0); }
  return vec4<f32>(base.rgb * shaped, base.a);
}`;
