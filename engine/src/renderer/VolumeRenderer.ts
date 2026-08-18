import { mat4 } from 'wgpu-matrix';
import type { IEngine } from '../core/IEngine';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { VolumeMaterial } from '../material/VolumeMaterial';
import { BaseRenderer } from './BaseRenderer';
import type { LiveIdSet } from './utils';
import type { MaterialGpuDrivenBatch, MaterialRenderBatchItem } from './MaterialRendererRegistry';
import { getBuiltinSpecializedRenderingShader } from '../shader/BuiltinSpecializedRenderingShader';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import { RendererObjectTable } from './RendererObjectTable';
import type { GpuDrivenBatchBuffer } from './GpuDrivenBatchBuffer';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { CLIPPING_BLOCK_FLOATS, writeClippingBlock } from './ClippingPlanesGpu';
import { ParameterizedRendererCore, RendererCacheGeometryOwner } from './ParameterizedRendererCore';
import type { RendererObjectSlotCache } from './RendererCacheMap';

interface VolumeGeometryData {
  version: number;
  positionBuffer: GPUBuffer;
  indexBuffer: GPUBuffer | null;
  vertexCount: number;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  boundsMin: Float32Array;
  boundsMax: Float32Array;
}

interface VolumeEntityData {
  modelSlot: number;
}

interface VolumeMaterialData {
  bindGroup: GPUBindGroup;
  texture: GPUTexture | null;
  samplerDescriptor: GPUSamplerDescriptor | null;
  samplerKey: string;
  sampler: GPUSampler;
}

const OBJECT_BASE_FLOATS = 16 + 16 + 4 + 4 + 4 + 4;
const OBJECT_TABLE_FLOATS = OBJECT_BASE_FLOATS;

export class VolumeRenderer extends BaseRenderer {
  readonly type = 'volume';

  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private shaderModule!: GPUShaderModule;
  private shaderKey = '';
  private cameraBindGroupLayout!: GPUBindGroupLayout;
  private objectBindGroupLayout!: GPUBindGroupLayout;
  private materialBindGroupLayout!: GPUBindGroupLayout;
  private pipelineLayout!: GPUPipelineLayout;
  private sceneFrameBinding!: SceneFrameGpuBinding;
  private rendererCore!: ParameterizedRendererCore<VolumeEntityData, VolumeGeometryData>;
  private get objectTable(): RendererObjectTable { return this.rendererCore.requireObjectTable(); }
  private get geometryCache(): RendererCacheGeometryOwner<VolumeGeometryData> {
    return this.rendererCore.geometry as RendererCacheGeometryOwner<VolumeGeometryData>;
  }
  private get entityCache(): RendererObjectSlotCache<VolumeEntityData> { return this.rendererCore.requireObjects(); }
  private readonly cameraDynamicOffset = new Uint32Array(1);
  private defaultTexture!: GPUTexture;
  private defaultSampler!: GPUSampler;
  private readonly materialCache = new Map<number, VolumeMaterialData>();
  private readonly samplerCache = new Map<string, GPUSampler>();
  private readonly invWorldScratch = mat4.identity() as Float32Array;
  private initialized = false;
  private get uploadsPrepared(): boolean { return this.rendererCore.uploadsPrepared; }

