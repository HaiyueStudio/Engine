// haiyue:deformation-pass forward
// haiyue:deformation-abi 1
// haiyue:deformation-module 10c43d2008ebba9ec6891c008f57347c11e9e2d86f693a669075cd9c61c2544d
// source: shader-language/builtin-deformation-family.json

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


struct ObjectUniforms {
  model : mat4x4<f32>,
  morphWeights : vec4<f32>,
  deformationFlags : vec4<f32>,
}

struct MaterialUniforms {
  color    : vec4<f32>,
  emissiveFactor : vec4<f32>,
  useTexture : u32,
  useEmissiveTexture : u32,
  _pad1    : u32,
  _pad2    : u32,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<storage, read> objects : array<ObjectUniforms>;
@group(2) @binding(0) var<uniform> material : MaterialUniforms;
@group(2) @binding(1) var baseTexture       : texture_2d<f32>;
@group(2) @binding(2) var baseSampler       : sampler;
@group(2) @binding(3) var emissiveTexture   : texture_2d<f32>;

struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) uv       : vec2<f32>,
  @location(3) morphPosition0 : vec3<f32>,
  @location(4) morphPosition1 : vec3<f32>,
  @location(5) morphPosition2 : vec3<f32>,
  @location(6) morphPosition3 : vec3<f32>,
  @builtin(instance_index) instanceIndex : u32,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) uv            : vec2<f32>,
  @location(1) normal        : vec3<f32>,
  @location(2) worldPos      : vec3<f32>,
  @location(3) @interpolate(flat) objectIndex : u32,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let object = objects[input.instanceIndex];
  let position = applyMorphPosition(
    input.position,
    input.morphPosition0,
    input.morphPosition1,
    input.morphPosition2,
    input.morphPosition3,
    object.morphWeights,
  );
  let worldPosition = object.model * vec4<f32>(position, 1.0);
  out.clipPos = sceneFrame.viewProjection * worldPosition;
  out.uv      = input.uv;
  out.normal  = input.normal;
  out.worldPos = worldPosition.xyz;
  out.objectIndex = input.instanceIndex;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let object = objects[input.objectIndex];
  if (hy_is_clipped(input.worldPos, input.objectIndex)) { discard; }
  var texColor = vec4<f32>(1.0, 1.0, 1.0, 1.0);
  if (material.useTexture != 0u) {
    texColor = textureSample(baseTexture, baseSampler, input.uv);
  }
  var outColor = texColor * material.color;
  if (material.useEmissiveTexture != 0u) {
    let emissive = textureSample(emissiveTexture, baseSampler, input.uv).rgb * material.emissiveFactor.rgb;
    outColor = vec4<f32>(outColor.rgb + emissive, outColor.a);
  }
  return vec4<f32>(applyFog(outColor.rgb, sceneFrame.fog, sceneFrame.eyePosition.xyz, input.worldPos), outColor.a);
}
