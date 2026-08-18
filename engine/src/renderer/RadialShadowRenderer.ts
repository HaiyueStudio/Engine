import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import { Geometry3D } from '../geometry/Geometry3D';
import { RadialShadowMaterial } from '../material/RadialShadowMaterial';
import { BaseRenderer } from './BaseRenderer';
import { createPrimitiveState } from './gpuDescriptors';
import { getSharedGeometry3DGPUCache } from './SharedGeometry3DGPUCache';
import { encodePrimitivePipelineKey } from './pipelineKey';
import { getStripIndexFormat, matrixEquals, writeBuffer as wrtBuf } from './utils';
import type { LiveIdSet } from './utils';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { getBuiltin2dUiShader } from '../shader/BuiltinRenderShader';

interface EntityGPUData {
  modelBuf: GPUBuffer;
  modelBindGroup: GPUBindGroup;
  modelSnapshot: Float32Array;
  modelDirty: boolean;
}

interface MatGPUData {
  paramsBuf: GPUBuffer;
  paramsBindGroup: GPUBindGroup;
  paramsData: Float32Array;
  lastColor: [number, number, number];
  lastOpacity: number;
  lastInnerRadius: number;
  paramsDirty: boolean;
}

export class RadialShadowRenderer extends BaseRenderer {
  readonly type = 'radial-shadow';

  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private bgl0!: GPUBindGroupLayout;
  private bgl1!: GPUBindGroupLayout;
  private bgl2!: GPUBindGroupLayout;
  private cameraBuf!: GPUBuffer;
  private cameraBindGroup!: GPUBindGroup;
  private geoCache!: ReturnType<typeof getSharedGeometry3DGPUCache>;
  private entityCache = new Map<number, EntityGPUData>();
  private matCache = new Map<number, MatGPUData>();
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private initialized = false;

  prepare(engine: IEngine): void {
    if (this.initialized) return;
    this.clearPipelineCache();
    this.initialized = true;
    this.engine = engine;
    const { device } = engine;
    this.geoCache = getSharedGeometry3DGPUCache(device, getEngineGPUResourceTracker(engine));

    this.bgl0 = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.bgl1 = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.bgl2 = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const generated = getBuiltin2dUiShader(device, 'radial-shadow', [this.bgl0, this.bgl1, this.bgl2]);
    this.shader = generated.module;
    this.pipelineLayout = generated.pipelineLayout;

    this.cameraBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cameraBindGroup = device.createBindGroup({
      layout: this.bgl0,
      entries: [{ binding: 0, resource: { buffer: this.cameraBuf } }],
    });
  }

  updateCamera(viewProjMatrix: Float32Array): void {
    wrtBuf(this.engine.device.queue, this.cameraBuf, 0, viewProjMatrix);
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = encodePrimitivePipelineKey('triangle-list', 'none', 'ccw', undefined, this.reverseZ, this.msaaSamples);
    this.addPipelineWarmup(
      plan,
      key,
      'Radial shadow',
      () => this._pipelineDescriptor('triangle-list', 'none', 'ccw', undefined),
      this.engine.device,
    );
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this.entityCache, liveEntities, data => data.modelBuf.destroy());
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    this.geoCache.releaseUnused(this, liveGeometries);
  }

  releaseMaterialsNotIn(liveMaterials: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this.matCache, liveMaterials, data => data.paramsBuf.destroy());
  }

  render(
    passEncoder: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: RadialShadowMaterial,
    worldMatrix: Float32Array,
  ): void {
    const { device } = this.engine;
    const geoData = this.geoCache.ensure(geometry, this);

    let entData = this.entityCache.get(entityId);
    if (!entData) {
      const modelBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      entData = {
        modelBuf,
        modelBindGroup: device.createBindGroup({
          layout: this.bgl1,
          entries: [{ binding: 0, resource: { buffer: modelBuf } }],
        }),
        modelSnapshot: new Float32Array(16),
        modelDirty: true,
      };
      this.entityCache.set(entityId, entData);
    }
    if (entData.modelDirty || !matrixEquals(entData.modelSnapshot, worldMatrix)) {
      wrtBuf(device.queue, entData.modelBuf, 0, worldMatrix);
      entData.modelSnapshot.set(worldMatrix);
      entData.modelDirty = false;
    }

    let matData = this.matCache.get(material.id);
    if (!matData) {
      const paramsBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      matData = {
        paramsBuf,
        paramsBindGroup: device.createBindGroup({
          layout: this.bgl2,
          entries: [{ binding: 0, resource: { buffer: paramsBuf } }],
        }),
        paramsData: new Float32Array(8),
        lastColor: [-1, -1, -1],
        lastOpacity: -1,
        lastInnerRadius: -1,
        paramsDirty: true,
      };
      this.matCache.set(material.id, matData);
    }
    material.color.writeSRGB(matData.paramsData, 0);
    if (
      matData.paramsDirty ||
      matData.lastColor[0] !== matData.paramsData[0] ||
      matData.lastColor[1] !== matData.paramsData[1] ||
      matData.lastColor[2] !== matData.paramsData[2] ||
      matData.lastOpacity !== material.opacity ||
      matData.lastInnerRadius !== material.innerRadius
    ) {
      matData.paramsData[3] = material.opacity;
      matData.paramsData[4] = material.innerRadius;
      wrtBuf(device.queue, matData.paramsBuf, 0, matData.paramsData);
      matData.lastColor[0] = matData.paramsData[0]!;
      matData.lastColor[1] = matData.paramsData[1]!;
      matData.lastColor[2] = matData.paramsData[2]!;
      matData.lastOpacity = material.opacity;
      matData.lastInnerRadius = material.innerRadius;
      matData.paramsDirty = false;
    }

    passEncoder.setPipeline(this._getPipeline(geometry));
    passEncoder.setBindGroup(0, this.cameraBindGroup);
    passEncoder.setBindGroup(1, entData.modelBindGroup);
    passEncoder.setBindGroup(2, matData.paramsBindGroup);
    passEncoder.setVertexBuffer(0, geoData.positionBuf);
    passEncoder.setVertexBuffer(1, geoData.uvBuf);
    if (geoData.indexBuf) {
      passEncoder.setIndexBuffer(geoData.indexBuf, geoData.indexFormat);
      passEncoder.drawIndexed(geoData.indexCount);
    } else {
      passEncoder.draw(geoData.vertexCount);
    }
  }

  private _getPipeline(geometry: Geometry3D): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode: GPUCullMode = geometry.cullMode ?? 'none';
    const frontFace = geometry.frontFace ?? 'ccw';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const key = encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples);
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
      const { format } = this.engine;
      return {
        layout: this.pipelineLayout,
        vertex: {
          module: this.shader,
          entryPoint: 'vs_main',
          buffers: [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] },
          ],
        },
        fragment: {
          module: this.shader,
          entryPoint: 'fs_main',
          targets: [{
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          }],
        },
        primitive: createPrimitiveState(topology, cullMode, frontFace, stripIndexFormat),
        depthStencil: {
          format: this.engine.getDepthFormat(this.reverseZ),
          depthWriteEnabled: false,
          depthCompare: this.reverseZ ? 'greater' : 'less',
        },
        multisample: { count: this.msaaSamples },
      };
  }

  destroy(): void {
    this.cameraBuf?.destroy();
    this.geoCache?.releaseOwner(this);
    this.destroyCacheEntries(this.entityCache, entity => entity.modelBuf.destroy());
    this.destroyCacheEntries(this.matCache, material => material.paramsBuf.destroy());
    this.clearPipelineCache();
  }
}
