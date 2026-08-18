// haiyue:material-lighting-pass toon
// haiyue:material-lighting-abi 1
// haiyue:material-lighting-module 5d97c3daa97c1993c3737129fc6165fcbb694988dea7527b0022e36430b38117
// haiyue:deformation-module 10c43d2008ebba9ec6891c008f57347c11e9e2d86f693a669075cd9c61c2544d
// source: shader-language/builtin-material-lighting-family.json

struct FogUniforms {
  color : vec4<f32>,
  distanceParams : vec4<f32>,
  heightParams : vec4<f32>,
}

fn fogAmount(fog : FogUniforms, eyePosition : vec3<f32>, worldPosition : vec3<f32>) -> f32 {
  let mode = fog.distanceParams.x;
  if (mode < 0.5) { return 0.0; }

  let ray = worldPosition - eyePosition;
  let viewDistance = length(ray);
  var amount = 0.0;

  if (mode < 1.5) {
    let start = fog.distanceParams.y;
    let end = max(fog.distanceParams.z, start + 0.0001);
    amount = clamp((viewDistance - start) / (end - start), 0.0, 1.0);
  } else {
    let baseHeight = fog.heightParams.x;
    let density = max(fog.heightParams.y, 0.0);
    let falloff = max(fog.heightParams.z, 0.0);
    let cameraDensity = exp(clamp(-falloff * (eyePosition.y - baseHeight), -40.0, 40.0));
    let heightDelta = worldPosition.y - eyePosition.y;
    let scaledDelta = falloff * heightDelta;
    var averageDensity = cameraDensity;
    if (abs(scaledDelta) > 0.0001) {
      averageDensity *= (1.0 - exp(clamp(-scaledDelta, -40.0, 40.0))) / scaledDelta;
    }
    let opticalDepth = density * viewDistance * max(averageDensity, 0.0);
    amount = 1.0 - exp(-min(opticalDepth, 40.0));
  }

  return min(clamp(amount, 0.0, 1.0), clamp(fog.distanceParams.w, 0.0, 1.0));
}

fn applyFog(color : vec3<f32>, fog : FogUniforms, eyePosition : vec3<f32>, worldPosition : vec3<f32>) -> vec3<f32> {
  return mix(color, fog.color.rgb, fogAmount(fog, eyePosition, worldPosition));
}


struct SceneFrameUniforms {
  viewProjection : mat4x4<f32>,
  view : mat4x4<f32>,
  inverseViewProjection : mat4x4<f32>,
  eyePosition : vec4<f32>,
  viewport : vec4<f32>,
  fog : FogUniforms,
}


struct HyClip {
  p : array<vec4<f32>, 8>,
  m : vec4<f32>,
}

@group(1) @binding(1) var<storage, read> hyClip : array<HyClip>;

fn hy_is_clipped(p : vec3<f32>, o : u32) -> bool {
  let c = hyClip[o];
  for (var i = 0u; i < min(u32(max(c.m.x, 0.0)), 8u); i += 1u) {
    if (dot(c.p[i].xyz, p) + c.p[i].w < 0.0) { return true; }
  }
  return false;
}


struct DirectionalShadowData {
  lightViewProj : mat4x4<f32>,
  params : vec4<f32>,
}
struct ShadowUniforms {
  shadows : array<DirectionalShadowData, 1u>,
}

@group(3) @binding(5) var<uniform> shadow : ShadowUniforms;
@group(3) @binding(6) var shadowTexture : texture_depth_2d_array;
@group(3) @binding(7) var shadowSampler : sampler_comparison;

