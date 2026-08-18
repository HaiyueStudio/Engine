// haiyue:typed-ir bcf86dd8d974d52061e010f2700df013dbc850f922e7f8853217caad5a6b0f0b

// haiyue:postprocess-module 1c40f6b5a68dbc08aa464942931a2d05ef4d099437d03ca4cc0cfa41063c3f2d

struct VertexOutput {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> VertexOutput {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0),
  );
  var output : VertexOutput;
  output.pos = vec4<f32>(pos[vi], 0.0, 1.0);
  output.uv = uvs[vi];
  return output;
}

struct MotionBlurParams {
  resolution : vec4<f32>,
  settings : vec4<f32>,
  display : vec4<f32>,
}

@group(0) @binding(0) var sourceTexture : texture_2d<f32>;
@group(0) @binding(1) var motionTexture : texture_2d<f32>;
@group(0) @binding(2) var neighborMaxTexture : texture_2d<f32>;
@group(0) @binding(3) var linearSampler : sampler;
@group(0) @binding(4) var<uniform> params : MotionBlurParams;

fn clampPixel(pixel : vec2<i32>, dimensions : vec2<i32>) -> vec2<i32> {
  return clamp(pixel, vec2<i32>(0), dimensions - vec2<i32>(1));
}

fn capVelocity(velocity : vec2<f32>) -> vec2<f32> {
  let velocityPixels = velocity * params.resolution.xy;
  let pixelLength = length(velocityPixels);
  if (pixelLength > params.settings.z && pixelLength > 0.000001) {
    return velocity * params.settings.z / pixelLength;
  }
  return velocity;
}

fn velocityHeatmap(velocity : vec2<f32>) -> vec4<f32> {
  let velocityPixels = velocity * params.resolution.xy;
  let magnitude = length(velocityPixels);
  if (magnitude < 0.15) { return vec4<f32>(0.012, 0.018, 0.035, 1.0); }
  let direction = atan2(velocityPixels.y, velocityPixels.x);
  let phase = vec3<f32>(0.0, 2.0943951, 4.1887902);
  let hue = 0.5 + 0.5 * cos(vec3<f32>(direction) + phase);
  let brightness = sqrt(clamp(magnitude / max(params.settings.z, 1.0), 0.0, 1.0));
  return vec4<f32>(hue * (0.06 + brightness * 0.94), 1.0);
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let dimensions = vec2<i32>(textureDimensions(sourceTexture, 0));
  let pixel = clampPixel(vec2<i32>(input.pos.xy), dimensions);
  let source = textureLoad(sourceTexture, pixel, 0);
  let velocityScale = params.settings.x * params.settings.y;
  let currentVelocity = textureLoad(motionTexture, pixel, 0).xy * velocityScale;
  if (params.display.x > 1.5) { return velocityHeatmap(currentVelocity); }

  let sampleCount = u32(clamp(round(params.settings.w), 1.0, 32.0));
  let currentPixels = length(currentVelocity * params.resolution.xy);
  var velocity = currentVelocity;
  if (params.display.y > 0.5 && currentPixels < 0.5) {
    let tileSize = max(1u, u32(round(params.display.w)));
    let tile = vec2<i32>(vec2<u32>(pixel) / tileSize);
    velocity = textureLoad(neighborMaxTexture, tile, 0).xy * velocityScale;
  }
  velocity = capVelocity(velocity);
  if (sampleCount <= 1u || dot(velocity, velocity) < 0.0000000001) { return source; }

  let reconstruction = params.display.y > 0.5;
  let stationaryReceiver = reconstruction && currentPixels < 0.5;
  let direction = normalize(velocity * params.resolution.xy);
  var accumulated = select(vec4<f32>(0.0), source, stationaryReceiver);
  var totalWeight = select(0.0, 1.0, stationaryReceiver);
  for (var sampleIndex = 0u; sampleIndex < 32u; sampleIndex += 1u) {
    if (sampleIndex >= sampleCount) { break; }
    let t = f32(sampleIndex) / f32(sampleCount - 1u) - 0.5;
    let sampleUv = clamp(input.uv + velocity * t, vec2<f32>(0.0), vec2<f32>(1.0));
    var weight = 1.0;
    if (stationaryReceiver) {
      let samplePixel = clampPixel(vec2<i32>(sampleUv * params.resolution.xy), dimensions);
      let sampleVelocity = textureLoad(motionTexture, samplePixel, 0).xy * velocityScale * params.resolution.xy;
      let sampleMagnitude = length(sampleVelocity);
      let alignment = select(0.0, dot(sampleVelocity / sampleMagnitude, direction), sampleMagnitude > 0.0001);
      let motionContribution = smoothstep(0.5, 1.5, sampleMagnitude);
      weight = motionContribution * smoothstep(0.2, 0.75, alignment) * (1.0 - abs(t) * 0.35);
    }
    accumulated += textureSampleLevel(sourceTexture, linearSampler, sampleUv, 0.0) * weight;
    totalWeight += weight;
  }
  let blurred = select(source, accumulated / totalWeight, totalWeight > 0.000001);
  if (params.display.x > 0.5) {
    let divider = abs(input.uv.x - params.display.z) * params.resolution.x;
    if (divider < 1.0) { return vec4<f32>(0.94, 0.98, 1.0, 1.0); }
    return select(source, blurred, input.uv.x >= params.display.z);
  }
  return blurred;
}

