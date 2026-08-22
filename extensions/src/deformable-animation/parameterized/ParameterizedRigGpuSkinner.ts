import { multiplyMatrix } from './math.js';
import type { RigBonePose, RuntimeMesh } from './runtime-types.js';

export interface RigGpuSkinnerOptions { readonly maxGpuBytes?: number; }
export interface RigGpuSkinnerStats { readonly meshCount: number; readonly bufferCount: number; readonly allocatedBytes: number; readonly generation: number; readonly lost: boolean; readonly disposed: boolean; }
interface MeshSource { readonly positions: Float32Array; readonly offsets: Uint32Array; readonly joints: Uint32Array; readonly weights: Float32Array; readonly boneCount: number; }
interface MeshGpu { readonly source: MeshSource; readonly buffers: readonly GPUBuffer[]; readonly bindGroup: GPUBindGroup; readonly output: GPUBuffer; readonly bytes: number; }

export class ParameterizedRigGpuSkinner {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private readonly meshes = new Map<string, MeshGpu>();
  private readonly sources = new Map<string, MeshSource>();
  private generationValue = 0;
  private lostValue = false;
  private disposedValue = false;
  private readonly maxGpuBytes: number;

  constructor(device: GPUDevice, options: RigGpuSkinnerOptions = {}) {
    this.device = device; this.maxGpuBytes = options.maxGpuBytes ?? 512 * 1024 * 1024; this.validateDevice(device); this.pipeline = this.createPipeline(device); this.watchLoss(device, this.generationValue);
  }

  uploadMesh(id: string, mesh: RuntimeMesh, boneCount: number): GPUBuffer {
    this.assertLive(); if (!id || this.sources.has(id)) throw new Error('E_RIG_GPU_DUPLICATE_MESH');
    const source = Object.freeze({ positions: Float32Array.from(mesh.positions), offsets: Uint32Array.from(mesh.influenceOffsets), joints: Uint32Array.from(mesh.jointIndices), weights: Float32Array.from(mesh.weights), boneCount });
    const candidateBytes = estimateBytes(source); if (this.stats.allocatedBytes + candidateBytes > this.maxGpuBytes) throw new Error('E_RIG_GPU_BUDGET');
    const gpu = this.createMeshGpu(id, source); this.sources.set(id, source); this.meshes.set(id, gpu); return gpu.output;
  }

  skin(id: string, bones: readonly RigBonePose[], encoder: GPUCommandEncoder): GPUBuffer {
    this.assertLive(); const gpu = this.meshes.get(id); if (!gpu || bones.length !== gpu.source.boneCount) throw new Error('E_RIG_GPU_REFERENCE');
    const matrices = new Float32Array(bones.length * 8);
    for (let index = 0; index < bones.length; index++) { const matrix = multiplyMatrix(bones[index]!.world, bones[index]!.inverseBind), offset = index * 8; matrices[offset] = matrix[0]; matrices[offset + 1] = matrix[1]; matrices[offset + 2] = matrix[2]; matrices[offset + 3] = matrix[3]; matrices[offset + 4] = matrix[4]; matrices[offset + 5] = matrix[5]; }
    this.device.queue.writeBuffer(gpu.buffers[4]!, 0, matrices);
    const groups = Math.ceil(gpu.source.positions.length / 2 / 64), maximum = this.device.limits.maxComputeWorkgroupsPerDimension, groupsX = Math.min(groups, maximum), groupsY = Math.ceil(groups / groupsX);
    const pass = encoder.beginComputePass({ label: `ParameterizedRig.skin:${id}` }); pass.setPipeline(this.pipeline); pass.setBindGroup(0, gpu.bindGroup); pass.dispatchWorkgroups(groupsX, groupsY); pass.end(); return gpu.output;
  }

  removeMesh(id: string): void { const gpu = this.meshes.get(id); if (gpu) { destroyGpu(gpu); this.meshes.delete(id); } this.sources.delete(id); }

  notifyDeviceLost(): void { if (this.disposedValue || this.lostValue) return; this.lostValue = true; for (const gpu of this.meshes.values()) destroyGpu(gpu); this.meshes.clear(); }

  recoverDevice(device: GPUDevice, generation = this.generationValue + 1): void {
    if (this.disposedValue) throw new Error('E_RIG_GPU_DISPOSED');
    this.notifyDeviceLost(); this.validateDevice(device); this.device = device; this.pipeline = this.createPipeline(device);
    const rebuilt = new Map<string, MeshGpu>();
    try { for (const [id, source] of this.sources) rebuilt.set(id, this.createMeshGpu(id, source)); }
    catch (error) { for (const gpu of rebuilt.values()) destroyGpu(gpu); throw error; }
    for (const [id, gpu] of rebuilt) this.meshes.set(id, gpu);
    this.generationValue = generation; this.lostValue = false;
    this.watchLoss(device, generation);
  }

  dispose(): void { if (this.disposedValue) return; this.disposedValue = true; for (const gpu of this.meshes.values()) destroyGpu(gpu); this.meshes.clear(); this.sources.clear(); }

  get stats(): RigGpuSkinnerStats { let bytes = 0, buffers = 0; for (const gpu of this.meshes.values()) { bytes += gpu.bytes; buffers += gpu.buffers.length; } return Object.freeze({ meshCount: this.meshes.size, bufferCount: buffers, allocatedBytes: bytes, generation: this.generationValue, lost: this.lostValue, disposed: this.disposedValue }); }

