import type { Geometry3D, Skinning3D } from '../geometry/Geometry3D';
import { alignUp4 } from '../utils/align';
import { RendererCacheMap } from './RendererCacheMap';
import { sharedZeroVectorCache } from './ZeroVectorCache';
import { writeBuffer } from './utils';
import type { LiveIdSet } from './utils';

export interface CurrentDeformationGpuData {
  readonly vertexCount: number;
  readonly morphEnabled: boolean;
  readonly morphSources: readonly (Float32Array | null)[];
  readonly morphBuffers: readonly GPUBuffer[];
  readonly skinning: Skinning3D | null;
  readonly skinJointSource: Float32Array | null;
  readonly skinWeightSource: Float32Array | null;
  readonly skinMatrixSource: Float32Array | null;
  readonly skinJointBuffer: GPUBuffer | null;
  readonly skinWeightBuffer: GPUBuffer | null;
  readonly skinMatrixBuffer: GPUBuffer | null;
  readonly skinBindGroup: GPUBindGroup;
  skinVersion: number;
}

/** Renderer-local resources implementing deformation ABI v1 group 3. */
export class CurrentDeformationGpuCache {
  private readonly cache = new RendererCacheMap<CurrentDeformationGpuData>(data => this.destroyData(data));
  private readonly fallbackMatrixBuffer: GPUBuffer;
  private readonly fallbackAttributeBuffer: GPUBuffer;
  private readonly fallbackBindGroup: GPUBindGroup;

  constructor(
    private readonly device: GPUDevice,
    private readonly skinLayout: GPUBindGroupLayout,
    private readonly label: string,
  ) {
    this.fallbackMatrixBuffer = this.makeStorageBuffer(new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]), 64);
    this.fallbackAttributeBuffer = this.makeStorageBuffer(new Float32Array(4));
    this.fallbackBindGroup = device.createBindGroup({
      label: `${label}.fallbackSkinBindGroup`,
      layout: skinLayout,
      entries: [
        { binding: 0, resource: { buffer: this.fallbackMatrixBuffer } },
        { binding: 1, resource: { buffer: this.fallbackAttributeBuffer } },
        { binding: 2, resource: { buffer: this.fallbackAttributeBuffer } },
      ],
    });
  }

  ensure(geometry: Geometry3D): CurrentDeformationGpuData {
    const morphEnabled = geometry.morphUseGpu && geometry.hasMorphTargets;
    let data = this.cache.get(geometry.id);
    if (!data || !this.matches(data, geometry, morphEnabled)) {
      data = this.createData(geometry, morphEnabled);
      this.cache.set(geometry.id, data);
    }
    const skinning = geometry.skinning;
    if (skinning && data.skinMatrixBuffer && data.skinVersion !== skinning.version) {
      writeBuffer(this.device.queue, data.skinMatrixBuffer, 0, skinning.jointMatrices);
      data.skinVersion = skinning.version;
    }
    return data;
  }

  releaseNotIn(liveGeometries: LiveIdSet): void {
    this.cache.releaseNotIn(liveGeometries);
  }

  destroy(): void {
    this.cache.clear();
    this.fallbackMatrixBuffer.destroy();
    this.fallbackAttributeBuffer.destroy();
  }

  private matches(data: CurrentDeformationGpuData, geometry: Geometry3D, morphEnabled: boolean): boolean {
    if (data.vertexCount !== geometry.vertexCount || data.morphEnabled !== morphEnabled) return false;
    for (let index = 0; index < 4; index++) {
      if (data.morphSources[index] !== (morphEnabled ? geometry.morphTargets[index]?.positions ?? null : null)) return false;
    }
    const skinning = geometry.skinning;
    return data.skinning === skinning
      && data.skinJointSource === (skinning?.joints ?? null)
      && data.skinWeightSource === (skinning?.weights ?? null)
      && data.skinMatrixSource === (skinning?.jointMatrices ?? null);
  }

  private createData(geometry: Geometry3D, morphEnabled: boolean): CurrentDeformationGpuData {
    const morphSources = Array.from({ length: 4 }, (_, index) =>
      morphEnabled ? geometry.morphTargets[index]?.positions ?? null : null);
    const zeroMorph = sharedZeroVectorCache.vec3(geometry.vertexCount);
    let zeroMorphBuffer: GPUBuffer | null = null;
    const morphBuffers = morphSources.map((source, index) => {
      if (!source) {
        zeroMorphBuffer ??= this.makeVertexBuffer(zeroMorph, `${this.label}.zeroMorph`);
        return zeroMorphBuffer;
      }
      return this.makeVertexBuffer(source, `${this.label}.morph${index}`);
    });
    const skinning = geometry.skinning;
    const skinMatrixBuffer = skinning ? this.makeStorageBuffer(skinning.jointMatrices, 64) : null;
    const skinJointBuffer = skinning ? this.makeStorageBuffer(skinning.joints) : null;
    const skinWeightBuffer = skinning ? this.makeStorageBuffer(skinning.weights) : null;
    const skinBindGroup = skinMatrixBuffer && skinJointBuffer && skinWeightBuffer
      ? this.device.createBindGroup({
          label: `${this.label}.skinBindGroup`,
          layout: this.skinLayout,
          entries: [
            { binding: 0, resource: { buffer: skinMatrixBuffer } },
            { binding: 1, resource: { buffer: skinJointBuffer } },
            { binding: 2, resource: { buffer: skinWeightBuffer } },
          ],
        })
      : this.fallbackBindGroup;
    return {
      vertexCount: geometry.vertexCount,
      morphEnabled,
      morphSources,
      morphBuffers,
      skinning,
      skinJointSource: skinning?.joints ?? null,
      skinWeightSource: skinning?.weights ?? null,
      skinMatrixSource: skinning?.jointMatrices ?? null,
      skinJointBuffer,
      skinWeightBuffer,
      skinMatrixBuffer,
      skinBindGroup,
      skinVersion: skinning?.version ?? -1,
    };
  }

  private makeVertexBuffer(data: Float32Array, label: string): GPUBuffer {
    const buffer = this.device.createBuffer({
      label,
      size: Math.max(4, alignUp4(data.byteLength)),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) writeBuffer(this.device.queue, buffer, 0, data);
    return buffer;
  }

  private makeStorageBuffer(data: Float32Array, minimumSize = 16): GPUBuffer {
    const buffer = this.device.createBuffer({
      label: `${this.label}.storage`,
      size: Math.max(minimumSize, alignUp4(data.byteLength)),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) writeBuffer(this.device.queue, buffer, 0, data);
    return buffer;
  }

  private destroyData(data: CurrentDeformationGpuData): void {
    for (const buffer of new Set(data.morphBuffers)) buffer.destroy();
    data.skinJointBuffer?.destroy();
    data.skinWeightBuffer?.destroy();
    data.skinMatrixBuffer?.destroy();
  }
}
