// haiyue:compute-pass instanced-cull
// haiyue:compute-abi 1
// haiyue:compute-ir 7b4438188507bcc2c60a1e5989b8c1b83c3059e596d32f43f82ca2849c38e22c
// haiyue:compute-module 224edd29cb3a5bf01c487e04e033918d52080c080ac656754d0a633b961894a6
// source: shader-language/builtin-compute-family.json

struct FrustumPlanes { planes: array<vec4<f32>, 6>, };
struct CullingParams {
  instanceCount: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  localSphere: vec4<f32>,
};
struct Counter { value: atomic<u32>, };

@group(0) @binding(0) var<storage, read> transforms: array<mat4x4<f32>>;
@group(0) @binding(1) var<storage, read_write> visible: array<u32>;
@group(0) @binding(2) var<storage, read_write> counter: Counter;
@group(0) @binding(3) var<uniform> frustum: FrustumPlanes;
@group(0) @binding(4) var<uniform> params: CullingParams;

fn sphere_visible(center: vec3<f32>, radius: f32) -> bool {
  for (var i = 0u; i < 6u; i = i + 1u) {
    let p = frustum.planes[i];
    if (dot(p.xyz, center) + p.w < -radius) { return false; }
  }
  return true;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = gid.x;
  if (index >= params.instanceCount) { return; }
  let model = transforms[index];
  let worldCenter4 = model * vec4<f32>(params.localSphere.xyz, 1.0);
  let sx = length(model[0].xyz);
  let sy = length(model[1].xyz);
  let sz = length(model[2].xyz);
  let radius = params.localSphere.w * max(sx, max(sy, sz));
  if (sphere_visible(worldCenter4.xyz, radius)) {
    let writeIndex = atomicAdd(&counter.value, 1u);
    visible[writeIndex] = index;
  }
}
