import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import type { Geometry3D } from '../geometry/Geometry3D';
import { BaseRenderer } from './BaseRenderer';
import { createPrimitiveState } from './gpuDescriptors';
import { getSharedGeometry3DGPUCache } from './SharedGeometry3DGPUCache';
import { encodePrimitivePipelineKey } from './pipelineKey';
import { getStripIndexFormat, matrixEquals } from './utils';
import type { LiveIdSet } from './utils';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { getBuiltinDeformationShader } from '../shader/BuiltinDeformationShader';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import { RendererObjectSlotCache } from './RendererCacheMap';
import { RendererObjectTable } from './RendererObjectTable';
import { CurrentDeformationGpuCache } from './CurrentDeformationGpuCache';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { CLIPPING_BLOCK_FLOATS, clippingStateKey, writeClippingBlock } from './ClippingPlanesGpu';

const OBJECT_TABLE_FLOATS = 24;
const OBJECT_TABLE_MORPH_OFFSET = 16;
const OBJECT_TABLE_DEFORMATION_OFFSET = 20;

interface EntityGPUData {
  modelSlot: number;
  modelSnapshot: Float32Array;
  modelDirty: boolean;
  clippingKey: string;
}

export class OutlineMaskRenderer extends BaseRenderer {
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private bgl0!: GPUBindGroupLayout;
  private bgl1!: GPUBindGroupLayout;
  private bgl2!: GPUBindGroupLayout;
  private bgl3!: GPUBindGroupLayout;
  private sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly cameraDynamicOffset = new Uint32Array(1);
  private shaderModule!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private geoCache!: ReturnType<typeof getSharedGeometry3DGPUCache>;
  private objectTable!: RendererObjectTable;
  private deformationCache!: CurrentDeformationGpuCache;
  private entityCache = new RendererObjectSlotCache<EntityGPUData>(
    () => this.objectTable,
    modelSlot => ({ modelSlot, modelSnapshot: new Float32Array(16), modelDirty: true, clippingKey: '' }),
  );
  private _initialized = false;

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this.clearPipelineCache();
    this._initialized = true;
    this.engine = engine;
    const { device } = engine;
    this.geoCache = getSharedGeometry3DGPUCache(device, getEngineGPUResourceTracker(engine));
    this.sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this.bgl0 = this.sceneFrameBinding.bindGroupLayout;
    this.bgl1 = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ] });
    this.bgl2 = device.createBindGroupLayout({ entries: [] });
    this.bgl3 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const generated = getBuiltinDeformationShader(device, 'outline', [this.bgl0, this.bgl1, this.bgl2, this.bgl3]);
    this.shaderModule = generated.module;
    this.pipelineLayout = generated.pipelineLayout;
    this.objectTable = new RendererObjectTable({
      device,
      bindGroupLayout: this.bgl1,
      label: 'OutlineMaskRenderer.objectTable',
      floatsPerSlot: OBJECT_TABLE_FLOATS,
      auxiliary: { binding: 1, floatsPerSlot: CLIPPING_BLOCK_FLOATS, label: 'OutlineMaskRenderer.clippingTable' },
    });
    this.objectTable.ensureCapacity(1);
    this.deformationCache = new CurrentDeformationGpuCache(device, this.bgl3, 'OutlineMaskRenderer');
  }

  beginView(sceneFrame: SceneFrameUniformSnapshot): void {
    this.cameraDynamicOffset[0] = this.sceneFrameBinding.upload(sceneFrame);
    this.objectTable.beginUploads();
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const reverseZ = this.reverseZ;
    const msaaSamples = this.msaaSamples;
    for (const depthWrite of [true, false]) {
      const key = encodePrimitivePipelineKey('triangle-list', 'back', 'ccw', undefined, reverseZ, msaaSamples, depthWrite ? 1 : 0);
      this.addPipelineWarmup(
        plan,
        key,
        `Outline mask ${depthWrite ? 'occluded' : 'visible'}`,
        () => this._pipelineDescriptor('triangle-list', 'back', 'ccw', undefined, depthWrite, reverseZ, msaaSamples),
        this.engine.device,
      );
    }
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    this.entityCache.releaseNotIn(liveEntities);
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    this.geoCache.releaseUnused(this, liveGeometries);
    this.deformationCache.releaseNotIn(liveGeometries);
  }

  render(
    passEncoder: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    worldMatrix: Float32Array,
    options: { depthWrite?: boolean } = {},
    clippingPlanes: ClippingPlanes | null = null,
  ): void {
    const geoData = this.geoCache.ensure(geometry, this);
    const deformation = this.deformationCache.ensure(geometry);
    const entData = this.entityCache.ensure(entityId);
    this._writeObject(entData, geometry, clippingPlanes, worldMatrix);
    this.objectTable.flushUploads();

    passEncoder.setPipeline(this._getPipeline(geometry, options.depthWrite ?? true));
    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    passEncoder.setBindGroup(1, this.objectTable.bindGroup);
    passEncoder.setBindGroup(3, deformation.skinBindGroup);
    passEncoder.setVertexBuffer(0, geoData.positionBuf);
    for (let index = 0; index < 4; index++) passEncoder.setVertexBuffer(index + 1, deformation.morphBuffers[index]!);
    if (geoData.indexBuf) {
      passEncoder.setIndexBuffer(geoData.indexBuf, geoData.indexFormat);
      passEncoder.drawIndexed(geoData.indexCount, 1, 0, 0, entData.modelSlot);
    } else {
      passEncoder.draw(geoData.vertexCount, 1, 0, entData.modelSlot);
    }
  }

  destroy(): void {
    this.sceneFrameBinding?.destroy();
    this.geoCache?.releaseOwner(this);
    this.deformationCache?.destroy();
    this.entityCache.clear();
    this.objectTable?.destroy();
    this.clearPipelineCache();
    this._initialized = false;
  }

  private _writeObject(entData: EntityGPUData, geometry: Geometry3D, clippingPlanes: ClippingPlanes | null, worldMatrix: Float32Array): void {
    const base = entData.modelSlot * OBJECT_TABLE_FLOATS;
    const data = this.objectTable.data;
    const morphEnabled = geometry.morphUseGpu && geometry.hasMorphTargets;
    const morph0 = morphEnabled ? geometry.morphWeights[0] ?? 0 : 0;
    const morph1 = morphEnabled ? geometry.morphWeights[1] ?? 0 : 0;
    const morph2 = morphEnabled ? geometry.morphWeights[2] ?? 0 : 0;
    const morph3 = morphEnabled ? geometry.morphWeights[3] ?? 0 : 0;
    const skinned = geometry.skinning ? 1 : 0;
    const clipKey = clippingStateKey(clippingPlanes);
    const objectUnchanged =
      !entData.modelDirty
      && matrixEquals(entData.modelSnapshot, worldMatrix)
      && data[base + OBJECT_TABLE_MORPH_OFFSET] === morph0
      && data[base + OBJECT_TABLE_MORPH_OFFSET + 1] === morph1
      && data[base + OBJECT_TABLE_MORPH_OFFSET + 2] === morph2
      && data[base + OBJECT_TABLE_MORPH_OFFSET + 3] === morph3
      && data[base + OBJECT_TABLE_DEFORMATION_OFFSET] === (morphEnabled ? 1 : 0)
      && data[base + OBJECT_TABLE_DEFORMATION_OFFSET + 1] === skinned;
    if (!objectUnchanged) {
      data.set(worldMatrix, base);
      data[base + OBJECT_TABLE_MORPH_OFFSET] = morph0;
      data[base + OBJECT_TABLE_MORPH_OFFSET + 1] = morph1;
      data[base + OBJECT_TABLE_MORPH_OFFSET + 2] = morph2;
      data[base + OBJECT_TABLE_MORPH_OFFSET + 3] = morph3;
      data[base + OBJECT_TABLE_DEFORMATION_OFFSET] = morphEnabled ? 1 : 0;
      data[base + OBJECT_TABLE_DEFORMATION_OFFSET + 1] = skinned;
      data[base + OBJECT_TABLE_DEFORMATION_OFFSET + 2] = 0;
      data[base + OBJECT_TABLE_DEFORMATION_OFFSET + 3] = 0;
      this.objectTable.writeSlot(entData.modelSlot);
      entData.modelSnapshot.set(worldMatrix);
      entData.modelDirty = false;
    }
    if (entData.clippingKey !== clipKey) {
      writeClippingBlock(this.objectTable.auxiliaryData, entData.modelSlot * CLIPPING_BLOCK_FLOATS, clippingPlanes);
      this.objectTable.writeAuxiliarySlot(entData.modelSlot);
    }
    entData.clippingKey = clipKey;
  }

  private _getPipeline(geometry: Geometry3D, depthWrite: boolean): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = geometry.cullMode ?? 'back';
    const frontFace = geometry.frontFace ?? 'ccw';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const key = encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples, depthWrite ? 1 : 0);
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(
      this._pipelineDescriptor(
        topology,
        cullMode,
        frontFace,
        stripIndexFormat,
        depthWrite,
        this.reverseZ,
        this.msaaSamples,
      ),
    ));
  }

  private _pipelineDescriptor(
    topology: GPUPrimitiveTopology,
    cullMode: GPUCullMode,
    frontFace: GPUFrontFace,
    stripIndexFormat: GPUIndexFormat | undefined,
    depthWrite: boolean,
    reverseZ: boolean,
    msaaSamples: 1 | 4,
  ): GPURenderPipelineDescriptor {
    const { format } = this.engine;
    return {
      layout: this.pipelineLayout,
      vertex: {
        module: this.shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          ...Array.from({ length: 4 }, (_, index): GPUVertexBufferLayout => ({
            arrayStride: 12,
            attributes: [{ shaderLocation: index + 1, offset: 0, format: 'float32x3' }],
          })),
        ],
      },
      fragment: { module: this.shaderModule, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: createPrimitiveState(topology, cullMode, frontFace, stripIndexFormat),
      depthStencil: {
        format: this.engine.getDepthFormat(reverseZ),
        depthWriteEnabled: depthWrite,
        depthCompare: reverseZ ? 'greater-equal' : 'less-equal',
      },
      multisample: { count: msaaSamples },
    };
  }

}
