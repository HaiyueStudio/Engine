import { System } from '../ecs/System';
import { Entity } from '../ecs/Entity';
import { World } from '../ecs/World';
import type { IEngine } from '../core/IEngine';
import { getEngineFrameDiagnostics } from '../core/EngineDiagnosticsAccess';
import { Mesh3D } from '../components/Mesh3D';
import { Transform3D } from '../components/Transform3D';
import { Camera3D } from '../components/Camera3D';
import { PbrMaterial } from '../material/PbrMaterial';
import type { Material } from '../material/Material';
import { Mesh3DRenderer } from '../renderer/Mesh3DRenderer';
import type { PostProcessPass } from '../postprocess/PostProcessPass';
import { Frustum } from '../culling/Frustum';
import type { BoundingSphere } from '../culling/Frustum';
import type { Geometry3D } from '../geometry/Geometry3D';
import { MeshHelper } from '../components/MeshHelper';
import { mat4 } from 'wgpu-matrix';
import type { ViewportRect, ScissorRect } from '../core/ViewportRect';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { beginRenderCommandPass } from '../core/RenderCommandContext';
import type { RenderCommandContext, RenderFrameContext } from '../core/RenderCommandContext';
import { MaterialRendererRegistry } from '../renderer/MaterialRendererRegistry';
import type { InternalMaterialRenderContext, MaterialGpuDrivenBatch, MaterialRendererKey, MaterialRendererRegistration } from '../renderer/MaterialRendererRegistry';
import type { RenderPipelineEntryOptions } from '../renderer/RenderPipeline';
import type { GpuDrivenBatchBuffer } from '../renderer/GpuDrivenBatchBuffer';
import { Render3DPostScenePasses } from './Render3DPostScenePasses';
import {
  Render3DSceneCollector,
  type Render3DViewCollectionOptions,
  type Render3DWorldExtractionOptions,
} from './Render3DSceneCollector';
import { fillMaterialRenderContext, Render3DSubmitter, type Render3DSubmitterOptions } from './Render3DSubmitter';
import { Render3DScenePassRenderer } from './Render3DScenePassRenderer';
import { Render3DFramePlan, type Render3DFramePassSnapshot } from './Render3DFramePlan';
import { DEFAULT_RENDER_PROFILE, resolveRenderProfileSettings, type RenderProfileName, type RenderProfileSettings } from '../core/RenderProfile';
import type { DirectionalShadowState } from '../renderer/ShadowMapRenderer';
import { Render3DBoundsCache } from './Render3DBoundsCache';
import { getSceneRenderEnvironment, type SceneRenderEnvironment } from '../frame/SceneRenderEnvironment';
import { getSceneFrameUniformSnapshot, type SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { RenderView, getRenderViewPassOptions, type RenderViewSnapshot } from '../core/RenderView';
import type { Render3DOpaqueSceneSortKey, WorldFrameState } from './Render3DFrameState';
import type { Render3DOpaqueSortMode } from './Render3DOpaqueSorter';
import { cloneRenderPassDescriptor } from '../core/renderPassDescriptor';
import { PlanarMirrorManager } from './PlanarMirrorManager';
import type { PlanarMirrorGpuResourceStats } from './PlanarMirrorManager';
import type { MirrorViewPlannerStats } from './MirrorViewPlanner';
import type { RenderGraphStats } from '../core/RenderGraph';
import type { TransientRenderTargetPoolStats } from '../rtt/TransientRenderTargetPool';
import { getSceneFrameGpuArena } from '../renderer/SceneFrameGpuArena';
import type { FrameData } from '../frame/FrameData';
import type { Camera3DFrameData } from '../frame/FrameData';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { Render3DMaterialContextScratch } from './Render3DMaterialContextScratch';
import type {
  Render3DHelperItem,
  Render3DRenderItem,
  Render3DSystemOptions,
  TransparentMaterialInfo,
} from './Render3DContracts';
import { Render3DLiveCache } from './Render3DLiveCache';
import { registerDefaultMaterialRenderers } from './Render3DDefaultRendererRegistry';
import { Render3DSpatialCandidateResolver } from './Render3DSpatialCandidateResolver';
import { Render3DDirectionalShadowOrchestrator } from './Render3DDirectionalShadowOrchestrator';
import {
  Render3DFrameCoordinator,
  type Render3DSceneGlobalExecutionState,
  type Render3DViewExecutionState,
} from './Render3DFrameCoordinator';
import { Render3DFrameTelemetry } from './Render3DFrameTelemetry';
import { Render3DRendererSuite } from './Render3DRendererSuite';
import { Render3DViewPreparation } from './Render3DViewPreparation';
import {
  installRender3DMeshRenderer,
  readRender3DGpuDrivenBatchBuffer,
  readRender3DGpuDrivenBatchIndexForEntity,
  readRender3DGpuDrivenMaterialSlot,
} from './Render3DSystemAccess';
export type {
  DefaultMaterialRendererOptions,
  Render3DSystemOptions,
} from './Render3DContracts';
const DEFAULT_SPATIAL_CULLING_THRESHOLD = 512;
const DEFAULT_SPATIAL_LEAF_SIZE = 8;
const EMPTY_FRAME_PLAN_SNAPSHOT: readonly Render3DFramePassSnapshot[] = Object.freeze([]);
const EMPTY_POST_PROCESS_PASSES: PostProcessPass[] = [];
type Render3DPlannedView = {
  cameraEntity: Entity; camera: Camera3D; cameraFrame: Camera3DFrameData;
  postProcessPasses: PostProcessPass[]; sceneFrameUniforms: SceneFrameUniformSnapshot;
};
const framePlanSnapshots = new WeakMap<Render3DSystem, readonly Render3DFramePassSnapshot[]>();
/** Experimental diagnostics accessor. Import from `@haiyue/engine/experimental`. */
export function getRender3DFramePlanSnapshot(system: Render3DSystem): readonly Render3DFramePassSnapshot[] {
  return framePlanSnapshots.get(system) ?? EMPTY_FRAME_PLAN_SNAPSHOT;
}
const EMPTY_ENTITY_SET: ReadonlySet<Entity> = new Set<Entity>();
export class Render3DSystem extends System {
  private engine: IEngine;
  private cameraEntity: Entity;
  private readonly _fallbackView: RenderView;
  private readonly _renderers: Render3DRendererSuite;
  /** @internal Legacy diagnostic seams retained for repository tests and benchmark instrumentation. */
  private get mesh3DRenderer(): Mesh3DRenderer | null { return this._renderers.basic; }
  private get _depthRenderer() { return this._renderers.depth; }
  private get _normalRenderer() { return this._renderers.normal; }
  private get _volumeRenderer() { return this._renderers.volume; }
  private get _planarMirrorRenderer() { return this._renderers.planarMirror; }
  private get _pbrRenderer() { return this._renderers.pbr; }
  private get _shadowRenderer() { return this._renderers.shadow; }

  private _reverseZ: boolean;
  private _msaaSamples: 1 | 4;
  viewport: ViewportRect | null;
  scissor: ScissorRect | null;
  loadOp: 'clear' | 'load';
  transparentSort: boolean;
  private _renderProfile: RenderProfileName;
  private _renderSettings: RenderProfileSettings;
  private readonly _spatialCandidates: Render3DSpatialCandidateResolver;
  requiresIsolatedPass = false;

  /** Current view frustum — updated every frame regardless of the selected profile.
   *  Can be read externally for debug visualisation. */
  readonly frustum: Frustum = new Frustum();

  get renderPipelineOptions(): RenderPipelineEntryOptions {
    return { pass: (this.requiresIsolatedPass || this.passes.length > 0) ? 'isolated' : 'shared', loadOp: this.loadOp, sort: this.priority };
  }

  get renderProfile(): RenderProfileName { return this._renderProfile; }
  get renderSettings(): RenderProfileSettings { return this._renderSettings; }

  setRenderProfile(profile: RenderProfileName): this {
    if (profile === this._renderProfile) return this;
    this._renderProfile = profile;
    this._renderSettings = this.engine.capabilities?.profile.name === profile
      ? this.engine.capabilities.settings
      : resolveRenderProfileSettings(profile, this.engine.device?.features);
    return this;
  }

  /** Number of entities rendered in the last frame. */
  lastVisibleCount!: number;
  /** Total number of entities evaluated in the last frame. */
  lastTotalCount!: number;
  /** Number of RenderViews consumed in the last record. */
  lastViewCount!: number;
  /** Stable diagnostics for the most recent planar-reflection plan. */
  get lastMirrorPlanStats(): MirrorViewPlannerStats { return this._planarMirrorManager.stats; }
  /** Explicit scene/view/reflection dependency graph compiled for the last frame. */
  get lastRenderGraphStats(): RenderGraphStats { return this._planarMirrorManager.graphStats; }
  /** Physical/logical reflection target memory and aliasing diagnostics. */
  get lastMirrorTargetPoolStats(): TransientRenderTargetPoolStats {
    return this._planarMirrorManager.transientTargetStats;
  }
  /** Logical mirror/depth scopes, persistent ownership, and total resident memory. */
  get lastMirrorGpuResourceStats(): PlanarMirrorGpuResourceStats {
    return this._planarMirrorManager.gpuResourceStats;
  }
  /** Whether the last frame used the shared mesh SpatialIndex broad phase. */
  lastSpatialIndexUsed!: boolean;
  /** Total camera-view and directional-shadow BVH queries issued by the last frame. */
  lastSpatialQueryCount!: number;
  /** Number of directional-shadow BVH queries issued by the last frame. */
  lastSpatialShadowQueryCount!: number;
  /** Unique broad-phase candidates shared by all views in the last frame. */
  lastSpatialCandidateCount!: number;
  /** Directional-shadow GPU passes encoded by the last frame (zero on cache hit). */
  lastDirectionalShadowPassCount!: number;
  /** Camera-independent shadow casters collected for the last frame. */
  lastDirectionalShadowCasterCount!: number;
  /** Whether the last frame reused the prior scene-global directional shadow map. */
  lastDirectionalShadowCacheHit!: boolean;
  /** Cumulative camera-independent scene extractions, useful for churn diagnostics. */
  get sceneExtractionCount(): number { return this._sceneCollector.extractionCount; }
  /** Number of visible mesh batches uploaded to the GPU-driven batch buffer in the last frame. */
  lastGpuDrivenBatchCount!: number;
  /** Number of unique materials referenced by the current GPU-driven Render3D batch table. */
  lastGpuDrivenMaterialCount!: number;
  /** Scene-global GPU command/table builds performed by the last logical frame. */
  lastGpuDrivenGlobalCommandBuilds!: number;
  /** Dirty scene-global command slots refreshed by the last logical frame. */
  lastGpuDrivenGlobalCommandUpdates!: number;
  /** Deterministic command DTO pool misses in the last logical frame. */
  lastGpuDrivenCommandObjectsCreated!: number;
  /** Material-to-renderer resolutions performed outside persistent caches in the last frame. */
  lastGpuDrivenMaterialRendererResolutions!: number;
  /** Opaque sorting path selected for the most recently recorded view. */
  lastOpaqueSortMode!: Render3DOpaqueSortMode;
  /** Opaque item count seen by the most recent view sorter. */
  lastOpaqueSortCount!: number;

  get reverseZ(): boolean {
    return this._reverseZ;
  }

  set reverseZ(value: boolean) {
    if (this._reverseZ === value) return;
    this._reverseZ = value;
  }

  get msaaSamples(): 1 | 4 {
    return this._msaaSamples;
  }

  set msaaSamples(value: 1 | 4) {
    if (this._msaaSamples === value) return;
    this._msaaSamples = value;
  }

  /**
   * Ordered list of post-processing passes applied after the 3-D scene renders.
   * Push/pop passes at any time — changes take effect on the next frame.
   */
  passes: PostProcessPass[] = [];

  /** Allows hosts to disable planar-reflection planning when the optional renderer is unavailable. */
  planarMirrorsEnabled = true;

  private _postScenePasses: Render3DPostScenePasses;
  materialRenderers: MaterialRendererRegistry;
  private readonly _materialContextScratch = new Render3DMaterialContextScratch(
    batchIndex => this._getGpuDrivenMaterialBatch(batchIndex),
  );
  private get _materialRenderContext(): InternalMaterialRenderContext {
    return this._materialContextScratch.context;
  }
  private _recording = false;
  private readonly _telemetry = new Render3DFrameTelemetry();
  private readonly _boundsCache = new Render3DBoundsCache();
  private readonly _viewPreparation: Render3DViewPreparation;
  private get _frameItems() { return this._viewPreparation.frameItems; }
  private get _opaqueItems(): Render3DRenderItem[] { return this._viewPreparation.frameItems.opaqueItems; }
  private get _transparentItems(): Render3DRenderItem[] { return this._viewPreparation.frameItems.transparentItems; }
  private get _helperItems(): Render3DHelperItem[] { return this._viewPreparation.frameItems.helperItems; }
  private get _outlineItems(): Render3DRenderItem[] { return this._viewPreparation.frameItems.outlineItems; }
  private get _transparentViews() { return this._viewPreparation.transparentViews; }
  private get _gpuDrivenBatches() { return this._viewPreparation.gpuDrivenBatches; }
  private _scenePassRenderer: Render3DScenePassRenderer;
  private readonly _frameCoordinator: Render3DFrameCoordinator;
  private get _framePlan(): Render3DFramePlan { return this._frameCoordinator.viewPlan; }
  private get _frameExecution(): Render3DViewExecutionState {
    return this._frameCoordinator.viewState;
  }
  private get _sceneGlobalExecution(): Render3DSceneGlobalExecutionState {
    return this._frameCoordinator.sceneGlobalState;
  }
  private readonly _sceneCollector = new Render3DSceneCollector();
  private readonly _planarMirrorManager: PlanarMirrorManager;
  private readonly _submitter = new Render3DSubmitter();
  private readonly _submitterOptions: Render3DSubmitterOptions = {
    gpuDrivenBatches: false,
    megaBatchRuns: [],
    batchBuffer: null,
    resolveMaterialRenderer: material => this.materialRenderers.resolve(material),
    getGpuDrivenBatch: batchIndex => this._getGpuDrivenMaterialBatch(batchIndex),
    setMaterialRenderContext: (passEncoder, entityId, geometry, material, clippingPlanes, worldMatrix, viewProj, viewMatrix, gpuDrivenBatch) =>
      fillMaterialRenderContext(this._materialRenderContext, passEncoder, entityId, geometry, material, clippingPlanes, worldMatrix, viewProj, viewMatrix, gpuDrivenBatch),
  };
  private readonly _disabledHierarchyCache: EntityHierarchyDisabledCache = new Map();
  private readonly _worldMatrixCache = new Map<Entity, Transform3D | null>();
  private readonly _transparentRendererIds = new WeakMap<MaterialRendererRegistration, number>();
  private readonly _viewMatrix = mat4.identity() as Float32Array;
  private readonly _viewProjMatrix = mat4.identity() as Float32Array;
  private readonly _liveCaches = new Render3DLiveCache();
  private _nextTransparentRendererId = 1;
  private readonly _liveBasicEntities = this._liveCaches.basicEntities;
  private readonly _liveBasicGeometries = this._liveCaches.basicGeometries;
  private readonly _liveBasicMaterials = this._liveCaches.basicMaterials;
  private readonly _liveBlinnPhongEntities = this._liveCaches.blinnPhongEntities;
  private readonly _liveBlinnPhongGeometries = this._liveCaches.blinnPhongGeometries;
  private readonly _liveBlinnPhongMaterials = this._liveCaches.blinnPhongMaterials;
  private readonly _liveDepthEntities = this._liveCaches.depthEntities;
  private readonly _liveDepthGeometries = this._liveCaches.depthGeometries;
  private readonly _liveDepthMaterials = this._liveCaches.depthMaterials;
  private readonly _liveNormalEntities = this._liveCaches.normalEntities;
  private readonly _liveNormalGeometries = this._liveCaches.normalGeometries;
  private readonly _liveNormalMaterials = this._liveCaches.normalMaterials;
  private readonly _liveHelperEntities = this._liveCaches.helperEntities;
  private readonly _liveHelperGeometries = this._liveCaches.helperGeometries;
  private readonly _liveOutlineEntities = this._liveCaches.outlineEntities;
  private readonly _liveOutlineGeometries = this._liveCaches.outlineGeometries;
  private readonly _liveMotionGeometries = this._liveCaches.motionGeometries;
  private readonly _liveVolumeEntities = this._liveCaches.volumeEntities;
  private readonly _liveVolumeGeometries = this._liveCaches.volumeGeometries;
  private readonly _liveVolumeMaterials = this._liveCaches.volumeMaterials;
  private readonly _livePbrEntities = this._liveCaches.pbrEntities;
  private readonly _livePbrGeometries = this._liveCaches.pbrGeometries;
  private readonly _livePbrMaterials = this._liveCaches.pbrMaterials;
  private get _liveFrame(): number { return this._liveCaches.frame; }
  private readonly _worldExtractionOptions: Render3DWorldExtractionOptions;
  private readonly _viewCollectionOptions: Render3DViewCollectionOptions;
  private readonly _pbrSceneLightingContext = {
    lightingRevision: 0,
    shadowRevision: 0,
    lights: [] as readonly import('../frame/SceneRenderEnvironment').PbrLightInfo[],
    environment: null as import('../lighting/EnvironmentLight').EnvironmentLight | null,
    shadow: null as DirectionalShadowState | null,
    shadows: [] as readonly (DirectionalShadowState | null)[],
  };
  private readonly _projectionJitter = new Float32Array(2);
  private readonly _postProcessFrameContext = {
    viewKey: '',
    frameId: 0,
    cameraId: 0,
    width: 1,
    height: 1,
    reverseZ: false,
    near: 0.1,
    far: 1000,
    isOrthographic: false,
    projectionJitter: new Float32Array(2),
    projectionMatrix: mat4.identity() as Float32Array,
    viewProjectionMatrix: mat4.identity() as Float32Array,
    inverseViewProjectionMatrix: mat4.identity() as Float32Array,
  };
  private readonly _directionalShadows: Render3DDirectionalShadowOrchestrator;
  private readonly _transparentMaterialInfoScratch: TransparentMaterialInfo = {
    transparent: false,
    order: 0,
    depthSort: false,
    rendererKey: 0,
  };
  private readonly _getWorldBoundingSphereCallback = (
    geometry: Geometry3D,
    worldMatrix: Float32Array,
    target?: BoundingSphere & { center: [number, number, number] },
  ) => this._getWorldBoundingSphere(geometry, worldMatrix, target);
  private readonly _containsSphereCallback = (sphere: BoundingSphere) => this.frustum.containsSphere(sphere);
  private readonly _receivesDirectionalShadowCallback = (material: Material) =>
    this.materialRenderers.receivesDirectionalShadow(material);
  private readonly _resolveShadowCullMode = (material: Material) => this.materialRenderers.resolveShadowCullMode(material);
  private readonly _getTransparentMaterialInfoCallback = (material: Material) => this._getTransparentMaterialInfo(material);
  private readonly _nextRenderItemCallback = (
    entityId: number,
    mesh: Mesh3D,
    geometry: Geometry3D,
    material: Material,
    clippingPlanes: Render3DRenderItem['clippingPlanes'],
    worldMatrix: Float32Array,
    viewDepth: number,
    transparentOrder: number,
    transparentDepthSort: boolean,
    worldSphere: BoundingSphere | null,
    lodLevel: number,
    opaqueSortKey: Render3DOpaqueSceneSortKey | null,
  ) => this._frameItems.nextRenderItem(
    entityId,
    mesh,
    geometry,
    material,
    clippingPlanes,
    worldMatrix,
    viewDepth,
    transparentOrder,
    transparentDepthSort,
    worldSphere,
    lodLevel,
    opaqueSortKey,
  );
  private readonly _nextHelperItemCallback = (
    entityId: number,
    geometry: Geometry3D,
    helper: MeshHelper,
    worldMatrix: Float32Array,
  ) => this._frameItems.nextHelperItem(entityId, geometry, helper, worldMatrix);
  private readonly _resolveMaterialRegistration = (material: Material) => this.materialRenderers.resolve(material);
  private readonly _resolveRendererSlot = (registration: MaterialRendererRegistration) => this._getRendererSlot(registration);
  private readonly _getOpaqueSceneSortKey = (entityId: number, lodLevel: number) =>
    this._gpuDrivenBatches.getOpaqueSceneSortKey(entityId, lodLevel);
  readonly recoveryLabel: string;
  readonly recoverySource: { kind: 'render-system'; system: 'Render3DSystem' };
  private readonly _unregisterRecovery: (() => void) | null;

  constructor(
    engine: IEngine,
    cameraEntity: Entity,
    options: Render3DSystemOptions = {},
  ) {
    super({ all: [Mesh3D] });
    this._telemetry.bind(this);
    this.engine       = engine;
    this.cameraEntity = cameraEntity;
    this._renderers = new Render3DRendererSuite(engine);
    this._worldExtractionOptions = {
      frameData: null as unknown as import('../frame/FrameData').FrameData,
      disabledHierarchyCache: this._disabledHierarchyCache,
      worldMatrixCache: this._worldMatrixCache,
      getWorldBoundingSphere: this._getWorldBoundingSphereCallback,
    };
    this._fallbackView = new RenderView({
      key: `render3d:${this.id}:default`,
      camera: cameraEntity,
      target: engine.renderTarget ?? engine as unknown as import('../core/RenderView').RenderViewTarget,
      clearColor: options.clearColor ?? engine.clearColor,
      depthConvention: (options.reverseZ ?? engine.reverseZ) ? 'reverse' : 'standard',
      sampleCount: options.msaaSamples ?? engine.msaaSamples,
      viewport: options.viewport ?? null,
      scissor: options.scissor ?? null,
      loadOp: options.loadOp ?? 'clear',
    });
    this._postScenePasses = new Render3DPostScenePasses(engine);
    this._reverseZ    = options.reverseZ    ?? engine.reverseZ;
    this._msaaSamples = options.msaaSamples ?? engine.msaaSamples;
    this.viewport     = options.viewport    ?? null;
    this.scissor      = options.scissor     ?? null;
    this.loadOp       = options.loadOp      ?? 'clear';
    this._renderProfile = options.renderProfile ?? engine.renderProfile ?? DEFAULT_RENDER_PROFILE;
    this._renderSettings = engine.capabilities?.profile.name === this._renderProfile
      ? engine.capabilities.settings
      : resolveRenderProfileSettings(this._renderProfile, engine.device?.features);
    const spatialCullingThreshold = normalizeNonNegativeInteger(
      options.spatialCullingThreshold,
      DEFAULT_SPATIAL_CULLING_THRESHOLD,
    );
    const spatialLeafSize = Math.max(
      1,
      normalizeNonNegativeInteger(options.spatialLeafSize, DEFAULT_SPATIAL_LEAF_SIZE),
    );
    this._spatialCandidates = new Render3DSpatialCandidateResolver(
      spatialCullingThreshold,
      spatialLeafSize,
    );
    this.transparentSort = options.transparentSort ?? true;
    this.materialRenderers = options.materialRenderers ?? new MaterialRendererRegistry();
    this._viewPreparation = new Render3DViewPreparation(this.engine);
    this._viewCollectionOptions = {
      view: null as unknown as RenderViewSnapshot,
      cameraPosition: null as unknown as Float32Array,
      frustumCull: false,
      gpuDrivenCulling: false,
      transparentSort: false,
      viewMatrix: this._viewMatrix,
      opaqueItems: this._opaqueItems,
      transparentItems: this._transparentItems,
      helperItems: this._helperItems,
      outlineItems: this._outlineItems,
      transparentBatch: this._transparentViews.batch,
      containsSphere: this._containsSphereCallback,
      getTransparentMaterialInfo: this._getTransparentMaterialInfoCallback,
      getOpaqueSceneSortKey: this._getOpaqueSceneSortKey,
      getWorldBoundingSphere: this._getWorldBoundingSphereCallback,
      nextRenderItem: this._nextRenderItemCallback,
      nextHelperItem: this._nextHelperItemCallback,
    };
    this._directionalShadows = new Render3DDirectionalShadowOrchestrator({
      collector: this._sceneCollector,
      collection: {
        receivesDirectionalShadow: this._receivesDirectionalShadowCallback,
        getTransparentMaterialInfo: this._getTransparentMaterialInfoCallback,
        getWorldBoundingSphere: this._getWorldBoundingSphereCallback,
        nextRenderItem: this._nextRenderItemCallback,
      },
      getRenderer: () => this._requireShadowRenderer(),
      resolveShadowCullMode: this._resolveShadowCullMode,
    });
    this._scenePassRenderer = new Render3DScenePassRenderer(this.engine);
    this._frameCoordinator = new Render3DFrameCoordinator({
      collectView: this._collectViewPass,
      sortRenderItems: this._sortRenderItemsPass,
      prepareGpuDrivenBatches: this._prepareGpuDrivenBatchesPass,
      sortTransparentOnGpu: this._sortTransparentOnGpuPass,
      preparePbrLighting: this._preparePbrLightingPass,
      renderScene: this._renderScenePassPass,
      renderPostScene: this._renderPostScenePassesPass,
      renderDirectionalShadow: this._renderDirectionalShadowPass,
    });
    this._planarMirrorManager = new PlanarMirrorManager(this.engine, options.planarMirrorPlanner);
    registerDefaultMaterialRenderers(this.materialRenderers, {
      basic: () => this._requireBasicRenderer(),
      blinnPhong: () => this._requireBlinnPhongRenderer(),
      pbr: () => this._requirePbrRenderer(),
      depth: () => this._requireDepthRenderer(),
      normal: () => this._requireNormalRenderer(),
      volume: () => this._requireVolumeRenderer(),
      planarMirror: () => this._requirePlanarMirrorRenderer(),
      destroyPlanarMirror: () => this._renderers.destroyPlanarMirror(),
      live: this._liveCaches,
    }, options.registerDefaultMaterialRenderers);
    this.requiresIsolatedPass = true;
    this.name         = 'Render3DSystem';
    this.recoveryLabel = `${this.name}:${this.id}`;
    this.recoverySource = { kind: 'render-system', system: 'Render3DSystem' };
    this._unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this) ?? null;
    framePlanSnapshots.set(this, this._framePlan.snapshot);
    if (options.priority !== undefined) this.priority = options.priority;
  }

  registerMaterialRenderer<M extends Material>(registration: MaterialRendererRegistration<M>): this {
    this.materialRenderers.register(registration);
    return this;
  }

  unregisterMaterialRenderer(materialType: MaterialRendererKey): this {
    this.materialRenderers.unregister(materialType);
    return this;
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    this._renderers.contributePipelineWarmup(plan, this.reverseZ, this.msaaSamples);

    this._scenePassRenderer.contributePipelineWarmup(plan, this.reverseZ, this.msaaSamples);
    this._postScenePasses.contributePipelineWarmup(plan, this.passes, this.reverseZ, this.msaaSamples);
  }

  private get gpuDrivenBatchBuffer(): GpuDrivenBatchBuffer | null {
    return this._gpuDrivenBatches.batchBuffer;
  }

  private getGpuDrivenBatchIndexForEntity(entityId: number): number | undefined {
    return this._gpuDrivenBatches.getBatchIndexForEntity(entityId);
  }

  private getGpuDrivenMaterialSlot(materialId: number): number | undefined {
    return this._gpuDrivenBatches.getMaterialSlot(materialId);
  }

  public setCameraEntity(cameraEntity: Entity): this {
    this.cameraEntity = cameraEntity;
    this._fallbackView.camera = cameraEntity;
    return this;
  }

  private addRenderer(renderer: Mesh3DRenderer): this {
    this._renderers.setBasic(renderer);
    return this;
  }

  record(world: World, context: RenderCommandContext): this {
    if (this._recording) {
      throw new EngineError(
        EngineErrorCode.EngineInvalidState,
        'Render3DSystem.record() is not reentrant.',
        {
          path: 'Render3DSystem.record',
          hint: 'Queue nested rendering as another RenderView instead of calling record() recursively.',
        },
      );
    }
    this._recording = true;
    try {
      return this._record(world, context);
    } finally {
      this._materialContextScratch.reset();
      this._recording = false;
    }
  }

  private _record(world: World, context: RenderCommandContext): this {
    this._frameCoordinator.beginFrame();
    this._telemetry.beginFrame();
    if (this.disabled) return this;

    const { device } = context;
    if (!device) return this;

    this._renderers.requireBasic();
    this._beginLiveCacheFrame();
    this._sceneCollector.beginFrame(this._liveFrame);
    this._worldMatrixCache.clear();

    this._fallbackView.camera = this.cameraEntity;
    this._fallbackView.viewport = this.viewport;
    this._fallbackView.scissor = this.scissor;
    this._fallbackView.reverseZ = this.reverseZ;
    this._fallbackView.sampleCount = this.msaaSamples;
    this._fallbackView.loadOp = this.loadOp;
    const views = context.viewFamily?.views.length
      ? context.viewFamily.views
      : [context.view ?? this._fallbackView.snapshot()];
    const frameData = context.frameData ?? world.frameData;
    const sceneEnvironment = getSceneRenderEnvironment(frameData, world);
    const sceneFrameArena = typeof GPUShaderStage !== 'undefined'
      && typeof GPUBufferUsage !== 'undefined'
      && typeof device.createBindGroupLayout === 'function'
      && typeof device.createBuffer === 'function'
      && typeof device.createBindGroup === 'function'
      ? getSceneFrameGpuArena(device)
      : null;
    const renderViews = this._planarMirrorManager.prepare(
      world,
      frameData,
      views,
      sceneFrameArena ? {
        maxViews: Math.max(0, sceneFrameArena.growableViews - views.length),
      } : undefined,
      this.planarMirrorsEnabled,
    );
    this.lastViewCount = renderViews.length;
    const entities = this.entitySet.get(world) ?? EMPTY_ENTITY_SET;
    const plannedViews = new Map<string, Render3DPlannedView>();
    const plannedSceneFrames: SceneFrameUniformSnapshot[] = [];
    for (const renderView of renderViews) {
      const camera = renderView.camera.getComponent(Camera3D);
      if (!camera) continue;
      const postProcessPasses = renderView.postProcessEnabled ? this.passes : EMPTY_POST_PROCESS_PASSES;
      const projectionJitter = this._postScenePasses.resolveProjectionJitter(postProcessPasses, {
        viewKey: renderView.key,
        frameId: frameData.frameId,
        width: renderView.width,
        height: renderView.height,
      }, this._projectionJitter);
      const cameraFrame = frameData.getCamera3D(renderView.camera, camera, {
        width: renderView.width,
        height: renderView.height,
        reverseZ: renderView.reverseZ,
        projectionJitter,
      });
      const sceneFrameUniforms = getSceneFrameUniformSnapshot(cameraFrame, sceneEnvironment.fog);
      plannedViews.set(renderView.key, {
        cameraEntity: renderView.camera,
        camera,
        cameraFrame,
        postProcessPasses,
        sceneFrameUniforms,
      });
      plannedSceneFrames.push(sceneFrameUniforms);
    }
    sceneFrameArena?.ensureCapacityForSnapshots(plannedSceneFrames, context);
    const extractionEntities = this._resolveExtractionEntities(
      world,
      frameData,
      renderViews,
      entities,
      sceneEnvironment.shadowLights,
    );
    this._worldExtractionOptions.frameData = frameData;
    const extractionDiagnostics = getEngineFrameDiagnostics(this.engine);
    const extractionStartedAt = extractionDiagnostics?.startMeasure() ?? 0;
    const worldFrameState = this._sceneCollector.extract(world, extractionEntities, this._worldExtractionOptions);
    extractionDiagnostics?.finishMeasure('collect', extractionStartedAt);
    this._frameCoordinator.setSceneGlobalState(
      context,
      frameData,
      worldFrameState,
      sceneEnvironment,
    );
    const pbrSceneLighting = this._pbrSceneLightingContext;
    const previousView = context.view;
    const previousDescriptor = context.descriptor;
    const previousLoadOp = context.loadOp;
    this._viewPreparation.beginFrame(renderViews.length, context);
    this.lastVisibleCount = 0;
    this.lastTotalCount = worldFrameState.totalCount;
    let viewIndex = 0;
    for (const graphPass of this._planarMirrorManager.compiledExecutionPasses) {
      (context as Partial<RenderFrameContext>).endPass?.();
      if (graphPass.passClass === 'scene-global') {
        const hasShadowPass = this._directionalShadows.collect(
          frameData,
          worldFrameState,
          sceneEnvironment,
        );
        this._syncDirectionalShadowDiagnostics();
        this._frameCoordinator.executeSceneGlobal(hasShadowPass);
        const globalGpuStats = this._viewPreparation.prepareSceneGlobal(
          world,
          frameData,
          worldFrameState,
          this.renderSettings,
          this._resolveMaterialRegistration,
          this._resolveRendererSlot,
          this.materialRenderers.revision,
        );
        this.lastGpuDrivenGlobalCommandBuilds = globalGpuStats.globalCommandBuilds;
        this.lastGpuDrivenGlobalCommandUpdates = globalGpuStats.globalCommandUpdates;
        this.lastGpuDrivenCommandObjectsCreated = globalGpuStats.commandObjectsCreated;
        this.lastGpuDrivenMaterialRendererResolutions = globalGpuStats.materialRendererResolutions;
        pbrSceneLighting.lightingRevision = sceneEnvironment.lightingRevision;
        pbrSceneLighting.shadowRevision = this._directionalShadows.revision;
        pbrSceneLighting.lights = sceneEnvironment.pbrLights;
        pbrSceneLighting.environment = sceneEnvironment.environmentLight;
        pbrSceneLighting.shadow = this._directionalShadows.shadow;
        pbrSceneLighting.shadows = this._directionalShadows.shadows;
        continue;
      }
      const frameView = graphPass.view;
      if (!frameView) continue;
      context.view = frameView;
      context.loadOp = frameView.loadOp;
      context.descriptor = cloneRenderPassDescriptor(
        frameView.target.getRenderPassDescriptor(getRenderViewPassOptions(frameView)),
        frameView.loadOp,
      );
      this._recordView(
        world,
        context,
        frameView,
        worldFrameState,
        sceneEnvironment,
        viewIndex,
        plannedViews.get(frameView.key),
      );
      viewIndex++;
    }
    (context as Partial<RenderFrameContext>).endPass?.();
    context.view = previousView;
    context.descriptor = previousDescriptor;
    context.loadOp = previousLoadOp;
    this._sweepViewLocalCaches();
    this._releaseStaleRendererCaches(world);
    this._clearRenderItemReferences();
    return this;
  }

  /** Internal diagnostic seam retained for spatial-index contract tests. */
  private _resolveExtractionEntities(
    world: World,
    frameData: FrameData,
    views: readonly RenderViewSnapshot[],
    entities: ReadonlySet<Entity>,
    shadowLights: SceneRenderEnvironment['shadowLights'],
  ): ReadonlySet<Entity> {
    const result = this._spatialCandidates.resolve(
      world,
      frameData,
      views,
      entities,
      shadowLights,
      this.cameraEntity,
      this.renderSettings.frustumCulling,
    );
    const stats = this._spatialCandidates.stats;
    this.lastSpatialIndexUsed = stats.used;
    this.lastSpatialQueryCount = stats.queryCount;
    this.lastSpatialShadowQueryCount = stats.shadowQueryCount;
    this.lastSpatialCandidateCount = stats.candidateCount;
    return result;
  }

  private _recordView(
    world: World,
    context: RenderCommandContext,
    frameView: RenderViewSnapshot,
    worldFrameState: WorldFrameState,
    sceneEnvironment: SceneRenderEnvironment,
    uniformSlot: number,
    plannedView?: Render3DPlannedView,
  ): void {
    this._framePlan.clear();
    this._viewPreparation.selectView(uniformSlot, this._viewCollectionOptions);
    this._reverseZ = frameView.reverseZ;
    this._msaaSamples = frameView.sampleCount;
    const basicRenderer = this._renderers.requireBasic();
    basicRenderer.reverseZ = this.reverseZ;
    basicRenderer.msaaSamples = this.msaaSamples;
    const cameraEntity = plannedView?.cameraEntity
      ?? (frameView.camera.getComponent(Camera3D) ? frameView.camera : this.cameraEntity);
    const camera = plannedView?.camera ?? cameraEntity.getComponent(Camera3D);
    if (!camera) return;

    const vpW = frameView.width;
    const vpH = frameView.height;
    const frameData = context.frameData ?? world.frameData;
    const postProcessPasses = plannedView?.postProcessPasses
      ?? (frameView.postProcessEnabled ? this.passes : EMPTY_POST_PROCESS_PASSES);
    const cameraFrame = plannedView?.cameraFrame ?? (() => {
      const projectionJitter = this._postScenePasses.resolveProjectionJitter(postProcessPasses, {
        viewKey: frameView.key,
        frameId: frameData.frameId,
        width: vpW,
        height: vpH,
      }, this._projectionJitter);
      return frameData.getCamera3D(cameraEntity, camera, {
        width: vpW,
        height: vpH,
        reverseZ: this.reverseZ,
        projectionJitter,
      });
    })();
    const camWorldMatrix = cameraFrame.worldMatrix;
    this._viewMatrix.set(cameraFrame.viewMatrix);
    this._viewProjMatrix.set(cameraFrame.viewProjectionMatrix);
    const viewMatrix = this._viewMatrix;
    const viewProj = this._viewProjMatrix;

    // Always update the frustum so external code can read it for debugging
    this.frustum.setFromViewProjection(viewProj);

    // ── Post-process setup ─────────────────────────────────────────────────
    const postSceneRequirements = this._postScenePasses.prepare(postProcessPasses, context, this.reverseZ);

    const camX = camWorldMatrix[12] ?? 0;
    const camY = camWorldMatrix[13] ?? 0;
    const camZ = camWorldMatrix[14] ?? 0;
    const eyePosition = this._materialRenderContext.eyePosition;
    eyePosition[0] = camX;
    eyePosition[1] = camY;
    eyePosition[2] = camZ;

    const sceneFrameUniforms = plannedView?.sceneFrameUniforms
      ?? getSceneFrameUniformSnapshot(cameraFrame, sceneEnvironment.fog);
    this._materialRenderContext.sceneEnvironment = sceneEnvironment;
    this._materialRenderContext.sceneFrameUniforms = sceneFrameUniforms;
    this._materialRenderContext.directionalShadow = this._directionalShadows.shadow;
    this._materialRenderContext.directionalShadows = this._directionalShadows.shadows;
    this._materialRenderContext.commandContext = context;
    this._materialRenderContext.engine = this.engine;
    this._materialRenderContext.viewKey = frameView.key;
    this._materialRenderContext.viewProj = viewProj;
    this._materialRenderContext.viewMatrix = viewMatrix;
    this._materialRenderContext.viewSlot = uniformSlot;
    this._materialRenderContext.fog = sceneEnvironment.fog;
    this._materialRenderContext.reverseZ = this.reverseZ;
    this._materialRenderContext.msaaSamples = this.msaaSamples;
    this._frameCoordinator.executeView(
      world,
      context,
      camera,
      cameraEntity.id,
      cameraFrame,
      postProcessPasses,
      postSceneRequirements,
      frameView,
      worldFrameState,
      camWorldMatrix,
      sceneEnvironment,
      cameraFrame.position,
      uniformSlot,
      vpW,
      vpH,
      this._liveFrame,
    );
  }

  private _syncDirectionalShadowDiagnostics(): void {
    this.lastDirectionalShadowPassCount = this._directionalShadows.passCount;
    this.lastDirectionalShadowCasterCount = this._directionalShadows.casterCount;
    this.lastDirectionalShadowCacheHit = this._directionalShadows.cacheHit;
  }

  private readonly _collectViewPass = () => {
    const state = this._frameExecution;
    const options = this._viewCollectionOptions;
    options.diagnostics = getEngineFrameDiagnostics(this.engine);
    options.view = state.frameView;
    options.cameraPosition = state.cameraPosition;
    this.lastVisibleCount += this._viewPreparation.collectView(
      this._sceneCollector,
      state.worldFrameState,
      options,
      this.renderSettings,
      this.transparentSort,
    );
  };

  private readonly _sortRenderItemsPass = () => this._measureStage('sort', this._sortRenderItemsStage);
  private readonly _sortRenderItemsStage = () => {
    const stats = this._viewPreparation.sort(this.renderSettings, this.transparentSort);
    this.lastOpaqueSortMode = stats.mode;
    this.lastOpaqueSortCount = stats.itemCount;
  };

  private readonly _prepareGpuDrivenBatchesPass = () => this._measureStage('batch-build', this._prepareGpuDrivenBatchesStage);
  private readonly _prepareGpuDrivenBatchesStage = () => {
    const state = this._frameExecution;
    const gpuDrivenStats = this._viewPreparation.prepareGpuDrivenBatches(
      state.context,
      this.frustum,
      this.renderSettings,
      state.uniformSlot,
    );
    this.lastGpuDrivenBatchCount = gpuDrivenStats.batchCount;
    this.lastGpuDrivenMaterialCount = gpuDrivenStats.materialCount;
    this.lastGpuDrivenCommandObjectsCreated = gpuDrivenStats.commandObjectsCreated;
    this.lastGpuDrivenMaterialRendererResolutions = gpuDrivenStats.materialRendererResolutions;
    this._materialRenderContext.gpuDrivenBatchBuffer =
      this.renderSettings.gpuDrivenBatches
      && gpuDrivenStats.batchCount > 0
        ? this._gpuDrivenBatches.batchBuffer
        : null;
  };

  private readonly _sortTransparentOnGpuPass = () => {
    const state = this._frameExecution;
    this._viewPreparation.sortTransparentOnGpu(
      state.context,
      this.renderSettings.gpuCullingReadback,
    );
  };

  private readonly _renderDirectionalShadowPass = () => {
    this._directionalShadows.render(this._sceneGlobalExecution.context);
    this._syncDirectionalShadowDiagnostics();
  };

  private readonly _preparePbrLightingPass = () => {
    if (!this._containsPbrMaterial(this._opaqueItems, this._transparentItems)) return;
    this._requirePbrRenderer().beginScene(this._pbrSceneLightingContext);
  };

  private readonly _renderScenePassPass = () => this._measureStage('upload', this._renderScenePassStage);
  private readonly _renderScenePassStage = () => this._renderScenePass();
  private readonly _renderPostScenePassesPass = () => this._renderPostScenePasses();

  private _measureStage(stage: 'collect' | 'sort' | 'batch-build' | 'upload', action: () => void): void {
    const diagnostics = getEngineFrameDiagnostics(this.engine);
    if (diagnostics) diagnostics.measure(stage, action);
    else action();
  }

  private _renderScenePass(): void {
    const state = this._frameExecution;
    const { world, context } = state;
    let { postSceneRequirements } = state;
    const { postProcessPasses } = state;
    const opaqueItems = this._opaqueItems;
    const transparentItems = this._transparentItems;
    const helperItems = this._helperItems;
    const viewProj = this._viewProjMatrix;
    const viewMatrix = this._viewMatrix;
    const loadOp = state.frameView.loadOp;
    const submitterOptions = this._getSubmitterOptions();
    try {
      this._submitter.prepareView(opaqueItems, transparentItems, this._materialRenderContext, submitterOptions);
      const needsSceneColorCapture = transparentItems.some(item =>
        item.material instanceof PbrMaterial && item.material.transmissionFactor > 0);
      if (needsSceneColorCapture) {
        postSceneRequirements = this._postScenePasses.prepare(postProcessPasses, context, this.reverseZ, true);
        state.postSceneRequirements = postSceneRequirements;
      }
      const pbrRenderer = this._renderers.pbr;
      if (!needsSceneColorCapture) pbrRenderer?.setTransmissionFramebuffer(null);
      let passEncoder: GPURenderPassEncoder;
      let ownsPass = false;
      if (postSceneRequirements.usePostProcess) {
        passEncoder = context.encoder.beginRenderPass(this._postScenePasses.buildScenePassDescriptor(
          loadOp,
          this.reverseZ,
          context.view,
          needsSceneColorCapture,
        ));
        ownsPass = true;
      } else if (context.passEncoder) {
        passEncoder = context.passEncoder;
      } else if (isRenderFrameContext(context)) {
        passEncoder = context.beginPass(context.descriptor, context.loadOp);
      } else {
        const commandPass = beginRenderCommandPass(context);
        passEncoder = commandPass.passEncoder;
        ownsPass = commandPass.ownsPass;
      }

    const applyViewState = (pass: GPURenderPassEncoder): void => {
      const viewport = context.view?.viewport ?? this.viewport;
      const scissor = context.view?.scissor ?? this.scissor;
      if (viewport) pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, viewport.minDepth ?? 0, viewport.maxDepth ?? 1);
      if (scissor) pass.setScissorRect(scissor.x, scissor.y, scissor.width, scissor.height);
    };
    applyViewState(passEncoder);

    this._scenePassRenderer.renderSky(
      passEncoder,
      world,
      this._disabledHierarchyCache,
      this._materialRenderContext.sceneFrameUniforms,
      this.reverseZ,
      this.msaaSamples,
    );

    this._submitter.drawOpaqueItems(opaqueItems, passEncoder, viewProj, viewMatrix, submitterOptions);
    if (needsSceneColorCapture) {
      passEncoder.end();
      const sceneColor = this._postScenePasses.captureSceneColor(context.encoder);
      this._requirePbrRenderer().setTransmissionFramebuffer(sceneColor);
      passEncoder = context.encoder.beginRenderPass(this._postScenePasses.buildScenePassDescriptor(
        'load',
        this.reverseZ,
        context.view,
        true,
      ));
      applyViewState(passEncoder);
    }
    this._submitter.drawDepthPrepassItems(transparentItems, passEncoder, viewProj, viewMatrix, submitterOptions);
    this._submitter.drawTransparentItems(
      transparentItems,
      passEncoder,
      viewProj,
      viewMatrix,
      opaqueItems.length,
      submitterOptions,
    );

    this._scenePassRenderer.renderHelpers(passEncoder, helperItems, this._materialRenderContext.sceneFrameUniforms, this.reverseZ, this.msaaSamples, {
      helperEntities: this._liveHelperEntities,
      helperGeometries: this._liveHelperGeometries,
    });

      if (ownsPass) passEncoder.end();
    } finally {
      this._submitter.endView(this._materialRenderContext);
    }
  }

  private _renderPostScenePasses(): void {
    const {
      context,
      camera,
      cameraEntityId,
      cameraFrame,
      frameView,
      postProcessPasses,
      postSceneRequirements,
    } = this._frameExecution;
    const opaqueItems = this._opaqueItems;
    const transparentItems = this._transparentItems;
    const outlineItems = this._outlineItems;
    if (!postSceneRequirements.usePostProcess) return;
    if (postSceneRequirements.needsDepth || postSceneRequirements.needsNormal || postSceneRequirements.needsMotion || postSceneRequirements.needsOutlineMask) {
      const postItems = this._frameItems.preparePostItems();
      this._postScenePasses.renderAuxiliaryBuffers({
        encoder: context.encoder,
        items: postItems,
        motionItems: opaqueItems,
        outlineItems,
        sceneFrameUniforms: this._materialRenderContext.sceneFrameUniforms,
        camera,
        reverseZ: this.reverseZ,
        sampleCount: context.view?.sampleCount ?? this.msaaSamples,
        viewKey: frameView.key,
        frameId: cameraFrame.frameId,
        cameraId: cameraEntityId,
        motionHistoryRevision: resolveMotionHistoryRevision(postProcessPasses),
        context,
        requirements: postSceneRequirements,
        live: {
          depthEntities: this._liveDepthEntities,
          depthGeometries: this._liveDepthGeometries,
          depthMaterials: this._liveDepthMaterials,
          normalEntities: this._liveNormalEntities,
          normalGeometries: this._liveNormalGeometries,
          normalMaterials: this._liveNormalMaterials,
          outlineEntities: this._liveOutlineEntities,
          outlineGeometries: this._liveOutlineGeometries,
          motionGeometries: this._liveMotionGeometries,
        },
      });
    }
    const outputView = context.view?.target.getOutputView() ?? this.engine.getOutputView();
    const frame = this._postProcessFrameContext;
    frame.viewKey = frameView.key;
    frame.frameId = cameraFrame.frameId;
    frame.cameraId = cameraEntityId;
    frame.width = frameView.width;
    frame.height = frameView.height;
    frame.reverseZ = cameraFrame.reverseZ;
    frame.near = camera.near;
    frame.far = camera.far;
    frame.isOrthographic = camera.projectionType === 'orthographic';
    frame.projectionJitter.set(cameraFrame.projectionJitter);
    frame.projectionMatrix.set(cameraFrame.projectionMatrix);
    frame.viewProjectionMatrix.set(cameraFrame.viewProjectionMatrix);
    frame.inverseViewProjectionMatrix.set(cameraFrame.inverseViewProjectionMatrix);
    this._postScenePasses.runPostProcess(context.encoder, postProcessPasses, outputView, postSceneRequirements, frame);
  }

  override destroy(): this {
    this._unregisterRecovery?.();
    this.suspendForDeviceLoss();
    this._clearViewLocalCaches();
    this.materialRenderers.destroy();
    return super.destroy();
  }

  suspendForDeviceLoss(): void {
    this._renderers.suspendForDeviceLoss();
    this._postScenePasses.destroy();
    this._scenePassRenderer.destroy();
    this._planarMirrorManager.destroy();
    this._viewPreparation.suspendForDeviceLoss();
    this.materialRenderers.releaseResources();
    this._directionalShadows.reset();
    this._syncDirectionalShadowDiagnostics();
    this._boundsCache.clear();
    this._telemetry.resetGpuState();
    this._clearRenderItemReferences();
    this._disabledHierarchyCache.clear();
    this._liveCaches.clear();
    this._spatialCandidates.reset();
  }

  recoverGpuResource(_device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this._postScenePasses = new Render3DPostScenePasses(this.engine);
    this._viewPreparation.recoverGpuResources();
    this._scenePassRenderer = new Render3DScenePassRenderer(this.engine);
  }

  private _getSubmitterOptions(): Render3DSubmitterOptions {
    const options = this._submitterOptions;
    options.gpuDrivenBatches = this.renderSettings.gpuDrivenBatches;
    options.megaBatchRuns = this._gpuDrivenBatches.megaBatchRuns;
    options.batchBuffer = this._materialRenderContext.gpuDrivenBatchBuffer;
    return options;
  }

  private _getRendererSlot(registration: MaterialRendererRegistration): number {
    return this._getTransparentRendererKey(registration);
  }

  private _getGpuDrivenMaterialBatch(batchIndex: number): MaterialGpuDrivenBatch | undefined {
    return this._gpuDrivenBatches.getMaterialBatch(batchIndex, this.renderSettings.gpuDrivenBatches, this.renderSettings.gpuDrivenIndirectDraws);
  }

  private _getWorldBoundingSphere(
    geometry: Geometry3D,
    worldMatrix: Float32Array,
    target?: BoundingSphere & { center: [number, number, number] },
  ): BoundingSphere | null {
    return this._boundsCache.getWorldSphere(geometry, worldMatrix, this._liveFrame, target);
  }

  private _getTransparentMaterialInfo(material: Material): TransparentMaterialInfo {
    const registration = this.materialRenderers.resolve(material);
    const transparent = registration?.isTransparent?.(material) ?? false;
    const info = this._transparentMaterialInfoScratch;
    info.transparent = transparent;
    if (!transparent || !registration) {
      info.order = 0;
      info.depthSort = false;
      info.rendererKey = 0;
      return info;
    }
    info.order = registration.transparentOrder?.(material) ?? 0;
    info.depthSort = registration.transparentDepthSort?.(material) ?? true;
    info.rendererKey = this._getTransparentRendererKey(registration);
    return info;
  }

  private _getTransparentRendererKey(registration: MaterialRendererRegistration): number {
    let key = this._transparentRendererIds.get(registration);
    if (key !== undefined) return key;
    key = this._nextTransparentRendererId++;
    this._transparentRendererIds.set(registration, key);
    return key;
  }

  private _containsPbrMaterial(
    opaqueItems: readonly Render3DRenderItem[],
    transparentItems: readonly Render3DRenderItem[],
  ): boolean {
    return opaqueItems.some(item => item.material instanceof PbrMaterial)
      || transparentItems.some(item => item.material instanceof PbrMaterial);
  }

  /** @internal Override seams retained for deterministic renderer contract tests. */
  private _requireBasicRenderer() { return this._renderers.requireBasic(); }
  private _requireBlinnPhongRenderer() { return this._renderers.requireBlinnPhong(); }
  private _requirePbrRenderer() { return this._renderers.requirePbr(); }
  private _requireShadowRenderer() { return this._renderers.requireShadow(); }
  private _requireDepthRenderer() { return this._renderers.requireDepth(); }
  private _requireNormalRenderer() { return this._renderers.requireNormal(); }
  private _requireVolumeRenderer() { return this._renderers.requireVolume(); }
  private _requirePlanarMirrorRenderer() { return this._renderers.requirePlanarMirror(); }

  private _beginLiveCacheFrame(): void {
    if (this._liveCaches.beginFrame()) {
      // Old lastUsedFrame values may collide after wrapping the frame counter.
      this._boundsCache.clear();
      this._clearViewLocalCaches();
    }
  }

  private _sweepViewLocalCaches(): void {
    this._sceneCollector.sweepViewCaches();
    this._frameCoordinator.sweepViewCaches(this._liveFrame);
  }

  private _clearViewLocalCaches(): void {
    this._sceneCollector.clearViewCaches();
    this._frameCoordinator.clearViewCaches();
  }

  private _releaseStaleRendererCaches(world: World): void {
    this._renderers.releaseStaleCaches({
      basicEntities: this._liveBasicEntities,
      basicGeometries: this._liveBasicGeometries,
      basicMaterials: this._liveBasicMaterials,
      blinnPhongEntities: this._liveBlinnPhongEntities,
      blinnPhongGeometries: this._liveBlinnPhongGeometries,
      blinnPhongMaterials: this._liveBlinnPhongMaterials,
      depthEntities: this._liveDepthEntities,
      depthGeometries: this._liveDepthGeometries,
      depthMaterials: this._liveDepthMaterials,
      normalEntities: this._liveNormalEntities,
      normalGeometries: this._liveNormalGeometries,
      normalMaterials: this._liveNormalMaterials,
      volumeEntities: this._liveVolumeEntities,
      volumeGeometries: this._liveVolumeGeometries,
      volumeMaterials: this._liveVolumeMaterials,
      pbrEntities: this._livePbrEntities,
      pbrGeometries: this._livePbrGeometries,
      pbrMaterials: this._livePbrMaterials,
    });

    this._postScenePasses.releaseRendererCaches({
      depthEntities: this._liveDepthEntities,
      depthGeometries: this._liveDepthGeometries,
      depthMaterials: this._liveDepthMaterials,
      normalEntities: this._liveNormalEntities,
      normalGeometries: this._liveNormalGeometries,
      normalMaterials: this._liveNormalMaterials,
      outlineEntities: this._liveOutlineEntities,
      outlineGeometries: this._liveOutlineGeometries,
      motionGeometries: this._liveMotionGeometries,
    });

    this._scenePassRenderer.releaseRendererCaches({
      helperEntities: this._liveHelperEntities,
      helperGeometries: this._liveHelperGeometries,
    });

    this._sweepLiveCacheMarkers(world);
  }

  private _sweepLiveCacheMarkers(world: World): void {
    this._liveCaches.sweep(world, this._boundsCache, this._disabledHierarchyCache);
  }

  private _clearRenderItemReferences(): void {
    this._viewPreparation.endFrame();
  }

}

