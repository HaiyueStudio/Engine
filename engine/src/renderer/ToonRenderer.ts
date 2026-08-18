import { mat4 } from 'wgpu-matrix';
import type { AssetHandle, CompressedTextureSourceDescriptor } from '../assets/AssetManager';
import { AssetManager } from '../assets/AssetManager';
import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import { SCENE_RENDER_MAX_LIGHTS, type PbrLightInfo } from '../frame/SceneRenderEnvironment';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { MaterialTextureSource, SampleableTextureSource } from '../material/BasicMaterial';
import { TOON_MAX_LAYERS, type ToonMaterial, type ToonTextureMapping } from '../material/ToonMaterial';
import { getBuiltinMaterialLightingShader } from '../shader/BuiltinMaterialLightingShader';
import { BaseRenderer } from './BaseRenderer';
import type { GpuDrivenBatchBuffer } from './GpuDrivenBatchBuffer';
import { forEachDirectInstanceBatchRun } from './DirectInstanceBatchRuns';
import type { MaterialGpuDrivenBatch, MaterialRenderBatchItem, MaterialRendererViewContext } from './MaterialRendererRegistry';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { RendererCacheMap, RendererObjectSlotCache } from './RendererCacheMap';
import { RendererObjectTable } from './RendererObjectTable';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import type { SharedGeometry3DGPUData } from './SharedGeometry3DGPUCache';
import type { DirectionalShadowState } from './ShadowMapRenderer';
import { createColorTargetState, createPrimitiveState } from './gpuDescriptors';
import { encodePrimitivePipelineKey } from './pipelineKey';
import { getStripIndexFormat, matrixEquals, writeBuffer } from './utils';
import type { LiveIdSet } from './utils';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { CLIPPING_BLOCK_FLOATS, clippingStateKey, writeClippingBlock } from './ClippingPlanesGpu';
import { ParameterizedRendererCore, SharedGeometryRendererOwner } from './ParameterizedRendererCore';

const OBJECT_BASE_FLOATS = 32;
const OBJECT_FLOATS = OBJECT_BASE_FLOATS;
const MATERIAL_FLOATS = 60;
const MATERIAL_BYTES = MATERIAL_FLOATS * 4;
const LIGHT_FLOATS = 4 + SCENE_RENDER_MAX_LIGHTS * 16;
const LIGHT_BYTES = LIGHT_FLOATS * 4;
// Toon intentionally consumes one effective directional shadow, while the
// shared PCF feature still requires an explicit array length and array view.
const TOON_MAX_DIRECTIONAL_SHADOWS = 1;
const SHADOW_FLOATS = 20;
const SHADOW_BYTES = SHADOW_FLOATS * 4;
const LAYER_INDICES = Object.freeze([0, 1, 2, 3] as const);

interface ToonObjectGpuData {
  modelSlot: number;
  modelSnapshot: Float32Array;
  clippingKey: string;
  dirty: boolean;
}

interface ToonMaterialGpuData {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  textures: GPUTexture[];
  samplers: GPUSampler[];
  samplerKeys: string[];
  sources: unknown[];
  handles: Array<AssetHandle<GPUTexture> | null>;
  loaded: boolean[];
  f32: Float32Array;
  snapshotKey: string;
  disposed: boolean;
}