  private createMeshGpu(id: string, source: MeshSource): MeshGpu {
    const maximumBufferSize = Math.min(this.device.limits.maxBufferSize, this.device.limits.maxStorageBufferBindingSize);
    const requiredBufferSizes = [source.positions.byteLength, source.offsets.byteLength, source.joints.byteLength, source.weights.byteLength, source.boneCount * 32, source.positions.byteLength, 16].map(size => Math.max(4, align4(size)));
    if (requiredBufferSizes.some(size => size > maximumBufferSize)) throw new Error('E_RIG_GPU_UNSUPPORTED_LIMITS');
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, created: GPUBuffer[] = [];
    const makeBuffer = (descriptor: GPUBufferDescriptor): GPUBuffer => { const buffer = this.device.createBuffer(descriptor); created.push(buffer); return buffer; };
    const uploaded = (label: string, data: ArrayBufferView, extraUsage = 0): GPUBuffer => { const size = Math.max(4, align4(data.byteLength)), buffer = makeBuffer({ label: `ParameterizedRig.${id}.${label}`, size, usage: usage | extraUsage }); if (data.byteLength > 0) this.device.queue.writeBuffer(buffer, 0, data as ArrayBufferView<ArrayBuffer>); return buffer; };
    try {
      const positions = uploaded('positions', source.positions), offsets = uploaded('offsets', source.offsets), joints = uploaded('joints', source.joints), weights = uploaded('weights', source.weights), matrices = uploaded('matrices', new Float32Array(source.boneCount * 8)), output = makeBuffer({ label: `ParameterizedRig.${id}.output`, size: Math.max(4, align4(source.positions.byteLength)), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.VERTEX });
      const groups = Math.ceil(source.positions.length / 2 / 64), groupsX = Math.min(groups, this.device.limits.maxComputeWorkgroupsPerDimension), params = new Uint32Array([source.positions.length / 2, groupsX, 0, 0]), uniform = makeBuffer({ label: `ParameterizedRig.${id}.params`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); this.device.queue.writeBuffer(uniform, 0, params);
      const buffers = Object.freeze([positions, offsets, joints, weights, matrices, output, uniform]);
      const bindGroup = this.device.createBindGroup({ label: `ParameterizedRig.${id}.bindGroup`, layout: this.pipeline.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      return { source, buffers, bindGroup, output, bytes: buffers.reduce((sum, buffer) => sum + buffer.size, 0) };
    } catch (error) { for (const buffer of created) buffer.destroy(); throw error; }
  }

  private validateDevice(device: GPUDevice): void { if (device.limits.maxStorageBuffersPerShaderStage < 6 || device.limits.maxBufferSize < 16 || device.limits.maxStorageBufferBindingSize < 16 || device.limits.maxUniformBufferBindingSize < 16 || device.limits.maxComputeWorkgroupsPerDimension < 1) throw new Error('E_RIG_GPU_UNSUPPORTED_LIMITS'); }
  private createPipeline(device: GPUDevice): GPUComputePipeline { return device.createComputePipeline({ label: 'ParameterizedRig.skinPipeline', layout: 'auto', compute: { module: device.createShaderModule({ label: 'ParameterizedRig.skinShader', code: PARAMETERIZED_RIG_SKIN_WGSL }), entryPoint: 'main' } }); }
  private watchLoss(device: GPUDevice, generation: number): void { void device.lost.then(() => { if (!this.disposedValue && this.device === device && this.generationValue === generation) this.notifyDeviceLost(); }); }
  private assertLive(): void { if (this.disposedValue) throw new Error('E_RIG_GPU_DISPOSED'); if (this.lostValue) throw new Error('E_RIG_GPU_DEVICE_LOST'); }
}

function estimateBytes(source: MeshSource): number { return align4(source.positions.byteLength) * 2 + align4(source.offsets.byteLength) + align4(source.joints.byteLength) + align4(source.weights.byteLength) + align4(source.boneCount * 32) + 16; }
function destroyGpu(gpu: MeshGpu): void { for (const buffer of gpu.buffers) buffer.destroy(); }
function align4(value: number): number { return (value + 3) & ~3; }

export const PARAMETERIZED_RIG_SKIN_WGSL = /* wgsl */`
struct BoneMatrix { linear: vec4f, translation: vec4f }
struct Params { vertexCount: u32, groupsX: u32, _pad0: u32, _pad1: u32 }
@group(0) @binding(0) var<storage, read> positions: array<vec2f>;
@group(0) @binding(1) var<storage, read> offsets: array<u32>;
@group(0) @binding(2) var<storage, read> joints: array<u32>;
@group(0) @binding(3) var<storage, read> weights: array<f32>;
@group(0) @binding(4) var<storage, read> bones: array<BoneMatrix>;
@group(0) @binding(5) var<storage, read_write> output: array<vec2f>;
@group(0) @binding(6) var<uniform> params: Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let vertex = id.x + id.y * params.groupsX * 64u; if (vertex >= params.vertexCount) { return; }
  let source = positions[vertex]; let start = offsets[vertex]; let end = offsets[vertex + 1u];
  if (start == end) { output[vertex] = source; return; }
  var result = vec2f(0);
  for (var influence = start; influence < end; influence++) {
    let bone = bones[joints[influence]]; let transformed = vec2f(bone.linear.x * source.x + bone.linear.z * source.y + bone.translation.x, bone.linear.y * source.x + bone.linear.w * source.y + bone.translation.y);
    result += transformed * weights[influence];
  }
  output[vertex] = result;
}`;
