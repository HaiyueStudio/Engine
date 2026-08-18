/// <reference path="./types/wgsl.d.ts" />

// Core
export { FrameDiagnostics } from './core/FrameDiagnostics';
export type { FrameDiagnosticsOptions, FrameMetricCounter, FrameMetricStage, FrameMetricsSnapshot } from './core/FrameDiagnostics';
export { getEngineFrameDiagnostics, getEngineGPUResourceTracker, registerEngineDiagnostics } from './core/EngineDiagnosticsAccess';
export type { EngineDiagnosticsState } from './core/EngineDiagnosticsAccess';
export { HaiyueEngine } from './core/Engine';
export type { HaiyueEngineEventMap, HaiyueEngineOptions } from './core/Engine';
export { EngineEvent, EventEmitter } from './core/EventEmitter';
export type { EmitEventOptions, EventListener, EventListenerOptions, EventPhase } from './core/EventEmitter';
export { EngineError, EngineErrorCode } from './core/EngineError';
export type { EngineErrorOptions } from './core/EngineError';
export { RenderTargetManager } from './core/RenderTargetManager';
export type { RenderTargetManagerOptions } from './core/RenderTargetManager';
export { resolveDepthFormat } from './core/DepthFormat';
export { FrameLoop } from './core/FrameLoop';
export type { FrameLoopOptions } from './core/FrameLoop';
export { EngineRegistryHub } from './core/EngineRegistryHub';
export { EnginePluginHost } from './core/EnginePluginHost';
export type { EnginePluginHostOptions, EnginePluginHostScope } from './core/EnginePluginHost';
export { DEFAULT_ENGINE_DEFAULTS, cloneClearColor, mergeEngineDefaults, mergeSceneDefaults } from './core/EngineDefaults';
export type { AssetManagerDefaults, EngineClearColor, EngineDefaults, EngineDefaultsInput, RenderPipelineDefaults, SceneDefaults } from './core/EngineDefaults';
export { assertPluginDependencies, createRegistrationToken } from './core/EnginePlugin';
export type { ComponentRegistration, EditorPluginContext, EnginePlugin, EnginePluginContext, InstalledEnginePlugin, PluginRollbackScope, PluginRuntimeContext, RegistrationToken, ScenePluginContext, ScenePluginScene } from './core/EnginePlugin';
export { createRenderCapabilities, DEFAULT_RENDER_PROFILE, getRenderProfile, RENDER_PROFILES, resolveRenderProfileFeatures, resolveRenderProfileSettings } from './core/RenderProfile';
export type { RenderCapabilities, RenderCapabilityDecision, RenderCapabilityName, RenderCapabilityReport, RenderDimension, RenderProfile, RenderProfileName, RenderProfileSettings } from './core/RenderProfile';
export { requireEngineCanvas, requireEngineDevice } from './core/IEngine';
export type { IEngine } from './core/IEngine';
export type { ViewportRect, ScissorRect } from './core/ViewportRect';
export { RenderView, RenderViewFamily } from './core/RenderView';
export type { RenderDepthConvention, RenderSampleCount, RenderViewFamilyOptions, RenderViewFamilySnapshot, RenderViewOptions, RenderViewSnapshot, RenderViewTarget, RenderViewTargetPassOptions } from './core/RenderView';
export { RenderGraph } from './core/RenderGraph';
export type { RenderGraphCompiledPass, RenderGraphPassClass, RenderGraphPassHandle, RenderGraphPassOptions, RenderGraphResourceHandle, RenderGraphResourceLifetime, RenderGraphResourceOptions, RenderGraphStats } from './core/RenderGraph';
export { alignUp, alignUp4, alignUp16 } from './utils/align';
export { AssetManager } from './assets/AssetManager';
export { isCompressedTextureSource } from './assets/AssetManager';
export type { AssetHandle, AssetLoadOptions, AssetLoaderContext, AssetLoaderRegistration, AssetLookupRequest, AssetManagerDebugSnapshot, AssetManagerOptions, CompressedTextureSourceDescriptor, TextureAssetOptions, TextureMipmapMode } from './assets/AssetManager';
export { AssetJob, AssetOwnerScope, ASSET_JOB_PRIORITY_VALUE } from './assets/AssetJob';
export type { AssetJobContext, AssetJobOptions, AssetJobPhase, AssetJobPriority, AssetJobProgress } from './assets/AssetJob';
export { AssetCacheHierarchy, BudgetedAssetCache } from './assets/AssetCache';
export type { AssetCacheBudget, AssetCacheHierarchyOptions, AssetCacheSnapshot } from './assets/AssetCache';
export { AssetUploadScheduler } from './assets/AssetUploadScheduler';
export type { AssetUploadSchedulerSnapshot, AssetUploadTask } from './assets/AssetUploadScheduler';
export { isWorkerInfrastructureError, normalizeParserError, parseAssetWorkerFirst } from './assets/AssetParser';
export type { AssetParser, AssetParserContext, WorkerFallbackDiagnostic, WorkerFirstParseOptions } from './assets/AssetParser';
export { createAbortError, monotonicNow } from './async/AsyncPrimitives';
export { WorkerChannel, WORKER_CHANNEL_PROTOCOL_VERSION } from './async/WorkerChannel';
export type { WorkerChannelLike } from './async/WorkerChannel';
export { AssetWorkerClient, createAssetWorkerClientFromUrl, createAssetWorkerSource, createInlineAssetWorkerClient } from './assets/AssetWorkerClient';
export type { AssetWorkerLike, AssetWorkerRequest, AssetWorkerRequestInit, AssetWorkerRequestType, AssetWorkerResponse } from './assets/AssetWorkerClient';
export { createInlineKtx2TextureWorkerClient, createKtx2TextureLoader, createKtx2TextureWorkerClientFromUrl, createKtx2TextureWorkerSource, inspectKtx2Texture, Ktx2TextureWorkerClient, prepareKtx2TexturePayload, uploadKtx2Texture, uploadPreparedKtx2Texture } from './assets/Ktx2TextureLoader';
export type { Ktx2SupercompressionDecoder, Ktx2TextureInfo, Ktx2TextureLoaderOptions, Ktx2TexturePayload, Ktx2TextureWorker, Ktx2TextureWorkerOptions } from './assets/Ktx2TextureLoader';
export { getSceneRenderIntegration, getSceneRenderPipeline, Scene, normalizeSceneOptions } from './scene/Scene';
export type { SceneAssetRequest, SceneCameraOptions, SceneCreateOptions, SceneLoadedAssets, SceneOptions, ScenePreset, SceneRenderViewOptions } from './scene/Scene';
export { createSceneSystemPlan, SCENE_PRESETS } from './scene/internal/ScenePresetFactory';
export type { ScenePresetDefinition, SceneSystemPlanEntry, SceneSystemRole } from './scene/internal/ScenePresetFactory';

