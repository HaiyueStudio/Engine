import type { Geometry3D, MorphTarget3D, Skinning3D } from '../geometry/Geometry3D';
import { alignUp4 } from '../utils/align';
import { RendererCacheMap } from './RendererCacheMap';
import { writeBuffer } from './utils';
import type { LiveIdSet } from './utils';

export interface PbrDeformationGpuData {
  readonly vertexCount: number;
  readonly morphEnabled: boolean;
  readonly morphPositionSources: readonly (Float32Array | null)[];
  readonly morphNormalSources: readonly (Float32Array | null)[];
  readonly morphBuffers: GPUBuffer[];
  readonly skinning: Skinning3D | null;
  readonly skinJointSource: Float32Array | null;
  readonly skinWeightSource: Float32Array | null;
  readonly skinMatrixSource: Float32Array | null;
  readonly skinJointBuffer: GPUBuffer | null;
  readonly skinWeightBuffer: GPUBuffer | null;
  readonly skinMatrixBuffer: GPUBuffer | null;
  skinBindGroup: GPUBindGroup;
  skinVersion: number;
  sceneBindingRevision: number;
}

export interface PbrDeformationGpuCacheOptions {
  readonly device: GPUDevice;
  readonly getSceneBindingRevision: () => number;
  readonly getFallbackSceneBindGroup: () => GPUBindGroup;
  readonly createSceneBindGroup: (
    skinMatrices: GPUBuffer,
    skinJoints: GPUBuffer,
    skinWeights: GPUBuffer,
  ) => GPUBindGroup;
}

/**
 * Owns every PBR morph/skinning GPU allocation.
 *
 * Geometry identity and source-array identity decide allocation reuse, while
 * Skinning3D.version decides matrix uploads. This keeps camera/view changes
 * from re-uploading unchanged joint matrices and gives device recovery one
 * deterministic resource owner to dispose and recreate.
 */
export class PbrDeformationGpuCache {
  readonly fallbackSkinMatrixBuffer: GPUBuffer;
  readonly fallbackSkinJointBuffer: GPUBuffer;
  readonly fallbackSkinWeightBuffer: GPUBuffer;

  private readonly _entries = new RendererCacheMap<PbrDeformationGpuData>(data => this._destroyEntry(data));

  constructor(private readonly _options: PbrDeformationGpuCacheOptions) {
    const identity = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    this.fallbackSkinMatrixBuffer = this._makeStorageBuffer(identity, 'PbrRenderer.fallbackSkinMatrices', 64);
    this.fallbackSkinJointBuffer = this._makeStorageBuffer(new Float32Array(4), 'PbrRenderer.fallbackSkinJoints');
    this.fallbackSkinWeightBuffer = this._makeStorageBuffer(new Float32Array(4), 'PbrRenderer.fallbackSkinWeights');
  }

  ensure(geometry: Geometry3D): PbrDeformationGpuData {
    const morphEnabled = geometry.morphUseGpu && geometry.hasMorphTargets;
    let data = this._entries.get(geometry.id);
    if (!data || !this._matches(data, geometry, morphEnabled)) {
      data = this._createEntry(geometry, morphEnabled);
      this._entries.set(geometry.id, data);
    }
    this._syncSkinningMatrices(geometry, data);
    return data;
  }

  getSceneBindGroup(data: PbrDeformationGpuData): GPUBindGroup {
    const revision = this._options.getSceneBindingRevision();
    if (data.sceneBindingRevision === revision) return data.skinBindGroup;
    data.skinBindGroup = data.skinMatrixBuffer && data.skinJointBuffer && data.skinWeightBuffer
      ? this._options.createSceneBindGroup(data.skinMatrixBuffer, data.skinJointBuffer, data.skinWeightBuffer)
      : this._options.getFallbackSceneBindGroup();
    data.sceneBindingRevision = revision;
    return data.skinBindGroup;
  }

  releaseNotIn(live: LiveIdSet): void {
    this._entries.releaseNotIn(live);
  }

  destroy(): void {
    this._entries.clear();
    this.fallbackSkinMatrixBuffer.destroy();
    this.fallbackSkinJointBuffer.destroy();
    this.fallbackSkinWeightBuffer.destroy();
  }

