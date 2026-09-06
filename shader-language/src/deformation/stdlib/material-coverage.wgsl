// Prefix of the forward PBR material ABI. Borrowing the same buffer and texture
// keeps readiness, factor alpha, cutoff, UV selection and transforms identical.
struct CoverageMaterial {
  baseColor : vec4<f32>,
  emissiveAndNormalScale : vec4<f32>,
  surfaceAndCutoff : vec4<f32>,
  flags : vec4<u32>,
  extensions : array<vec4<f32>, 6>,
  baseMapping0 : vec4<f32>,
  baseMapping1 : vec4<f32>,
}
@group(2) @binding(1) var<uniform> coverage : CoverageMaterial;
@group(2) @binding(2) var coverageTexture : texture_2d<f32>;
@group(2) @binding(3) var coverageSampler : sampler;

fn hy_has_material_coverage(uv0: vec2<f32>, uv1: vec2<f32>) -> bool {
  if (coverage.flags.w != 1u) { return true; }
  var alpha = coverage.baseColor.a;
  if (coverage.flags.x != 0u) {
    let uv = select(uv0, uv1, coverage.baseMapping0.w > 0.5);
    let mapped = vec2<f32>(dot(coverage.baseMapping0.xy, uv) + coverage.baseMapping0.z,
      dot(coverage.baseMapping1.xy, uv) + coverage.baseMapping1.z);
    alpha *= textureSample(coverageTexture, coverageSampler, mapped).a;
  }
  return alpha >= coverage.surfaceAndCutoff.w;
}
