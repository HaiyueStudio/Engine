// haiyue:builtin-render gui-shape
// source: shader-language/builtin-engine-2d-ui-family.json

struct Viewport {
  size : vec2<f32>,
  _pad : vec2<f32>,
}

@group(0) @binding(0) var<uniform> viewport : Viewport;

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) rect : vec4<f32>,
  @location(3) radius : f32,
  @location(4) clip : vec4<f32>,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) screenPos : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) rect : vec4<f32>,
  @location(3) radius : f32,
  @location(4) clip : vec4<f32>,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  var out : VertexOutput;
  let clipX = input.position.x / viewport.size.x * 2.0 - 1.0;
  let clipY = 1.0 - input.position.y / viewport.size.y * 2.0;
  out.clipPos = vec4<f32>(clipX, clipY, 0.0, 1.0);
  out.screenPos = input.position;
  out.color = input.color;
  out.rect = input.rect;
  out.radius = input.radius;
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
  let halfSize = input.rect.zw * 0.5;
  let center = input.rect.xy + halfSize;
  let radius = min(input.radius, min(halfSize.x, halfSize.y));
  let q = abs(input.screenPos - center) - (halfSize - vec2<f32>(radius, radius));
  let d = length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
  let alpha = 1.0 - smoothstep(0.0, 1.0, d);
  if (alpha <= 0.001) {
    discard;
  }
  return vec4<f32>(input.color.rgb, input.color.a * alpha);
}
