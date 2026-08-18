import type { IEngine } from '../core/IEngine';
import type { Geometry2D } from '../geometry/Geometry2D';
import { Material2D } from '../material/Material2D';
import type { BlendMode2D } from '../material/Material2D';
import { BaseRenderer } from './BaseRenderer';
import { createColorTargetState, createPrimitiveState } from './gpuDescriptors';
import { encodePrimitivePipelineKey } from './pipelineKey';
import { getStripIndexFormat, matrixEquals, writeBuffer as wrtBuf, writeBufferAligned } from './utils';
import type { LiveIdSet } from './utils';
import { alignUp4 } from '../utils/align';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { Material2DRendererRegistry } from './Material2DRendererRegistry';
import type { Material2DRenderBatchItem, Material2DRenderContext, Material2DRendererRegistration } from './Material2DRendererRegistry';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { RendererObjectTable } from './RendererObjectTable';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { getBuiltin2dUiShader } from '../shader/BuiltinRenderShader';

// ── Cache types ───────────────────────────────────────────────────────────────

interface GeoGPU {
  vertBuf:    GPUBuffer;
  idxBuf:     GPUBuffer | null;
  version: number;
  indexCount:  number;
  vertexCount: number;
  indexFormat: GPUIndexFormat;
}

interface EntGPU {
  objectSlot: number;
  modelSnapshot: Float32Array;
  lastColor: [number, number, number, number];
  uniformDirty: boolean;
}

const OBJECT_TABLE_FLOATS = 20;
const OBJECT_TABLE_COLOR_OFFSET = 16;

// ── Renderer ──────────────────────────────────────────────────────────────────

export class Mesh2DRenderer extends BaseRenderer {
  reverseZ    = false;
  msaaSamples: 1 | 4 = 1;
  readonly materialRenderers = new Material2DRendererRegistry();

  private engine!: IEngine;

  private bgl0!: GPUBindGroupLayout;
  private bgl1!: GPUBindGroupLayout;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;

  private _cameraBuf!: GPUBuffer;
  private _cameraBG!:  GPUBindGroup;
  private _objectTable!: RendererObjectTable;

  private _geoCache = new Map<number, GeoGPU>();
  private _entCache = new Map<number, EntGPU>();
  private readonly _materialRunScratch: Material2DRenderBatchItem[] = [];
  private readonly _basicMaterialRegistration: Material2DRendererRegistration<Material2D>;
  private _basicUploadsPrepared = false;

  private _initialized = false;
  private readonly _materialRenderContext: Material2DRenderContext = {
    engine: null as unknown as IEngine,
    passEncoder: null as unknown as GPURenderPassEncoder,
    entityId: 0,
    geometry: null as unknown as Geometry2D,
    material: null as unknown as Material2D,
    worldMatrix: null as unknown as Float32Array,
    reverseZ: false,
    msaaSamples: 1,
  };

  constructor() {
    super();
    this._basicMaterialRegistration = {
      materialType: Material2D,
      render: context => this._renderBasicMaterial(
        context.passEncoder,
        context.entityId,
        context.geometry,
        context.material,
        context.worldMatrix,
      ),
      renderBatch: (context, items) => this._renderBasicMaterialBatch(context.passEncoder, items),
    };
    this.materialRenderers.register(this._basicMaterialRegistration);
  }

  registerMaterialRenderer<M extends Material2D>(registration: Material2DRendererRegistration<M>): this {
    this.materialRenderers.register(registration);
    return this;
  }

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this.clearPipelineCache();
    this._initialized = true;
    this.engine = engine;
    const { device } = engine;

