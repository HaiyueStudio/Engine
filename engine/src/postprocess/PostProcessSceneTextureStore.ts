import type { IEngine } from '../core/IEngine';

export interface PostProcessSceneTextureRequirements {
  depth: boolean;
  normal: boolean;
  motion?: boolean;
  outlineMask: boolean;
  auxDepth?: boolean;
}

const TEXTURE_KEYS = [
  'depthTexture', 'normalTexture', 'motionTexture', 'outlineMaskTexture',
  'outlineVisibleMaskTexture', 'outlineVisibleMaskMsaaTexture', 'auxDepthTexture',
] as const;
const VIEW_KEYS = [
  'depthView', 'normalView', 'motionView', 'outlineMaskView',
  'outlineVisibleMaskView', 'outlineVisibleMaskMsaaView', 'auxDepthView',
] as const;

type SceneTextureResources = Record<typeof TEXTURE_KEYS[number], GPUTexture | null>
  & Record<typeof VIEW_KEYS[number], GPUTextureView | null>
  & { lastSeenEpoch: number };

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

  private readonly _resources = new Map<string, SceneTextureResources>();
  private _activeKey = '';
  private _frameId: number | undefined;
  private _epoch = 0;
  private _retirementScheduledEpoch = -1;
  private _generation = 0;

  /** Without a submission boundary, cached textures stay alive until destroy(). */
  beginFrame(frameId: number, afterSubmit?: (callback: (queue: GPUQueue) => void) => void): void {
    if (frameId !== this._frameId) {
      this._frameId = frameId;
      this._epoch++;
    }
    if (!afterSubmit || this._retirementScheduledEpoch === this._epoch) return;
    const epoch = this._epoch;
    const generation = this._generation;
    this._retirementScheduledEpoch = epoch;
    afterSubmit(queue => {
      if (generation !== this._generation) return;
      const retire = (): void => {
        if (generation !== this._generation) return;
        this._sweepUnusedResources(epoch);
      };
      void queue.onSubmittedWorkDone().then(retire, retire);
    });
  }

  ensure(
    engine: IEngine,
    requirements: PostProcessSceneTextureRequirements,
    reverseZ: boolean,
    surface: { width: number; height: number; format: GPUTextureFormat; sampleCount?: 1 | 4 } = engine,
  ): void {
    const { device } = engine;
    const { width, height, format } = surface;
    const sampleCount = surface.sampleCount ?? engine.msaaSamples;
    const depthFormat = engine.getDepthFormat(reverseZ);
    const key = `${width}x${height}:${format}:${sampleCount}:${reverseZ ? 1 : 0}:${depthFormat}`;
    let resources = this._resources.get(key);
    if (key !== this._activeKey) {
      this._activateResources(resources);
      this._activeKey = key;
    }
    if (!resources) {
      resources = {
        depthTexture: null, depthView: null,
        normalTexture: null, normalView: null,
        motionTexture: null, motionView: null,
        outlineMaskTexture: null, outlineMaskView: null,
        outlineVisibleMaskTexture: null, outlineVisibleMaskView: null,
        outlineVisibleMaskMsaaTexture: null, outlineVisibleMaskMsaaView: null,
        auxDepthTexture: null, auxDepthView: null,
        lastSeenEpoch: this._epoch,
      };
      this._resources.set(key, resources);
    }
    resources.lastSeenEpoch = this._epoch;

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
        format: 'rgba16float',
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
        format: depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.auxDepthView = this.auxDepthTexture.createView();
    }
    for (const property of TEXTURE_KEYS) resources[property] = this[property];
    for (const property of VIEW_KEYS) resources[property] = this[property];
  }

  destroy(): void {
    this._generation++;
    for (const resources of this._resources.values()) this._destroyResources(resources);
    this._resources.clear();
    this._activateResources();
    this._activeKey = '';
    this._frameId = undefined;
    this._retirementScheduledEpoch = -1;
  }

  private _activateResources(resources?: SceneTextureResources): void {
    for (const property of TEXTURE_KEYS) this[property] = resources?.[property] ?? null;
    for (const property of VIEW_KEYS) this[property] = resources?.[property] ?? null;
  }

  private _destroyResources(resources: SceneTextureResources): void {
    for (const property of TEXTURE_KEYS) resources[property]?.destroy();
  }

  private _sweepUnusedResources(completedEpoch: number): void {
    for (const [key, resources] of this._resources) {
      // A later frame may have reused this set while queue completion was pending.
      if (resources.lastSeenEpoch >= completedEpoch) continue;
      this._destroyResources(resources);
      this._resources.delete(key);
      if (key === this._activeKey) {
        this._activateResources();
        this._activeKey = '';
      }
    }
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
