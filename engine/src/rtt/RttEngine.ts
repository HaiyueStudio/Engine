import type { IEngine } from '../core/IEngine';
import { requireEngineDevice } from '../core/IEngine';
import {
  getEngineFrameDiagnostics,
  getEngineGPUResourceTracker,
  registerEngineDiagnostics,
} from '../core/EngineDiagnosticsAccess';
import type { RenderViewTarget, RenderViewTargetPassOptions } from '../core/RenderView';
import type { GPUResourceOwner } from '../core/GPUResourceTracker';

let rttEngineId = 0;

interface RttAttachmentSet {
  msaaTexture: GPUTexture | null;
  msaaView: GPUTextureView | null;
  depthTexture: GPUTexture;
  depthView: GPUTextureView;
  colorAttachment: GPURenderPassColorAttachment;
  depthAttachment: GPURenderPassDepthStencilAttachment;
  descriptor: GPURenderPassDescriptor;
}

/**
 * Off-screen engine proxy.
 * Wraps an engine for device/format access but owns its own
 * color + depth (+ optional MSAA) render targets.
 *
 * Pass this to Render3DSystem / Line3DRenderSystem / BitmapTextRenderSystem
 * that live inside an RttTexture world so they render into the off-screen buffer.
 */
export class RttEngine implements IEngine {
  readonly key = `rtt:${++rttEngineId}`;
  private _real: IEngine;
  private _width: number;
  private _height: number;
  private _reverseZ = false;
  private _msaaSamples: 1 | 4 = 1;

  private _clearColor = { r: 0, g: 0, b: 0, a: 1 };

  // The sampleable resolve target — always sampleCount=1
  private _colorTexture!: GPUTexture;
  private _colorView!: GPUTextureView;

  private readonly _attachments = new Map<string, RttAttachmentSet>();
  private _renderPassDescriptorVersion = 0;

  // ── IEngine interface ──────────────────────────────────────────────────────

  get device(): GPUDevice { return this._real.device; }
  get adapter(): GPUAdapter | null { return this._real.adapter ?? null; }
  get context(): GPUCanvasContext | null { return this._real.context ?? null; }
  get canvas(): HTMLCanvasElement | null { return this._real.canvas ?? null; }
  get assetManager() { return this._real.assetManager; }
  get format(): GPUTextureFormat { return this._real.format; }
  get width(): number { return this._width; }
  get height(): number { return this._height; }
  get displayWidth(): number { return this._width; }
  get displayHeight(): number { return this._height; }
  get renderTarget(): RenderViewTarget { return this; }

  get reverseZ(): boolean { return this._reverseZ; }
  set reverseZ(v: boolean) {
    if (this._reverseZ === v) return;
    this._reverseZ = v;
    this._renderPassDescriptorVersion++;
  }

  get msaaSamples(): 1 | 4 { return this._msaaSamples; }
  set msaaSamples(v: 1 | 4) {
    if (this._msaaSamples === v) return;
    this._msaaSamples = v;
    this._renderPassDescriptorVersion++;
  }

  get clearColor(): { r: number; g: number; b: number; a: number } { return this._clearColor; }
  set clearColor(value: { r: number; g: number; b: number; a: number }) {
    if (this._clearColor === value) return;
    this._clearColor = value;
    this._renderPassDescriptorVersion++;
  }

  get depthTextureView(): GPUTextureView { return this._getAttachments(this._msaaSamples, this._reverseZ).depthView; }
  get msaaTextureView(): GPUTextureView | null { return this._getAttachments(this._msaaSamples, this._reverseZ).msaaView; }
  getDepthFormat(reverseZ = this._reverseZ): GPUTextureFormat { return this._real.getDepthFormat(reverseZ); }
  getOutputView(): GPUTextureView { return this._colorView; }

  // ── Extra ──────────────────────────────────────────────────────────────────

  /** The sampleable color texture — use this in BasicMaterial */
  get colorTexture(): GPUTexture { return this._colorTexture; }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  constructor(
    real: IEngine,
    width: number,
    height: number,
    clearColor: { r: number; g: number; b: number; a: number } = { r: 0, g: 0, b: 0, a: 1 },
    private readonly _label = 'RttEngine',
    private readonly _resourceOwner: GPUResourceOwner | null = null,
  ) {
    this._real = real;
    this._width = width;
    this._height = height;
    this.clearColor = clearColor;
    const resourceTracker = getEngineGPUResourceTracker(real);
    const frameDiagnostics = getEngineFrameDiagnostics(real);
    if (resourceTracker && frameDiagnostics) {
      registerEngineDiagnostics(this, { resourceTracker, frameDiagnostics });
    }
    this._createColorTarget();
  }

