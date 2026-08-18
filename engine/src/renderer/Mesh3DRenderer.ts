import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import { Geometry3D } from '../geometry/Geometry3D';
import { BasicMaterial, BASIC_MATERIAL_SHADER, BASIC_MATERIAL_SKINNED_SHADER } from '../material/BasicMaterial';
import type { BlendMode, MaterialTextureSource, SampleableTextureSource } from '../material/BasicMaterial';
import { BaseRenderer } from './BaseRenderer';
import { getSharedGeometry3DGPUCache } from './SharedGeometry3DGPUCache';
import { encodeCompare, encodePrimitivePipelineKey } from './pipelineKey';
import { getStripIndexFormat, matrixEquals, writeBuffer as wrtBuf, writeBufferAligned } from './utils';
import type { LiveIdSet } from './utils';
import { sharedZeroVectorCache } from './ZeroVectorCache';
import { alignUp4 } from '../utils/align';
import { AssetManager, type AssetHandle } from '../assets/AssetManager';
import type { MaterialGpuDrivenBatch, MaterialRenderBatchItem } from './MaterialRendererRegistry';
import type { GpuDrivenBatchBuffer } from './GpuDrivenBatchBuffer';
import { forEachDirectInstanceBatchRun } from './DirectInstanceBatchRuns';
import { RendererObjectTable } from './RendererObjectTable';
import { RendererCacheMap, RendererObjectSlotCache } from './RendererCacheMap';
import { Mesh3DPipelineFactory } from './Mesh3DPipelineFactory';
import { getBuiltinDeformationShader } from '../shader/BuiltinDeformationShader';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { CLIPPING_BLOCK_FLOATS, clippingStateKey, writeClippingBlock } from './ClippingPlanesGpu';
import { ParameterizedRendererCore, RendererCacheGeometryOwner } from './ParameterizedRendererCore';

interface GeoGPUData {
  geometryId: number;
  sharedStandard: boolean;
  positionBuf: GPUBuffer;
  normalBuf: GPUBuffer;
  uvBuf: GPUBuffer;
  morphPositionBufs: GPUBuffer[];
  skinJointBuf: GPUBuffer | null;
  skinWeightBuf: GPUBuffer | null;
  skinMatrixBuf: GPUBuffer | null;
  skinBindGroup: GPUBindGroup | null;
  indexBuf: GPUBuffer | null;
  indexCount: number;
  vertexCount: number;
  indexFormat: GPUIndexFormat;
  version: number;
  morphVersion: number;
  morphUseGpu: boolean;
  skinVersion: number;
  skinned: boolean;
}

const OBJECT_TABLE_FLOATS = 24;
const OBJECT_TABLE_MORPH_OFFSET = 16;
const OBJECT_TABLE_DEFORMATION_OFFSET = 20;

interface EntityGPUData {
  modelSlot: number;
  modelSnapshot: Float32Array;
  modelDirty: boolean;
  clippingKey: string;
}

interface MatGPUData {
  colorBuf: GPUBuffer;
  gpuTexture: GPUTexture;
  emissiveGpuTexture: GPUTexture;
  textureHandle: AssetHandle<GPUTexture> | null;
  emissiveTextureHandle: AssetHandle<GPUTexture> | null;
  ownsTexture: boolean;
  ownsEmissiveTexture: boolean;
  sampler: GPUSampler;
  bindGroup: GPUBindGroup;
  textureLoaded: boolean;
  emissiveTextureLoaded: boolean;
  /** Tracks which texture object is currently bound — detects RTT texture changes */
  sourceTexture: unknown;
  sourceEmissiveTexture: unknown;
  sourceSampler: GPUSamplerDescriptor | null;
  sourceSamplerKey: string;
  uniformData: ArrayBuffer;
  uniformF32: Float32Array;
  uniformU32: Uint32Array;
  lastColor: [number, number, number, number];
  lastEmissiveFactor: [number, number, number];
  lastUseTexture: number;
  lastUseEmissiveTexture: number;
  uniformDirty: boolean;
}

interface Mesh3DRenderResources {
  geoData: GeoGPUData;
  entData: EntityGPUData;
  matData: MatGPUData;
}

/**
 * Additive blending is commutative for the configured color equation, so
 * already-ordered objects sharing an exact material/geometry may be instanced.
 * Depth-writing transparent materials remain order/state dependent.
 */
export function supportsBasicSortedInstanceBatching(material: BasicMaterial): boolean {
  return material.blending === 'additive' && !material.depthWrite;
}

export class Mesh3DRenderer extends BaseRenderer {
  readonly type = 'mesh3d';

  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;

  private bgl0!: GPUBindGroupLayout; // camera
  private bgl1!: GPUBindGroupLayout; // object
  private bgl2!: GPUBindGroupLayout; // material
  private bgl3!: GPUBindGroupLayout; // skinning
  private shaderModule!: GPUShaderModule;
  private skinnedShaderModule!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private skinnedPipelineLayout!: GPUPipelineLayout;
  private pipelineFactory!: Mesh3DPipelineFactory;

  private sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly cameraDynamicOffset = new Uint32Array(1);
  private rendererCore!: ParameterizedRendererCore<EntityGPUData, GeoGPUData>;
  private get objectTable(): RendererObjectTable { return this.rendererCore.requireObjectTable(); }
  private get batchObjectTable(): RendererObjectTable { return this.rendererCore.requireBatchObjectTable(); }
  private get geoCache(): RendererCacheGeometryOwner<GeoGPUData> {
    return this.rendererCore.geometry as RendererCacheGeometryOwner<GeoGPUData>;
  }
  private get entityCache(): RendererObjectSlotCache<EntityGPUData> { return this.rendererCore.requireObjects(); }
  private assetManager!: AssetManager;
  private ownsAssetManager = false;

  private defaultTexture!: GPUTexture;
  private defaultSampler!: GPUSampler;

  private sharedGeoCache!: ReturnType<typeof getSharedGeometry3DGPUCache>;
  private matCache = new RendererCacheMap<MatGPUData>(data => this._destroyMatData(data));
  private _samplerCache = new Map<string, GPUSampler>();

  private _initialized = false;

  constructor(_options?: Record<string, unknown>) {
    super();
  }

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this.clearPipelineCache();
    this._initialized = true;
    this.engine = engine;
    const { device } = engine;
    this.assetManager = engine.assetManager ?? new AssetManager(device, getEngineGPUResourceTracker(engine), engine.defaults?.assetManager);
    this.ownsAssetManager = !engine.assetManager;
    this.sharedGeoCache = getSharedGeometry3DGPUCache(device, getEngineGPUResourceTracker(engine));

