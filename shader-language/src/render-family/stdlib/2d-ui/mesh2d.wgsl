struct CameraUniforms {
  viewProj : mat4x4<f32>,
}

struct ObjectUniforms {
  model : mat4x4<f32>,
  color : vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(1) @binding(0) var<storage, read> objects : array<ObjectUniforms>;

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) color : vec4<f32>,
}

@vertex
fn vs_main(@location(0) position : vec2<f32>, @builtin(instance_index) objectIndex : u32) -> VertexOutput {
  var out : VertexOutput;
  let object = objects[objectIndex];
  out.clipPos = camera.viewProj * object.model * vec4<f32>(position, 0.0, 1.0);
  out.color = object.color;
  return out;
}

@fragment
fn fs_main(in : VertexOutput) -> @location(0) vec4<f32> {
  return in.color;
}
