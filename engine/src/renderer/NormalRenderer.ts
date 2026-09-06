import type { Material } from '../material/Material';
import { auxiliaryCullMode, auxiliaryFrontFace, auxiliaryUsesDeformation, MATERIAL_COVERAGE_LAYOUT, MaterialCoverageBindings, type MaterialCoverageResources } from './AuxiliaryMaterial';
import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import { Geometry3D } from '../geometry/Geometry3D';
import { NormalMaterial } from '../material/NormalMaterial';
import { mat4 } from 'wgpu-matrix';
import { PbrDeformationGpuCache } from './PbrDeformationGpuCache';
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
import { forEachDirectInstanceBatchRun, forEachIndirectBatchRun } from './DirectInstanceBatchRuns';
import type { RenderBatchBindingEncoder } from './IndirectBatchBundleCache';
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

const OBJECT_TABLE_FLOATS = 40;

interface MatGPUData {
  paramsBuf: GPUBuffer;
  paramsBindGroup: GPUBindGroup;
  paramsData: Uint32Array;
  depthData: Float32Array;
  lastSpace: number;
  paramsDirty: boolean;
}

export class NormalRenderer extends BaseRenderer {
  readonly type = 'normal';

  reverseZ = false;
  msaaSamples: 1 | 4 = 1;
  /** When set, location 1 writes normalized linear depth alongside the normal. */
  auxiliaryDepth: { near: number; far: number } | null = null;
  /** Optional auxiliary target override; ordinary material rendering uses the engine surface format. */

  private engine!: IEngine;
  private bgl0!: GPUBindGroupLayout;
  private bgl1!: GPUBindGroupLayout;
  private bgl2!: GPUBindGroupLayout;
  private bgl3!: GPUBindGroupLayout;
  private deformationCache!: PbrDeformationGpuCache;
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

