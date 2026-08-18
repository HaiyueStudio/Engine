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

@group(0) @binding(0) var tileMaxTexture : texture_2d<f32>;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec2<f32> {
  let dimensions = vec2<i32>(textureDimensions(tileMaxTexture, 0));
  let tile = clamp(vec2<i32>(input.pos.xy), vec2<i32>(0), dimensions - vec2<i32>(1));
  var strongest = vec2<f32>(0.0);
  var strongestMagnitude = 0.0;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let candidateTile = clamp(tile + vec2<i32>(x, y), vec2<i32>(0), dimensions - vec2<i32>(1));
      let candidate = textureLoad(tileMaxTexture, candidateTile, 0).xy;
      let magnitude = dot(candidate, candidate);
      if (magnitude > strongestMagnitude) {
        strongest = candidate;
        strongestMagnitude = magnitude;
      }
    }
  }
  return strongest;
}

