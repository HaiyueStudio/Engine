// haiyue:compute-pass gpu-draw-command
// haiyue:compute-abi 1
// haiyue:compute-ir e8b0c13e681a306ae56b7b2a32209123cc9c3407e75834cf58de590244d53b95
// haiyue:compute-module 224edd29cb3a5bf01c487e04e033918d52080c080ac656754d0a633b961894a6
// source: shader-language/builtin-compute-family.json

struct DrawCommandParams {
  commandCount: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

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
@group(0) @binding(1) var<storage, read_write> indexedIndirect: array<u32>;
@group(0) @binding(2) var<storage, read_write> drawIndirect: array<u32>;
@group(0) @binding(3) var<uniform> params: DrawCommandParams;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let batchIndex = gid.x;
  if (batchIndex >= params.commandCount) { return; }
  let command = commands[batchIndex];
  let indexedBase = batchIndex * 5u;
  indexedIndirect[indexedBase] = command.indexCount;
  indexedIndirect[indexedBase + 1u] = command.instanceCount;
  indexedIndirect[indexedBase + 2u] = 0u;
  indexedIndirect[indexedBase + 3u] = 0u;
  indexedIndirect[indexedBase + 4u] = command.firstInstance;
  let drawBase = batchIndex * 4u;
  drawIndirect[drawBase] = command.vertexCount;
  drawIndirect[drawBase + 1u] = command.instanceCount;
  drawIndirect[drawBase + 2u] = 0u;
  drawIndirect[drawBase + 3u] = command.firstInstance;
}
