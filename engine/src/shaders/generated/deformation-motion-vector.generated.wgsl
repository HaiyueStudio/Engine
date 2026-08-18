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


struct ObjectMotionUniforms {
  currentModel           : mat4x4<f32>,
  previousModel          : mat4x4<f32>,
  previousViewProjection : mat4x4<f32>,
  currentMorphWeights    : vec4<f32>,
  previousMorphWeights   : vec4<f32>,
  deformationFlags       : vec4<f32>,
}

struct MotionSkinMatrices {
  values : array<mat4x4<f32>>,
}

struct MotionSkinAttributes {
  values : array<vec4<f32>>,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<uniform> object : ObjectMotionUniforms;
@group(2) @binding(0) var<storage, read> currentSkinMatrices : MotionSkinMatrices;
@group(2) @binding(1) var<storage, read> previousSkinMatrices : MotionSkinMatrices;
@group(2) @binding(2) var<storage, read> motionSkinJoints : MotionSkinAttributes;
@group(2) @binding(3) var<storage, read> motionSkinWeights : MotionSkinAttributes;

struct VertexOutput {
  @builtin(position) clipPosition : vec4<f32>,
  @location(0) @interpolate(perspective, center) previousClipPosition : vec4<f32>,
  @location(1) worldPos : vec3<f32>,
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
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec2<f32> {
  if (hy_is_clipped(input.worldPos, 0u)) { discard; }
  let previousMagnitude = max(abs(input.previousClipPosition.w), 0.000001);
  let previousW = select(-previousMagnitude, previousMagnitude, input.previousClipPosition.w >= 0.0);
  let previousNdc = input.previousClipPosition.xy / previousW;
  let currentUv = input.clipPosition.xy * sceneFrame.viewport.zw;
  let previousUv = vec2<f32>(previousNdc.x * 0.5 + 0.5, 0.5 - previousNdc.y * 0.5);
  return currentUv - previousUv;
}
