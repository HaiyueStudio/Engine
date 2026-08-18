import type { IEngine } from '../core/IEngine';
import { requireEngineDevice } from '../core/IEngine';
import type { PostProcessPass } from './PostProcessPass';
import type { PostProcessSceneTextures } from './PostProcessPass';
import { requiredItemAt } from '../math/arrayAccess';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getBuiltinPostprocessShader } from './BuiltinPostprocessShader';

interface PostProcessSurfaceResources {
  readonly buf0: GPUTexture;
  readonly buf0View: GPUTextureView;
  buf1: GPUTexture | null;
  buf1View: GPUTextureView | null;
  lastSeenFrame: number;
}

interface PostProcessSceneAttachments {
  readonly msaaTexture: GPUTexture | null;
  readonly msaaView: GPUTextureView | null;
  readonly depthTexture: GPUTexture;
  readonly depthView: GPUTextureView;
  lastSeenFrame: number;
}

/**
 * Manages the intermediate ping-pong textures used by the post-processing
 * chain and dispatches each pass in order.
 *
 * The scene is rendered into `buf0` by Render3DSystem; then passes run:
 *   buf0 → pass[0] → buf1 (or output)
 *   buf1 → pass[1] → buf0 (or output)
 *   …
 *   last pass → outputView
 */
export class PostProcessRenderer {
  private _engine!: IEngine;
  private _buf0!: GPUTexture;
  private _buf0View!: GPUTextureView;
  private _buf1: GPUTexture | null = null;
  private _buf1View: GPUTextureView | null = null;
  private _sceneMsaaTexture: GPUTexture | null = null;
  private _sceneMsaaView: GPUTextureView | null = null;
  private _sceneDepthTexture: GPUTexture | null = null;
  private _sceneDepthView: GPUTextureView | null = null;
  private _sceneAttachmentKey = '';
  private _surfaceKey = '';
  private readonly _surfaceResources = new Map<string, PostProcessSurfaceResources>();
  private readonly _sceneAttachments = new Map<string, PostProcessSceneAttachments>();
  private _frameId = 0;
  private _retirementScheduledFrame = -1;
  private _width = 0;
  private _height = 0;
  private _format!: GPUTextureFormat;
  private _prepared = false;
  private _preparedPasses = new Set<PostProcessPass>();
  private _presentLayout: GPUBindGroupLayout | null = null;
  private _presentPipeline: GPURenderPipeline | null = null;

  get sceneTexture(): GPUTexture  { return this._buf0; }
  get sceneView():    GPUTextureView { return this._buf0View; }
  get width():  number { return this._width; }
  get height(): number { return this._height; }
  get format(): GPUTextureFormat { return this._format; }

  get sceneDepthView(): GPUTextureView | null { return this._sceneDepthView; }

  /** Registers the submission boundary used to retire view sizes not used by this frame. */
  beginFrame(frameId: number, afterSubmit?: (callback: (queue: GPUQueue) => void) => void): void {
    this._frameId = frameId;
    const activeSurface = this._surfaceResources.get(this._surfaceKey);
    if (activeSurface) activeSurface.lastSeenFrame = frameId;
    const activeAttachments = this._sceneAttachments.get(this._sceneAttachmentKey);
    if (activeAttachments) activeAttachments.lastSeenFrame = frameId;
    if (!afterSubmit || this._retirementScheduledFrame === frameId) return;
    this._retirementScheduledFrame = frameId;
    afterSubmit(queue => {
      const retire = (): void => this._sweepUnusedResources(frameId);
      void queue.onSubmittedWorkDone().then(retire, retire);
    });
  }

  prepare(
    engine: IEngine,
    width = engine.width,
    height = engine.height,
    format: GPUTextureFormat = engine.format,
  ): void {
    if (this._prepared) return;
    this._prepared = true;
    this._engine   = engine;
    this._width    = width;
    this._height   = height;
    this._format   = format;
    this._createBuf0();
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan, passes: readonly PostProcessPass[]): void {
    this._reconcilePreparedPasses(passes);
    const device = requireEngineDevice(this._engine);
    for (const pass of passes) {
      if (!this._preparedPasses.has(pass)) {
        pass.prepare(device, this._format, this._width, this._height);
        this._preparedPasses.add(pass);
      }
      pass.contributePipelineWarmup(plan, device);
    }
  }

