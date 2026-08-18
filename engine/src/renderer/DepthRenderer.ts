import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import { Geometry3D, type Skinning3D } from '../geometry/Geometry3D';
import { DepthMaterial } from '../material/DepthMaterial';
import { BaseRenderer } from './BaseRenderer';
import type { SharedGeometry3DGPUData } from './SharedGeometry3DGPUCache';
import { encodePrimitivePipelineKey } from './pipelineKey';
import { getStripIndexFormat, matrixEquals, writeBuffer as wrtBuf } from './utils';
import type { LiveIdSet } from './utils';
import type { MaterialGpuDrivenBatch, MaterialRenderBatchItem } from './MaterialRendererRegistry';
import { createPrimitiveState } from './gpuDescriptors';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { getBuiltinDeformationShader } from '../shader/BuiltinDeformationShader';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import { RendererCacheMap, RendererObjectSlotCache } from './RendererCacheMap';
import { RendererObjectTable } from './RendererObjectTable';
import type { GpuDrivenBatchBuffer } from './GpuDrivenBatchBuffer';
import { forEachDirectInstanceBatchRun } from './DirectInstanceBatchRuns';
import { sharedZeroVectorCache } from './ZeroVectorCache';
import { alignUp4 } from '../utils/align';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { CLIPPING_BLOCK_FLOATS, clippingStateKey, writeClippingBlock } from './ClippingPlanesGpu';
import { ParameterizedRendererCore, SharedGeometryRendererOwner } from './ParameterizedRendererCore';

interface EntityGPUData {
  modelSlot: number;
  modelSnapshot: Float32Array;
  modelDirty: boolean;
  clippingKey: string;
}

const OBJECT_TABLE_FLOATS = 24;
const OBJECT_TABLE_MORPH_OFFSET = 16;
const OBJECT_TABLE_DEFORMATION_OFFSET = 20;

interface DepthDeformationGpuData {
  vertexCount: number;
  morphEnabled: boolean;
  morphSources: readonly (Float32Array | null)[];
  morphBuffers: GPUBuffer[];
  skinning: Skinning3D | null;
  skinJointSource: Float32Array | null;
  skinWeightSource: Float32Array | null;
  skinMatrixSource: Float32Array | null;
  skinJointBuffer: GPUBuffer | null;
  skinWeightBuffer: GPUBuffer | null;
  skinMatrixBuffer: GPUBuffer | null;
  skinBindGroup: GPUBindGroup;
  skinVersion: number;
}

interface MatGPUData {
  paramsBuf: GPUBuffer;
  paramsBindGroup: GPUBindGroup;
  paramsData: ArrayBuffer;
  paramsF32: Float32Array;
  paramsU32: Uint32Array;
  lastNear: number;
  lastFar: number;
  lastIsOrthographic: number;
  lastReverseZ: number;
  paramsDirty: boolean;
}

export class DepthRenderer extends BaseRenderer {
  readonly type = 'depth';

  reverseZ = false;
  msaaSamples: 1 | 4 = 1;
  /** Optional auxiliary target override; ordinary material rendering uses the engine surface format. */
  colorFormat: GPUTextureFormat | null = null;

  private engine!: IEngine;
  private bgl0!: GPUBindGroupLayout;
  private bgl1!: GPUBindGroupLayout;
  private bgl2!: GPUBindGroupLayout;
  private bgl3!: GPUBindGroupLayout;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;

  private sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly cameraDynamicOffset = new Uint32Array(1);
  private rendererCore!: ParameterizedRendererCore<EntityGPUData, SharedGeometry3DGPUData>;
  private get objectTable(): RendererObjectTable { return this.rendererCore.requireObjectTable(); }
  private get batchObjectTable(): RendererObjectTable { return this.rendererCore.requireBatchObjectTable(); }
  private get geoCache(): SharedGeometryRendererOwner { return this.rendererCore.geometry as SharedGeometryRendererOwner; }
  private get entityCache(): RendererObjectSlotCache<EntityGPUData> { return this.rendererCore.requireObjects(); }
  private matCache   = new Map<number, MatGPUData>();
  private deformationCache = new RendererCacheMap<DepthDeformationGpuData>(data => this._destroyDeformation(data));
  private fallbackSkinMatrixBuffer!: GPUBuffer;
  private fallbackSkinAttributeBuffer!: GPUBuffer;
  private fallbackSkinBindGroup!: GPUBindGroup;

