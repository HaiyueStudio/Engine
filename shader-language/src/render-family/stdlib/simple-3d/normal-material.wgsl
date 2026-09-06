struct ObjectUniforms {
  model        : mat4x4<f32>,
  normalMatrix : mat4x4<f32>,
  morphWeights : vec4<f32>,
  deformationFlags : vec4<f32>,
}

struct NormalParams {
  space : u32,
  near : f32,
  far : f32,
  _pad2 : u32,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<storage, read> objects : array<ObjectUniforms>;
@group(2) @binding(0) var<uniform> params : NormalParams;

struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) morphPosition0 : vec3<f32>,
  @location(3) morphNormal0 : vec3<f32>,
  @location(4) morphPosition1 : vec3<f32>,
  @location(5) morphNormal1 : vec3<f32>,
  @location(6) morphPosition2 : vec3<f32>,
  @location(7) morphNormal2 : vec3<f32>,
  @location(8) morphPosition3 : vec3<f32>,
  @location(9) morphNormal3 : vec3<f32>,
  @location(10) uv0 : vec2<f32>,
  @location(11) uv1 : vec2<f32>,
  @builtin(vertex_index) vertexIndex : u32,
  @builtin(instance_index) instanceIndex : u32,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) normal        : vec3<f32>,
  @location(1) worldPos      : vec3<f32>,
  @location(2) @interpolate(flat) objectIndex : u32,
  @location(3) uv0 : vec2<f32>,
  @location(4) uv1 : vec2<f32>,
  @location(5) viewDepth : f32,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let object = objects[input.instanceIndex];
  var position = vec4<f32>(applyMorphPosition(input.position, input.morphPosition0, input.morphPosition1,
    input.morphPosition2, input.morphPosition3, object.morphWeights), 1.0);
  var localNormal = applyMorphNormal(input.normal, input.morphNormal0, input.morphNormal1,
    input.morphNormal2, input.morphNormal3, object.morphWeights);
  if (object.deformationFlags.y > 0.5) {
    let joints = skinJoints.values[input.vertexIndex];
    let weights = skinWeights.values[input.vertexIndex];
    position = skinPosition(position.xyz, joints, weights);
    localNormal = safeNormalize(skinNormal(localNormal, joints, weights));
  }
  let worldPosition = object.model * position;
  out.clipPos = sceneFrame.viewProjection * worldPosition;
  out.worldPos = worldPosition.xyz;
  out.objectIndex = input.instanceIndex;
  out.uv0 = input.uv0;
  out.uv1 = input.uv1;
  out.viewDepth = -(sceneFrame.view * worldPosition).z;

  var n = localNormal;
  if (params.space == 0u) {
    n = normalize(localNormal);
  } else if (params.space == 1u) {
    n = normalize((object.normalMatrix * vec4<f32>(localNormal, 0.0)).xyz);
  } else {
    // A mat4 inverse-transpose can carry translation in its bottom row. Drop
    // that homogeneous component before the camera transform so translation
    // can never leak into a direction vector.
    let worldNormal = normalize((object.normalMatrix * vec4<f32>(localNormal, 0.0)).xyz);
    n = normalize((sceneFrame.view * vec4<f32>(worldNormal, 0.0)).xyz);
  }

  out.normal = n;
  return out;
}

struct AuxiliaryOutput {
  @location(0) normal : vec4<f32>,
  @location(1) depth : f32,
}

@fragment
fn fs_main(input: VertexOutput) -> AuxiliaryOutput {
  let object = objects[input.objectIndex];
  if (!hy_has_material_coverage(input.uv0, input.uv1)) { discard; }
  if (hy_is_clipped(input.worldPos, input.objectIndex)) { discard; }
  let n = normalize(input.normal);
  var out : AuxiliaryOutput;
  out.normal = vec4<f32>(n * 0.5 + vec3<f32>(0.5, 0.5, 0.5), 1.0);
  out.depth = clamp((input.viewDepth - params.near) / (params.far - params.near), 0.0, 1.0);
  return out;
}
