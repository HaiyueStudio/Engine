import { ViewLightUniformBuffer, LIGHT_UNIFORM_BYTES, LIGHT_UNIFORM_BINDING } from './ViewLightUniformBuffer';
import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { BlinnPhongMaterial } from '../material/BlinnPhongMaterial';
import { mat4 } from 'wgpu-matrix';
import { BaseRenderer } from './BaseRenderer';
import type { SharedGeometry3DGPUData } from './SharedGeometry3DGPUCache';
import { encodePrimitivePipelineKey } from './pipelineKey';
import { colorEquals, getStripIndexFormat, matrixEquals, writeBuffer as wrtBuf } from './utils';
import type { LiveIdSet } from './utils';
import type { MaterialGpuDrivenBatch, MaterialRenderBatchItem } from './MaterialRendererRegistry';
import type { GpuDrivenBatchBuffer } from './GpuDrivenBatchBuffer';
import { forEachDirectInstanceBatchRun, forEachIndirectBatchRun } from './DirectInstanceBatchRuns';
import { createColorTargetState, createPrimitiveState } from './gpuDescriptors';
import { RendererObjectTable } from './RendererObjectTable';
import { RendererCacheMap, RendererObjectSlotCache } from './RendererCacheMap';
import { SCENE_RENDER_MAX_LIGHTS, type PbrLightInfo } from '../frame/SceneRenderEnvironment';
import { getBuiltinMaterialLightingShader } from '../shader/BuiltinMaterialLightingShader';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { CLIPPING_BLOCK_FLOATS, clippingStateKey, writeClippingBlock } from './ClippingPlanesGpu';
import { ParameterizedRendererCore, SharedGeometryRendererOwner } from './ParameterizedRendererCore';

// ─────────────────────────────────────────────────────────────────────────────
// GPU buffer layout (all sizes in bytes)
//
// Scene frame UBO (group 0) follows SceneFrameUniformLayout.
// Object table(group 1):  array<model[64] + normalMatrix[64]> = 128 * objects
// Material UBO(group 2):  ambient[16]  + diffuse[16]
//                       + specular[16] + shininess+pad[16]    = 64
// Lights UBO  (group 3):  countVec[16] + LightData[8×64]      = 528
//   LightData: typeVec[16] + color[16] + direction[16] + position[16]
// ─────────────────────────────────────────────────────────────────────────────

export const BLINN_PHONG_MAX_LIGHTS = SCENE_RENDER_MAX_LIGHTS;

// Byte sizes
const OBJ_BASE_FLOATS = 128 / 4;
const OBJ_FLOATS = OBJ_BASE_FLOATS;
const MAT_SIZE   =  64;

// ─────────────────────────────────────────────────────────────────────────────
// GPU cache types
// ─────────────────────────────────────────────────────────────────────────────

interface ObjGPU {
  modelSlot: number;
  modelSnapshot: Float32Array;
  clippingKey: string;
  dirty: boolean;
}

interface MatGPU {
  buf: GPUBuffer;
  bg:  GPUBindGroup;
  data: Float32Array;
  lastAmbient: [number, number, number, number];
  lastDiffuse: [number, number, number, number];
  lastSpecular: [number, number, number, number];
  lastShininess: number;
  dirty: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────────────────────

export class BlinnPhongRenderer extends BaseRenderer {
  reverseZ    = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;

  private _bgl0!: GPUBindGroupLayout; // camera
  private _bgl1!: GPUBindGroupLayout; // object
  private _bgl2!: GPUBindGroupLayout; // material
  private _bgl3!: GPUBindGroupLayout; // lights
  private _shader!: GPUShaderModule;
  private _shaderKey = '';
  private _pipelineLayout!: GPUPipelineLayout;

  private _sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly _cameraDynamicOffset = new Uint32Array(1);
  private _rendererCore!: ParameterizedRendererCore<ObjGPU, SharedGeometry3DGPUData>;
  private get _objectTable(): RendererObjectTable { return this._rendererCore.requireObjectTable(); }
  private get _batchObjectTable(): RendererObjectTable { return this._rendererCore.requireBatchObjectTable(); }
  private get _geoCache(): SharedGeometryRendererOwner { return this._rendererCore.geometry as SharedGeometryRendererOwner; }
  private get _objCache(): RendererObjectSlotCache<ObjGPU> { return this._rendererCore.requireObjects(); }