  private _initialized = false;

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    super.clearPipelineCache();
    this._initialized = true;
    this.engine = engine;
    const { device } = engine;
    this.sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this.bgl0 = this.sceneFrameBinding.bindGroupLayout;
    this.bgl1 = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ] });
    this.bgl2 = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.bgl3 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    const generated = getBuiltinDeformationShader(device, 'depth', [this.bgl0, this.bgl1, this.bgl2, this.bgl3]);
    this.shader = generated.module;
    this.pipelineLayout = generated.pipelineLayout;
    this.rendererCore = new ParameterizedRendererCore({
      objectTables: {
        device,
        bindGroupLayout: this.bgl1,
        label: 'DepthRenderer',
        floatsPerSlot: OBJECT_TABLE_FLOATS,
        auxiliary: { binding: 1, floatsPerSlot: CLIPPING_BLOCK_FLOATS, label: 'DepthRenderer.clippingTable' },
      },
      createObject: modelSlot => ({
        modelSlot,
        modelSnapshot: new Float32Array(16),
        modelDirty: true,
        clippingKey: '',
      }),
      geometry: new SharedGeometryRendererOwner(device, this, getEngineGPUResourceTracker(engine)),
    });
    this._createFallbackSkinning();

  }

  beginView(sceneFrame: SceneFrameUniformSnapshot, context?: RenderCommandContext): void {
    this.cameraDynamicOffset[0] = this.sceneFrameBinding.upload(sceneFrame, context);
    this.rendererCore.beginUploads(context);
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = encodePrimitivePipelineKey('triangle-list', 'back', 'ccw', undefined, this.reverseZ, this.msaaSamples);
    this.addPipelineWarmup(plan, key, 'Depth material', () => (
      this._pipelineDescriptor('triangle-list', 'back', 'ccw', undefined)
    ), this.engine.device);
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    this.entityCache.releaseNotIn(liveEntities);
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    this.geoCache.releaseUnused(this, liveGeometries);
    this.deformationCache.releaseNotIn(liveGeometries);
  }

  releaseMaterialsNotIn(liveMaterials: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this.matCache, liveMaterials, data => data.paramsBuf.destroy());
  }

  prepareObjects(
    items: readonly MaterialRenderBatchItem<DepthMaterial>[],
    first = 0,
    count = items.length - first,
    firstBatchIndex = first,
    batchBuffer: GpuDrivenBatchBuffer | null = null,
  ): void {
    const end = Math.min(items.length, first + count);
    for (let index = first; index < end; index++) {
      const item = items[index];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      const objectSlot = batchBuffer?.getObjectSlot(firstBatchIndex + index - first);
      this._prepareObject(
        item.entityId,
        item.geometry,
        item.material,
        item.clippingPlanes,
        item.worldMatrix,
        objectSlot,
        objectSlot === undefined ? this.objectTable : this.batchObjectTable,
      );
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
    material: DepthMaterial,
    worldMatrix: Float32Array,
    options: { gpuDrivenBatch?: MaterialGpuDrivenBatch | undefined } = {},
    clippingPlanes: ClippingPlanes | null = null,
  ): void {
    const objectSlot = options.gpuDrivenBatch?.objectSlot;
    const objectTable = objectSlot === undefined ? this.objectTable : this.batchObjectTable;
    const { geoData, entData, matData, deformation } = this._prepareObject(
      entityId,
      geometry,
      material,
      clippingPlanes,
      worldMatrix,
      objectSlot,
      objectTable,
    );
    if (!this.rendererCore.uploadsPrepared) objectTable.flushUploads();

    const pipeline = this._getPipeline(geometry);
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    passEncoder.setBindGroup(1, objectTable.bindGroup);
    passEncoder.setBindGroup(2, matData.paramsBindGroup);
    passEncoder.setBindGroup(3, deformation.skinBindGroup);
    passEncoder.setVertexBuffer(0, geoData.positionBuf);
    for (let index = 0; index < 4; index++) passEncoder.setVertexBuffer(index + 1, deformation.morphBuffers[index]!);

    const firstInstance = objectSlot ?? entData.modelSlot;
    if (geoData.indexBuf) {
      passEncoder.setIndexBuffer(geoData.indexBuf, geoData.indexFormat);
      if (options.gpuDrivenBatch) {
        passEncoder.drawIndexedIndirect(options.gpuDrivenBatch.indexedIndirectBuffer, options.gpuDrivenBatch.indexedIndirectOffset);
      } else {
        passEncoder.drawIndexed(geoData.indexCount, 1, 0, 0, firstInstance);
      }
    } else {
      if (options.gpuDrivenBatch) {
        passEncoder.drawIndirect(options.gpuDrivenBatch.drawIndirectBuffer, options.gpuDrivenBatch.drawIndirectOffset);
      } else {
        passEncoder.draw(geoData.vertexCount, 1, 0, firstInstance);
      }
    }
  }

  renderBatch(
    passEncoder: GPURenderPassEncoder,
    items: readonly MaterialRenderBatchItem<DepthMaterial>[],
    first: number,
    count: number,
    batchBuffer: GpuDrivenBatchBuffer,
  ): void {
    if (batchBuffer.gpuUploadEnabled === false) {
      forEachDirectInstanceBatchRun(items, first, count, batchBuffer, run => {
        const resources = this._prepareObject(
          run.item.entityId,
          run.item.geometry,
          run.item.material,
          run.item.clippingPlanes,
          run.item.worldMatrix,
          run.firstInstance,
          this.batchObjectTable,
        );
        this._bindBatchResources(passEncoder, run.item.geometry, resources);
        this._drawDirect(passEncoder, resources.geoData, run.instanceCount, run.firstInstance);
      });
      return;
    }

    const end = Math.min(items.length, first + count);
    for (let index = first; index < end; index++) {
      const item = items[index];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      const objectSlot = batchBuffer.getObjectSlot(index);
      const resources = this._prepareObject(
        item.entityId,
        item.geometry,
        item.material,
        item.clippingPlanes,
        item.worldMatrix,
        objectSlot,
        this.batchObjectTable,
      );
      this._bindBatchResources(passEncoder, item.geometry, resources);
      if (resources.geoData.indexBuf) {
        passEncoder.setIndexBuffer(resources.geoData.indexBuf, resources.geoData.indexFormat);
        passEncoder.drawIndexedIndirect(
          batchBuffer.indexedIndirectBuffer,
          batchBuffer.getIndexedIndirectOffset(index),
        );
      } else {
        passEncoder.drawIndirect(batchBuffer.drawIndirectBuffer, batchBuffer.getDrawIndirectOffset(index));
      }
    }
  }

  private _prepareObject(
    entityId: number,
    geometry: Geometry3D,
    material: DepthMaterial,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    requestedSlot?: number,
    objectTable: RendererObjectTable = this.objectTable,
  ) {
    const { device } = this.engine;
    const geoData = this.geoCache.ensure(geometry, this);
    const deformation = this._ensureDeformation(geometry);
    this._syncSkinningMatrices(geometry, deformation);
    const entData = this.entityCache.ensure(entityId);
    this._writeObjectTableEntry(entData, geometry, clippingPlanes, worldMatrix, requestedSlot, objectTable);
    const materialId = this.rendererCore.materialIdentity(material);
    let matData = this.matCache.get(materialId);
    if (!matData) {
      const paramsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const paramsData = new ArrayBuffer(16);
      matData = {
        paramsBuf,
        paramsBindGroup: device.createBindGroup({
          layout: this.bgl2,
          entries: [{ binding: 0, resource: { buffer: paramsBuf } }],
        }),
        paramsData,
        paramsF32: new Float32Array(paramsData),
        paramsU32: new Uint32Array(paramsData),
        lastNear: Number.NaN,
        lastFar: Number.NaN,
        lastIsOrthographic: -1,
        lastReverseZ: -1,
        paramsDirty: true,
      };
      this.matCache.set(materialId, matData);
    }
    const isOrthographic = material.isOrthographic ? 1 : 0;
    const reverseZ = this.reverseZ ? 1 : 0;
    if (
      matData.paramsDirty
      || matData.lastNear !== material.near
      || matData.lastFar !== material.far
      || matData.lastIsOrthographic !== isOrthographic
      || matData.lastReverseZ !== reverseZ
    ) {
      matData.paramsF32[0] = material.near;
      matData.paramsF32[1] = material.far;
      matData.paramsU32[2] = isOrthographic;
      matData.paramsU32[3] = reverseZ;
      device.queue.writeBuffer(matData.paramsBuf, 0, matData.paramsData);
      matData.lastNear = material.near;
      matData.lastFar = material.far;
      matData.lastIsOrthographic = isOrthographic;
      matData.lastReverseZ = reverseZ;
      matData.paramsDirty = false;
    }
    return { geoData, entData, matData, deformation };
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
    const objectData = objectTable.data;
    const morphEnabled = geometry.morphUseGpu && geometry.hasMorphTargets;
    const morph0 = morphEnabled ? geometry.morphWeights[0] ?? 0 : 0;
    const morph1 = morphEnabled ? geometry.morphWeights[1] ?? 0 : 0;
    const morph2 = morphEnabled ? geometry.morphWeights[2] ?? 0 : 0;
    const morph3 = morphEnabled ? geometry.morphWeights[3] ?? 0 : 0;
    const skinned = geometry.skinning ? 1 : 0;
    const stable = objectTable === this.objectTable && requestedSlot === undefined;
    const clipKey = clippingStateKey(clippingPlanes);
    const objectUnchanged =
      stable
      && !entData.modelDirty
      && matrixEquals(entData.modelSnapshot, worldMatrix)
      && objectData[base + OBJECT_TABLE_MORPH_OFFSET] === morph0
      && objectData[base + OBJECT_TABLE_MORPH_OFFSET + 1] === morph1
      && objectData[base + OBJECT_TABLE_MORPH_OFFSET + 2] === morph2
      && objectData[base + OBJECT_TABLE_MORPH_OFFSET + 3] === morph3
      && objectData[base + OBJECT_TABLE_DEFORMATION_OFFSET] === (morphEnabled ? 1 : 0)
      && objectData[base + OBJECT_TABLE_DEFORMATION_OFFSET + 1] === skinned;
    if (!objectUnchanged) {
      objectData.set(worldMatrix, base);
      objectData[base + OBJECT_TABLE_MORPH_OFFSET] = morph0;
      objectData[base + OBJECT_TABLE_MORPH_OFFSET + 1] = morph1;
      objectData[base + OBJECT_TABLE_MORPH_OFFSET + 2] = morph2;
      objectData[base + OBJECT_TABLE_MORPH_OFFSET + 3] = morph3;
      objectData[base + OBJECT_TABLE_DEFORMATION_OFFSET] = morphEnabled ? 1 : 0;
      objectData[base + OBJECT_TABLE_DEFORMATION_OFFSET + 1] = skinned;
      objectData[base + OBJECT_TABLE_DEFORMATION_OFFSET + 2] = 0;
      objectData[base + OBJECT_TABLE_DEFORMATION_OFFSET + 3] = 0;
      objectTable.writeSlot(objectSlot);
    }
    if (!stable || entData.clippingKey !== clipKey) {
      writeClippingBlock(objectTable.auxiliaryData, objectSlot * CLIPPING_BLOCK_FLOATS, clippingPlanes);
      objectTable.writeAuxiliarySlot(objectSlot);
    }
    if (stable) {
      if (!objectUnchanged) {
        entData.modelSnapshot.set(worldMatrix);
        entData.modelDirty = false;
      }
      entData.clippingKey = clipKey;
    }
  }

  private _bindBatchResources(
    passEncoder: GPURenderPassEncoder,
    geometry: Geometry3D,
    resources: {
      geoData: SharedGeometry3DGPUData;
      matData: MatGPUData;
      deformation: DepthDeformationGpuData;
    },
  ): void {
    passEncoder.setPipeline(this._getPipeline(geometry));
    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    passEncoder.setBindGroup(1, this.batchObjectTable.bindGroup);
    passEncoder.setBindGroup(2, resources.matData.paramsBindGroup);
    passEncoder.setBindGroup(3, resources.deformation.skinBindGroup);
    passEncoder.setVertexBuffer(0, resources.geoData.positionBuf);
    for (let index = 0; index < 4; index++) {
      passEncoder.setVertexBuffer(index + 1, resources.deformation.morphBuffers[index]!);
    }
  }

  private _drawDirect(
    passEncoder: GPURenderPassEncoder,
    geoData: SharedGeometry3DGPUData,
    instanceCount: number,
    firstInstance: number,
  ): void {
    if (geoData.indexBuf) {
      passEncoder.setIndexBuffer(geoData.indexBuf, geoData.indexFormat);
      passEncoder.drawIndexed(geoData.indexCount, instanceCount, 0, 0, firstInstance);
    } else {
      passEncoder.draw(geoData.vertexCount, instanceCount, 0, firstInstance);
    }
  }

  private _createFallbackSkinning(): void {
    this.fallbackSkinMatrixBuffer = this._makeStorageBuffer(new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]), 64);
    this.fallbackSkinAttributeBuffer = this._makeStorageBuffer(new Float32Array(4));
    this.fallbackSkinBindGroup = this.engine.device.createBindGroup({
      layout: this.bgl3,
      entries: [
        { binding: 0, resource: { buffer: this.fallbackSkinMatrixBuffer } },
        { binding: 1, resource: { buffer: this.fallbackSkinAttributeBuffer } },
        { binding: 2, resource: { buffer: this.fallbackSkinAttributeBuffer } },
      ],
    });
  }

  private _ensureDeformation(geometry: Geometry3D): DepthDeformationGpuData {
    const morphEnabled = geometry.morphUseGpu && geometry.hasMorphTargets;
    let data = this.deformationCache.get(geometry.id);
    if (!data || !this._deformationMatches(data, geometry, morphEnabled)) {
      data = this._createDeformation(geometry, morphEnabled);
      this.deformationCache.set(geometry.id, data);
    }
    return data;
  }

  private _deformationMatches(
    data: DepthDeformationGpuData,
    geometry: Geometry3D,
    morphEnabled: boolean,
  ): boolean {
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

  private _createDeformation(geometry: Geometry3D, morphEnabled: boolean): DepthDeformationGpuData {
    const morphSources = Array.from({ length: 4 }, (_, index) =>
      morphEnabled ? geometry.morphTargets[index]?.positions ?? null : null);
    const zeroMorph = sharedZeroVectorCache.vec3(geometry.vertexCount);
    let zeroMorphBuffer: GPUBuffer | null = null;
    const morphBuffers = morphSources.map(source => {
      if (!source) {
        zeroMorphBuffer ??= this._makeVertexBuffer(zeroMorph);
        return zeroMorphBuffer;
      }
      return this._makeVertexBuffer(source);
    });
    const skinning = geometry.skinning;
    const skinMatrixBuffer = skinning ? this._makeStorageBuffer(skinning.jointMatrices, 64) : null;
    const skinJointBuffer = skinning ? this._makeStorageBuffer(skinning.joints) : null;
    const skinWeightBuffer = skinning ? this._makeStorageBuffer(skinning.weights) : null;
    const skinBindGroup = skinMatrixBuffer && skinJointBuffer && skinWeightBuffer
      ? this.engine.device.createBindGroup({
          layout: this.bgl3,
          entries: [
            { binding: 0, resource: { buffer: skinMatrixBuffer } },
            { binding: 1, resource: { buffer: skinJointBuffer } },
            { binding: 2, resource: { buffer: skinWeightBuffer } },
          ],
        })
      : this.fallbackSkinBindGroup;
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

  private _makeVertexBuffer(data: Float32Array): GPUBuffer {
    const buffer = this.engine.device.createBuffer({
      size: Math.max(4, alignUp4(data.byteLength)),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) wrtBuf(this.engine.device.queue, buffer, 0, data);
    return buffer;
  }

  private _makeStorageBuffer(data: Float32Array, minimumSize = 16): GPUBuffer {
    const buffer = this.engine.device.createBuffer({
      size: Math.max(minimumSize, alignUp4(data.byteLength)),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) wrtBuf(this.engine.device.queue, buffer, 0, data);
    return buffer;
  }

  private _syncSkinningMatrices(geometry: Geometry3D, data: DepthDeformationGpuData): void {
    const skinning = geometry.skinning;
    if (!skinning || !data.skinMatrixBuffer || data.skinVersion === skinning.version) return;
    wrtBuf(this.engine.device.queue, data.skinMatrixBuffer, 0, skinning.jointMatrices);
    data.skinVersion = skinning.version;
  }

  private _destroyDeformation(data: DepthDeformationGpuData): void {
    for (const buffer of new Set(data.morphBuffers)) buffer.destroy();
    data.skinJointBuffer?.destroy();
    data.skinWeightBuffer?.destroy();
    data.skinMatrixBuffer?.destroy();
  }

  private _getPipeline(geometry: Geometry3D): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = geometry.cullMode ?? 'back';
    const frontFace = geometry.frontFace ?? 'ccw';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const key = `${encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples)}:${this.colorFormat ?? this.engine.format}`;
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(
      this._pipelineDescriptor(topology, cullMode, frontFace, stripIndexFormat),
    ));
  }

  private _pipelineDescriptor(
    topology: GPUPrimitiveTopology,
    cullMode: GPUCullMode,
    frontFace: GPUFrontFace,
    stripIndexFormat: GPUIndexFormat | undefined,
  ): GPURenderPipelineDescriptor {
      return {
        layout: this.pipelineLayout,
        vertex: {
          module: this.shader,
          entryPoint: 'vs_main',
          buffers: [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            ...Array.from({ length: 4 }, (_, index): GPUVertexBufferLayout => ({
              arrayStride: 12,
              attributes: [{ shaderLocation: index + 1, offset: 0, format: 'float32x3' }],
            })),
          ],
        },
        fragment: { module: this.shader, entryPoint: 'fs_main', targets: [{ format: this.colorFormat ?? this.engine.format }] },
        primitive: createPrimitiveState(topology, cullMode, frontFace, stripIndexFormat),
        depthStencil: {
          format: this.engine.getDepthFormat(this.reverseZ),
          depthWriteEnabled: true,
          depthCompare: this.reverseZ ? 'greater' : 'less',
        },
        multisample: { count: this.msaaSamples },
      };
  }

  destroy(): void {
    this.sceneFrameBinding?.destroy();
    this.rendererCore?.destroy();
    this.deformationCache.clear();
    this.fallbackSkinMatrixBuffer?.destroy();
    this.fallbackSkinAttributeBuffer?.destroy();
    this.destroyCacheEntries(this.matCache, material => material.paramsBuf.destroy());
    this.clearPipelineCache();
  }
}
