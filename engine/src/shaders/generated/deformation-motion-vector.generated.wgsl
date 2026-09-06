// haiyue:deformation-pass motion-vector
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


struct ObjectMotionUniforms {
  currentModel           : mat4x4<f32>,
  previousModel          : mat4x4<f32>,
  previousViewProjection : mat4x4<f32>,
  currentMorphWeights    : vec4<f32>,
  previousMorphWeights   : vec4<f32>,
  deformationFlags       : vec4<f32>,
  cameraDepth            : vec4<f32>,
  jitterDelta            : vec4<f32>,
}

struct MotionSkinMatrices {
  values : array<mat4x4<f32>>,
}

struct MotionSkinAttributes {
  values : array<vec4<f32>>,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<uniform> object : ObjectMotionUniforms;
@group(3) @binding(0) var<storage, read> currentSkinMatrices : MotionSkinMatrices;
@group(3) @binding(1) var<storage, read> previousSkinMatrices : MotionSkinMatrices;
@group(3) @binding(2) var<storage, read> motionSkinJoints : MotionSkinAttributes;
@group(3) @binding(3) var<storage, read> motionSkinWeights : MotionSkinAttributes;

struct VertexOutput {
  @location(2) uv0 : vec2<f32>,
  @location(3) uv1 : vec2<f32>,
  @builtin(position) clipPosition : vec4<f32>,
  @location(0) @interpolate(perspective, center) previousClipPosition : vec4<f32>,
  @location(1) worldPos : vec3<f32>,
  @location(4) viewNormal : vec3<f32>,
  @location(5) viewDepth : f32,
}

fn skinMotionPosition(
  position : vec3<f32>,
  joints : vec4<f32>,
  weights : vec4<f32>,
  previous : bool,
) -> vec4<f32> {
  if (dot(weights, vec4<f32>(1.0)) <= 0.0) { return vec4<f32>(position, 1.0); }
  let j0 = u32(joints.x);
  let j1 = u32(joints.y);
  let j2 = u32(joints.z);
  let j3 = u32(joints.w);
  let p = vec4<f32>(position, 1.0);
  if (previous) {
    return (previousSkinMatrices.values[j0] * p) * weights.x +
      (previousSkinMatrices.values[j1] * p) * weights.y +
      (previousSkinMatrices.values[j2] * p) * weights.z +
      (previousSkinMatrices.values[j3] * p) * weights.w;
  }
  return (currentSkinMatrices.values[j0] * p) * weights.x +
    (currentSkinMatrices.values[j1] * p) * weights.y +
    (currentSkinMatrices.values[j2] * p) * weights.z +
    (currentSkinMatrices.values[j3] * p) * weights.w;
}

struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) morphPosition0 : vec3<f32>,
  @location(2) morphPosition1 : vec3<f32>,
  @location(3) morphPosition2 : vec3<f32>,
  @location(4) morphPosition3 : vec3<f32>,
  @location(5) uv0 : vec2<f32>,
  @location(6) uv1 : vec2<f32>,
  @location(7) normal : vec3<f32>,
  @location(8) morphNormal0 : vec3<f32>,
  @location(9) morphNormal1 : vec3<f32>,
  @location(10) morphNormal2 : vec3<f32>,
  @location(11) morphNormal3 : vec3<f32>,
  @builtin(vertex_index) vertexIndex : u32,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  let currentLocal = applyMorphPosition(
    input.position,
    input.morphPosition0,
    input.morphPosition1,
    input.morphPosition2,
    input.morphPosition3,
    object.currentMorphWeights,
  );
  let previousLocal = applyMorphPosition(
    input.position,
    input.morphPosition0,
    input.morphPosition1,
    input.morphPosition2,
    input.morphPosition3,
    object.previousMorphWeights,
  );
  var currentPosition = vec4<f32>(currentLocal, 1.0);
  var previousPosition = vec4<f32>(previousLocal, 1.0);
  if (object.deformationFlags.y > 0.5) {
    let joints = motionSkinJoints.values[input.vertexIndex];
    let weights = motionSkinWeights.values[input.vertexIndex];
    currentPosition = skinMotionPosition(currentLocal, joints, weights, false);
    previousPosition = skinMotionPosition(previousLocal, joints, weights, true);
  }
  let currentClip = sceneFrame.viewProjection * object.currentModel * currentPosition;
  let previousClip = object.previousViewProjection * object.previousModel * previousPosition;
  var out : VertexOutput;
  out.clipPosition = currentClip;
  out.previousClipPosition = previousClip;
  out.worldPos = (object.currentModel * currentPosition).xyz;
  out.uv0 = input.uv0;
  out.uv1 = input.uv1;
  out.viewDepth = -(sceneFrame.view * object.currentModel * currentPosition).z;
  out.viewNormal = vec3<f32>(0.0, 0.0, 1.0);
  if (object.deformationFlags.w > 0.5) {
    var normal = applyMorphNormal(input.normal, input.morphNormal0, input.morphNormal1,
      input.morphNormal2, input.morphNormal3, object.currentMorphWeights);
    if (object.deformationFlags.y > 0.5) {
      let joints = motionSkinJoints.values[input.vertexIndex];
      let weights = motionSkinWeights.values[input.vertexIndex];
      if (dot(weights, vec4<f32>(1.0)) > 0.0) {
        let n = vec4<f32>(normal, 0.0);
        normal = ((currentSkinMatrices.values[u32(joints.x)] * n) * weights.x +
          (currentSkinMatrices.values[u32(joints.y)] * n) * weights.y +
          (currentSkinMatrices.values[u32(joints.z)] * n) * weights.z +
          (currentSkinMatrices.values[u32(joints.w)] * n) * weights.w).xyz;
      }
    }
    // Cofactors implement the model inverse-transpose without enlarging the
    // temporal object ABI. Preserve determinant sign under mirrored scaling.
    let a = object.currentModel[0].xyz;
    let b = object.currentModel[1].xyz;
    let c = object.currentModel[2].xyz;
    let determinantSign = select(-1.0, 1.0, dot(a, cross(b, c)) >= 0.0);
    let worldNormal = normalize((cross(b, c) * normal.x + cross(c, a) * normal.y + cross(a, b) * normal.z) * determinantSign);
    out.viewNormal = normalize((sceneFrame.view * vec4<f32>(worldNormal, 0.0)).xyz);
  }
  return out;
}

