struct DeferredSurfaceOutput {
  @location(0) baseMetallic: vec4<f32>,
  @location(1) normalRoughness: vec4<f32>,
  @location(2) emissiveOcclusion: vec4<f32>,
}
@fragment
fn fs_main(input: VertexOutput) -> DeferredSurfaceOutput {
  if (hy_is_clipped(input.worldPos, input.objectIndex)) { discard; }
  let surface = sampleStandardPbrSurface(input);
  return DeferredSurfaceOutput(
    vec4<f32>(surface.base.rgb, surface.metallic),
    vec4<f32>(normalize(surface.normal), surface.roughness),
    vec4<f32>(surface.emissive, surface.occlusion),
  );
}