// ECS utils
export { isEntityDisabledInHierarchy, isEntityDisabledInHierarchyCached } from './ecs/utils/hierarchy';
export type { EntityHierarchyDisabledCache } from './ecs/utils/hierarchy';
export { SpatialIndex } from './spatial/SpatialIndex';
export type { SpatialIndexKey, SpatialIndexStats } from './spatial/SpatialIndex';
export { getSpatialIndexService } from './spatial/SpatialIndexService';
export type { MeshSpatialEntry, SpatialIndexService } from './spatial/SpatialIndexService';
export { clearCachedRenderPassDescriptors, cloneRenderPassDescriptor, getCachedRenderPassDescriptor } from './core/renderPassDescriptor';
export type { RenderPassLoadOp } from './core/renderPassDescriptor';
export { beginRenderCommandPass, createRenderFrameContext, RenderFrameContext } from './core/RenderCommandContext';
export type { RenderCommandContext, RenderFrameContextOptions } from './core/RenderCommandContext';
export { FrameData, TransformStore, composeViewProjection } from './frame';
export type { Camera3DFrameData, Camera3DFrameOptions, TransformFrameEntry, WorldFrameToken } from './frame';
export { createGPUResourceOwner, GPUResourceScope, GPUResourceTracker, estimateTextureBytes } from './core/GPUResourceTracker';
export type { GPUCacheStats, GPUResourceDebugSnapshot, GPUResourceOwner, GPUResourceOwnerKind, GPUResourceRecord, GPUResourceTrackOptions, GPUResourceTrackerOptions, GPUResourceTypeStats, GPUResourceUsage, GPUTrackedResourceType } from './core/GPUResourceTracker';
export { isRecoverableGpuResource } from './core/Lifecycle';
export type { AssetJobState, DeviceRecoveryPhase, DeviceRecoveryProgress, EngineLifecycleState, PluginLifecycleState, RecoverableGpuResource, SceneLifecycleState } from './core/Lifecycle';

// Input
export { InputMap } from './input/InputMap';
export type { InputActionBindings, InputActionSnapshot } from './input/InputMap';

// GUI
export * from './gui';

