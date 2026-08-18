struct CullParams { commandCount: u32, _pad0: u32, _pad1: u32, _pad2: u32, };
struct FrustumPlanes { planes: array<vec4<f32>, 6>, };
struct BatchCommand {
  entityId: u32,
  geometryId: u32,
  materialId: u32,
  instanceCount: u32,
  indexCount: u32,
  vertexCount: u32,
  sortKey: u32,
  flags: u32,
  firstInstance: u32,
};

@group(0) @binding(0) var<storage, read> commands: array<BatchCommand>;
@group(0) @binding(1) var<storage, read> bounds: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> indexedIndirect: array<u32>;
@group(0) @binding(3) var<storage, read_write> drawIndirect: array<u32>;
@group(0) @binding(4) var<uniform> frustum: FrustumPlanes;
@group(0) @binding(5) var<uniform> params: CullParams;

fn sphere_visible(sphere: vec4<f32>) -> bool {
  for (var i = 0u; i < 6u; i = i + 1u) {
    let plane = frustum.planes[i];
    if (dot(plane.xyz, sphere.xyz) + plane.w < -sphere.w) { return false; }
  }
  return true;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let batchIndex = gid.x;
  if (batchIndex >= params.commandCount) { return; }
  let command = commands[batchIndex];
  let instanceCount = select(0u, command.instanceCount, sphere_visible(bounds[batchIndex]));
  indexedIndirect[batchIndex * 5u + 1u] = instanceCount;
  drawIndirect[batchIndex * 4u + 1u] = instanceCount;
}
