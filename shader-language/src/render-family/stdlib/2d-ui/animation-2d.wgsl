struct CameraUniforms {
  viewProj : mat4x4<f32>,
}

struct ObjectUniforms {
  model : mat4x4<f32>,
  color : vec4<f32>,
  multiplyColor : vec4<f32>,
  screenColor : vec4<f32>,
  params : vec4<f32>, // x: composite layer count, y: output offscreen source
  uvRect : vec4<f32>,
  compositeParams : array<vec4<f32>, 8>, // mode, operation, feather x/y
  compositeExpansion0 : vec4<f32>,
  compositeExpansion1 : vec4<f32>,
  gradientParams : vec4<f32>, // kind, stop count, opacity
  gradientGeometry : vec4<f32>, // start.xy, end.xy
  gradientColors : array<vec4<f32>, 8>,
  gradientOffsets0 : vec4<f32>,
  gradientOffsets1 : vec4<f32>,
  effectKinds0 : vec4<f32>,
  effectKinds1 : vec4<f32>,
  effectData : array<EffectData, 8>,
}

struct EffectData {
  data0 : vec4<f32>,
  data1 : vec4<f32>,
  data2 : vec4<f32>,
  data3 : vec4<f32>,
  data4 : vec4<f32>,
  data5 : vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(1) @binding(0) var<uniform> object : ObjectUniforms;
@group(2) @binding(0) var baseTexture : texture_2d<f32>;
@group(2) @binding(1) var baseSampler : sampler;
@group(3) @binding(0) var compositeTexture0 : texture_2d<f32>;
@group(3) @binding(1) var compositeTexture1 : texture_2d<f32>;
@group(3) @binding(2) var compositeTexture2 : texture_2d<f32>;
@group(3) @binding(3) var compositeTexture3 : texture_2d<f32>;
@group(3) @binding(4) var compositeTexture4 : texture_2d<f32>;
@group(3) @binding(5) var compositeTexture5 : texture_2d<f32>;
@group(3) @binding(6) var compositeTexture6 : texture_2d<f32>;
@group(3) @binding(7) var compositeTexture7 : texture_2d<f32>;
@group(3) @binding(8) var compositeSampler : sampler;

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) uv : vec2<f32>,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) localPosition : vec2<f32>,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  var out : VertexOutput;
  out.clipPos = camera.viewProj * object.model * vec4<f32>(input.position, 0.0, 1.0);
  out.uv = object.uvRect.xy + input.uv * object.uvRect.zw;
  out.localPosition = input.position;
  return out;
}

struct EffectVertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) effectIndex : u32,
}

@vertex
fn vs_effect(@builtin(vertex_index) vertexIndex : u32, @builtin(instance_index) effectIndex : u32) -> EffectVertexOutput {
  let uv = vec2<f32>(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  var out : EffectVertexOutput;
  out.clipPos = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
  out.uv = uv;
  out.effectIndex = effectIndex;
  return out;
}

fn decode_coverage(value : vec4<f32>, mode : f32) -> f32 {
  var coverage = select(value.a, dot(value.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)), mode > 1.5);
  if ((mode > 0.5 && mode < 1.5) || mode > 2.5) { coverage = 1.0 - coverage; }
  return clamp(coverage, 0.0, 1.0);
}

fn filtered_coverage(
  source : texture_2d<f32>,
  uv : vec2<f32>,
  parameters : vec4<f32>,
  expansion : f32,
) -> f32 {
  let dimensions = vec2<f32>(textureDimensions(source));
  let radius = max(vec2<f32>(abs(expansion)), parameters.zw);
  let stepUv = radius / max(dimensions, vec2<f32>(1.0));
  let center = decode_coverage(textureSample(source, compositeSampler, uv), parameters.x);
  if (max(radius.x, radius.y) < 0.001) { return center; }
  let a = decode_coverage(textureSample(source, compositeSampler, uv + vec2<f32>(-stepUv.x, -stepUv.y)), parameters.x);
  let b = decode_coverage(textureSample(source, compositeSampler, uv + vec2<f32>(0.0, -stepUv.y)), parameters.x);
  let c = decode_coverage(textureSample(source, compositeSampler, uv + vec2<f32>(stepUv.x, -stepUv.y)), parameters.x);
  let d = decode_coverage(textureSample(source, compositeSampler, uv + vec2<f32>(-stepUv.x, 0.0)), parameters.x);
  let e = decode_coverage(textureSample(source, compositeSampler, uv + vec2<f32>(stepUv.x, 0.0)), parameters.x);
  let f = decode_coverage(textureSample(source, compositeSampler, uv + vec2<f32>(-stepUv.x, stepUv.y)), parameters.x);
  let g = decode_coverage(textureSample(source, compositeSampler, uv + vec2<f32>(0.0, stepUv.y)), parameters.x);
  let h = decode_coverage(textureSample(source, compositeSampler, uv + vec2<f32>(stepUv.x, stepUv.y)), parameters.x);
  var expanded = center;
  if (expansion > 0.001) { expanded = max(center, max(max(max(a, b), max(c, d)), max(max(e, f), max(g, h)))); }
  if (expansion < -0.001) { expanded = min(center, min(min(min(a, b), min(c, d)), min(min(e, f), min(g, h)))); }
  if (max(parameters.z, parameters.w) < 0.001) { return expanded; }
  let blurred = (center * 2.0 + a + b + c + d + e + f + g + h) / 10.0;
  return mix(expanded, blurred, clamp(max(parameters.z, parameters.w), 0.0, 1.0));
}

