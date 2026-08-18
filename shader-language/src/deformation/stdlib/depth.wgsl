struct ObjectUniforms {
  model : mat4x4<f32>,
  morphWeights : vec4<f32>,
  deformationFlags : vec4<f32>,
}

struct DepthParams {
  near          : f32,
  far           : f32,
  isOrthographic : u32,
  reverseZ      : u32,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<storage, read> objects : array<ObjectUniforms>;
@group(2) @binding(0) var<uniform> params : DepthParams;

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) viewDepth : f32,
  @location(1) worldPos : vec3<f32>,
  @location(2) @interpolate(flat) objectIndex : u32,
}

struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) morphPosition0 : vec3<f32>,
  @location(2) morphPosition1 : vec3<f32>,
  @location(3) morphPosition2 : vec3<f32>,
  @location(4) morphPosition3 : vec3<f32>,
  @builtin(vertex_index) vertexIndex : u32,
  @builtin(instance_index) instanceIndex : u32,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
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
  let viewPosition = sceneFrame.view * worldPosition;
  out.clipPos = sceneFrame.viewProjection * worldPosition;
  out.viewDepth = -viewPosition.z;
  out.worldPos = worldPosition.xyz;
  out.objectIndex = input.instanceIndex;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let object = objects[in.objectIndex];
  if (hy_is_clipped(in.worldPos, in.objectIndex)) { discard; }
  let linearDepth = clamp((in.viewDepth - params.near) / (params.far - params.near), 0.0, 1.0);
  return vec4<f32>(linearDepth, linearDepth, linearDepth, 1.0);
}
