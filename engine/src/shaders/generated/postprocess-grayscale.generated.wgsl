// haiyue:builtin-postprocess grayscale

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

@group(0) @binding(0) var sourceTexture : texture_2d<f32>;
@group(0) @binding(1) var linearSampler : sampler;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(sourceTexture, linearSampler, input.uv);
  let luma = dot(color.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  return vec4<f32>(luma, luma, luma, color.a);
}

