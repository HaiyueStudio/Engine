import { estimateTextureBytes, GPUResourceScope, GPUResourceTracker } from './GPUResourceTracker';
import { EngineError, EngineErrorCode } from './EngineError';
import { cloneClearColor } from './EngineDefaults';
import type { RenderViewTarget, RenderViewTargetPassOptions } from './RenderView';
import {
  createWebGpuCompatibilityError,
  WebGpuCompatibilityStatus,
} from './WebGpuCompatibility';

const RESIZE_DEBOUNCE_MS = 80;
let renderTargetManagerId = 0;

interface ViewAttachmentSet {
  msaaTexture: GPUTexture | null;
  msaaView: GPUTextureView | null;
  depthTexture: GPUTexture;
  depthView: GPUTextureView;
  colorAttachment: GPURenderPassColorAttachment;
  depthAttachment: GPURenderPassDepthStencilAttachment;
  descriptor: GPURenderPassDescriptor;
}

export interface RenderTargetManagerOptions {
  canvas: HTMLCanvasElement | null;
  alphaMode: GPUCanvasAlphaMode;
  msaaSamples: 1 | 4;
  reverseZ: boolean;
  clearColor: { r: number; g: number; b: number; a: number };
  devicePixelRatio: number | (() => number);
  gpuResourceTracker: GPUResourceTracker;
  getDepthFormat(reverseZ?: boolean): GPUTextureFormat;
  onResize?(width: number, height: number): void;
}

export class RenderTargetManager implements RenderViewTarget {
  readonly key = `canvas:${++renderTargetManagerId}`;
  private _canvas: HTMLCanvasElement | null;
  private _device: GPUDevice | null = null;
  private _context: GPUCanvasContext | null = null;
  private _format: GPUTextureFormat | null = null;
  private _msaaTexture: GPUTexture | null = null;
  private _msaaTextureView: GPUTextureView | null = null;
  private _depthTexture: GPUTexture | null = null;
  private _depthTextureView: GPUTextureView | null = null;
  private _disposalQueue: GpuDisposalQueue | null = null;
  private _resizeRafId = 0;
  private _resizeDebounceId: ReturnType<typeof setTimeout> | null = null;
  private _displayWidth = 1;
  private _displayHeight = 1;
  private _frameOutputView: GPUTextureView | null = null;
  private readonly _colorAttachment: GPURenderPassColorAttachment;
  private readonly _depthStencilAttachment: GPURenderPassDepthStencilAttachment;
  private readonly _renderPassDescriptor: GPURenderPassDescriptor;
  private _renderPassDescriptorVersion = 0;
  private _msaaSamples: 1 | 4;
  private _reverseZ: boolean;
  private _clearColor: { r: number; g: number; b: number; a: number };
  private _devicePixelRatio: number | (() => number);
  private _resourceScope: GPUResourceScope | null = null;
  private _deviceGeneration = 0;
  private readonly _viewAttachments = new Map<string, ViewAttachmentSet>();

  constructor(private readonly _options: RenderTargetManagerOptions) {
    this._canvas = _options.canvas;
    this._msaaSamples = _options.msaaSamples;
    this._reverseZ = _options.reverseZ;
    this._clearColor = cloneClearColor(_options.clearColor);
    this._devicePixelRatio = _options.devicePixelRatio;
    this._colorAttachment = {
      view: undefined as unknown as GPUTextureView,
      clearValue: this._clearColor,
      loadOp: 'clear',
      storeOp: 'store',
    };
    this._depthStencilAttachment = {
      view: undefined as unknown as GPUTextureView,
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    };
    this._renderPassDescriptor = {
      colorAttachments: [this._colorAttachment],
      depthStencilAttachment: this._depthStencilAttachment,
    };
  }

