// haiyue:builtin-postprocess gaussian-blur

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
  sigma : f32,
  radius : i32,
  padding : vec2<u32>,
}

@group(0) @binding(0) var sourceTexture : texture_2d<f32>;
@group(0) @binding(1) var linearSampler : sampler;
@group(0) @binding(2) var<uniform> params : BlurParams;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  var color = vec4<f32>(0.0);
  var totalWeight = 0.0;
  let sigmaSquared = params.sigma * params.sigma;
  for (var index = -params.radius; index <= params.radius; index += 1) {
    let offset = params.direction * params.texelSize * f32(index);
    let weight = exp(-0.5 * f32(index * index) / sigmaSquared);
    color += textureSampleLevel(sourceTexture, linearSampler, input.uv + offset, 0.0) * weight;
    totalWeight += weight;
  }
  return color / totalWeight;
}

