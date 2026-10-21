import { PbrSceneBindGroups } from './PbrSceneBindGroups';
import { ViewLightUniformBuffer, LIGHT_UNIFORM_BYTES, LIGHT_UNIFORM_BINDING } from './ViewLightUniformBuffer';
import { mat4 } from 'wgpu-matrix';
import type { MaterialCoverageResources } from './AuxiliaryMaterial';
import { AssetManager } from '../assets/AssetManager';
import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { EnvironmentLight } from '../lighting/EnvironmentLight';
import type { PbrAlphaMode, PbrMaterial } from '../material/PbrMaterial';
import type { MaterialGpuDrivenBatch, MaterialRenderBatchItem } from './MaterialRendererRegistry';
import { forEachDirectInstanceBatchRun, forEachIndirectBatchRun } from './DirectInstanceBatchRuns';
import type { GpuDrivenBatchBuffer } from './GpuDrivenBatchBuffer';
import { BaseRenderer } from './BaseRenderer';
import { RendererObjectSlotCache } from './RendererCacheMap';
import { RendererObjectTable } from './RendererObjectTable';
import type { SharedGeometry3DGPUData } from './SharedGeometry3DGPUCache';
import { createColorTargetState, createPrimitiveState } from './gpuDescriptors';
import { encodePrimitivePipelineKey } from './pipelineKey';
import { colorEquals, getStripIndexFormat, matrixEquals, writeBuffer } from './utils';
import type { LiveIdSet } from './utils';
import type { DirectionalShadowState } from './ShadowMapRenderer';
import {
  SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS,
  SCENE_RENDER_MAX_LIGHTS,
  type PbrLightInfo,
} from '../frame/SceneRenderEnvironment';
import { getBuiltinMaterialLightingShader } from '../shader/BuiltinMaterialLightingShader';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import {
  getEnvironmentCubeMipCount,
  getEnvironmentCubeVersion,
  unwrapEnvironmentCubeTexture,
} from './PbrTextureBindings';
import { PbrDirectionalShadowBinding } from './PbrDirectionalShadowBinding';
import { PbrDeformationGpuCache, type PbrDeformationGpuData } from './PbrDeformationGpuCache';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { CLIPPING_BLOCK_FLOATS, clippingStateKey, writeClippingBlock } from './ClippingPlanesGpu';
import { writePbrEnvironmentUniforms } from './PbrEnvironmentUniforms';
import { ParameterizedRendererCore, SharedGeometryRendererOwner } from './ParameterizedRendererCore';
import { RecordedGpuResources } from './RecordedGpuResources';
import { PbrMaterialResources, PBR_BASE_BINDING_SLOTS as BASE_BINDING_SLOTS, type MaterialGpuData } from './PbrMaterialResources';
import { registerPbrDeferredSurfacePort, deletePbrDeferredSurfacePort, type PbrDeferredSurfaceShader, type PbrFullLightingState } from './PbrDeferredSurfacePort';

export const PBR_MAX_LIGHTS = SCENE_RENDER_MAX_LIGHTS;
export type { PbrLightInfo } from '../frame/SceneRenderEnvironment';

export interface PbrSceneLightingContext {
  /** Stable revision of light and image-based environment uniform inputs. */
  readonly lightingRevision: number;
  /** Stable revision of the rendered directional-shadow state. */
  readonly shadowRevision: number;
  readonly lights: readonly PbrLightInfo[];
  readonly environment: EnvironmentLight | null;
  readonly shadow: DirectionalShadowState | null;
  readonly shadows?: readonly (DirectionalShadowState | null)[];
}

interface ObjectGpuData {
  modelSlot: number;
  modelSnapshot: Float32Array;
  dirty: boolean;
  clippingKey: string;
}

interface EnvironmentGpuState {
  source: EnvironmentLight | null;
  diffuseSource: unknown;
  specularSource: unknown;
  diffuseVersion: number;
  specularVersion: number;
  diffuseTexture: GPUTexture;
  specularTexture: GPUTexture;
}

const OBJECT_FLOATS = 40;
const OBJECT_MORPH_OFFSET = 32;
const OBJECT_DEFORMATION_FLAGS_OFFSET = 36;
const ENVIRONMENT_BYTES = 48;

