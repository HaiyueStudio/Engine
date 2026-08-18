fn clearcoatFresnel(cosTheta : f32) -> f32 {
  return 0.04 + 0.96 * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn clearcoatDirectBrdf(
  nDotV : f32,
  nDotL : f32,
  nDotH : f32,
  hDotV : f32,
  roughness : f32,
) -> f32 {
  let resolvedRoughness = clamp(roughness, 0.04, 1.0);
  let d = distributionGGX(nDotH, resolvedRoughness);
  let g = geometrySmith(nDotV, nDotL, resolvedRoughness);
  let f = clearcoatFresnel(hDotV);
  return (d * g * f) / max(4.0 * nDotV * nDotL, 0.0001);
}

fn clearcoatBaseAttenuation(fresnel : f32, factor : f32) -> f32 {
  return clamp(1.0 - clamp(factor, 0.0, 1.0) * fresnel, 0.0, 1.0);
}