// RTT
export { RttTexture } from './rtt/RttTexture';
export type { RttTextureOptions } from './rtt/RttTexture';
export { RttRenderContributor } from './rtt/RttRenderContributor';
export type { RttRenderContributorOptions } from './rtt/RttRenderContributor';
export { estimateTransientRenderTargetBytes, TransientRenderTargetPool } from './rtt/TransientRenderTargetPool';
export type { TransientRenderTargetAssignment, TransientRenderTargetDescriptor, TransientRenderTargetPoolStats, TransientRenderTargetRequest, TransientRenderTargetScopeStats } from './rtt/TransientRenderTargetPool';

// Compute
export { ComputePassBase } from './compute/ComputePassBase';
export type { ComputePassBaseOptions } from './compute/ComputePassBase';
export { ComputeKernel } from './compute/ComputeKernel';
export type { ComputeKernelOptions } from './compute/ComputeKernel';
export { TextureConvolutionProcessor, CONVOLUTION_KERNELS } from './compute/TextureConvolutionProcessor';
export type { ConvolutionKernelName, TextureConvolutionOptions, TextureConvolutionProcessOptions } from './compute/TextureConvolutionProcessor';

// Color
export { Color } from './color/Color';
export type { BuiltinColorSpace, ColorValue } from './color/Color';
export { ColorSRGB } from './color/ColorSRGB';
export { ColorLinear } from './color/ColorLinear';
export { ColorHSL } from './color/ColorHSL';
export { isColorValue, resolveColor, toColorSRGB, writeColorLinear, writeColorSRGB } from './color/ColorLike';
export type { ColorChannels, ColorConvertible, ColorLike, ColorObject, ColorTuple } from './color/ColorLike';

// Geometry
export { Geometry3D } from './geometry/Geometry3D';
export { GEOMETRY3D_UV_CHANNEL_CAPACITY } from './geometry/Geometry3D';
export type { CustomAttribute, Geometry3DBoundsMode, Geometry3DLocalBounds, Geometry3DTextureCoordinateSet, InstanceAttribute, Geometry3DOptions } from './geometry/Geometry3D';
export { LineGeometry } from './geometry/LineGeometry';
export { createBox3D } from './geometry/BoxGeometry';
export type { BoxGeometryOptions } from './geometry/BoxGeometry';
export { createRoundedBox3D } from './geometry/RoundedBoxGeometry';
export type { RoundedBoxGeometryOptions } from './geometry/RoundedBoxGeometry';
export { createSphere3D } from './geometry/SphereGeometry';
export type { SphereGeometryOptions } from './geometry/SphereGeometry';
export { createCone3D } from './geometry/ConeGeometry';
export type { ConeGeometryOptions } from './geometry/ConeGeometry';
export { createCylinder3D } from './geometry/CylinderGeometry';
export type { CylinderGeometryOptions } from './geometry/CylinderGeometry';
export { createTorus3D } from './geometry/TorusGeometry';
export type { TorusGeometryOptions } from './geometry/TorusGeometry';
export { createIcosahedron3D } from './geometry/IcosahedronGeometry';
export type { IcosahedronGeometryOptions } from './geometry/IcosahedronGeometry';
export { createPlane3D } from './geometry/PlaneGeometry';
export type { PlaneGeometryOptions } from './geometry/PlaneGeometry';
export { createCSGGeometry, csgUnion, csgSubtract, csgIntersect } from './geometry/CSG';
export type { CSGOperation } from './geometry/CSG';

// Geometry 2D
export { Geometry2D } from './geometry/Geometry2D';
export { createRect2D, createCircle2D, createTriangle2D, createPolygon2D } from './geometry/Shapes2D';
export type {
  RectGeometry2DOptions,
  CircleGeometry2DOptions,
  TriangleGeometry2DOptions,
  RegularPolygonOptions,
  CustomPolygonOptions,
} from './geometry/Shapes2D';

// SVG
export { createSVG2DMeshes } from './svg/SVGGeometry2D';
export type { SVG2DMeshData, SVG2DOptions } from './svg/SVGGeometry2D';

// Font
export { createBitmapFontData } from './font/BitmapFontData';
export type { BitmapFontChar, BitmapFontData } from './font/BitmapFontData';
export { parseFnt, parseFntJson } from './font/BitmapFontParser';
export { buildBitmapFont } from './font/BitmapFontBuilder';
export type { BuildFontOptions, BuiltFont } from './font/BitmapFontBuilder';
export { buildSdfBitmapFont } from './font/SdfBitmapFontBuilder';
export type { BuildSdfFontOptions, BuiltSdfFont } from './font/SdfBitmapFontBuilder';

