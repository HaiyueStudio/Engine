struct DeferredSurfaceOutput {
  @location(0) baseMetallic: vec4<f32>,
  @location(1) normalRoughness: vec4<f32>,
  @location(2) emissiveOcclusion: vec4<f32>,
}
@fragment
fn fs_main(input: VertexOutput) -> DeferredSurfaceOutput {
  if (hy_is_clipped(input.worldPos, input.objectIndex)) { discard; }
  let surface = sampleStandardPbrSurface(input);
  // Extended opaque PBR keeps its exact geometry/coverage but is lit by full Forward.
  let forwardOnly = material.clearcoatFactors.x > 0.0 || material.clearcoatFactors.w != 1.5
    || any(material.specularFactors != vec4<f32>(1.0)) || (material.clearcoatFlags.y & 3u) != 0u
    || any(material.sheenFactors.rgb != vec3<f32>(0.0)) || (material.clearcoatFlags.z & 3u) != 0u;
  return DeferredSurfaceOutput(
    vec4<f32>(surface.base.rgb, surface.metallic),
    vec4<f32>(normalize(surface.normal), select(surface.roughness, -1.0, forwardOnly)),
    vec4<f32>(surface.emissive, surface.occlusion),
  );
}
