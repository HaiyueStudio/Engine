import { mat4 } from 'wgpu-matrix';
import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import { Frustum } from '../culling/Frustum';
import { SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS } from '../frame/SceneRenderEnvironment';
import type { Geometry3D, Skinning3D } from '../geometry/Geometry3D';
import type { DirectionalLight } from '../lighting/DirectionalLight';
import type { Material } from '../material/Material';
import { getBuiltinDeformationShader, type BuiltinDeformationPassId } from '../shader/BuiltinDeformationShader';
import type { Render3DRenderItem } from '../systems/Render3DContracts';
import { alignUp4 } from '../utils/align';
import { BaseRenderer } from './BaseRenderer';
import { createPrimitiveState } from './gpuDescriptors';
import { encodePrimitivePipelineKey, encodeShaderPipelineKey } from './pipelineKey';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { RendererCacheMap, RendererObjectSlotCache } from './RendererCacheMap';
import { RendererObjectTable } from './RendererObjectTable';
import {
  getSharedGeometry3DGPUCache,
  type SharedGeometry3DGPUData,
} from './SharedGeometry3DGPUCache';
import { getStripIndexFormat, matrixEquals, writeBuffer } from './utils';
import { sharedZeroVectorCache } from './ZeroVectorCache';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import {
  DIRECTIONAL_SHADOW_FOCUS_ORIGIN,
  writeDirectionalShadowViewProjection,
} from './DirectionalShadowMath';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { CLIPPING_BLOCK_FLOATS, clippingStateKey, writeClippingBlock } from './ClippingPlanesGpu';

export interface DirectionalShadowState {
  readonly enabled: boolean;
  /** Per-layer 2-D view retained by single-shadow material renderers. */
  readonly view: GPUTextureView;
  /** Shared array view used by PBR multi-shadow sampling. */
  readonly arrayView?: GPUTextureView;
  /** Array layer containing this light's depth map. */
  readonly layer?: number;
  readonly sampler: GPUSampler;
  readonly lightViewProjection: Float32Array;
  readonly mapSize: number;
  readonly bias: number;
  readonly normalBias: number;
}

export type ShadowCullModeResolver = (material: Material) => GPUCullMode | null;

const DEFAULT_SHADOW_CULL_MODE_RESOLVER: ShadowCullModeResolver = () => null;

interface ShadowObjectData {
  modelSlot: number;
  modelSnapshot: Float32Array;
  modelDirty: boolean;
  clippingKey: string;
}

interface ShadowDeformationGpuData {
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
  skinBindGroup: GPUBindGroup | null;
  skinVersion: number;
  vertexCount: number;
}

interface ShadowPipelineVariant {
  readonly morph: boolean;
  readonly skinned: boolean;
  readonly pass: BuiltinDeformationPassId;
}

interface ShadowDrawCaster {
  readonly sharedGeometry: SharedGeometry3DGPUData;
  readonly pipeline: GPURenderPipeline;
  readonly variant: ShadowPipelineVariant;
  readonly cullMode: GPUCullMode;
  readonly deformation: ShadowDeformationGpuData | null;
  readonly objectSlot: number;
}

const OBJECT_TABLE_FLOATS = 24;
const OBJECT_TABLE_MORPH_OFFSET = 16;
const OBJECT_TABLE_DEFORMATION_OFFSET = 20;
const SHADOW_PIPELINE_VARIANTS: readonly ShadowPipelineVariant[] = Object.freeze([
  { morph: false, skinned: false, pass: 'shadow' },
  { morph: true, skinned: false, pass: 'shadow-morph' },
  { morph: false, skinned: true, pass: 'shadow-skinned' },
  { morph: true, skinned: true, pass: 'shadow-skinned-morph' },
]);

