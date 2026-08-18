import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { InstancedMaterial } from '../material/InstancedMaterial';
import { InstancedPbrMaterial } from '../material/InstancedPbrMaterial';
import type { InstancedPbrAlphaMode } from '../material/InstancedPbrMaterial';
import type { EnvironmentLight } from '../lighting/EnvironmentLight';
import { BaseRenderer } from './BaseRenderer';
import { createPrimitiveState } from './gpuDescriptors';
import type { SharedGeometry3DGPUData } from './SharedGeometry3DGPUCache';
import { encodePrimitivePipelineKey } from './pipelineKey';
import { getStripIndexFormat, writeBuffer as wrtBuf } from './utils';
import type { LiveIdSet } from './utils';
import { IndirectDrawCommandBuffer } from './IndirectDrawCommandBuffer';
import type { BoundingSphere } from '../culling/Frustum';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { GpuSortComputePass } from '../compute/GpuSortComputePass';
import { recordComputeResourcePass } from '../compute/ComputeResourceAccess';
import { getBuiltinSpecializedRenderingShader } from '../shader/BuiltinSpecializedRenderingShader';
import { getBuiltinComputeShader } from '../shader/BuiltinComputeShader';
import { SCENE_RENDER_MAX_LIGHTS, type PbrLightInfo } from '../frame/SceneRenderEnvironment';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import type { GpuDrivenIndirectCommandView } from './GpuDrivenBatchBuffer';
import { writePbrEnvironmentUniforms } from './PbrEnvironmentUniforms';
import { ParameterizedRendererCore, SharedGeometryRendererOwner } from './ParameterizedRendererCore';

// ── GPU caches ────────────────────────────────────────────────────────────────

interface MatGPUData {
  transformBuf:  GPUBuffer;
  colorBuf:      GPUBuffer;
  visibleIndexBuf: GPUBuffer;
  sortKeyBuf: GPUBuffer;
  sortIndexBuf: GPUBuffer;
  sortParamsBuf: GPUBuffer;
  sortBindGroup: GPUBindGroup;
  counterBuf:    GPUBuffer;
  cullParamsBuf: GPUBuffer;
  materialBuf: GPUBuffer;
  bindGroup1:    GPUBindGroup;
  cullBindGroup: GPUBindGroup;
  indirect:      IndirectDrawCommandBuffer;
  instanceCount: number;
  instanceCapacity: number;
  identityIndexCapacity: number;
  identityIndicesValid: boolean;
  materialId: number;
  materialRevision: number;
}

interface InstancedCoreObject {
  modelSlot: number;
}

export interface InstancedMesh3DRenderOptions {
  indirect?: boolean;
  gpuCulling?: boolean;
  instanceSorted?: boolean;
  externalIndirect?: InstancedMesh3DExternalIndirectCommand | undefined;
}

export type InstancedMesh3DExternalIndirectCommand = GpuDrivenIndirectCommandView;

export interface InstancedMesh3DGpuCullingOptions {
  planes: Float32Array;
  localSphere: BoundingSphere;
  timestampWrites?: GPUComputePassTimestampWrites | undefined;
  externalIndirect?: InstancedMesh3DExternalIndirectCommand | undefined;
}

export interface InstancedMesh3DInstanceDepthSortOptions {
  viewMatrix: Float32Array;
  order: 'front-to-back' | 'back-to-front';
}

function nextInstanceBufferCapacity(required: number, current: number): number {
  let capacity = Math.max(1, current);
  while (capacity < required) capacity *= 2;
  return capacity;
}

