struct DenoiseParams {
  image: vec4u,
  controls: vec4f,
  reserved0: vec4f,
  reserved1: vec4f,
}
@group(0) @binding(0) var<uniform> params: DenoiseParams;
@group(0) @binding(1) var accumulation: texture_2d<f32>;
@group(0) @binding(2) var moments: texture_2d<f32>;
@group(0) @binding(3) var feature: texture_2d<f32>;
@group(0) @binding(4) var previousDenoised: texture_2d<f32>;
@group(0) @binding(5) var temporalOutput: texture_storage_2d<rgba16float, write>;

fn luma(value: vec3f) -> f32 { return dot(value, vec3f(0.2126, 0.7152, 0.0722)); }
@compute @workgroup_size(8, 8, 1)
fn temporal_main(@builtin(global_invocation_id) globalId: vec3u) {
  if (globalId.x >= params.image.x || globalId.y >= params.image.y) { return; }
  let pixel = vec2i(globalId.xy); let limit = vec2i(params.image.xy) - vec2i(1);
  let current = textureLoad(accumulation, pixel, 0).rgb; var lower = current; var upper = current;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let neighbor = textureLoad(accumulation, clamp(pixel + vec2i(x, y), vec2i(0), limit), 0).rgb;
    lower = min(lower, neighbor); upper = max(upper, neighbor);
  }}
  let previous = clamp(textureLoad(previousDenoised, pixel, 0).rgb, lower, upper);
  let moment = textureLoad(moments, pixel, 0).rg; let variance = max(0.0, moment.y - moment.x * moment.x);
  let featureValue = textureLoad(feature, pixel, 0); let difference = abs(luma(previous) - featureValue.x);
  let threshold = params.controls.y + sqrt(variance) * params.controls.w;
  var weight = params.controls.x * exp(-difference / max(threshold, 1e-5));
  if (params.image.z == 0u || params.image.w != 0u || difference > threshold * 4.0) { weight = 0.0; }
  textureStore(temporalOutput, pixel, vec4f(mix(current, previous, clamp(weight, 0.0, 0.95)), 1.0));
}
