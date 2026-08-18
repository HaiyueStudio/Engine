// haiyue:builtin-render tilemap2d
// source: shader-language/builtin-components-2d-ui-family.json

struct CameraUniforms {
  viewProj : mat4x4<f32>,
}

struct ObjectUniforms {
  model : mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(1) @binding(0) var<uniform> object : ObjectUniforms;

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) color : vec4<f32>,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) color : vec4<f32>,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  var out : VertexOutput;
  out.clipPos = camera.viewProj * object.model * vec4<f32>(input.position, 0.0, 1.0);
  out.color = input.color;
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