fn shadowVisibility(shadowIndex: u32, worldPosition: vec3<f32>, normal: vec3<f32>, lightDirection: vec3<f32>) -> f32 {
  if (shadowIndex >= 1u) { return 1.0; }
  let shadowData = shadow.shadows[shadowIndex];
  if (shadowData.params.x < 0.5) { return 1.0; }
  let shadowPosition = shadowData.lightViewProj * vec4<f32>(worldPosition, 1.0);
  let projected = shadowPosition.xyz / max(shadowPosition.w, 0.00001);
  let uv = vec2<f32>(projected.x * 0.5 + 0.5, 1.0 - (projected.y * 0.5 + 0.5));
  if (projected.z <= 0.0 || projected.z >= 1.0 || any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return 1.0; }
  let slope = 1.0 - max(dot(normal, lightDirection), 0.0);
  let compareDepth = projected.z - shadowData.params.y - slope * shadowData.params.z;
  let texel = vec2<f32>(shadowData.params.w);
  let layer = i32(shadowData.params.x - 1.0);
  var visibility = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      visibility += textureSampleCompareLevel(
        shadowTexture,
        shadowSampler,
        uv + vec2<f32>(f32(x), f32(y)) * texel,
        layer,
        compareDepth,
      );
    }
  }
  return visibility / 9.0;
}


struct ObjectUniforms {
  model        : mat4x4<f32>,
  normalMatrix : mat4x4<f32>,
}

struct MaterialUniforms {
  baseColor   : vec4<f32>,
  thresholds  : vec4<f32>,
  layerColors : array<vec4<f32>, 4>,
  // x = layer count, y = threshold softness, z = texture bit mask
  params      : vec4<f32>,
  // Two affine rows per layer. row0.w selects TEXCOORD_0/1.
  uvRows      : array<vec4<f32>, 8>,
}

struct LightData {
  typeVec   : vec4<u32>,
  color     : vec4<f32>,
  direction : vec4<f32>,
  position  : vec4<f32>,
}

struct LightsUniforms {
  countVec : vec4<u32>,
  lights   : array<LightData, 8u>,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<storage, read> objects : array<ObjectUniforms>;
@group(2) @binding(0) var<uniform> material : MaterialUniforms;
@group(2) @binding(1) var layerTexture0 : texture_2d<f32>;
@group(2) @binding(2) var layerTexture1 : texture_2d<f32>;
@group(2) @binding(3) var layerTexture2 : texture_2d<f32>;
@group(2) @binding(4) var layerTexture3 : texture_2d<f32>;
@group(2) @binding(5) var layerSampler0 : sampler;
@group(2) @binding(6) var layerSampler1 : sampler;
@group(2) @binding(7) var layerSampler2 : sampler;
@group(2) @binding(8) var layerSampler3 : sampler;
@group(3) @binding(0) var<uniform> lights : LightsUniforms;

struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) uv0      : vec2<f32>,
  @location(3) uv1      : vec2<f32>,
  @builtin(instance_index) instanceIndex : u32,
}

struct VertexOutput {
  @builtin(position) clipPos  : vec4<f32>,
  @location(0) worldPos       : vec3<f32>,
  @location(1) worldNorm      : vec3<f32>,
  @location(2) uv0            : vec2<f32>,
  @location(3) uv1            : vec2<f32>,
  @location(4) @interpolate(flat) objectIndex : u32,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let object = objects[in.instanceIndex];
  let worldPosition = object.model * vec4<f32>(in.position, 1.0);
  var out: VertexOutput;
  out.clipPos = sceneFrame.viewProjection * worldPosition;
  out.worldPos = worldPosition.xyz;
  out.worldNorm = normalize((object.normalMatrix * vec4<f32>(in.normal, 0.0)).xyz);
  out.uv0 = in.uv0;
  out.uv1 = in.uv1;
  out.objectIndex = in.instanceIndex;
  return out;
}

fn transformedUv(layer: u32, uv0: vec2<f32>, uv1: vec2<f32>) -> vec2<f32> {
  let row0 = material.uvRows[layer * 2u];
  let row1 = material.uvRows[layer * 2u + 1u];
  let uv = select(uv0, uv1, row0.w > 0.5);
  return vec2<f32>(dot(row0.xy, uv) + row0.z, dot(row1.xy, uv) + row1.z);
}

