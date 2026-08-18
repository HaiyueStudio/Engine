import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { RenderViewSnapshot } from '../core/RenderView';
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
import { PostProcessSceneTextureStore } from '../postprocess/PostProcessSceneTextureStore';
import { DepthRenderer } from '../renderer/DepthRenderer';
import { NormalRenderer } from '../renderer/NormalRenderer';
import { OutlineMaskRenderer } from '../renderer/OutlineMaskRenderer';
import { MotionVectorRenderer } from '../renderer/MotionVectorRenderer';
import type { LiveIdSet } from '../renderer/utils';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { ClippingPlanes } from '../components/ClippingPlanes';

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
  private readonly _sceneTextures = new PostProcessSceneTextureStore();
  private readonly _depthMaterial = new DepthMaterial();
  private readonly _normalMaterial = new NormalMaterial({ space: 'view' });
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

  constructor(private readonly _engine: IEngine) {}

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
    normal.contributePipelineWarmup(plan);

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
      motion.contributePipelineWarmup(plan);
    }

    if (passes.length > 0) {
      if (!this._postRenderer) {
        this._postRenderer = new PostProcessRenderer();
        this._postRenderer.prepare(this._engine);
      }
      this._postRenderer.contributePipelineWarmup(plan, passes);
    }
  }

  prepare(
    passes: readonly PostProcessPass[],
    context: RenderCommandContext,
    reverseZ: boolean,
    needsSceneColorCapture = false,
  ): Render3DPostSceneRequirements {
    const requirements = this.getRequirements(passes, needsSceneColorCapture);
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
        'Render3DSystem.record() cannot use an external open pass when post-processing is enabled.',
        {
          hint: 'Register this Render3DSystem as an isolated render pipeline entry, or disable post-processing for shared-pass rendering.',
          docsPath: 'errors/E_RENDER_PIPELINE_INVALID_PASS_STATE',
        },
      );
    }

    const surface = context.view?.target ?? this._engine;
    if (!this._postRenderer) {
      this._postRenderer = new PostProcessRenderer();
      this._postRenderer.prepare(this._engine, surface.width, surface.height, surface.format);
    } else if (
      this._postRenderer.width !== surface.width ||
      this._postRenderer.height !== surface.height ||
      this._postRenderer.format !== surface.format
    ) {
      this._postRenderer.resize(surface.width, surface.height, surface.format);
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
        width: surface.width,
        height: surface.height,
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
    requirements.usePostProcess = passes.length > 0 || needsSceneColorCapture;
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

    return postRenderer.getScenePassDescriptor({
      sampleCount: view?.sampleCount ?? this._engine.msaaSamples,
      reverseZ,
      clearColor: view?.clearColor ?? this._engine.clearColor,
      loadOp,
      depthFormat: this._engine.getDepthFormat(reverseZ),
      preserveMsaa,
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
    context: RenderCommandContext;
    requirements: Render3DPostSceneRequirements;
    live: Render3DPostSceneLiveSets;
  }): void {
    const { requirements } = options;
    if (!requirements.needsDepth && !requirements.needsNormal && !requirements.needsMotion && !requirements.needsOutlineMask) return;
    const textures = this._sceneTextures;
    const depthAttachment = () => ({
      view: textures.auxDepthView!,
      depthClearValue: options.reverseZ ? 0.0 : 1.0,
      depthLoadOp: 'clear' as GPULoadOp,
      depthStoreOp: 'discard' as GPUStoreOp,
    });

    if (requirements.needsDepth && textures.depthView) {
      const renderer = this._requireDepthRenderer();
      this._depthMaterial.near = options.camera.near;
      this._depthMaterial.far = options.camera.far;
      this._depthMaterial.isOrthographic = options.camera.projectionType === 'orthographic';
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
      for (const { entityId, geometry, clippingPlanes, worldMatrix } of options.items) {
        if (!geometry || !worldMatrix) continue;
        options.live.depthEntities.add(entityId);
        options.live.depthGeometries.add(geometry.id);
        options.live.depthMaterials.add(this._depthMaterial.id);
        renderer.render(pass, entityId, geometry, this._depthMaterial, worldMatrix, {}, clippingPlanes);
      }
      pass.end();
    }

    if (requirements.needsNormal && textures.normalView) {
      const renderer = this._requireNormalRenderer();
      renderer.reverseZ = options.reverseZ;
      renderer.msaaSamples = 1;
      renderer.beginView(options.sceneFrameUniforms);
      const pass = options.encoder.beginRenderPass({
        label: 'Render3DSystem.postNormalPass',
        colorAttachments: [{
          view: textures.normalView,
          clearValue: { r: 0.5, g: 0.5, b: 1, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
        depthStencilAttachment: depthAttachment(),
      });
      for (const { entityId, geometry, clippingPlanes, worldMatrix } of options.items) {
        if (!geometry || !worldMatrix) continue;
        options.live.normalEntities.add(entityId);
        options.live.normalGeometries.add(geometry.id);
        options.live.normalMaterials.add(this._normalMaterial.id);
        renderer.render(pass, entityId, geometry, this._normalMaterial, worldMatrix, {}, clippingPlanes);
      }
      pass.end();
    }

    if (requirements.needsMotion && textures.motionView) {
      const renderer = this._requireMotionVectorRenderer();
      renderer.reverseZ = options.reverseZ;
      const viewOptions = {
        viewKey: options.viewKey,
        frameId: options.frameId,
        cameraId: options.cameraId,
        historyRevision: options.motionHistoryRevision,
      };
      renderer.beginView(options.sceneFrameUniforms, viewOptions, options.context);
      const pass = options.encoder.beginRenderPass({
        label: 'Render3DSystem.postMotionVectorPass',
        colorAttachments: [{
          view: textures.motionView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
        depthStencilAttachment: depthAttachment(),
      });
      // Transparent coverage requires material-specific alpha handling. The
      // first velocity ABI deliberately starts with opaque rigid meshes.
      for (const { entityId, geometry, clippingPlanes, worldMatrix } of options.motionItems) {
        if (!geometry || !worldMatrix) continue;
        options.live.motionGeometries.add(geometry.id);
        renderer.render(pass, entityId, geometry, worldMatrix, clippingPlanes);
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
      for (const { entityId, geometry, clippingPlanes, worldMatrix } of options.outlineItems) {
        if (!geometry || !worldMatrix) continue;
        options.live.outlineEntities.add(entityId);
        options.live.outlineGeometries.add(geometry.id);
        renderer.render(pass, entityId, geometry, worldMatrix, {}, clippingPlanes);
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
        for (const { entityId, geometry, clippingPlanes, worldMatrix } of options.outlineItems) {
          if (!geometry || !worldMatrix) continue;
          options.live.outlineEntities.add(entityId);
          options.live.outlineGeometries.add(geometry.id);
          renderer.render(visiblePass, entityId, geometry, worldMatrix, { depthWrite: false }, clippingPlanes);
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
    this._postRenderer.run(encoder, passes, outputView, {
      depth: requirements.needsDepth ? this._sceneTextures.depthTexture ?? undefined : undefined,
      normal: requirements.needsNormal ? this._sceneTextures.normalTexture ?? undefined : undefined,
      motion: requirements.needsMotion ? this._sceneTextures.motionTexture ?? undefined : undefined,
      outlineMask: requirements.needsOutlineMask ? this._sceneTextures.outlineMaskTexture ?? undefined : undefined,
      outlineVisibleMask: requirements.needsOutlineMask ? this._sceneTextures.outlineVisibleMaskTexture ?? undefined : undefined,
      frame,
    });
  }

  releaseRendererCaches(live: Render3DPostSceneLiveSets): void {
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

  destroy(): void {
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
