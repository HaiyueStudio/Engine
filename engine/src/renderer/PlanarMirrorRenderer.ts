import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { PlanarMirrorMaterial } from '../material/PlanarMirrorMaterial';
import { getBuiltinSpecializedRenderingShader } from '../shader/BuiltinSpecializedRenderingShader';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import { BaseRenderer } from './BaseRenderer';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import { getSharedGeometry3DGPUCache } from './SharedGeometry3DGPUCache';
import { createPrimitiveState } from './gpuDescriptors';
import { encodePrimitivePipelineKey, encodeShaderPipelineKey } from './pipelineKey';
import { getStripIndexFormat, matrixEquals, writeBuffer } from './utils';
import type { MaterialRenderBatchItem, MaterialRendererViewContext } from './MaterialRendererRegistry';
import type { PipelineWarmupPlan } from './PipelineWarmup';

interface MirrorEntityGpuData {
  readonly buffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly snapshot: Float32Array;
  lastSeenView: number;
}

interface MirrorMaterialGpuData {
  readonly buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  readonly data: Float32Array;
  readonly matrixSnapshot: Float32Array;
  texture: GPUTexture;
  textureVersion: number;
  materialRevision: number;
  lastSeenView: number;
}

const MATERIAL_FLOATS = 20;
const CACHE_SWEEP_INTERVAL = 120;

export class PlanarMirrorRenderer extends BaseRenderer {
  readonly type = 'planar-mirror';
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly cameraDynamicOffset = new Uint32Array(1);
  private objectBindGroupLayout!: GPUBindGroupLayout;
  private materialBindGroupLayout!: GPUBindGroupLayout;
  private pipelineLayout!: GPUPipelineLayout;
  private shader!: GPUShaderModule;
  private shaderKey = '';
  private geometryCache!: ReturnType<typeof getSharedGeometry3DGPUCache>;
  private defaultTexture!: GPUTexture;
  private defaultSampler!: GPUSampler;
  private readonly entities = new Map<number, MirrorEntityGpuData>();
  private readonly materials = new Map<number, Map<string, MirrorMaterialGpuData>>();
  private activeViewKey = '';
  private viewGeneration = 0;
  private initialized = false;