  resize(width: number, height: number): void {
    this._width = width;
    this._height = height;
    this._colorTexture.destroy();
    this._clearAttachments();
    this._createColorTarget();
  }

  getRenderPassDescriptor(options?: RenderViewTargetPassOptions): GPURenderPassDescriptor {
    const sampleCount = options?.sampleCount ?? this._msaaSamples;
    const reverseZ = options ? options.depthConvention === 'reverse' : this._reverseZ;
    const attachments = this._getAttachments(sampleCount, reverseZ);
    const clearColor = options?.clearColor ?? this.clearColor;
    const colorAttachment = attachments.colorAttachment;
    colorAttachment.clearValue = clearColor;
    colorAttachment.view = attachments.msaaView ?? this._colorView;
    if (attachments.msaaView) colorAttachment.resolveTarget = this._colorView;
    else delete colorAttachment.resolveTarget;
    colorAttachment.storeOp = attachments.msaaView ? 'discard' : 'store';
    attachments.depthAttachment.depthClearValue = reverseZ ? 0.0 : 1.0;
    return attachments.descriptor;
  }

  getRenderPassDescriptorVersion(): number { return this._renderPassDescriptorVersion; }

  destroy(): void {
    this._colorTexture?.destroy();
    this._clearAttachments();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _createColorTarget(): void {
    const { format } = this._real;
    const size: GPUExtent3DStrict = [this._width, this._height];

    // Sampleable resolve target (sampleCount=1)
    this._colorTexture = this._createTexture({
      label: `${this._label}.color`,
      size,
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._colorView = this._colorTexture.createView();
  }

  private _getAttachments(sampleCount: 1 | 4, reverseZ: boolean): RttAttachmentSet {
    const key = `${sampleCount}:${reverseZ ? 1 : 0}`;
    const cached = this._attachments.get(key);
    if (cached) return cached;
    const { format } = this._real;
    const size: GPUExtent3DStrict = [this._width, this._height];
    let msaaTexture: GPUTexture | null = null;
    let msaaView: GPUTextureView | null = null;
    if (sampleCount > 1) {
      msaaTexture = this._createTexture({
        label: `${this._label}.msaa`,
        size,
        format,
        sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      msaaView = msaaTexture.createView();
    }
    const depthTexture = this._createTexture({
      label: `${this._label}.depth.${reverseZ ? 'reverse' : 'standard'}`,
      size,
      sampleCount,
      format: this.getDepthFormat(reverseZ),
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const colorAttachment: GPURenderPassColorAttachment = {
      view: msaaView ?? this._colorView,
      ...(msaaView ? { resolveTarget: this._colorView } : {}),
      clearValue: this.clearColor,
      loadOp: 'clear',
      storeOp: msaaView ? 'discard' : 'store',
    };
    const depthView = depthTexture.createView();
    const depthAttachment: GPURenderPassDepthStencilAttachment = {
      view: depthView,
      depthClearValue: reverseZ ? 0 : 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    };
    const result = {
      msaaTexture,
      msaaView,
      depthTexture,
      depthView,
      colorAttachment,
      depthAttachment,
      descriptor: {
        colorAttachments: [colorAttachment],
        depthStencilAttachment: depthAttachment,
      },
    };
    this._attachments.set(key, result);
    return result;
  }

  private _clearAttachments(): void {
    if (this._attachments.size > 0) this._renderPassDescriptorVersion++;
    for (const attachments of this._attachments.values()) {
      attachments.msaaTexture?.destroy();
      attachments.depthTexture.destroy();
    }
    this._attachments.clear();
  }

  private _createTexture(descriptor: GPUTextureDescriptor): GPUTexture {
    const device = requireEngineDevice(this._real);
    const tracker = this._resourceOwner ? getEngineGPUResourceTracker(this._real) : undefined;
    const previousOwner = tracker && this._resourceOwner ? tracker.enterOwner(this._resourceOwner) : null;
    try {
      return device.createTexture(descriptor);
    } finally {
      if (tracker && this._resourceOwner) tracker.leaveOwner(previousOwner);
    }
  }
}
