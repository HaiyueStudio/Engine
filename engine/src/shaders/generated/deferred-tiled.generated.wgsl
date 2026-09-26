const TILE_SIZE: u32 = 16u;
const TILE_WORKGROUP_SIZE: u32 = 64u;
const TILE_CAPACITY: u32 = 128u;
const TILE_HEADER_WORDS: u32 = 4u;
const TILE_STRIDE_WORDS: u32 = 132u;
struct DeferredTileParameters { grid: vec4<u32>, viewport: vec4<f32>, }
@group(3) @binding(15) var<storage, read> tileWords: array<u32>;
@group(3) @binding(16) var<uniform> tileParameters: DeferredTileParameters;

// Return (word offset, count, full-list fallback). Never add a stored prefix to fallback.
fn deferredTileRange(pixel: vec2<f32>) -> vec3<u32> {
  let tileXY = vec2<u32>(max(pixel - tileParameters.viewport.xy, vec2<f32>(0.0))) / TILE_SIZE;
  let tile = tileXY.y * tileParameters.grid.x + tileXY.x;
  let base = tile * TILE_STRIDE_WORDS;
  if (any(tileXY >= tileParameters.grid.xy) || tile >= tileParameters.grid.w
    || tile >= arrayLength(&tileWords) / TILE_STRIDE_WORDS) {
    return vec3<u32>(0u, lightView.pointCount, 1u);
  }
  let offset = tileWords[base];
  let count = tileWords[base + 1u];
  if (tileWords[base + 2u] != 0u || count > min(tileParameters.grid.z, TILE_CAPACITY)
    || offset != base + TILE_HEADER_WORDS) {
    return vec3<u32>(0u, lightView.pointCount, 1u);
  }
  return vec3<u32>(offset, count, 0u);
}

// Per-pixel terms shared by every local light. The G02 reference remains the oracle.
struct DeferredPointSurface {
  n: vec3<f32>,
  v: vec3<f32>,
  base: vec3<f32>,
  f0: vec3<f32>,
  nDotV: f32,
  metallic: f32,
  a2: f32,
  k: f32,
  gV: f32,
}
fn deferredPointSurface(n: vec3<f32>, v: vec3<f32>, base: vec3<f32>,
  nDotV: f32, metallic: f32, roughness: f32) -> DeferredPointSurface {
  let a = roughness * roughness;
  let r = roughness + 1.0;
  let k = r * r / 8.0;
  return DeferredPointSurface(n, v, base, mix(vec3<f32>(0.04), base, metallic),
    nDotV, metallic, a * a, k, nDotV / max(nDotV * (1.0 - k) + k, 0.00001));
}
fn deferredPoint(positionRange: vec4<f32>, lightRadiance: vec3<f32>, position: vec3<f32>, s: DeferredPointSurface) -> vec3<f32> {
  let toLight = positionRange.xyz - position;
  let distance = length(toLight);
  let range = max(positionRange.w, 0.0001);
  if (distance >= range) { return vec3<f32>(0.0); }
  let l = toLight / max(distance, 0.0001);
  let nDotL = max(dot(s.n, l), 0.0);
  if (nDotL <= 0.0) { return vec3<f32>(0.0); }
  let h = deferredNormalize(s.v + l);
  let nDotH = max(dot(s.n, h), 0.0);
  let hDotV = max(dot(h, s.v), 0.0);
  let fresnel = pow(clamp(1.0 - hDotV, 0.0, 1.0), 5.0);
  let f = s.f0 + (vec3<f32>(1.0) - s.f0) * fresnel;
  let dielectricF = 0.04 + (1.0 - 0.04) * fresnel;
  let denominator = nDotH * nDotH * (s.a2 - 1.0) + 1.0;
  let d = s.a2 / max(PI * denominator * denominator, 0.00001);
  let g = s.gV * (nDotL / max(nDotL * (1.0 - s.k) + s.k, 0.00001));
  let specular = d * g * f / max(4.0 * s.nDotV * nDotL, 0.0001);
  let kd = vec3<f32>(1.0 - dielectricF) * (1.0 - s.metallic);
  let radiance = lightRadiance * pow(clamp(1.0 - distance / range, 0.0, 1.0), 2.0);
  return (kd * s.base / PI + specular) * radiance * nDotL;
}

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


struct DeferredSourceHeader {
  abiVersion: u32,
  sourceGeneration: u32,
  pointCount: u32,
  directionalCount: u32,
}

