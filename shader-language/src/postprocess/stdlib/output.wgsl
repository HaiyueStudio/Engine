struct OutputParams { settings : vec4<f32>, }
@group(__GROUP__) @binding(0) var sourceColor : texture_2d<f32>;
@group(__GROUP__) @binding(1) var<uniform> params : OutputParams;

fn encodeSrgb(color : vec3<f32>) -> vec3<f32> {
  return select(1.055 * pow(color, vec3<f32>(1.0 / 2.4)) - 0.055, color * 12.92, color <= vec3<f32>(0.0031308));
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(sourceColor));
  let pixel = clamp(vec2<i32>(input.uv * vec2<f32>(size)), vec2<i32>(0), size - vec2<i32>(1));
  let source = textureLoad(sourceColor, pixel, 0);
  // Floating-point captures remain scene-linear, before exposure and display conversion.
  if (params.settings.z == 0.0) { return source; }
  let alpha = clamp(source.a, 0.0, 1.0);
  // Additive-only layers carry radiance with zero coverage.
  let coverage = select(alpha, 1.0, alpha == 0.0);
  var color = max(source.rgb / max(coverage, 0.000001), vec3<f32>(0.0)) * params.settings.x;
  if (params.settings.y > 0.5) { color = color / (color + vec3<f32>(1.0)); }
  // An sRGB attachment performs the transfer in hardware. Ordinary UNORM needs it here.
  if (params.settings.z == 1.0) { color = encodeSrgb(color); }
  return vec4<f32>(color * coverage, alpha);
}
