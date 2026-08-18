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
  lights   : array<LightData, TOON_MAX_LIGHTS>,
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
