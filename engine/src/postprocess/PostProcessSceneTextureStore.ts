import type { IEngine } from '../core/IEngine';

export interface PostProcessSceneTextureRequirements {
  depth: boolean;
  normal: boolean;
  motion?: boolean;
  outlineMask: boolean;
  auxDepth?: boolean;
}

export class PostProcessSceneTextureStore {
  depthTexture: GPUTexture | null = null;
  depthView: GPUTextureView | null = null;
  normalTexture: GPUTexture | null = null;
  normalView: GPUTextureView | null = null;
  motionTexture: GPUTexture | null = null;
  motionView: GPUTextureView | null = null;
  outlineMaskTexture: GPUTexture | null = null;
  outlineMaskView: GPUTextureView | null = null;
  outlineVisibleMaskTexture: GPUTexture | null = null;
  outlineVisibleMaskView: GPUTextureView | null = null;
  outlineVisibleMaskMsaaTexture: GPUTexture | null = null;
  outlineVisibleMaskMsaaView: GPUTextureView | null = null;
  auxDepthTexture: GPUTexture | null = null;
  auxDepthView: GPUTextureView | null = null;

  private _width = 0;
  private _height = 0;
  private _reverseZ = false;
  private _sampleCount: 1 | 4 = 1;

  ensure(
    engine: IEngine,
    requirements: PostProcessSceneTextureRequirements,
    reverseZ: boolean,
    surface: { width: number; height: number; format: GPUTextureFormat; sampleCount?: 1 | 4 } = engine,
  ): void {
    const { device } = engine;
    const { width, height, format } = surface;
    const sampleCount = surface.sampleCount ?? engine.msaaSamples;
    const sizeChanged = width !== this._width
      || height !== this._height
      || reverseZ !== this._reverseZ
      || sampleCount !== this._sampleCount;

    if (sizeChanged) {
      this.destroy();
      this._width = width;
      this._height = height;
      this._reverseZ = reverseZ;
      this._sampleCount = sampleCount;
    }

    if (requirements.depth && !this.depthTexture) {
      this.depthTexture = this._createColorTexture(device, width, height, 'r32float', 'PostProcessSceneTextureStore.depthTexture');
      this.depthView = this.depthTexture.createView();
    }

    if (requirements.normal && !this.normalTexture) {
      this.normalTexture = this._createColorTexture(device, width, height, 'rgba16float', 'PostProcessSceneTextureStore.normalTexture');
      this.normalView = this.normalTexture.createView();
    }

    if (requirements.motion && !this.motionTexture) {
      this.motionTexture = device.createTexture({
        label: 'PostProcessSceneTextureStore.motionTexture',
        size: [width, height],
        format: 'rg16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.motionView = this.motionTexture.createView();
    }

    if (requirements.outlineMask && !this.outlineMaskTexture) {
      this.outlineMaskTexture = this._createColorTexture(device, width, height, format, 'PostProcessSceneTextureStore.outlineMaskTexture');
      this.outlineMaskView = this.outlineMaskTexture.createView();
    }

    if (requirements.outlineMask && !this.outlineVisibleMaskTexture) {
      this.outlineVisibleMaskTexture = this._createColorTexture(device, width, height, format, 'PostProcessSceneTextureStore.outlineVisibleMaskTexture');
      this.outlineVisibleMaskView = this.outlineVisibleMaskTexture.createView();
    }

    if (requirements.outlineMask && sampleCount > 1 && !this.outlineVisibleMaskMsaaTexture) {
      this.outlineVisibleMaskMsaaTexture = device.createTexture({
        label: 'PostProcessSceneTextureStore.outlineVisibleMaskMsaaTexture',
        size: [width, height],
        sampleCount,
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.outlineVisibleMaskMsaaView = this.outlineVisibleMaskMsaaTexture.createView();
    }

    if (requirements.auxDepth && !this.auxDepthTexture) {
      this.auxDepthTexture = device.createTexture({
        label: 'PostProcessSceneTextureStore.auxDepthTexture',
        size: [width, height],
        format: engine.getDepthFormat(reverseZ),
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.auxDepthView = this.auxDepthTexture.createView();
    }
  }

  destroy(): void {
    this.depthTexture?.destroy();
    this.normalTexture?.destroy();
    this.motionTexture?.destroy();
    this.outlineMaskTexture?.destroy();
    this.outlineVisibleMaskTexture?.destroy();
    this.outlineVisibleMaskMsaaTexture?.destroy();
    this.auxDepthTexture?.destroy();
    this.depthTexture = null;
    this.depthView = null;
    this.normalTexture = null;
    this.normalView = null;
    this.motionTexture = null;
    this.motionView = null;
    this.outlineMaskTexture = null;
    this.outlineMaskView = null;
    this.outlineVisibleMaskTexture = null;
    this.outlineVisibleMaskView = null;
    this.outlineVisibleMaskMsaaTexture = null;
    this.outlineVisibleMaskMsaaView = null;
    this.auxDepthTexture = null;
    this.auxDepthView = null;
  }

  private _createColorTexture(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
    label: string,
  ): GPUTexture {
    return device.createTexture({
      label,
      size: [width, height],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }
}
