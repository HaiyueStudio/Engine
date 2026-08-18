// haiyue:builtin-postprocess ao-denoise

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
}