  private _matches(
    data: PbrDeformationGpuData,
    geometry: Geometry3D,
    morphEnabled: boolean,
  ): boolean {
    if (data.vertexCount !== geometry.vertexCount || data.morphEnabled !== morphEnabled) return false;
    for (let index = 0; index < 4; index++) {
      const target = morphEnabled ? geometry.morphTargets[index] : undefined;
      if (data.morphPositionSources[index] !== (target?.positions ?? null)) return false;
      if (data.morphNormalSources[index] !== (target?.normals ?? null)) return false;
    }
    const skinning = geometry.skinning;
    return data.skinning === skinning
      && data.skinJointSource === (skinning?.joints ?? null)
      && data.skinWeightSource === (skinning?.weights ?? null)
      && data.skinMatrixSource === (skinning?.jointMatrices ?? null);
  }

  private _createEntry(geometry: Geometry3D, morphEnabled: boolean): PbrDeformationGpuData {
    const morphPositionSources = Array.from({ length: 4 }, (_, index) =>
      morphEnabled ? geometry.morphTargets[index]?.positions ?? null : null);
    const morphNormalSources = Array.from({ length: 4 }, (_, index) =>
      morphEnabled ? geometry.morphTargets[index]?.normals ?? null : null);
    let zeroMorphBuffer: GPUBuffer | null = null;
    const morphBuffers = Array.from({ length: 4 }, (_, index) => {
      const target = morphEnabled ? geometry.morphTargets[index] : undefined;
      if (!target?.positions && !target?.normals) {
        zeroMorphBuffer ??= this._makeMorphBuffer(null, geometry.vertexCount, 'PbrRenderer.zeroMorph');
        return zeroMorphBuffer;
      }
      return this._makeMorphBuffer(target, geometry.vertexCount, `PbrRenderer.morph${index}`);
    });

    const skinning = geometry.skinning;
    const skinMatrixBuffer = skinning
      ? this._makeStorageBuffer(skinning.jointMatrices, 'PbrRenderer.skinMatrices', 64)
      : null;
    const skinJointBuffer = skinning
      ? this._makeStorageBuffer(skinning.joints, 'PbrRenderer.skinJoints')
      : null;
    const skinWeightBuffer = skinning
      ? this._makeStorageBuffer(skinning.weights, 'PbrRenderer.skinWeights')
      : null;
    const skinBindGroup = skinMatrixBuffer && skinJointBuffer && skinWeightBuffer
      ? this._options.createSceneBindGroup(skinMatrixBuffer, skinJointBuffer, skinWeightBuffer)
      : this._options.getFallbackSceneBindGroup();
    return {
      vertexCount: geometry.vertexCount,
      morphEnabled,
      morphPositionSources,
      morphNormalSources,
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
      sceneBindingRevision: this._options.getSceneBindingRevision(),
    };
  }

  private _makeMorphBuffer(target: MorphTarget3D | null, vertexCount: number, label: string): GPUBuffer {
    const interleaved = new Float32Array(vertexCount * 6);
    if (target) {
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        const source = vertex * 3;
        const destination = vertex * 6;
        interleaved[destination] = target.positions?.[source] ?? 0;
        interleaved[destination + 1] = target.positions?.[source + 1] ?? 0;
        interleaved[destination + 2] = target.positions?.[source + 2] ?? 0;
        interleaved[destination + 3] = target.normals?.[source] ?? 0;
        interleaved[destination + 4] = target.normals?.[source + 1] ?? 0;
        interleaved[destination + 5] = target.normals?.[source + 2] ?? 0;
      }
    }
    const buffer = this._options.device.createBuffer({
      label,
      size: Math.max(4, alignUp4(interleaved.byteLength)),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (interleaved.byteLength > 0) writeBuffer(this._options.device.queue, buffer, 0, interleaved);
    return buffer;
  }

  private _makeStorageBuffer(data: Float32Array, label: string, minimumSize = 16): GPUBuffer {
    const buffer = this._options.device.createBuffer({
      label,
      size: Math.max(minimumSize, alignUp4(data.byteLength)),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) writeBuffer(this._options.device.queue, buffer, 0, data);
    return buffer;
  }

  private _syncSkinningMatrices(geometry: Geometry3D, data: PbrDeformationGpuData): void {
    const skinning = geometry.skinning;
    if (!skinning || !data.skinMatrixBuffer || data.skinVersion === skinning.version) return;
    writeBuffer(this._options.device.queue, data.skinMatrixBuffer, 0, skinning.jointMatrices);
    data.skinVersion = skinning.version;
  }

  private _destroyEntry(data: PbrDeformationGpuData): void {
    for (const buffer of new Set(data.morphBuffers)) buffer.destroy();
    data.skinJointBuffer?.destroy();
    data.skinWeightBuffer?.destroy();
    data.skinMatrixBuffer?.destroy();
  }
}