// Material
export { Material } from './material/Material';
export { BasicMaterial } from './material/BasicMaterial';
export type { BasicMaterialOptions, BlendMode, MaterialTextureSource, SampleableTextureSource } from './material/BasicMaterial';
export { LineMaterial } from './material/LineMaterial';
export { CssMaterial } from './material/CssMaterial';
export type { CssMaterialOptions, CssMaterialStyle, CssPadding, CssVerticalAlign, CssWhiteSpace } from './material/CssMaterial';
export { InstancedMaterial } from './material/InstancedMaterial';
export { DepthMaterial } from './material/DepthMaterial';
export type { DepthMaterialOptions } from './material/DepthMaterial';
export { NormalMaterial } from './material/NormalMaterial';
export type { NormalMaterialOptions } from './material/NormalMaterial';
export { PlanarMirrorMaterial } from './material/PlanarMirrorMaterial';
export type { PlanarMirrorMaterialOptions, PlanarMirrorReflection } from './material/PlanarMirrorMaterial';
export { Material2D } from './material/Material2D';
export type { Material2DOptions, BlendMode2D } from './material/Material2D';
export { BlinnPhongMaterial } from './material/BlinnPhongMaterial';
export type { BlinnPhongMaterialOptions, BlendModeBlinnPhong } from './material/BlinnPhongMaterial';
export { RadialShadowMaterial } from './material/RadialShadowMaterial';
export type { RadialShadowMaterialOptions } from './material/RadialShadowMaterial';
export { VolumeMaterial } from './material/VolumeMaterial';
export type { VolumeBlendMode, VolumeMaterialOptions } from './material/VolumeMaterial';

// Lighting
export { LightComponent } from './lighting/LightComponent';
export type { LightType } from './lighting/LightComponent';
export { AmbientLight } from './lighting/AmbientLight';
export type { AmbientLightOptions } from './lighting/AmbientLight';
export { DirectionalLight } from './lighting/DirectionalLight';
export type { DirectionalLightOptions } from './lighting/DirectionalLight';
export { PointLight } from './lighting/PointLight';
export type { PointLightOptions } from './lighting/PointLight';
export { Fog } from './lighting/Fog';
export type { FogMode, FogOptions } from './lighting/Fog';