    this.bgl0 = this.getSharedRendererResource(device, 'Mesh2DRenderer.bgl0', () => device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    }));
    this.bgl1 = this.getSharedRendererResource(device, 'Mesh2DRenderer.bgl1', () => device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }],
    }));
    const generated = getBuiltin2dUiShader(device, 'mesh2d', [this.bgl0, this.bgl1]);
    this.shader = generated.module;
    this.pipelineLayout = generated.pipelineLayout;

    this._cameraBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._cameraBG  = device.createBindGroup({
      layout: this.bgl0,
      entries: [{ binding: 0, resource: { buffer: this._cameraBuf } }],
    });
    this._objectTable = new RendererObjectTable({
      device,
      bindGroupLayout: this.bgl1,
      label: 'Mesh2DRenderer.objectTable',
      floatsPerSlot: OBJECT_TABLE_FLOATS,
    });
    this._objectTable.ensureCapacity(1);
  }

  updateCamera(viewProj: Float32Array): void {
    wrtBuf(this.engine.device.queue, this._cameraBuf, 0, viewProj);
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const topology: GPUPrimitiveTopology = 'triangle-list';
    const stripIndexFormat = undefined;
    for (const blending of ['none', 'normal', 'additive'] as const) {
      const blendFlag = blending === 'normal' ? 1 : blending === 'additive' ? 2 : 0;
      const key = encodePrimitivePipelineKey(topology, 'none', 'ccw', stripIndexFormat, this.reverseZ, this.msaaSamples, blendFlag);
      this.addPipelineWarmup(
        plan,
        key,
        `Mesh 2D ${blending === 'none' ? 'opaque' : blending}`,
        () => this._pipelineDescriptor(blending, topology, stripIndexFormat),
        this.engine.device,
      );
    }
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this._entCache, liveEntities, data => this._destroyEntityData(data));
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this._geoCache, liveGeometries, data => {
      data.vertBuf.destroy();
      data.idxBuf?.destroy();
    });
  }

  render(
    passEncoder: GPURenderPassEncoder,
    entityId:    number,
    geometry:    Geometry2D,
    material:    Material2D,
    worldMatrix: Float32Array,
    submissionContext?: RenderCommandContext,
  ): void {
    this._objectTable.beginUploads(submissionContext);
    const registration = this.materialRenderers.resolve(material);
    if (!registration) {
      throw new EngineError(
        EngineErrorCode.RenderPipelineUnsupportedMaterial,
        `No 2D material renderer is registered for ${material.constructor.name}.`,
        {
          hint: 'Call mesh2DRenderer.registerMaterialRenderer(...) or Mesh2DRenderSystem.registerMaterialRenderer(...) with this material type registered.',
          docsPath: 'errors/E_RENDER_PIPELINE_UNSUPPORTED_MATERIAL',
        },
      );
    }
    registration.render(this._setMaterialRenderContext(passEncoder, entityId, geometry, material, worldMatrix));
  }

  renderBatch<M extends Material2D>(
    passEncoder: GPURenderPassEncoder,
    items: readonly Material2DRenderBatchItem<M>[],
    submissionContext?: RenderCommandContext,
  ): void {
    const first = items[0];
    if (!first) return;
    this._objectTable.beginUploads(submissionContext);
    const registration = this.materialRenderers.resolve(first.material);
    if (!registration) {
      throw new EngineError(
        EngineErrorCode.RenderPipelineUnsupportedMaterial,
        `No 2D material renderer is registered for ${first.material.constructor.name}.`,
        {
          hint: 'Call mesh2DRenderer.registerMaterialRenderer(...) or Mesh2DRenderSystem.registerMaterialRenderer(...) with this material type registered.',
          docsPath: 'errors/E_RENDER_PIPELINE_UNSUPPORTED_MATERIAL',
        },
      );
    }
    const context = this._setMaterialRenderContext(passEncoder, first.entityId, first.geometry, first.material, first.worldMatrix);
    if (registration.renderBatch) {
      registration.renderBatch(context, items);
      return;
    }
    for (const item of items) {
      registration.render(this._setMaterialRenderContext(passEncoder, item.entityId, item.geometry, item.material, item.worldMatrix));
    }
  }

  renderMany(
    passEncoder: GPURenderPassEncoder,
    items: readonly Material2DRenderBatchItem[],
    submissionContext?: RenderCommandContext,
  ): void {
    const first = items[0];
    if (!first) return;
    this._objectTable.beginUploads(submissionContext);
    for (const item of items) {
      if (this.materialRenderers.resolve(item.material) === this._basicMaterialRegistration) {
        this._prepareBasicMaterial(item.entityId, item.geometry, item.material, item.worldMatrix);
      }
    }
    this._objectTable.flushUploads();
    this._basicUploadsPrepared = true;
    try {
      let runStart = 0;
      let runRegistration = this._requireMaterialRenderer(first.material);
      for (let i = 1; i <= items.length; i++) {
        const item = i < items.length ? items[i] : null;
        const registration = item ? this._requireMaterialRenderer(item.material) : null;
        if (item && registration === runRegistration) continue;
        this._renderResolvedBatch(passEncoder, runRegistration, items, runStart, i);
        if (item && registration) {
          runStart = i;
          runRegistration = registration;
        }
      }
    } finally {
      this._basicUploadsPrepared = false;
    }
  }

  private _requireMaterialRenderer<M extends Material2D>(material: M): Material2DRendererRegistration<M> {
    const registration = this.materialRenderers.resolve(material);
    if (!registration) {
      throw new EngineError(
        EngineErrorCode.RenderPipelineUnsupportedMaterial,
        `No 2D material renderer is registered for ${material.constructor.name}.`,
        {
          hint: 'Call mesh2DRenderer.registerMaterialRenderer(...) or Mesh2DRenderSystem.registerMaterialRenderer(...) with this material type registered.',
          docsPath: 'errors/E_RENDER_PIPELINE_UNSUPPORTED_MATERIAL',
        },
      );
    }
    return registration;
  }

  private _renderResolvedBatch<M extends Material2D>(
    passEncoder: GPURenderPassEncoder,
    registration: Material2DRendererRegistration<M>,
    items: readonly Material2DRenderBatchItem[],
    start: number,
    end: number,
  ): void {
    if (end <= start) return;
    const first = items[start] as Material2DRenderBatchItem<M>;
    const context = this._setMaterialRenderContext(passEncoder, first.entityId, first.geometry, first.material, first.worldMatrix);
    if (registration.renderBatch) {
      const batch = this._materialRunScratch as Material2DRenderBatchItem<M>[];
      batch.length = 0;
      for (let i = start; i < end; i++) batch.push(items[i] as Material2DRenderBatchItem<M>);
      registration.renderBatch(context, batch);
      batch.length = 0;
      return;
    }
    for (let i = start; i < end; i++) {
      const item = items[i] as Material2DRenderBatchItem<M>;
      registration.render(this._setMaterialRenderContext(passEncoder, item.entityId, item.geometry, item.material, item.worldMatrix));
    }
  }

  private _setMaterialRenderContext<M extends Material2D>(
    passEncoder: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry2D,
    material: M,
    worldMatrix: Float32Array,
  ): Material2DRenderContext<M> {
    const context = this._materialRenderContext as Material2DRenderContext<M>;
    context.engine = this.engine;
    context.passEncoder = passEncoder;
    context.entityId = entityId;
    context.geometry = geometry;
    context.material = material;
    context.worldMatrix = worldMatrix;
    context.reverseZ = this.reverseZ;
    context.msaaSamples = this.msaaSamples;
    return context;
  }

  private _renderBasicMaterial(
    passEncoder: GPURenderPassEncoder,
    entityId:    number,
    geometry:    Geometry2D,
    material:    Material2D,
    worldMatrix: Float32Array,
  ): void {
    const preparedGeo = this._basicUploadsPrepared ? this._geoCache.get(geometry.id) : undefined;
    const preparedEnt = this._basicUploadsPrepared ? this._entCache.get(entityId) : undefined;
    const { geo, ent } = preparedGeo && preparedEnt
      ? { geo: preparedGeo, ent: preparedEnt }
      : this._prepareBasicMaterial(entityId, geometry, material, worldMatrix);
    if (!this._basicUploadsPrepared) this._objectTable.flushUploads();

    // ── Pipeline ───────────────────────────────────────────────────────────────
    const pipeline = this._getPipeline(geometry, material.blending);

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, this._cameraBG);
    passEncoder.setBindGroup(1, this._objectTable.bindGroup);
    passEncoder.setVertexBuffer(0, geo.vertBuf);

    if (geo.idxBuf) {
      passEncoder.setIndexBuffer(geo.idxBuf, geo.indexFormat);
      passEncoder.drawIndexed(geo.indexCount, 1, 0, 0, ent.objectSlot);
    } else {
      passEncoder.draw(geo.vertexCount, 1, 0, ent.objectSlot);
    }
  }

  private _renderBasicMaterialBatch(
    passEncoder: GPURenderPassEncoder,
    items: readonly Material2DRenderBatchItem<Material2D>[],
  ): void {
    if (this._basicUploadsPrepared) {
      for (const item of items) {
        this._renderBasicMaterial(passEncoder, item.entityId, item.geometry, item.material, item.worldMatrix);
      }
      return;
    }
    for (const item of items) this._prepareBasicMaterial(item.entityId, item.geometry, item.material, item.worldMatrix);
    this._objectTable.flushUploads();
    this._basicUploadsPrepared = true;
    try {
      for (const item of items) {
        this._renderBasicMaterial(passEncoder, item.entityId, item.geometry, item.material, item.worldMatrix);
      }
    } finally {
      this._basicUploadsPrepared = false;
    }
  }

  private _prepareBasicMaterial(
    entityId: number,
    geometry: Geometry2D,
    material: Material2D,
    worldMatrix: Float32Array,
  ): { geo: GeoGPU; ent: EntGPU } {
    const geo = this._getOrCreateGeometryGpu(geometry);
    let ent = this._entCache.get(entityId);
    if (!ent) {
      ent = {
        objectSlot: this._objectTable.allocateSlot(),
        modelSnapshot: new Float32Array(16),
        lastColor: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
        uniformDirty: true,
      };
      this._entCache.set(entityId, ent);
    }
    this._writeObjectUniform(ent, worldMatrix, material);
    return { geo, ent };
  }

  private _getOrCreateGeometryGpu(geometry: Geometry2D): GeoGPU {
    let geo = this._geoCache.get(geometry.id);
    if (!geo) {
      geo = this._createGeometryGpu(geometry);
      this._geoCache.set(geometry.id, geo);
      return geo;
    }
    if (geo.version !== geometry.version) {
      geo.vertBuf.destroy();
      geo.idxBuf?.destroy();
      geo = this._createGeometryGpu(geometry);
      this._geoCache.set(geometry.id, geo);
    }
    return geo;
  }

  private _createGeometryGpu(geometry: Geometry2D): GeoGPU {
    const { device } = this.engine;
    const pos = geometry.positions;
    const vertBuf = device.createBuffer({
      size: alignUp4(pos.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    wrtBuf(device.queue, vertBuf, 0, pos);

    let idxBuf: GPUBuffer | null = null;
    let indexFormat: GPUIndexFormat = 'uint16';
    if (geometry.indices) {
      const idx = geometry.indices;
      idxBuf = device.createBuffer({
        size: alignUp4(idx.byteLength),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      writeBufferAligned(device.queue, idxBuf, 0, idx);
      indexFormat = idx instanceof Uint32Array ? 'uint32' : 'uint16';
    }

    return {
      vertBuf,
      idxBuf,
      version: geometry.version,
      indexCount: geometry.indexCount,
      vertexCount: geometry.vertexCount,
      indexFormat,
    };
  }

  private _writeObjectUniform(ent: EntGPU, worldMatrix: Float32Array, material: Material2D): void {
    const colorBase = ent.objectSlot * OBJECT_TABLE_FLOATS + OBJECT_TABLE_COLOR_OFFSET;
    const objectTableData = this._objectTable.data;
    material.color.writeSRGB(objectTableData, colorBase);
    const r = objectTableData[colorBase]!;
    const g = objectTableData[colorBase + 1]!;
    const b = objectTableData[colorBase + 2]!;
    const a = objectTableData[colorBase + 3]!;
    const color = ent.lastColor;
    const matrixChanged = ent.uniformDirty || !matrixEquals(ent.modelSnapshot, worldMatrix);
    const colorChanged =
      color[0] !== r ||
      color[1] !== g ||
      color[2] !== b ||
      color[3] !== a;

    if (!matrixChanged && !colorChanged) {
      return;
    }

    if (matrixChanged) {
      const base = ent.objectSlot * OBJECT_TABLE_FLOATS;
      objectTableData.set(worldMatrix, base);
      ent.modelSnapshot.set(worldMatrix);
    }
    if (colorChanged || ent.uniformDirty) {
      color[0] = r;
      color[1] = g;
      color[2] = b;
      color[3] = a;
    }
    this._objectTable.writeSlot(ent.objectSlot);
    ent.uniformDirty = false;
  }

  private _destroyEntityData(ent: EntGPU): void {
    this._objectTable.releaseSlot(ent.objectSlot);
  }

  private _getPipeline(geometry: Geometry2D, blending: BlendMode2D): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const blendFlag = blending === 'normal' ? 1 : blending === 'additive' ? 2 : 0;
    const key = encodePrimitivePipelineKey(topology, 'none', 'ccw', stripIndexFormat, this.reverseZ, this.msaaSamples, blendFlag);
    return this.getCachedPipeline(key, () => this._makePipeline(blending, topology, stripIndexFormat));
  }

  private _makePipeline(
    blending: BlendMode2D,
    topology: GPUPrimitiveTopology,
    stripIndexFormat: GPUIndexFormat | undefined,
  ): GPURenderPipeline {
    return this.engine.device.createRenderPipeline(this._pipelineDescriptor(blending, topology, stripIndexFormat));
  }

  private _pipelineDescriptor(
    blending: BlendMode2D,
    topology: GPUPrimitiveTopology,
    stripIndexFormat: GPUIndexFormat | undefined,
  ): GPURenderPipelineDescriptor {
    const { format } = this.engine;
    const rz   = this.reverseZ;
    const msaa = this.msaaSamples;

    const blend: GPUBlendState | undefined = blending === 'none'
      ? undefined
      : blending === 'additive'
        ? {
            color: { srcFactor: 'src-alpha', dstFactor: 'one',                operation: 'add' },
            alpha: { srcFactor: 'zero',      dstFactor: 'one',                operation: 'add' },
          }
        : {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          };

    return {
      layout: this.pipelineLayout,
      vertex:   { module: this.shader, entryPoint: 'vs_main', buffers: [{
        arrayStride: 8,
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
      }] },
      fragment: { module: this.shader, entryPoint: 'fs_main', targets: [createColorTargetState(format, blend)] },
      primitive: createPrimitiveState(topology, 'none', 'ccw', stripIndexFormat),
      depthStencil: {
        format:            this.engine.getDepthFormat(rz),
        depthWriteEnabled: false,
        depthCompare:      'always',
      },
      multisample: { count: msaa },
    };
  }

  destroy(): void {
    this._cameraBuf?.destroy();
    this._objectTable?.destroy();
    this.destroyCacheEntries(this._geoCache, g => { g.vertBuf.destroy(); g.idxBuf?.destroy(); });
    this.destroyCacheEntries(this._entCache, e => this._destroyEntityData(e));
    this.clearPipelineCache();
    this.materialRenderers.destroy();
  }
}
