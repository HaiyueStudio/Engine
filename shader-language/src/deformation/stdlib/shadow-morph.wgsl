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
  @location(1) morphPosition0 : vec3<f32>,
  @location(2) morphPosition1 : vec3<f32>,
  @location(3) morphPosition2 : vec3<f32>,
  @location(4) morphPosition3 : vec3<f32>,
  @builtin(instance_index) instanceIndex : u32,
}

@vertex
fn vs_main(input: VertexInput) -> ShadowVertexOutput {
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