  prepare(engine: IEngine): void {
    if (this.initialized) return;
    this.initialized = true;
    this.engine = engine;
    const { device } = engine;
    this.sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this.cameraBindGroupLayout = this.sceneFrameBinding.bindGroupLayout;
    this.objectBindGroupLayout = this.getSharedRendererResource(device, 'VolumeRenderer.objectStorageBgl', () => device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ] }));
    this.materialBindGroupLayout = this.getSharedRendererResource(device, 'VolumeRenderer.materialBgl', () => device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    }));
    const generated = getBuiltinSpecializedRenderingShader(device, 'volume', [
      this.cameraBindGroupLayout,
      this.objectBindGroupLayout,
      this.materialBindGroupLayout,
    ]);
    this.shaderModule = generated.module;
    this.shaderKey = generated.pass.canonicalHash;
    this.pipelineLayout = generated.pipelineLayout;
    this.rendererCore = new ParameterizedRendererCore({
      objectTables: {
        device,
        bindGroupLayout: this.objectBindGroupLayout,
        label: 'VolumeRenderer',
        floatsPerSlot: OBJECT_TABLE_FLOATS,
        batch: false,
        auxiliary: { binding: 1, floatsPerSlot: CLIPPING_BLOCK_FLOATS, label: 'VolumeRenderer.clippingTable' },
      },
      createObject: modelSlot => ({ modelSlot }),
      geometry: new RendererCacheGeometryOwner(
        data => {
          data.positionBuffer.destroy();
          data.indexBuffer?.destroy();
        },
        geometry => this.createGeometryData(geometry),
      ),
    });
    this.defaultTexture = device.createTexture({
      label: 'VolumeRenderer.defaultTexture',
      size: [1, 1, 1],
      dimension: '3d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.defaultTexture },
      new Uint8Array([255, 255, 255, 0]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    this.defaultSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    for (const blending of ['normal', 'additive'] as const) {
      const key = this.pipelineKey(blending);
      this.addPipelineWarmup(
        plan,
        key,
        `Volume ${blending}`,
        () => this.pipelineDescriptor(blending),
        this.engine.device,
      );
    }
  }

  beginView(sceneFrame: SceneFrameUniformSnapshot, context?: RenderCommandContext): void {
    this.cameraDynamicOffset[0] = this.sceneFrameBinding.upload(sceneFrame, context);
    this.rendererCore.beginUploads(context);
  }

  prepareObjects(
    items: readonly MaterialRenderBatchItem<VolumeMaterial>[],
    first: number,
    count: number,
    _eyePosition: [number, number, number],
    firstBatchIndex = first,
    batchBuffer: GpuDrivenBatchBuffer | null = null,
  ): void {
    const end = Math.min(items.length, first + count);
    for (let index = first; index < end; index++) {
      const item = items[index];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      const geometryData = this.ensureGeometry(item.geometry);
      const entityData = this.ensureEntity(item.entityId);
      this.ensureMaterial(item.material);
      const objectSlot = batchBuffer?.gpuUploadEnabled
        ? batchBuffer.getObjectSlot(firstBatchIndex + index - first)
        : entityData.modelSlot;
      this.writeObjectTableEntry(objectSlot, geometryData, item.clippingPlanes, item.worldMatrix, item.material);
    }
  }

  flushUploads(): void {
    this.rendererCore.flushUploads();
  }

  endView(): void {
    this.rendererCore.endView();
  }

  render(
    passEncoder: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: VolumeMaterial,
    worldMatrix: Float32Array,
    _eyePosition: [number, number, number],
    options: { gpuDrivenBatch?: MaterialGpuDrivenBatch | undefined } = {},
    clippingPlanes: ClippingPlanes | null = null,
  ): void {
    const geometryData = this.ensureGeometry(geometry);
    const entityData = this.ensureEntity(entityId);
    const materialData = this.ensureMaterial(material);
    const objectSlot = options.gpuDrivenBatch?.objectSlot ?? entityData.modelSlot;
    if (!this.uploadsPrepared) {
      this.writeObjectTableEntry(objectSlot, geometryData, clippingPlanes, worldMatrix, material);
    }

    passEncoder.setPipeline(this.getPipeline(material));
    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    passEncoder.setBindGroup(1, this.objectTable.bindGroup);
    passEncoder.setBindGroup(2, materialData.bindGroup);
    passEncoder.setVertexBuffer(0, geometryData.positionBuffer);
    if (geometryData.indexBuffer) {
      passEncoder.setIndexBuffer(geometryData.indexBuffer, geometryData.indexFormat);
      if (options.gpuDrivenBatch) {
        passEncoder.drawIndexedIndirect(options.gpuDrivenBatch.indexedIndirectBuffer, options.gpuDrivenBatch.indexedIndirectOffset);
      } else {
        passEncoder.drawIndexed(geometryData.indexCount, 1, 0, 0, objectSlot);
      }
    } else {
      if (options.gpuDrivenBatch) {
        passEncoder.drawIndirect(options.gpuDrivenBatch.drawIndirectBuffer, options.gpuDrivenBatch.drawIndirectOffset);
      } else {
        passEncoder.draw(geometryData.vertexCount, 1, 0, objectSlot);
      }
    }
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    this.rendererCore.releaseObjectsNotIn(liveEntities);
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    this.rendererCore.releaseGeometriesNotIn(liveGeometries);
  }

  releaseMaterialsNotIn(liveMaterials: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this.materialCache, liveMaterials, () => {});
  }

  destroy(): this {
    this.rendererCore?.destroy();
    this.materialCache.clear();
    this.samplerCache.clear();
    this.defaultTexture?.destroy();
    this.sceneFrameBinding?.destroy();
    this.clearPipelineCache();
    return this;
  }

  private ensureGeometry(geometry: Geometry3D): VolumeGeometryData {
    let data = this.geometryCache.get(geometry.id);
    if (!data || data.version !== geometry.version) {
      if (data) {
        data.positionBuffer.destroy();
        data.indexBuffer?.destroy();
      }
      data = this.createGeometryData(geometry);
      this.geometryCache.set(geometry.id, data);
    }
    return data;
  }

  private createGeometryData(geometry: Geometry3D): VolumeGeometryData {
    const { device } = this.engine;
    const positionBuffer = device.createBuffer({
      label: `VolumeRenderer.geometry.${geometry.id}.positions`,
      size: geometry.positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(positionBuffer, 0, geometry.positions as ArrayBufferView<ArrayBuffer>);
    let indexBuffer: GPUBuffer | null = null;
    let indexFormat: GPUIndexFormat = 'uint16';
    if (geometry.indices) {
      indexFormat = geometry.indices instanceof Uint32Array ? 'uint32' : 'uint16';
      indexBuffer = device.createBuffer({
        label: `VolumeRenderer.geometry.${geometry.id}.indices`,
        size: geometry.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(indexBuffer, 0, geometry.indices as ArrayBufferView<ArrayBuffer>);
    }
    const bounds = geometry.getBoundingBox();
    return {
      version: geometry.version,
      positionBuffer,
      indexBuffer,
      vertexCount: geometry.vertexCount,
      indexCount: geometry.indices?.length ?? 0,
      indexFormat,
      boundsMin: Float32Array.from(bounds.min),
      boundsMax: Float32Array.from(bounds.max),
    };
  }

  private ensureEntity(entityId: number): VolumeEntityData {
    let data = this.entityCache.get(entityId);
    if (data) return data;
    return this.entityCache.ensure(entityId);
  }

  private ensureMaterial(material: VolumeMaterial): VolumeMaterialData {
    const samplerKey = this.samplerKey(material.sampler);
    const materialId = this.rendererCore.materialIdentity(material);
    let data = this.materialCache.get(materialId);
    if (!data || data.texture !== material.texture || data.samplerKey !== samplerKey) {
      data = this.createMaterialData(material, samplerKey);
      this.materialCache.set(materialId, data);
    }
    return data;
  }

  private createMaterialData(material: VolumeMaterial, samplerKey: string): VolumeMaterialData {
    const { device } = this.engine;
    const sampler = this.createSampler(material.sampler, samplerKey);
    const texture = material.texture ?? this.defaultTexture;
    return {
      texture: material.texture,
      samplerDescriptor: material.sampler,
      samplerKey,
      sampler,
      bindGroup: device.createBindGroup({
        layout: this.materialBindGroupLayout,
        entries: [
          { binding: 0, resource: texture.createView({ dimension: '3d' }) },
          { binding: 1, resource: sampler },
        ],
      }),
    };
  }

  private writeObjectTableEntry(
    objectSlot: number,
    geometryData: VolumeGeometryData,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    material: VolumeMaterial,
  ): void {
    this.objectTable.ensureCapacity(objectSlot + 1);
    const base = objectSlot * OBJECT_TABLE_FLOATS;
    const data = this.objectTable.data;
    const invWorld = mat4.inverse(worldMatrix, this.invWorldScratch) as Float32Array;
    data.set(worldMatrix, base);
    data.set(invWorld, base + 16);
    data.set(geometryData.boundsMin, base + 32);
    data[base + 35] = 0;
    data.set(geometryData.boundsMax, base + 36);
    data[base + 39] = 0;
    data[base + 40] = material.densityScale;
    data[base + 41] = material.opacityScale;
    data[base + 42] = Math.max(1, Math.min(192, material.steps));
    data[base + 43] = 0;
    material.color.writeSRGB(data, base + 44);
    this.objectTable.writeSlot(objectSlot);
    writeClippingBlock(this.objectTable.auxiliaryData, objectSlot * CLIPPING_BLOCK_FLOATS, clippingPlanes);
    this.objectTable.writeAuxiliarySlot(objectSlot);
  }

  private getPipeline(material: VolumeMaterial): GPURenderPipeline {
    const key = this.pipelineKey(material.blending);
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(this.pipelineDescriptor(material.blending)));
  }

  private pipelineKey(blending: VolumeMaterial['blending']): string {
    return `${this.shaderKey}|${this.reverseZ ? 1 : 0}|${this.msaaSamples}|${blending}`;
  }

  private pipelineDescriptor(blending: VolumeMaterial['blending']): GPURenderPipelineDescriptor {
    const blend: GPUBlendState = blending === 'additive'
      ? {
          color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        }
      : {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        };
    return {
      layout: this.pipelineLayout,
      vertex: {
        module: this.shaderModule,
        entryPoint: 'vs_main',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.engine.format, blend }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: this.engine.getDepthFormat(this.reverseZ),
        depthWriteEnabled: false,
        depthCompare: this.reverseZ ? 'greater' : 'less',
      },
      multisample: { count: this.msaaSamples },
    };
  }

  private createSampler(descriptor: GPUSamplerDescriptor | null, key: string): GPUSampler {
    if (!descriptor) return this.defaultSampler;
    let sampler = this.samplerCache.get(key);
    if (!sampler) {
      sampler = this.engine.device.createSampler(descriptor);
      this.samplerCache.set(key, sampler);
    }
    return sampler;
  }

  private samplerKey(descriptor: GPUSamplerDescriptor | null): string {
    if (!descriptor) return 'default';
    return [
      descriptor.addressModeU ?? 'clamp-to-edge',
      descriptor.addressModeV ?? 'clamp-to-edge',
      descriptor.addressModeW ?? 'clamp-to-edge',
      descriptor.magFilter ?? 'nearest',
      descriptor.minFilter ?? 'nearest',
      descriptor.mipmapFilter ?? 'nearest',
      descriptor.lodMinClamp ?? 0,
      descriptor.lodMaxClamp ?? 32,
      descriptor.compare ?? '',
      descriptor.maxAnisotropy ?? 1,
    ].join('|');
  }
}