struct DeferredLightRecord {
  positionRange: vec4<f32>,
  radiance: vec4<f32>,
  direction: vec4<f32>,
  identity: vec4<u32>,
}

struct DeferredViewHeader {
  sourceGeneration: u32,
  pointCount: u32,
  directionalCount: u32,
  flags: u32,
  ambientRadiance: vec4<f32>,
}


struct DirectionalShadowData {
  lightViewProj : mat4x4<f32>,
  params : vec4<f32>,
}
struct ShadowUniforms {
  shadows : array<DirectionalShadowData, 3u>,
}

@group(3) @binding(12) var<uniform> shadow : ShadowUniforms;
@group(3) @binding(13) var shadowTexture : texture_depth_2d_array;
@group(3) @binding(14) var shadowSampler : sampler_comparison;

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


struct DeferredSource {
  header: DeferredSourceHeader,
  records: array<DeferredLightRecord>,
}
struct DeferredResolveParameters {
  // Pixel-space origin and extent of the G-buffer viewport, including nonzero origins.
  viewport: vec4<f32>,
  // x = depth clear (0 reverse-Z / 1 forward-Z), yz = viewport min/max depth.
  depth: vec4<f32>,
}
struct EnvironmentUniforms {
  diffuseColor: vec4<f32>,
  specularColor: vec4<f32>,
  params: vec4<f32>,
}
@group(0) @binding(0) var<uniform> sceneFrame: SceneFrameUniforms;
@group(3) @binding(0) var<storage, read> source: DeferredSource;
@group(3) @binding(1) var<uniform> lightView: DeferredViewHeader;
@group(3) @binding(2) var<storage, read> pointIndices: array<u32>;
@group(3) @binding(3) var g0: texture_2d<f32>;
@group(3) @binding(4) var g1: texture_2d<f32>;
@group(3) @binding(5) var g2: texture_2d<f32>;
@group(3) @binding(6) var gDepth: texture_depth_2d;
@group(3) @binding(7) var<uniform> resolveParameters: DeferredResolveParameters;
@group(3) @binding(8) var<uniform> environment: EnvironmentUniforms;
@group(3) @binding(9) var diffuseEnvironment: texture_cube<f32>;
@group(3) @binding(10) var specularEnvironment: texture_cube<f32>;
@group(3) @binding(11) var environmentSampler: sampler;

fn deferredMaxComponent(value: vec3<f32>) -> f32 { return max(value.x, max(value.y, value.z)); }
fn deferredNormalize(value: vec3<f32>) -> vec3<f32> { return value / max(length(value), 0.000001); }
fn deferredRotateY(direction: vec3<f32>, angle: f32) -> vec3<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return vec3<f32>(c * direction.x - s * direction.z, direction.y, s * direction.x + c * direction.z);
}

