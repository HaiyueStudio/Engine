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
