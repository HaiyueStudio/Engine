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