fn combine_coverage(current : f32, next : f32, operation : f32) -> f32 {
  if (operation < 0.5) { return current + next * (1.0 - current); }
  if (operation < 1.5) { return max(0.0, current - next); }
  if (operation < 2.5) { return current * next; }
  return abs(current - next);
}

fn gradient_offset(index : i32) -> f32 {
  if (index < 4) { return object.gradientOffsets0[index]; }
  return object.gradientOffsets1[index - 4];
}

fn gradient_color(position : vec2<f32>) -> vec4<f32> {
  let start = object.gradientGeometry.xy;
  let delta = object.gradientGeometry.zw - start;
  var progress = dot(position - start, delta) / max(dot(delta, delta), 1e-6);
  if (object.gradientParams.x > 1.5) { progress = length(position - start) / max(length(delta), 1e-6); }
  progress = clamp(progress, 0.0, 1.0);
  var previousOffset = gradient_offset(0);
  var previousColor = object.gradientColors[0];
  for (var index = 1; index < 8; index++) {
    if (f32(index) >= object.gradientParams.y) { break; }
    let nextOffset = gradient_offset(index);
    let nextColor = object.gradientColors[index];
    if (progress <= nextOffset) {
      let local = clamp((progress - previousOffset) / max(nextOffset - previousOffset, 1e-6), 0.0, 1.0);
      return mix(previousColor, nextColor, local) * vec4<f32>(1.0, 1.0, 1.0, object.gradientParams.z);
    }
    previousOffset = nextOffset;
    previousColor = nextColor;
  }
  return previousColor * vec4<f32>(1.0, 1.0, 1.0, object.gradientParams.z);
}

fn effect_kind(index : u32) -> f32 {
  if (index < 4u) { return object.effectKinds0[index]; }
  return object.effectKinds1[index - 4u];
}

fn unpremultiply(value : vec4<f32>) -> vec4<f32> {
  if (value.a <= 1e-6) { return vec4<f32>(0.0); }
  return vec4<f32>(value.rgb / value.a, value.a);
}

