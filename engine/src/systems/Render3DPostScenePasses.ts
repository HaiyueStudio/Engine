import type { Material } from '../material/Material';
import { auxiliaryWritesDepth, type MaterialCoverageResolver } from '../renderer/AuxiliaryMaterial';
import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { getRenderViewPassOptions, type RenderViewSnapshot } from '../core/RenderView';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import type { Camera3D } from '../components/Camera3D';
import type { Geometry3D } from '../geometry/Geometry3D';
import { DepthMaterial } from '../material/DepthMaterial';
import { NormalMaterial } from '../material/NormalMaterial';
import type {
  PostProcessFrameContext,
  PostProcessPass,
  PostProcessProjectionJitterContext,
} from '../postprocess/PostProcessPass';
import { PostProcessRenderer } from '../postprocess/PostProcessRenderer';
import { SceneOutputPass } from '../postprocess/SceneOutputPass';
import { SCENE_COLOR_FORMAT } from '../postprocess/SceneColor';
import { srgbToLinear } from '../color/Color';
import { PostProcessSceneTextureStore } from '../postprocess/PostProcessSceneTextureStore';
import { DepthRenderer } from '../renderer/DepthRenderer';
import { NormalRenderer } from '../renderer/NormalRenderer';
import { OutlineMaskRenderer } from '../renderer/OutlineMaskRenderer';
import { MotionVectorRenderer } from '../renderer/MotionVectorRenderer';
import type { LiveIdSet } from '../renderer/utils';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { auxiliarySurfacePassCount, canShareMotionSurface, isAuxiliarySurface } from './Render3DAuxiliaryPlan';

interface MutableLiveIdSet extends LiveIdSet {
  add(id: number): void;
}

export interface Render3DPostSceneRequirements {
  usePostProcess: boolean;
  needsDepth: boolean;
  needsNormal: boolean;
  needsMotion: boolean;
  needsOutlineMask: boolean;
  needsAuxDepth: boolean;
  needsSceneColorCapture: boolean;
}

export interface Render3DPostSceneItem {
  entityId: number;
  material: Material | null;
  geometry: Geometry3D | null;
  clippingPlanes: ClippingPlanes | null;
  worldMatrix: Float32Array | null;
}

export interface Render3DPostSceneLiveSets {
  depthEntities: MutableLiveIdSet;
  depthGeometries: MutableLiveIdSet;
  depthMaterials: MutableLiveIdSet;
  normalEntities: MutableLiveIdSet;
  normalGeometries: MutableLiveIdSet;
  normalMaterials: MutableLiveIdSet;
  outlineEntities: MutableLiveIdSet;
  outlineGeometries: MutableLiveIdSet;
  motionGeometries: MutableLiveIdSet;
}

export class Render3DPostScenePasses {
  readonly output = new SceneOutputPass();
  private readonly _chain: PostProcessPass[] = [];
  private readonly _sceneTextures = new PostProcessSceneTextureStore();
  private readonly _viewMaterials = new Map<string, { depth: DepthMaterial; normal: NormalMaterial }>();
  /** Structural counts for the last view, excluding the separate outline semantics. */
  readonly auxiliaryStats = { surfacePassCount: 0, surfaceDrawCount: 0, unmergedPassCount: 0, unmergedDrawCount: 0, sharedMotionSurface: false };
  private _postRenderer: PostProcessRenderer | null = null;
  private _depthRenderer: DepthRenderer | null = null;
  private _normalRenderer: NormalRenderer | null = null;
  private _outlineMaskRenderer: OutlineMaskRenderer | null = null;
  private _motionVectorRenderer: MotionVectorRenderer | null = null;
  private readonly _requirements: Render3DPostSceneRequirements = {
    usePostProcess: false,
    needsDepth: false,
    needsNormal: false,
    needsMotion: false,
    needsOutlineMask: false,
    needsAuxDepth: false,
    needsSceneColorCapture: false,
  };

