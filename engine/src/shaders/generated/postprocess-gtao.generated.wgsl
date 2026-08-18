// haiyue:builtin-postprocess gtao

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
@group(0) @binding(1) var linearDepthTexture : texture_2d<f32>;
@group(0) @binding(2) var viewNormalTexture : texture_2d<f32>;
@group(0) @binding(3) var linearSampler : sampler;
@group(0) @binding(4) var<uniform> params : AmbientOcclusionParams;

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
}

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
}