// Components
export { Transform3D } from './components/Transform3D';
export { CartesianTransform3D } from './components/CartesianTransform3D';
export { FixedScreenTransform3D } from './components/FixedScreenTransform3D';
export type { FixedScreenTransform3DOptions, FixedScreenRect } from './components/FixedScreenTransform3D';
export { BasisTransform3D } from './components/BasisTransform3D';
export type { BasisTransform3DOptions, Vec3Tuple } from './components/BasisTransform3D';
export { SphericalTransform3D } from './components/SphericalTransform3D';
export { Camera3D } from './components/Camera3D';
export type { Camera3DOptions, ProjectionType } from './components/Camera3D';
export { Camera2D } from './components/Camera2D';
export type { Camera2DOptions, Camera2DViewportMode } from './components/Camera2D';
export { Mesh3D } from './components/Mesh3D';
export type { Mesh3DData } from './components/Mesh3D';
export { PlanarMirror } from './components/PlanarMirror';
export type { PlanarMirrorOptions } from './components/PlanarMirror';
export { Line3D } from './components/Line3D';
export { Interactive } from './components/Interactive';
export type { InteractiveEvent, InteractiveHandler, InteractiveOptions } from './components/Interactive';
export { BitmapText } from './components/BitmapText';
export type { BitmapFontMode, BitmapTextOptions } from './components/BitmapText';
export { CanvasTextComponent } from './components/CanvasTextComponent';
export type { CanvasTextComponentOptions } from './components/CanvasTextComponent';
export { Physics2DTo3DTransformSync } from './components/Physics2DTo3DTransformSync';
export type { Physics2DTo3DPlane, Physics2DTo3DRotationAxis, Physics2DTo3DSource, Physics2DTo3DTransformSyncOptions } from './components/Physics2DTo3DTransformSync';
export { DataComponent } from './components/DataComponent';
export type { JsonObject, JsonPrimitive, JsonValue } from './components/DataComponent';
export { InstancedMesh3D } from './components/InstancedMesh3D';
export { MeshHelper } from './components/MeshHelper';
export type { MeshHelperOptions, HelperMode } from './components/MeshHelper';
export { OutlineTarget } from './components/OutlineTarget';
export { Sky } from './components/Sky';
export type { SkyOptions } from './components/Sky';
export { KeyboardComponent } from './components/KeyboardComponent';
export type { KeyboardSnapshot } from './components/KeyboardComponent';
export { MusicPlayerComponent } from './components/MusicPlayerComponent';
export type { MusicPlayerOptions } from './components/MusicPlayerComponent';
export { ScriptComponent, SCRIPT_LIFECYCLES } from './components/ScriptComponent';
export type {
  ScriptComponentScripts,
  ScriptCompiledFunction,
  ScriptCompiler,
  ScriptCompilerContext,
  ScriptDebuggerDecision,
  ScriptDebuggerEvent,
  ScriptDebuggerHook,
  ScriptExecutionOptions,
  ScriptExecutionPolicy,
  ScriptErrorPolicy,
  ScriptExecutor,
  ScriptLifecycleName,
  ScriptLifecycleEvent,
  ScriptRuntimeApiFactory,
  ScriptRuntimeContext,
  ScriptRuntimeErrorEvent,
  ScriptSourceLocation,
  ScriptSourceMapResolver,
} from './components/ScriptComponent';
export { DEFAULT_SCRIPT_CAPABILITIES, generateScriptRuntimeDeclarations, SCRIPT_CAPABILITIES, SCRIPT_RUNTIME_COMPLETION_PATHS, SCRIPT_RUNTIME_CONTRACT } from './script/ScriptRuntimeContract';
export type { ScriptCapabilityName, ScriptRuntimeApi, ScriptRuntimeAssetApi, ScriptRuntimeContractEntry, ScriptRuntimeDebugApi, ScriptRuntimeReadApi, ScriptRuntimeSceneApi } from './script/ScriptRuntimeContract';
export { ScriptExecutionScope } from './script/ScriptExecutionScope';
export type { ScriptDisposer } from './script/ScriptExecutionScope';
export { ScriptResource } from './script/ScriptResource';
export { Mesh2D } from './components/Mesh2D';
export { Transform2D } from './components/Transform2D';
export type { Transform2DOptions } from './components/Transform2D';

// Physics 2D
export { Physics2DBody } from './physics/Physics2DBody';
export type { Physics2DBodyOptions, Physics2DBodyType, Physics2DShapeType } from './physics/Physics2DBody';
export { Physics2DJoint } from './physics/Physics2DJoint';
export type { Physics2DJointOptions, Physics2DJointType, Physics2DJointTarget } from './physics/Physics2DJoint';
export { Physics2DSystem } from './physics/Physics2DSystem';
export type { Physics2DMouseJointOptions, Physics2DSystemOptions } from './physics/Physics2DSystem';

// Systems
export { getRender3DFramePlanSnapshot, Render3DSystem } from './systems/Render3DSystem';
export type { DefaultMaterialRendererOptions, Render3DSystemOptions } from './systems/Render3DSystem';
export type { MirrorViewDropReason, MirrorViewPlanBudget, MirrorViewPlannerOptions, MirrorViewPlannerStats } from './systems/MirrorViewPlanner';
export type { RenderViewFrame, WorldFrameRenderable, WorldFrameState } from './systems/Render3DFrameState';
export type { Render3DOpaqueSceneSortKey } from './systems/Render3DFrameState';
export { Render3DOpaqueSorter } from './systems/Render3DOpaqueSorter';
export type { Render3DOpaqueSorterStats, Render3DOpaqueSortMode } from './systems/Render3DOpaqueSorter';
export type { Render3DFramePassKind, Render3DFramePassSnapshot } from './systems/Render3DFramePlan';
export { FixedScreenTransform3DSystem } from './systems/FixedScreenTransform3DSystem';
export type { FixedScreenTransform3DSystemOptions } from './systems/FixedScreenTransform3DSystem';
/** Diagnostic-only camera-distance LOD observer. Rendering LOD is selected by Render3DSystem per view. */
export { BvhLodSystem } from './systems/BvhLodSystem';
export type { BvhLodSystemOptions, BvhLodSystemStats } from './systems/BvhLodSystem';
export { Line3DRenderSystem } from './systems/Line3DRenderSystem';
export type { Line3DRenderSystemOptions } from './systems/Line3DRenderSystem';
export { BitmapTextRenderSystem } from './systems/BitmapTextRenderSystem';
export type { BitmapTextRenderSystemOptions } from './systems/BitmapTextRenderSystem';
export { InstancedMesh3DRenderSystem } from './systems/InstancedMesh3DRenderSystem';
export type {
  InstancedMesh3DBatchSortMode,
  InstancedMesh3DAllocationStats,
  InstancedMesh3DInstanceSortMode,
  InstancedMesh3DGpuProfile,
  InstancedMesh3DRenderSystemOptions,
} from './systems/InstancedMesh3DRenderSystem';
export { Mesh2DRenderSystem } from './systems/Mesh2DRenderSystem';
export type { Mesh2DRenderSystemOptions } from './systems/Mesh2DRenderSystem';
export { BlinnPhongRenderSystem } from './systems/BlinnPhongRenderSystem';
export type { BlinnPhongRenderSystemOptions } from './systems/BlinnPhongRenderSystem';
export { RadialShadowRenderFeature } from './systems/RadialShadowRenderFeature';
export type { RadialShadowRenderFeatureOptions } from './systems/RadialShadowRenderFeature';
export { Physics2DTo3DTransformSyncSystem } from './systems/Physics2DTo3DTransformSyncSystem';
export type { Physics2DTo3DTransformSyncSystemOptions } from './systems/Physics2DTo3DTransformSyncSystem';
export { createInteractionRaycastResult, InteractionSystem } from './systems/InteractionSystem';
export type { InteractionRaycastResult, InteractionSystemOptions } from './systems/InteractionSystem';

