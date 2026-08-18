// haiyue:builtin-postprocess fxaa

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

const FXAA_REDUCE_MIN : f32 = 0.0078125;
const FXAA_REDUCE_MUL : f32 = 0.125;
const FXAA_SPAN_MAX : f32 = 8.0;

fn luma(color : vec3<f32>) -> f32 { return dot(color, vec3<f32>(0.299, 0.587, 0.114)); }

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let dimensions = textureDimensions(sourceTexture, 0);
  let reciprocalFrame = vec2<f32>(1.0 / f32(dimensions.x), 1.0 / f32(dimensions.y));
  let uv = input.uv;
  let rgbNW = textureSample(sourceTexture, linearSampler, uv + vec2<f32>(-1.0, -1.0) * reciprocalFrame).rgb;
  let rgbNE = textureSample(sourceTexture, linearSampler, uv + vec2<f32>(1.0, -1.0) * reciprocalFrame).rgb;
  let rgbSW = textureSample(sourceTexture, linearSampler, uv + vec2<f32>(-1.0, 1.0) * reciprocalFrame).rgb;
  let rgbSE = textureSample(sourceTexture, linearSampler, uv + vec2<f32>(1.0, 1.0) * reciprocalFrame).rgb;
  let rgbM = textureSample(sourceTexture, linearSampler, uv).rgb;
  let lumaNW = luma(rgbNW);
  let lumaNE = luma(rgbNE);
  let lumaSW = luma(rgbSW);
  let lumaSE = luma(rgbSE);
  let lumaM = luma(rgbM);
  let lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  let lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
  var direction = vec2<f32>(
    -((lumaNW + lumaNE) - (lumaSW + lumaSE)),
    ((lumaNW + lumaSW) - (lumaNE + lumaSE)),
  );
  let directionReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * (0.25 * FXAA_REDUCE_MUL), FXAA_REDUCE_MIN);
  let reciprocalDirectionMin = 1.0 / (min(abs(direction.x), abs(direction.y)) + directionReduce);
  direction = clamp(direction * reciprocalDirectionMin, vec2<f32>(-FXAA_SPAN_MAX), vec2<f32>(FXAA_SPAN_MAX)) * reciprocalFrame;
  let rgbA = 0.5 * (
    textureSample(sourceTexture, linearSampler, uv + direction * (1.0 / 3.0 - 0.5)).rgb +
    textureSample(sourceTexture, linearSampler, uv + direction * (2.0 / 3.0 - 0.5)).rgb
  );
  let rgbB = rgbA * 0.5 + 0.25 * (
    textureSample(sourceTexture, linearSampler, uv + direction * -0.5).rgb +
    textureSample(sourceTexture, linearSampler, uv + direction * 0.5).rgb
  );
  let lumaB = luma(rgbB);
  if (lumaB < lumaMin || lumaB > lumaMax) { return vec4<f32>(rgbA, 1.0); }
  return vec4<f32>(rgbB, 1.0);
}