    this.sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this.bgl0 = this.sceneFrameBinding.bindGroupLayout;
    this.bgl1 = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ] });
    this.bgl2 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.bgl3 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    const generated = getBuiltinDeformationShader(device, 'forward', [this.bgl0, this.bgl1, this.bgl2]);
    const generatedSkinned = getBuiltinDeformationShader(
      device,
      'forward-skinned',
      [this.bgl0, this.bgl1, this.bgl2, this.bgl3],
    );
    this.shaderModule = generated.module;
    this.skinnedShaderModule = generatedSkinned.module;
    this.pipelineLayout = generated.pipelineLayout;
    this.skinnedPipelineLayout = generatedSkinned.pipelineLayout;
    this.pipelineFactory = new Mesh3DPipelineFactory(
      engine,
      this.shaderModule,
      this.skinnedShaderModule,
      this.pipelineLayout,
      this.skinnedPipelineLayout,
    );

    this.rendererCore = new ParameterizedRendererCore({
      objectTables: {
        device,
        bindGroupLayout: this.bgl1,
        label: 'Mesh3DRenderer',
        floatsPerSlot: OBJECT_TABLE_FLOATS,
        auxiliary: { binding: 1, floatsPerSlot: CLIPPING_BLOCK_FLOATS, label: 'Mesh3DRenderer.clippingTable' },
      },
      createObject: modelSlot => ({
        modelSlot,
        modelSnapshot: new Float32Array(16),
        modelDirty: true,
        clippingKey: '',
      }),
      geometry: new RendererCacheGeometryOwner(
        data => this._destroyGeoData(data),
        geometry => this._uploadGeometry(geometry),
      ),
    });

    // 1×1 white default texture
    this.defaultTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.defaultTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this.defaultSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
  }

  updateCamera(sceneFrame: SceneFrameUniformSnapshot, _viewSlot = 0, context?: RenderCommandContext): void {
    this.cameraDynamicOffset[0] = this.sceneFrameBinding.upload(sceneFrame, context);
    this.rendererCore.beginUploads(context);
  }

  prepareObjects(
    items: readonly MaterialRenderBatchItem<BasicMaterial>[],
    first = 0,
    count = items.length - first,
    firstBatchIndex = first,
    batchBuffer: GpuDrivenBatchBuffer | null = null,
  ): void {
    const end = Math.min(items.length, first + count);
    for (let index = first; index < end; index++) {
      const item = items[index];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      const objectSlot = batchBuffer && (
        item.material.blending === 'none'
        || supportsBasicSortedInstanceBatching(item.material)
      )
        ? batchBuffer.getObjectSlot(firstBatchIndex + index - first)
        : undefined;
      const objectTable = objectSlot === undefined ? this.objectTable : this.batchObjectTable;
      const { matData } = this._ensureRenderResources(
        item.entityId,
        item.geometry,
        item.material,
        item.clippingPlanes,
        item.worldMatrix,
        objectSlot,
        objectTable,
      );
      this._syncBatchMaterialResources(item.material, matData);
    }
  }

  flushUploads(): void {
    this.rendererCore.flushUploads();
  }

  endView(): void {
    this.rendererCore.endView();
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const baseOptions = {
      topology: 'triangle-list' as const,
      cullMode: 'back' as const,
      frontFace: 'ccw' as const,
      reverseZ: this.reverseZ,
      msaaSamples: this.msaaSamples,
      depthWriteEnabled: true,
    };
    for (const skinned of [false, true]) {
      const primitiveKey = encodePrimitivePipelineKey(
        baseOptions.topology,
        baseOptions.cullMode,
        baseOptions.frontFace,
        undefined,
        this.reverseZ,
        this.msaaSamples,
        1 | (skinned ? 2 : 0),
      );
      const key = this.rendererCore.pipelineKey(
        primitiveKey,
        skinned ? BASIC_MATERIAL_SKINNED_SHADER.featureKey : BASIC_MATERIAL_SHADER.featureKey,
      );
      const options = { ...baseOptions, skinned };
      this.addPipelineWarmup(
        plan,
        key,
        `Basic ${skinned ? 'skinned ' : ''}opaque`,
        () => this.pipelineFactory.descriptor(options),
        this.engine.device,
      );

      const depthPrimitiveKey = encodePrimitivePipelineKey(
        baseOptions.topology,
        baseOptions.cullMode,
        baseOptions.frontFace,
        undefined,
        this.reverseZ,
        this.msaaSamples,
        (1 << 8) | (skinned ? 1 : 0),
      );
      const depthKey = this.rendererCore.pipelineKey(
        depthPrimitiveKey,
        skinned ? BASIC_MATERIAL_SKINNED_SHADER.featureKey : BASIC_MATERIAL_SHADER.featureKey,
      );
      this.addPipelineWarmup(
        plan,
        depthKey,
        `Basic ${skinned ? 'skinned ' : ''}depth prepass`,
        () => this.pipelineFactory.descriptor({ ...options, colorWriteMask: 0 }),
        this.engine.device,
      );
    }

    const standardCompare: GPUCompareFunction = this.reverseZ ? 'greater' : 'less';
    const prepassCompare: GPUCompareFunction = this.reverseZ ? 'greater-equal' : 'less-equal';
    const blendVariants = [
      { label: 'Basic alpha blend', depthWriteEnabled: false, depthCompare: standardCompare },
      { label: 'Basic alpha blend after depth prepass', depthWriteEnabled: false, depthCompare: prepassCompare },
      { label: 'Basic alpha blend with depth write', depthWriteEnabled: true, depthCompare: standardCompare },
    ] as const;
    for (const variant of blendVariants) {
      const blendFlags = 1
        | ((variant.depthWriteEnabled ? 1 : 0) << 2)
        | (encodeCompare(variant.depthCompare) << 3)
        | (1 << 7);
      const primitiveKey = encodePrimitivePipelineKey(
        baseOptions.topology,
        baseOptions.cullMode,
        baseOptions.frontFace,
        undefined,
        this.reverseZ,
        this.msaaSamples,
        blendFlags,
      );
      const key = this.rendererCore.pipelineKey(primitiveKey, BASIC_MATERIAL_SHADER.featureKey);
      this.addPipelineWarmup(
        plan,
        key,
        variant.label,
        () => this.pipelineFactory.blendDescriptor('normal', {
          ...baseOptions,
          depthWriteEnabled: variant.depthWriteEnabled,
          depthCompare: variant.depthCompare,
        }),
        this.engine.device,
      );
    }
  }

  releaseEntity(entityId: number): void {
    this.entityCache.release(entityId);
  }

  releaseGeometry(geometryId: number): void {
    this.geoCache.release(geometryId);
  }

  releaseMaterial(materialId: number): void {
    this.matCache.release(materialId);
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    this.entityCache.releaseNotIn(liveEntities);
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    this.geoCache.releaseNotIn(liveGeometries);
  }

  releaseMaterialsNotIn(liveMaterials: LiveIdSet): void {
    this.matCache.releaseNotIn(liveMaterials);
  }

  render(
    passEncoder: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: BasicMaterial,
    worldMatrix: Float32Array,
    options: { skipDepthPrepass?: boolean; gpuDrivenBatch?: MaterialGpuDrivenBatch | undefined } = {},
    clippingPlanes: ClippingPlanes | null = null,
  ): void {
    const objectSlot = options.gpuDrivenBatch?.objectSlot;
    const objectTable = objectSlot === undefined ? this.objectTable : this.batchObjectTable;
    const { geoData, entData, matData } = this._ensureRenderResources(
      entityId,
      geometry,
      material,
      clippingPlanes,
      worldMatrix,
      objectSlot,
      objectTable,
      this.rendererCore.uploadsPrepared,
    );

    if (!this.rendererCore.uploadsPrepared) this._syncBatchMaterialResources(material, matData);

    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    passEncoder.setBindGroup(1, objectTable.bindGroup);
    passEncoder.setBindGroup(2, matData.bindGroup);
    if (geoData.skinned && geoData.skinBindGroup) passEncoder.setBindGroup(3, geoData.skinBindGroup);
    passEncoder.setVertexBuffer(0, geoData.positionBuf);
    passEncoder.setVertexBuffer(1, geoData.normalBuf);
    passEncoder.setVertexBuffer(2, geoData.uvBuf);
    for (let i = 0; i < 4; i++) passEncoder.setVertexBuffer(3 + i, geoData.morphPositionBufs[i]);

    const useDepthPrepass = material.blending === 'normal' && material.depthWrite && !options.skipDepthPrepass;
    if (useDepthPrepass) {
      passEncoder.setPipeline(this._getDepthPrepassPipeline(geometry, material));
      this._draw(passEncoder, geoData, undefined, objectSlot ?? entData.modelSlot);
    }

    const pipeline = material.blending === 'none'
      ? this._getOpaquePipeline(geometry, material)
      : this._getBlendPipeline(
          material.blending,
          geometry,
          material,
          useDepthPrepass ? false : material.depthWrite,
          useDepthPrepass ? (this.reverseZ ? 'greater-equal' : 'less-equal') : undefined,
        );
    passEncoder.setPipeline(pipeline);
    this._draw(passEncoder, geoData, options.gpuDrivenBatch, entData.modelSlot);
  }

  renderBatch(
    passEncoder: GPURenderPassEncoder,
    items: readonly MaterialRenderBatchItem<BasicMaterial>[],
    first: number,
    count: number,
    batchBuffer: GpuDrivenBatchBuffer,
    skipDepthPrepass = false,
    firstBatchIndex = first,
  ): void {
    const end = Math.min(items.length, first + count);
    if (first >= end) return;

    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    if (batchBuffer.gpuUploadEnabled === false) {
      forEachDirectInstanceBatchRun(items, first, count, batchBuffer, run => {
        const item = run.item;
        const matData = this._ensureBatchMaterialData(item.material);
        const { geoData, entData } = this._ensureGeometryEntityResources(
          item.entityId,
          item.geometry,
          item.clippingPlanes,
          item.worldMatrix,
          run.firstInstance,
          this.batchObjectTable,
        );
        const pipeline = item.material.blending === 'none'
          ? this._getOpaquePipeline(item.geometry, item.material)
          : this._getBlendPipeline(
              item.material.blending,
              item.geometry,
              item.material,
              item.material.depthWrite,
            );
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(2, matData.bindGroup);
        this._bindGeometry(passEncoder, geoData, entData, this.batchObjectTable);
        if (geoData.indexBuf) {
          passEncoder.setIndexBuffer(geoData.indexBuf, geoData.indexFormat);
          passEncoder.drawIndexed(geoData.indexCount, run.instanceCount, 0, 0, run.firstInstance);
        } else {
          passEncoder.draw(geoData.vertexCount, run.instanceCount, 0, run.firstInstance);
        }
      }, firstBatchIndex);
      return;
    }

    if (!skipDepthPrepass) {
      for (let itemIndex = first; itemIndex < end; itemIndex++) {
        const item = items[itemIndex];
        if (!item?.geometry || !item.material || !item.worldMatrix) continue;
        const itemMaterial = item.material;
        const useDepthPrepass = itemMaterial.blending === 'normal' && itemMaterial.depthWrite;
        if (!useDepthPrepass) continue;
        const batchIndex = firstBatchIndex + itemIndex - first;
        const objectSlot = batchBuffer.getObjectSlot(batchIndex);
        const matData = this._ensureBatchMaterialData(itemMaterial);
        const { geoData, entData } = this._ensureGeometryEntityResources(
          item.entityId,
          item.geometry,
          item.clippingPlanes,
          item.worldMatrix,
          objectSlot,
          this.batchObjectTable,
        );
        passEncoder.setBindGroup(2, matData.bindGroup);
        passEncoder.setPipeline(this._getDepthPrepassPipeline(item.geometry, itemMaterial));
        this._bindGeometry(passEncoder, geoData, entData, this.batchObjectTable);
        this._draw(passEncoder, geoData, undefined, objectSlot);
      }
    }

    for (let itemIndex = first; itemIndex < end; itemIndex++) {
      const item = items[itemIndex];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      const itemMaterial = item.material;
      const batchIndex = firstBatchIndex + itemIndex - first;
      const objectSlot = batchBuffer.getObjectSlot(batchIndex);
      const matData = this._ensureBatchMaterialData(itemMaterial);
      const { geoData, entData } = this._ensureGeometryEntityResources(
        item.entityId,
        item.geometry,
        item.clippingPlanes,
        item.worldMatrix,
        objectSlot,
        this.batchObjectTable,
      );
      const useDepthPrepass = itemMaterial.blending === 'normal' && itemMaterial.depthWrite && !skipDepthPrepass;
      const pipeline = itemMaterial.blending === 'none'
        ? this._getOpaquePipeline(item.geometry, itemMaterial)
        : this._getBlendPipeline(
            itemMaterial.blending,
            item.geometry,
            itemMaterial,
            useDepthPrepass ? false : itemMaterial.depthWrite,
            useDepthPrepass ? (this.reverseZ ? 'greater-equal' : 'less-equal') : undefined,
          );
      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(2, matData.bindGroup);
      this._bindGeometry(passEncoder, geoData, entData, this.batchObjectTable);
      this._drawBatch(passEncoder, geoData, batchBuffer, batchIndex);
    }
  }

  private _ensureBatchMaterialData(material: BasicMaterial): MatGPUData {
    if (this.rendererCore.uploadsPrepared) {
      const prepared = this.matCache.get(this.rendererCore.materialIdentity(material));
      if (prepared) return prepared;
    }
    const matData = this.matCache.ensure(this.rendererCore.materialIdentity(material), () => this._createMatGPUData(material));
    this._syncBatchMaterialResources(material, matData);
    return matData;
  }

  renderDepthPrepass(
    passEncoder: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: BasicMaterial,
    worldMatrix: Float32Array,
    clippingPlanes: ClippingPlanes | null = null,
  ): void {
    const { geoData, entData, matData } = this._ensureRenderResources(
      entityId,
      geometry,
      material,
      clippingPlanes,
      worldMatrix,
      undefined,
      this.objectTable,
      this.rendererCore.uploadsPrepared,
    );

    passEncoder.setPipeline(this._getDepthPrepassPipeline(geometry, material));
    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    passEncoder.setBindGroup(1, this.objectTable.bindGroup);
    passEncoder.setBindGroup(2, matData.bindGroup);
    if (geoData.skinned && geoData.skinBindGroup) passEncoder.setBindGroup(3, geoData.skinBindGroup);
    passEncoder.setVertexBuffer(0, geoData.positionBuf);
    passEncoder.setVertexBuffer(1, geoData.normalBuf);
    passEncoder.setVertexBuffer(2, geoData.uvBuf);
    for (let i = 0; i < 4; i++) passEncoder.setVertexBuffer(3 + i, geoData.morphPositionBufs[i]);
    this._draw(passEncoder, geoData, undefined, entData.modelSlot);
  }

  private _ensureRenderResources(
    entityId: number,
    geometry: Geometry3D,
    material: BasicMaterial,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    objectSlot?: number,
    objectTable: RendererObjectTable = this.objectTable,
    prepared = false,
  ): Mesh3DRenderResources {
    if (prepared) {
      const geoData = this.geoCache.get(geometry.id);
      const entData = this.entityCache.get(entityId);
      const matData = this.matCache.get(this.rendererCore.materialIdentity(material));
      if (geoData && entData && matData) return { geoData, entData, matData };
    }
    let geoData = this.geoCache.get(geometry.id);
    if (!geoData) {
      geoData = this._uploadGeometry(geometry);
      this.geoCache.set(geometry.id, geoData);
    } else if (
      geoData.version !== geometry.version ||
      geoData.morphVersion !== geometry.morphVersion ||
      geoData.morphUseGpu !== geometry.morphUseGpu ||
      geoData.skinned !== this._hasGpuSkinning(geometry)
    ) {
      this._updateGeometryBuffers(geometry, geoData);
    }
    this._syncSkinningMatrices(geometry, geoData);

    const entData = this.entityCache.ensure(entityId);
    this._writeObjectTableEntry(entData, geometry, clippingPlanes, worldMatrix, objectSlot, objectTable);

    const matData = this.matCache.ensure(this.rendererCore.materialIdentity(material), () => this._createMatGPUData(material));

    return { geoData, entData, matData };
  }

  private _ensureGeometryEntityResources(
    entityId: number,
    geometry: Geometry3D,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    objectSlot?: number,
    objectTable: RendererObjectTable = this.objectTable,
  ): { geoData: GeoGPUData; entData: EntityGPUData } {
    if (this.rendererCore.uploadsPrepared) {
      const geoData = this.geoCache.get(geometry.id);
      const entData = this.entityCache.get(entityId);
      if (geoData && entData) return { geoData, entData };
    }
    let geoData = this.geoCache.get(geometry.id);
    if (!geoData) {
      geoData = this._uploadGeometry(geometry);
      this.geoCache.set(geometry.id, geoData);
    } else if (
      geoData.version !== geometry.version ||
      geoData.morphVersion !== geometry.morphVersion ||
      geoData.morphUseGpu !== geometry.morphUseGpu ||
      geoData.skinned !== this._hasGpuSkinning(geometry)
    ) {
      this._updateGeometryBuffers(geometry, geoData);
    }
    this._syncSkinningMatrices(geometry, geoData);

    const entData = this.entityCache.ensure(entityId);
    this._writeObjectTableEntry(entData, geometry, clippingPlanes, worldMatrix, objectSlot, objectTable);
    return { geoData, entData };
  }

  private _syncBatchMaterialResources(material: BasicMaterial, matData: MatGPUData): void {
    this._syncMaterialTexture(material.texture, matData, 'base');
    this._syncMaterialTexture(material.emissiveTexture, matData, 'emissive');
    const samplerKey = this._samplerKey(material.sampler);
    if (matData.sourceSamplerKey !== samplerKey) {
      matData.sourceSampler = material.sampler;
      matData.sourceSamplerKey = samplerKey;
      matData.sampler = this._createSampler(material.sampler);
      this._rebuildMatBindGroup(matData);
    }
    this._writeMaterialUniform(matData, material);
  }

  private _bindGeometry(
    passEncoder: GPURenderPassEncoder,
    geoData: GeoGPUData,
    entData: EntityGPUData,
    objectTable: RendererObjectTable = this.objectTable,
  ): void {
    passEncoder.setBindGroup(1, objectTable.bindGroup);
    if (geoData.skinned && geoData.skinBindGroup) passEncoder.setBindGroup(3, geoData.skinBindGroup);
    passEncoder.setVertexBuffer(0, geoData.positionBuf);
    passEncoder.setVertexBuffer(1, geoData.normalBuf);
    passEncoder.setVertexBuffer(2, geoData.uvBuf);
    for (let i = 0; i < 4; i++) passEncoder.setVertexBuffer(3 + i, geoData.morphPositionBufs[i]);
  }

  private _draw(passEncoder: GPURenderPassEncoder, geoData: GeoGPUData, gpuDrivenBatch?: MaterialGpuDrivenBatch | undefined, firstInstance = 0): void {
    if (geoData.indexBuf) {
      passEncoder.setIndexBuffer(geoData.indexBuf, geoData.indexFormat);
      if (gpuDrivenBatch) {
        passEncoder.drawIndexedIndirect(gpuDrivenBatch.indexedIndirectBuffer, gpuDrivenBatch.indexedIndirectOffset);
      } else {
        passEncoder.drawIndexed(geoData.indexCount, 1, 0, 0, firstInstance);
      }
    } else {
      if (gpuDrivenBatch) {
        passEncoder.drawIndirect(gpuDrivenBatch.drawIndirectBuffer, gpuDrivenBatch.drawIndirectOffset);
      } else {
        passEncoder.draw(geoData.vertexCount, 1, 0, firstInstance);
      }
    }
  }

  private _drawBatch(
    passEncoder: GPURenderPassEncoder,
    geoData: GeoGPUData,
    batchBuffer: GpuDrivenBatchBuffer,
    batchIndex: number,
  ): void {
    if (geoData.indexBuf) {
      passEncoder.setIndexBuffer(geoData.indexBuf, geoData.indexFormat);
      passEncoder.drawIndexedIndirect(batchBuffer.indexedIndirectBuffer, batchBuffer.getIndexedIndirectOffset(batchIndex));
    } else {
      passEncoder.drawIndirect(batchBuffer.drawIndirectBuffer, batchBuffer.getDrawIndirectOffset(batchIndex));
    }
  }

  private _writeObjectTableEntry(
    entData: EntityGPUData,
    geometry: Geometry3D,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    requestedSlot: number | undefined,
    objectTable: RendererObjectTable,
  ): void {
    const objectSlot = requestedSlot ?? entData.modelSlot;
    objectTable.ensureCapacity(objectSlot + 1);
    const base = objectSlot * OBJECT_TABLE_FLOATS;
    const objectTableData = objectTable.data;
    const isStableSlot = objectTable === this.objectTable && requestedSlot === undefined;
    const enabled = geometry.morphUseGpu && geometry.morphTargets.length > 0;
    const morph0 = enabled ? geometry.morphWeights[0] ?? 0 : 0;
    const morph1 = enabled ? geometry.morphWeights[1] ?? 0 : 0;
    const morph2 = enabled ? geometry.morphWeights[2] ?? 0 : 0;
    const morph3 = enabled ? geometry.morphWeights[3] ?? 0 : 0;
    const skinned = geometry.skinning ? 1 : 0;
    const clipKey = clippingStateKey(clippingPlanes);
    const objectUnchanged =
      isStableSlot &&
      !entData.modelDirty &&
      matrixEquals(entData.modelSnapshot, worldMatrix) &&
      objectTableData[base + OBJECT_TABLE_MORPH_OFFSET] === morph0 &&
      objectTableData[base + OBJECT_TABLE_MORPH_OFFSET + 1] === morph1 &&
      objectTableData[base + OBJECT_TABLE_MORPH_OFFSET + 2] === morph2 &&
      objectTableData[base + OBJECT_TABLE_MORPH_OFFSET + 3] === morph3 &&
      objectTableData[base + OBJECT_TABLE_DEFORMATION_OFFSET] === (enabled ? 1 : 0) &&
      objectTableData[base + OBJECT_TABLE_DEFORMATION_OFFSET + 1] === skinned;
    if (!objectUnchanged) {
      objectTableData.set(worldMatrix, base);
      objectTableData[base + OBJECT_TABLE_MORPH_OFFSET] = morph0;
      objectTableData[base + OBJECT_TABLE_MORPH_OFFSET + 1] = morph1;
      objectTableData[base + OBJECT_TABLE_MORPH_OFFSET + 2] = morph2;
      objectTableData[base + OBJECT_TABLE_MORPH_OFFSET + 3] = morph3;
      objectTableData[base + OBJECT_TABLE_DEFORMATION_OFFSET] = enabled ? 1 : 0;
      objectTableData[base + OBJECT_TABLE_DEFORMATION_OFFSET + 1] = skinned;
      objectTableData[base + OBJECT_TABLE_DEFORMATION_OFFSET + 2] = 0;
      objectTableData[base + OBJECT_TABLE_DEFORMATION_OFFSET + 3] = 0;
      objectTable.writeSlot(objectSlot);
    }
    if (!isStableSlot || entData.clippingKey !== clipKey) {
      writeClippingBlock(objectTable.auxiliaryData, objectSlot * CLIPPING_BLOCK_FLOATS, clippingPlanes);
      objectTable.writeAuxiliarySlot(objectSlot);
    }
    if (isStableSlot) {
      if (!objectUnchanged) {
        entData.modelSnapshot.set(worldMatrix);
        entData.modelDirty = false;
      }
      entData.clippingKey = clipKey;
    }
  }

  private _writeMaterialUniform(matData: MatGPUData, material: BasicMaterial): void {
    material.color.writeSRGB(matData.uniformF32, 0);
    const r = matData.uniformF32[0]!;
    const g = matData.uniformF32[1]!;
    const b = matData.uniformF32[2]!;
    const a = matData.uniformF32[3]!;
    const [er, eg, eb] = material.emissiveFactor;
    const useTexture = matData.textureLoaded ? 1 : 0;
    const useEmissiveTexture = matData.emissiveTextureLoaded ? 1 : 0;
    const color = matData.lastColor;
    const emissiveFactor = matData.lastEmissiveFactor;
    const changed =
      matData.uniformDirty ||
      color[0] !== r ||
      color[1] !== g ||
      color[2] !== b ||
      color[3] !== a ||
      emissiveFactor[0] !== er ||
      emissiveFactor[1] !== eg ||
      emissiveFactor[2] !== eb ||
      matData.lastUseTexture !== useTexture ||
      matData.lastUseEmissiveTexture !== useEmissiveTexture;
    if (!changed) {
      return;
    }

    matData.uniformF32[4] = er;
    matData.uniformF32[5] = eg;
    matData.uniformF32[6] = eb;
    matData.uniformF32[7] = 1;
    matData.uniformU32[8] = useTexture;
    matData.uniformU32[9] = useEmissiveTexture;
    matData.uniformU32[10] = 0;
    matData.uniformU32[11] = 0;
    this.engine.device.queue.writeBuffer(matData.colorBuf, 0, matData.uniformData);

    color[0] = r;
    color[1] = g;
    color[2] = b;
    color[3] = a;
    emissiveFactor[0] = er;
    emissiveFactor[1] = eg;
    emissiveFactor[2] = eb;
    matData.lastUseTexture = useTexture;
    matData.lastUseEmissiveTexture = useEmissiveTexture;
    matData.uniformDirty = false;
  }

  private _getOpaquePipeline(geometry: Geometry3D, material: BasicMaterial): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = material.cullMode ?? geometry.cullMode ?? 'back';
    const frontFace = material.frontFace ?? geometry.frontFace ?? 'ccw';
    const depthWriteEnabled = material.depthWrite;
    const skinned = this._hasGpuSkinning(geometry);
    const stripIndexFormat = getStripIndexFormat(geometry);
    const flags = (depthWriteEnabled ? 1 : 0) | (skinned ? 2 : 0);
    const primitiveKey = encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples, flags);
    const key = this.rendererCore.pipelineKey(
      primitiveKey,
      skinned ? BASIC_MATERIAL_SKINNED_SHADER.featureKey : BASIC_MATERIAL_SHADER.featureKey,
    );
    return this.getCachedPipeline(key, () => this.pipelineFactory.create({
        topology,
        cullMode,
        frontFace,
        stripIndexFormat,
        reverseZ: this.reverseZ,
        msaaSamples: this.msaaSamples,
        depthWriteEnabled,
        skinned,
      }));
  }

  private _getBlendPipeline(
    blending: BlendMode,
    geometry: Geometry3D,
    material: BasicMaterial,
    depthWriteEnabled: boolean,
    depthCompare?: GPUCompareFunction,
  ): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = material.cullMode ?? geometry.cullMode ?? 'back';
    const frontFace = material.frontFace ?? geometry.frontFace ?? 'ccw';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const compare = depthCompare ?? (this.reverseZ ? 'greater' : 'less');
    const skinned = this._hasGpuSkinning(geometry);
    const blendFlag = blending === 'normal' ? 1 : blending === 'additive' ? 2 : 0;
    const flags = blendFlag
      | ((depthWriteEnabled ? 1 : 0) << 2)
      | (encodeCompare(compare) << 3)
      | ((skinned ? 1 : 0) << 6)
      | (1 << 7);
    const primitiveKey = encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples, flags);
    const key = this.rendererCore.pipelineKey(
      primitiveKey,
      skinned ? BASIC_MATERIAL_SKINNED_SHADER.featureKey : BASIC_MATERIAL_SHADER.featureKey,
    );
    return this.getCachedPipeline(key, () => this.pipelineFactory.createBlend(blending, {
      topology,
      cullMode,
      frontFace,
      stripIndexFormat,
      reverseZ: this.reverseZ,
      msaaSamples: this.msaaSamples,
      depthWriteEnabled,
      depthCompare: compare,
      skinned,
    }));
  }

  private _getDepthPrepassPipeline(geometry: Geometry3D, material: BasicMaterial): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = material.cullMode ?? geometry.cullMode ?? 'back';
    const frontFace = material.frontFace ?? geometry.frontFace ?? 'ccw';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const skinned = this._hasGpuSkinning(geometry);
    const flags = (1 << 8) | (skinned ? 1 : 0);
    const primitiveKey = encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples, flags);
    const key = this.rendererCore.pipelineKey(
      primitiveKey,
      skinned ? BASIC_MATERIAL_SKINNED_SHADER.featureKey : BASIC_MATERIAL_SHADER.featureKey,
    );
    return this.getCachedPipeline(key, () => this.pipelineFactory.create({
        topology,
        cullMode,
        frontFace,
        stripIndexFormat,
        reverseZ: this.reverseZ,
        msaaSamples: this.msaaSamples,
        depthWriteEnabled: true,
        colorWriteMask: 0,
        skinned,
      }));
  }

  private _hasGpuSkinning(geo: Geometry3D): boolean {
    return Boolean(geo.skinning);
  }

  private _createMatGPUData(material: BasicMaterial): MatGPUData {
    const { device } = this.engine;
    const uniformData = new ArrayBuffer(48);
    const colorBuf = device.createBuffer({
      size: 48, // color vec4 + emissive vec4 + u32 x 4
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const samplerKey = this._samplerKey(material.sampler);
    const sampler = this._createSampler(material.sampler);
    const bindGroup = device.createBindGroup({
      layout: this.bgl2,
      entries: [
        { binding: 0, resource: { buffer: colorBuf } },
        { binding: 1, resource: this.defaultTexture.createView() },
        { binding: 2, resource: sampler },
        { binding: 3, resource: this.defaultTexture.createView() },
      ],
    });
    return {
      colorBuf,
      gpuTexture: this.defaultTexture,
      emissiveGpuTexture: this.defaultTexture,
      textureHandle: null,
      emissiveTextureHandle: null,
      ownsTexture: false,
      ownsEmissiveTexture: false,
      sampler,
      bindGroup,
      textureLoaded: false,
      emissiveTextureLoaded: false,
      sourceTexture: null,
      sourceEmissiveTexture: null,
      sourceSampler: material.sampler,
      sourceSamplerKey: samplerKey,
      uniformData,
      uniformF32: new Float32Array(uniformData),
      uniformU32: new Uint32Array(uniformData),
      lastColor: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
      lastEmissiveFactor: [Number.NaN, Number.NaN, Number.NaN],
      lastUseTexture: -1,
      lastUseEmissiveTexture: -1,
      uniformDirty: true,
    };
  }

  private _createSampler(descriptor: GPUSamplerDescriptor | null): GPUSampler {
    if (!descriptor) return this.defaultSampler;
    const key = this._samplerKey(descriptor);
    let sampler = this._samplerCache.get(key);
    if (!sampler) {
      sampler = this.engine.device.createSampler(descriptor);
      this._samplerCache.set(key, sampler);
    }
    return sampler;
  }

  private _samplerKey(descriptor: GPUSamplerDescriptor | null): string {
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

  private _rebuildMatBindGroup(matData: MatGPUData): void {
    const { device } = this.engine;
    matData.bindGroup = device.createBindGroup({
      layout: this.bgl2,
      entries: [
        { binding: 0, resource: { buffer: matData.colorBuf } },
        { binding: 1, resource: matData.gpuTexture.createView() },
        { binding: 2, resource: matData.sampler },
        { binding: 3, resource: matData.emissiveGpuTexture.createView() },
      ],
    });
  }

  private _syncMaterialTexture(source: MaterialTextureSource, matData: MatGPUData, slot: 'base' | 'emissive'): void {
    const currentSource = slot === 'base' ? matData.sourceTexture : matData.sourceEmissiveTexture;
    if (isSampleableTextureSource(source)) {
      const texture = source.texture;
      const currentTexture = slot === 'base' ? matData.gpuTexture : matData.emissiveGpuTexture;
      if (currentSource === source && currentTexture === texture) return;
      if (slot === 'base') {
        this._destroyOwnedTexture(matData, 'base');
        matData.gpuTexture = texture;
        matData.ownsTexture = false;
        matData.textureLoaded = true;
        matData.sourceTexture = source;
      } else {
        this._destroyOwnedTexture(matData, 'emissive');
        matData.emissiveGpuTexture = texture;
        matData.ownsEmissiveTexture = false;
        matData.emissiveTextureLoaded = true;
        matData.sourceEmissiveTexture = source;
      }
      this._rebuildMatBindGroup(matData);
      matData.uniformDirty = true;
      return;
    }
    if (isExternalGPUTextureSource(source)) {
      if (currentSource === source) return;
      if (slot === 'base') {
        this._destroyOwnedTexture(matData, 'base');
        matData.gpuTexture = source;
        matData.ownsTexture = false;
        matData.textureLoaded = true;
        matData.sourceTexture = source;
      } else {
        this._destroyOwnedTexture(matData, 'emissive');
        matData.emissiveGpuTexture = source;
        matData.ownsEmissiveTexture = false;
        matData.emissiveTextureLoaded = true;
        matData.sourceEmissiveTexture = source;
      }
      this._rebuildMatBindGroup(matData);
      matData.uniformDirty = true;
      return;
    }
    if (source && currentSource !== source) {
      if (slot === 'base') {
        this._destroyOwnedTexture(matData, 'base');
        matData.gpuTexture = this.defaultTexture;
        matData.ownsTexture = false;
        matData.textureLoaded = false;
        matData.sourceTexture = source;
      } else {
        this._destroyOwnedTexture(matData, 'emissive');
        matData.emissiveGpuTexture = this.defaultTexture;
        matData.ownsEmissiveTexture = false;
        matData.emissiveTextureLoaded = false;
        matData.sourceEmissiveTexture = source;
      }
      matData.uniformDirty = true;
      this._loadTextureAsync(source, matData, slot);
      return;
    }
    if (!source && currentSource !== null) {
      if (slot === 'base') {
        this._destroyOwnedTexture(matData, 'base');
        matData.gpuTexture = this.defaultTexture;
        matData.ownsTexture = false;
        matData.textureLoaded = false;
        matData.sourceTexture = null;
      } else {
        this._destroyOwnedTexture(matData, 'emissive');
        matData.emissiveGpuTexture = this.defaultTexture;
        matData.ownsEmissiveTexture = false;
        matData.emissiveTextureLoaded = false;
        matData.sourceEmissiveTexture = null;
      }
      this._rebuildMatBindGroup(matData);
      matData.uniformDirty = true;
    }
  }

  private async _loadTextureAsync(
    sourceTexture: Exclude<MaterialTextureSource, GPUTexture | SampleableTextureSource | null>,
    matData: MatGPUData,
    slot: 'base' | 'emissive',
  ): Promise<void> {
    try {
      const handle = await this._loadTexture(sourceTexture);
      const gpuTexture = handle.value;
      if (this.rendererCore.destroyed) {
        handle.release();
        return;
      }
      if (slot === 'base') {
        if (matData.sourceTexture !== sourceTexture) {
          handle.release();
          return;
        }
        this._destroyOwnedTexture(matData, 'base');
        matData.gpuTexture = gpuTexture;
        matData.textureHandle = handle;
        matData.ownsTexture = true;
        matData.textureLoaded = true;
      } else {
        if (matData.sourceEmissiveTexture !== sourceTexture) {
          handle.release();
          return;
        }
        this._destroyOwnedTexture(matData, 'emissive');
        matData.emissiveGpuTexture = gpuTexture;
        matData.emissiveTextureHandle = handle;
        matData.ownsEmissiveTexture = true;
        matData.emissiveTextureLoaded = true;
      }
      this._rebuildMatBindGroup(matData);
      matData.uniformDirty = true;
    } catch (e) {
      if (!this.rendererCore.destroyed) console.warn('Failed to load texture:', e);
    }
  }

  private async _loadTexture(
    src: string | ImageBitmap | HTMLCanvasElement | HTMLImageElement | Exclude<MaterialTextureSource, string | ImageBitmap | HTMLCanvasElement | HTMLImageElement | GPUTexture | SampleableTextureSource | null>,
  ): Promise<AssetHandle<GPUTexture>> {
    return this.assetManager.loadTexture(src, { signal: this.rendererCore.signal });
  }

  private _uploadGeometry(geo: Geometry3D): GeoGPUData {
    if (!geo.hasMorphTargets) {
      const shared = this.sharedGeoCache.ensure(geo, this);
      const zeroMorphData = sharedZeroVectorCache.vec3(geo.vertexCount);
      const morphPositionBufs: GPUBuffer[] = [];
      for (let i = 0; i < 4; i++) {
        morphPositionBufs.push(this._makeVertexBuffer(zeroMorphData));
      }
      const skinData = this._createSkinningGpuData(geo);
      return {
        geometryId: geo.id,
        sharedStandard: true,
        positionBuf: shared.positionBuf,
        normalBuf: shared.normalBuf,
        uvBuf: shared.uvBuf,
        morphPositionBufs,
        ...skinData,
        indexBuf: shared.indexBuf,
        indexCount: shared.indexCount,
        vertexCount: shared.vertexCount,
        indexFormat: shared.indexFormat,
        version: geo.version,
        morphVersion: geo.morphVersion,
        morphUseGpu: geo.morphUseGpu,
        skinVersion: geo.skinning?.version ?? -1,
        skinned: this._hasGpuSkinning(geo),
      };
    }

    const positionBuf = this._makeVertexBuffer(
      geo.morphUseGpu && geo.morphBasePositions ? geo.morphBasePositions : geo.positions,
    );
    const normalBuf = this._makeVertexBuffer(
      geo.morphUseGpu && geo.morphBaseNormals ? geo.morphBaseNormals : geo.normals ?? sharedZeroVectorCache.vec3(geo.vertexCount),
    );
    const uvBuf = this._makeVertexBuffer(
      geo.getTextureCoordinatesForChannel(0) ?? sharedZeroVectorCache.vec2(geo.vertexCount),
    );
    const zeroMorphData = sharedZeroVectorCache.vec3(geo.vertexCount);
    const morphPositionBufs: GPUBuffer[] = [];
    for (let i = 0; i < 4; i++) {
      morphPositionBufs.push(this._makeVertexBuffer(geo.morphTargets[i]?.positions ?? zeroMorphData));
    }
    const skinData = this._createSkinningGpuData(geo);

    let indexBuf: GPUBuffer | null = null;
    let indexFormat: GPUIndexFormat = 'uint16';
    if (geo.indices?.length) {
      const indexData = geo.indices;
      const aligned = alignUp4(indexData.byteLength);
      indexBuf = this.engine.device.createBuffer({
        size: aligned,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      writeBufferAligned(this.engine.device.queue, indexBuf, 0, indexData);
      indexFormat = indexData instanceof Uint32Array ? 'uint32' : 'uint16';
    }

    return {
      geometryId: geo.id,
      sharedStandard: false,
      positionBuf,
      normalBuf,
      uvBuf,
      morphPositionBufs,
      ...skinData,
      indexBuf,
      indexCount: geo.indexCount,
      vertexCount: geo.vertexCount,
      indexFormat,
      version: geo.version,
      morphVersion: geo.morphVersion,
      morphUseGpu: geo.morphUseGpu,
      skinVersion: geo.skinning?.version ?? -1,
      skinned: this._hasGpuSkinning(geo),
    };
  }

  private _makeVertexBuffer(data: Float32Array): GPUBuffer {
    const buf = this.engine.device.createBuffer({
      size: Math.max(4, alignUp4(data.byteLength)),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) wrtBuf(this.engine.device.queue, buf, 0, data);
    return buf;
  }

  private _makeStorageBuffer(data: Float32Array): GPUBuffer {
    const buf = this.engine.device.createBuffer({
      size: Math.max(16, alignUp4(data.byteLength)),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    wrtBuf(this.engine.device.queue, buf, 0, data);
    return buf;
  }

  private _updateGeometryBuffers(geo: Geometry3D, data: GeoGPUData): void {
    if (data.sharedStandard) {
      if (geo.hasMorphTargets) {
        this._destroyGeoData(data);
        Object.assign(data, this._uploadGeometry(geo));
        return;
      }
      const shared = this.sharedGeoCache.ensure(geo, this);
      data.positionBuf = shared.positionBuf;
      data.normalBuf = shared.normalBuf;
      data.uvBuf = shared.uvBuf;
      data.indexBuf = shared.indexBuf;
      data.indexCount = shared.indexCount;
      data.vertexCount = shared.vertexCount;
      data.indexFormat = shared.indexFormat;
      data.version = geo.version;
      data.morphVersion = geo.morphVersion;
      data.morphUseGpu = geo.morphUseGpu;
      this._replaceSkinningGpuData(geo, data);
      return;
    }

    if (!geo.hasMorphTargets) {
      this._destroyGeoData(data);
      Object.assign(data, this._uploadGeometry(geo));
      return;
    }

    wrtBuf(this.engine.device.queue, data.positionBuf, 0, geo.morphUseGpu && geo.morphBasePositions ? geo.morphBasePositions : geo.positions);
    wrtBuf(this.engine.device.queue, data.normalBuf, 0, geo.morphUseGpu && geo.morphBaseNormals ? geo.morphBaseNormals : geo.normals ?? sharedZeroVectorCache.vec3(geo.vertexCount));
    wrtBuf(this.engine.device.queue, data.uvBuf, 0, geo.getTextureCoordinatesForChannel(0) ?? sharedZeroVectorCache.vec2(geo.vertexCount));
    data.version = geo.version;
    data.morphVersion = geo.morphVersion;
    data.morphUseGpu = geo.morphUseGpu;
    this._replaceSkinningGpuData(geo, data);
  }

  private _createSkinningGpuData(geo: Geometry3D): Pick<GeoGPUData, 'skinJointBuf' | 'skinWeightBuf' | 'skinMatrixBuf' | 'skinBindGroup'> {
    const skinning = geo.skinning;
    if (!skinning) {
      return { skinJointBuf: null, skinWeightBuf: null, skinMatrixBuf: null, skinBindGroup: null };
    }
    const skinMatrixBuf = this.engine.device.createBuffer({
      size: Math.max(64, alignUp4(skinning.jointMatrices.byteLength)),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    wrtBuf(this.engine.device.queue, skinMatrixBuf, 0, skinning.jointMatrices);
    const skinJointBuf = this._makeStorageBuffer(skinning.joints);
    const skinWeightBuf = this._makeStorageBuffer(skinning.weights);
    return {
      skinJointBuf,
      skinWeightBuf,
      skinMatrixBuf,
      skinBindGroup: this.engine.device.createBindGroup({
        layout: this.bgl3,
        entries: [
          { binding: 0, resource: { buffer: skinMatrixBuf } },
          { binding: 1, resource: { buffer: skinJointBuf } },
          { binding: 2, resource: { buffer: skinWeightBuf } },
        ],
      }),
    };
  }

  private _replaceSkinningGpuData(geo: Geometry3D, data: GeoGPUData): void {
    data.skinJointBuf?.destroy();
    data.skinWeightBuf?.destroy();
    data.skinMatrixBuf?.destroy();
    const skinData = this._createSkinningGpuData(geo);
    data.skinJointBuf = skinData.skinJointBuf;
    data.skinWeightBuf = skinData.skinWeightBuf;
    data.skinMatrixBuf = skinData.skinMatrixBuf;
    data.skinBindGroup = skinData.skinBindGroup;
    data.skinVersion = geo.skinning?.version ?? -1;
    data.skinned = this._hasGpuSkinning(geo);
  }

  private _syncSkinningMatrices(geo: Geometry3D, data: GeoGPUData): void {
    const skinning = geo.skinning;
    if (!skinning || !data.skinMatrixBuf || data.skinVersion === skinning.version) return;
    wrtBuf(this.engine.device.queue, data.skinMatrixBuf, 0, skinning.jointMatrices);
    data.skinVersion = skinning.version;
  }

  private _deferTextureDestroy(texture: GPUTexture): void {
    const device = this.engine.device;
    void device.queue.onSubmittedWorkDone()
      .then(() => texture.destroy())
      .catch(() => {
        try {
          texture.destroy();
        } catch {
          // Device may already be lost/destroyed during teardown.
        }
      });
  }

  private _destroyOwnedTexture(matData: MatGPUData, slot: 'base' | 'emissive'): void {
    if (slot === 'base') {
      if (matData.ownsTexture && matData.gpuTexture !== this.defaultTexture) {
        if (matData.textureHandle) matData.textureHandle.release();
        else this._deferTextureDestroy(matData.gpuTexture);
      }
      matData.textureHandle = null;
      matData.ownsTexture = false;
      return;
    }
    if (matData.ownsEmissiveTexture && matData.emissiveGpuTexture !== this.defaultTexture) {
      if (matData.emissiveTextureHandle) matData.emissiveTextureHandle.release();
      else this._deferTextureDestroy(matData.emissiveGpuTexture);
    }
    matData.emissiveTextureHandle = null;
    matData.ownsEmissiveTexture = false;
  }

  private _destroyGeoData(data: GeoGPUData): void {
    if (data.sharedStandard) {
      this.sharedGeoCache?.release(data.geometryId, this);
    } else {
      data.positionBuf.destroy();
      data.normalBuf.destroy();
      data.uvBuf.destroy();
      data.indexBuf?.destroy();
    }
    for (const buf of data.morphPositionBufs) buf.destroy();
    data.skinJointBuf?.destroy();
    data.skinWeightBuf?.destroy();
    data.skinMatrixBuf?.destroy();
  }

  private _destroyMatData(data: MatGPUData): void {
    data.colorBuf.destroy();
    this._destroyOwnedTexture(data, 'base');
    this._destroyOwnedTexture(data, 'emissive');
  }

  destroy(): void {
    this.sceneFrameBinding?.destroy();
    this.rendererCore?.destroy();
    this.matCache.clear();
    if (this.ownsAssetManager) this.assetManager?.dispose();
    this._samplerCache.clear();
    this.defaultTexture?.destroy();
    this.clearPipelineCache();
  }
}

function isExternalGPUTextureSource(source: MaterialTextureSource): source is GPUTexture {
  if (!source || typeof source === 'string') return false;
  return Object.prototype.toString.call(source) === '[object GPUTexture]' ||
    typeof (source as GPUTexture).createView === 'function';
}

function isSampleableTextureSource(source: MaterialTextureSource): source is SampleableTextureSource {
  if (!source || typeof source === 'string' || isExternalGPUTextureSource(source)) return false;
  const texture = (source as Partial<SampleableTextureSource>).texture;
  return texture != null && typeof texture.createView === 'function';
}
