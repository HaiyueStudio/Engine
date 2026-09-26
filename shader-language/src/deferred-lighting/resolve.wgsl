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
  for (var index = 0u; index < lightView.pointCount; index++) {
    let local = pointIndices[index];
    if (local < source.header.pointCount) {
      direct += deferredDirect(source.records[source.header.directionalCount + local], position, n, v, nDotV, base, metallic, roughness);
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