  constructor(private readonly _engine: IEngine, private readonly resolveCoverage: MaterialCoverageResolver = () => null) {}

  resolveMotionHistoryRevision(passes: readonly PostProcessPass[], viewKey: string): number {
    let revision = 0;
    for (const pass of passes) revision = (Math.imul(revision, 31) + pass.getMotionHistoryRevision(viewKey)) >>> 0;
    return revision;
  }

  resolveProjectionJitter(
    passes: readonly PostProcessPass[],
    context: PostProcessProjectionJitterContext,
    out: Float32Array,
  ): Float32Array {
    for (const pass of passes) {
      out[0] = 0;
      out[1] = 0;
      if (pass.getProjectionJitter(context, out)) return out;
    }
    out[0] = 0;
    out[1] = 0;
    return out;
  }

  contributePipelineWarmup(
    plan: PipelineWarmupPlan,
    passes: readonly PostProcessPass[],
    reverseZ: boolean,
    sampleCount: 1 | 4,
  ): void {
    const depth = this._requireDepthRenderer();
    depth.reverseZ = reverseZ;
    depth.msaaSamples = 1;
    depth.contributePipelineWarmup(plan);

    const normal = this._requireNormalRenderer();
    normal.reverseZ = reverseZ;
    normal.msaaSamples = 1;
    normal.auxiliaryDepth = null;
    normal.contributePipelineWarmup(plan);
    if (passes.some(pass => pass.needsDepthTexture) && passes.some(pass => pass.needsNormalTexture)) {
      normal.auxiliaryDepth = { near: 0, far: 1 };
      normal.contributePipelineWarmup(plan);
      normal.auxiliaryDepth = null;
    }

    const outline = this._requireOutlineMaskRenderer();
    outline.reverseZ = reverseZ;
    outline.msaaSamples = 1;
    outline.contributePipelineWarmup(plan);
    if (sampleCount > 1) {
      outline.msaaSamples = sampleCount;
      outline.contributePipelineWarmup(plan);
    }

    if (passes.some(pass => !!pass.needsMotionTexture)) {
      const motion = this._requireMotionVectorRenderer();
      motion.reverseZ = reverseZ;
      motion.auxiliaryDepth = false;
      motion.auxiliaryNormal = false;
      motion.contributePipelineWarmup(plan);
      motion.auxiliaryDepth = passes.some(pass => !!pass.needsDepthTexture);
      motion.auxiliaryNormal = passes.some(pass => !!pass.needsNormalTexture);
      motion.contributePipelineWarmup(plan);
    }

    {
      if (!this._postRenderer) {
        this._postRenderer = new PostProcessRenderer();
        this._postRenderer.prepare(this._engine, this._engine.width, this._engine.height, SCENE_COLOR_FORMAT);
      }
      this.output.configure(this._engine.format, 1, 'reinhard');
      this._postRenderer.contributePipelineWarmup(plan, this.outputChain(passes));
    }
  }

