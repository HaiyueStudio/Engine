// haiyue:deformation-pass outline
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


@group(3) @binding(0) var<storage, read> skin : SkinUniforms;
@group(3) @binding(1) var<storage, read> skinJoints : SkinAttributes;
@group(3) @binding(2) var<storage, read> skinWeights : SkinAttributes;


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


// Prefix of the forward PBR material ABI. Borrowing the same buffer and texture
// keeps readiness, factor alpha, cutoff, UV selection and transforms identical.
struct CoverageMaterial {
  baseColor : vec4<f32>,
  emissiveAndNormalScale : vec4<f32>,
  surfaceAndCutoff : vec4<f32>,
  flags : vec4<u32>,
  extensions : array<vec4<f32>, 6>,
  baseMapping0 : vec4<f32>,
  baseMapping1 : vec4<f32>,
}
@group(2) @binding(1) var<uniform> coverage : CoverageMaterial;
@group(2) @binding(2) var coverageTexture : texture_2d<f32>;
@group(2) @binding(3) var coverageSampler : sampler;

fn hy_has_material_coverage(uv0: vec2<f32>, uv1: vec2<f32>) -> bool {
  if (coverage.flags.w != 1u) { return true; }
  var alpha = coverage.baseColor.a;
  if (coverage.flags.x != 0u) {
    let uv = select(uv0, uv1, coverage.baseMapping0.w > 0.5);
    let mapped = vec2<f32>(dot(coverage.baseMapping0.xy, uv) + coverage.baseMapping0.z,
      dot(coverage.baseMapping1.xy, uv) + coverage.baseMapping1.z);
    alpha *= textureSample(coverageTexture, coverageSampler, mapped).a;
  }
  return alpha >= coverage.surfaceAndCutoff.w;
}


struct ObjectUniforms {
  model : mat4x4<f32>,
  morphWeights : vec4<f32>,
  deformationFlags : vec4<f32>,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<storage, read> objects : array<ObjectUniforms>;

struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) morphPosition0 : vec3<f32>,
  @location(2) morphPosition1 : vec3<f32>,
  @location(3) morphPosition2 : vec3<f32>,
  @location(4) morphPosition3 : vec3<f32>,
  @location(5) uv0 : vec2<f32>,
  @location(6) uv1 : vec2<f32>,
  @builtin(vertex_index) vertexIndex : u32,
  @builtin(instance_index) instanceIndex : u32,
}

struct VertexOutput {
  @location(2) uv0 : vec2<f32>,
  @location(3) uv1 : vec2<f32>,
  @builtin(position) clipPosition : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) @interpolate(flat) objectIndex : u32,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  let object = objects[input.instanceIndex];
  let morphedPosition = applyMorphPosition(
    input.position,
    input.morphPosition0,
    input.morphPosition1,
    input.morphPosition2,
    input.morphPosition3,
    object.morphWeights,
  );
  var localPosition = vec4<f32>(morphedPosition, 1.0);
  if (object.deformationFlags.y > 0.5) {
    let joints = skinJoints.values[input.vertexIndex];
    let weights = skinWeights.values[input.vertexIndex];
    localPosition = skinPosition(morphedPosition, joints, weights);
  }
  let worldPosition = object.model * localPosition;
  var output : VertexOutput;
  output.clipPosition = sceneFrame.viewProjection * worldPosition;
  output.worldPos = worldPosition.xyz;
  output.objectIndex = input.instanceIndex;
  output.uv0 = input.uv0;
  output.uv1 = input.uv1;
  return output;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let object = objects[input.objectIndex];
  if (!hy_has_material_coverage(input.uv0, input.uv1)) { discard; }
  if (hy_is_clipped(input.worldPos, input.objectIndex)) { discard; }
  return vec4<f32>(1.0);
}
