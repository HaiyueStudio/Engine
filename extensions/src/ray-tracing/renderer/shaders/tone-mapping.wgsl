// Authoritative G05 tone-mapping module. Kept separate from path tracing so HDR
// storage-write and sampled-read never alias in one WebGPU usage scope.
struct ToneParams {
  image: vec4u,
  scene: vec4u,
  cameraOrigin: vec4f,
  cameraRight: vec4f,
  cameraUp: vec4f,
  cameraForward: vec4f,
  environment: vec4f,
  render: vec4f,
}
@group(0) @binding(0) var<uniform> toneParams: ToneParams;
@group(0) @binding(1) var toneInput: texture_2d<f32>;
@group(0) @binding(2) var toneOutput: texture_storage_2d<rgba8unorm, write>;

fn linear_to_srgb(value: vec3f) -> vec3f {
  let low = value * 12.92;
  let high = 1.055 * pow(max(value, vec3f(0.0)), vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(high, low, value <= vec3f(0.0031308));
}
fn aces(value: vec3f) -> vec3f {
  return clamp((value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@compute @workgroup_size(8, 8, 1)
fn tone_main(@builtin(global_invocation_id) globalId: vec3u) {
  if (globalId.x >= toneParams.image.x || globalId.y >= toneParams.image.y) { return; }
  var color = textureLoad(toneInput, vec2i(globalId.xy), 0).rgb * toneParams.render.y;
  if ((toneParams.scene.w & 4u) != 0u) { color = color / (vec3f(1.0) + color); }
  else if ((toneParams.scene.w & 8u) != 0u) { color = aces(color); }
  color = linear_to_srgb(clamp(color, vec3f(0.0), vec3f(1.0)));
  textureStore(toneOutput, vec2i(globalId.xy), vec4f(color, 1.0));
}
