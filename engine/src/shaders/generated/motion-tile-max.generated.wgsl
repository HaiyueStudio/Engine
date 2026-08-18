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

struct MotionTileMaxParams {
  sourceSize : vec2<u32>,
  tileSize : u32,
  padding : u32,
}

@group(0) @binding(0) var motionTexture : texture_2d<f32>;
@group(0) @binding(1) var<uniform> params : MotionTileMaxParams;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec2<f32> {
  let tile = vec2<u32>(input.pos.xy);
  let origin = tile * params.tileSize;
  var strongest = vec2<f32>(0.0);
  var strongestMagnitude = 0.0;
  for (var y = 0u; y < 8u; y += 1u) {
    for (var x = 0u; x < 8u; x += 1u) {
      if (x >= params.tileSize || y >= params.tileSize) { continue; }
      let sourcePixel = origin + vec2<u32>(x, y);
      if (sourcePixel.x >= params.sourceSize.x || sourcePixel.y >= params.sourceSize.y) { continue; }
      let candidate = textureLoad(motionTexture, vec2<i32>(sourcePixel), 0).xy;
      let magnitude = dot(candidate, candidate);
      if (magnitude > strongestMagnitude) {
        strongest = candidate;
        strongestMagnitude = magnitude;
      }
    }
  }
  return strongest;
}