export class PbrRenderer extends BaseRenderer {
  private _deferredSurface: PbrDeferredSurfaceShader | null = null;
  private _fullLighting: PbrFullLightingState | null = null;
  private readonly _sceneGroups = new PbrSceneBindGroups();
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private _engine!: IEngine;
  private recordedOwner: RecordedGpuResources | undefined;
  private get recorded(): RecordedGpuResources { return this.recordedOwner ??= new RecordedGpuResources(this._engine.device); }
  private submissionContext: RenderCommandContext | undefined;
  private _assetManager!: AssetManager;
  private _ownsAssetManager = false;
  private _baseShader!: GPUShaderModule;
  private _clearcoatShader!: GPUShaderModule;
  private _transmissionShader!: GPUShaderModule;
  private _transmissionClearcoatShader!: GPUShaderModule;
  private _baseShaderKey = '';
  private _clearcoatShaderKey = '';
  private _transmissionShaderKey = '';
  private _transmissionClearcoatShaderKey = '';
  private _pipelineLayout!: GPUPipelineLayout;
  private _cameraLayout!: GPUBindGroupLayout;
  private _objectLayout!: GPUBindGroupLayout;
  private _materialLayout!: GPUBindGroupLayout;
  private _sceneLayout!: GPUBindGroupLayout;
  private _sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly _cameraDynamicOffset = new Uint32Array(1);
  private _lightUniforms!: ViewLightUniformBuffer;
  private _lights: readonly PbrLightInfo[] = [];
  private _sceneBindGroup!: GPUBindGroup;
  private _environmentBuffer!: GPUBuffer;
  private _directionalShadowBinding!: PbrDirectionalShadowBinding;
  private _environmentSampler!: GPUSampler;
  private _defaultSampler!: GPUSampler;
  private _defaultWhite!: GPUTexture;
  private _defaultNormal!: GPUTexture;
  private _defaultBlack!: GPUTexture;
  private _defaultBlackView!: GPUTextureView;
  private _defaultCube!: GPUTexture;
  private _defaultShadow!: GPUTexture;
  private _defaultShadowView!: GPUTextureView;
  private _defaultShadowSampler!: GPUSampler;
  private _transmissionFramebufferView!: GPUTextureView;
  private _rendererCore!: ParameterizedRendererCore<ObjectGpuData, SharedGeometry3DGPUData>;
  private get _objectTable(): RendererObjectTable { return this._rendererCore.requireObjectTable(); }
  private get _batchObjectTable(): RendererObjectTable { return this._rendererCore.requireBatchObjectTable(); }
  private get _geometryCache(): SharedGeometryRendererOwner { return this._rendererCore.geometry as SharedGeometryRendererOwner; }
  private get _objects(): RendererObjectSlotCache<ObjectGpuData> { return this._rendererCore.requireObjects(); }
  private _deformationCache!: PbrDeformationGpuCache;
  private _environmentState!: EnvironmentGpuState;
  private _materialResources!: PbrMaterialResources;
  private get _materials() { return this._materialResources.entries; }
  private readonly _environmentData = new Float32Array(ENVIRONMENT_BYTES / 4);
  private readonly _environmentSnapshot = new Float32Array(ENVIRONMENT_BYTES / 4).fill(Number.NaN);
  private readonly _inverseScratch = mat4.identity() as Float32Array;
  private readonly _normalScratch = mat4.identity() as Float32Array;
  private _initialized = false;
  private get _uploadsPrepared(): boolean { return this._rendererCore.uploadsPrepared; }
  private _sceneLightingRevision = -1;
  private _sceneShadowRevision = -1;
  private _sceneBindingRevision = 0;

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this._initialized = true;
    this._engine = engine;
    this._environmentSnapshot.fill(Number.NaN);
    const device = engine.device;
    this.recordedOwner = new RecordedGpuResources(device);
    this._assetManager = engine.assetManager ?? new AssetManager(device, getEngineGPUResourceTracker(engine), engine.defaults?.assetManager);
    this._ownsAssetManager = !engine.assetManager;
    this._sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this._createLayouts();
    const layouts = [this._cameraLayout, this._objectLayout, this._materialLayout, this._sceneLayout];
    let deferredBindingRevision = -1;
    let deferredBindings: readonly GPUBindGroupEntry[] = [];
    registerPbrDeferredSurfacePort(this, {
      layouts,
      setSurface: shader => { this._deferredSurface = shader; },
      setFullLighting: state => { this._fullLighting = state; },
      lightingBindings: () => {
        if (deferredBindingRevision === this._sceneBindingRevision) return deferredBindings;
        deferredBindingRevision = this._sceneBindingRevision;
        return deferredBindings = [
        { binding: 8, resource: { buffer: this._environmentBuffer } },
        { binding: 9, resource: this._environmentState.diffuseTexture.createView({ dimension: 'cube' }) },
        { binding: 10, resource: this._environmentState.specularTexture.createView({ dimension: 'cube' }) },
        { binding: 11, resource: this._environmentSampler },
        { binding: 12, resource: { buffer: this._directionalShadowBinding.buffer } },
        { binding: 13, resource: this._directionalShadowBinding.view },
        { binding: 14, resource: this._directionalShadowBinding.sampler },
        ];
      },
    });
    const base = getBuiltinMaterialLightingShader(device, 'pbr', layouts);
    const clearcoat = getBuiltinMaterialLightingShader(device, 'pbr-clearcoat', layouts);
    const transmission = getBuiltinMaterialLightingShader(device, 'pbr-transmission', layouts);
    const transmissionClearcoat = getBuiltinMaterialLightingShader(device, 'pbr-transmission-clearcoat', layouts);
    this._baseShader = base.module;
    this._clearcoatShader = clearcoat.module;
    this._transmissionShader = transmission.module;
    this._transmissionClearcoatShader = transmissionClearcoat.module;
    this._baseShaderKey = base.pass.canonicalHash;
    this._clearcoatShaderKey = clearcoat.pass.canonicalHash;
    this._transmissionShaderKey = transmission.pass.canonicalHash;
    this._transmissionClearcoatShaderKey = transmissionClearcoat.pass.canonicalHash;
    this._deformationCache = new PbrDeformationGpuCache({
      device,
      getSceneBindingRevision: () => this._sceneBindingRevision,
      getFallbackSceneBindGroup: () => this._sceneBindGroup,
      createSceneBindGroup: (skinMatrices, skinJoints, skinWeights) =>
        this._buildSceneBindGroup(skinMatrices, skinJoints, skinWeights),
    });
    this._pipelineLayout = base.pipelineLayout;
    this._rendererCore = new ParameterizedRendererCore({
      objectTables: {
        device,
        bindGroupLayout: this._objectLayout,
        label: 'PbrRenderer',
        floatsPerSlot: OBJECT_FLOATS,
        auxiliary: { binding: 1, floatsPerSlot: CLIPPING_BLOCK_FLOATS, label: 'PbrRenderer.clippingTable' },
      },
      createObject: modelSlot => ({ modelSlot, modelSnapshot: new Float32Array(16), dirty: true, clippingKey: '' }),
      geometry: new SharedGeometryRendererOwner(device, this, getEngineGPUResourceTracker(engine)),
    });
    this._lightUniforms = new ViewLightUniformBuffer(device, 'PbrRenderer.lights');
    this._environmentBuffer = device.createBuffer({ label: 'PbrRenderer.environment', size: ENVIRONMENT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._defaultSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this._environmentSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this._defaultShadowSampler = device.createSampler({ compare: 'less-equal' });
    this._defaultWhite = this._createSolidTexture([255, 255, 255, 255]);
    this._defaultNormal = this._createSolidTexture([128, 128, 255, 255]);
    this._defaultBlack = this._createSolidTexture([0, 0, 0, 255]);
    this._defaultBlackView = this._defaultBlack.createView();
    this._defaultCube = this._createSolidCube([255, 255, 255, 255]);
    this._defaultShadow = device.createTexture({
      size: [1, 1, SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._defaultShadowView = this._defaultShadow.createView({ dimension: '2d-array' });
    this._transmissionFramebufferView = this._defaultBlackView;
    this._environmentState = this._createEnvironmentState();
    this._directionalShadowBinding = new PbrDirectionalShadowBinding(
      device,
      this._defaultShadowView,
      this._defaultShadowSampler,
    );
    for (const texture of [this._defaultWhite, this._defaultNormal, this._defaultBlack, this._defaultCube, this._defaultShadow]) {
      this.recorded.own(texture, () => texture.destroy());
    }
    const environmentBuffer = this._environmentBuffer;
    this.recorded.own(environmentBuffer, () => environmentBuffer.destroy());
    if (this._ownsAssetManager) { const assets = this._assetManager; this.recorded.own(assets, () => assets.dispose()); }
    this._materialResources = new PbrMaterialResources({ device, assets: this._assetManager, signal: this._rendererCore.signal,
      layout: this._materialLayout, defaultSampler: this._defaultSampler, white: this._defaultWhite,
      normal: this._defaultNormal, black: this._defaultBlack, recorded: this.recorded });
    this._rebuildSceneBindGroup();
    this.updateEnvironment(null);
    this.updateShadow(null);
  }

  /** Selects the opaque scene-color snapshot sampled by transmissive materials. */
  setTransmissionFramebuffer(view: GPUTextureView | null): void {
    const next = view ?? this._defaultBlackView;
    if (this._transmissionFramebufferView === next) return;
    this._transmissionFramebufferView = next;
    this._rebuildSceneBindGroup();
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const topology: GPUPrimitiveTopology = 'triangle-list';
    const cullMode: GPUCullMode = 'back';
    const frontFace: GPUFrontFace = 'ccw';
    for (const alphaMode of ['opaque', 'mask', 'blend'] as const) {
      for (const uvLayoutKey of ['none', '0=TEXCOORD_0']) {
        for (const clearcoatEnabled of [false, true]) {
          for (const transmissionEnabled of [false, true]) {
            const alphaFlag = alphaMode === 'blend' ? 2 : alphaMode === 'mask' ? 1 : 0;
            const primitiveKey = encodePrimitivePipelineKey(
              topology,
              cullMode,
              frontFace,
              undefined,
              this.reverseZ,
              this.msaaSamples,
              alphaFlag,
            );
            const key = this._rendererCore.pipelineKey(
              `${primitiveKey}|uv:${uvLayoutKey}|cc:${clearcoatEnabled ? 1 : 0}|tr:${transmissionEnabled ? 1 : 0}`,
              this._shaderKey(clearcoatEnabled, transmissionEnabled),
            );
            this.addPipelineWarmup(
              plan,
              key,
              `PBR ${alphaMode}${clearcoatEnabled ? ' clearcoat' : ''}${transmissionEnabled ? ' transmission' : ''} (${uvLayoutKey === 'none' ? 'no UV' : 'UV0'})`,
              () => this._pipelineDescriptor(topology, cullMode, frontFace, alphaMode, clearcoatEnabled, undefined, transmissionEnabled),
              this._engine.device,
            );
          }
        }
      }
    }
  }

  updateFrame(
    sceneFrame: SceneFrameUniformSnapshot,
    lights: readonly PbrLightInfo[],
    environment: EnvironmentLight | null,
    shadow: DirectionalShadowState | null,
    _viewSlot = 0,
    context?: RenderCommandContext,
  ): void {
    this._lights = lights;
    const environmentBindingsChanged = this.updateEnvironment(environment, false);
    const shadowBindingsChanged = this.updateShadows([shadow], false);
    if (environmentBindingsChanged || shadowBindingsChanged) this._rebuildSceneBindGroup();
    this._sceneLightingRevision = -1;
    this._sceneShadowRevision = -1;
    this.beginView(sceneFrame, context);
  }

  /** Prepares selected lights for beginView and updates shared environment/shadow data. */
  beginScene(scene: PbrSceneLightingContext): void {
    this._lights = scene.lights;
    let bindingsChanged = false;
    if (this._sceneLightingRevision !== scene.lightingRevision) {
      bindingsChanged = this.updateEnvironment(scene.environment, false) || bindingsChanged;
      this._sceneLightingRevision = scene.lightingRevision;
    }
    if (this._sceneShadowRevision !== scene.shadowRevision) {
      bindingsChanged = this.updateShadows(scene.shadows ?? [scene.shadow], false) || bindingsChanged;
      this._sceneShadowRevision = scene.shadowRevision;
    }
    if (bindingsChanged) this._rebuildSceneBindGroup();
  }

  /** Selects one SceneFrame arena slot and starts view-local object uploads. */
  beginView(sceneFrame: SceneFrameUniformSnapshot, context?: RenderCommandContext): void {
    this.submissionContext = context;
    this.recorded.retain(this._environmentBuffer, context);
    this._directionalShadowBinding.retain(context);
    for (const texture of [this._defaultWhite, this._defaultNormal, this._defaultBlack, this._defaultCube, this._defaultShadow]) this.recorded.retain(texture, context);
    if (this._ownsAssetManager) this.recorded.retain(this._assetManager, context);
    const previousBuffer = this._lightUniforms.buffer;
    this._lightUniforms.selectView(sceneFrame, context);
    this._lightUniforms.upload(this._lights);
    if (previousBuffer !== this._lightUniforms.buffer) this._rebuildSceneBindGroup();
    this._rendererCore.beginUploads(context);
    this._cameraDynamicOffset[0] = this._sceneFrameBinding.upload(sceneFrame, context);
  }

  prepareObjects(
    items: readonly MaterialRenderBatchItem<PbrMaterial>[],
    first = 0,
    count = items.length - first,
    firstBatchIndex = first,
    batchBuffer: GpuDrivenBatchBuffer | null = null,
  ): void {
    const end = Math.min(items.length, first + count);
    for (let index = first; index < end; index++) {
      const item = items[index];
      if (!item?.geometry || !item.material || !item.worldMatrix) continue;
      const material = item.material;
      const geometryData = this._geometryCache.ensure(item.geometry, this);
      void geometryData;
      this._deformationCache.ensure(item.geometry, this.submissionContext);
      const object = this._objects.ensure(item.entityId);
      const batchSlot = batchBuffer && material.alphaMode !== 'blend' && material.transmissionFactor <= 0
        ? batchBuffer.getObjectSlot(firstBatchIndex + index - first)
        : undefined;
      const objectSlot = batchSlot ?? object.modelSlot;
      const objectTable = batchSlot === undefined ? this._objectTable : this._batchObjectTable;
      this._writeObject(object, item.geometry, item.clippingPlanes, item.worldMatrix, objectSlot, objectTable, batchSlot === undefined);
      const materialData = this._materials.ensure(this._rendererCore.materialIdentity(material), () => this._createMaterial(material));
      this._syncMaterial(material, materialData);
    }
  }

  flushUploads(): void {
    this._rendererCore.flushUploads();
  }

  endView(): void {
    this._rendererCore.endView();
    this.submissionContext = undefined;
  }

  render(
    pass: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: PbrMaterial,
    worldMatrix: Float32Array,
    options: { gpuDrivenBatch?: MaterialGpuDrivenBatch | undefined } = {},
    clippingPlanes: ClippingPlanes | null = null,
  ): void {
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
    items: readonly MaterialRenderBatchItem<PbrMaterial>[],
    first: number,
    count: number,
    batchBuffer: GpuDrivenBatchBuffer,
  ): void {
    if (batchBuffer.gpuUploadEnabled === false) {
      forEachDirectInstanceBatchRun(items, first, count, batchBuffer, run => {
        this._renderDirectInstanceRun(
          pass,
          run.item.geometry,
          run.item.material,
          run.firstInstance,
          run.instanceCount,
        );
      });
      return;
    }
    if (this._uploadsPrepared) {
      forEachIndirectBatchRun(items, first, count, batchBuffer, run => {
        this._renderDirectInstanceRun(pass, run.item.geometry, run.item.material,
          run.firstInstance, run.instanceCount, batchBuffer, run.firstBatch);
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

  private _renderDirectInstanceRun(
    pass: GPURenderPassEncoder,
    geometry: Geometry3D,
    material: PbrMaterial,
    firstInstance: number,
    instanceCount: number,
    batchBuffer?: GpuDrivenBatchBuffer,
    firstBatch = 0,
  ): void {
    const geometryData = this._geometryCache.ensure(geometry, this);
    const deformation = this._deformationCache.ensure(geometry, this.submissionContext);
    const materialData = this._materials.ensure(this._rendererCore.materialIdentity(material), () => this._createMaterial(material));
    if (!this._uploadsPrepared) this._syncMaterial(material, materialData);

    const bindings = batchBuffer ? this.indirectBatches.begin() : pass;
    bindings.setPipeline(this._getPipeline(geometry, material));
    bindings.setBindGroup(0, this._sceneFrameBinding.bindGroup, this._cameraDynamicOffset);
    bindings.setBindGroup(1, this._batchObjectTable.bindGroup);
    bindings.setBindGroup(2, materialData.bindGroup);
    bindings.setBindGroup(3, this._sceneGroup(deformation), this._lightUniforms.dynamicOffset);
    bindings.setVertexBuffer(0, geometryData.positionBuf);
    bindings.setVertexBuffer(1, geometryData.normalBuf);
    bindings.setVertexBuffer(2, geometryData.uvBuf);
    bindings.setVertexBuffer(3, geometryData.uv1Buf);
    for (let index = 0; index < 4; index++) bindings.setVertexBuffer(index + 4, deformation.morphBuffers[index]!);
    if (batchBuffer) {
      this.indirectBatches.draw(pass, this._engine.device, batchBuffer, firstBatch, instanceCount,
        geometryData.indexBuf, geometryData.indexFormat,
        this._deferredSurface ? ['rgba16float', 'rgba16float', 'rgba16float'] : [this.colorFormat ?? this._engine.format],
        this._deferredSurface ? 'depth32float' : this._engine.getDepthFormat(this.reverseZ), this.msaaSamples);
      return;
    }
    if (geometryData.indexBuf) {
      pass.setIndexBuffer(geometryData.indexBuf, geometryData.indexFormat);
      pass.drawIndexed(geometryData.indexCount, instanceCount, 0, 0, firstInstance);
    } else {
      pass.draw(geometryData.vertexCount, instanceCount, 0, firstInstance);
    }
  }

  private _renderItem(
    pass: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: PbrMaterial,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    batchBuffer?: GpuDrivenBatchBuffer,
    batchIndex?: number,
  ): void {
    const geometryData = this._geometryCache.ensure(geometry, this);
    const deformation = this._deformationCache.ensure(geometry, this.submissionContext);
    const object = this._objects.ensure(entityId);
    const batchSlot = batchBuffer && batchIndex !== undefined
      ? batchBuffer.getObjectSlot(batchIndex)
      : undefined;
    const objectSlot = batchSlot ?? object.modelSlot;
    const objectTable = batchSlot === undefined ? this._objectTable : this._batchObjectTable;
    if (!this._uploadsPrepared) this._writeObject(object, geometry, clippingPlanes, worldMatrix, objectSlot, objectTable, batchSlot === undefined);
    const materialData = this._materials.ensure(this._rendererCore.materialIdentity(material), () => this._createMaterial(material));
    if (!this._uploadsPrepared) this._syncMaterial(material, materialData);

    pass.setPipeline(this._getPipeline(geometry, material));
    pass.setBindGroup(0, this._sceneFrameBinding.bindGroup, this._cameraDynamicOffset);
    pass.setBindGroup(1, objectTable.bindGroup);
    pass.setBindGroup(2, material.transmissionFactor > 0 ? materialData.transmissionBindGroup : materialData.bindGroup);
    pass.setBindGroup(3, this._sceneGroup(deformation), this._lightUniforms.dynamicOffset);
    pass.setVertexBuffer(0, geometryData.positionBuf);
    pass.setVertexBuffer(1, geometryData.normalBuf);
    pass.setVertexBuffer(2, geometryData.uvBuf);
    pass.setVertexBuffer(3, geometryData.uv1Buf);
    for (let index = 0; index < 4; index++) pass.setVertexBuffer(index + 4, deformation.morphBuffers[index]!);
    if (geometryData.indexBuf) {
      pass.setIndexBuffer(geometryData.indexBuf, geometryData.indexFormat);
      if (batchBuffer && batchIndex !== undefined) {
        pass.drawIndexedIndirect(batchBuffer.indexedIndirectBuffer, batchBuffer.getIndexedIndirectOffset(batchIndex));
      } else {
        pass.drawIndexed(geometryData.indexCount, 1, 0, 0, objectSlot);
      }
    } else if (batchBuffer && batchIndex !== undefined) {
      pass.drawIndirect(batchBuffer.drawIndirectBuffer, batchBuffer.getDrawIndirectOffset(batchIndex));
    } else {
      pass.draw(geometryData.vertexCount, 1, 0, objectSlot);
    }
  }

  releaseEntitiesNotIn(live: LiveIdSet): void { this._objects.releaseNotIn(live); }
  releaseGeometriesNotIn(live: LiveIdSet): void {
    this._geometryCache.releaseUnused(this, live);
    this._deformationCache.releaseNotIn(live);
  }
  releaseMaterialsNotIn(live: LiveIdSet): void { this._materials.releaseNotIn(live); }

  private _createLayouts(): void {
    const device = this._engine.device;
    this._cameraLayout = this._sceneFrameBinding.bindGroupLayout;
    this._objectLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ] });
    this._materialLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ...BASE_BINDING_SLOTS.map((_, index) => ({ binding: index + 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' as GPUTextureSampleType } })),
      ...BASE_BINDING_SLOTS.map((_, index) => ({ binding: index + 1 + BASE_BINDING_SLOTS.length, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' as GPUSamplerBindingType } })),
    ] });
    this._sceneLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: LIGHT_UNIFORM_BINDING },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 5, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 8, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 9, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 10, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 11, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ] });
  }

  private _writeObject(
    object: ObjectGpuData,
    geometry: Geometry3D,
    clippingPlanes: ClippingPlanes | null,
    world: Float32Array,
    slot: number,
    objectTable: RendererObjectTable,
    stable: boolean,
  ): void {
    objectTable.ensureCapacity(slot + 1);
    const base = slot * OBJECT_FLOATS;
    const morphEnabled = geometry.morphUseGpu && geometry.hasMorphTargets;
    const morph0 = morphEnabled ? geometry.morphWeights[0] ?? 0 : 0;
    const morph1 = morphEnabled ? geometry.morphWeights[1] ?? 0 : 0;
    const morph2 = morphEnabled ? geometry.morphWeights[2] ?? 0 : 0;
    const morph3 = morphEnabled ? geometry.morphWeights[3] ?? 0 : 0;
    const skinned = geometry.skinning ? 1 : 0;
    const clipKey = clippingStateKey(clippingPlanes);
    const table = objectTable.data;
    const objectUnchanged =
      stable
      && !object.dirty
      && matrixEquals(object.modelSnapshot, world)
      && table[base + OBJECT_MORPH_OFFSET] === morph0
      && table[base + OBJECT_MORPH_OFFSET + 1] === morph1
      && table[base + OBJECT_MORPH_OFFSET + 2] === morph2
      && table[base + OBJECT_MORPH_OFFSET + 3] === morph3
      && table[base + OBJECT_DEFORMATION_FLAGS_OFFSET + 1] === skinned;
    if (!objectUnchanged) {
      objectTable.data.set(world, base);
      mat4.inverse(world, this._inverseScratch);
      mat4.transpose(this._inverseScratch, this._normalScratch);
      objectTable.data.set(this._normalScratch, base + 16);
      table[base + OBJECT_MORPH_OFFSET] = morph0;
      table[base + OBJECT_MORPH_OFFSET + 1] = morph1;
      table[base + OBJECT_MORPH_OFFSET + 2] = morph2;
      table[base + OBJECT_MORPH_OFFSET + 3] = morph3;
      table[base + OBJECT_DEFORMATION_FLAGS_OFFSET] = morphEnabled ? 1 : 0;
      table[base + OBJECT_DEFORMATION_FLAGS_OFFSET + 1] = skinned;
      table[base + OBJECT_DEFORMATION_FLAGS_OFFSET + 2] = 0;
      table[base + OBJECT_DEFORMATION_FLAGS_OFFSET + 3] = 0;
      objectTable.writeSlot(slot);
    }
    if (!stable || object.clippingKey !== clipKey) {
      writeClippingBlock(objectTable.auxiliaryData, slot * CLIPPING_BLOCK_FLOATS, clippingPlanes);
      objectTable.writeAuxiliarySlot(slot);
    }
    if (stable) {
      if (!objectUnchanged) {
        object.modelSnapshot.set(world);
        object.dirty = false;
      }
      object.clippingKey = clipKey;
    }
  }

  private updateEnvironment(environment: EnvironmentLight | null, rebuildBindings = true): boolean {
    const diffuseSource = environment?.diffuseTexture ?? null;
    const specularSource = environment?.specularTexture ?? null;
    const diffuseVersion = getEnvironmentCubeVersion(diffuseSource);
    const specularVersion = getEnvironmentCubeVersion(specularSource);
    let bindingsChanged = false;
    if (
      this._environmentState.source !== environment ||
      this._environmentState.diffuseSource !== diffuseSource ||
      this._environmentState.specularSource !== specularSource ||
      this._environmentState.diffuseVersion !== diffuseVersion ||
      this._environmentState.specularVersion !== specularVersion
    ) {
      this._environmentState.source = environment;
      this._environmentState.diffuseSource = diffuseSource;
      this._environmentState.specularSource = specularSource;
      this._environmentState.diffuseVersion = diffuseVersion;
      this._environmentState.specularVersion = specularVersion;
      this._environmentState.diffuseTexture = unwrapEnvironmentCubeTexture(diffuseSource) ?? this._defaultCube;
      this._environmentState.specularTexture = unwrapEnvironmentCubeTexture(specularSource) ?? this._defaultCube;
      bindingsChanged = true;
    }
    writePbrEnvironmentUniforms(this._environmentData, environment, {
      maxMipLevel: Math.max(
        getEnvironmentCubeMipCount(diffuseSource),
        getEnvironmentCubeMipCount(specularSource),
        1,
      ) - 1,
      // EnvironmentUniforms.params is vec4<f32>; the shared writer deliberately
      // stores this flag through the Float32 view rather than a Uint32 alias.
      hasTexture: Boolean(diffuseSource || specularSource),
    });
    if (this._environmentData.some((value, index) => !Object.is(value, this._environmentSnapshot[index]))) {
      if (this.recorded.pending(this._environmentBuffer)) {
        const previous = this._environmentBuffer;
        const buffer = this._engine.device.createBuffer({ label: 'PbrRenderer.environment', size: ENVIRONMENT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this._environmentBuffer = this.recorded.own(buffer, () => buffer.destroy());
        this.recorded.retire(previous);
        bindingsChanged = true;
      }
      writeBuffer(this._engine.device.queue, this._environmentBuffer, 0, this._environmentData);
      this._environmentSnapshot.set(this._environmentData);
    }
    if (bindingsChanged && rebuildBindings) this._rebuildSceneBindGroup();
    return bindingsChanged;
  }

  private updateShadow(shadow: DirectionalShadowState | null, rebuildBindings = true): boolean {
    return this.updateShadows([shadow], rebuildBindings);
  }

  private updateShadows(
    shadows: readonly (DirectionalShadowState | null)[],
    rebuildBindings = true,
  ): boolean {
    const bindingsChanged = this._directionalShadowBinding.update(shadows);
    if (bindingsChanged && rebuildBindings) this._rebuildSceneBindGroup();
    return bindingsChanged;
  }

  private _createMaterial(material: PbrMaterial): MaterialGpuData { return this._materialResources.create(material); }

  /** @internal Borrow the exact material state used by forward shading. */
  prepareMaterialCoverage(material: PbrMaterial): MaterialCoverageResources {
    const data = this._materials.ensure(this._rendererCore.materialIdentity(material), () => this._createMaterial(material));
    this._syncMaterial(material, data);
    return data;
  }

  private _syncMaterial(material: PbrMaterial, data: MaterialGpuData): void { this._materialResources.sync(material, data, this.submissionContext); }

  private _createEnvironmentState(): EnvironmentGpuState {
    return {
      source: null,
      diffuseSource: null,
      specularSource: null,
      diffuseVersion: 0,
      specularVersion: 0,
      diffuseTexture: this._defaultCube,
      specularTexture: this._defaultCube,
    };
  }

  private _rebuildSceneBindGroup(): void {
    if (!this._environmentState || !this._directionalShadowBinding) return;
    this._sceneBindingRevision++;
    this._sceneBindGroup = this._buildSceneBindGroup(
      this._deformationCache.fallbackSkinMatrixBuffer,
      this._deformationCache.fallbackSkinJointBuffer,
      this._deformationCache.fallbackSkinWeightBuffer,
    );
  }

  private _buildSceneBindGroup(
    skinMatrices: GPUBuffer,
    skinJoints: GPUBuffer,
    skinWeights: GPUBuffer,
  ): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this._lightUniforms.buffer, size: LIGHT_UNIFORM_BYTES } },
        { binding: 1, resource: { buffer: this._environmentBuffer } },
        { binding: 2, resource: this._environmentState.diffuseTexture.createView({ dimension: 'cube' }) },
        { binding: 3, resource: this._environmentState.specularTexture.createView({ dimension: 'cube' }) },
        { binding: 4, resource: this._environmentSampler },
        { binding: 5, resource: { buffer: this._directionalShadowBinding.buffer } },
        { binding: 6, resource: this._directionalShadowBinding.view },
        { binding: 7, resource: this._directionalShadowBinding.sampler },
        { binding: 8, resource: { buffer: skinMatrices } },
        { binding: 9, resource: { buffer: skinJoints } },
        { binding: 10, resource: { buffer: skinWeights } },
        { binding: 11, resource: this._transmissionFramebufferView },
      ];
    return this._sceneGroups.create(this._engine.device, this._sceneLayout, entries);
  }

  private _sceneGroup(deformation: PbrDeformationGpuData): GPUBindGroup {
    const base = this._deformationCache.getSceneBindGroup(deformation);
    return this._sceneGroups.resolve(base, this._deferredSurface ? null : this._fullLighting);
  }

  private _getPipeline(geometry: Geometry3D, material: PbrMaterial): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = material.doubleSided ? 'none' : geometry.cullMode ?? 'back';
    const frontFace = geometry.frontFace ?? 'ccw';
    const stripIndexFormat = getStripIndexFormat(geometry);
    const alphaFlag = material.alphaMode === 'blend' ? 2 : material.alphaMode === 'mask' ? 1 : 0;
    const clearcoatEnabled = material.clearcoatFactor > 0;
    const transmissionEnabled = material.transmissionFactor > 0;
    const primitiveKey = encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, this.msaaSamples, alphaFlag);
    const key = this._rendererCore.pipelineKey(
      `${primitiveKey}|uv:${geometry.textureCoordinateLayoutKey}|cc:${clearcoatEnabled ? 1 : 0}|tr:${transmissionEnabled ? 1 : 0}`,
      this._deferredSurface?.key ?? this._fullLighting?.shader(clearcoatEnabled, transmissionEnabled).key ?? this._shaderKey(clearcoatEnabled, transmissionEnabled),
    );
    return this.getCachedPipeline(key, () => this._engine.device.createRenderPipeline(
      this._pipelineDescriptor(topology, cullMode, frontFace, material.alphaMode, clearcoatEnabled, stripIndexFormat, transmissionEnabled),
    ));
  }

