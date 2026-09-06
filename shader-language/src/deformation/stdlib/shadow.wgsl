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

@vertex
fn vs_main(
  @location(5) uv0: vec2<f32>,
  @location(6) uv1: vec2<f32>,
  @location(0) position: vec3<f32>,
  @builtin(instance_index) instanceIndex: u32,
) -> ShadowVertexOutput {
  let object = objects[instanceIndex];
  let worldPosition = object.model * vec4<f32>(position, 1.0);
  var output : ShadowVertexOutput;
  output.clipPosition = lightCamera.viewProj * worldPosition;
  output.worldPos = worldPosition.xyz;
  output.objectIndex = instanceIndex;
  output.uv0 = uv0;
  output.uv1 = uv1;
  return output;
}

@fragment fn fs_main(input : ShadowVertexOutput) -> @location(0) vec4<f32> {
  let object = objects[input.objectIndex];
  if (!hy_has_material_coverage(input.uv0, input.uv1)) { discard; }
  if (hy_is_clipped(input.worldPos, input.objectIndex)) { discard; }
  return vec4<f32>(1.0);
}