fn apply_color_effect(value : vec4<f32>, index : u32) -> vec4<f32> {
  let kind = effect_kind(index);
  let data = object.effectData[index];
  var color = unpremultiply(value);
  if (kind < 1.5) {
    let luminance = dot(color.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    let tinted = mix(data.data0.xyz, vec3<f32>(data.data0.w, data.data1.x, data.data1.y), luminance);
    color = vec4<f32>(mix(color.rgb, tinted, clamp(data.data1.z, 0.0, 1.0)), color.a);
  } else if (kind < 2.5) {
    color = vec4<f32>(data.data0.rgb, color.a);
    color.a = color.a * data.data0.a * clamp(data.data1.x, 0.0, 1.0);
  } else if (kind < 3.5) {
    color.a = color.a * clamp(data.data0.x, 0.0, 1.0);
  } else if (kind < 4.5) {
    let source = color;
    color = vec4<f32>(
      dot(source, data.data0) + data.data1.x,
      dot(source, vec4<f32>(data.data1.yzw, data.data2.x)) + data.data2.y,
      dot(source, vec4<f32>(data.data2.zw, data.data3.xy)) + data.data3.z,
      dot(source, vec4<f32>(data.data3.w, data.data4.xyz)) + data.data4.w
    );
    color = clamp(color, vec4<f32>(0.0), vec4<f32>(1.0));
  }
  return vec4<f32>(color.rgb * color.a, color.a);
}

fn sample_blurred(uv : vec2<f32>, radius : vec2<f32>) -> vec4<f32> {
  let dimensions = max(vec2<f32>(textureDimensions(baseTexture)), vec2<f32>(1.0));
  let stepUv = radius / dimensions;
  if (max(radius.x, radius.y) < 0.01) { return textureSampleLevel(baseTexture, baseSampler, uv, 0.0); }
  var value = textureSampleLevel(baseTexture, baseSampler, uv, 0.0) * 0.25;
  value += textureSampleLevel(baseTexture, baseSampler, uv + vec2<f32>(-stepUv.x, 0.0), 0.0) * 0.125;
  value += textureSampleLevel(baseTexture, baseSampler, uv + vec2<f32>(stepUv.x, 0.0), 0.0) * 0.125;
  value += textureSampleLevel(baseTexture, baseSampler, uv + vec2<f32>(0.0, -stepUv.y), 0.0) * 0.125;
  value += textureSampleLevel(baseTexture, baseSampler, uv + vec2<f32>(0.0, stepUv.y), 0.0) * 0.125;
  value += textureSampleLevel(baseTexture, baseSampler, uv + vec2<f32>(-stepUv.x, -stepUv.y), 0.0) * 0.0625;
  value += textureSampleLevel(baseTexture, baseSampler, uv + vec2<f32>(stepUv.x, -stepUv.y), 0.0) * 0.0625;
  value += textureSampleLevel(baseTexture, baseSampler, uv + vec2<f32>(-stepUv.x, stepUv.y), 0.0) * 0.0625;
  value += textureSampleLevel(baseTexture, baseSampler, uv + vec2<f32>(stepUv.x, stepUv.y), 0.0) * 0.0625;
  return value;
}

@fragment
fn fs_effect(input : EffectVertexOutput) -> @location(0) vec4<f32> {
  let kind = effect_kind(input.effectIndex);
  let data = object.effectData[input.effectIndex];
  if (kind < 4.5) { return apply_color_effect(textureSampleLevel(baseTexture, baseSampler, input.uv, 0.0), input.effectIndex); }
  if (kind < 5.5) { return sample_blurred(input.uv, max(data.data0.xy, vec2<f32>(0.0))); }
  let dimensions = max(vec2<f32>(textureDimensions(baseTexture)), vec2<f32>(1.0));
  let shadowUv = input.uv - data.data1.yz / dimensions;
  let shadowCoverage = sample_blurred(shadowUv, vec2<f32>(max(data.data1.w, 0.0))).a;
  let shadowAlpha = clamp(shadowCoverage * data.data1.x * data.data0.a, 0.0, 1.0);
  let shadow = vec4<f32>(data.data0.rgb * shadowAlpha, shadowAlpha);
  let foreground = textureSampleLevel(baseTexture, baseSampler, input.uv, 0.0);
  return foreground + shadow * (1.0 - foreground.a);
}

@fragment
fn fs_present(input : EffectVertexOutput) -> @location(0) vec4<f32> {
  return textureSampleLevel(baseTexture, baseSampler, input.uv, 0.0);
}

fn animation_color(input : VertexOutput, premultipliedTexture : bool) -> vec4<f32> {
  var source = textureSample(baseTexture, baseSampler, input.uv);
  var sourcePremultiplied = premultipliedTexture;
  if (object.gradientParams.x > 0.5) {
    source = gradient_color(input.localPosition);
    sourcePremultiplied = false;
  }
  if (!sourcePremultiplied) { source = vec4<f32>(source.rgb * source.a, source.a); }
  // Frozen Cubism drawable-color order. Tint alpha is pose metadata only.
  // Setup-mask rendering skips both RGB operations so mask coverage is tint-independent.
  if (object.params.y < 0.5) {
    source = vec4<f32>(source.rgb * object.multiplyColor.rgb, source.a);
    source = vec4<f32>(source.rgb + object.screenColor.rgb * source.a - source.rgb * object.screenColor.rgb, source.a);
  }
  var coverage = 1.0;
  if (object.params.x > 0.5) {
    let uv = input.clipPos.xy / vec2<f32>(textureDimensions(compositeTexture0));
    coverage = select(0.0, 1.0, object.compositeParams[0].y > 0.5 && object.compositeParams[0].y < 2.5);
    coverage = combine_coverage(coverage, filtered_coverage(compositeTexture0, uv, object.compositeParams[0], object.compositeExpansion0.x), object.compositeParams[0].y);
    if (object.params.x > 1.5) { coverage = combine_coverage(coverage, filtered_coverage(compositeTexture1, uv, object.compositeParams[1], object.compositeExpansion0.y), object.compositeParams[1].y); }
    if (object.params.x > 2.5) { coverage = combine_coverage(coverage, filtered_coverage(compositeTexture2, uv, object.compositeParams[2], object.compositeExpansion0.z), object.compositeParams[2].y); }
    if (object.params.x > 3.5) { coverage = combine_coverage(coverage, filtered_coverage(compositeTexture3, uv, object.compositeParams[3], object.compositeExpansion0.w), object.compositeParams[3].y); }
    if (object.params.x > 4.5) { coverage = combine_coverage(coverage, filtered_coverage(compositeTexture4, uv, object.compositeParams[4], object.compositeExpansion1.x), object.compositeParams[4].y); }
    if (object.params.x > 5.5) { coverage = combine_coverage(coverage, filtered_coverage(compositeTexture5, uv, object.compositeParams[5], object.compositeExpansion1.y), object.compositeParams[5].y); }
    if (object.params.x > 6.5) { coverage = combine_coverage(coverage, filtered_coverage(compositeTexture6, uv, object.compositeParams[6], object.compositeExpansion1.z), object.compositeParams[6].y); }
    if (object.params.x > 7.5) { coverage = combine_coverage(coverage, filtered_coverage(compositeTexture7, uv, object.compositeParams[7], object.compositeExpansion1.w), object.compositeParams[7].y); }
  }
  let alpha = source.a * object.color.a;
  return vec4<f32>(source.rgb * object.color.rgb * object.color.a * coverage, alpha * coverage);
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  return animation_color(input, false);
}

@fragment
fn fs_main_premultiplied_texture(input : VertexOutput) -> @location(0) vec4<f32> {
  return animation_color(input, true);
}