  /**
   * Run the chain of passes.
   * @param encoder   The active command encoder for this frame.
   * @param passes    The ordered list of passes to apply.
   * @param outputView  The final destination view (swapchain or RTT color texture).
   */
  run(
    encoder: GPUCommandEncoder,
    passes: PostProcessPass[],
    outputView: GPUTextureView,
    sceneTextures: PostProcessSceneTextures = {},
  ): void {
    this._reconcilePreparedPasses(passes);
    const N = passes.length;
    if (N === 0) {
      if ('beginRenderPass' in encoder) this._present(encoder, outputView);
      return;
    }

    const device = requireEngineDevice(this._engine);
    const format = this._format;

    if (N >= 2 && !this._buf1) {
      this._createBuf1();
    }

    for (let i = 0; i < N; i++) {
      const pass   = requiredItemAt(passes, i, 'post-process passes');
      const isLast = i === N - 1;

      const src     = (i % 2 === 0) ? this._buf0 : this._buf1!;
      const dstView = isLast
        ? outputView
        : ((i % 2 === 0) ? this._buf1View! : this._buf0View);

      if (!this._preparedPasses.has(pass)) {
        pass.prepare(device, format, this._width, this._height);
        this._preparedPasses.add(pass);
      }

      pass.setSceneTextures(sceneTextures);
      pass.apply(encoder, src, dstView, device);
    }
  }

  resize(width: number, height: number, format: GPUTextureFormat = this._format): void {
    if (this._format !== format) {
      this._presentLayout = null;
      this._presentPipeline = null;
    }
    this._width  = width;
    this._height = height;
    this._format = format;
    this._createBuf0();
    if (this._buf1) this._createBuf1();
    this._activateSceneAttachments(null);
    const device = requireEngineDevice(this._engine);
    for (const p of this._preparedPasses) {
      p.resize(device, format, this._width, this._height);
    }
  }

  getScenePassDescriptor(options: {
    sampleCount: 1 | 4;
    reverseZ: boolean;
    clearColor: Readonly<GPUColorDict>;
    loadOp: GPULoadOp;
    depthFormat: GPUTextureFormat;
    preserveMsaa?: boolean;
  }): GPURenderPassDescriptor {
    this._ensureSceneAttachments(options.sampleCount, options.reverseZ, options.depthFormat);
    const colorAttachment: GPURenderPassColorAttachment = this._sceneMsaaView
      ? {
          view: this._sceneMsaaView,
          resolveTarget: this._buf0View,
          clearValue: options.clearColor,
          loadOp: options.loadOp,
          storeOp: options.preserveMsaa ? 'store' : 'discard',
        }
      : {
          view: this._buf0View,
          clearValue: options.clearColor,
          loadOp: options.loadOp,
          storeOp: 'store',
        };
    return {
      colorAttachments: [colorAttachment],
      depthStencilAttachment: {
        view: this._sceneDepthView!,
        depthClearValue: options.reverseZ ? 0 : 1,
        depthLoadOp: options.loadOp === 'load' ? 'load' : 'clear',
        depthStoreOp: 'store',
      },
    };
  }

  /** Copies the resolved opaque scene color into a stable texture for refraction sampling. */
  captureSceneColor(encoder: GPUCommandEncoder): GPUTextureView {
    if (!this._buf1) this._createBuf1();
    encoder.copyTextureToTexture(
      { texture: this._buf0 },
      { texture: this._buf1! },
      [this._width, this._height, 1],
    );
    return this._buf1View!;
  }

  destroy(): void {
    for (const resources of this._surfaceResources.values()) {
      resources.buf0.destroy();
      resources.buf1?.destroy();
    }
    this._surfaceResources.clear();
    this._destroySceneAttachments();
    for (const p of this._preparedPasses) p.destroy();
    this._preparedPasses.clear();
    this._prepared = false;
    this._presentLayout = null;
    this._presentPipeline = null;
    this._buf1 = null;
    this._buf1View = null;
    this._surfaceKey = '';
  }

  private _reconcilePreparedPasses(passes: readonly PostProcessPass[]): void {
    const activePasses = new Set(passes);
    for (const pass of this._preparedPasses) {
      if (activePasses.has(pass)) continue;
      pass.destroy();
      this._preparedPasses.delete(pass);
    }
  }

