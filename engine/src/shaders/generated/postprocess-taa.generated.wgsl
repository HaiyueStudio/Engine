// haiyue:builtin-postprocess taa

struct VertexOutput {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0,  1.0),
    vec2<f32>(2.0,  1.0),
    vec2<f32>(0.0, -1.0),
  );
  var output : VertexOutput;
  output.pos = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

struct TaaParams {
  currentInverseViewProjection : mat4x4<f32>,
  previousViewProjection : mat4x4<f32>,
  resolutionFeedback : vec4<f32>,
  depthHistory : vec4<f32>,
  projection : vec4<f32>,
}

@group(0) @binding(0) var currentColor : texture_2d<f32>;
@group(0) @binding(1) var historyColor : texture_2d<f32>;
@group(0) @binding(2) var currentDepth : texture_2d<f32>;
@group(0) @binding(3) var linearSampler : sampler;
@group(0) @binding(4) var<uniform> params : TaaParams;

struct TaaOutput {
  @location(0) display : vec4<f32>,
  @location(1) history : vec4<f32>,
}

fn deviceDepthFromLinear(linearDepth : f32) -> f32 {
  let near = params.depthHistory.z;
  let far = params.depthHistory.w;
  var standardDepth = linearDepth;
  if (params.projection.x < 0.5) {
    let viewDepth = near + linearDepth * (far - near);
    standardDepth = (far - near * far / max(viewDepth, near)) / (far - near);
  }
  if (params.projection.y > 0.5) { return 1.0 - standardDepth; }
  return standardDepth;
}

fn linearDepthFromDevice(deviceDepth : f32) -> f32 {
  let near = params.depthHistory.z;
  let far = params.depthHistory.w;
  let standardDepth = select(deviceDepth, 1.0 - deviceDepth, params.projection.y > 0.5);
  if (params.projection.x > 0.5) { return clamp(standardDepth, 0.0, 1.0); }
  let viewDepth = near * far / max(far - standardDepth * (far - near), 0.000001);
  return clamp((viewDepth - near) / (far - near), 0.0, 1.0);
}

fn loadCurrent(pixel : vec2<i32>, dimensions : vec2<i32>) -> vec3<f32> {
  return textureLoad(currentColor, clamp(pixel, vec2<i32>(0), dimensions - vec2<i32>(1)), 0).rgb;
}

@fragment
fn fs_main(input : VertexOutput) -> TaaOutput {
  let dimensions = vec2<i32>(textureDimensions(currentColor, 0));
  let pixel = clamp(vec2<i32>(input.pos.xy), vec2<i32>(0), dimensions - vec2<i32>(1));
  let current = textureLoad(currentColor, pixel, 0);
  let linearDepth = textureLoad(currentDepth, pixel, 0).r;
  var neighborhoodMin = current.rgb;
  var neighborhoodMax = current.rgb;
  var neighborhoodSum = vec3<f32>(0.0);
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let sampleColor = loadCurrent(pixel + vec2<i32>(x, y), dimensions);
      neighborhoodMin = min(neighborhoodMin, sampleColor);
      neighborhoodMax = max(neighborhoodMax, sampleColor);
      neighborhoodSum += sampleColor;
    }
  }
  var resolved = current.rgb;
  if (params.depthHistory.y > 0.5) {
    let clip = vec4<f32>(
      input.uv.x * 2.0 - 1.0,
      1.0 - input.uv.y * 2.0,
      deviceDepthFromLinear(linearDepth),
      1.0,
    );
    let worldHomogeneous = params.currentInverseViewProjection * clip;
    let world = worldHomogeneous.xyz / max(abs(worldHomogeneous.w), 0.000001) * sign(worldHomogeneous.w);
    let previousClip = params.previousViewProjection * vec4<f32>(world, 1.0);
    if (previousClip.w > 0.000001) {
      let previousNdc = previousClip.xyz / previousClip.w;
      let previousUv = vec2<f32>(previousNdc.x * 0.5 + 0.5, 0.5 - previousNdc.y * 0.5);
      let inside = all(previousUv >= vec2<f32>(0.0)) && all(previousUv <= vec2<f32>(1.0));
      if (inside && previousNdc.z >= 0.0 && previousNdc.z <= 1.0) {
        let history = textureSampleLevel(historyColor, linearSampler, previousUv, 0.0);
        let expectedDepth = linearDepthFromDevice(previousNdc.z);
        let depthTolerance = params.depthHistory.x * max(1.0, expectedDepth * 8.0);
        if (abs(history.a - expectedDepth) <= depthTolerance) {
          let clippedHistory = clamp(history.rgb, neighborhoodMin, neighborhoodMax);
          resolved = mix(current.rgb, clippedHistory, params.resolutionFeedback.z);
        }
      }
    }
  }
  let neighborhoodMean = neighborhoodSum / 9.0;
  let displayColor = max(resolved + (resolved - neighborhoodMean) * params.resolutionFeedback.w, vec3<f32>(0.0));
  var output : TaaOutput;
  output.display = vec4<f32>(displayColor, current.a);
  output.history = vec4<f32>(resolved, linearDepth);
  return output;
}

