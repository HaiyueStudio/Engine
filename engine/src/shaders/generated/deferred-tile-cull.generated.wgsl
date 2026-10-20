struct DeferredSourceHeader {
  abiVersion: u32,
  sourceGeneration: u32,
  pointCount: u32,
  directionalCount: u32,
}

struct DeferredLightRecord {
  positionRange: vec4<f32>,
  radiance: vec4<f32>,
  direction: vec4<f32>,
  identity: vec4<u32>,
}

struct DeferredViewHeader {
  sourceGeneration: u32,
  pointCount: u32,
  directionalCount: u32,
  flags: u32,
  ambientRadiance: vec4<f32>,
}


struct FogUniforms {
  color : vec4<f32>,
  distanceParams : vec4<f32>,
  heightParams : vec4<f32>,
}
struct SceneFrameUniforms {
  viewProjection : mat4x4<f32>,
  view : mat4x4<f32>,
  inverseViewProjection : mat4x4<f32>,
  eyePosition : vec4<f32>,
  viewport : vec4<f32>,
  fog : FogUniforms,
}


const TILE_SIZE: u32 = 16u;
const TILE_WORKGROUP_SIZE: u32 = 64u;
const TILE_CAPACITY: u32 = 128u;
const TILE_HEADER_WORDS: u32 = 4u;
const TILE_STRIDE_WORDS: u32 = 132u;
struct DeferredTileParameters { grid: vec4<u32>, viewport: vec4<f32>, }

struct DeferredSource {
  header: DeferredSourceHeader,
  records: array<DeferredLightRecord>,
}
@group(0) @binding(0) var<uniform> sceneFrame: SceneFrameUniforms;
@group(3) @binding(0) var<storage, read> source: DeferredSource;
@group(3) @binding(1) var<uniform> lightView: DeferredViewHeader;
@group(3) @binding(2) var<storage, read> pointIndices: array<u32>;
@group(3) @binding(15) var<storage, read_write> tileWords: array<u32>;
@group(3) @binding(16) var<uniform> tileParameters: DeferredTileParameters;

var<workgroup> prefix: array<u32, TILE_WORKGROUP_SIZE>;
var<workgroup> accepted: u32;

// Plane is expressed in world space. Scaling the normal also scales the sphere radius.
// The margin includes cancellation in large world coordinates and f32 matrix products.
fn tileOutsidePlane(plane: vec4<f32>, sphere: vec4<f32>) -> bool {
  let center = vec4<f32>(sphere.xyz, 1.0);
  let radius = max(sphere.w, 0.0001) * length(plane.xyz);
  let margin = 0.00001 * (dot(abs(plane), abs(center)) + radius + 1.0);
  return dot(plane, center) < -radius - margin;
}

fn tileIntersects(sphere: vec4<f32>, tile: vec2<u32>) -> bool {
  let lo = vec2<f32>(tile * TILE_SIZE) / tileParameters.viewport.zw;
  let hi = min(vec2<f32>((tile + vec2<u32>(1u)) * TILE_SIZE), tileParameters.viewport.zw) / tileParameters.viewport.zw;
  let left = 2.0 * lo.x - 1.0;
  let right = 2.0 * hi.x - 1.0;
  let top = 1.0 - 2.0 * lo.y;
  let bottom = 1.0 - 2.0 * hi.y;
  let m = transpose(sceneFrame.viewProjection);
  return !(tileOutsidePlane(m[0] - left * m[3], sphere)
    || tileOutsidePlane(right * m[3] - m[0], sphere)
    || tileOutsidePlane(m[1] - bottom * m[3], sphere)
    || tileOutsidePlane(top * m[3] - m[1], sphere)
    || tileOutsidePlane(m[2], sphere)
    || tileOutsidePlane(m[3] - m[2], sphere));
}

@compute @workgroup_size(TILE_WORKGROUP_SIZE)
fn cs_main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let tile = group.y * tileParameters.grid.x + group.x;
  let base = tile * TILE_STRIDE_WORDS;
  // Missing whole records are detected by resolve and use the complete view list.
  if (group.x >= tileParameters.grid.x || group.y >= tileParameters.grid.y
    || tile >= tileParameters.grid.w || tile >= arrayLength(&tileWords) / TILE_STRIDE_WORDS) { return; }
  if (lane == 0u) {
    accepted = 0u;
    tileWords[base] = base + TILE_HEADER_WORDS;
    tileWords[base + 1u] = 0u;
    tileWords[base + 2u] = 1u;
    tileWords[base + 3u] = 0u;
  }
  workgroupBarrier();
  if (source.header.abiVersion != 1u || source.header.sourceGeneration != lightView.sourceGeneration
    || lightView.directionalCount != source.header.directionalCount
    || lightView.pointCount > arrayLength(&pointIndices)
    || source.header.directionalCount + source.header.pointCount > arrayLength(&source.records)) { return; }
  for (var batch = 0u; batch < lightView.pointCount; batch += TILE_WORKGROUP_SIZE) {
    let index = batch + lane;
    var hit = 0u;
    var local = 0u;
    if (index < lightView.pointCount) {
      local = pointIndices[index];
      if (local < source.header.pointCount) {
        hit = select(0u, 1u, tileIntersects(source.records[source.header.directionalCount + local].positionRange, group.xy));
      }
    }
    prefix[lane] = hit;
    workgroupBarrier();
    // Stable scan: tiled accumulation retains the original source order.
    for (var step = 1u; step < TILE_WORKGROUP_SIZE; step *= 2u) {
      var preceding = 0u;
      if (lane >= step) { preceding = prefix[lane - step]; }
      workgroupBarrier();
      prefix[lane] += preceding;
      workgroupBarrier();
    }
    let destination = accepted + prefix[lane];
    if (hit != 0u && destination <= min(tileParameters.grid.z, TILE_CAPACITY)) {
      tileWords[base + TILE_HEADER_WORDS + destination - 1u] = local;
    }
    workgroupBarrier();
    if (lane == 0u) { accepted += prefix[TILE_WORKGROUP_SIZE - 1u]; }
    workgroupBarrier();
  }
  if (lane == 0u) {
    tileWords[base + 1u] = accepted;
    tileWords[base + 2u] = select(0u, 1u, accepted > min(tileParameters.grid.z, TILE_CAPACITY));
  }
}
