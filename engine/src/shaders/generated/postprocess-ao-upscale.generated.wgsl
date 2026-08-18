// haiyue:builtin-postprocess ao-upscale

struct VertexOutput {
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
}

struct AmbientOcclusionParams {
  resolution : vec4<f32>,
  radiusIntensityBiasPower : vec4<f32>,
  camera : vec4<f32>,
  settings : vec4<f32>,
  projectionMatrix : mat4x4<f32>,
  inverseProjectionMatrix : mat4x4<f32>,
}

@group(0) @binding(0) var sourceColor : texture_2d<f32>;
@group(0) @binding(1) var ambientOcclusionTexture : texture_2d<f32>;
@group(0) @binding(2) var linearDepthTexture : texture_2d<f32>;
@group(0) @binding(3) var viewNormalTexture : texture_2d<f32>;
@group(0) @binding(4) var linearSampler : sampler;
@group(0) @binding(5) var<uniform> params : AmbientOcclusionParams;

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
}

