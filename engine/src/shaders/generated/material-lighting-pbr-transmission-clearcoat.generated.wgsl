// haiyue:material-lighting-pass pbr-transmission-clearcoat
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


fn applyMorphPosition(
  position : vec3<f32>,
  morphPosition0 : vec3<f32>,
  morphPosition1 : vec3<f32>,
  morphPosition2 : vec3<f32>,
  morphPosition3 : vec3<f32>,
  weights : vec4<f32>,
) -> vec3<f32> {
  return position +
    morphPosition0 * weights.x +
    morphPosition1 * weights.y +
    morphPosition2 * weights.z +
    morphPosition3 * weights.w;
}

fn applyMorphNormal(
  normal : vec3<f32>,
  morphNormal0 : vec3<f32>,
  morphNormal1 : vec3<f32>,
  morphNormal2 : vec3<f32>,
  morphNormal3 : vec3<f32>,
  weights : vec4<f32>,
) -> vec3<f32> {
  return normal +
    morphNormal0 * weights.x +
    morphNormal1 * weights.y +
    morphNormal2 * weights.z +
    morphNormal3 * weights.w;
}


@group(3) @binding(8) var<storage, read> skin : SkinUniforms;
@group(3) @binding(9) var<storage, read> skinJoints : SkinAttributes;
@group(3) @binding(10) var<storage, read> skinWeights : SkinAttributes;


struct SkinUniforms {
  jointMatrices : array<mat4x4<f32>>,
}

struct SkinAttributes {
  values : array<vec4<f32>>,
}

fn skinPosition(position: vec3<f32>, joints: vec4<f32>, weights: vec4<f32>) -> vec4<f32> {
  if (dot(weights, vec4<f32>(1.0)) <= 0.0) {
    return vec4<f32>(position, 1.0);
  }
  let j0 = u32(joints.x);
  let j1 = u32(joints.y);
  let j2 = u32(joints.z);
  let j3 = u32(joints.w);
  let p = vec4<f32>(position, 1.0);
  return (skin.jointMatrices[j0] * p) * weights.x +
    (skin.jointMatrices[j1] * p) * weights.y +
    (skin.jointMatrices[j2] * p) * weights.z +
    (skin.jointMatrices[j3] * p) * weights.w;
}

fn skinNormal(normal: vec3<f32>, joints: vec4<f32>, weights: vec4<f32>) -> vec3<f32> {
  if (dot(weights, vec4<f32>(1.0)) <= 0.0) {
    return normal;
  }
  let j0 = u32(joints.x);
  let j1 = u32(joints.y);
  let j2 = u32(joints.z);
  let j3 = u32(joints.w);
  let n = vec4<f32>(normal, 0.0);
  return (skin.jointMatrices[j0] * n).xyz * weights.x +
    (skin.jointMatrices[j1] * n).xyz * weights.y +
    (skin.jointMatrices[j2] * n).xyz * weights.z +
    (skin.jointMatrices[j3] * n).xyz * weights.w;
}

fn safeNormalize(value: vec3<f32>) -> vec3<f32> {
  let len2 = dot(value, value);
  if (len2 <= 0.00000001) {
    return value;
  }
  return value * inverseSqrt(len2);
}


const PI : f32 = 3.14159265359;

fn distributionGGX(nDotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 0.00001);
}

fn geometrySchlickGGX(nDotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return nDotV / max(nDotV * (1.0 - k) + k, 0.00001);
}

fn geometrySmith(nDotV: f32, nDotL: f32, roughness: f32) -> f32 {
  return geometrySchlickGGX(nDotV, roughness) * geometrySchlickGGX(nDotL, roughness);
}