  private _pipelineDescriptor(
    topology: GPUPrimitiveTopology,
    cullMode: GPUCullMode,
    frontFace: GPUFrontFace,
    alphaMode: PbrAlphaMode,
    clearcoatEnabled: boolean,
    stripIndexFormat?: GPUIndexFormat,
    transmissionEnabled = false,
  ): GPURenderPipelineDescriptor {
    const full = this._deferredSurface ? null : this._fullLighting?.shader(clearcoatEnabled, transmissionEnabled);
    return {
      layout: full?.pipelineLayout ?? this._pipelineLayout,
      vertex: {
        module: this._deferredSurface?.module ?? full?.module ?? (transmissionEnabled
          ? (clearcoatEnabled ? this._transmissionClearcoatShader : this._transmissionShader)
          : (clearcoatEnabled ? this._clearcoatShader : this._baseShader)),
        entryPoint: 'vs_main',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
          { arrayStride: 24, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x2' }, { shaderLocation: 12, offset: 8, format: 'float32x4' }] },
          ...Array.from({ length: 4 }, (_, index): GPUVertexBufferLayout => ({
            arrayStride: 24,
            attributes: [
              { shaderLocation: index * 2 + 4, offset: 0, format: 'float32x3' },
              { shaderLocation: index * 2 + 5, offset: 12, format: 'float32x3' },
            ],
          })),
        ],
      },
      fragment: {
        module: this._deferredSurface?.module ?? full?.module ?? (transmissionEnabled
          ? (clearcoatEnabled ? this._transmissionClearcoatShader : this._transmissionShader)
          : (clearcoatEnabled ? this._clearcoatShader : this._baseShader)),
        entryPoint: 'fs_main',
        targets: this._deferredSurface ? [0, 1, 2].map(() => ({ format: 'rgba16float' as const })) : [createColorTargetState(this.colorFormat ?? this._engine.format, alphaMode === 'blend' ? {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        } : undefined)],
      },
      primitive: createPrimitiveState(topology, cullMode, frontFace, stripIndexFormat),
      depthStencil: {
        format: this._deferredSurface ? 'depth32float' : this._engine.getDepthFormat(this.reverseZ),
        depthWriteEnabled: alphaMode !== 'blend',
        depthCompare: this.reverseZ ? 'greater-equal' : 'less-equal',
      },
      multisample: { count: this.msaaSamples },
    };
  }

