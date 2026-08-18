const PI : f32 = 3.14159265359;

fn distributionGGX(nDotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 0.00001);
}

fn geometrySchlickGGX(nDotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return nDotV / max(nDotV * (1.0 - k) + k, 0.00001);
}

fn geometrySmith(nDotV: f32, nDotL: f32, roughness: f32) -> f32 {
  return geometrySchlickGGX(nDotV, roughness) * geometrySchlickGGX(nDotL, roughness);
}

fn fresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickF90(cosTheta: f32, f0: vec3<f32>, f90: vec3<f32>) -> vec3<f32> {
  return f0 + (f90 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickRoughness(cosTheta: f32, f0: vec3<f32>, roughness: f32) -> vec3<f32> {
  return f0 + (max(vec3<f32>(1.0 - roughness), f0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickRoughnessF90(
  cosTheta: f32,
  f0: vec3<f32>,
  f90: vec3<f32>,
  roughness: f32,
) -> vec3<f32> {
  let roughF90 = max(f90 * (1.0 - roughness), f0);
  return f0 + (roughF90 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}
