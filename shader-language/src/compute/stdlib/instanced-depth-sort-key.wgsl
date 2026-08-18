struct SortKeyParams {
  instanceCount: u32,
  reverseDepth: u32,
  paddedCount: u32,
  _pad1: u32,
  view: mat4x4<f32>,
};

@group(0) @binding(0) var<storage, read> transforms: array<mat4x4<f32>>;
@group(0) @binding(1) var<storage, read_write> sortKeys: array<u32>;
@group(0) @binding(2) var<storage, read_write> sortIndices: array<u32>;
@group(0) @binding(3) var<uniform> params: SortKeyParams;

fn pack_depth_key(viewZ: f32) -> u32 {
  let depth = clamp(-viewZ * 16.0, 0.0, 65535.0);
  return u32(depth);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = gid.x;
  if (index >= params.paddedCount) { return; }
  if (index >= params.instanceCount) {
    sortKeys[index] = 0xffffffffu;
    sortIndices[index] = 0xffffffffu;
    return;
  }
  let model = transforms[index];
  let worldCenter = vec4<f32>(model[3].xyz, 1.0);
  let viewCenter = params.view * worldCenter;
  let depth = pack_depth_key(viewCenter.z);
  sortKeys[index] = select(depth, 0xffffu - depth, params.reverseDepth != 0u);
  sortIndices[index] = index;
}
