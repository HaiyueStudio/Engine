fn sheenDistribution(nDotH: f32, roughness: f32) -> f32 {
  let alphaG = max(roughness * roughness, 0.0001);
  let inverseRoughness = 1.0 / alphaG;
  let sin2H = max(1.0 - nDotH * nDotH, 0.0);
  return (2.0 + inverseRoughness)
    * pow(sin2H, inverseRoughness * 0.5)
    / (2.0 * PI);
}

fn sheenVisibilityL(cosTheta: f32, alphaG: f32) -> f32 {
  let oneMinusAlphaSq = (1.0 - alphaG) * (1.0 - alphaG);
  let a = mix(21.5473, 25.3245, oneMinusAlphaSq);
  let b = mix(3.82987, 3.32435, oneMinusAlphaSq);
  let c = mix(0.19823, 0.16801, oneMinusAlphaSq);
  let d = mix(-1.97760, -1.27393, oneMinusAlphaSq);
  let e = mix(-4.32054, -4.85967, oneMinusAlphaSq);
  return a / (1.0 + b * pow(max(cosTheta, 0.0001), c)) + d * cosTheta + e;
}

fn sheenLambda(cosTheta: f32, alphaG: f32) -> f32 {
  let resolvedCosTheta = clamp(abs(cosTheta), 0.0001, 1.0);
  if (resolvedCosTheta < 0.5) {
    return exp(sheenVisibilityL(resolvedCosTheta, alphaG));
  }
  return exp(
    2.0 * sheenVisibilityL(0.5, alphaG)
      - sheenVisibilityL(1.0 - resolvedCosTheta, alphaG),
  );
}

fn sheenVisibility(nDotV: f32, nDotL: f32, roughness: f32) -> f32 {
  let alphaG = max(roughness * roughness, 0.0001);
  let denominator = (
    1.0
      + sheenLambda(nDotV, alphaG)
      + sheenLambda(nDotL, alphaG)
  ) * 4.0 * max(nDotV, 0.0001) * max(nDotL, 0.0001);
  return 1.0 / max(denominator, 0.0001);
}

fn sheenDirectBrdf(
  nDotV: f32,
  nDotL: f32,
  nDotH: f32,
  roughness: f32,
) -> f32 {
  return sheenDistribution(nDotH, roughness)
    * sheenVisibility(nDotV, nDotL, roughness);
}

// Analytic approximation of the Charlie directional albedo lookup. This keeps
// the layer energy-bounded without adding another sampled texture to the
// already binding-dense PBR pipeline.
fn sheenDirectionalAlbedo(nDotV: f32, roughness: f32) -> f32 {
  let grazing = pow(1.0 - clamp(nDotV, 0.0, 1.0), 1.0 + roughness * 2.0);
  return clamp(mix(0.25, 0.75, grazing) * (1.0 - 0.35 * roughness), 0.0, 1.0);
}

fn sheenMaxColor(color: vec3<f32>) -> f32 {
  return max(color.x, max(color.y, color.z));
}

fn sheenDirectBaseAttenuation(
  color: vec3<f32>,
  nDotV: f32,
  nDotL: f32,
  roughness: f32,
) -> f32 {
  let strength = sheenMaxColor(color);
  let viewAttenuation = 1.0 - strength * sheenDirectionalAlbedo(nDotV, roughness);
  let lightAttenuation = 1.0 - strength * sheenDirectionalAlbedo(nDotL, roughness);
  return clamp(min(viewAttenuation, lightAttenuation), 0.0, 1.0);
}

fn sheenIblBaseAttenuation(color: vec3<f32>, nDotV: f32, roughness: f32) -> f32 {
  return clamp(
    1.0 - sheenMaxColor(color) * sheenDirectionalAlbedo(nDotV, roughness),
    0.0,
    1.0,
  );
}