export class ToonRenderer extends BaseRenderer {
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private _engine!: IEngine;
  private _assetManager!: AssetManager;
  private _ownsAssetManager = false;
  private _shader!: GPUShaderModule;
  private _shaderKey = '';
  private _pipelineLayout!: GPUPipelineLayout;
  private _sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly _cameraDynamicOffset = new Uint32Array(1);
  private _objectLayout!: GPUBindGroupLayout;
  private _materialLayout!: GPUBindGroupLayout;
  private _sceneLayout!: GPUBindGroupLayout;
  private _rendererCore!: ParameterizedRendererCore<ToonObjectGpuData, SharedGeometry3DGPUData>;
  private get _objectTable(): RendererObjectTable { return this._rendererCore.requireObjectTable(); }
  private get _batchObjectTable(): RendererObjectTable { return this._rendererCore.requireBatchObjectTable(); }
  private get _geometryCache(): SharedGeometryRendererOwner { return this._rendererCore.geometry as SharedGeometryRendererOwner; }
  private get _objects(): RendererObjectSlotCache<ToonObjectGpuData> { return this._rendererCore.requireObjects(); }
  private _lightBuffer!: GPUBuffer;
  private _shadowBuffer!: GPUBuffer;
  private _sceneBindGroup!: GPUBindGroup;
  private _defaultTexture!: GPUTexture;
  private _defaultSampler!: GPUSampler;
  private _defaultShadowTexture!: GPUTexture;
  private _defaultShadowView!: GPUTextureView;
  private _defaultShadowSampler!: GPUSampler;
  private _shadowView!: GPUTextureView;
  private _shadowSampler!: GPUSampler;
  private readonly _materials = new RendererCacheMap<ToonMaterialGpuData>(data => this._destroyMaterial(data));
  private readonly _samplers = new Map<string, GPUSampler>();
  private readonly _lightData = new Float32Array(LIGHT_FLOATS);
  private readonly _lightSnapshot = new Float32Array(LIGHT_FLOATS);
  private readonly _lightU32 = new Uint32Array(this._lightData.buffer);
  private readonly _shadowData = new Float32Array(SHADOW_FLOATS);
  private readonly _inverseScratch = mat4.identity() as Float32Array;
  private readonly _normalScratch = mat4.identity() as Float32Array;
  private _lightingRevision = -1;
  private _initialized = false;
  private get _uploadsPrepared(): boolean { return this._rendererCore.uploadsPrepared; }
  private _warnedLightLimit = false;

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this._initialized = true;
    this._engine = engine;
    const device = engine.device;
    this._assetManager = engine.assetManager ?? new AssetManager(device, getEngineGPUResourceTracker(engine), engine.defaults?.assetManager);
    this._ownsAssetManager = !engine.assetManager;
    // A recovered device owns a fresh buffer even when the logical lights are unchanged.
    this._lightSnapshot.fill(Number.NaN);
    this._sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this._objectLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ] });
    this._materialLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ...LAYER_INDICES.map(index => ({ binding: index + 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' as GPUTextureSampleType } })),
      ...LAYER_INDICES.map(index => ({ binding: index + 1 + TOON_MAX_LAYERS, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' as GPUSamplerBindingType } })),
    ] });
    this._sceneLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 5, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
    ] });
    const generated = getBuiltinMaterialLightingShader(device, 'toon', [
      this._sceneFrameBinding.bindGroupLayout,
      this._objectLayout,
      this._materialLayout,
      this._sceneLayout,
    ]);
    this._shader = generated.module;
    this._shaderKey = generated.pass.canonicalHash;
    this._pipelineLayout = generated.pipelineLayout;
    this._rendererCore = new ParameterizedRendererCore({
      objectTables: {
        device,
        bindGroupLayout: this._objectLayout,
        label: 'ToonRenderer',
        floatsPerSlot: OBJECT_FLOATS,
        auxiliary: { binding: 1, floatsPerSlot: CLIPPING_BLOCK_FLOATS, label: 'ToonRenderer.clippingTable' },
      },
      createObject: modelSlot => ({ modelSlot, modelSnapshot: new Float32Array(16), clippingKey: '', dirty: true }),
      geometry: new SharedGeometryRendererOwner(device, this, getEngineGPUResourceTracker(engine)),
    });
    this._lightBuffer = device.createBuffer({ label: 'ToonRenderer.lights', size: LIGHT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._shadowBuffer = device.createBuffer({ label: 'ToonRenderer.shadow', size: SHADOW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._defaultSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this._defaultTexture = this._createSolidTexture();
    this._defaultShadowSampler = device.createSampler({ compare: 'less-equal' });
    this._defaultShadowTexture = device.createTexture({
      label: 'ToonRenderer.defaultShadow',
      size: [1, 1, 1],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._defaultShadowView = this._defaultShadowTexture.createView({
      dimension: '2d-array',
      baseArrayLayer: 0,
      arrayLayerCount: TOON_MAX_DIRECTIONAL_SHADOWS,
    });
    this._shadowView = this._defaultShadowView;
    this._shadowSampler = this._defaultShadowSampler;
    this._rebuildSceneBindGroup();
    this._writeShadow(null);
  }

  beginView(context: MaterialRendererViewContext): void {
    this.reverseZ = context.reverseZ;
    this.msaaSamples = context.msaaSamples;
    this._rendererCore.beginUploads(context.commandContext);
    this._cameraDynamicOffset[0] = this._sceneFrameBinding.upload(context.sceneFrameUniforms, context.commandContext);
    if (this._lightingRevision !== context.sceneEnvironment.lightingRevision) {
      this._writeLights(context.sceneEnvironment.pbrLights);
      this._lightingRevision = context.sceneEnvironment.lightingRevision;
    }
    this._writeShadow(context.directionalShadow);
  }

  prepareObjects(
    items: readonly MaterialRenderBatchItem<ToonMaterial>[],
    first = 0,
    count = items.length - first,
    firstBatchIndex = first,
    batchBuffer: GpuDrivenBatchBuffer | null = null,
  ): void {
    const end = Math.min(items.length, first + count);
    for (let index = first; index < end; index++) {
      const item = items[index];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      this._geometryCache.ensure(item.geometry, this);
      const object = this._objects.ensure(item.entityId);
      const batchSlot = batchBuffer && item.material.alphaMode === 'opaque'
        ? batchBuffer.getObjectSlot(firstBatchIndex + index - first)
        : undefined;
      const objectSlot = batchSlot ?? object.modelSlot;
      const table = batchSlot === undefined ? this._objectTable : this._batchObjectTable;
      this._writeObject(object, item.clippingPlanes, item.worldMatrix, objectSlot, table, batchSlot === undefined);
      this._syncMaterial(item.material, this._materials.ensure(item.material.id, () => this._createMaterial()));
    }
  }

  flushUploads(): void {
    this._rendererCore.flushUploads();
  }

  endView(): void {
    this._rendererCore.endView();
  }

  render(
    pass: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: ToonMaterial,
    worldMatrix: Float32Array,
    options: { gpuDrivenBatch?: MaterialGpuDrivenBatch | undefined } = {},
    clippingPlanes: ClippingPlanes | null = null,
  ): void {
    const batch = options.gpuDrivenBatch;
    this._renderItem(pass, entityId, geometry, material, clippingPlanes, worldMatrix, batch?.batchBuffer, batch?.batchIndex);
  }

  renderBatch(
    pass: GPURenderPassEncoder,
    items: readonly MaterialRenderBatchItem<ToonMaterial>[],
    first: number,
    count: number,
    batchBuffer: GpuDrivenBatchBuffer,
  ): void {
    if (batchBuffer.gpuUploadEnabled === false) {
      forEachDirectInstanceBatchRun(items, first, count, batchBuffer, run => {
        const item = run.item;
        const geometryData = this._geometryCache.ensure(item.geometry, this);
        const materialData = this._materials.ensure(item.material.id, () => this._createMaterial());
        if (!this._uploadsPrepared) this._syncMaterial(item.material, materialData);
        pass.setPipeline(this._getPipeline(item.geometry, item.material));
        pass.setBindGroup(0, this._sceneFrameBinding.bindGroup, this._cameraDynamicOffset);
        pass.setBindGroup(1, this._batchObjectTable.bindGroup);
        pass.setBindGroup(2, materialData.bindGroup);
        pass.setBindGroup(3, this._sceneBindGroup);
        pass.setVertexBuffer(0, geometryData.positionBuf);
        pass.setVertexBuffer(1, geometryData.normalBuf);
        pass.setVertexBuffer(2, geometryData.uvBuf);
        pass.setVertexBuffer(3, geometryData.uv1Buf ?? geometryData.uvBuf);
        if (geometryData.indexBuf) {
          pass.setIndexBuffer(geometryData.indexBuf, geometryData.indexFormat);
          pass.drawIndexed(geometryData.indexCount, run.instanceCount, 0, 0, run.firstInstance);
        } else {
          pass.draw(geometryData.vertexCount, run.instanceCount, 0, run.firstInstance);
        }
      });
      return;
    }
    const end = Math.min(items.length, first + count);
    for (let index = first; index < end; index++) {
      const item = items[index];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      this._renderItem(pass, item.entityId, item.geometry, item.material, item.clippingPlanes, item.worldMatrix, batchBuffer, index);
    }
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    for (const alphaMode of ['opaque', 'blend'] as const) {
      const primitiveKey = encodePrimitivePipelineKey('triangle-list', 'back', 'ccw', undefined, this.reverseZ, this.msaaSamples, alphaMode === 'blend' ? 1 : 0);
      const key = this._rendererCore.pipelineKey(`${primitiveKey}|uv:0=TEXCOORD_0`, this._shaderKey);
      this.addPipelineWarmup(plan, key, `Toon ${alphaMode}`, () => this._pipelineDescriptor('triangle-list', 'back', 'ccw', alphaMode), this._engine.device);
    }
  }

  releaseEntitiesNotIn(live: LiveIdSet): void { this._objects.releaseNotIn(live); }
  releaseGeometriesNotIn(live: LiveIdSet): void { this._geometryCache.releaseUnused(this, live); }
  releaseMaterialsNotIn(live: LiveIdSet): void { this._materials.releaseNotIn(live); }

  private _renderItem(
    pass: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: ToonMaterial,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    batchBuffer?: GpuDrivenBatchBuffer,
    batchIndex?: number,
  ): void {
    const geometryData = this._geometryCache.ensure(geometry, this);
    const object = this._objects.ensure(entityId);
    const batchSlot = batchBuffer && batchIndex !== undefined ? batchBuffer.getObjectSlot(batchIndex) : undefined;
    const objectSlot = batchSlot ?? object.modelSlot;
    const table = batchSlot === undefined ? this._objectTable : this._batchObjectTable;
    if (!this._uploadsPrepared) this._writeObject(object, clippingPlanes, worldMatrix, objectSlot, table, batchSlot === undefined);
    const materialData = this._materials.ensure(this._rendererCore.materialIdentity(material), () => this._createMaterial());
    if (!this._uploadsPrepared) this._syncMaterial(material, materialData);

    pass.setPipeline(this._getPipeline(geometry, material));
    pass.setBindGroup(0, this._sceneFrameBinding.bindGroup, this._cameraDynamicOffset);
    pass.setBindGroup(1, table.bindGroup);
    pass.setBindGroup(2, materialData.bindGroup);
    pass.setBindGroup(3, this._sceneBindGroup);
    pass.setVertexBuffer(0, geometryData.positionBuf);
    pass.setVertexBuffer(1, geometryData.normalBuf);
    pass.setVertexBuffer(2, geometryData.uvBuf);
    pass.setVertexBuffer(3, geometryData.uv1Buf ?? geometryData.uvBuf);
    if (geometryData.indexBuf) {
      pass.setIndexBuffer(geometryData.indexBuf, geometryData.indexFormat);
      if (batchBuffer && batchIndex !== undefined) pass.drawIndexedIndirect(batchBuffer.indexedIndirectBuffer, batchBuffer.getIndexedIndirectOffset(batchIndex));
      else pass.drawIndexed(geometryData.indexCount, 1, 0, 0, objectSlot);
    } else if (batchBuffer && batchIndex !== undefined) {
      pass.drawIndirect(batchBuffer.drawIndirectBuffer, batchBuffer.getDrawIndirectOffset(batchIndex));
    } else {
      pass.draw(geometryData.vertexCount, 1, 0, objectSlot);
    }
  }

  private _writeObject(object: ToonObjectGpuData, clippingPlanes: ClippingPlanes | null, world: Float32Array, slot: number, table: RendererObjectTable, stable: boolean): void {
    table.ensureCapacity(slot + 1);
    const clipKey = clippingStateKey(clippingPlanes);
    const objectUnchanged = stable && !object.dirty && matrixEquals(object.modelSnapshot, world);
    const offset = slot * OBJECT_FLOATS;
    if (!objectUnchanged) {
      table.data.set(world, offset);
      mat4.inverse(world, this._inverseScratch);
      mat4.transpose(this._inverseScratch, this._normalScratch);
      table.data.set(this._normalScratch, offset + 16);
      table.writeSlot(slot);
    }
    if (!stable || object.clippingKey !== clipKey) {
      writeClippingBlock(table.auxiliaryData, slot * CLIPPING_BLOCK_FLOATS, clippingPlanes);
      table.writeAuxiliarySlot(slot);
    }
    if (stable) {
      if (!objectUnchanged) object.modelSnapshot.set(world);
      object.clippingKey = clipKey;
      object.dirty = false;
    }
  }

  private _createMaterial(): ToonMaterialGpuData {
    const buffer = this._engine.device.createBuffer({ label: 'ToonRenderer.material', size: MATERIAL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const data: ToonMaterialGpuData = {
      buffer,
      bindGroup: null as unknown as GPUBindGroup,
      textures: LAYER_INDICES.map(() => this._defaultTexture),
      samplers: LAYER_INDICES.map(() => this._defaultSampler),
      samplerKeys: LAYER_INDICES.map(() => 'default'),
      sources: LAYER_INDICES.map(() => null),
      handles: LAYER_INDICES.map(() => null),
      loaded: LAYER_INDICES.map(() => false),
      f32: new Float32Array(MATERIAL_FLOATS),
      snapshotKey: '',
      disposed: false,
    };
    data.bindGroup = this._buildMaterialBindGroup(data);
    return data;
  }

  private _syncMaterial(material: ToonMaterial, data: ToonMaterialGpuData): void {
    let bindingsChanged = false;
    for (const index of LAYER_INDICES) {
      const layer = material.layers[index];
      const source = layer?.texture ?? null;
      bindingsChanged = this._syncTexture(index, source, data) || bindingsChanged;
      const samplerKey = this._samplerKey(layer?.sampler ?? null);
      if (data.samplerKeys[index] !== samplerKey) {
        data.samplerKeys[index] = samplerKey;
        data.samplers[index] = this._getSampler(layer?.sampler ?? null);
        bindingsChanged = true;
      }
    }
    if (bindingsChanged) data.bindGroup = this._buildMaterialBindGroup(data);
    const snapshotKey = `${material.revision}|${data.loaded.map(value => value ? 1 : 0).join('')}`;
    if (data.snapshotKey === snapshotKey) return;
    data.snapshotKey = snapshotKey;
    material.baseColor.writeLinear(data.f32, 0);
    data.f32.fill(0, 4);
    let textureMask = 0;
    for (const index of LAYER_INDICES) {
      const layer = material.layers[index];
      if (!layer) {
        writeIdentityMapping(data.f32, 28 + index * 8);
        continue;
      }
      data.f32[4 + index] = layer.minLight;
      layer.color.writeLinear(data.f32, 8 + index * 4);
      if (data.loaded[index]) textureMask |= 1 << index;
      writeTextureMapping(data.f32, 28 + index * 8, layer.textureMapping);
    }
    data.f32[24] = material.layers.length;
    data.f32[25] = material.bandSoftness;
    data.f32[26] = textureMask;
    data.f32[27] = 0;
    writeBuffer(this._engine.device.queue, data.buffer, 0, data.f32);
  }

  private _syncTexture(index: number, source: MaterialTextureSource, data: ToonMaterialGpuData): boolean {
    if (data.sources[index] === source) return false;
    data.handles[index]?.release();
    data.handles[index] = null;
    data.sources[index] = source;
    data.loaded[index] = false;
    data.textures[index] = this._defaultTexture;
    data.snapshotKey = '';
    if (!source) return true;
    const immediate = unwrapTexture(source);
    if (immediate) {
      data.textures[index] = immediate;
      data.loaded[index] = true;
      return true;
    }
    void this._assetManager.loadTexture(
      source as string | ImageBitmap | HTMLCanvasElement | HTMLImageElement | CompressedTextureSourceDescriptor,
      { format: 'rgba8unorm-srgb', mipmaps: 'generate', signal: this._rendererCore.signal },
    ).then(handle => {
      if (this._rendererCore.destroyed || data.disposed || data.sources[index] !== source) {
        handle.release();
        return;
      }
      data.handles[index] = handle;
      data.textures[index] = handle.value;
      data.loaded[index] = true;
      data.bindGroup = this._buildMaterialBindGroup(data);
      data.snapshotKey = '';
    }).catch(error => {
      if (!this._rendererCore.destroyed) console.warn(`[ToonRenderer] Failed to load layer ${index} texture.`, error);
    });
    return true;
  }

  private _writeLights(lights: readonly PbrLightInfo[]): void {
    this._lightData.fill(0);
    const count = Math.min(SCENE_RENDER_MAX_LIGHTS, lights.length);
    if (lights.length > SCENE_RENDER_MAX_LIGHTS && !this._warnedLightLimit) {
      this._warnedLightLimit = true;
      console.warn(`[ToonRenderer] Received ${lights.length} lights; only the first ${SCENE_RENDER_MAX_LIGHTS} are used.`);
    }
    this._lightU32[0] = count;
    for (let index = 0; index < count; index++) {
      const light = lights[index]!;
      const offset = 4 + index * 16;
      this._lightU32[offset] = light.type;
      this._lightData[offset + 4] = light.color[0];
      this._lightData[offset + 5] = light.color[1];
      this._lightData[offset + 6] = light.color[2];
      this._lightData[offset + 7] = light.intensity;
      this._lightData[offset + 8] = light.direction[0];
      this._lightData[offset + 9] = light.direction[1];
      this._lightData[offset + 10] = light.direction[2];
      this._lightData[offset + 12] = light.position[0];
      this._lightData[offset + 13] = light.position[1];
      this._lightData[offset + 14] = light.position[2];
      this._lightData[offset + 15] = light.range;
    }
    let changed = false;
    for (let index = 0; index < this._lightData.length; index++) {
      if (!Object.is(this._lightData[index], this._lightSnapshot[index])) { changed = true; break; }
    }
    if (!changed) return;
    this._lightSnapshot.set(this._lightData);
    writeBuffer(this._engine.device.queue, this._lightBuffer, 0, this._lightData);
  }

  private _writeShadow(shadow: DirectionalShadowState | null): void {
    const view = shadow?.arrayView ?? this._defaultShadowView;
    const sampler = shadow?.sampler ?? this._defaultShadowSampler;
    if (view !== this._shadowView || sampler !== this._shadowSampler) {
      this._shadowView = view;
      this._shadowSampler = sampler;
      this._rebuildSceneBindGroup();
    }
    this._shadowData.fill(0);
    if (shadow) this._shadowData.set(shadow.lightViewProjection, 0);
    else this._shadowData[0] = this._shadowData[5] = this._shadowData[10] = this._shadowData[15] = 1;
    this._shadowData[16] = shadow?.enabled ? (shadow.layer ?? 0) + 1 : 0;
    this._shadowData[17] = shadow?.bias ?? 0;
    this._shadowData[18] = shadow?.normalBias ?? 0;
    this._shadowData[19] = shadow ? 1 / shadow.mapSize : 1;
    writeBuffer(this._engine.device.queue, this._shadowBuffer, 0, this._shadowData);
  }

  private _rebuildSceneBindGroup(): void {
    this._sceneBindGroup = this._engine.device.createBindGroup({ layout: this._sceneLayout, entries: [
      { binding: 0, resource: { buffer: this._lightBuffer } },
      { binding: 5, resource: { buffer: this._shadowBuffer } },
      { binding: 6, resource: this._shadowView },
      { binding: 7, resource: this._shadowSampler },
    ] });
  }

  private _buildMaterialBindGroup(data: ToonMaterialGpuData): GPUBindGroup {
    return this._engine.device.createBindGroup({ layout: this._materialLayout, entries: [
      { binding: 0, resource: { buffer: data.buffer } },
      ...LAYER_INDICES.map(index => ({ binding: index + 1, resource: data.textures[index]!.createView() })),
      ...LAYER_INDICES.map(index => ({ binding: index + 1 + TOON_MAX_LAYERS, resource: data.samplers[index]! })),
    ] });
  }

  private _getPipeline(geometry: Geometry3D, material: ToonMaterial): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = material.doubleSided ? 'none' : geometry.cullMode ?? 'back';
    const frontFace = geometry.frontFace ?? 'ccw';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const alphaFlag = material.alphaMode === 'blend' ? 1 : 0;
    const primitiveKey = encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples, alphaFlag);
    const key = this._rendererCore.pipelineKey(`${primitiveKey}|uv:${geometry.textureCoordinateLayoutKey}`, this._shaderKey);
    return this.getCachedPipeline(key, () => this._engine.device.createRenderPipeline(
      this._pipelineDescriptor(topology, cullMode, frontFace, material.alphaMode, stripIndexFormat),
    ));
  }

  private _pipelineDescriptor(
    topology: GPUPrimitiveTopology,
    cullMode: GPUCullMode,
    frontFace: GPUFrontFace,
    alphaMode: 'opaque' | 'blend',
    stripIndexFormat?: GPUIndexFormat,
  ): GPURenderPipelineDescriptor {
    const blend: GPUBlendState | undefined = alphaMode === 'blend' ? {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } : undefined;
    return {
      layout: this._pipelineLayout,
      vertex: { module: this._shader, entryPoint: 'vs_main', buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
        { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
        { arrayStride: 8, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x2' }] },
      ] },
      fragment: { module: this._shader, entryPoint: 'fs_main', targets: [createColorTargetState(this._engine.format, blend)] },
      primitive: createPrimitiveState(topology, cullMode, frontFace, stripIndexFormat),
      depthStencil: {
        format: this._engine.getDepthFormat(this.reverseZ),
        depthWriteEnabled: alphaMode !== 'blend',
        depthCompare: this.reverseZ ? 'greater-equal' : 'less-equal',
      },
      multisample: { count: this.msaaSamples },
    };
  }

  private _getSampler(descriptor: GPUSamplerDescriptor | null): GPUSampler {
    if (!descriptor) return this._defaultSampler;
    const key = this._samplerKey(descriptor);
    let sampler = this._samplers.get(key);
    if (!sampler) {
      sampler = this._engine.device.createSampler(descriptor);
      this._samplers.set(key, sampler);
    }
    return sampler;
  }

  private _samplerKey(descriptor: GPUSamplerDescriptor | null): string {
    return descriptor ? JSON.stringify(descriptor, Object.keys(descriptor).sort()) : 'default';
  }

  private _createSolidTexture(): GPUTexture {
    const texture = this._engine.device.createTexture({
      label: 'ToonRenderer.defaultWhite',
      size: [1, 1, 1],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._engine.device.queue.writeTexture({ texture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
    return texture;
  }

  private _destroyMaterial(data: ToonMaterialGpuData): void {
    data.disposed = true;
    data.buffer.destroy();
    for (const handle of data.handles) handle?.release();
  }

  destroy(): void {
    this._sceneFrameBinding?.destroy();
    this._lightBuffer?.destroy();
    this._shadowBuffer?.destroy();
    this._defaultTexture?.destroy();
    this._defaultShadowTexture?.destroy();
    this._rendererCore?.destroy();
    this._materials.clear();
    this._samplers.clear();
    if (this._ownsAssetManager) this._assetManager?.dispose();
    this.clearPipelineCache();
    this._lightingRevision = -1;
    this._initialized = false;
  }
}

function writeTextureMapping(target: Float32Array, offset: number, mapping: ToonTextureMapping): void {
  const cos = Math.cos(mapping.rotation);
  const sin = Math.sin(mapping.rotation);
  target[offset] = mapping.scale[0] * cos;
  target[offset + 1] = -mapping.scale[1] * sin;
  target[offset + 2] = mapping.offset[0];
  target[offset + 3] = mapping.texCoord;
  target[offset + 4] = mapping.scale[0] * sin;
  target[offset + 5] = mapping.scale[1] * cos;
  target[offset + 6] = mapping.offset[1];
  target[offset + 7] = 0;
}

function writeIdentityMapping(target: Float32Array, offset: number): void {
  target[offset] = 1;
  target[offset + 1] = 0;
  target[offset + 2] = 0;
  target[offset + 3] = 0;
  target[offset + 4] = 0;
  target[offset + 5] = 1;
  target[offset + 6] = 0;
  target[offset + 7] = 0;
}

function unwrapTexture(source: MaterialTextureSource): GPUTexture | null {
  if (!source || typeof source !== 'object') return null;
  if ('texture' in source && isGpuTextureLike((source as SampleableTextureSource).texture)) {
    return (source as SampleableTextureSource).texture;
  }
  return isGpuTextureLike(source) ? source : null;
}

function isGpuTextureLike(value: unknown): value is GPUTexture {
  return typeof value === 'object' && value !== null && typeof (value as { createView?: unknown }).createView === 'function';
}
