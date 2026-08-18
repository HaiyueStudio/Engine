// haiyue:builtin-postprocess sobel

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

struct SobelParams {
  edgeColorStrength : vec4<f32>,
  thresholdBlendMode : vec4<f32>,
}

@group(0) @binding(0) var sourceTexture : texture_2d<f32>;
@group(0) @binding(1) var linearSampler : sampler;
@group(0) @binding(2) var<uniform> params : SobelParams;

fn luma(color : vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn sampleLuma(coordinate : vec2<i32>, dimensions : vec2<i32>) -> f32 {
  let pixel = clamp(coordinate, vec2<i32>(0), dimensions - vec2<i32>(1));
  return luma(textureLoad(sourceTexture, pixel, 0).rgb);
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let dimensionsU = textureDimensions(sourceTexture, 0);
  let dimensions = vec2<i32>(i32(dimensionsU.x), i32(dimensionsU.y));
  let coordinate = clamp(vec2<i32>(input.uv * vec2<f32>(dimensionsU)), vec2<i32>(0), dimensions - vec2<i32>(1));
  let topLeft = sampleLuma(coordinate + vec2<i32>(-1, -1), dimensions);
  let topCenter = sampleLuma(coordinate + vec2<i32>(0, -1), dimensions);
  let topRight = sampleLuma(coordinate + vec2<i32>(1, -1), dimensions);
  let middleLeft = sampleLuma(coordinate + vec2<i32>(-1, 0), dimensions);
  let middleRight = sampleLuma(coordinate + vec2<i32>(1, 0), dimensions);
  let bottomLeft = sampleLuma(coordinate + vec2<i32>(-1, 1), dimensions);
  let bottomCenter = sampleLuma(coordinate + vec2<i32>(0, 1), dimensions);
  let bottomRight = sampleLuma(coordinate + vec2<i32>(1, 1), dimensions);
  let gradientX = -topLeft - 2.0 * middleLeft - bottomLeft + topRight + 2.0 * middleRight + bottomRight;
  let gradientY = -topLeft - 2.0 * topCenter - topRight + bottomLeft + 2.0 * bottomCenter + bottomRight;
  let strength = max(params.edgeColorStrength.w, 0.0);
  let threshold = max(params.thresholdBlendMode.x, 0.0);
  let blend = clamp(params.thresholdBlendMode.y, 0.0, 1.0);
  let edgeOnly = params.thresholdBlendMode.z > 0.5;
  let edge = smoothstep(threshold, threshold + 0.12, length(vec2<f32>(gradientX, gradientY)) * strength);
  let edgeColor = params.edgeColorStrength.rgb;
  if (edgeOnly) { return vec4<f32>(edgeColor * edge, 1.0); }
  let base = textureSample(sourceTexture, linearSampler, input.uv);
  return vec4<f32>(mix(base.rgb, edgeColor, edge * blend), base.a);
}