/** Experimental: installs a concrete low-level mesh renderer implementation. */
export function setRender3DMeshRenderer(
  system: Render3DSystem,
  renderer: Mesh3DRenderer,
): Render3DSystem {
  installRender3DMeshRenderer(system, renderer);
  return system;
}

/** Experimental: exposes the current GPU-driven buffer for diagnostics and engine research. */
export function getRender3DGpuDrivenBatchBuffer(
  system: Render3DSystem,
): GpuDrivenBatchBuffer | null {
  return readRender3DGpuDrivenBatchBuffer(system);
}

/** Experimental: resolves an internal entity-to-batch table slot. */
export function getRender3DGpuDrivenBatchIndexForEntity(
  system: Render3DSystem,
  entityId: number,
): number | undefined {
  return readRender3DGpuDrivenBatchIndexForEntity(system, entityId);
}

/** Experimental: resolves an internal material-table slot. */
export function getRender3DGpuDrivenMaterialSlot(
  system: Render3DSystem,
  materialId: number,
): number | undefined {
  return readRender3DGpuDrivenMaterialSlot(system, materialId);
}

function isRenderFrameContext(context: RenderCommandContext): context is RenderFrameContext {
  return typeof (context as Partial<RenderFrameContext>).endPass === 'function'
    && typeof (context as Partial<RenderFrameContext>).beginPass === 'function';
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function resolveMotionHistoryRevision(passes: readonly PostProcessPass[]): number {
  let revision = 0;
  for (const pass of passes) revision = (Math.imul(revision, 31) + pass.getMotionHistoryRevision()) >>> 0;
  return revision;
}