  prepare(engine: IEngine): void {
    if (this.initialized) return;
    this.initialized = true;
    this.engine = engine;
    const device = engine.device;
    this.geometryCache = getSharedGeometry3DGPUCache(device, getEngineGPUResourceTracker(engine));
    this.sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this.objectBindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.materialBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const generated = getBuiltinSpecializedRenderingShader(device, 'planar-mirror', [
      this.sceneFrameBinding.bindGroupLayout,
      this.objectBindGroupLayout,
      this.materialBindGroupLayout,
    ]);
    this.shader = generated.module;
    this.shaderKey = generated.pass.canonicalHash;
    this.pipelineLayout = generated.pipelineLayout;
    this.defaultTexture = device.createTexture({
      label: 'PlanarMirrorRenderer.defaultTexture',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.defaultTexture },
      new Uint8Array([0, 0, 0, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this.defaultSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  beginView(context: MaterialRendererViewContext): void {
    this.activeViewKey = context.viewKey;
    this.reverseZ = context.reverseZ;
    this.msaaSamples = context.msaaSamples;
    this.cameraDynamicOffset[0] = this.sceneFrameBinding.upload(context.sceneFrameUniforms, context.commandContext);
    this.viewGeneration = this.viewGeneration >= Number.MAX_SAFE_INTEGER ? 1 : this.viewGeneration + 1;
    if (this.viewGeneration % CACHE_SWEEP_INTERVAL === 0) this.sweepCaches();
  }

  prepareObjects(
    items: readonly MaterialRenderBatchItem<PlanarMirrorMaterial>[],
    first: number,
    count: number,
  ): void {
    const end = Math.min(items.length, first + count);
    for (let index = first; index < end; index++) {
      const item = items[index];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      this.ensureEntity(item.entityId, item.worldMatrix);
      this.ensureMaterial(item.material);
      this.geometryCache.ensure(item.geometry, this);
    }
  }

  flushUploads(): void {}
  endView(): void {}

  render(
    pass: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: PlanarMirrorMaterial,
    worldMatrix: Float32Array,
  ): void {
    const geo = this.geometryCache.ensure(geometry, this);
    const entity = this.ensureEntity(entityId, worldMatrix);
    const materialData = this.ensureMaterial(material);
    pass.setPipeline(this.getPipeline(geometry));
    pass.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    pass.setBindGroup(1, entity.bindGroup);
    pass.setBindGroup(2, materialData.bindGroup);
    pass.setVertexBuffer(0, geo.positionBuf);
    if (geo.indexBuf) {
      pass.setIndexBuffer(geo.indexBuf, geo.indexFormat);
      pass.drawIndexed(geo.indexCount);
    } else {
      pass.draw(geo.vertexCount);
    }
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = encodeShaderPipelineKey(
      encodePrimitivePipelineKey('triangle-list', 'none', 'ccw', undefined, this.reverseZ, this.msaaSamples),
      this.shaderKey,
    );
    this.addPipelineWarmup(plan, key, 'Planar mirror', () => this.pipelineDescriptor(
      'triangle-list', 'none', 'ccw', undefined,
    ), this.engine.device);
  }

  destroy(): this {
    if (!this.initialized) return this;
    this.initialized = false;
    this.sceneFrameBinding.destroy();
    this.geometryCache.releaseOwner(this);
    for (const entity of this.entities.values()) entity.buffer.destroy();
    for (const byView of this.materials.values()) {
      for (const material of byView.values()) material.buffer.destroy();
    }
    this.entities.clear();
    this.materials.clear();
    this.defaultTexture.destroy();
    this.clearPipelineCache();
    return this;
  }

  private ensureEntity(entityId: number, worldMatrix: Float32Array): MirrorEntityGpuData {
    let data = this.entities.get(entityId);
    if (!data) {
      const buffer = this.engine.device.createBuffer({
        label: `PlanarMirrorRenderer.entity.${entityId}`,
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      data = {
        buffer,
        bindGroup: this.engine.device.createBindGroup({
          layout: this.objectBindGroupLayout,
          entries: [{ binding: 0, resource: { buffer } }],
        }),
        snapshot: new Float32Array(16),
        lastSeenView: this.viewGeneration,
      };
      data.snapshot.fill(Number.NaN);
      this.entities.set(entityId, data);
    }
    data.lastSeenView = this.viewGeneration;
    if (!matrixEquals(data.snapshot, worldMatrix)) {
      writeBuffer(this.engine.device.queue, data.buffer, 0, worldMatrix);
      data.snapshot.set(worldMatrix);
    }
    return data;
  }

  private ensureMaterial(material: PlanarMirrorMaterial): MirrorMaterialGpuData {
    let byView = this.materials.get(material.id);
    if (!byView) {
      byView = new Map();
      this.materials.set(material.id, byView);
    }
    let data = byView.get(this.activeViewKey);
    const reflection = material.getReflection(this.activeViewKey);
    const texture = reflection?.texture ?? this.defaultTexture;
    const textureVersion = reflection?.version ?? -1;
    if (!data) {
      const buffer = this.engine.device.createBuffer({
        label: `PlanarMirrorRenderer.material.${material.id}.${this.activeViewKey}`,
        size: MATERIAL_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      data = {
        buffer,
        bindGroup: this.createMaterialBindGroup(buffer, texture),
        data: new Float32Array(MATERIAL_FLOATS),
        matrixSnapshot: new Float32Array(16),
        texture,
        textureVersion,
        materialRevision: -1,
        lastSeenView: this.viewGeneration,
      };
      data.matrixSnapshot.fill(Number.NaN);
      byView.set(this.activeViewKey, data);
    }
    data.lastSeenView = this.viewGeneration;
    if (data.texture !== texture || data.textureVersion !== textureVersion) {
      data.texture = texture;
      data.textureVersion = textureVersion;
      data.bindGroup = this.createMaterialBindGroup(data.buffer, texture);
    }
    const reflectionMatrix = reflection?.viewProjectionMatrix;
    const matrixChanged = reflectionMatrix ? !matrixEquals(data.matrixSnapshot, reflectionMatrix) : false;
    if (data.materialRevision !== material.revision || matrixChanged) {
      if (reflectionMatrix) {
        data.data.set(reflectionMatrix, 0);
        data.matrixSnapshot.set(reflectionMatrix);
      } else {
        data.data.fill(0, 0, 16);
        data.matrixSnapshot.fill(0);
      }
      data.data[16] = material.tint[0];
      data.data[17] = material.tint[1];
      data.data[18] = material.tint[2];
      data.data[19] = material.reflectivity;
      writeBuffer(this.engine.device.queue, data.buffer, 0, data.data);
      data.materialRevision = material.revision;
    }
    return data;
  }

  private createMaterialBindGroup(buffer: GPUBuffer, texture: GPUTexture): GPUBindGroup {
    return this.engine.device.createBindGroup({
      layout: this.materialBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: this.defaultSampler },
      ],
    });
  }

  private getPipeline(geometry: Geometry3D): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = geometry.cullMode ?? 'none';
    const frontFace = geometry.frontFace ?? 'ccw';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const key = encodeShaderPipelineKey(
      encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples),
      this.shaderKey,
    );
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(
      this.pipelineDescriptor(topology, cullMode, frontFace, stripIndexFormat),
    ));
  }

  private pipelineDescriptor(
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
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      fragment: {
        module: this.shader,
        entryPoint: 'fs_main',
        targets: [{ format: this.engine.format }],
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

  private sweepCaches(): void {
    const oldest = this.viewGeneration - CACHE_SWEEP_INTERVAL * 2;
    for (const [entityId, entity] of this.entities) {
      if (entity.lastSeenView >= oldest) continue;
      entity.buffer.destroy();
      this.entities.delete(entityId);
    }
    for (const [materialId, byView] of this.materials) {
      for (const [viewKey, material] of byView) {
        if (material.lastSeenView >= oldest) continue;
        material.buffer.destroy();
        byView.delete(viewKey);
      }
      if (byView.size === 0) this.materials.delete(materialId);
    }
  }
}