  get canvas(): HTMLCanvasElement | null { return this._canvas; }
  get context(): GPUCanvasContext | null { return this._context; }
  get width(): number { return this._canvas?.width ?? 0; }
  get height(): number { return this._canvas?.height ?? 0; }
  get displayWidth(): number { return this._displayWidth; }
  get displayHeight(): number { return this._displayHeight; }
  get devicePixelRatio(): number { return this._resolveDevicePixelRatio(); }
  get format(): GPUTextureFormat { return this._requireFormat(); }
  get msaaTextureView(): GPUTextureView | null { return this._msaaTextureView; }
  get depthTextureView(): GPUTextureView { return this._depthTextureView!; }

  configure(device: GPUDevice, format: GPUTextureFormat): void {
    if (this._device) this.suspendForDeviceLoss();
    const canvas = this._requireCanvas();
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) {
      throw createWebGpuCompatibilityError(WebGpuCompatibilityStatus.ContextUnavailable);
    }

    this._device = device;
    this._format = format;
    this._context = context;
    this._disposalQueue = new GpuDisposalQueue(device);
    this._resourceScope = this._options.gpuResourceTracker.createScope(
      'engine',
      `HaiyueEngine.render-targets:${++this._deviceGeneration}`,
    );
    context.configure({
      device,
      format,
      alphaMode: this._options.alphaMode,
    });
    this.resizeToDisplaySize(true);
  }

  attachWindowResize(): void {
    globalThis.window?.addEventListener?.('resize', this._onResize);
  }

  detachWindowResize(): void {
    globalThis.window?.removeEventListener?.('resize', this._onResize);
  }

  setMsaaSamples(value: 1 | 4): void {
    if (this._msaaSamples === value) return;
    this._msaaSamples = value;
    if (this._device) this.createRenderTargets();
  }

  setReverseZ(value: boolean): void {
    if (this._reverseZ === value) return;
    this._reverseZ = value;
    if (this._device) this.createRenderTargets();
  }

  setClearColor(value: { r: number; g: number; b: number; a: number }): void {
    this._clearColor = cloneClearColor(value);
    this._colorAttachment.clearValue = this._clearColor;
  }

  setDevicePixelRatio(value: number | (() => number)): void {
    this._devicePixelRatio = value;
    if (this._device) this.resizeToDisplaySize(true);
  }

  beginFrame(): void {
    this._frameOutputView = null;
  }

  resizeToDisplaySize(force = false): boolean {
    const canvas = this._requireCanvas();
    const rect = canvas.getBoundingClientRect();
    const dpr = this._resolveDevicePixelRatio();
    const displayWidth = rect.width || canvas.clientWidth || canvas.width || 1;
    const displayHeight = rect.height || canvas.clientHeight || canvas.height || 1;
    const width = Math.max(1, Math.floor(displayWidth * dpr));
    const height = Math.max(1, Math.floor(displayHeight * dpr));
    const logicalWidth = Math.max(1, displayWidth);
    const logicalHeight = Math.max(1, displayHeight);

    if (!force && canvas.width === width && canvas.height === height && this._displayWidth === logicalWidth && this._displayHeight === logicalHeight) {
      return false;
    }

    canvas.width = width;
    canvas.height = height;
    this._displayWidth = logicalWidth;
    this._displayHeight = logicalHeight;
    if (this._device) {
      this.createRenderTargets();
      this._options.onResize?.(this.width, this.height);
    }
    return true;
  }

  createRenderTargets(): void {
    const device = this._requireDevice();
    const format = this._requireFormat();
    const canvas = this._requireCanvas();
    const tracker = this._options.gpuResourceTracker;
    if (this._msaaTexture) tracker.untrackTexture(this._msaaTexture);
    if (this._depthTexture) tracker.untrackTexture(this._depthTexture);
    if (this._msaaTexture) this._deferRenderTargetDestroy(this._msaaTexture);
    if (this._depthTexture) this._deferRenderTargetDestroy(this._depthTexture);
    this._clearViewAttachments();
    this._frameOutputView = null;

    const width = Math.max(1, canvas.width);
    const height = Math.max(1, canvas.height);

    if (this._msaaSamples > 1) {
      this._msaaTexture = device.createTexture({
        size: [width, height],
        sampleCount: this._msaaSamples,
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this._resourceScope!.trackTexture(
        this._msaaTexture,
        'HaiyueEngine.msaaTexture',
        estimateTextureBytes([width, height, 1], format, this._msaaSamples),
      );
      this._msaaTextureView = this._msaaTexture.createView();
    } else {
      this._msaaTexture = null;
      this._msaaTextureView = null;
    }

    const depthFormat = this._options.getDepthFormat(this._reverseZ);
    this._depthTexture = device.createTexture({
      size: [width, height],
      sampleCount: this._msaaSamples,
      format: depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._resourceScope!.trackTexture(
      this._depthTexture,
      'HaiyueEngine.depthTexture',
      estimateTextureBytes([width, height, 1], depthFormat, this._msaaSamples),
    );
    this._depthTextureView = this._depthTexture.createView();
  }

  getOutputView(): GPUTextureView {
    if (!this._frameOutputView) this._frameOutputView = this._requireContext().getCurrentTexture().createView();
    return this._frameOutputView;
  }

  getRenderPassDescriptor(options?: RenderViewTargetPassOptions): GPURenderPassDescriptor {
    const sampleCount = options?.sampleCount ?? this._msaaSamples;
    const reverseZ = options ? options.depthConvention === 'reverse' : this._reverseZ;
    if (sampleCount !== this._msaaSamples || reverseZ !== this._reverseZ) {
      return this._getViewRenderPassDescriptor(options!);
    }
    const swapchainView = this.getOutputView();
    const colorAttachment = this._colorAttachment;
    const previousView = colorAttachment.view;
    const previousResolveTarget = colorAttachment.resolveTarget;
    const previousDepthView = this._depthStencilAttachment.view;
    colorAttachment.clearValue = options?.clearColor ?? this._clearColor;
    colorAttachment.loadOp = 'clear';

    if (this._msaaSamples > 1) {
      colorAttachment.view = this._msaaTextureView!;
      colorAttachment.resolveTarget = swapchainView;
      colorAttachment.storeOp = 'store';
    } else {
      colorAttachment.view = swapchainView;
      delete colorAttachment.resolveTarget;
      colorAttachment.storeOp = 'store';
    }

    const depthAttachment = this._depthStencilAttachment;
    depthAttachment.view = this._depthTextureView!;
    depthAttachment.depthClearValue = this._reverseZ ? 0.0 : 1.0;
    depthAttachment.depthLoadOp = 'clear';
    depthAttachment.depthStoreOp = 'store';

    if (
      previousView !== colorAttachment.view ||
      previousResolveTarget !== colorAttachment.resolveTarget ||
      previousDepthView !== depthAttachment.view
    ) {
      this._renderPassDescriptorVersion++;
    }

    return this._renderPassDescriptor;
  }

  getRenderPassDescriptorVersion(_options?: RenderViewTargetPassOptions): number {
    return this._renderPassDescriptorVersion;
  }

  destroy(): void {
    this.detachWindowResize();
    if (this._resizeDebounceId !== null) {
      clearTimeout(this._resizeDebounceId);
      this._resizeDebounceId = null;
    }
    if (this._resizeRafId) {
      cancelAnimationFrame(this._resizeRafId);
      this._resizeRafId = 0;
    }
    this.suspendForDeviceLoss();
    this._canvas = null;
  }

  /** Releases device-bound state while retaining the canvas for recovery. */
  suspendForDeviceLoss(): void {
    this._disposalQueue?.destroyNow();
    this._disposalQueue = null;
    this._clearViewAttachments(false);
    this._resourceScope?.release();
    this._resourceScope = null;
    this._msaaTexture = null;
    this._msaaTextureView = null;
    this._depthTexture = null;
    this._depthTextureView = null;
    this._frameOutputView = null;
    try {
      this._context?.unconfigure();
    } catch {
      // A lost device may invalidate the canvas context before teardown.
    }
    this._context = null;
    this._device = null;
  }

  private _onResize = () => {
    if (this._resizeDebounceId !== null) {
      clearTimeout(this._resizeDebounceId);
    }
    this._resizeDebounceId = setTimeout(() => {
      this._resizeDebounceId = null;
      this._scheduleResizeToDisplaySize();
    }, RESIZE_DEBOUNCE_MS);
  };

  private _scheduleResizeToDisplaySize(): void {
    if (this._resizeRafId) return;
    this._resizeRafId = requestAnimationFrame(() => {
      this._resizeRafId = 0;
      if (this._device && this._canvas) this.resizeToDisplaySize();
    });
  }

  private _deferRenderTargetDestroy(texture: GPUTexture): void {
    const device = this._device;
    if (!device || !this._disposalQueue) {
      texture.destroy();
      return;
    }
    this._disposalQueue.enqueue(texture);
  }

  private _getViewRenderPassDescriptor(options: RenderViewTargetPassOptions): GPURenderPassDescriptor {
    const reverseZ = options.depthConvention === 'reverse';
    const key = `${options.sampleCount}:${reverseZ ? 1 : 0}`;
    let attachments = this._viewAttachments.get(key);
    if (!attachments) {
      attachments = this._createViewAttachments(options.sampleCount, reverseZ, key);
      this._viewAttachments.set(key, attachments);
      this._renderPassDescriptorVersion++;
    }
    const outputView = this.getOutputView();
    attachments.colorAttachment.clearValue = options.clearColor;
    if (attachments.msaaView) {
      attachments.colorAttachment.view = attachments.msaaView;
      attachments.colorAttachment.resolveTarget = outputView;
    } else {
      attachments.colorAttachment.view = outputView;
      delete attachments.colorAttachment.resolveTarget;
    }
    attachments.depthAttachment.depthClearValue = reverseZ ? 0 : 1;
    return attachments.descriptor;
  }

  private _createViewAttachments(sampleCount: 1 | 4, reverseZ: boolean, key: string): ViewAttachmentSet {
    const device = this._requireDevice();
    const format = this._requireFormat();
    const width = Math.max(1, this.width);
    const height = Math.max(1, this.height);
    let msaaTexture: GPUTexture | null = null;
    let msaaView: GPUTextureView | null = null;
    if (sampleCount > 1) {
      msaaTexture = device.createTexture({
        size: [width, height],
        sampleCount,
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this._resourceScope!.trackTexture(
        msaaTexture,
        `HaiyueEngine.renderView[${key}].msaa`,
        estimateTextureBytes([width, height, 1], format, sampleCount),
      );
      msaaView = msaaTexture.createView();
    }
    const depthFormat = this._options.getDepthFormat(reverseZ);
    const depthTexture = device.createTexture({
      size: [width, height],
      sampleCount,
      format: depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._resourceScope!.trackTexture(
      depthTexture,
      `HaiyueEngine.renderView[${key}].depth`,
      estimateTextureBytes([width, height, 1], depthFormat, sampleCount),
    );
    const depthView = depthTexture.createView();
    const colorAttachment: GPURenderPassColorAttachment = {
      view: msaaView ?? (undefined as unknown as GPUTextureView),
      clearValue: this._clearColor,
      loadOp: 'clear',
      storeOp: 'store',
    };
    const depthAttachment: GPURenderPassDepthStencilAttachment = {
      view: depthView,
      depthClearValue: reverseZ ? 0 : 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    };
    return {
      msaaTexture,
      msaaView,
      depthTexture,
      depthView,
      colorAttachment,
      depthAttachment,
      descriptor: { colorAttachments: [colorAttachment], depthStencilAttachment: depthAttachment },
    };
  }

  private _clearViewAttachments(defer = true): void {
    const tracker = this._options.gpuResourceTracker;
    for (const attachments of this._viewAttachments.values()) {
      if (attachments.msaaTexture) tracker.untrackTexture(attachments.msaaTexture);
      tracker.untrackTexture(attachments.depthTexture);
      if (attachments.msaaTexture) {
        if (defer) this._deferRenderTargetDestroy(attachments.msaaTexture);
        else attachments.msaaTexture.destroy();
      }
      if (defer) this._deferRenderTargetDestroy(attachments.depthTexture);
      else attachments.depthTexture.destroy();
    }
    this._viewAttachments.clear();
  }

  private _resolveDevicePixelRatio(): number {
    const raw = typeof this._devicePixelRatio === 'function'
      ? this._devicePixelRatio()
      : this._devicePixelRatio;
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
  }

  private _requireCanvas(): HTMLCanvasElement {
    if (!this._canvas) {
      throw new EngineError(
        EngineErrorCode.EngineDestroyed,
        'HaiyueEngine has been destroyed.',
        {
          hint: 'Create a new HaiyueEngine instead of using an instance after destroy().',
          docsPath: 'errors/E_ENGINE_DESTROYED',
        },
      );
    }
    return this._canvas;
  }

  private _requireDevice(): GPUDevice {
    if (!this._device) {
      throw new EngineError(
        EngineErrorCode.EngineNotInitialized,
        'HaiyueEngine device is not initialized or has been destroyed.',
        {
          hint: 'Call await engine.init() before rendering or allocating GPU resources.',
          docsPath: 'errors/E_ENGINE_NOT_INITIALIZED',
        },
      );
    }
    return this._device;
  }

  private _requireContext(): GPUCanvasContext {
    if (!this._context) {
      throw new EngineError(
        EngineErrorCode.EngineNotInitialized,
        'HaiyueEngine context is not initialized or has been destroyed.',
        {
          hint: 'Call await engine.init() before requesting render pass descriptors or output views.',
          docsPath: 'errors/E_ENGINE_NOT_INITIALIZED',
        },
      );
    }
    return this._context;
  }

  private _requireFormat(): GPUTextureFormat {
    if (!this._format) {
      throw new EngineError(
        EngineErrorCode.EngineNotInitialized,
        'HaiyueEngine render target format is not initialized.',
        {
          hint: 'Call await engine.init() before creating render targets.',
          docsPath: 'errors/E_ENGINE_NOT_INITIALIZED',
        },
      );
    }
    return this._format;
  }
}

class GpuDisposalQueue {
  private readonly _pending = new Set<GPUTexture>();
  private readonly _inFlight = new Set<GPUTexture>();
  private readonly _destroyed = new WeakSet<GPUTexture>();
  private _scheduled = false;

  constructor(private readonly _device: GPUDevice) {}

  enqueue(texture: GPUTexture): void {
    if (this._destroyed.has(texture)) return;
    this._pending.add(texture);
    this._schedule();
  }

  destroyNow(): void {
    for (const texture of this._pending) this._destroyTexture(texture);
    for (const texture of this._inFlight) this._destroyTexture(texture);
    this._pending.clear();
    this._inFlight.clear();
    this._scheduled = false;
  }

  private _schedule(): void {
    if (this._scheduled || this._pending.size === 0) return;
    this._scheduled = true;
    const textures = [...this._pending];
    this._pending.clear();
    for (const texture of textures) this._inFlight.add(texture);
    void this._device.queue.onSubmittedWorkDone()
      .then(() => {
        for (const texture of textures) this._destroyTexture(texture);
      })
      .catch(() => {
        for (const texture of textures) this._destroyTexture(texture);
      })
      .finally(() => {
        for (const texture of textures) this._inFlight.delete(texture);
        this._scheduled = false;
        this._schedule();
      });
  }

  private _destroyTexture(texture: GPUTexture): void {
    if (this._destroyed.has(texture)) return;
    this._destroyed.add(texture);
    try {
      texture.destroy();
    } catch {
      // Device may already be lost/destroyed during teardown.
    }
  }
}