// Renderer
export { BaseRenderer } from './renderer/BaseRenderer';
export type { PipelineCacheDiagnosticsSnapshot } from './renderer/BaseRenderer';
export { PipelineWarmupPlan, createComputePipelineAsync, createRenderPipelineAsync, isPipelineWarmupParticipant } from './renderer/PipelineWarmup';
export type { PipelineWarmupListener, PipelineWarmupParticipant, PipelineWarmupProgress, PipelineWarmupRunOptions, PipelineWarmupStatus, PipelineWarmupTask } from './renderer/PipelineWarmup';
export { RendererCacheMap, RendererObjectSlotCache } from './renderer/RendererCacheMap';
export { RendererPipelineLayoutCache, RendererResourceCache } from './renderer/RendererResourceCache';
export { disposeSceneFrameGpuArena, getSceneFrameGpuArena, SceneFrameGpuArena, SceneFrameGpuBinding } from './renderer/SceneFrameGpuArena';
export type { SceneFrameGpuArenaOptions, SceneFrameGpuArenaStats } from './renderer/SceneFrameGpuArena';
export { FrameRingResource } from './renderer/FrameRingResource';
export type { FrameRingGenerationInfo, FrameRingResourceOptions, FrameRingResourceStats } from './renderer/FrameRingResource';
export { RendererRegistrationRegistry } from './renderer/RendererRegistrationRegistry';
export type { DestroyableRendererRegistration, RendererRegistrationConstructor } from './renderer/RendererRegistrationRegistry';
export { IndirectDrawCommandBuffer } from './renderer/IndirectDrawCommandBuffer';
export { GpuDrivenBatchBuffer } from './renderer/GpuDrivenBatchBuffer';
export type { GpuDrivenBatchCommand, GpuDrivenBatchTables, GpuDrivenIndirectCommandView, GpuDrivenInstanceTableEntry, GpuDrivenMaterialTableEntry, GpuDrivenMegaBatchRun, GpuDrivenReadbackDebugSnapshot, GpuDrivenReadbackPathDebugSnapshot, GpuDrivenReadbackRequestOptions, GpuDrivenReadbackResult, GpuDrivenReadbackStatus } from './renderer/GpuDrivenBatchBuffer';
export { TransparentMegaBatch } from './renderer/TransparentMegaBatch';
export type { TransparentMegaBatchEntry, TransparentMegaBatchRun } from './renderer/TransparentMegaBatch';
export { GpuDrawCommandComputePass } from './compute/GpuDrawCommandComputePass';
export type { GpuDrawCommandBuffers } from './compute/GpuDrawCommandComputePass';
export { Mesh3DGpuCullComputePass } from './compute/Mesh3DGpuCullComputePass';
export type { Mesh3DGpuCullBuffers } from './compute/Mesh3DGpuCullComputePass';
export { GpuSortComputePass } from './compute/GpuSortComputePass';
export type { GpuSortableBuffers } from './compute/GpuSortComputePass';
export { recordComputeResourcePass } from './compute/ComputeResourceAccess';
export { GUI_SHAPE_VERTEX_LAYOUT, GUI_TEXTURED_VERTEX_LAYOUT } from './gui/rendering/GuiVertexLayout';
export { MaterialRegistryBase } from './renderer/MaterialRegistryBase';
export type { MaterialRenderContract } from './renderer/MaterialRegistryBase';
export type { MaterialGpuDrivenBatch } from './renderer/MaterialRendererRegistry';
export {
  getRender3DGpuDrivenBatchBuffer,
  getRender3DGpuDrivenBatchIndexForEntity,
  getRender3DGpuDrivenMaterialSlot,
  setRender3DMeshRenderer,
} from './systems/Render3DSystem';
export { getSceneRenderEnvironment } from './frame/SceneRenderEnvironment';
export type { SceneRenderEnvironment } from './frame/SceneRenderEnvironment';
export {
  FOG_UNIFORM_WGSL,
  FogUniformLayout,
  generateWgslUniformStruct,
  getSceneFrameUniformSnapshot,
  SCENE_FRAME_UNIFORM_FLOATS,
  SCENE_FRAME_UNIFORM_WGSL,
  SceneFrameUniformLayout,
  writeSceneFrameUniforms,
} from './frame/SceneFrameUniformLayout';
export type {
  SceneFrameUniformSnapshot,
  UniformAbiFieldDefinition,
  UniformAbiFieldLayout,
  UniformAbiLayout,
} from './frame/SceneFrameUniformLayout';
export { Material2DRendererRegistry } from './renderer/Material2DRendererRegistry';
export type { Material2DConstructor, Material2DRendererKey, Material2DRenderBatchItem, Material2DRenderContext, Material2DRendererRegistration } from './renderer/Material2DRendererRegistry';
export { Mesh3DRenderer } from './renderer/Mesh3DRenderer';
export { BitmapTextRenderer } from './renderer/BitmapTextRenderer';
export { InstancedMesh3DRenderer } from './renderer/InstancedMesh3DRenderer';
export type {
  InstancedMesh3DExternalIndirectCommand,
  InstancedMesh3DInstanceDepthSortOptions,
  InstancedMesh3DRenderOptions,
  InstancedMesh3DGpuCullingOptions,
} from './renderer/InstancedMesh3DRenderer';
export { DepthRenderer } from './renderer/DepthRenderer';
export { NormalRenderer } from './renderer/NormalRenderer';
export { PlanarMirrorRenderer } from './renderer/PlanarMirrorRenderer';
export { MeshHelperRenderer } from './renderer/MeshHelperRenderer';
export { OutlineMaskRenderer } from './renderer/OutlineMaskRenderer';
export { SkyRenderer } from './renderer/SkyRenderer';
export { Mesh2DRenderer } from './renderer/Mesh2DRenderer';
export { BlinnPhongRenderer } from './renderer/BlinnPhongRenderer';
export { RadialShadowRenderer } from './renderer/RadialShadowRenderer';
export { VolumeRenderer } from './renderer/VolumeRenderer';
export { RenderPipeline } from './renderer/RenderPipeline';
export { RenderIntegration, getSystemRenderPipelineOptions, isRenderPipelineSystem } from './renderer/RenderIntegration';
export type {
  DeltaRenderRecordSystem,
  RenderPipelineEntryType,
  RenderPipelineExecutionBoundary,
  RenderPipelineEntryOptions,
  RenderPipelineDebugSnapshot,
  RenderPipelineDiagnosticIssue,
  RenderPipelineDiagnosticIssueCode,
  RenderPipelineEntryDebugSnapshot,
  RenderPipelineExecuteOptions,
  RenderPipelinePassSharing,
  RenderPipelinePassDebugSnapshot,
  RenderPipelineRecordMode,
  RenderPipelineSystem,
  RenderRecordSystem,
} from './renderer/RenderPipeline';
export type { RenderIntegrationOptions, RenderPipelineEntryOptionsFactory } from './renderer/RenderIntegration';
export type { DeltaRenderPassContributor, RenderPassContributor, RendererFeature } from './renderer/RenderFeature';

