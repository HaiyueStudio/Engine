struct ProgressiveParams {
  image: vec4u,
  sequence: vec4u,
  render: vec4f,
  debug: vec4f,
}
@group(0) @binding(0) var<uniform> params: ProgressiveParams;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var moments: texture_2d<f32>;
@group(0) @binding(3) var feature: texture_2d<f32>;
@group(0) @binding(4) var age: texture_2d<u32>;
@group(0) @binding(5) var output: texture_storage_2d<rgba8unorm, write>;

fn linear_to_srgb(value: vec3f) -> vec3f {
  let low = value * 12.92; let high = 1.055 * pow(max(value, vec3f(0.0)), vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(high, low, value <= vec3f(0.0031308));
}
fn aces(value: vec3f) -> vec3f { return clamp((value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14), vec3f(0.0), vec3f(1.0)); }

@compute @workgroup_size(8, 8, 1)
fn present_main(@builtin(global_invocation_id) globalId: vec3u) {
  if (globalId.x >= params.image.x || globalId.y >= params.image.y) { return; }
  let pixel = vec2i(globalId.xy); let view = params.image.w; var color = textureLoad(source, pixel, 0).rgb;
  if (view == 2u) { let moment = textureLoad(moments, pixel, 0).rg; let variance = max(0.0, moment.y - moment.x * moment.x); color = vec3f(min(1.0, variance * params.debug.x)); }
  else if (view == 3u) { let value = f32(textureLoad(age, pixel, 0).r); color = vec3f(log2(value + 1.0) / max(log2(params.debug.y + 1.0), 1.0)); }
  else if (view == 4u) { let value = textureLoad(feature, pixel, 0); color = vec3f(value.x, min(1.0, value.y * params.debug.z), min(1.0, value.z * params.debug.x)); }
  else {
    color *= params.render.x;
    if (params.sequence.w == 1u) { color = color / (vec3f(1.0) + color); }
    else if (params.sequence.w == 2u) { color = aces(color); }
  }
  textureStore(output, pixel, vec4f(linear_to_srgb(clamp(color, vec3f(0.0), vec3f(1.0))), 1.0));
}