fn sampleLayer(
  layer: u32,
  uv0: vec2<f32>,
  uv1: vec2<f32>,
  uv0Dx: vec2<f32>,
  uv0Dy: vec2<f32>,
  uv1Dx: vec2<f32>,
  uv1Dy: vec2<f32>,
) -> vec4<f32> {
  let textureMask = u32(material.params.z + 0.5);
  if ((textureMask & (1u << layer)) == 0u) { return vec4<f32>(1.0); }
  let uv = transformedUv(layer, uv0, uv1);
  let row0 = material.uvRows[layer * 2u];
  let row1 = material.uvRows[layer * 2u + 1u];
  let sourceDx = select(uv0Dx, uv1Dx, row0.w > 0.5);
  let sourceDy = select(uv0Dy, uv1Dy, row0.w > 0.5);
  let uvDx = vec2<f32>(dot(row0.xy, sourceDx), dot(row1.xy, sourceDx));
  let uvDy = vec2<f32>(dot(row0.xy, sourceDy), dot(row1.xy, sourceDy));
  switch layer {
    case 0u: { return textureSampleGrad(layerTexture0, layerSampler0, uv, uvDx, uvDy); }
    case 1u: { return textureSampleGrad(layerTexture1, layerSampler1, uv, uvDx, uvDy); }
    case 2u: { return textureSampleGrad(layerTexture2, layerSampler2, uv, uvDx, uvDy); }
    default: { return textureSampleGrad(layerTexture3, layerSampler3, uv, uvDx, uvDy); }
  }
}

fn luminance(value: vec3<f32>) -> f32 {
  return dot(value, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let object = objects[in.objectIndex];
  if (hy_is_clipped(in.worldPos, in.objectIndex)) { discard; }
  let N = normalize(in.worldNorm);
  let uv0Dx = dpdx(in.uv0);
  let uv0Dy = dpdy(in.uv0);
  let uv1Dx = dpdx(in.uv1);
  let uv1Dy = dpdy(in.uv1);
  var lightLevel = 0.0;
  var lightColor = vec3<f32>(0.0);
  for (var i = 0u; i < lights.countVec.x; i++) {
    let light = lights.lights[i];
    let sourceColor = max(light.color.rgb * light.color.a, vec3<f32>(0.0));
    var geometricWeight = 0.0;
    if (light.typeVec.x == 0u) {
      geometricWeight = 1.0;
    } else if (light.typeVec.x == 1u) {
      let L = normalize(-light.direction.xyz);
      geometricWeight = max(dot(N, L), 0.0) * shadowVisibility(0u, in.worldPos, N, L);
    } else if (light.typeVec.x == 2u) {
      let toLight = light.position.xyz - in.worldPos;
      let distance = length(toLight);
      let L = toLight / max(distance, 0.0001);
      let attenuation = pow(clamp(1.0 - distance / max(light.position.w, 0.0001), 0.0, 1.0), 2.0);
      geometricWeight = max(dot(N, L), 0.0) * attenuation;
    }
    let weighted = sourceColor * geometricWeight;
    lightLevel += luminance(weighted);
    lightColor += weighted;
  }
  lightLevel = clamp(lightLevel, 0.0, 1.0);

  let layerCount = max(1u, u32(material.params.x + 0.5));
  var lower = 0u;
  var upper = 0u;
  var blendWeight = 0.0;
  let softness = material.params.y;
  for (var layer = 1u; layer < layerCount; layer++) {
    let threshold = material.thresholds[layer];
    if (softness > 0.0 && lightLevel > threshold - softness && lightLevel < threshold + softness) {
      upper = layer;
      blendWeight = smoothstep(threshold - softness, threshold + softness, lightLevel);
      break;
    }
    if (lightLevel >= threshold + softness) {
      lower = layer;
      upper = layer;
    } else {
      break;
    }
  }

  let lowerLayer = material.layerColors[lower] * sampleLayer(lower, in.uv0, in.uv1, uv0Dx, uv0Dy, uv1Dx, uv1Dy);
  let upperLayer = material.layerColors[upper] * sampleLayer(upper, in.uv0, in.uv1, uv0Dx, uv0Dy, uv1Dx, uv1Dy);
  let band = mix(lowerLayer, upperLayer, blendWeight);
  let maxLightChannel = max(max(lightColor.r, lightColor.g), lightColor.b);
  let lightTint = select(vec3<f32>(1.0), lightColor / maxLightChannel, maxLightChannel > 0.0001);
  let color = material.baseColor.rgb * band.rgb * lightTint;
  let alpha = material.baseColor.a * band.a;
  return vec4<f32>(applyFog(color, sceneFrame.fog, sceneFrame.eyePosition.xyz, in.worldPos), alpha);
}