export class ShadowMapRenderer extends BaseRenderer {
  private _engine!: IEngine;
  private _cameraLayout!: GPUBindGroupLayout;
  private _objectLayout!: GPUBindGroupLayout;
  private _skinLayout!: GPUBindGroupLayout;
  private _pipelineLayout!: GPUPipelineLayout;
  private _skinnedPipelineLayout!: GPUPipelineLayout;
  private _shaderModules: GPUShaderModule[] = [];
  private readonly _cameraBuffers: GPUBuffer[] = [];
  private readonly _cameraBindGroups: GPUBindGroup[] = [];
  private readonly _objectTables: RendererObjectTable[] = [];
  private _texture!: GPUTexture;
  private _view!: GPUTextureView;
  private _arrayView!: GPUTextureView;
  private readonly _layerViews: GPUTextureView[] = [];
  private _sampler!: GPUSampler;
  private _mapSize = 0;
  private _targetRevision = 0;
  private _geometryCache!: ReturnType<typeof getSharedGeometry3DGPUCache>;
  private readonly _objects: RendererObjectSlotCache<ShadowObjectData>[] = [];
  private readonly _deformations = new RendererCacheMap<ShadowDeformationGpuData>(data => this._destroyDeformation(data));
  private readonly _liveEntities = new Set<number>();
  private readonly _unassignedEntityIds: number[] = [];
  private readonly _liveGeometries = new Set<number>();
  private readonly _liveDeformations = new Set<number>();
  private readonly _batchLiveGeometries = new Set<number>();
  private readonly _batchLiveDeformations = new Set<number>();
  private readonly _drawCasters: ShadowDrawCaster[] = [];
  private _drawCastersOutOfSlotOrder = false;
  private _layerBatchActive = false;
  private _layerBatchHasRender = false;
  private readonly _lightFrustum = new Frustum();
  private readonly _lightViewProjections = Array.from(
    { length: SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS },
    () => mat4.identity() as Float32Array,
  );
  private readonly _viewMatrices = Array.from(
    { length: SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS },
    () => mat4.identity() as Float32Array,
  );
  private readonly _projectionMatrices = Array.from(
    { length: SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS },
    () => mat4.identity() as Float32Array,
  );
  private _initialized = false;

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this.clearPipelineCache();
    this._initialized = true;
    this._engine = engine;
    const device = engine.device;
    this._geometryCache = getSharedGeometry3DGPUCache(device, getEngineGPUResourceTracker(engine));
    this._cameraLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this._objectLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ] });
    const emptyLayout = device.createBindGroupLayout({ entries: [] });
    this._skinLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layouts = [this._cameraLayout, this._objectLayout];
    const skinnedLayouts = [this._cameraLayout, this._objectLayout, emptyLayout, this._skinLayout];
    const generated = SHADOW_PIPELINE_VARIANTS.map(variant => getBuiltinDeformationShader(
      device,
      variant.pass,
      variant.skinned ? skinnedLayouts : layouts,
    ));
    this._shaderModules = generated.map(runtime => runtime.module);
    this._pipelineLayout = generated[0]!.pipelineLayout;
    this._skinnedPipelineLayout = generated[2]!.pipelineLayout;
    this._cameraBuffers.length = 0;
    this._cameraBindGroups.length = 0;
    for (let layer = 0; layer < SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS; layer++) {
      const cameraBuffer = device.createBuffer({
        label: 'ShadowMapRenderer.lightCamera',
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this._cameraBuffers.push(cameraBuffer);
      this._cameraBindGroups.push(device.createBindGroup({
        layout: this._cameraLayout,
        entries: [{ binding: 0, resource: { buffer: cameraBuffer } }],
      }));
    }
    this._objectTables.length = 0;
    this._objects.length = 0;
    for (let layer = 0; layer < SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS; layer++) {
      const objectTable = new RendererObjectTable({
        device,
        bindGroupLayout: this._objectLayout,
        label: 'ShadowMapRenderer.objectTable',
        floatsPerSlot: OBJECT_TABLE_FLOATS,
        auxiliary: { binding: 1, floatsPerSlot: CLIPPING_BLOCK_FLOATS, label: 'ShadowMapRenderer.clippingTable' },
      });
      objectTable.ensureCapacity(1);
      this._objectTables.push(objectTable);
      this._objects.push(new RendererObjectSlotCache<ShadowObjectData>(
        () => objectTable,
        modelSlot => ({
          modelSlot,
          modelSnapshot: new Float32Array(16),
          modelDirty: true,
          clippingKey: '',
        }),
      ));
    }
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    for (let index = 0; index < SHADOW_PIPELINE_VARIANTS.length; index++) {
      const variant = SHADOW_PIPELINE_VARIANTS[index]!;
      const descriptor = this._pipelineDescriptor(
        'triangle-list',
        'back',
        'ccw',
        undefined,
        variant,
        this._shaderModules[index]!,
      );
      const key = this._pipelineKey('triangle-list', 'back', 'ccw', undefined, variant);
      const features = [variant.skinned ? 'skinned' : '', variant.morph ? 'morph' : ''].filter(Boolean).join(' ');
      this.addPipelineWarmup(
        plan,
        key,
        `Directional shadow${features ? ` ${features}` : ''}`,
        () => descriptor,
        this._engine.device,
      );
    }
  }

  get targetRevision(): number { return this._targetRevision; }

  /** Ensures one fixed-capacity depth-array target shared by every directional shadow slot. */
  prepareTarget(size: number): boolean {
    return this._ensureTarget(size);
  }

  /** Defers shared geometry/deformation sweeping until every updated layer is encoded. */
  beginLayerBatch(): void {
    this._layerBatchActive = true;
    this._layerBatchHasRender = false;
    this._batchLiveGeometries.clear();
    this._batchLiveDeformations.clear();
  }

  endLayerBatch(): void {
    if (!this._layerBatchActive) return;
    this._layerBatchActive = false;
    if (!this._layerBatchHasRender) return;
    this._deformations.releaseNotIn(this._batchLiveDeformations);
    this._geometryCache.releaseUnused(this, this._batchLiveGeometries);
  }

  render(
    encoder: GPUCommandEncoder,
    items: readonly Render3DRenderItem[],
    light: DirectionalLight,
    submissionContext?: RenderCommandContext,
    focus: readonly [number, number, number] = DIRECTIONAL_SHADOW_FOCUS_ORIGIN,
    resolveCullMode: ShadowCullModeResolver = DEFAULT_SHADOW_CULL_MODE_RESOLVER,
  ): DirectionalShadowState {
    this.prepareTarget(light.shadow.mapSize);
    this.beginLayerBatch();
    try {
      return this.renderLayer(encoder, items, light, 0, submissionContext, focus, resolveCullMode);
    } finally {
      this.endLayerBatch();
    }
  }

  /** Renders into one prepared array layer without reallocating between lights. */
  renderLayer(
    encoder: GPUCommandEncoder,
    items: readonly Render3DRenderItem[],
    light: DirectionalLight,
    layer: number,
    submissionContext?: RenderCommandContext,
    focus: readonly [number, number, number] = DIRECTIONAL_SHADOW_FOCUS_ORIGIN,
    resolveCullMode: ShadowCullModeResolver = DEFAULT_SHADOW_CULL_MODE_RESOLVER,
  ): DirectionalShadowState {
    if (!Number.isInteger(layer) || layer < 0 || layer >= SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS) {
      throw new RangeError(`Directional shadow layer ${layer} is outside the supported range.`);
    }
    if (!this._texture) this.prepareTarget(light.shadow.mapSize);
    const objectTable = this._objectTables[layer]!;
    const objects = this._objects[layer]!;
    objectTable.beginUploads(submissionContext);
    const lightViewProjection = this._updateLightMatrix(light, focus, layer);
    this._lightFrustum.setFromViewProjection(lightViewProjection);
    writeBuffer(this._engine.device.queue, this._cameraBuffers[layer]!, 0, lightViewProjection);
    this._liveEntities.clear();
    this._liveGeometries.clear();
    this._liveDeformations.clear();
    this._drawCasters.length = 0;
    this._drawCastersOutOfSlotOrder = false;

    for (const item of items) {
      if (this._isVisibleCaster(item)) this._liveEntities.add(item.entityId);
    }
    objects.releaseNotIn(this._liveEntities);

    // The table bind group changes when its storage buffer grows. Reserve before
    // encoding so the pass can bind one stable object table for every caster.
    objectTable.ensureCapacity(Math.max(1, this._liveEntities.size));
    // Spatial traversal order is view- and motion-dependent. Letting that order
    // assign stable slots scatters logically adjacent entity updates across the
    // whole table, turning one dynamic range into hundreds of queue writes.
    // Only new enrollment pays this sort; established entities retain slots.
    this._unassignedEntityIds.length = 0;
    for (const entityId of this._liveEntities) {
      if (!objects.get(entityId)) this._unassignedEntityIds.push(entityId);
    }
    this._unassignedEntityIds.sort(compareEntityIds);
    for (const entityId of this._unassignedEntityIds) objects.ensure(entityId);
    for (const item of items) {
      if (!this._liveEntities.has(item.entityId) || !item.geometry || !item.material || !item.worldMatrix) continue;
      const geometry = item.geometry;
      const sharedGeometry = this._geometryCache.ensure(geometry, this);
      const deformationSupported = supportsShadowDeformation(item.material);
      const morph = deformationSupported && geometry.morphUseGpu && geometry.hasMorphTargets;
      const skinned = deformationSupported && geometry.skinning !== null;
      const deformation = morph || skinned
        ? this._ensureDeformation(geometry, morph, skinned)
        : null;
      if (deformation) {
        this._liveDeformations.add(geometry.id);
        this._syncSkinningMatrices(geometry, deformation);
      }
      const object = objects.ensure(item.entityId);
      this._writeObject(objectTable, object, geometry, item.clippingPlanes, item.worldMatrix, morph);
      const variant = this._variant(morph, skinned);
      const cullMode = resolveCullMode(item.material) ?? geometry.cullMode ?? 'back';
      const objectSlot = object.modelSlot;
      const previousCaster = this._drawCasters[this._drawCasters.length - 1];
      if (previousCaster && objectSlot < previousCaster.objectSlot) {
        this._drawCastersOutOfSlotOrder = true;
      }
      this._drawCasters.push({
        sharedGeometry,
        pipeline: this._getPipeline(geometry, cullMode, variant),
        variant,
        cullMode,
        deformation,
        objectSlot,
      });
      this._liveGeometries.add(geometry.id);
    }
    objectTable.flushUploads();
    // Spatial/BVH traversal order can change when many casters move even when
    // the active caster set and stable object-table slots do not. Shadow depth
    // submission is order-independent, so restore slot order before finding
    // direct-instance runs. This preserves dirty-range uploads while avoiding
    // hundreds of one-object draws caused only by traversal-order churn.
    if (this._drawCastersOutOfSlotOrder) {
      this._drawCasters.sort(compareShadowCasterObjectSlots);
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: this._layerViews[layer]!,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setBindGroup(0, this._cameraBindGroups[layer]!);
    pass.setBindGroup(1, objectTable.bindGroup);
    for (let start = 0; start < this._drawCasters.length;) {
      const first = this._drawCasters[start]!;
      let end = start + 1;
      while (
        end < this._drawCasters.length
        && this._canInstanceTogether(first, this._drawCasters[end]!)
        && this._drawCasters[end]!.objectSlot === this._drawCasters[end - 1]!.objectSlot + 1
      ) {
        end++;
      }
      this._drawDirectInstances(pass, first, end - start);
      start = end;
    }
    pass.end();
    this._finishLayerLiveness();
    return {
      enabled: true,
      view: this._layerViews[layer]!,
      arrayView: this._arrayView,
      layer,
      sampler: this._sampler,
      lightViewProjection,
      mapSize: this._mapSize,
      bias: light.shadow.bias,
      normalBias: light.shadow.normalBias,
    };
  }

  private _isVisibleCaster(item: Render3DRenderItem): boolean {
    return item.geometry !== null
      && item.material !== null
      && item.worldMatrix !== null
      && (!item.worldSphere || this._lightFrustum.containsSphere(item.worldSphere));
  }

  private _finishLayerLiveness(): void {
    if (!this._layerBatchActive) {
      this._deformations.releaseNotIn(this._liveDeformations);
      this._geometryCache.releaseUnused(this, this._liveGeometries);
      return;
    }
    this._layerBatchHasRender = true;
    for (const geometryId of this._liveGeometries) this._batchLiveGeometries.add(geometryId);
    for (const geometryId of this._liveDeformations) this._batchLiveDeformations.add(geometryId);
  }

  private _ensureTarget(size: number): boolean {
    if (this._mapSize === size && this._texture) return false;
    this._texture?.destroy();
    this._mapSize = size;
    this._texture = this._engine.device.createTexture({
      label: 'Haiyue.directional-shadow-map',
      size: [size, size, SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._layerViews.length = 0;
    for (let layer = 0; layer < SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS; layer++) {
      this._layerViews.push(this._texture.createView({
        dimension: '2d',
        baseArrayLayer: layer,
        arrayLayerCount: 1,
      }));
    }
    this._view = this._layerViews[0]!;
    this._arrayView = this._texture.createView({
      dimension: '2d-array',
      baseArrayLayer: 0,
      arrayLayerCount: SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS,
    });
    this._sampler = this._engine.device.createSampler({
      compare: 'less-equal',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this._targetRevision = this._targetRevision >= Number.MAX_SAFE_INTEGER ? 1 : this._targetRevision + 1;
    return true;
  }

  private _updateLightMatrix(
    light: DirectionalLight,
    focus: readonly [number, number, number],
    layer: number,
  ): Float32Array {
    const lightViewProjection = this._lightViewProjections[layer]!;
    writeDirectionalShadowViewProjection(
      light,
      lightViewProjection,
      this._viewMatrices[layer]!,
      this._projectionMatrices[layer]!,
      focus,
    );
    return lightViewProjection;
  }

  private _writeObject(
    objectTable: RendererObjectTable,
    object: ShadowObjectData,
    geometry: Geometry3D,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    morphEnabled: boolean,
  ): void {
    const base = object.modelSlot * OBJECT_TABLE_FLOATS;
    const data = objectTable.data;
    const morph0 = morphEnabled ? geometry.morphWeights[0] ?? 0 : 0;
    const morph1 = morphEnabled ? geometry.morphWeights[1] ?? 0 : 0;
    const morph2 = morphEnabled ? geometry.morphWeights[2] ?? 0 : 0;
    const morph3 = morphEnabled ? geometry.morphWeights[3] ?? 0 : 0;
    const skinned = geometry.skinning ? 1 : 0;
    const clipKey = clippingStateKey(clippingPlanes);
    const objectUnchanged =
      !object.modelDirty
      && matrixEquals(object.modelSnapshot, worldMatrix)
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
      objectTable.writeSlot(object.modelSlot);
      object.modelSnapshot.set(worldMatrix);
      object.modelDirty = false;
    }
    if (object.clippingKey !== clipKey) {
      writeClippingBlock(objectTable.auxiliaryData, object.modelSlot * CLIPPING_BLOCK_FLOATS, clippingPlanes);
      objectTable.writeAuxiliarySlot(object.modelSlot);
    }
    object.clippingKey = clipKey;
  }

  private _ensureDeformation(geometry: Geometry3D, morph: boolean, skinned: boolean): ShadowDeformationGpuData {
    let data = this._deformations.get(geometry.id);
    if (!data || !this._deformationMatches(data, geometry, morph, skinned)) {
      data = this._createDeformation(geometry, morph, skinned);
      this._deformations.set(geometry.id, data);
    }
    return data;
  }

  private _deformationMatches(
    data: ShadowDeformationGpuData,
    geometry: Geometry3D,
    morph: boolean,
    skinned: boolean,
  ): boolean {
    if (data.vertexCount !== geometry.vertexCount || data.morphEnabled !== morph) return false;
    for (let index = 0; index < 4; index++) {
      if (data.morphSources[index] !== (morph ? geometry.morphTargets[index]?.positions ?? null : null)) return false;
    }
    const skinning = skinned ? geometry.skinning : null;
    return data.skinning === skinning
      && data.skinJointSource === (skinning?.joints ?? null)
      && data.skinWeightSource === (skinning?.weights ?? null)
      && data.skinMatrixSource === (skinning?.jointMatrices ?? null)
      && (data.skinMatrixBuffer !== null) === skinned;
  }

  private _createDeformation(geometry: Geometry3D, morph: boolean, skinned: boolean): ShadowDeformationGpuData {
    const morphSources = Array.from({ length: 4 }, (_, index) =>
      morph ? geometry.morphTargets[index]?.positions ?? null : null);
    const zeroMorph = sharedZeroVectorCache.vec3(geometry.vertexCount);
    const morphBuffers = morph
      ? morphSources.map(source => this._makeBuffer(source ?? zeroMorph, GPUBufferUsage.VERTEX))
      : [];
    const skinning = skinned ? geometry.skinning : null;
    const skinJointBuffer = skinning ? this._makeBuffer(skinning.joints, GPUBufferUsage.STORAGE) : null;
    const skinWeightBuffer = skinning ? this._makeBuffer(skinning.weights, GPUBufferUsage.STORAGE) : null;
    const skinMatrixBuffer = skinning ? this._makeBuffer(skinning.jointMatrices, GPUBufferUsage.STORAGE, 64) : null;
    const skinBindGroup = skinning && skinJointBuffer && skinWeightBuffer && skinMatrixBuffer
      ? this._engine.device.createBindGroup({
        layout: this._skinLayout,
        entries: [
          { binding: 0, resource: { buffer: skinMatrixBuffer } },
          { binding: 1, resource: { buffer: skinJointBuffer } },
          { binding: 2, resource: { buffer: skinWeightBuffer } },
        ],
      })
      : null;
    return {
      morphEnabled: morph,
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
      vertexCount: geometry.vertexCount,
    };
  }

  private _makeBuffer(data: { byteLength: number; buffer: ArrayBufferLike; byteOffset: number }, usage: number, minimumSize = 16): GPUBuffer {
    const buffer = this._engine.device.createBuffer({
      size: Math.max(minimumSize, alignUp4(data.byteLength)),
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) writeBuffer(this._engine.device.queue, buffer, 0, data);
    return buffer;
  }

  private _syncSkinningMatrices(geometry: Geometry3D, data: ShadowDeformationGpuData): void {
    const skinning = geometry.skinning;
    if (!skinning || !data.skinMatrixBuffer || data.skinVersion === skinning.version) return;
    writeBuffer(this._engine.device.queue, data.skinMatrixBuffer, 0, skinning.jointMatrices);
    data.skinVersion = skinning.version;
  }

  private _destroyDeformation(data: ShadowDeformationGpuData): void {
    for (const buffer of data.morphBuffers) buffer.destroy();
    data.skinJointBuffer?.destroy();
    data.skinWeightBuffer?.destroy();
    data.skinMatrixBuffer?.destroy();
  }

  private _canInstanceTogether(first: ShadowDrawCaster, next: ShadowDrawCaster): boolean {
    if (
      first.pipeline !== next.pipeline
      || first.variant !== next.variant
      || first.cullMode !== next.cullMode
      || first.sharedGeometry.positionBuf !== next.sharedGeometry.positionBuf
      || first.sharedGeometry.vertexCount !== next.sharedGeometry.vertexCount
      || first.sharedGeometry.indexBuf !== next.sharedGeometry.indexBuf
      || first.sharedGeometry.indexCount !== next.sharedGeometry.indexCount
      || first.sharedGeometry.indexFormat !== next.sharedGeometry.indexFormat
    ) {
      return false;
    }
    if (
      (first.deformation?.skinBindGroup ?? null) !== (next.deformation?.skinBindGroup ?? null)
      || first.deformation?.morphBuffers.length !== next.deformation?.morphBuffers.length
    ) {
      return false;
    }
    const firstMorphBuffers = first.deformation?.morphBuffers;
    const nextMorphBuffers = next.deformation?.morphBuffers;
    if (firstMorphBuffers && nextMorphBuffers) {
      for (let index = 0; index < firstMorphBuffers.length; index++) {
        if (firstMorphBuffers[index] !== nextMorphBuffers[index]) return false;
      }
    }
    return true;
  }

  private _drawDirectInstances(
    pass: GPURenderPassEncoder,
    caster: ShadowDrawCaster,
    instanceCount: number,
  ): void {
    const { sharedGeometry, deformation, variant } = caster;
    pass.setPipeline(caster.pipeline);
    if (variant.skinned && deformation?.skinBindGroup) pass.setBindGroup(3, deformation.skinBindGroup);
    pass.setVertexBuffer(0, sharedGeometry.positionBuf);
    if (variant.morph && deformation) {
      for (let index = 0; index < 4; index++) pass.setVertexBuffer(index + 1, deformation.morphBuffers[index]!);
    }
    if (sharedGeometry.indexBuf) {
      pass.setIndexBuffer(sharedGeometry.indexBuf, sharedGeometry.indexFormat);
      pass.drawIndexed(sharedGeometry.indexCount, instanceCount, 0, 0, caster.objectSlot);
    } else {
      pass.draw(sharedGeometry.vertexCount, instanceCount, 0, caster.objectSlot);
    }
  }

  private _variant(morph: boolean, skinned: boolean): ShadowPipelineVariant {
    const index = (morph ? 1 : 0) | (skinned ? 2 : 0);
    return SHADOW_PIPELINE_VARIANTS[index]!;
  }

  private _getPipeline(
    geometry: Geometry3D,
    cullMode: GPUCullMode,
    variant: ShadowPipelineVariant,
  ): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const frontFace = geometry.frontFace ?? 'ccw';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const key = this._pipelineKey(topology, cullMode, frontFace, stripIndexFormat, variant);
    const shader = this._shaderModules[(variant.morph ? 1 : 0) | (variant.skinned ? 2 : 0)]!;
    return this.getCachedPipeline(key, () => this._engine.device.createRenderPipeline(
      this._pipelineDescriptor(topology, cullMode, frontFace, stripIndexFormat, variant, shader),
    ));
  }

  private _pipelineKey(
    topology: GPUPrimitiveTopology,
    cullMode: GPUCullMode,
    frontFace: GPUFrontFace,
    stripIndexFormat: GPUIndexFormat | undefined,
    variant: ShadowPipelineVariant,
  ): string {
    const flags = (variant.morph ? 1 : 0) | (variant.skinned ? 2 : 0);
    return encodeShaderPipelineKey(
      encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, false, 1, flags),
      `deformation-abi-v1:${variant.pass}`,
    );
  }

  private _pipelineDescriptor(
    topology: GPUPrimitiveTopology,
    cullMode: GPUCullMode,
    frontFace: GPUFrontFace,
    stripIndexFormat: GPUIndexFormat | undefined,
    variant: ShadowPipelineVariant,
    shader: GPUShaderModule,
  ): GPURenderPipelineDescriptor {
    const buffers: GPUVertexBufferLayout[] = [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
    ];
    if (variant.morph) {
      for (let index = 0; index < 4; index++) {
        buffers.push({
          arrayStride: 12,
          attributes: [{ shaderLocation: index + 1, offset: 0, format: 'float32x3' }],
        });
      }
    }
    return {
      label: `ShadowMapRenderer.${variant.skinned ? 'skinned' : 'static'}${variant.morph ? '.morph' : ''}`,
      layout: variant.skinned ? this._skinnedPipelineLayout : this._pipelineLayout,
      vertex: { module: shader, entryPoint: 'vs_main', buffers },
      primitive: createPrimitiveState(topology, cullMode, frontFace, stripIndexFormat),
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    };
  }

  destroy(): void {
    for (const buffer of this._cameraBuffers) buffer.destroy();
    this._cameraBuffers.length = 0;
    this._cameraBindGroups.length = 0;
    this._texture?.destroy();
    for (const objects of this._objects) objects.clear();
    this._objects.length = 0;
    for (const objectTable of this._objectTables) objectTable.destroy();
    this._objectTables.length = 0;
    this._deformations.clear();
    this._geometryCache?.releaseOwner(this);
    this._shaderModules.length = 0;
    this._drawCasters.length = 0;
    this._drawCastersOutOfSlotOrder = false;
    this._batchLiveGeometries.clear();
    this._batchLiveDeformations.clear();
    this._layerBatchActive = false;
    this._layerBatchHasRender = false;
    this._layerViews.length = 0;
    this._mapSize = 0;
    this._targetRevision = 0;
    this.clearPipelineCache();
    this._initialized = false;
  }
}

function compareShadowCasterObjectSlots(a: ShadowDrawCaster, b: ShadowDrawCaster): number {
  return a.objectSlot - b.objectSlot;
}

function compareEntityIds(a: number, b: number): number {
  return a - b;
}

function supportsShadowDeformation(material: Material): boolean {
  return material.type === 'basic' || material.type === 'pbr-metallic-roughness';
}