struct AuxiliaryOutput {
  @location(0) motion : vec4<f32>,
  @location(1) depth : f32,
  @location(2) normal : vec4<f32>,
}

@fragment
fn fs_main(input : VertexOutput) -> AuxiliaryOutput {
  if (!hy_has_material_coverage(input.uv0, input.uv1)) { discard; }
  if (hy_is_clipped(input.worldPos, 0u)) { discard; }
  let previousMagnitude = max(abs(input.previousClipPosition.w), 0.000001);
  let previousW = select(-previousMagnitude, previousMagnitude, input.previousClipPosition.w >= 0.0);
  let previousNdc = input.previousClipPosition.xy / previousW;
  let currentUv = input.clipPosition.xy * sceneFrame.viewport.zw;
  let previousUv = vec2<f32>(previousNdc.x * 0.5 + 0.5, 0.5 - previousNdc.y * 0.5);
  let previousDeviceDepth = input.previousClipPosition.z / previousW;
  var previousDepth = (input.previousClipPosition.w - object.cameraDepth.x) / (object.cameraDepth.y - object.cameraDepth.x);
  if (object.cameraDepth.z > 0.5) {
    previousDepth = select(previousDeviceDepth, 1.0 - previousDeviceDepth, object.cameraDepth.w > 0.5);
  }
  let projected = input.previousClipPosition.w > 0.000001 && previousDeviceDepth >= 0.0 && previousDeviceDepth <= 1.0;
  let valid = projected && object.deformationFlags.z > 0.5;
  let velocity = select(vec2<f32>(0.0), currentUv - previousUv - object.jitterDelta.xy, projected);
  var out : AuxiliaryOutput;
  out.motion = vec4<f32>(velocity, clamp(previousDepth, 0.0, 1.0), select(-1.0, 1.0, valid));
  out.depth = clamp((input.viewDepth - object.cameraDepth.x) / (object.cameraDepth.y - object.cameraDepth.x), 0.0, 1.0);
  out.normal = vec4<f32>(normalize(input.viewNormal) * 0.5 + vec3<f32>(0.5), 1.0);
  return out;
}
