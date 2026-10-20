@group(3) @binding(15) var<storage, read> tileWords: array<u32>;
@group(3) @binding(16) var<uniform> tileParameters: DeferredTileParameters;

// Return (word offset, count, full-list fallback). Never add a stored prefix to fallback.
fn deferredTileRange(pixel: vec2<f32>) -> vec3<u32> {
  let tileXY = vec2<u32>(max(pixel - tileParameters.viewport.xy, vec2<f32>(0.0))) / TILE_SIZE;
  let tile = tileXY.y * tileParameters.grid.x + tileXY.x;
  let base = tile * TILE_STRIDE_WORDS;
  if (any(tileXY >= tileParameters.grid.xy) || tile >= tileParameters.grid.w
    || tile >= arrayLength(&tileWords) / TILE_STRIDE_WORDS) {
    return vec3<u32>(0u, lightView.pointCount, 1u);
  }
  let offset = tileWords[base];
  let count = tileWords[base + 1u];
  if (tileWords[base + 2u] != 0u || count > min(tileParameters.grid.z, TILE_CAPACITY)
    || offset != base + TILE_HEADER_WORDS) {
    return vec3<u32>(0u, lightView.pointCount, 1u);
  }
  return vec3<u32>(offset, count, 0u);
}
