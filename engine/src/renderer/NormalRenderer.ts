import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import { Geometry3D } from '../geometry/Geometry3D';
import { NormalMaterial } from '../material/NormalMaterial';
import { mat4 } from 'wgpu-matrix';
import { BaseRenderer } from './BaseRenderer';
import type { SharedGeometry3DGPUData } from './SharedGeometry3DGPUCache';
import { encodePrimitivePipelineKey } from './pipelineKey';
import { getStripIndexFormat, matrixEquals, writeBuffer as wrtBuf } from './utils';
import type { LiveIdSet } from './utils';
import type { MaterialGpuDrivenBatch, MaterialRenderBatchItem } from './MaterialRendererRegistry';
import { createPrimitiveState } from './gpuDescriptors';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import { RendererObjectTable } from './RendererObjectTable';
import { RendererObjectSlotCache } from './RendererCacheMap';
import type { GpuDrivenBatchBuffer } from './GpuDrivenBatchBuffer';
import { forEachDirectInstanceBatchRun } from './DirectInstanceBatchRuns';
import { getBuiltinSimple3dShader } from '../shader/BuiltinSimple3dShader';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { CLIPPING_BLOCK_FLOATS, clippingStateKey, writeClippingBlock } from './ClippingPlanesGpu';
import { ParameterizedRendererCore, SharedGeometryRendererOwner } from './ParameterizedRendererCore';

interface EntityGPUData {
  modelSlot: number;
  modelSnapshot: Float32Array;
  objectDirty: boolean;
  clippingKey: string;
}

const OBJECT_TABLE_FLOATS = 32;

interface MatGPUData {
  paramsBuf: GPUBuffer;
  paramsBindGroup: GPUBindGroup;
  paramsData: Uint32Array;
  lastSpace: number;
  paramsDirty: boolean;
}

export class NormalRenderer extends BaseRenderer {
  readonly type = 'normal';

  reverseZ = false;
  msaaSamples: 1 | 4 = 1;
  /** Optional auxiliary target override; ordinary material rendering uses the engine surface format. */
  colorFormat: GPUTextureFormat | null = null;

  private engine!: IEngine;
  private bgl0!: GPUBindGroupLayout;
  private bgl1!: GPUBindGroupLayout;
  private bgl2!: GPUBindGroupLayout;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;

  private sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly cameraDynamicOffset = new Uint32Array(1);
  private rendererCore!: ParameterizedRendererCore<EntityGPUData, SharedGeometry3DGPUData>;
  private get objectTable(): RendererObjectTable { return this.rendererCore.requireObjectTable(); }
  private get batchObjectTable(): RendererObjectTable { return this.rendererCore.requireBatchObjectTable(); }
  private get geoCache(): SharedGeometryRendererOwner { return this.rendererCore.geometry as SharedGeometryRendererOwner; }
  private get entityCache(): RendererObjectSlotCache<EntityGPUData> { return this.rendererCore.requireObjects(); }
  private matCache = new Map<number, MatGPUData>();

