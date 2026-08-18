struct DirectionalShadowData {
  lightViewProj : mat4x4<f32>,
  params : vec4<f32>,
}
struct ShadowUniforms {
  shadows : array<DirectionalShadowData, MAX_DIRECTIONAL_SHADOWS>,
}

@group(3) @binding(5) var<uniform> shadow : ShadowUniforms;
@group(3) @binding(6) var shadowTexture : texture_depth_2d_array;
@group(3) @binding(7) var shadowSampler : sampler_comparison;

fn shadowVisibility(shadowIndex: u32, worldPosition: vec3<f32>, normal: vec3<f32>, lightDirection: vec3<f32>) -> f32 {
  if (shadowIndex >= MAX_DIRECTIONAL_SHADOWS) { return 1.0; }
  let shadowData = shadow.shadows[shadowIndex];
  if (shadowData.params.x < 0.5) { return 1.0; }
  let shadowPosition = shadowData.lightViewProj * vec4<f32>(worldPosition, 1.0);
  let projected = shadowPosition.xyz / max(shadowPosition.w, 0.00001);
  let uv = vec2<f32>(projected.x * 0.5 + 0.5, 1.0 - (projected.y * 0.5 + 0.5));
  if (projected.z <= 0.0 || projected.z >= 1.0 || any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return 1.0; }
  let slope = 1.0 - max(dot(normal, lightDirection), 0.0);
  let compareDepth = projected.z - shadowData.params.y - slope * shadowData.params.z;
  let texel = vec2<f32>(shadowData.params.w);
  let layer = i32(shadowData.params.x - 1.0);
  var visibility = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      visibility += textureSampleCompareLevel(
        shadowTexture,
        shadowSampler,
        uv + vec2<f32>(f32(x), f32(y)) * texel,
        layer,
        compareDepth,
      );
    }
  }
  return visibility / 9.0;
}