  prepare(
    passes: readonly PostProcessPass[],
    context: RenderCommandContext,
    reverseZ: boolean,
    needsSceneColorCapture = false,
  ): Render3DPostSceneRequirements {
    const requirements = this.getRequirements(passes, needsSceneColorCapture);
    Object.assign(this.auxiliaryStats, { surfacePassCount: 0, surfaceDrawCount: 0, unmergedPassCount: 0, unmergedDrawCount: 0, sharedMotionSurface: false });
    // Every auxiliary configuration owns an aux-depth attachment. Keep advancing
    // idle stores after effects are disabled, without adding callbacks to scenes
    // that have never allocated auxiliary buffers.
    if (requirements.needsAuxDepth || this._sceneTextures.auxDepthTexture !== null) {
      this._sceneTextures.beginFrame(
        context.frameData?.frameId ?? 0,
        context.afterSubmit ? callback => context.afterSubmit!(callback) : undefined,
      );
    }
    if (!requirements.needsMotion && this._motionVectorRenderer) {
      const renderer = this._motionVectorRenderer;
      this._motionVectorRenderer = null;
      const retire = (): void => renderer.destroy();
      if (context.afterSubmit) context.afterSubmit(queue => void queue.onSubmittedWorkDone().then(retire, retire));
      else retire();
    }
    if (!requirements.usePostProcess) return requirements;

    if (context.passEncoder) {
      throw new EngineError(
        EngineErrorCode.RenderPipelineInvalidPassState,
        'Render3DSystem.record() requires an isolated pass for linear HDR rendering and scene output.',
        {
          hint: 'Register this Render3DSystem as an isolated render pipeline entry so it can encode its HDR scene and output stages.',
          docsPath: 'errors/E_RENDER_PIPELINE_INVALID_PASS_STATE',
        },
      );
    }

    const surface = context.view?.target ?? this._engine;
    if (!this._postRenderer) {
      this._postRenderer = new PostProcessRenderer();
      this._postRenderer.prepare(this._engine, context.view?.width ?? surface.width, context.view?.height ?? surface.height, SCENE_COLOR_FORMAT);
    } else if (
      this._postRenderer.width !== (context.view?.width ?? surface.width) ||
      this._postRenderer.height !== (context.view?.height ?? surface.height)
    ) {
      this._postRenderer.resize(context.view?.width ?? surface.width, context.view?.height ?? surface.height, SCENE_COLOR_FORMAT);
    }
    this._postRenderer.beginFrame(
      context.frameData?.frameId ?? 0,
      context.afterSubmit ? callback => context.afterSubmit!(callback) : undefined,
    );

    if (requirements.needsDepth || requirements.needsNormal || requirements.needsMotion || requirements.needsOutlineMask) {
      this._sceneTextures.ensure(this._engine, {
        depth: requirements.needsDepth,
        normal: requirements.needsNormal,
        motion: requirements.needsMotion,
        outlineMask: requirements.needsOutlineMask,
        auxDepth: requirements.needsAuxDepth,
      }, reverseZ, {
        width: context.view?.width ?? surface.width,
        height: context.view?.height ?? surface.height,
        format: surface.format,
        sampleCount: context.view?.sampleCount ?? this._engine.msaaSamples,
      });
    }

    return requirements;
  }

