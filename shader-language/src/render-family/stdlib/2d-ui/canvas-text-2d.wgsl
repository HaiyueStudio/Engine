struct CameraUniforms {
  viewProj : mat4x4<f32>,
}

struct ObjectUniforms {
  model : mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(1) @binding(0) var<uniform> object : ObjectUniforms;
@group(2) @binding(0) var textTexture : texture_2d<f32>;
@group(2) @binding(1) var textSampler : sampler;

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) uv : vec2<f32>,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  var out : VertexOutput;
  out.clipPos = camera.viewProj * object.model * vec4<f32>(input.position, 0.0, 1.0);
  out.uv = input.uv;
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(textTexture, textSampler, input.uv);
}
