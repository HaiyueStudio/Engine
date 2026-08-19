struct ProgressiveParams {
  image: vec4u,
  sequence: vec4u,
  render: vec4f,
  debug: vec4f,
}
struct ProgressiveDiagnostics {
  varianceSamples: atomic<u32>,
  varianceSum: atomic<u32>,
  varianceMax: atomic<u32>,
  pixels: atomic<u32>,
}
@group(0) @binding(0) var<uniform> params: ProgressiveParams;
@group(0) @binding(1) var rawSample: texture_2d<f32>;
@group(0) @binding(2) var previousAccumulation: texture_2d<f32>;
@group(0) @binding(3) var previousMoments: texture_2d<f32>;
@group(0) @binding(4) var accumulationOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var momentsOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var featureOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var ageOutput: texture_storage_2d<r32uint, write>;
@group(0) @binding(8) var<storage, read_write> diagnostics: ProgressiveDiagnostics;

fn srgb_to_linear(value: vec3f) -> vec3f {
  let low = value / 12.92; let high = pow((value + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(high, low, value <= vec3f(0.04045));
}
fn luma(value: vec3f) -> f32 { return dot(value, vec3f(0.2126, 0.7152, 0.0722)); }
fn raw_linear(pixel: vec2i) -> vec3f {
  let limit = vec2i(params.image.xy) - vec2i(1);
  return srgb_to_linear(textureLoad(rawSample, clamp(pixel, vec2i(0), limit), 0).rgb);
}

@compute @workgroup_size(8, 8, 1)
fn accumulate_main(@builtin(global_invocation_id) globalId: vec3u) {
  if (globalId.x >= params.image.x || globalId.y >= params.image.y) { return; }
  let pixel = vec2i(globalId.xy); let sample = raw_linear(pixel); let sampleLuma = luma(sample);
  let sampleIndex = params.image.z; let count = f32(sampleIndex + 1u);
  var mean = sample; var meanLuma = sampleLuma; var meanSquared = sampleLuma * sampleLuma;
  if (sampleIndex != 0u) {
    let previous = textureLoad(previousAccumulation, pixel, 0).rgb;
    let previousMoment = textureLoad(previousMoments, pixel, 0).rg;
    mean = previous + (sample - previous) / count;
    meanLuma = previousMoment.x + (sampleLuma - previousMoment.x) / count;
    meanSquared = previousMoment.y + (sampleLuma * sampleLuma - previousMoment.y) / count;
  }
  let variance = max(0.0, meanSquared - meanLuma * meanLuma);
  let right = raw_linear(pixel + vec2i(1, 0)); let down = raw_linear(pixel + vec2i(0, 1));
  let edge = max(abs(sampleLuma - luma(right)), abs(sampleLuma - luma(down)));
  textureStore(accumulationOutput, pixel, vec4f(mean, 1.0));
  textureStore(momentsOutput, pixel, vec4f(meanLuma, meanSquared, 0.0, 0.0));
  textureStore(featureOutput, pixel, vec4f(meanLuma, edge, variance, 1.0));
  textureStore(ageOutput, pixel, vec4u(sampleIndex + 1u, 0u, 0u, 0u));
  atomicAdd(&diagnostics.pixels, 1u);
  if ((globalId.x & 15u) == 0u && (globalId.y & 15u) == 0u) {
    let encoded = u32(min(variance, 1.0) * 65535.0 + 0.5);
    atomicAdd(&diagnostics.varianceSamples, 1u); atomicAdd(&diagnostics.varianceSum, encoded); atomicMax(&diagnostics.varianceMax, encoded);
  }
}
