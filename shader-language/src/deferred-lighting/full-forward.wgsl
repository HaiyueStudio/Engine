// ADR 0109: one shared source, complete per-view indices, no opaque tile filtering.
struct FullForwardSource {
  header: DeferredSourceHeader,
  records: array<DeferredLightRecord>,
}
@group(3) @binding(12) var<storage, read> fullLightSource: FullForwardSource;
@group(3) @binding(13) var<uniform> fullLightView: DeferredViewHeader;
@group(3) @binding(14) var<storage, read> fullPointIndices: array<u32>;

fn fullForwardLightCount() -> u32 {
  if (fullLightSource.header.abiVersion != 1u
    || fullLightSource.header.sourceGeneration != fullLightView.sourceGeneration
    || fullLightView.directionalCount > fullLightSource.header.directionalCount
    || fullLightView.pointCount > fullLightSource.header.pointCount
    || fullLightView.pointCount > arrayLength(&fullPointIndices)
    || fullLightSource.header.directionalCount > arrayLength(&fullLightSource.records)
    || fullLightSource.header.pointCount > arrayLength(&fullLightSource.records) - fullLightSource.header.directionalCount) {
    return 0u;
  }
  // The single ambient record preserves the original layered BRDF's ambient semantics.
  return fullLightView.directionalCount + 1u + fullLightView.pointCount;
}

fn fullForwardLight(index: u32) -> LightData {
  if (index == fullLightView.directionalCount) {
    return LightData(vec4<u32>(0u), vec4<f32>(fullLightView.ambientRadiance.rgb, 1.0), vec4<f32>(0.0), vec4<f32>(0.0));
  }
  var recordIndex = index;
  if (index > fullLightView.directionalCount) {
    let pointIndex = fullPointIndices[index - fullLightView.directionalCount - 1u];
    if (pointIndex >= fullLightSource.header.pointCount) {
      return LightData(vec4<u32>(0u), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
    }
    recordIndex = fullLightSource.header.directionalCount + pointIndex;
  }
  let light = fullLightSource.records[recordIndex];
  // Source radiance already includes intensity; identity.z is the shadow slot, not loop index.
  return LightData(light.identity, vec4<f32>(light.radiance.rgb, 1.0), light.direction, light.positionRange);
}

// Opaque draws borrow the otherwise unused scene-color binding for G1's proxy mask.
// This preserves the baseline 16 sampled-texture limit. Transparent/transmission draws
// retain the original scene-color binding and never consume the proxy mask.
fn fullForwardOpaqueVisible(position: vec4<f32>) -> bool {
  if (material.flags.w == 2u || TRANSMISSION_ENABLED) { return true; }
  return textureLoad(transmissionFramebuffer, vec2<i32>(position.xy), 0).a < 0.0;
}
