struct Viewport {
  size : vec2<f32>,
  _pad : vec2<f32>,
}

@group(0) @binding(0) var<uniform> viewport : Viewport;
@group(1) @binding(0) var fontTex : texture_2d<f32>;
@group(1) @binding(1) var fontSampler : sampler;

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) color : vec4<f32>,
  @location(3) clip : vec4<f32>,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) screenPos : vec2<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) color : vec4<f32>,
  @location(3) clip : vec4<f32>,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  var out : VertexOutput;
  let clipX = input.position.x / viewport.size.x * 2.0 - 1.0;
  let clipY = 1.0 - input.position.y / viewport.size.y * 2.0;
  out.clipPos = vec4<f32>(clipX, clipY, 0.0, 1.0);
  out.screenPos = input.position;
  out.uv = input.uv;
  out.color = input.color;
  out.clip = input.clip;
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  if (
    input.screenPos.x < input.clip.x ||
    input.screenPos.y < input.clip.y ||
    input.screenPos.x > input.clip.z ||
    input.screenPos.y > input.clip.w
  ) {
    discard;
  }
  let sample = textureSample(fontTex, fontSampler, input.uv);
  let alpha = sample.a * input.color.a;
  if (alpha <= 0.01) {
    discard;
  }
  return vec4<f32>(input.color.rgb, alpha);
}