  private _lightUniforms!: ViewLightUniformBuffer;
  private _lights: readonly PbrLightInfo[] = [];
  private _lightsNeedUpload = false;
  private _lightBG!:  GPUBindGroup;

  private _matCache = new RendererCacheMap<MatGPU>(data => data.buf.destroy());
  private _inverseScratch = mat4.identity() as Float32Array;
  private _normalScratch = mat4.identity() as Float32Array;
  private _warnedLightLimit = false;
  private _initialized = false;
  private get _uploadsPrepared(): boolean { return this._rendererCore.uploadsPrepared; }

  // ── Init ────────────────────────────────────────────────────────────────────

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this.clearPipelineCache();
    this._initialized = true;
    this.engine = engine;
    const { device } = engine;
    this._sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this._bgl0 = this._sceneFrameBinding.bindGroupLayout;
    this._bgl1 = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ] });
    this._bgl2 = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this._bgl3 = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: LIGHT_UNIFORM_BINDING }],
    });

    const generated = getBuiltinMaterialLightingShader(
      device,
      'blinn-phong',
      [this._bgl0, this._bgl1, this._bgl2, this._bgl3],
    );
    this._shader = generated.module;
    this._shaderKey = generated.pass.canonicalHash;
    this._pipelineLayout = generated.pipelineLayout;

    this._rendererCore = new ParameterizedRendererCore({
      objectTables: {
        device,
        bindGroupLayout: this._bgl1,
        label: 'BlinnPhongRenderer',
        floatsPerSlot: OBJ_FLOATS,
        auxiliary: { binding: 1, floatsPerSlot: CLIPPING_BLOCK_FLOATS, label: 'BlinnPhongRenderer.clippingTable' },
      },
      createObject: modelSlot => ({
        modelSlot,
        modelSnapshot: new Float32Array(16),
        clippingKey: '',
        dirty: true,
      }),
      geometry: new SharedGeometryRendererOwner(device, this, getEngineGPUResourceTracker(engine)),
    });

    // Lights buffer
    this._lightUniforms = new ViewLightUniformBuffer(device, 'BlinnPhongRenderer.lights');
    this._rebuildLightBindGroup();
  }

  // ── Per-frame camera + lights upload ──────────────────────────────────────

  updateCamera(sceneFrame: SceneFrameUniformSnapshot, context?: RenderCommandContext): void {
    this._lightsNeedUpload = true;
    if (this._lightUniforms.selectView(sceneFrame, context)) this._rebuildLightBindGroup();
    this._cameraDynamicOffset[0] = this._sceneFrameBinding.upload(sceneFrame, context);
    this._rendererCore.beginUploads(context);
  }

  prepareObjects(
    items: readonly MaterialRenderBatchItem<BlinnPhongMaterial>[],
    first = 0,
    count = items.length - first,
    firstBatchIndex = first,
    batchBuffer: GpuDrivenBatchBuffer | null = null,
  ): void {
    const end = Math.min(items.length, first + count);
    for (let index = first; index < end; index++) {
      const item = items[index];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      this._geoCache.ensure(item.geometry, this);
      const object = this._objCache.ensure(item.entityId);
      const batchSlot = batchBuffer && item.material.blending === 'none'
        ? batchBuffer.getObjectSlot(firstBatchIndex + index - first)
        : undefined;
      const objectSlot = batchSlot ?? object.modelSlot;
      const objectTable = batchSlot === undefined ? this._objectTable : this._batchObjectTable;
      this._writeObjectTableEntry(object, item.clippingPlanes, item.worldMatrix, objectSlot, objectTable, batchSlot === undefined);
      const materialData = this._ensureMaterial(item.material);
      this._writeMaterialUniform(materialData, item.material);
    }
  }

  flushUploads(): void {
    this._rendererCore.flushUploads();
  }

  endView(): void {
    this._rendererCore.endView();
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    for (const blended of [false, true]) {
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
        blended ? 1 : 0,
      );
      const key = this._rendererCore.pipelineKey(primitiveKey, this._shaderKey);
      this.addPipelineWarmup(
        plan,
        key,
        `Blinn-Phong ${blended ? 'alpha blend' : 'opaque'}`,
        () => this._pipelineDescriptor(topology, cullMode, frontFace, blended),
        this.engine.device,
      );
    }
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    this._objCache.releaseNotIn(liveEntities);
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    this._geoCache.releaseUnused(this, liveGeometries);
  }

  releaseMaterialsNotIn(liveMaterials: LiveIdSet): void {
    this._matCache.releaseNotIn(liveMaterials);
  }

  updateLights(lights: readonly PbrLightInfo[]): void {
    this._lights = lights;
    this._lightsNeedUpload = false;
    if (lights.length > BLINN_PHONG_MAX_LIGHTS && !this._warnedLightLimit) {
      this._warnedLightLimit = true;
      console.warn(`[BlinnPhongRenderer] Received ${lights.length} lights; only the first ${BLINN_PHONG_MAX_LIGHTS} are used.`);
    }
    const previousBuffer = this._lightUniforms.buffer;
    this._lightUniforms.upload(lights);
    if (previousBuffer !== this._lightUniforms.buffer) this._rebuildLightBindGroup();
  }

  private _rebuildLightBindGroup(): void {
    this._lightBG = this.engine.device.createBindGroup({
      layout: this._bgl3,
      entries: [{ binding: 0, resource: { buffer: this._lightUniforms.buffer, size: LIGHT_UNIFORM_BYTES } }],
    });
  }

  // ── Draw ────────────────────────────────────────────────────────────────────

  render(
    pass:        GPURenderPassEncoder,
    entityId:    number,
    geometry:    Geometry3D,
    material:    BlinnPhongMaterial,
    worldMatrix: Float32Array,
    options:     { gpuDrivenBatch?: MaterialGpuDrivenBatch | undefined } = {},
    clippingPlanes: ClippingPlanes | null = null,
  ): void {
    if (this._lightsNeedUpload) this.updateLights(this._lights);
    const gpuDrivenBatch = options.gpuDrivenBatch;
    this._renderItem(
      pass,
      entityId,
      geometry,
      material,
      clippingPlanes,
      worldMatrix,
      gpuDrivenBatch?.batchBuffer,
      gpuDrivenBatch?.batchIndex,
    );
  }

  renderBatch(
    pass: GPURenderPassEncoder,
    items: readonly MaterialRenderBatchItem<BlinnPhongMaterial>[],
    first: number,
    count: number,
    batchBuffer: GpuDrivenBatchBuffer,
  ): void {
    if (this._lightsNeedUpload) this.updateLights(this._lights);
    if (!batchBuffer.gpuUploadEnabled || this._uploadsPrepared) {
      const visitRuns = batchBuffer.gpuUploadEnabled ? forEachIndirectBatchRun : forEachDirectInstanceBatchRun;
      visitRuns(items, first, count, batchBuffer, run => {
        const item = run.item;
        const geo = this._geoCache.ensure(item.geometry, this);
        const mat = this._ensureMaterial(item.material);
        if (!this._uploadsPrepared) this._writeMaterialUniform(mat, item.material);
        const bindings = batchBuffer.gpuUploadEnabled ? this.indirectBatches.begin() : pass;
        bindings.setPipeline(item.material.blending === 'none' ? this._getOpaquePipeline(item.geometry) : this._getBlendPipeline(item.geometry));
        bindings.setBindGroup(0, this._sceneFrameBinding.bindGroup, this._cameraDynamicOffset);
        bindings.setBindGroup(1, this._batchObjectTable.bindGroup);
        bindings.setBindGroup(2, mat.bg);
        bindings.setBindGroup(3, this._lightBG, this._lightUniforms.dynamicOffset);
        bindings.setVertexBuffer(0, geo.positionBuf);
        bindings.setVertexBuffer(1, geo.normalBuf);
        bindings.setVertexBuffer(2, geo.uvBuf);
        if (batchBuffer.gpuUploadEnabled) {
          this.indirectBatches.draw(pass, this.engine.device, batchBuffer, run.firstBatch,
            run.instanceCount, geo.indexBuf, geo.indexFormat, [this.colorFormat ?? this.engine.format],
            this.engine.getDepthFormat(this.reverseZ), this.msaaSamples);
          return;
        }
        if (geo.indexBuf) {
          pass.setIndexBuffer(geo.indexBuf, geo.indexFormat);
          pass.drawIndexed(geo.indexCount, run.instanceCount, 0, 0, run.firstInstance);
        } else {
          pass.draw(geo.vertexCount, run.instanceCount, 0, run.firstInstance);
        }
      });
      return;
    }
    const end = Math.min(items.length, first + count);
    for (let batchIndex = first; batchIndex < end; batchIndex++) {
      const item = items[batchIndex];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      this._renderItem(
        pass,
        item.entityId,
        item.geometry,
        item.material,
        item.clippingPlanes,
        item.worldMatrix,
        batchBuffer,
        batchIndex,
      );
    }
  }

  private _renderItem(
    pass: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: BlinnPhongMaterial,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    batchBuffer?: GpuDrivenBatchBuffer,
    batchIndex?: number,
  ): void {
    // ── Geometry ──────────────────────────────────────────────────────────────
    const geo = this._geoCache.ensure(geometry, this);

    const obj = this._objCache.ensure(entityId);

    const batchSlot = batchBuffer && batchIndex !== undefined
      ? batchBuffer.getObjectSlot(batchIndex)
      : undefined;
    const objectSlot = batchSlot ?? obj.modelSlot;
    const objectTable = batchSlot === undefined ? this._objectTable : this._batchObjectTable;
    if (!this._uploadsPrepared) {
      this._writeObjectTableEntry(obj, clippingPlanes, worldMatrix, objectSlot, objectTable, batchSlot === undefined);
    }

    // ── Material ──────────────────────────────────────────────────────────────
    const mat = this._ensureMaterial(material);

    if (!this._uploadsPrepared) this._writeMaterialUniform(mat, material);

    // ── Pipeline ──────────────────────────────────────────────────────────────
    const pipeline = material.blending === 'none'
      ? this._getOpaquePipeline(geometry)
      : this._getBlendPipeline(geometry);

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this._sceneFrameBinding.bindGroup, this._cameraDynamicOffset);
    pass.setBindGroup(1, objectTable.bindGroup);
    pass.setBindGroup(2, mat.bg);
    pass.setBindGroup(3, this._lightBG, this._lightUniforms.dynamicOffset);
    pass.setVertexBuffer(0, geo.positionBuf);
    pass.setVertexBuffer(1, geo.normalBuf);
    pass.setVertexBuffer(2, geo.uvBuf);

    if (geo.indexBuf) {
      pass.setIndexBuffer(geo.indexBuf, geo.indexFormat);
      if (batchBuffer && batchIndex !== undefined) {
        pass.drawIndexedIndirect(batchBuffer.indexedIndirectBuffer, batchBuffer.getIndexedIndirectOffset(batchIndex));
      } else {
        pass.drawIndexed(geo.indexCount, 1, 0, 0, objectSlot);
      }
    } else {
      if (batchBuffer && batchIndex !== undefined) {
        pass.drawIndirect(batchBuffer.drawIndirectBuffer, batchBuffer.getDrawIndirectOffset(batchIndex));
      } else {
        pass.draw(geo.vertexCount, 1, 0, objectSlot);
      }
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private _ensureMaterial(material: BlinnPhongMaterial): MatGPU {
    return this._matCache.ensure(this._rendererCore.materialIdentity(material), () => {
      const buf = this.engine.device.createBuffer({ size: MAT_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const bg  = this.engine.device.createBindGroup({
        layout: this._bgl2,
        entries: [{ binding: 0, resource: { buffer: buf } }],
      });
      return {
        buf,
        bg,
        data: new Float32Array(MAT_SIZE / 4),
        lastAmbient: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
        lastDiffuse: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
        lastSpecular: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
        lastShininess: Number.NaN,
        dirty: true,
      };
    });
  }

  private _writeObjectTableEntry(
    obj: ObjGPU,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    objectSlot: number,
    objectTable: RendererObjectTable,
    stableSlot: boolean,
  ): void {
    objectTable.ensureCapacity(objectSlot + 1);
    const clipKey = clippingStateKey(clippingPlanes);
    const objectUnchanged = stableSlot && !obj.dirty && matrixEquals(obj.modelSnapshot, worldMatrix);

    const base = objectSlot * OBJ_FLOATS;
    if (!objectUnchanged) {
      const objectTableData = objectTable.data;
      objectTableData.set(worldMatrix, base);
      mat4.inverse(worldMatrix, this._inverseScratch);
      mat4.transpose(this._inverseScratch, this._normalScratch);
      objectTableData.set(this._normalScratch, base + 16);
      objectTable.writeSlot(objectSlot);
    }
    if (!stableSlot || obj.clippingKey !== clipKey) {
      writeClippingBlock(objectTable.auxiliaryData, objectSlot * CLIPPING_BLOCK_FLOATS, clippingPlanes);
      objectTable.writeAuxiliarySlot(objectSlot);
    }
    if (stableSlot) {
      if (!objectUnchanged) obj.modelSnapshot.set(worldMatrix);
      obj.clippingKey = clipKey;
      obj.dirty = false;
    }
  }

  private _writeMaterialUniform(mat: MatGPU, material: BlinnPhongMaterial): void {
    const ambient = material.ambient;
    const diffuse = material.diffuse;
    const specular = material.specular;
    ambient.writeLinear(mat.data, 0);
    diffuse.writeLinear(mat.data, 4);
    if (material.blending === 'none') mat.data[7] = 1;
    specular.writeLinear(mat.data, 8);
    const changed =
      mat.dirty ||
      !colorEquals(mat.lastAmbient, mat.data[0]!, mat.data[1]!, mat.data[2]!, mat.data[3]!) ||
      !colorEquals(mat.lastDiffuse, mat.data[4]!, mat.data[5]!, mat.data[6]!, mat.data[7]!) ||
      !colorEquals(mat.lastSpecular, mat.data[8]!, mat.data[9]!, mat.data[10]!, mat.data[11]!) ||
      mat.lastShininess !== material.shininess;
    if (!changed) {
      return;
    }

    mat.data[12] = material.shininess;
    mat.data[13] = 0;
    mat.data[14] = 0;
    mat.data[15] = 0;
    wrtBuf(this.engine.device.queue, mat.buf, 0, mat.data);

    for (let i = 0; i < 4; i++) {
      mat.lastAmbient[i] = mat.data[i]!;
      mat.lastDiffuse[i] = mat.data[i + 4]!;
      mat.lastSpecular[i] = mat.data[i + 8]!;
    }
    mat.lastShininess = material.shininess;
    mat.dirty = false;
  }

  private _getOpaquePipeline(geometry: Geometry3D): GPURenderPipeline {
    return this._getPipeline(geometry, false);
  }

  private _getBlendPipeline(geometry: Geometry3D): GPURenderPipeline {
    return this._getPipeline(geometry, true);
  }

  private _getPipeline(geometry: Geometry3D, blended: boolean): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = geometry.cullMode ?? 'back';
    const frontFace = geometry.frontFace ?? 'ccw';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const primitiveKey = encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples, blended ? 1 : 0);
    const key = this._rendererCore.pipelineKey(primitiveKey, this._shaderKey);
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(
      this._pipelineDescriptor(topology, cullMode, frontFace, blended, stripIndexFormat),
    ));
  }

  private _pipelineDescriptor(
    topology: GPUPrimitiveTopology,
    cullMode: GPUCullMode,
    frontFace: GPUFrontFace,
    blended: boolean,
    stripIndexFormat?: GPUIndexFormat,
  ): GPURenderPipelineDescriptor {
    const blend: GPUBlendState | undefined = blended ? {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } : undefined;
    return {
      layout: this._pipelineLayout,
      vertex: { module: this._shader, entryPoint: 'vs_main', buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
        { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
      ] },
      fragment: { module: this._shader, entryPoint: 'fs_main', targets: [createColorTargetState(this.colorFormat ?? this.engine.format, blend)] },
      primitive: createPrimitiveState(topology, cullMode, frontFace, stripIndexFormat),
      depthStencil: {
        format: this.engine.getDepthFormat(this.reverseZ),
        depthWriteEnabled: !blended,
        depthCompare: this.reverseZ ? 'greater-equal' : 'less-equal',
      },
      multisample: { count: this.msaaSamples },
    };
  }

  // ── Destroy ─────────────────────────────────────────────────────────────────

  destroy(): void {
    this._sceneFrameBinding?.destroy();
    this._lightUniforms?.destroy();
    this._lights = [];
    this._lightsNeedUpload = false;
    this._rendererCore?.destroy();
    this._matCache.clear();
    this.clearPipelineCache();
  }
}
