// haiyue:builtin-postprocess outline-overlay

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
  blendMode : f32,
}

@group(0) @binding(0) var sourceTexture : texture_2d<f32>;
@group(0) @binding(1) var outlineEdge : texture_2d<f32>;
@group(0) @binding(2) var outlineGlow : texture_2d<f32>;
@group(0) @binding(3) var linearSampler : sampler;
@group(0) @binding(4) var<uniform> params : OutlineParams;
@group(0) @binding(5) var outlineMask : texture_2d<f32>;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let base = textureSampleLevel(sourceTexture, linearSampler, input.uv, 0.0);
  let edge = textureSampleLevel(outlineEdge, linearSampler, input.uv, 0.0);
  let glow = textureSampleLevel(outlineGlow, linearSampler, input.uv, 0.0);
  let selected = textureSampleLevel(outlineMask, linearSampler, input.uv, 0.0).r;
  let outside = 1.0 - smoothstep(0.001, 0.5, selected);
  let visibleAmount = clamp(edge.r + glow.r * outside * params.edgeGlow, 0.0, 1.0);
  let hiddenAmount = clamp(edge.g + glow.g * outside * params.edgeGlow, 0.0, 1.0);
  let visibleWeight = clamp(visibleAmount * params.edgeStrength, 0.0, 1.0);
  let hiddenWeight = clamp(hiddenAmount * params.edgeStrength, 0.0, 1.0);
  var rgb = base.rgb;
  if (params.blendMode < 0.5) {
    rgb += params.visibleEdgeColor.rgb * visibleAmount * params.edgeStrength;
    rgb += params.hiddenEdgeColor.rgb * hiddenAmount * params.edgeStrength;
  } else if (params.blendMode < 1.5) {
    rgb = mix(rgb, params.visibleEdgeColor.rgb, visibleWeight);
    rgb = mix(rgb, params.hiddenEdgeColor.rgb, hiddenWeight);
  } else {
    rgb *= mix(vec3<f32>(1.0), params.visibleEdgeColor.rgb, visibleWeight);
    rgb *= mix(vec3<f32>(1.0), params.hiddenEdgeColor.rgb, hiddenWeight);
  }
  return vec4<f32>(rgb, base.a);
}

