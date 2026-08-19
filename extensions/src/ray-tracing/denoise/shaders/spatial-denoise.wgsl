struct DenoiseParams {
  image: vec4u,
  controls: vec4f,
  reserved0: vec4f,
  reserved1: vec4f,
}
@group(0) @binding(0) var<uniform> params: DenoiseParams;
@group(0) @binding(1) var temporalInput: texture_2d<f32>;
@group(0) @binding(2) var moments: texture_2d<f32>;
@group(0) @binding(3) var feature: texture_2d<f32>;
@group(0) @binding(4) var spatialOutput: texture_storage_2d<rgba16float, write>;

fn luma(value: vec3f) -> f32 { return dot(value, vec3f(0.2126, 0.7152, 0.0722)); }
@compute @workgroup_size(8, 8, 1)
fn spatial_main(@builtin(global_invocation_id) globalId: vec3u) {
  if (globalId.x >= params.image.x || globalId.y >= params.image.y) { return; }
  let pixel = vec2i(globalId.xy); let limit = vec2i(params.image.xy) - vec2i(1);
  let center = textureLoad(temporalInput, pixel, 0).rgb; let centerFeature = textureLoad(feature, pixel, 0);
  let moment = textureLoad(moments, pixel, 0).rg; let variance = max(0.0, moment.y - moment.x * moment.x);
  let colorScale = params.controls.y + sqrt(variance) * params.controls.w;
  var total = center * 4.0; var totalWeight = 4.0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    if (x == 0 && y == 0) { continue; }
    let location = clamp(pixel + vec2i(x, y), vec2i(0), limit);
    let value = textureLoad(temporalInput, location, 0).rgb; let featureValue = textureLoad(feature, location, 0);
    let colorDifference = abs(luma(value) - luma(center));
    let featureDifference = abs(featureValue.x - centerFeature.x) + abs(featureValue.y - centerFeature.y);
    let distanceWeight = select(0.7, 1.0, x == 0 || y == 0);
    let weight = distanceWeight * exp(-colorDifference / max(colorScale, 1e-5)) * exp(-featureDifference / max(params.controls.z, 1e-5));
    total += value * weight; totalWeight += weight;
  }}
  textureStore(spatialOutput, pixel, vec4f(total / totalWeight, 1.0));
}