  private _shaderKey(clearcoatEnabled: boolean, transmissionEnabled: boolean): string {
    if (transmissionEnabled) {
      return clearcoatEnabled ? this._transmissionClearcoatShaderKey : this._transmissionShaderKey;
    }
    return clearcoatEnabled ? this._clearcoatShaderKey : this._baseShaderKey;
  }

  private _createSolidTexture(color: readonly [number, number, number, number]): GPUTexture {
    const texture = this._engine.device.createTexture({
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._engine.device.queue.writeTexture({ texture }, new Uint8Array(color), { bytesPerRow: 4 }, [1, 1, 1]);
    return texture;
  }

  private _createSolidCube(color: readonly [number, number, number, number]): GPUTexture {
    const texture = this._engine.device.createTexture({
      size: [1, 1, 6],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    for (let layer = 0; layer < 6; layer++) {
      this._engine.device.queue.writeTexture({ texture, origin: [0, 0, layer] }, new Uint8Array(color), { bytesPerRow: 4 }, [1, 1, 1]);
    }
    return texture;
  }

  destroy(): void {
    deletePbrDeferredSurfacePort(this);
    this._deferredSurface = null;
    this._fullLighting = null;
    this._sceneFrameBinding?.destroy();
    this._lightUniforms?.destroy();
    this._lights = [];
    this._rendererCore?.destroy();
    this._deformationCache?.destroy();
    this._directionalShadowBinding?.destroy();
    this._materialResources?.destroy();
    this.recordedOwner?.retireAll();
    this.clearPipelineCache();
    this._sceneLightingRevision = -1;
    this._sceneShadowRevision = -1;
    this._sceneBindingRevision = 0;
    this._initialized = false;
  }
}