function nextPowerOfTwo(required: number): number {
  let capacity = 1;
  while (capacity < required) capacity *= 2;
  return capacity;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export class InstancedMesh3DRenderer extends BaseRenderer {
  readonly type = 'instancedMesh3d';

  reverseZ    = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;

  private bgl0!: GPUBindGroupLayout; // camera
  private bgl1!: GPUBindGroupLayout; // transforms + colors storage
  private shader!: GPUShaderModule;
  private shaderKey = '';
  private cullShader!: GPUShaderModule;
  private sortKeyShader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private cullPipeline: GPUComputePipeline | null = null;
  private sortKeyPipeline: GPUComputePipeline | null = null;
  private cullPipelineLayout!: GPUPipelineLayout;
  private sortKeyPipelineLayout!: GPUPipelineLayout;
  private cullBgl!: GPUBindGroupLayout;
  private sortKeyBgl!: GPUBindGroupLayout;
  private frustumBuf!: GPUBuffer;
  private lightBuf!: GPUBuffer;
  private environmentBuf!: GPUBuffer;
  private readonly _lightData = new Float32Array((16 + SCENE_RENDER_MAX_LIGHTS * 64) / 4);
  private readonly _lightU32 = new Uint32Array(this._lightData.buffer);
  private readonly _environmentData = new Float32Array(12);
  private readonly _materialData = new Float32Array(4);
  private _lightingRevision = -1;
  private readonly _cullParamsData = new ArrayBuffer(32);
  private readonly _cullParamsU32 = new Uint32Array(this._cullParamsData);
  private readonly _cullParamsF32 = new Float32Array(this._cullParamsData);
  private readonly _sortParamsData = new ArrayBuffer(80);
  private readonly _sortParamsU32 = new Uint32Array(this._sortParamsData);
  private readonly _sortParamsF32 = new Float32Array(this._sortParamsData);
  private _identityIndices = new Uint32Array(0);
  private _instanceSortPass!: GpuSortComputePass;

  private sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly cameraDynamicOffset = new Uint32Array(1);

  private rendererCore!: ParameterizedRendererCore<InstancedCoreObject, SharedGeometry3DGPUData>;
  private get geoCache(): SharedGeometryRendererOwner { return this.rendererCore.geometry as SharedGeometryRendererOwner; }
  private matCache = new Map<number, MatGPUData>();

  private _initialized = false;

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this.clearPipelineCache();
    this._initialized = true;
    this.engine = engine;
    const { device } = engine;
    this.rendererCore = new ParameterizedRendererCore({
      geometry: new SharedGeometryRendererOwner(device, this, getEngineGPUResourceTracker(engine)),
    });

    const cullGenerated = getBuiltinComputeShader(device, 'instanced-cull');
    const sortKeyGenerated = getBuiltinComputeShader(device, 'instanced-depth-sort-key');
    this.cullShader = cullGenerated.module;
    this.sortKeyShader = sortKeyGenerated.module;
    this.cullBgl = cullGenerated.bindGroupLayout;
    this.sortKeyBgl = sortKeyGenerated.bindGroupLayout;
    this.cullPipelineLayout = cullGenerated.pipelineLayout;
    this.sortKeyPipelineLayout = sortKeyGenerated.pipelineLayout;

    this.sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this.bgl0 = this.sceneFrameBinding.bindGroupLayout;
    this.bgl1 = this.getSharedRendererResource(device, 'InstancedMesh3DRenderer.bgl1', () => device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    }));

    const generated = getBuiltinSpecializedRenderingShader(device, 'instanced-mesh3d', [this.bgl0, this.bgl1]);
    this.shader = generated.module;
    this.shaderKey = generated.pass.canonicalHash;
    this.pipelineLayout = generated.pipelineLayout;
    this._instanceSortPass = new GpuSortComputePass(engine, 'InstancedMesh3D.instanceDepthSort');

    this.frustumBuf = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.lightBuf = device.createBuffer({
      label: 'InstancedMesh3DRenderer.lights',
      size: this._lightData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.environmentBuf = device.createBuffer({
      label: 'InstancedMesh3DRenderer.environment',
      size: this._environmentData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.updateLighting([], null, 0);
  }

  updateCamera(sceneFrame: SceneFrameUniformSnapshot, context?: RenderCommandContext): void {
    this.cameraDynamicOffset[0] = this.sceneFrameBinding.upload(sceneFrame, context);
  }

  updateLighting(lights: readonly PbrLightInfo[], environment: EnvironmentLight | null, revision: number): void {
    if (revision === this._lightingRevision) return;
    this._lightingRevision = revision;
    this._lightData.fill(0);
    const count = Math.min(SCENE_RENDER_MAX_LIGHTS, lights.length);
    this._lightU32[0] = count;
    for (let index = 0; index < count; index++) {
      const light = lights[index]!;
      const base = 4 + index * 16;
      this._lightU32[base] = light.type;
      this._lightData[base + 4] = light.color[0];
      this._lightData[base + 5] = light.color[1];
      this._lightData[base + 6] = light.color[2];
      this._lightData[base + 7] = light.intensity;
      this._lightData[base + 8] = light.direction[0];
      this._lightData[base + 9] = light.direction[1];
      this._lightData[base + 10] = light.direction[2];
      this._lightData[base + 12] = light.position[0];
      this._lightData[base + 13] = light.position[1];
      this._lightData[base + 14] = light.position[2];
      this._lightData[base + 15] = light.range;
    }
    writePbrEnvironmentUniforms(this._environmentData, environment);
    wrtBuf(this.engine.device.queue, this.lightBuf, 0, this._lightData);
    wrtBuf(this.engine.device.queue, this.environmentBuf, 0, this._environmentData);
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const topology: GPUPrimitiveTopology = 'triangle-list';
    const cullMode: GPUCullMode = 'back';
    const frontFace: GPUFrontFace = 'ccw';
    const primitiveKey = encodePrimitivePipelineKey(
      topology,
      cullMode,
      frontFace,
      undefined,
      this.reverseZ,
      this.msaaSamples,
    );
    const key = this.rendererCore.pipelineKey(primitiveKey, this.shaderKey, 'opaque');
    this.addPipelineWarmup(
      plan,
      key,
      'Instanced mesh opaque',
      () => this._pipelineDescriptor(topology, cullMode, frontFace, undefined, 'opaque'),
      this.engine.device,
    );
    this.addComputePipelineWarmup(
      plan,
      'gpu-cull',
      'Instanced mesh GPU culling',
      () => this._cullPipelineDescriptor(),
      this.engine.device,
      () => this.cullPipeline,
      pipeline => { this.cullPipeline = pipeline; },
    );
    this.addComputePipelineWarmup(
      plan,
      'depth-sort-keys',
      'Instanced mesh depth-sort keys',
      () => this._sortKeyPipelineDescriptor(),
      this.engine.device,
      () => this.sortKeyPipeline,
      pipeline => { this.sortKeyPipeline = pipeline; },
    );
    this._instanceSortPass.contributePipelineWarmup(plan);
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this.matCache, liveEntities, data => {
      data.transformBuf.destroy();
      data.colorBuf.destroy();
      data.visibleIndexBuf.destroy();
      data.sortKeyBuf.destroy();
      data.sortIndexBuf.destroy();
      data.sortParamsBuf.destroy();
      data.counterBuf.destroy();
      data.cullParamsBuf.destroy();
      data.materialBuf.destroy();
      data.indirect.destroy();
    });
  }

  prepareInstanceData(entityId: number, geometry: Geometry3D, material: InstancedMaterial): boolean {
    const instanceCount = material.activeInstanceCount;
    if (instanceCount < 1) return false;
    this.geoCache.ensure(geometry, this);
    this._ensureMaterialData(entityId, material, instanceCount);
    return true;
  }

  dispatchGpuCulling(
    context: RenderCommandContext,
    entityId: number,
    geometry: Geometry3D,
    material: InstancedMaterial,
    options: InstancedMesh3DGpuCullingOptions,
  ): void {
    const matData = this._ensureMaterialData(entityId, material, material.activeInstanceCount, false);
    if (material.activeInstanceCount < 1) return;
    const geoData = this.geoCache.ensure(geometry, this);
    this._uploadDirtyInstanceData(matData, material);

    const device = this.engine.device;
    wrtBuf(device.queue, this.frustumBuf, 0, options.planes);
    this._cullParamsU32[0] = material.activeInstanceCount >>> 0;
    this._cullParamsF32[4] = options.localSphere.center[0];
    this._cullParamsF32[5] = options.localSphere.center[1];
    this._cullParamsF32[6] = options.localSphere.center[2];
    this._cullParamsF32[7] = options.localSphere.radius;
    device.queue.writeBuffer(matData.cullParamsBuf, 0, this._cullParamsData);

    if (!options.externalIndirect) {
      if (geoData.indexBuf) {
        matData.indirect.writeIndexed(geoData.indexCount, 0);
      } else {
        matData.indirect.write(geoData.vertexCount, 0);
      }
    }

    context.encoder.clearBuffer(matData.counterBuf);
    const pass = context.encoder.beginComputePass({
      label: 'InstancedMesh3DRenderer.gpuCulling',
      ...(options.timestampWrites === undefined ? {} : { timestampWrites: options.timestampWrites }),
    });
    pass.setPipeline(this._getCullPipeline());
    pass.setBindGroup(0, matData.cullBindGroup);
    pass.dispatchWorkgroups(Math.ceil(material.activeInstanceCount / 64));
    pass.end();
    if (geoData.indexBuf) {
      options.externalIndirect
        ? context.encoder.copyBufferToBuffer(matData.counterBuf, 0, options.externalIndirect.indexedIndirectBuffer, options.externalIndirect.indexedIndirectOffset + 4, 4)
        : context.encoder.copyBufferToBuffer(matData.counterBuf, 0, matData.indirect.indexedBuffer, 4, 4);
    } else {
      options.externalIndirect
        ? context.encoder.copyBufferToBuffer(matData.counterBuf, 0, options.externalIndirect.drawIndirectBuffer, options.externalIndirect.drawIndirectOffset + 4, 4)
        : context.encoder.copyBufferToBuffer(matData.counterBuf, 0, matData.indirect.drawBuffer, 4, 4);
    }
    matData.identityIndicesValid = false;
  }

  copyGpuCullingCountTo(context: RenderCommandContext, entityId: number, dstBuffer: GPUBuffer, dstOffset = 0): boolean {
    const matData = this.matCache.get(entityId);
    if (!matData) return false;
    context.encoder.copyBufferToBuffer(matData.counterBuf, 0, dstBuffer, dstOffset, 4);
    return true;
  }

  dispatchInstanceDepthSort(
    context: RenderCommandContext,
    entityId: number,
    material: InstancedMaterial,
    options: InstancedMesh3DInstanceDepthSortOptions,
  ): void {
    const instanceCount = material.activeInstanceCount;
    if (instanceCount <= 1) return;
    const matData = this._ensureMaterialData(entityId, material, instanceCount, false);
    this._uploadDirtyInstanceData(matData, material);
    const paddedCount = nextPowerOfTwo(instanceCount);

    this._sortParamsU32[0] = instanceCount >>> 0;
    this._sortParamsU32[1] = options.order === 'back-to-front' ? 1 : 0;
    this._sortParamsU32[2] = paddedCount >>> 0;
    this._sortParamsU32[3] = 0;
    this._sortParamsF32.set(options.viewMatrix, 4);
    this.engine.device.queue.writeBuffer(matData.sortParamsBuf, 0, this._sortParamsData);

    const keyToken = recordComputeResourcePass(context, {
      label: 'InstancedMesh3DRenderer.instanceDepthSortKeys',
      path: 'InstancedMesh3DRenderer.instanceDepthSortKeys.resources',
      accesses: [
        { resource: matData.sortKeyBuf, use: 'storage-write', path: 'InstancedMesh3DRenderer.instanceDepthSortKeys.sortKeyBuffer' },
        { resource: matData.sortIndexBuf, use: 'storage-write', path: 'InstancedMesh3DRenderer.instanceDepthSortKeys.sortIndexBuffer' },
      ],
    });
    const pass = context.encoder.beginComputePass({ label: 'InstancedMesh3DRenderer.instanceDepthSortKeys' });
    pass.setPipeline(this._getSortKeyPipeline());
    pass.setBindGroup(0, matData.sortBindGroup);
    pass.dispatchWorkgroups(Math.ceil(paddedCount / 64));
    pass.end();

    const sortToken = this._instanceSortPass.sort(context, {
      sortKeyBuffer: matData.sortKeyBuf,
      sortIndexBuffer: matData.sortIndexBuf,
      count: instanceCount,
      paddedCapacity: paddedCount,
    }, { after: [keyToken], path: 'InstancedMesh3DRenderer.instanceDepthSort.resources' });
    if (sortToken) {
      recordComputeResourcePass(context, {
        label: 'InstancedMesh3DRenderer.visibleIndexCopy',
        path: 'InstancedMesh3DRenderer.visibleIndexCopy',
        after: [sortToken],
        accesses: [
          { resource: matData.sortIndexBuf, use: 'copy-read', path: 'InstancedMesh3DRenderer.visibleIndexCopy.sortIndexBuffer' },
          { resource: matData.visibleIndexBuf, use: 'copy-write', path: 'InstancedMesh3DRenderer.visibleIndexCopy.visibleIndexBuffer' },
        ],
      });
    }
    context.encoder.copyBufferToBuffer(matData.sortIndexBuf, 0, matData.visibleIndexBuf, 0, instanceCount * 4);
    matData.identityIndicesValid = false;
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    this.geoCache.releaseUnused(this, liveGeometries);
  }

  render(
    passEncoder: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: InstancedMaterial,
    options: InstancedMesh3DRenderOptions = {},
  ): void {
    const { device } = this.engine;
    const instanceCount = material.activeInstanceCount;
    if (instanceCount < 1) return;

    // ── Geometry ──────────────────────────────────────────────────────────────
    const geoData = this.geoCache.ensure(geometry, this);

    const matData = this._ensureMaterialData(entityId, material, instanceCount, !(options.gpuCulling || options.instanceSorted));

    // ── Upload dirty instance data ────────────────────────────────────────────
    this._uploadDirtyInstanceData(matData, material);

    // ── Draw ──────────────────────────────────────────────────────────────────
    passEncoder.setPipeline(this._getPipeline(geometry, material));
    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    passEncoder.setBindGroup(1, matData.bindGroup1);
    passEncoder.setVertexBuffer(0, geoData.positionBuf);
    passEncoder.setVertexBuffer(1, geoData.normalBuf);
    passEncoder.setVertexBuffer(2, geoData.uvBuf);

    if (geoData.indexBuf) {
      passEncoder.setIndexBuffer(geoData.indexBuf, geoData.indexFormat);
      if (options.indirect) {
        if (options.externalIndirect) {
          passEncoder.drawIndexedIndirect(options.externalIndirect.indexedIndirectBuffer, options.externalIndirect.indexedIndirectOffset);
        } else {
          if (!options.gpuCulling) matData.indirect.writeIndexed(geoData.indexCount, instanceCount);
          passEncoder.drawIndexedIndirect(matData.indirect.indexedBuffer, 0);
        }
      } else {
        passEncoder.drawIndexed(geoData.indexCount, instanceCount);
      }
    } else {
      if (options.indirect) {
        if (options.externalIndirect) {
          passEncoder.drawIndirect(options.externalIndirect.drawIndirectBuffer, options.externalIndirect.drawIndirectOffset);
        } else {
          if (!options.gpuCulling) matData.indirect.write(geoData.vertexCount, instanceCount);
          passEncoder.drawIndirect(matData.indirect.drawBuffer, 0);
        }
      } else {
        passEncoder.draw(geoData.vertexCount, instanceCount);
      }
    }
  }

  private _ensureMaterialData(entityId: number, material: InstancedMaterial, instanceCount: number, ensureIdentityIndices = true): MatGPUData {
    const { device } = this.engine;
    let matData = this.matCache.get(entityId);
    if (!matData || instanceCount > matData.instanceCapacity) {
      matData?.transformBuf.destroy();
      matData?.colorBuf.destroy();
      matData?.visibleIndexBuf.destroy();
      matData?.sortKeyBuf.destroy();
      matData?.sortIndexBuf.destroy();
      matData?.sortParamsBuf.destroy();
      matData?.counterBuf.destroy();
      matData?.cullParamsBuf.destroy();
      matData?.materialBuf.destroy();
      matData?.indirect.destroy();
      const instanceCapacity = nextInstanceBufferCapacity(instanceCount, matData?.instanceCapacity ?? 0);

      const transformBuf = device.createBuffer({
        size: instanceCapacity * 64,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const colorBuf = device.createBuffer({
        size: Math.max(instanceCapacity * 16, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const visibleIndexBuf = device.createBuffer({
        size: Math.max(instanceCapacity * 4, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const sortKeyBuf = device.createBuffer({
        size: Math.max(instanceCapacity * 4, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const sortIndexBuf = device.createBuffer({
        size: Math.max(instanceCapacity * 4, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      const sortParamsBuf = device.createBuffer({
        size: 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const counterBuf = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
      const cullParamsBuf = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const materialBuf = device.createBuffer({
        label: `InstancedMesh3D.${entityId}.pbrMaterial`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup1 = device.createBindGroup({
        layout: this.bgl1,
        entries: [
          { binding: 0, resource: { buffer: transformBuf } },
          { binding: 1, resource: { buffer: colorBuf } },
          { binding: 2, resource: { buffer: visibleIndexBuf } },
          { binding: 3, resource: { buffer: materialBuf } },
          { binding: 4, resource: { buffer: this.lightBuf } },
          { binding: 5, resource: { buffer: this.environmentBuf } },
        ],
      });
      const cullBindGroup = device.createBindGroup({
        layout: this.cullBgl,
        entries: [
          { binding: 0, resource: { buffer: transformBuf } },
          { binding: 1, resource: { buffer: visibleIndexBuf } },
          { binding: 2, resource: { buffer: counterBuf } },
          { binding: 3, resource: { buffer: this.frustumBuf } },
          { binding: 4, resource: { buffer: cullParamsBuf } },
        ],
      });
      const sortBindGroup = device.createBindGroup({
        layout: this.sortKeyBgl,
        entries: [
          { binding: 0, resource: { buffer: transformBuf } },
          { binding: 1, resource: { buffer: sortKeyBuf } },
          { binding: 2, resource: { buffer: sortIndexBuf } },
          { binding: 3, resource: { buffer: sortParamsBuf } },
        ],
      });
      const indirect = new IndirectDrawCommandBuffer(this.engine, `InstancedMesh3D.${entityId}`);
      matData = {
        transformBuf,
        colorBuf,
        visibleIndexBuf,
        sortKeyBuf,
        sortIndexBuf,
        sortParamsBuf,
        sortBindGroup,
        counterBuf,
        cullParamsBuf,
        materialBuf,
        bindGroup1,
        cullBindGroup,
        indirect,
        instanceCount,
        instanceCapacity,
        identityIndexCapacity: 0,
        identityIndicesValid: false,
        materialId: -1,
        materialRevision: -1,
      };
      this.matCache.set(entityId, matData);
      material.transformsDirty = true;
      material.colorsDirty = true;
    } else {
      if (instanceCount > matData.instanceCount) {
        material.transformsDirty = true;
        material.colorsDirty = true;
      }
      matData.instanceCount = instanceCount;
    }
    if (ensureIdentityIndices) this._ensureIdentityIndices(matData, instanceCount);
    return matData;
  }

  private _ensureIdentityIndices(matData: MatGPUData, count: number): void {
    if (count <= matData.identityIndexCapacity && matData.identityIndicesValid) return;
    if (this._identityIndices.length < count) {
      const previousLength = this._identityIndices.length;
      const indices = new Uint32Array(count);
      indices.set(this._identityIndices);
      for (let i = previousLength; i < count; i++) indices[i] = i;
      this._identityIndices = indices;
    }
    wrtBuf(this.engine.device.queue, matData.visibleIndexBuf, 0, this._identityIndices.subarray(0, count));
    matData.identityIndexCapacity = count;
    matData.identityIndicesValid = true;
  }

  private _uploadDirtyInstanceData(matData: MatGPUData, material: InstancedMaterial): void {
    const queue = this.engine.device.queue;
    const instanceCount = material.activeInstanceCount;
    if (material.transformsDirty) {
      const start = Math.min(material.transformDirtyStart, instanceCount);
      const end = Math.min(material.transformDirtyEnd, instanceCount);
      if (end > start) wrtBuf(queue, matData.transformBuf, start * 16 * 4, material.transforms.subarray(start * 16, end * 16));
      material.clearTransformsDirty();
    }
    if (material.colorsDirty) {
      const start = Math.min(material.colorDirtyStart, instanceCount);
      const end = Math.min(material.colorDirtyEnd, instanceCount);
      if (end > start) wrtBuf(queue, matData.colorBuf, start * 4 * 4, material.colors.subarray(start * 4, end * 4));
      material.clearColorsDirty();
    }
    if (matData.materialBuf && (matData.materialId !== material.id || matData.materialRevision !== material.revision)) {
      this._materialData.fill(0);
      if (material instanceof InstancedPbrMaterial) {
        this._materialData[0] = 1;
        this._materialData[1] = material.metallic;
        this._materialData[2] = material.roughness;
      }
      wrtBuf(queue, matData.materialBuf, 0, this._materialData);
      matData.materialId = material.id;
      matData.materialRevision = material.revision;
    }
  }

  private _getPipeline(geometry: Geometry3D, material: InstancedMaterial): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = geometry.cullMode ?? 'back';
    const frontFace = geometry.frontFace ?? 'ccw';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const primitiveKey = encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples);
    const alphaMode = material instanceof InstancedPbrMaterial ? material.alphaMode : 'opaque';
    const key = this.rendererCore.pipelineKey(primitiveKey, this.shaderKey, alphaMode);
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(
      this._pipelineDescriptor(topology, cullMode, frontFace, stripIndexFormat, alphaMode),
    ));
  }

  private _pipelineDescriptor(
    topology: GPUPrimitiveTopology,
    cullMode: GPUCullMode,
    frontFace: GPUFrontFace,
    stripIndexFormat?: GPUIndexFormat,
    alphaMode: InstancedPbrAlphaMode = 'opaque',
  ): GPURenderPipelineDescriptor {
    return {
      layout: this.pipelineLayout,
      vertex: {
        module: this.shader,
        entryPoint: 'vs_main',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: {
        module: this.shader,
        entryPoint: 'fs_main',
        targets: [{
          format: this.engine.format,
          ...(alphaMode === 'blend' ? { blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          } } : {}),
        }],
      },
      primitive: createPrimitiveState(topology, cullMode, frontFace, stripIndexFormat),
      depthStencil: {
        format: this.engine.getDepthFormat(this.reverseZ),
        depthWriteEnabled: alphaMode === 'opaque',
        depthCompare: this.reverseZ ? 'greater' : 'less',
      },
      multisample: { count: this.msaaSamples },
    };
  }

  private _getCullPipeline(): GPUComputePipeline {
    return this.getCachedComputePipeline(
      'gpu-cull',
      () => this.cullPipeline,
      () => this.engine.device.createComputePipeline(this._cullPipelineDescriptor()),
      pipeline => { this.cullPipeline = pipeline; },
    );
  }

  private _getSortKeyPipeline(): GPUComputePipeline {
    return this.getCachedComputePipeline(
      'depth-sort-keys',
      () => this.sortKeyPipeline,
      () => this.engine.device.createComputePipeline(this._sortKeyPipelineDescriptor()),
      pipeline => { this.sortKeyPipeline = pipeline; },
    );
  }

  private _cullPipelineDescriptor(): GPUComputePipelineDescriptor {
    return {
      layout: this.cullPipelineLayout,
      compute: { module: this.cullShader, entryPoint: 'cs_main' },
    };
  }

  private _sortKeyPipelineDescriptor(): GPUComputePipelineDescriptor {
    return {
      layout: this.sortKeyPipelineLayout,
      compute: { module: this.sortKeyShader, entryPoint: 'cs_main' },
    };
  }

  destroy(): void {
    this.sceneFrameBinding?.destroy();
    this.frustumBuf?.destroy();
    this.lightBuf?.destroy();
    this.environmentBuf?.destroy();
    this.rendererCore?.destroy();
    this.destroyCacheEntries(this.matCache, m => {
      m.transformBuf.destroy();
      m.colorBuf.destroy();
      m.visibleIndexBuf.destroy();
      m.sortKeyBuf.destroy();
      m.sortIndexBuf.destroy();
      m.sortParamsBuf.destroy();
      m.counterBuf.destroy();
      m.cullParamsBuf.destroy();
      m.materialBuf.destroy();
      m.indirect.destroy();
    });
    this.clearPipelineCache();
    this.cullPipeline = null;
    this.sortKeyPipeline = null;
    this._instanceSortPass?.destroy();
  }
}
