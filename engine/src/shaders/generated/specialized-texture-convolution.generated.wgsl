// haiyue:specialized-rendering-pass texture-convolution
// haiyue:specialized-rendering-abi 1
// haiyue:specialized-rendering-module e58254ced41b58d62be3b93804a7633bcaa270d03d1064a773f62a4db8af1e3d
// source: shader-language/builtin-specialized-rendering-family.json

struct Params {
  kernel0 : vec4<f32>,
  kernel1 : vec4<f32>,
  kernel2 : vec4<f32>,
  size    : vec2<u32>,
  _pad    : vec2<u32>,
}

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var dstTex : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params : Params;

fn kernelValue(index: u32) -> f32 {
  if (index < 4u) { return params.kernel0[index]; }
  if (index < 8u) { return params.kernel1[index - 4u]; }
  return params.kernel2[index - 8u];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.size.x || gid.y >= params.size.y) { return; }
  var color = vec4<f32>(0.0);
  var index = 0u;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let sx = clamp(i32(gid.x) + x, 0, i32(params.size.x) - 1);
      let sy = clamp(i32(gid.y) + y, 0, i32(params.size.y) - 1);
      color += textureLoad(srcTex, vec2<i32>(sx, sy), 0) * kernelValue(index);
      index = index + 1u;
    }
  }
  textureStore(dstTex, vec2<i32>(gid.xy), vec4<f32>(color.rgb, 1.0));
}