fn deferredDirect(light: DeferredLightRecord, position: vec3<f32>, n: vec3<f32>, v: vec3<f32>,
  nDotV: f32, base: vec3<f32>, metallic: f32, roughness: f32) -> vec3<f32> {
  var l = deferredNormalize(-light.direction.xyz);
  var radiance = light.radiance.rgb;
  if (light.identity.x == 2u) {
    let toLight = light.positionRange.xyz - position;
    let distance = length(toLight);
    l = toLight / max(distance, 0.0001);
    radiance *= pow(clamp(1.0 - distance / max(light.positionRange.w, 0.0001), 0.0, 1.0), 2.0);
  }
  let h = deferredNormalize(v + l);
  let nDotL = max(dot(n, l), 0.0);
  let nDotH = max(dot(n, h), 0.0);
  let hDotV = max(dot(h, v), 0.0);
  let f0 = mix(vec3<f32>(0.04), base, metallic);
  let f = fresnelSchlickF90(hDotV, f0, vec3<f32>(1.0));
  let dielectricF = fresnelSchlickF90(hDotV, vec3<f32>(0.04), vec3<f32>(1.0));
  let d = distributionGGX(nDotH, roughness);
  let g = geometrySmith(nDotV, nDotL, roughness);
  let specular = (d * g * f) / max(4.0 * nDotV * nDotL, 0.0001);
  let kd = vec3<f32>(1.0 - deferredMaxComponent(dielectricF)) * (1.0 - metallic);
  var visibility = 1.0;
  if (light.identity.x == 1u && light.identity.z < 3u) {
    visibility = shadowVisibility(light.identity.z, position, n, l);
  }
  return (kd * base / PI + specular) * radiance * nDotL * visibility;
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
struct DeferredResolveOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}
@fragment
fn fs_main(@builtin(position) pixel: vec4<f32>) -> DeferredResolveOutput {
  let xy = vec2<i32>(pixel.xy);
  let depth = textureLoad(gDepth, xy, 0);
  if (depth == resolveParameters.depth.x) { discard; }
  let baseMetallic = textureLoad(g0, xy, 0);
  let normalRoughness = textureLoad(g1, xy, 0);
  let emissiveOcclusion = textureLoad(g2, xy, 0);
  if (normalRoughness.a < 0.0) { discard; }
  // CPU validates the same contract. Guard GPU access as well; no stale list can address another generation.
  if (source.header.abiVersion != 1u || source.header.sourceGeneration != lightView.sourceGeneration
    || lightView.directionalCount != source.header.directionalCount
    || lightView.pointCount > arrayLength(&pointIndices)) { discard; }
  let uv = (pixel.xy - resolveParameters.viewport.xy) / resolveParameters.viewport.zw;
  let ndcDepth = (depth - resolveParameters.depth.y) / (resolveParameters.depth.z - resolveParameters.depth.y);
  let homogeneous = sceneFrame.inverseViewProjection * vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), ndcDepth, 1.0);
  let position = homogeneous.xyz / homogeneous.w;
  let n = deferredNormalize(normalRoughness.xyz);
  let v = deferredNormalize(sceneFrame.eyePosition.xyz - position);
  let nDotV = max(dot(n, v), 0.0001);
  let base = baseMetallic.rgb;
  let metallic = baseMetallic.a;
  let roughness = normalRoughness.a;
  let ambientF = fresnelSchlickF90(nDotV, vec3<f32>(0.04), vec3<f32>(1.0));
  var direct = lightView.ambientRadiance.rgb * base * (1.0 - metallic) * (1.0 - deferredMaxComponent(ambientF));
  for (var index = 0u; index < lightView.directionalCount; index++) {
    direct += deferredDirect(source.records[index], position, n, v, nDotV, base, metallic, roughness);
  }
  let tileRange = deferredTileRange(pixel.xy);
  let pointSurface = deferredPointSurface(n, v, base, nDotV, metallic, roughness);
  if (tileRange.z != 0u) {
    for (var index = 0u; index < lightView.pointCount; index++) {
      let local = pointIndices[index];
      if (local < source.header.pointCount) {
        let sourceIndex = source.header.directionalCount + local;
        direct += deferredPoint(source.records[sourceIndex].positionRange, source.records[sourceIndex].radiance.rgb, position, pointSurface);
      }
    }
  } else {
    for (var index = 0u; index < tileRange.y; index++) {
      let local = tileWords[tileRange.x + index];
      if (local < source.header.pointCount) {
        let sourceIndex = source.header.directionalCount + local;
        direct += deferredPoint(source.records[sourceIndex].positionRange, source.records[sourceIndex].radiance.rgb, position, pointSurface);
      }
    }
  }
  let dielectricF = fresnelSchlickRoughnessF90(nDotV, vec3<f32>(0.04), vec3<f32>(1.0), roughness);
  let metalF = fresnelSchlickRoughnessF90(nDotV, base, vec3<f32>(1.0), roughness);
  let environmentF = mix(dielectricF, metalF, metallic);
  let kd = vec3<f32>(1.0 - deferredMaxComponent(dielectricF)) * (1.0 - metallic);
  var irradiance = environment.diffuseColor.rgb;
  var prefiltered = environment.specularColor.rgb;
  if (environment.params.w > 0.5) {
    let rotation = environment.params.y;
    irradiance *= textureSampleLevel(diffuseEnvironment, environmentSampler, deferredRotateY(n, rotation), environment.params.z).rgb;
    prefiltered *= textureSampleLevel(specularEnvironment, environmentSampler, deferredRotateY(reflect(-v, n), rotation), roughness * environment.params.z).rgb;
  }
  let ibl = (kd * irradiance * base / PI + prefiltered * environmentF) * environment.params.x * emissiveOcclusion.a;
  let color = direct + ibl + emissiveOcclusion.rgb;
  return DeferredResolveOutput(vec4<f32>(applyFog(color, sceneFrame.fog, sceneFrame.eyePosition.xyz, position), 1.0), depth);
}