// Controls
export { OrbitControl } from './controls/OrbitControl';
export type { OrbitControlOptions } from './controls/OrbitControl';
export { BoxSelectionControl } from './controls/BoxSelectionControl';
export type { BoxSelectionControlOptions, BoxSelectionMode, BoxSelectionRect, BoxSelectionResult } from './controls/BoxSelectionControl';

// Math
export { Ray } from './math/Ray';
export type { RayHit, RayIntersectMeshOptions } from './math/Ray';

// Tween
export { Tween } from './tween/Tween';
export type { TweenOptions, TweenRepeat, TweenTarget } from './tween/Tween';
export { TweenManager } from './tween/TweenManager';
export type { TweenGroupState, TweenRuntimeItem } from './tween/TweenManager';
export { TweenSequence } from './tween/TweenSequence';
export type { TweenSequenceOptions } from './tween/TweenSequence';
export { TweenSystem } from './tween/TweenSystem';
export type { TweenSystemOptions } from './tween/TweenSystem';
export { Easing } from './tween/Easing';
export type { EasingFunction } from './tween/Easing';
export { interpolate, lerpNumber, lerpFloat32Array, lerpColorSRGB, interpolatorRegistry } from './tween/interpolators/index';

// Culling
export { Frustum, computeBoundingSphere, transformBoundingSphere } from './culling/Frustum';
export type { BoundingSphere } from './culling/Frustum';