  private _initialized = false;
  private _inverseScratch = mat4.identity() as Float32Array;
  private _normalScratch = mat4.identity() as Float32Array;

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this.clearPipelineCache();
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
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });

    const generated = getBuiltinSimple3dShader(device, 'normal-material', [this.bgl0, this.bgl1, this.bgl2]);
    this.shader = generated.module;
    this.pipelineLayout = generated.pipelineLayout;
    this.rendererCore = new ParameterizedRendererCore({
      objectTables: {
        device,
        bindGroupLayout: this.bgl1,
        label: 'NormalRenderer',
        floatsPerSlot: OBJECT_TABLE_FLOATS,
        auxiliary: { binding: 1, floatsPerSlot: CLIPPING_BLOCK_FLOATS, label: 'NormalRenderer.clippingTable' },
      },
      createObject: modelSlot => ({
        modelSlot,
        modelSnapshot: new Float32Array(16),
        objectDirty: true,
        clippingKey: '',
      }),
      geometry: new SharedGeometryRendererOwner(device, this, getEngineGPUResourceTracker(engine)),
    });
  }

  beginView(sceneFrame: SceneFrameUniformSnapshot, context?: RenderCommandContext): void {
    this.cameraDynamicOffset[0] = this.sceneFrameBinding.upload(sceneFrame, context);
    this.rendererCore.beginUploads(context);
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = encodePrimitivePipelineKey('triangle-list', 'back', 'ccw', undefined, this.reverseZ, this.msaaSamples);
    this.addPipelineWarmup(plan, key, 'Normal material', () => (
      this._pipelineDescriptor('triangle-list', 'back', 'ccw', undefined)
    ), this.engine.device);
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    this.entityCache.releaseNotIn(liveEntities);
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    this.geoCache.releaseUnused(this, liveGeometries);
  }

  releaseMaterialsNotIn(liveMaterials: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this.matCache, liveMaterials, data => data.paramsBuf.destroy());
  }

  prepareObjects(
    items: readonly MaterialRenderBatchItem<NormalMaterial>[],
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
    material: NormalMaterial,
    worldMatrix: Float32Array,
    options: { gpuDrivenBatch?: MaterialGpuDrivenBatch | undefined } = {},
    clippingPlanes: ClippingPlanes | null = null,
  ): void {
    const objectSlot = options.gpuDrivenBatch?.objectSlot;
    const objectTable = objectSlot === undefined ? this.objectTable : this.batchObjectTable;
    const { geoData, entData, matData } = this._prepareObject(
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
    passEncoder.setVertexBuffer(0, geoData.positionBuf);
    passEncoder.setVertexBuffer(1, geoData.normalBuf);

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
    items: readonly MaterialRenderBatchItem<NormalMaterial>[],
    first: number,
    count: number,
    batchBuffer: GpuDrivenBatchBuffer,
  ): void {
    if (batchBuffer.gpuUploadEnabled === false) {
      forEachDirectInstanceBatchRun(items, first, count, batchBuffer, run => {
        const item = run.item;
        const { geoData, matData } = this._prepareObject(
          item.entityId,
          item.geometry,
          item.material,
          item.clippingPlanes,
          item.worldMatrix,
          run.firstInstance,
          this.batchObjectTable,
        );
        this._bindBatchResources(passEncoder, item.geometry, geoData, matData);
        this._drawDirect(passEncoder, geoData, run.instanceCount, run.firstInstance);
      });
      return;
    }

    const end = Math.min(items.length, first + count);
    for (let index = first; index < end; index++) {
      const item = items[index];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      const objectSlot = batchBuffer.getObjectSlot(index);
      const { geoData, matData } = this._prepareObject(
        item.entityId,
        item.geometry,
        item.material,
        item.clippingPlanes,
        item.worldMatrix,
        objectSlot,
        this.batchObjectTable,
      );
      this._bindBatchResources(passEncoder, item.geometry, geoData, matData);
      if (geoData.indexBuf) {
        passEncoder.setIndexBuffer(geoData.indexBuf, geoData.indexFormat);
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
    material: NormalMaterial,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    requestedSlot?: number,
    objectTable: RendererObjectTable = this.objectTable,
  ) {
    const { device } = this.engine;
    const geoData = this.geoCache.ensure(geometry, this);
    const entData = this.entityCache.ensure(entityId);
    this._writeObjectTableEntry(entData, clippingPlanes, worldMatrix, requestedSlot, objectTable);
    const materialId = this.rendererCore.materialIdentity(material);
    let matData = this.matCache.get(materialId);
    if (!matData) {
      const paramsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      matData = {
        paramsBuf,
        paramsBindGroup: device.createBindGroup({
          layout: this.bgl2,
          entries: [{ binding: 0, resource: { buffer: paramsBuf } }],
        }),
        paramsData: new Uint32Array(4),
        lastSpace: -1,
        paramsDirty: true,
      };
      this.matCache.set(materialId, matData);
    }
    const space = material.space === 'local' ? 0 : material.space === 'world' ? 1 : 2;
    if (matData.paramsDirty || matData.lastSpace !== space) {
      matData.paramsData[0] = space;
      wrtBuf(device.queue, matData.paramsBuf, 0, matData.paramsData);
      matData.lastSpace = space;
      matData.paramsDirty = false;
    }
    return { geoData, entData, matData };
  }

  private _writeObjectTableEntry(
    entData: EntityGPUData,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    requestedSlot: number | undefined,
    objectTable: RendererObjectTable,
  ): void {
    const objectSlot = requestedSlot ?? entData.modelSlot;
    objectTable.ensureCapacity(objectSlot + 1);
    const stable = objectTable === this.objectTable && requestedSlot === undefined;
    const clipKey = clippingStateKey(clippingPlanes);
    const objectUnchanged = stable && !entData.objectDirty && matrixEquals(entData.modelSnapshot, worldMatrix);
    const base = objectSlot * OBJECT_TABLE_FLOATS;
    if (!objectUnchanged) {
      objectTable.data.set(worldMatrix, base);
      mat4.inverse(worldMatrix, this._inverseScratch);
      mat4.transpose(this._inverseScratch, this._normalScratch);
      objectTable.data.set(this._normalScratch, base + 16);
      objectTable.writeSlot(objectSlot);
    }
    if (!stable || entData.clippingKey !== clipKey) {
      writeClippingBlock(objectTable.auxiliaryData, objectSlot * CLIPPING_BLOCK_FLOATS, clippingPlanes);
      objectTable.writeAuxiliarySlot(objectSlot);
    }
    if (stable) {
      if (!objectUnchanged) {
        entData.modelSnapshot.set(worldMatrix);
        entData.objectDirty = false;
      }
      entData.clippingKey = clipKey;
    }
  }

  private _bindBatchResources(
    passEncoder: GPURenderPassEncoder,
    geometry: Geometry3D,
    geoData: SharedGeometry3DGPUData,
    matData: MatGPUData,
  ): void {
    passEncoder.setPipeline(this._getPipeline(geometry));
    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    passEncoder.setBindGroup(1, this.batchObjectTable.bindGroup);
    passEncoder.setBindGroup(2, matData.paramsBindGroup);
    passEncoder.setVertexBuffer(0, geoData.positionBuf);
    passEncoder.setVertexBuffer(1, geoData.normalBuf);
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
            { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          ],
        },
        fragment: {
          module: this.shader,
          entryPoint: 'fs_main',
          targets: [{ format: this.colorFormat ?? this.engine.format }],
        },
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
    this.destroyCacheEntries(this.matCache, material => material.paramsBuf.destroy());
    this.clearPipelineCache();
  }
}
