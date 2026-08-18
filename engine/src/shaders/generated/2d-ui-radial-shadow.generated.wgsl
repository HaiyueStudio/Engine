// haiyue:builtin-render radial-shadow
// source: shader-language/builtin-engine-2d-ui-family.json

struct CameraUniforms {
  viewProj : mat4x4<f32>,
}

struct ObjectUniforms {
  model : mat4x4<f32>,
}

struct ShadowParams {
  colorOpacity : vec4<f32>,
  settings     : vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(1) @binding(0) var<uniform> object : ObjectUniforms;
@group(2) @binding(0) var<uniform> params : ShadowParams;

struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) uv       : vec2<f32>,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) uv            : vec2<f32>,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.clipPos = camera.viewProj * object.model * vec4<f32>(input.position, 1.0);
  out.uv = input.uv;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let p = input.uv * 2.0 - vec2<f32>(1.0, 1.0);
  let d = length(p);
  let fade = 1.0 - smoothstep(params.settings.x, 1.0, d);
  let alpha = fade * params.colorOpacity.a;
  return vec4<f32>(params.colorOpacity.rgb, alpha);
}