fn fresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickF90(cosTheta: f32, f0: vec3<f32>, f90: vec3<f32>) -> vec3<f32> {
  return f0 + (f90 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickRoughness(cosTheta: f32, f0: vec3<f32>, roughness: f32) -> vec3<f32> {
  return f0 + (max(vec3<f32>(1.0 - roughness), f0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickRoughnessF90(
  cosTheta: f32,
  f0: vec3<f32>,
  f90: vec3<f32>,
  roughness: f32,
) -> vec3<f32> {
  let roughF90 = max(f90 * (1.0 - roughness), f0);
  return f0 + (roughF90 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}


fn clearcoatFresnel(cosTheta : f32) -> f32 {
  return 0.04 + 0.96 * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn clearcoatDirectBrdf(
  nDotV : f32,
  nDotL : f32,
  nDotH : f32,
  hDotV : f32,
  roughness : f32,
) -> f32 {
  let resolvedRoughness = clamp(roughness, 0.04, 1.0);
  let d = distributionGGX(nDotH, resolvedRoughness);
  let g = geometrySmith(nDotV, nDotL, resolvedRoughness);
  let f = clearcoatFresnel(hDotV);
  return (d * g * f) / max(4.0 * nDotV * nDotL, 0.0001);
}

fn clearcoatBaseAttenuation(fresnel : f32, factor : f32) -> f32 {
  return clamp(1.0 - clamp(factor, 0.0, 1.0) * fresnel, 0.0, 1.0);
}


fn sheenDistribution(nDotH: f32, roughness: f32) -> f32 {
  let alphaG = max(roughness * roughness, 0.0001);
  let inverseRoughness = 1.0 / alphaG;
  let sin2H = max(1.0 - nDotH * nDotH, 0.0);
  return (2.0 + inverseRoughness)
    * pow(sin2H, inverseRoughness * 0.5)
    / (2.0 * PI);
}

fn sheenVisibilityL(cosTheta: f32, alphaG: f32) -> f32 {
  let oneMinusAlphaSq = (1.0 - alphaG) * (1.0 - alphaG);
  let a = mix(21.5473, 25.3245, oneMinusAlphaSq);
  let b = mix(3.82987, 3.32435, oneMinusAlphaSq);
  let c = mix(0.19823, 0.16801, oneMinusAlphaSq);
  let d = mix(-1.97760, -1.27393, oneMinusAlphaSq);
  let e = mix(-4.32054, -4.85967, oneMinusAlphaSq);
  return a / (1.0 + b * pow(max(cosTheta, 0.0001), c)) + d * cosTheta + e;
}

fn sheenLambda(cosTheta: f32, alphaG: f32) -> f32 {
  let resolvedCosTheta = clamp(abs(cosTheta), 0.0001, 1.0);
  if (resolvedCosTheta < 0.5) {
    return exp(sheenVisibilityL(resolvedCosTheta, alphaG));
  }
  return exp(
    2.0 * sheenVisibilityL(0.5, alphaG)
      - sheenVisibilityL(1.0 - resolvedCosTheta, alphaG),
  );
}

fn sheenVisibility(nDotV: f32, nDotL: f32, roughness: f32) -> f32 {
  let alphaG = max(roughness * roughness, 0.0001);
  let denominator = (
    1.0
      + sheenLambda(nDotV, alphaG)
      + sheenLambda(nDotL, alphaG)
  ) * 4.0 * max(nDotV, 0.0001) * max(nDotL, 0.0001);
  return 1.0 / max(denominator, 0.0001);
}

fn sheenDirectBrdf(
  nDotV: f32,
  nDotL: f32,
  nDotH: f32,
  roughness: f32,
) -> f32 {
  return sheenDistribution(nDotH, roughness)
    * sheenVisibility(nDotV, nDotL, roughness);
}

// Analytic approximation of the Charlie directional albedo lookup. This keeps
// the layer energy-bounded without adding another sampled texture to the
// already binding-dense PBR pipeline.
fn sheenDirectionalAlbedo(nDotV: f32, roughness: f32) -> f32 {
  let grazing = pow(1.0 - clamp(nDotV, 0.0, 1.0), 1.0 + roughness * 2.0);
  return clamp(mix(0.25, 0.75, grazing) * (1.0 - 0.35 * roughness), 0.0, 1.0);
}

fn sheenMaxColor(color: vec3<f32>) -> f32 {
  return max(color.x, max(color.y, color.z));
}

fn sheenDirectBaseAttenuation(
  color: vec3<f32>,
  nDotV: f32,
  nDotL: f32,
  roughness: f32,
) -> f32 {
  let strength = sheenMaxColor(color);
  let viewAttenuation = 1.0 - strength * sheenDirectionalAlbedo(nDotV, roughness);
  let lightAttenuation = 1.0 - strength * sheenDirectionalAlbedo(nDotL, roughness);
  return clamp(min(viewAttenuation, lightAttenuation), 0.0, 1.0);
}

fn sheenIblBaseAttenuation(color: vec3<f32>, nDotV: f32, roughness: f32) -> f32 {
  return clamp(
    1.0 - sheenMaxColor(color) * sheenDirectionalAlbedo(nDotV, roughness),
    0.0,
    1.0,
  );
}


struct DirectionalShadowData {
  lightViewProj : mat4x4<f32>,
  params : vec4<f32>,
}
struct ShadowUniforms {
  shadows : array<DirectionalShadowData, 3u>,
}

@group(3) @binding(5) var<uniform> shadow : ShadowUniforms;
@group(3) @binding(6) var shadowTexture : texture_depth_2d_array;
@group(3) @binding(7) var shadowSampler : sampler_comparison;

fn shadowVisibility(shadowIndex: u32, worldPosition: vec3<f32>, normal: vec3<f32>, lightDirection: vec3<f32>) -> f32 {
  if (shadowIndex >= 3u) { return 1.0; }
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
  model : mat4x4<f32>,
  normalMatrix : mat4x4<f32>,
  morphWeights : vec4<f32>,
  deformationFlags : vec4<f32>,
}
struct TextureMapping {
  row0 : vec4<f32>,
  row1 : vec4<f32>,
}
struct MaterialUniforms {
  baseColor : vec4<f32>,
  emissiveNormalScale : vec4<f32>,
  factors : vec4<f32>,
  flags : vec4<u32>,
  clearcoatFactors : vec4<f32>,
  clearcoatFlags : vec4<u32>,
  specularFactors : vec4<f32>,
  sheenFactors : vec4<f32>,
  transmissionVolumeFactors : vec4<f32>,
  attenuationColorFlags : vec4<f32>,
  baseColorMapping : TextureMapping,
  metallicRoughnessMapping : TextureMapping,
  normalMapping : TextureMapping,
  occlusionMapping : TextureMapping,
  emissiveMapping : TextureMapping,
  clearcoatMapping : TextureMapping,
  clearcoatRoughnessMapping : TextureMapping,
  clearcoatNormalMapping : TextureMapping,
  specularMapping : TextureMapping,
  specularColorMapping : TextureMapping,
  sheenColorMapping : TextureMapping,
  sheenRoughnessMapping : TextureMapping,
  transmissionMapping : TextureMapping,
  thicknessMapping : TextureMapping,
}
struct LightData {
  typeVec : vec4<u32>,
  color : vec4<f32>,
  direction : vec4<f32>,
  position : vec4<f32>,
}
struct LightsUniforms {
  countVec : vec4<u32>,
  lights : array<LightData, 8>,
}
struct EnvironmentUniforms {
  diffuseColor : vec4<f32>,
  specularColor : vec4<f32>,
  params : vec4<f32>,
}
@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<storage, read> objects : array<ObjectUniforms>;
@group(2) @binding(0) var<uniform> material : MaterialUniforms;
@group(2) @binding(1) var baseColorTexture : texture_2d<f32>;
@group(2) @binding(2) var metallicRoughnessTexture : texture_2d<f32>;
@group(2) @binding(3) var normalTexture : texture_2d<f32>;
@group(2) @binding(4) var occlusionTexture : texture_2d<f32>;
@group(2) @binding(5) var emissiveTexture : texture_2d<f32>;
@group(2) @binding(6) var clearcoatTexture : texture_2d<f32>;
@group(2) @binding(7) var clearcoatRoughnessTexture : texture_2d<f32>;
@group(2) @binding(8) var clearcoatNormalTexture : texture_2d<f32>;
@group(2) @binding(9) var specularTexture : texture_2d<f32>;
@group(2) @binding(10) var specularColorTexture : texture_2d<f32>;
@group(2) @binding(11) var extensionTexture0 : texture_2d<f32>;
@group(2) @binding(12) var extensionTexture1 : texture_2d<f32>;
@group(2) @binding(13) var baseColorSampler : sampler;
@group(2) @binding(14) var metallicRoughnessSampler : sampler;
@group(2) @binding(15) var normalSampler : sampler;
@group(2) @binding(16) var occlusionSampler : sampler;
@group(2) @binding(17) var emissiveSampler : sampler;
@group(2) @binding(18) var clearcoatSampler : sampler;
@group(2) @binding(19) var clearcoatRoughnessSampler : sampler;
@group(2) @binding(20) var clearcoatNormalSampler : sampler;
@group(2) @binding(21) var specularSampler : sampler;
@group(2) @binding(22) var specularColorSampler : sampler;
@group(2) @binding(23) var extensionSampler0 : sampler;
@group(2) @binding(24) var extensionSampler1 : sampler;
@group(3) @binding(0) var<uniform> lights : LightsUniforms;
@group(3) @binding(1) var<uniform> environment : EnvironmentUniforms;
@group(3) @binding(2) var diffuseEnvironment : texture_cube<f32>;
@group(3) @binding(3) var specularEnvironment : texture_cube<f32>;
@group(3) @binding(4) var environmentSampler : sampler;
@group(3) @binding(11) var transmissionFramebuffer : texture_2d<f32>;
struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv0 : vec2<f32>,
  @location(3) uv1 : vec2<f32>,
  @location(4) morphPosition0 : vec3<f32>,
  @location(5) morphNormal0 : vec3<f32>,
  @location(6) morphPosition1 : vec3<f32>,
  @location(7) morphNormal1 : vec3<f32>,
  @location(8) morphPosition2 : vec3<f32>,
  @location(9) morphNormal2 : vec3<f32>,
  @location(10) morphPosition3 : vec3<f32>,
  @location(11) morphNormal3 : vec3<f32>,
  @builtin(instance_index) instanceIndex : u32,
  @builtin(vertex_index) vertexIndex : u32,
}
struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) worldNormal : vec3<f32>,
  @location(2) uv0 : vec2<f32>,
  @location(3) uv1 : vec2<f32>,
  @location(4) worldScale : f32,
  @location(5) @interpolate(flat) objectIndex : u32,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  let object = objects[input.instanceIndex];
  let morphedPosition = applyMorphPosition(
    input.position,
    input.morphPosition0,
    input.morphPosition1,
    input.morphPosition2,
    input.morphPosition3,
    object.morphWeights,
  );
  let morphedNormal = applyMorphNormal(
    input.normal,
    input.morphNormal0,
    input.morphNormal1,
    input.morphNormal2,
    input.morphNormal3,
    object.morphWeights,
  );
  var localPosition = vec4<f32>(morphedPosition, 1.0);
  var localNormal = morphedNormal;
  if (object.deformationFlags.y > 0.5) {
    let joints = skinJoints.values[input.vertexIndex];
    let weights = skinWeights.values[input.vertexIndex];
    localPosition = skinPosition(morphedPosition, joints, weights);
    localNormal = safeNormalize(skinNormal(morphedNormal, joints, weights));
  }
  let worldPosition = object.model * localPosition;
  var output : VertexOutput;
  output.clipPos = sceneFrame.viewProjection * worldPosition;
  output.worldPos = worldPosition.xyz;
  output.worldNormal = normalize((object.normalMatrix * vec4<f32>(localNormal, 0.0)).xyz);
  output.uv0 = input.uv0;
  output.uv1 = input.uv1;
  output.worldScale = (
    length(object.model[0].xyz)
    + length(object.model[1].xyz)
    + length(object.model[2].xyz)
  ) / 3.0;
  output.objectIndex = input.instanceIndex;
  return output;
}

fn rotateY(direction: vec3<f32>, angle: f32) -> vec3<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return vec3<f32>(c * direction.x - s * direction.z, direction.y, s * direction.x + c * direction.z);
}
fn maxComponent(value: vec3<f32>) -> f32 {
  return max(value.x, max(value.y, value.z));
}
fn textureUv(input: VertexOutput, mapping: TextureMapping) -> vec2<f32> {
  let source = select(input.uv0, input.uv1, mapping.row0.w > 0.5);
  let uv = vec3<f32>(source, 1.0);
  return vec2<f32>(dot(mapping.row0.xyz, uv), dot(mapping.row1.xyz, uv));
}
fn resolveNormal(input: VertexOutput) -> vec3<f32> {
  var n = normalize(input.worldNormal);
  if ((material.flags.z & 1u) == 0u) { return n; }
  let uv = textureUv(input, material.normalMapping);
  var mapNormal = textureSample(normalTexture, normalSampler, uv).xyz * 2.0 - 1.0;
  mapNormal = vec3<f32>(mapNormal.xy * material.emissiveNormalScale.w, mapNormal.z);
  let dp1 = dpdx(input.worldPos);
  let dp2 = dpdy(input.worldPos);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);
  let determinant = duv1.x * duv2.y - duv1.y * duv2.x;
  if (abs(determinant) < 0.000001) { return n; }
  let tangent = normalize((dp1 * duv2.y - dp2 * duv1.y) / determinant);
  let bitangent = normalize(cross(n, tangent));
  return normalize(mat3x3<f32>(tangent, bitangent, n) * mapNormal);
}
fn resolveClearcoatNormal(input: VertexOutput) -> vec3<f32> {
  var n = normalize(input.worldNormal);
  if ((material.clearcoatFlags.x & 4u) == 0u) { return n; }
  let uv = textureUv(input, material.clearcoatNormalMapping);
  var mapNormal = textureSample(clearcoatNormalTexture, clearcoatNormalSampler, uv).xyz * 2.0 - 1.0;
  mapNormal = vec3<f32>(mapNormal.xy * material.clearcoatFactors.z, mapNormal.z);
  let dp1 = dpdx(input.worldPos);
  let dp2 = dpdy(input.worldPos);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);
  let determinant = duv1.x * duv2.y - duv1.y * duv2.x;
  if (abs(determinant) < 0.000001) { return n; }
  let tangent = normalize((dp1 * duv2.y - dp2 * duv1.y) / determinant);
  let bitangent = normalize(cross(n, tangent));
  return normalize(mat3x3<f32>(tangent, bitangent, n) * mapNormal);
}
fn inverseDisplayToneMap(value: vec3<f32>) -> vec3<f32> {
  let linearDisplay = pow(clamp(value, vec3<f32>(0.0), vec3<f32>(0.9999)), vec3<f32>(2.2));
  return linearDisplay / max(vec3<f32>(0.0001), vec3<f32>(1.0) - linearDisplay);
}
fn sampleTransmissionFramebuffer(uv: vec2<f32>, roughness: f32) -> vec3<f32> {
  let dimensions = vec2<f32>(textureDimensions(transmissionFramebuffer));
  let radius = roughness * roughness * 8.0;
  let texel = vec2<f32>(1.0) / max(dimensions, vec2<f32>(1.0));
  let center = textureSampleLevel(transmissionFramebuffer, environmentSampler, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
  let x0 = textureSampleLevel(transmissionFramebuffer, environmentSampler, clamp(uv + vec2<f32>(radius * texel.x, 0.0), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
  let x1 = textureSampleLevel(transmissionFramebuffer, environmentSampler, clamp(uv - vec2<f32>(radius * texel.x, 0.0), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
  let y0 = textureSampleLevel(transmissionFramebuffer, environmentSampler, clamp(uv + vec2<f32>(0.0, radius * texel.y), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
  let y1 = textureSampleLevel(transmissionFramebuffer, environmentSampler, clamp(uv - vec2<f32>(0.0, radius * texel.y), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
  return inverseDisplayToneMap((center * 4.0 + x0 + x1 + y0 + y1) / 8.0);
}
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let object = objects[input.objectIndex];
  if (hy_is_clipped(input.worldPos, input.objectIndex)) { discard; }
  var base = material.baseColor;
  if (material.flags.x != 0u) { base *= textureSample(baseColorTexture, baseColorSampler, textureUv(input, material.baseColorMapping)); }
  if (material.flags.w == 1u && base.a < material.factors.w) { discard; }

  var metallic = material.factors.x;
  var roughness = material.factors.y;
  if (material.flags.y != 0u) {
    let orm = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, textureUv(input, material.metallicRoughnessMapping));
    roughness *= orm.g;
    metallic *= orm.b;
  }
  roughness = clamp(roughness, 0.04, 1.0);
  metallic = clamp(metallic, 0.0, 1.0);
  var clearcoatFactor = material.clearcoatFactors.x;
  var clearcoatRoughness = material.clearcoatFactors.y;
  if (true) {
    if ((material.clearcoatFlags.x & 1u) != 0u) {
      clearcoatFactor *= textureSample(clearcoatTexture, clearcoatSampler, textureUv(input, material.clearcoatMapping)).r;
    }
    if ((material.clearcoatFlags.x & 2u) != 0u) {
      clearcoatRoughness *= textureSample(clearcoatRoughnessTexture, clearcoatRoughnessSampler, textureUv(input, material.clearcoatRoughnessMapping)).g;
    }
  }
  clearcoatFactor = clamp(clearcoatFactor, 0.0, 1.0);
  clearcoatRoughness = clamp(clearcoatRoughness, 0.0, 1.0);
  var specularWeight = material.specularFactors.x;
  var specularColor = material.specularFactors.yzw;
  if ((material.clearcoatFlags.y & 1u) != 0u) {
    specularWeight *= textureSample(
      specularTexture,
      specularSampler,
      textureUv(input, material.specularMapping),
    ).a;
  }
  if ((material.clearcoatFlags.y & 2u) != 0u) {
    specularColor *= textureSample(
      specularColorTexture,
      specularColorSampler,
      textureUv(input, material.specularColorMapping),
    ).rgb;
  }
  specularWeight = clamp(specularWeight, 0.0, 1.0);
  specularColor = max(specularColor, vec3<f32>(0.0));
  var sheenColor = material.sheenFactors.rgb;
  var sheenRoughness = material.sheenFactors.a;
  if (!true && (material.clearcoatFlags.z & 1u) != 0u) {
    sheenColor *= textureSample(
      extensionTexture0,
      extensionSampler0,
      textureUv(input, material.sheenColorMapping),
    ).rgb;
  }
  if (!true && (material.clearcoatFlags.z & 2u) != 0u) {
    sheenRoughness *= textureSample(
      extensionTexture1,
      extensionSampler1,
      textureUv(input, material.sheenRoughnessMapping),
    ).a;
  }
  sheenColor = clamp(sheenColor, vec3<f32>(0.0), vec3<f32>(1.0));
  sheenRoughness = clamp(sheenRoughness, 0.0, 1.0);
  let sheenEnabled = sheenMaxColor(sheenColor) > 0.0;
  var transmission = material.transmissionVolumeFactors.x;
  var thickness = material.transmissionVolumeFactors.y;
  if (true && (u32(material.transmissionVolumeFactors.w) & 1u) != 0u) {
    transmission *= textureSample(
      extensionTexture0,
      extensionSampler0,
      textureUv(input, material.transmissionMapping),
    ).r;
  }
  if (true && (u32(material.transmissionVolumeFactors.w) & 2u) != 0u) {
    thickness *= textureSample(
      extensionTexture1,
      extensionSampler1,
      textureUv(input, material.thicknessMapping),
    ).g;
  }
  transmission = clamp(transmission, 0.0, 1.0) * (1.0 - metallic);
  thickness = max(thickness * input.worldScale, 0.0);
  let opaqueDiffuseWeight = 1.0 - transmission;
  let n = resolveNormal(input);
  var clearcoatNormal = n;
  if (true) { clearcoatNormal = resolveClearcoatNormal(input); }
  let v = normalize(sceneFrame.eyePosition.xyz - input.worldPos);
  let nDotV = max(dot(n, v), 0.0001);
  let clearcoatNDotV = max(dot(clearcoatNormal, v), 0.0001);
  let ior = max(material.clearcoatFactors.w, 0.0);
  let iorRatio = (ior - 1.0) / (ior + 1.0);
  let dielectricF0 = min(vec3<f32>(iorRatio * iorRatio) * specularColor, vec3<f32>(1.0))
    * specularWeight;
  let dielectricF90 = vec3<f32>(specularWeight);
  let f0 = mix(dielectricF0, base.rgb, metallic);
  let f90 = mix(dielectricF90, vec3<f32>(1.0), metallic);
  var direct = vec3<f32>(0.0);

  for (var index = 0u; index < min(lights.countVec.x, 8u); index++) {
    let light = lights.lights[index];
    if (light.typeVec.x == 0u) {
      let ambientF = fresnelSchlickF90(nDotV, dielectricF0, dielectricF90);
      let ambientDiffuseWeight = 1.0 - maxComponent(ambientF);
      let ambientRadiance = light.color.rgb * light.color.a;
      let ambientBase = ambientRadiance * base.rgb * (1.0 - metallic) * ambientDiffuseWeight * opaqueDiffuseWeight;
      var ambientLayered = ambientBase;
      if (sheenEnabled) {
        let sheenEnergy = sheenDirectionalAlbedo(nDotV, sheenRoughness);
        ambientLayered = ambientBase * sheenIblBaseAttenuation(sheenColor, nDotV, sheenRoughness)
          + ambientRadiance * sheenColor * sheenEnergy;
      }
      let ambientAttenuation = select(
        1.0,
        clearcoatBaseAttenuation(clearcoatFresnel(clearcoatNDotV), clearcoatFactor),
        true,
      );
      direct += ambientLayered * ambientAttenuation;
      continue;
    }
    var l = normalize(-light.direction.xyz);
    var radiance = light.color.rgb * light.color.a;
    if (light.typeVec.x == 2u) {
      let toLight = light.position.xyz - input.worldPos;
      let distance = length(toLight);
      l = toLight / max(distance, 0.0001);
      let attenuation = pow(clamp(1.0 - distance / max(light.position.w, 0.0001), 0.0, 1.0), 2.0);
      radiance *= attenuation;
    }
    let h = normalize(v + l);
    let nDotL = max(dot(n, l), 0.0);
    let nDotH = max(dot(n, h), 0.0);
    let hDotV = max(dot(h, v), 0.0);
    let d = distributionGGX(nDotH, roughness);
    let g = geometrySmith(nDotV, nDotL, roughness);
    let f = fresnelSchlickF90(hDotV, f0, f90);
    let dielectricF = fresnelSchlickF90(hDotV, dielectricF0, dielectricF90);
    let specular = (d * g * f) / max(4.0 * nDotV * nDotL, 0.0001);
    let kd = vec3<f32>(1.0 - maxComponent(dielectricF)) * (1.0 - metallic) * opaqueDiffuseWeight;
    var visibility = 1.0;
    if (light.typeVec.x == 1u && index < 3u) {
      visibility = shadowVisibility(index, input.worldPos, n, l);
    }
    let baseDirect = (kd * base.rgb / PI + specular) * radiance * nDotL * visibility;
    var layeredDirect = baseDirect;
    if (sheenEnabled && nDotL > 0.0) {
      let sheenBrdf = sheenDirectBrdf(nDotV, nDotL, nDotH, sheenRoughness);
      let sheenAttenuation = sheenDirectBaseAttenuation(
        sheenColor,
        nDotV,
        nDotL,
        sheenRoughness,
      );
      layeredDirect = baseDirect * sheenAttenuation
        + radiance * sheenColor * sheenBrdf * nDotL * visibility;
    }
    if (true && clearcoatFactor > 0.0) {
      let clearcoatH = normalize(v + l);
      let clearcoatNDotL = max(dot(clearcoatNormal, l), 0.0);
      let clearcoatNDotH = max(dot(clearcoatNormal, clearcoatH), 0.0);
      let clearcoatHDotV = max(dot(clearcoatH, v), 0.0);
      let coat = clearcoatDirectBrdf(
        clearcoatNDotV,
        clearcoatNDotL,
        clearcoatNDotH,
        clearcoatHDotV,
        clearcoatRoughness,
      );
      let attenuation = clearcoatBaseAttenuation(clearcoatFresnel(clearcoatNDotV), clearcoatFactor);
      direct += layeredDirect * attenuation
        + radiance * coat * clearcoatFactor * clearcoatNDotL * visibility;
    } else {
      direct += layeredDirect;
    }
  }

  let rotation = environment.params.y;
  let reflected = rotateY(reflect(-v, n), rotation);
  let irradianceDirection = rotateY(n, rotation);
  var irradiance = environment.diffuseColor.rgb;
  var prefiltered = environment.specularColor.rgb;
  if (environment.params.w > 0.5) {
    irradiance *= textureSampleLevel(diffuseEnvironment, environmentSampler, irradianceDirection, environment.params.z).rgb;
    prefiltered *= textureSampleLevel(specularEnvironment, environmentSampler, reflected, roughness * environment.params.z).rgb;
  }
  let dielectricEnvironmentF = fresnelSchlickRoughnessF90(
    nDotV,
    dielectricF0,
    dielectricF90,
    roughness,
  );
  let metalEnvironmentF = fresnelSchlickRoughnessF90(
    nDotV,
    base.rgb,
    vec3<f32>(1.0),
    roughness,
  );
  let environmentF = mix(dielectricEnvironmentF, metalEnvironmentF, metallic);
  let environmentKd = vec3<f32>(1.0 - maxComponent(dielectricEnvironmentF)) * (1.0 - metallic);
  var occlusion = 1.0;
  if ((material.flags.z & 2u) != 0u) {
    let sampledOcclusion = textureSample(occlusionTexture, occlusionSampler, textureUv(input, material.occlusionMapping)).r;
    occlusion = mix(1.0, sampledOcclusion, material.factors.z);
  }
  var ibl = (environmentKd * irradiance * base.rgb / PI * opaqueDiffuseWeight + prefiltered * environmentF) * environment.params.x * occlusion;
  if (true && transmission > 0.0) {
    var transmissionUv = input.clipPos.xy / vec2<f32>(textureDimensions(transmissionFramebuffer));
    var volumePathLength = thickness;
    var transmissionVisibility = 1.0;
    if (thickness > 0.0) {
      let refracted = refract(-v, n, 1.0 / max(ior, 1.0));
      if (dot(refracted, refracted) > 0.000001) {
        volumePathLength = thickness / max(abs(dot(refracted, n)), 0.01);
        let exitClip = sceneFrame.viewProjection * vec4<f32>(input.worldPos + refracted * thickness, 1.0);
        transmissionUv = exitClip.xy / max(exitClip.w, 0.0001) * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
      } else {
        transmissionVisibility = 0.0;
      }
    }
    var transmitted = sampleTransmissionFramebuffer(transmissionUv, roughness);
    if (thickness > 0.0 && material.transmissionVolumeFactors.z > 0.0) {
      transmitted *= pow(
        max(material.attenuationColorFlags.rgb, vec3<f32>(0.0001)),
        vec3<f32>(volumePathLength / material.transmissionVolumeFactors.z),
      );
    } else if (thickness <= 0.0) {
      transmitted *= base.rgb;
    }
    ibl += transmitted * transmission * transmissionVisibility * (vec3<f32>(1.0) - dielectricEnvironmentF);
  }
  if (sheenEnabled) {
    var sheenPrefiltered = environment.specularColor.rgb;
    if (environment.params.w > 0.5) {
      sheenPrefiltered *= textureSampleLevel(
        specularEnvironment,
        environmentSampler,
        reflected,
        sheenRoughness * environment.params.z,
      ).rgb;
    }
    let sheenEnergy = sheenDirectionalAlbedo(nDotV, sheenRoughness);
    ibl = ibl * sheenIblBaseAttenuation(sheenColor, nDotV, sheenRoughness)
      + sheenPrefiltered * sheenColor * sheenEnergy * environment.params.x * occlusion;
  }
  if (true && clearcoatFactor > 0.0) {
    let clearcoatReflected = rotateY(reflect(-v, clearcoatNormal), rotation);
    var clearcoatPrefiltered = environment.specularColor.rgb;
    if (environment.params.w > 0.5) {
      clearcoatPrefiltered *= textureSampleLevel(
        specularEnvironment,
        environmentSampler,
        clearcoatReflected,
        clearcoatRoughness * environment.params.z,
      ).rgb;
    }
    let clearcoatF = clearcoatFresnel(clearcoatNDotV) * clearcoatFactor;
    ibl = ibl * clearcoatBaseAttenuation(clearcoatFresnel(clearcoatNDotV), clearcoatFactor)
      + clearcoatPrefiltered * clearcoatF * environment.params.x * occlusion;
  }
  var emissive = material.emissiveNormalScale.rgb;
  if ((material.flags.z & 4u) != 0u) { emissive *= textureSample(emissiveTexture, emissiveSampler, textureUv(input, material.emissiveMapping)).rgb; }
  let color = direct + ibl + emissive;
  let mapped = color / (color + vec3<f32>(1.0));
  let displayColor = pow(mapped, vec3<f32>(1.0 / 2.2));
  return vec4<f32>(applyFog(displayColor, sceneFrame.fog, sceneFrame.eyePosition.xyz, input.worldPos), base.a);
}
