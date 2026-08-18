// haiyue:builtin-postprocess outline-blur

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

struct BlurParams {
  direction : vec2<f32>,
  texelSize : vec2<f32>,
  radius : f32,
  padding0 : f32,
  padding1 : f32,
  padding2 : f32,
}

@group(0) @binding(0) var outlineColor : texture_2d<f32>;
@group(0) @binding(1) var linearSampler : sampler;
@group(0) @binding(2) var<uniform> params : BlurParams;

fn gaussianPdf(value : f32, sigma : f32) -> f32 {
  return 0.39894 * exp(-0.5 * value * value / (sigma * sigma)) / sigma;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let radius = clamp(params.radius, 1.0, 12.0);
  let sigma = max(radius * 0.5, 0.0001);
  var sum = textureSampleLevel(outlineColor, linearSampler, input.uv, 0.0) * gaussianPdf(0.0, sigma);
  var weightSum = gaussianPdf(0.0, sigma);
  for (var index = 1; index <= 12; index += 1) {
    let distance = f32(index);
    if (distance <= radius) {
      let weight = gaussianPdf(distance, sigma);
      let offset = params.direction * params.texelSize * distance;
      sum += textureSampleLevel(outlineColor, linearSampler, input.uv + offset, 0.0) * weight;
      sum += textureSampleLevel(outlineColor, linearSampler, input.uv - offset, 0.0) * weight;
      weightSum += 2.0 * weight;
    }
  }
  return sum / weightSum;
}

