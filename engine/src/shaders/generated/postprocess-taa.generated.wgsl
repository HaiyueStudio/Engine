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
@group(0) @binding(3) var historyDepth : texture_2d<f32>;
@group(0) @binding(4) var<uniform> params : TaaParams;
@group(0) @binding(5) var temporalMotion : texture_2d<f32>;

struct TaaOutput {
  @location(0) display : vec4<f32>,
  @location(1) history : vec4<f32>,
  @location(2) depth : f32,
}

struct HistorySample {
  color : vec4<f32>,
  confidence : f32,
}

fn toYCoCg(rgb : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(rgb, vec3<f32>(0.25, 0.5, 0.25)), (rgb.r - rgb.b) * 0.5, dot(rgb, vec3<f32>(-0.25, 0.5, -0.25)));
}

fn fromYCoCg(color : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(color.x + color.y - color.z, color.x + color.z, color.x - color.y - color.z);
}

// Validate each bilinear tap before interpolating; filtering depth across a silhouette
// could otherwise accept a color belonging to a different surface.
fn sampleHistory(uv : vec2<f32>, expectedDepth : f32, dimensions : vec2<i32>) -> HistorySample {
  let location = uv * vec2<f32>(dimensions) - vec2<f32>(0.5);
  let origin = vec2<i32>(floor(location));
  let fraction = fract(location);
  let tolerance = params.depthHistory.x * max(1.0, expectedDepth * 8.0)
    + max(abs(expectedDepth) * 0.0005, 0.00000006); // rgba16float motion-depth quantization
  var color = vec4<f32>(0.0);
  var confidence = 0.0;
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      let pixel = origin + vec2<i32>(x, y);
      let weight = select(1.0 - fraction.x, fraction.x, x == 1) * select(1.0 - fraction.y, fraction.y, y == 1);
      if (all(pixel >= vec2<i32>(0)) && all(pixel < dimensions)) {
        let depth = textureLoad(historyDepth, pixel, 0).r;
        if (abs(depth - expectedDepth) <= tolerance) {
          color += textureLoad(historyColor, pixel, 0) * weight;
          confidence += weight;
        }
      }
    }
  }
  return HistorySample(color / max(confidence, 0.000001), confidence);
}

@fragment
fn fs_main(input : VertexOutput) -> TaaOutput {
  let dimensions = vec2<i32>(textureDimensions(currentColor, 0));
  let pixel = clamp(vec2<i32>(input.pos.xy), vec2<i32>(0), dimensions - vec2<i32>(1));
  let current = textureLoad(currentColor, pixel, 0);
  let depth = textureLoad(currentDepth, pixel, 0).r;
  var closestDepth = depth;
  var motionPixel = pixel;
  let currentYCoCg = toYCoCg(current.rgb);
  var neighborhoodMin = currentYCoCg;
  var neighborhoodMax = currentYCoCg;
  var neighborhoodSum = vec3<f32>(0.0);
  var neighborhoodSquaredSum = vec3<f32>(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let samplePixel = clamp(pixel + vec2<i32>(x, y), vec2<i32>(0), dimensions - vec2<i32>(1));
      let sampleDepth = textureLoad(currentDepth, samplePixel, 0).r;
      if (sampleDepth < closestDepth) {
        closestDepth = sampleDepth;
        motionPixel = samplePixel;
      }
      let color = toYCoCg(textureLoad(currentColor, samplePixel, 0).rgb);
      neighborhoodMin = min(neighborhoodMin, color);
      neighborhoodMax = max(neighborhoodMax, color);
      neighborhoodSum += color;
      neighborhoodSquaredSum += color * color;
    }
  }
  let mean = neighborhoodSum / 9.0;
  let sigma = sqrt(max(neighborhoodSquaredSum / 9.0 - mean * mean, vec3<f32>(0.0)));
  let clipMin = max(neighborhoodMin, mean - sigma * 1.5);
  let clipMax = min(neighborhoodMax, mean + sigma * 1.5);

  // Dilate depth and its corresponding motion together. A subpixel silhouette
  // can change coverage with Halton jitter while still belonging to the same
  // surface history; storing undilated depth would reject it every other frame.
  let motion = textureLoad(temporalMotion, motionPixel, 0);

  // History lives on the stable output grid. Motion already excludes both jitters;
  // subtracting their difference again would lock history to the sample phase.
  var previousUv = input.uv - motion.xy;
  var expectedDepth = motion.z;
  var usable = motion.w > 0.5 && expectedDepth >= 0.0 && expectedDepth <= 1.0;
  if (motion.w == 0.0 && closestDepth >= 0.999999) {
    // Only uncovered far background uses camera reprojection. Missing object
    // history (-1) or an unsupported surface at finite depth must use current color.
    let farDevice = select(1.0, 0.0, params.projection.y > 0.5);
    let clip = vec4<f32>(input.uv.x * 2.0 - 1.0, 1.0 - input.uv.y * 2.0, farDevice, 1.0);
    let worldH = params.currentInverseViewProjection * clip;
    let world = worldH.xyz / select(-max(abs(worldH.w), 0.000001), max(abs(worldH.w), 0.000001), worldH.w >= 0.0);
    var previousClip = params.previousViewProjection * vec4<f32>(world, 1.0);
    if (params.projection.x < 0.5) {
      let nearClip = vec4<f32>(clip.xy, 1.0 - farDevice, 1.0);
      let nearH = params.currentInverseViewProjection * nearClip;
      let nearWorld = nearH.xyz / nearH.w;
      previousClip = params.previousViewProjection * vec4<f32>(world - nearWorld, 0.0);
    }
    if (previousClip.w > 0.000001) {
      let ndc = previousClip.xy / previousClip.w;
      previousUv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) + params.projection.zw;
      expectedDepth = 1.0;
      usable = true;
    }
  }
  var resolved = current.rgb;
  if (params.depthHistory.y > 0.5 && usable && all(previousUv >= vec2<f32>(0.0)) && all(previousUv <= vec2<f32>(1.0))) {
    let history = sampleHistory(previousUv, expectedDepth, dimensions);
    let clipped = clamp(toYCoCg(history.color.rgb), clipMin, clipMax);
    let disagreement = abs(clipped.x - currentYCoCg.x) / max(max(abs(clipped.x), abs(currentYCoCg.x)), 0.05);
    let motionPixels = length(motion.xy * params.resolutionFeedback.xy);
    let feedback = mix(params.resolutionFeedback.z, min(params.resolutionFeedback.z, 0.75), clamp(motionPixels / 16.0, 0.0, 1.0));
    let alphaConfidence = clamp(1.0 - abs(current.a - history.color.a) * 4.0, 0.0, 1.0);
    let weight = feedback * history.confidence * alphaConfidence * (1.0 - clamp(disagreement * 0.5, 0.0, 0.9));
    resolved = mix(current.rgb, fromYCoCg(clipped), weight);
  }
  let sharpened = resolved + (resolved - fromYCoCg(mean)) * params.resolutionFeedback.w;
  var output : TaaOutput;
  output.display = vec4<f32>(max(sharpened, vec3<f32>(0.0)), current.a);
  output.history = vec4<f32>(resolved, current.a);
  output.depth = closestDepth;
  return output;
}

