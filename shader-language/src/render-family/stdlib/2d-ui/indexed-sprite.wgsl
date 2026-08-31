struct ViewportUniforms {
  size: vec2f,
  _pad: vec2f,
}

struct SpriteInstance {
  position_scale: vec4f,
  size_axis: vec4f,
  uv_rect: vec4f,
  rotation_opacity: vec4f,
  metadata: vec4u,
  tint: vec4f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) local_uv: vec2f,
  @location(1) @interpolate(flat) uv_rect: vec4f,
  @location(2) @interpolate(flat) size_palette_flags: vec4u,
  @location(3) @interpolate(flat) tint_opacity: vec4f,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<storage, read> instances: array<SpriteInstance>;
@group(1) @binding(0) var index_atlas: texture_2d<u32>;
@group(1) @binding(1) var color_atlas: texture_2d<f32>;
@group(1) @binding(2) var palette_bank: texture_2d<f32>;
@group(1) @binding(3) var color_sampler: sampler;

fn corner(vertex_index: u32) -> vec2f {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  return corners[vertex_index];
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32, @builtin(instance_index) instance_index: u32) -> VertexOutput {
  let instance = instances[instance_index];
  let uv = corner(vertex_index);
  var local = uv * instance.size_axis.xy - instance.size_axis.zw;
  if ((instance.metadata.y & 4u) != 0u) { local.x = -local.x; }
  if ((instance.metadata.y & 8u) != 0u) { local.y = -local.y; }
  local *= instance.position_scale.zw;
  let cosine = cos(instance.rotation_opacity.x);
  let sine = sin(instance.rotation_opacity.x);
  let rotated = vec2f(cosine * local.x - sine * local.y, sine * local.x + cosine * local.y);
  let world = instance.position_scale.xy + rotated;
  let ndc = vec2f(world.x / viewport.size.x * 2.0 - 1.0, 1.0 - world.y / viewport.size.y * 2.0);
  var output: VertexOutput;
  output.position = vec4f(ndc, instance.rotation_opacity.y, 1.0);
  output.local_uv = uv;
  output.uv_rect = instance.uv_rect;
  output.size_palette_flags = vec4u(u32(instance.size_axis.x), u32(instance.size_axis.y), instance.metadata.x, instance.metadata.y);
  output.tint_opacity = vec4f(instance.tint.rgb, instance.tint.a * instance.rotation_opacity.z);
  return output;
}

fn palette_color(index: u32, row: u32) -> vec4f {
  let dimensions = textureDimensions(palette_bank);
  return textureLoad(palette_bank, vec2i(i32(min(index, dimensions.x - 1u)), i32(min(row, dimensions.y - 1u))), 0);
}

fn indexed_nearest(input: VertexOutput) -> vec4f {
  let size = input.size_palette_flags.xy;
  let pixel = min(vec2u(input.local_uv * vec2f(size)), size - vec2u(1u));
  let origin = vec2u(input.uv_rect.xy);
  let index = textureLoad(index_atlas, vec2i(origin + pixel), 0).r;
  return palette_color(index, input.size_palette_flags.z);
}

fn indexed_linear(input: VertexOutput) -> vec4f {
  let size = input.size_palette_flags.xy;
  let coordinate = input.local_uv * vec2f(size) - vec2f(0.5);
  let low = vec2i(floor(coordinate));
  let fraction = fract(coordinate);
  let maximum = vec2i(size) - vec2i(1);
  let p00 = clamp(low, vec2i(0), maximum);
  let p10 = clamp(low + vec2i(1, 0), vec2i(0), maximum);
  let p01 = clamp(low + vec2i(0, 1), vec2i(0), maximum);
  let p11 = clamp(low + vec2i(1, 1), vec2i(0), maximum);
  let origin = vec2i(input.uv_rect.xy);
  let row = input.size_palette_flags.z;
  let c00 = palette_color(textureLoad(index_atlas, origin + p00, 0).r, row);
  let c10 = palette_color(textureLoad(index_atlas, origin + p10, 0).r, row);
  let c01 = palette_color(textureLoad(index_atlas, origin + p01, 0).r, row);
  let c11 = palette_color(textureLoad(index_atlas, origin + p11, 0).r, row);
  return mix(mix(c00, c10, fraction.x), mix(c01, c11, fraction.x), fraction.y);
}

fn color_sample(input: VertexOutput) -> vec4f {
  let atlas_size = vec2f(textureDimensions(color_atlas));
  let size = vec2f(input.size_palette_flags.xy);
  let pixel = input.uv_rect.xy + vec2f(0.5) + input.local_uv * max(size - vec2f(1.0), vec2f(0.0));
  return textureSampleLevel(color_atlas, color_sampler, pixel / atlas_size, 0.0);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let flags = input.size_palette_flags.w;
  if ((flags & 1u) != 0u) {
    if ((flags & 2u) != 0u) {
      return indexed_linear(input) * input.tint_opacity;
    }
    return indexed_nearest(input) * input.tint_opacity;
  }
  return color_sample(input) * input.tint_opacity;
}
