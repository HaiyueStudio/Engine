// haiyue:deformation-pass shadow-skinned
// haiyue:deformation-abi 1
// haiyue:deformation-module 10c43d2008ebba9ec6891c008f57347c11e9e2d86f693a669075cd9c61c2544d
// source: shader-language/builtin-deformation-family.json

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


struct LightCamera { viewProj : mat4x4<f32> }
struct ObjectData {
  model : mat4x4<f32>,
  morphWeights : vec4<f32>,
  deformationFlags : vec4<f32>,
}

@group(0) @binding(0) var<uniform> lightCamera : LightCamera;
@group(1) @binding(0) var<storage, read> objects : array<ObjectData>;

struct ShadowVertexOutput {
  @location(2) uv0 : vec2<f32>,
  @location(3) uv1 : vec2<f32>,
  @builtin(position) clipPosition : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) @interpolate(flat) objectIndex : u32,
}

struct VertexInput {
  @location(5) uv0 : vec2<f32>,
  @location(6) uv1 : vec2<f32>,
  @location(0) position : vec3<f32>,
  @builtin(instance_index) instanceIndex : u32,
  @builtin(vertex_index) vertexIndex : u32,
}

@vertex
fn vs_main(input: VertexInput) -> ShadowVertexOutput {
  let object = objects[input.instanceIndex];
  let joints = skinJoints.values[input.vertexIndex];
  let weights = skinWeights.values[input.vertexIndex];
  let position = skinPosition(input.position, joints, weights);
  let worldPosition = object.model * position;
  var output : ShadowVertexOutput;
  output.clipPosition = lightCamera.viewProj * worldPosition;
  output.worldPos = worldPosition.xyz;
  output.objectIndex = input.instanceIndex;
  output.uv0 = input.uv0;
  output.uv1 = input.uv1;
  return output;
}

@fragment fn fs_main(input : ShadowVertexOutput) -> @location(0) vec4<f32> {
  let object = objects[input.objectIndex];
  if (!hy_has_material_coverage(input.uv0, input.uv1)) { discard; }
  if (hy_is_clipped(input.worldPos, input.objectIndex)) { discard; }
  return vec4<f32>(1.0);
}
