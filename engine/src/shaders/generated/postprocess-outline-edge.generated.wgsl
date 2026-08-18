// haiyue:builtin-postprocess outline-edge

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

struct OutlineParams {
  visibleEdgeColor : vec4<f32>,
  hiddenEdgeColor : vec4<f32>,
  edgeStrength : f32,
  edgeThickness : f32,
  edgeGlow : f32,
  padding : f32,
}

@group(0) @binding(0) var outlineMask : texture_2d<f32>;
@group(0) @binding(1) var visibleOutlineMask : texture_2d<f32>;
@group(0) @binding(2) var linearSampler : sampler;
@group(0) @binding(3) var<uniform> params : OutlineParams;

fn maskAt(uv : vec2<f32>) -> f32 { return textureSampleLevel(outlineMask, linearSampler, uv, 0.0).r; }
fn visibleAt(uv : vec2<f32>) -> f32 { return textureSampleLevel(visibleOutlineMask, linearSampler, uv, 0.0).r; }

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let dimensions = textureDimensions(outlineMask, 0);
  let texel = vec2<f32>(1.0 / f32(dimensions.x), 1.0 / f32(dimensions.y));
  let radius = max(params.edgeThickness, 1.0);
  let offsetX = vec2<f32>(texel.x * radius, 0.0);
  let offsetY = vec2<f32>(0.0, texel.y * radius);
  let uvRight = clamp(input.uv + offsetX, vec2<f32>(0.0), vec2<f32>(1.0));
  let uvLeft = clamp(input.uv - offsetX, vec2<f32>(0.0), vec2<f32>(1.0));
  let uvUp = clamp(input.uv + offsetY, vec2<f32>(0.0), vec2<f32>(1.0));
  let uvDown = clamp(input.uv - offsetY, vec2<f32>(0.0), vec2<f32>(1.0));
  let gradientX = (maskAt(uvRight) - maskAt(uvLeft)) * 0.5;
  let gradientY = (maskAt(uvUp) - maskAt(uvDown)) * 0.5;
  let weightX = abs(gradientX);
  let weightY = abs(gradientY);
  let visibleX = select(visibleAt(uvLeft), visibleAt(uvRight), gradientX > 0.0);
  let visibleY = select(visibleAt(uvDown), visibleAt(uvUp), gradientY > 0.0);
  let visibility = (visibleX * weightX + visibleY * weightY) / max(weightX + weightY, 0.0001);
  let alpha = clamp(length(vec2<f32>(gradientX, gradientY)) * 2.0, 0.0, 1.0);
  let visibleEdge = alpha * clamp(visibility, 0.0, 1.0);
  let hiddenEdge = alpha * (1.0 - clamp(visibility, 0.0, 1.0));
  return vec4<f32>(visibleEdge, hiddenEdge, 0.0, alpha);
}

