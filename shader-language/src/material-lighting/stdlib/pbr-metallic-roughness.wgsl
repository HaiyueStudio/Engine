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
  if (CLEARCOAT_ENABLED) {
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
  if (!TRANSMISSION_ENABLED && (material.clearcoatFlags.z & 1u) != 0u) {
    sheenColor *= textureSample(
      extensionTexture0,
      extensionSampler0,
      textureUv(input, material.sheenColorMapping),
    ).rgb;
  }
  if (!TRANSMISSION_ENABLED && (material.clearcoatFlags.z & 2u) != 0u) {
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
  if (TRANSMISSION_ENABLED && (u32(material.transmissionVolumeFactors.w) & 1u) != 0u) {
    transmission *= textureSample(
      extensionTexture0,
      extensionSampler0,
      textureUv(input, material.transmissionMapping),
    ).r;
  }
  if (TRANSMISSION_ENABLED && (u32(material.transmissionVolumeFactors.w) & 2u) != 0u) {
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
  if (CLEARCOAT_ENABLED) { clearcoatNormal = resolveClearcoatNormal(input); }
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

  for (var index = 0u; index < min(lights.countVec.x, MAX_LIGHTS); index++) {
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
        CLEARCOAT_ENABLED,
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
    if (light.typeVec.x == 1u && index < MAX_DIRECTIONAL_SHADOWS) {
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
    if (CLEARCOAT_ENABLED && clearcoatFactor > 0.0) {
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
  if (TRANSMISSION_ENABLED && transmission > 0.0) {
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
  if (CLEARCOAT_ENABLED && clearcoatFactor > 0.0) {
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