  getRequirements(
    passes: readonly PostProcessPass[],
    needsSceneColorCapture = false,
  ): Render3DPostSceneRequirements {
    const requirements = this._requirements;
    requirements.usePostProcess = true;
    requirements.needsSceneColorCapture = needsSceneColorCapture;
    requirements.needsDepth = false;
    requirements.needsNormal = false;
    requirements.needsMotion = false;
    requirements.needsOutlineMask = false;
    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i];
      if (!pass) continue;
      requirements.needsDepth ||= !!pass.needsDepthTexture;
      requirements.needsNormal ||= !!pass.needsNormalTexture;
      requirements.needsMotion ||= !!pass.needsMotionTexture;
      requirements.needsOutlineMask ||= !!pass.needsOutlineMask;
    }
    requirements.needsAuxDepth = requirements.needsDepth
      || requirements.needsNormal
      || requirements.needsMotion
      || requirements.needsOutlineMask;
    return requirements;
  }

  buildScenePassDescriptor(
    loadOp: GPULoadOp,
    reverseZ: boolean,
    view?: RenderViewSnapshot,
    preserveMsaa = false,
  ): GPURenderPassDescriptor {
    const postRenderer = this._postRenderer;
    if (!postRenderer) {
      throw new EngineError(
        EngineErrorCode.RenderPipelineInvalidPassState,
        'PostProcessRenderer is not initialized.',
        {
          hint: 'Render3DSystem initializes post-processing internally; this usually means the scene pass descriptor was requested before record() setup completed.',
          docsPath: 'errors/E_RENDER_PIPELINE_INVALID_PASS_STATE',
        },
      );
    }

    const color = view?.clearColor ?? this._engine.clearColor;
    const clearColor = view?.loadOp === 'load' ? { r: 0, g: 0, b: 0, a: 0 }
      : { r: srgbToLinear(color.r) * color.a, g: srgbToLinear(color.g) * color.a, b: srgbToLinear(color.b) * color.a, a: color.a };
    // Full-target HDR passes must write the depth that later 3D overlay systems
    // load. SceneOutput only transfers color. Viewport-local HDR surfaces retain
    // their own depth because their attachment size/origin differs from the target.
    const sharesTargetCoordinates = !view?.viewport
      && postRenderer.width === (view?.target.width ?? this._engine.width)
      && postRenderer.height === (view?.target.height ?? this._engine.height);
    const depthAttachment = sharesTargetCoordinates
      ? (view ? view.target.getRenderPassDescriptor(getRenderViewPassOptions(view)) : this._engine.getRenderPassDescriptor()).depthStencilAttachment
      : undefined;
    return postRenderer.getScenePassDescriptor({
      sampleCount: view?.sampleCount ?? this._engine.msaaSamples,
      reverseZ,
      clearColor,
      loadOp,
      depthFormat: this._engine.getDepthFormat(reverseZ),
      preserveMsaa,
      ...(depthAttachment ? { depthAttachment } : {}),
    });
  }

  captureSceneColor(encoder: GPUCommandEncoder): GPUTextureView {
    if (!this._postRenderer) {
      throw new EngineError(
        EngineErrorCode.RenderPipelineInvalidPassState,
        'PostProcessRenderer is not initialized for scene-color capture.',
      );
    }
    return this._postRenderer.captureSceneColor(encoder);
  }

  applySceneViewport(pass: GPURenderPassEncoder, view: RenderViewSnapshot): void {
    const viewport = view.viewport;
    if (viewport) pass.setViewport(0, 0, view.width, view.height, viewport.minDepth ?? 0, viewport.maxDepth ?? 1);
    const scissor = view.scissor;
    if (!scissor) return;
    const x = Math.min(view.width, Math.max(0, scissor.x - (viewport?.x ?? 0)));
    const y = Math.min(view.height, Math.max(0, scissor.y - (viewport?.y ?? 0)));
    const right = Math.max(x, Math.min(view.width, scissor.x + scissor.width - (viewport?.x ?? 0)));
    const bottom = Math.max(y, Math.min(view.height, scissor.y + scissor.height - (viewport?.y ?? 0)));
    pass.setScissorRect(x, y, right - x, bottom - y);
  }

  renderAuxiliaryBuffers(options: {
    encoder: GPUCommandEncoder;
    items: readonly Render3DPostSceneItem[];
    motionItems: readonly Render3DPostSceneItem[];
    outlineItems: readonly Render3DPostSceneItem[];
    sceneFrameUniforms: SceneFrameUniformSnapshot;
    camera: Camera3D;
    reverseZ: boolean;
    sampleCount: 1 | 4;
    viewKey: string;
    frameId: number;
    cameraId: number;
    motionHistoryRevision: number;
    projectionJitter: ArrayLike<number>;
    context: RenderCommandContext;
    requirements: Render3DPostSceneRequirements;
    live: Render3DPostSceneLiveSets;
  }): void {
    const { requirements } = options;
    if (!requirements.needsDepth && !requirements.needsNormal && !requirements.needsMotion && !requirements.needsOutlineMask) return;
    const sharedMotion = requirements.needsMotion && canShareMotionSurface(options.items, options.motionItems);
    const motionDepth = sharedMotion && requirements.needsDepth;
    const motionNormal = sharedMotion && requirements.needsNormal;
    const normalDepth = !motionDepth && requirements.needsNormal && requirements.needsDepth;
    const stats = this.auxiliaryStats;
    stats.sharedMotionSurface = sharedMotion;
    stats.surfacePassCount = auxiliarySurfacePassCount(requirements, sharedMotion);
    stats.unmergedPassCount = +requirements.needsDepth + +requirements.needsNormal + +requirements.needsMotion;
    stats.unmergedDrawCount = 0;
    stats.surfaceDrawCount = 0;
    for (const item of options.items) if (isAuxiliarySurface(item)) stats.unmergedDrawCount += +requirements.needsDepth + +requirements.needsNormal;
    for (const item of options.motionItems) if (isAuxiliarySurface(item)) stats.unmergedDrawCount += +requirements.needsMotion;
    const textures = this._sceneTextures;
    const depthAttachment = () => ({
      view: textures.auxDepthView!,
      depthClearValue: options.reverseZ ? 0.0 : 1.0,
      depthLoadOp: 'clear' as GPULoadOp,
      depthStoreOp: 'discard' as GPUStoreOp,
    });

    if (requirements.needsDepth && !motionDepth && !normalDepth && textures.depthView) {
      const materials = this._getViewMaterials(options.viewKey);
      const renderer = this._requireDepthRenderer();
      materials.depth.near = options.camera.near;
      materials.depth.far = options.camera.far;
      materials.depth.isOrthographic = options.camera.projectionType === 'orthographic';
      renderer.reverseZ = options.reverseZ;
      renderer.msaaSamples = 1;
      renderer.beginView(options.sceneFrameUniforms);
      const pass = options.encoder.beginRenderPass({
        label: 'Render3DSystem.postDepthPass',
        colorAttachments: [{
          view: textures.depthView,
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
        depthStencilAttachment: depthAttachment(),
      });
      for (const { entityId, material, geometry, clippingPlanes, worldMatrix } of options.items) {
        if (!geometry || !worldMatrix || !material) continue;
        if (!auxiliaryWritesDepth(material)) continue;
        options.live.depthEntities.add(entityId);
        options.live.depthGeometries.add(geometry.id);
        options.live.depthMaterials.add(materials.depth.id);
        renderer.render(pass, entityId, geometry, materials.depth, worldMatrix, { sourceMaterial: material, coverage: this.resolveCoverage(material) }, clippingPlanes);
        stats.surfaceDrawCount++;
      }
      pass.end();
    }

    if (requirements.needsNormal && !motionNormal && textures.normalView) {
      const materials = this._getViewMaterials(options.viewKey);
      const renderer = this._requireNormalRenderer();
      renderer.reverseZ = options.reverseZ;
      renderer.msaaSamples = 1;
      renderer.auxiliaryDepth = normalDepth ? options.camera : null;
      renderer.beginView(options.sceneFrameUniforms);
      const pass = options.encoder.beginRenderPass({
        label: 'Render3DSystem.postNormalPass',
        colorAttachments: [{
          view: textures.normalView,
          clearValue: { r: 0.5, g: 0.5, b: 1, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }, normalDepth ? { view: textures.depthView!, clearValue: [1, 1, 1, 1], loadOp: 'clear', storeOp: 'store' } : null],
        depthStencilAttachment: depthAttachment(),
      });
      for (const { entityId, material, geometry, clippingPlanes, worldMatrix } of options.items) {
        if (!geometry || !worldMatrix || !material) continue;
        if (!auxiliaryWritesDepth(material)) continue;
        options.live.normalEntities.add(entityId);
        options.live.normalGeometries.add(geometry.id);
        options.live.normalMaterials.add(materials.normal.id);
        renderer.render(pass, entityId, geometry, materials.normal, worldMatrix, { sourceMaterial: material, coverage: this.resolveCoverage(material) }, clippingPlanes);
        stats.surfaceDrawCount++;
      }
      pass.end();
    }

    if (requirements.needsMotion && textures.motionView) {
      const renderer = this._requireMotionVectorRenderer();
      renderer.reverseZ = options.reverseZ;
      renderer.auxiliaryDepth = motionDepth;
      renderer.auxiliaryNormal = motionNormal;
      const viewOptions = {
        viewKey: options.viewKey,
        frameId: options.frameId,
        cameraId: options.cameraId,
        historyRevision: options.motionHistoryRevision,
        near: options.camera.near,
        far: options.camera.far,
        isOrthographic: options.camera.projectionType === 'orthographic',
        projectionJitter: options.projectionJitter,
      };
      renderer.beginView(options.sceneFrameUniforms, viewOptions, options.context);
      const pass = options.encoder.beginRenderPass({
        label: 'Render3DSystem.postMotionVectorPass',
        colorAttachments: [{
          view: textures.motionView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }, motionDepth ? { view: textures.depthView!, clearValue: [1, 1, 1, 1], loadOp: 'clear', storeOp: 'store' } : null,
        motionNormal ? { view: textures.normalView!, clearValue: [0.5, 0.5, 1, 1], loadOp: 'clear', storeOp: 'store' } : null],
        depthStencilAttachment: depthAttachment(),
      });
      // Velocity follows the opaque/alpha-tested surfaces of the main view.
      for (const { entityId, material, geometry, clippingPlanes, worldMatrix } of options.motionItems) {
        if (!geometry || !worldMatrix || !material) continue;
        if (!auxiliaryWritesDepth(material)) continue;
        options.live.motionGeometries.add(geometry.id);
        renderer.render(pass, entityId, geometry, worldMatrix, clippingPlanes, material, this.resolveCoverage(material));
        stats.surfaceDrawCount++;
      }
      pass.end();
      renderer.endView(viewOptions);
    }

    if (requirements.needsOutlineMask && textures.outlineMaskView) {
      const renderer = this._requireOutlineMaskRenderer();
      renderer.reverseZ = options.reverseZ;
      renderer.msaaSamples = 1;
      renderer.beginView(options.sceneFrameUniforms);
      const pass = options.encoder.beginRenderPass({
        label: 'Render3DSystem.postOutlineMaskPass',
        colorAttachments: [{
          view: textures.outlineMaskView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
        depthStencilAttachment: depthAttachment(),
      });
      for (const { entityId, material, geometry, clippingPlanes, worldMatrix } of options.outlineItems) {
        if (!geometry || !worldMatrix || !material) continue;
        options.live.outlineEntities.add(entityId);
        options.live.outlineGeometries.add(geometry.id);
        renderer.render(pass, entityId, geometry, worldMatrix, { sourceMaterial: material, coverage: this.resolveCoverage(material) }, clippingPlanes);
      }
      pass.end();

      if (textures.outlineVisibleMaskView) {
        renderer.msaaSamples = options.sampleCount;
        const visibleColorAttachment: GPURenderPassColorAttachment = textures.outlineVisibleMaskMsaaView
          ? {
              view: textures.outlineVisibleMaskMsaaView,
              resolveTarget: textures.outlineVisibleMaskView,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'discard',
            }
          : {
              view: textures.outlineVisibleMaskView,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            };
        const visiblePass = options.encoder.beginRenderPass({
          label: 'Render3DSystem.postOutlineVisibleMaskPass',
          colorAttachments: [visibleColorAttachment],
          depthStencilAttachment: {
            view: this._postRenderer!.sceneDepthView!,
            depthLoadOp: 'load',
            depthStoreOp: 'store',
          },
        });
        for (const { entityId, material, geometry, clippingPlanes, worldMatrix } of options.outlineItems) {
          if (!geometry || !worldMatrix || !material) continue;
          options.live.outlineEntities.add(entityId);
          options.live.outlineGeometries.add(geometry.id);
          renderer.render(visiblePass, entityId, geometry, worldMatrix, { depthWrite: false, sourceMaterial: material, coverage: this.resolveCoverage(material) }, clippingPlanes);
        }
        visiblePass.end();
      }
    }
  }

  runPostProcess(
    encoder: GPUCommandEncoder,
    passes: PostProcessPass[],
    outputView: GPUTextureView,
    requirements: Render3DPostSceneRequirements,
    frame: PostProcessFrameContext,
  ): void {
    if (!requirements.usePostProcess || !this._postRenderer) return;
    this._postRenderer.run(encoder, this.outputChain(passes), outputView, {
      depth: requirements.needsDepth ? this._sceneTextures.depthTexture ?? undefined : undefined,
      normal: requirements.needsNormal ? this._sceneTextures.normalTexture ?? undefined : undefined,
      motion: requirements.needsMotion ? this._sceneTextures.motionTexture ?? undefined : undefined,
      outlineMask: requirements.needsOutlineMask ? this._sceneTextures.outlineMaskTexture ?? undefined : undefined,
      outlineVisibleMask: requirements.needsOutlineMask ? this._sceneTextures.outlineVisibleMaskTexture ?? undefined : undefined,
      frame,
    });
  }

  releaseRendererCaches(live: Render3DPostSceneLiveSets): void {
    for (const [key, materials] of this._viewMaterials) {
      if (!live.depthMaterials.has(materials.depth.id) && !live.normalMaterials.has(materials.normal.id)) this._viewMaterials.delete(key);
    }
    this._depthRenderer?.releaseEntitiesNotIn(live.depthEntities);
    this._depthRenderer?.releaseGeometriesNotIn(live.depthGeometries);
    this._depthRenderer?.releaseMaterialsNotIn(live.depthMaterials);

    this._normalRenderer?.releaseEntitiesNotIn(live.normalEntities);
    this._normalRenderer?.releaseGeometriesNotIn(live.normalGeometries);
    this._normalRenderer?.releaseMaterialsNotIn(live.normalMaterials);

    this._outlineMaskRenderer?.releaseEntitiesNotIn(live.outlineEntities);
    this._outlineMaskRenderer?.releaseGeometriesNotIn(live.outlineGeometries);
    this._motionVectorRenderer?.releaseGeometriesNotIn(live.motionGeometries);
  }

  private outputChain(passes: readonly PostProcessPass[]): PostProcessPass[] {
    this._chain.length = 0;
    this._chain.push(...passes, this.output);
    return this._chain;
  }

  private _getViewMaterials(viewKey: string) {
    // Camera-dependent parameter buffers differ between views in one submission.
    let materials = this._viewMaterials.get(viewKey);
    if (!materials) {
      materials = { depth: new DepthMaterial(), normal: new NormalMaterial({ space: 'view' }) };
      this._viewMaterials.set(viewKey, materials);
    }
    return materials;
  }

  destroy(): void {
    this._viewMaterials.clear();
    this._chain.length = 0;
    this._postRenderer?.destroy();
    this._depthRenderer?.destroy();
    this._normalRenderer?.destroy();
    this._outlineMaskRenderer?.destroy();
    this._motionVectorRenderer?.destroy();
    this._sceneTextures.destroy();
    this._postRenderer = null;
    this._depthRenderer = null;
    this._normalRenderer = null;
    this._outlineMaskRenderer = null;
    this._motionVectorRenderer = null;
  }

  private _requireDepthRenderer(): DepthRenderer {
    if (!this._depthRenderer) {
      this._depthRenderer = new DepthRenderer();
      this._depthRenderer.colorFormat = 'r32float';
      this._depthRenderer.prepare(this._engine);
    }
    return this._depthRenderer;
  }

  private _requireNormalRenderer(): NormalRenderer {
    if (!this._normalRenderer) {
      this._normalRenderer = new NormalRenderer();
      this._normalRenderer.colorFormat = 'rgba16float';
      this._normalRenderer.prepare(this._engine);
    }
    return this._normalRenderer;
  }

  private _requireOutlineMaskRenderer(): OutlineMaskRenderer {
    if (!this._outlineMaskRenderer) {
      this._outlineMaskRenderer = new OutlineMaskRenderer();
      this._outlineMaskRenderer.prepare(this._engine);
    }
    return this._outlineMaskRenderer;
  }

  private _requireMotionVectorRenderer(): MotionVectorRenderer {
    if (!this._motionVectorRenderer) {
      this._motionVectorRenderer = new MotionVectorRenderer();
      this._motionVectorRenderer.prepare(this._engine);
    }
    return this._motionVectorRenderer;
  }
}
