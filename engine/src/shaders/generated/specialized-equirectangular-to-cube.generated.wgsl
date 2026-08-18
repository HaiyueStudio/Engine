// haiyue:specialized-rendering-pass equirectangular-to-cube
// haiyue:specialized-rendering-abi 1
// haiyue:specialized-rendering-module e58254ced41b58d62be3b93804a7633bcaa270d03d1064a773f62a4db8af1e3d
// source: shader-language/builtin-specialized-rendering-family.json

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) @interpolate(flat) faceIndex: u32,
}

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) faceIndex: u32,
) -> VertexOutput {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0),
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  output.faceIndex = faceIndex;
  return output;
}

fn cubeDirection(face: u32, uv: vec2<f32>) -> vec3<f32> {
  let u = uv.x * 2.0 - 1.0;
  let v = uv.y * 2.0 - 1.0;
  switch face {
    case 0u: { return normalize(vec3<f32>( 1.0, -v, -u)); }
    case 1u: { return normalize(vec3<f32>(-1.0, -v,  u)); }
    case 2u: { return normalize(vec3<f32>( u,  1.0,  v)); }
    case 3u: { return normalize(vec3<f32>( u, -1.0, -v)); }
    case 4u: { return normalize(vec3<f32>( u, -v,  1.0)); }
    default: { return normalize(vec3<f32>(-u, -v, -1.0)); }
  }
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let direction = cubeDirection(input.faceIndex, input.uv);
  let longitude = atan2(direction.z, direction.x);
  let latitude = acos(clamp(direction.y, -1.0, 1.0));
  let uv = vec2<f32>(longitude * 0.15915494309189535 + 0.5, latitude * 0.3183098861837907);
  return textureSampleLevel(sourceTexture, sourceSampler, uv, 0.0);
}