  private coverageBindings!: MaterialCoverageBindings;
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
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, ...MATERIAL_COVERAGE_LAYOUT],
    });

    this.bgl3 = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ] });
    const createSkinBindGroup = (matrices: GPUBuffer, joints: GPUBuffer, weights: GPUBuffer): GPUBindGroup => device.createBindGroup({
      layout: this.bgl3, entries: [
        { binding: 0, resource: { buffer: matrices } },
        { binding: 1, resource: { buffer: joints } },
        { binding: 2, resource: { buffer: weights } },
      ],
    });
    let fallbackSkin: GPUBindGroup | null = null;
    this.deformationCache = new PbrDeformationGpuCache({
      device, label: 'NormalRenderer', getSceneBindingRevision: () => 0, createSceneBindGroup: createSkinBindGroup,
      getFallbackSceneBindGroup: () => fallbackSkin ??= createSkinBindGroup(
        this.deformationCache.fallbackSkinMatrixBuffer,
        this.deformationCache.fallbackSkinJointBuffer,
        this.deformationCache.fallbackSkinWeightBuffer,
      ),
    });
    this.coverageBindings = new MaterialCoverageBindings(device, this.bgl2);
    const generated = getBuiltinSimple3dShader(device, 'normal-material', [this.bgl0, this.bgl1, this.bgl2, this.bgl3]);
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
    const key = this._pipelineKey('triangle-list', 'back', 'ccw', undefined);
    const depth = this.auxiliaryDepth !== null;
    this.addPipelineWarmup(plan, key, 'Normal material', () => (
      this._pipelineDescriptor('triangle-list', 'back', 'ccw', undefined, depth)
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
    options: { gpuDrivenBatch?: MaterialGpuDrivenBatch | undefined; sourceMaterial?: Material | null; coverage?: MaterialCoverageResources | null } = {},
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
      auxiliaryUsesDeformation(options.sourceMaterial),
    );
    if (!this.rendererCore.uploadsPrepared) objectTable.flushUploads();

    const pipeline = this._getPipeline(geometry, options.sourceMaterial);
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    passEncoder.setBindGroup(1, objectTable.bindGroup);
    passEncoder.setBindGroup(2, this.coverageBindings.get(options.coverage, matData.paramsBuf));
    this._bindGeometry(passEncoder, geometry, geoData);

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
    if (!batchBuffer.gpuUploadEnabled || this.rendererCore.uploadsPrepared) {
      const visitRuns = batchBuffer.gpuUploadEnabled ? forEachIndirectBatchRun : forEachDirectInstanceBatchRun;
      visitRuns(items, first, count, batchBuffer, run => {
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
        const bindings = batchBuffer.gpuUploadEnabled ? this.indirectBatches.begin() : passEncoder;
        this._bindBatchResources(bindings, item.geometry, geoData, matData);
        if (batchBuffer.gpuUploadEnabled) {
          this.indirectBatches.draw(passEncoder, this.engine.device, batchBuffer, run.firstBatch,
            run.instanceCount, geoData.indexBuf, geoData.indexFormat,
            this.auxiliaryDepth ? [this.colorFormat ?? this.engine.format, 'r32float'] : [this.colorFormat ?? this.engine.format],
            this.engine.getDepthFormat(this.reverseZ), this.msaaSamples);
          return;
        }
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
    deform = true,
  ) {
    const { device } = this.engine;
    const geoData = this.geoCache.ensure(geometry, this);
    const entData = this.entityCache.ensure(entityId);
    this.deformationCache.ensure(geometry);
    this._writeObjectTableEntry(entData, geometry, clippingPlanes, worldMatrix, requestedSlot, objectTable, deform);
    const materialId = this.rendererCore.materialIdentity(material);
    let matData = this.matCache.get(materialId);
    if (!matData) {
      const paramsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const paramsData = new Uint32Array(4);
      matData = {
        paramsBuf,
        paramsBindGroup: this.coverageBindings.get(null, paramsBuf),
        paramsData,
        depthData: new Float32Array(paramsData.buffer),
        lastSpace: -1,
        paramsDirty: true,
      };
      this.matCache.set(materialId, matData);
    }
    const space = material.space === 'local' ? 0 : material.space === 'world' ? 1 : 2;
    const near = Math.fround(this.auxiliaryDepth?.near ?? 0);
    const far = Math.fround(this.auxiliaryDepth?.far ?? 1);
    if (matData.paramsDirty || matData.lastSpace !== space || matData.depthData[1] !== near || matData.depthData[2] !== far) {
      matData.paramsData[0] = space;
      matData.depthData[1] = near;
      matData.depthData[2] = far;
      wrtBuf(device.queue, matData.paramsBuf, 0, matData.paramsData);
      matData.lastSpace = space;
      matData.paramsDirty = false;
    }
    return { geoData, entData, matData };
  }

  private _writeObjectTableEntry(
    entData: EntityGPUData,
    geometry: Geometry3D,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    requestedSlot: number | undefined,
    objectTable: RendererObjectTable,
    deform: boolean,
  ): void {
    const objectSlot = requestedSlot ?? entData.modelSlot;
    objectTable.ensureCapacity(objectSlot + 1);
    const stable = objectTable === this.objectTable && requestedSlot === undefined;
    const clipKey = clippingStateKey(clippingPlanes);
    const base = objectSlot * OBJECT_TABLE_FLOATS;
    const morphed = deform && geometry.morphUseGpu && geometry.hasMorphTargets;
    const skinned = deform && geometry.skinning ? 1 : 0;
    let objectUnchanged = stable && !entData.objectDirty && matrixEquals(entData.modelSnapshot, worldMatrix)
      && objectTable.data[base + 37] === skinned && objectTable.data[base + 36] === (morphed ? 1 : 0);
    for (let index = 0; index < 4; index++) {
      const weight = morphed ? geometry.morphWeights[index] ?? 0 : 0;
      objectUnchanged &&= objectTable.data[base + 32 + index] === weight;
      objectTable.data[base + 32 + index] = weight;
    }
    objectTable.data[base + 36] = morphed ? 1 : 0;
    objectTable.data[base + 37] = skinned;
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
    passEncoder: RenderBatchBindingEncoder,
    geometry: Geometry3D,
    geoData: SharedGeometry3DGPUData,
    matData: MatGPUData,
  ): void {
    passEncoder.setPipeline(this._getPipeline(geometry));
    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    passEncoder.setBindGroup(1, this.batchObjectTable.bindGroup);
    passEncoder.setBindGroup(2, matData.paramsBindGroup);
    this._bindGeometry(passEncoder, geometry, geoData);
  }

  private _bindGeometry(pass: RenderBatchBindingEncoder, geometry: Geometry3D, data: SharedGeometry3DGPUData): void {
    const deformation = this.deformationCache.ensure(geometry);
    pass.setBindGroup(3, deformation.skinBindGroup);
    pass.setVertexBuffer(0, data.positionBuf);
    pass.setVertexBuffer(1, data.normalBuf);
    for (let index = 0; index < 4; index++) pass.setVertexBuffer(index + 2, deformation.morphBuffers[index]!);
    pass.setVertexBuffer(6, data.uvBuf);
    pass.setVertexBuffer(7, data.uv1Buf ?? data.uvBuf);
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

  private _getPipeline(geometry: Geometry3D, sourceMaterial?: Material | null): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = auxiliaryCullMode(geometry, sourceMaterial);
    const frontFace = auxiliaryFrontFace(geometry, sourceMaterial);
    const stripIndexFormat = getStripIndexFormat(geometry);
    const key = this._pipelineKey(topology, cullMode, frontFace, stripIndexFormat);
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(
      this._pipelineDescriptor(topology, cullMode, frontFace, stripIndexFormat),
    ));
  }

  private _pipelineDescriptor(
    topology: GPUPrimitiveTopology,
    cullMode: GPUCullMode,
    frontFace: GPUFrontFace,
    stripIndexFormat: GPUIndexFormat | undefined,
    depth = this.auxiliaryDepth !== null,
  ): GPURenderPipelineDescriptor {
      return {
        layout: this.pipelineLayout,
        vertex: {
          module: this.shader,
          entryPoint: 'vs_main',
          buffers: [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
            ...Array.from({ length: 4 }, (_, index): GPUVertexBufferLayout => ({
              arrayStride: 24, attributes: [
                { shaderLocation: 2 + index * 2, offset: 0, format: 'float32x3' },
                { shaderLocation: 3 + index * 2, offset: 12, format: 'float32x3' },
              ],
            })),
            { arrayStride: 8, attributes: [{ shaderLocation: 10, offset: 0, format: 'float32x2' }] },
            { arrayStride: 8, attributes: [{ shaderLocation: 11, offset: 0, format: 'float32x2' }] },
          ],
        },
        fragment: {
          module: this.shader,
          entryPoint: 'fs_main',
          targets: [{ format: this.colorFormat ?? this.engine.format }, depth ? { format: 'r32float' } : null],
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

  private _pipelineKey(topology: GPUPrimitiveTopology, cullMode: GPUCullMode, frontFace: GPUFrontFace, stripIndexFormat: GPUIndexFormat | undefined): string {
    return `${encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples)}:${this.colorFormat ?? this.engine.format}:${+(this.auxiliaryDepth !== null)}`;
  }

  destroy(): void {
    this.coverageBindings?.destroy();
    this.sceneFrameBinding?.destroy();
    this.rendererCore?.destroy();
    this.deformationCache?.destroy();
    this.destroyCacheEntries(this.matCache, material => material.paramsBuf.destroy());
    this.clearPipelineCache();
  }
}