// Shader composition (experimental low-level rendering contract)
export {
  composeWgsl,
  createComposedShaderModule,
  defineWgslFeatureModule,
  formatWgslCompilationMessage,
  mapWgslSourceLocation,
} from './shader/WgslFeatureComposer';
export type {
  ComposedWgsl,
  ComposeWgslOptions,
  WgslDefineValue,
  WgslFeatureModule,
  WgslFeatureModuleOptions,
  WgslSourceLocation,
  WgslSourceSpan,
} from './shader/WgslFeatureComposer';

// Post-processing
export { PostProcessPass } from './postprocess/PostProcessPass';
export type { PostProcessFrameContext, PostProcessProjectionJitterContext } from './postprocess/PostProcessPass';
export { PostProcessRenderer } from './postprocess/PostProcessRenderer';
export { PostProcessRenderFeature } from './postprocess/PostProcessRenderFeature';
export type { PostProcessRenderFeatureOptions } from './postprocess/PostProcessRenderFeature';
export { PostProcessSceneTextureStore } from './postprocess/PostProcessSceneTextureStore';
export type { PostProcessSceneTextureRequirements } from './postprocess/PostProcessSceneTextureStore';
export { FxaaPass } from './postprocess/FxaaPass';
export { GaussianBlurPass } from './postprocess/GaussianBlurPass';
export type { GaussianBlurPassOptions } from './postprocess/GaussianBlurPass';
export { GrayscalePass } from './postprocess/GrayscalePass';
export { CustomPass } from './postprocess/CustomPass';
export type { CustomPassExtraBindGroupEntries, CustomPassExtraBindings, CustomPassExtraEntriesContext, CustomPassOptions } from './postprocess/CustomPass';
export { SobelPass } from './postprocess/SobelPass';
export type { SobelPassOptions } from './postprocess/SobelPass';
export { TaaPass } from './postprocess/TaaPass';
export type { TaaPassOptions } from './postprocess/TaaPass';
export { MotionBlurPass } from './postprocess/MotionBlurPass';
export type { MotionBlurPassOptions } from './postprocess/MotionBlurPass';
export { OutlinePass } from './postprocess/OutlinePass';
export type { OutlinePassOptions } from './postprocess/OutlinePass';

// Re-export ECS
export { Entity } from './ecs/Entity';
export { Component, ComponentLifecycleFlags, ComponentWithData, UniqueCheckType } from './ecs/Component';
export type { ComponentAddLifecycle, ComponentConstructor, ComponentRemoveLifecycle, ComponentUpdateLifecycle, ComponentWorldLifecycle } from './ecs/Component';
export { System } from './ecs/System';
export type { ComponentQueryToken, SystemQueryDescriptor } from './ecs/Query';
export type { SystemQuery, TQueryRule } from './ecs/System';
export { World } from './ecs/World';
export type { WorldComponentChange, WorldComponentChangeJournal, WorldComponentChangeKind, WorldRuntimeIntegration } from './ecs/World';
export { EcsIds } from './ecs/Global';
export { IdAllocator } from './ecs/IdAllocator';
export type { EcsIdDomain } from './ecs/IdAllocator';

// Serialization
export {
  ComponentSerializationRegistry,
  coreComponentSerializationRegistry,
  deserializeEntityCore,
  serializeEntityCore,
} from './serialization/ComponentSerializationRegistry';
export type {
  ComponentDeserializeContext,
  ComponentSerializeContext,
  ComponentSerializer,
  CoreSerializedComponent,
  CoreSerializedEntity,
  SerializedArrayLike,
  SerializedColor,
  SerializedVec2,
  SerializedVec3,
} from './serialization/ComponentSerializationRegistry';
