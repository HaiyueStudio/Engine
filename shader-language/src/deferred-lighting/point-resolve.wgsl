// Per-pixel terms shared by every local light. The G02 reference remains the oracle.
struct DeferredPointSurface {
  n: vec3<f32>,
  v: vec3<f32>,
  base: vec3<f32>,
  f0: vec3<f32>,
  nDotV: f32,
  metallic: f32,
  a2: f32,
  k: f32,
  gV: f32,
}
fn deferredPointSurface(n: vec3<f32>, v: vec3<f32>, base: vec3<f32>,
  nDotV: f32, metallic: f32, roughness: f32) -> DeferredPointSurface {
  let a = roughness * roughness;
  let r = roughness + 1.0;
  let k = r * r / 8.0;
  return DeferredPointSurface(n, v, base, mix(vec3<f32>(0.04), base, metallic),
    nDotV, metallic, a * a, k, nDotV / max(nDotV * (1.0 - k) + k, 0.00001));
}
fn deferredPoint(positionRange: vec4<f32>, lightRadiance: vec3<f32>, position: vec3<f32>, s: DeferredPointSurface) -> vec3<f32> {
  let toLight = positionRange.xyz - position;
  let distance = length(toLight);
  let range = max(positionRange.w, 0.0001);
  if (distance >= range) { return vec3<f32>(0.0); }
  let l = toLight / max(distance, 0.0001);
  let nDotL = max(dot(s.n, l), 0.0);
  if (nDotL <= 0.0) { return vec3<f32>(0.0); }
  let h = deferredNormalize(s.v + l);
  let nDotH = max(dot(s.n, h), 0.0);
  let hDotV = max(dot(h, s.v), 0.0);
  let fresnel = pow(clamp(1.0 - hDotV, 0.0, 1.0), 5.0);
  let f = s.f0 + (vec3<f32>(1.0) - s.f0) * fresnel;
  let dielectricF = 0.04 + (1.0 - 0.04) * fresnel;
  let denominator = nDotH * nDotH * (s.a2 - 1.0) + 1.0;
  let d = s.a2 / max(PI * denominator * denominator, 0.00001);
  let g = s.gV * (nDotL / max(nDotL * (1.0 - s.k) + s.k, 0.00001));
  let specular = d * g * f / max(4.0 * s.nDotV * nDotL, 0.0001);
  let kd = vec3<f32>(1.0 - dielectricF) * (1.0 - s.metallic);
  let radiance = lightRadiance * pow(clamp(1.0 - distance / range, 0.0, 1.0), 2.0);
  return (kd * s.base / PI + specular) * radiance * nDotL;
}