  private _createBuf0(): void {
    const key = `${this._width}x${this._height}:${this._format}`;
    const cached = this._surfaceResources.get(key);
    if (cached) {
      cached.lastSeenFrame = this._frameId;
      this._surfaceKey = key;
      this._buf0 = cached.buf0;
      this._buf0View = cached.buf0View;
      this._buf1 = cached.buf1;
      this._buf1View = cached.buf1View;
      return;
    }
    const device = requireEngineDevice(this._engine);
    this._buf0 = device.createTexture({
      label: 'PostProcessRenderer.sceneColorTexture',
      size:   [this._width, this._height],
      format: this._format,
      usage:  GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this._buf0View = this._buf0.createView();
    this._surfaceKey = key;
    this._buf1 = null;
    this._buf1View = null;
    this._surfaceResources.set(key, {
      buf0: this._buf0,
      buf0View: this._buf0View,
      buf1: null,
      buf1View: null,
      lastSeenFrame: this._frameId,
    });
  }

  private _createBuf1(): void {
    const resources = this._surfaceResources.get(this._surfaceKey);
    if (!resources) throw new Error('Post-process surface resources are not initialized.');
    if (resources.buf1) {
      this._buf1 = resources.buf1;
      this._buf1View = resources.buf1View;
      return;
    }
    const device = requireEngineDevice(this._engine);
    this._buf1 = device.createTexture({
      label: 'PostProcessRenderer.pingPongTexture',
      size:   [this._width, this._height],
      format: this._format,
      usage:  GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._buf1View = this._buf1.createView();
    resources.buf1 = this._buf1;
    resources.buf1View = this._buf1View;
  }

  private _ensureSceneAttachments(sampleCount: 1 | 4, reverseZ: boolean, depthFormat: GPUTextureFormat): void {
    const key = `${this._width}x${this._height}:${this._format}:${sampleCount}:${reverseZ ? 1 : 0}:${depthFormat}`;
    if (key === this._sceneAttachmentKey) return;
    const cached = this._sceneAttachments.get(key);
    if (cached) {
      cached.lastSeenFrame = this._frameId;
      this._sceneAttachmentKey = key;
      this._activateSceneAttachments(cached);
      return;
    }
    const device = requireEngineDevice(this._engine);
    let msaaTexture: GPUTexture | null = null;
    let msaaView: GPUTextureView | null = null;
    if (sampleCount > 1) {
      msaaTexture = device.createTexture({
        label: 'PostProcessRenderer.sceneMsaaTexture',
        size: [this._width, this._height],
        sampleCount,
        format: this._format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      msaaView = msaaTexture.createView();
    }
    const depthTexture = device.createTexture({
      label: 'PostProcessRenderer.sceneDepthTexture',
      size: [this._width, this._height],
      sampleCount,
      format: depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const attachments = {
      msaaTexture,
      msaaView,
      depthTexture,
      depthView: depthTexture.createView(),
      lastSeenFrame: this._frameId,
    };
    this._sceneAttachments.set(key, attachments);
    this._activateSceneAttachments(attachments);
    this._sceneAttachmentKey = key;
  }

  private _destroySceneAttachments(): void {
    for (const attachments of this._sceneAttachments.values()) {
      attachments.msaaTexture?.destroy();
      attachments.depthTexture.destroy();
    }
    this._sceneAttachments.clear();
    this._activateSceneAttachments(null);
    this._sceneAttachmentKey = '';
  }

  private _activateSceneAttachments(attachments: PostProcessSceneAttachments | null): void {
    this._sceneMsaaTexture = attachments?.msaaTexture ?? null;
    this._sceneMsaaView = attachments?.msaaView ?? null;
    this._sceneDepthTexture = attachments?.depthTexture ?? null;
    this._sceneDepthView = attachments?.depthView ?? null;
  }

  private _sweepUnusedResources(completedFrame: number): void {
    for (const [key, resources] of this._surfaceResources) {
      if (resources.lastSeenFrame >= completedFrame) continue;
      resources.buf0.destroy();
      resources.buf1?.destroy();
      this._surfaceResources.delete(key);
    }
    for (const [key, attachments] of this._sceneAttachments) {
      if (attachments.lastSeenFrame >= completedFrame) continue;
      attachments.msaaTexture?.destroy();
      attachments.depthTexture.destroy();
      this._sceneAttachments.delete(key);
    }
  }

  private _present(encoder: GPUCommandEncoder, outputView: GPUTextureView): void {
    const device = requireEngineDevice(this._engine);
    if (!this._presentLayout || !this._presentPipeline) {
      const shader = getBuiltinPostprocessShader(device, 'present');
      this._presentLayout = shader.bindGroupLayout;
      this._presentPipeline = device.createRenderPipeline({
        label: 'PostProcessRenderer.present',
        layout: shader.pipelineLayout,
        vertex: { module: shader.module, entryPoint: 'vs_main' },
        fragment: { module: shader.module, entryPoint: 'fs_main', targets: [{ format: this._format }] },
        primitive: { topology: 'triangle-list' },
      });
    }
    const bindGroup = device.createBindGroup({
      layout: this._presentLayout,
      entries: [{ binding: 0, resource: this._buf0View }],
    });
    const pass = encoder.beginRenderPass({
      label: 'PostProcessRenderer.present',
      colorAttachments: [{ view: outputView, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(this._presentPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }
}
