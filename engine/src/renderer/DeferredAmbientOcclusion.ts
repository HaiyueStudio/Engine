import { DeferredLightingCapabilityError } from '../frame/DeferredLightTable';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { PostProcessPass, PostProcessSceneTextures } from '../postprocess/PostProcessPass';
import { getLightingAmbientOcclusion } from '../postprocess/LightingAmbientOcclusion';
import { getDeferredAllocationBudget, type DeferredAllocationBudget } from './DeferredAllocationBudget';
import { deferredAoStorage, DEFERRED_AO_LAYOUT_VERSION } from './DeferredViewMemory';

export interface DeferredAmbientOcclusionInput {
  readonly passes: readonly PostProcessPass[];
  prepare(): PostProcessSceneTextures;
}
interface Slot {
  readonly viewKey: string;
  readonly width: number;
  readonly height: number;
  readonly sources: readonly PostProcessPass[];
  readonly passes: readonly PostProcessPass[];
  readonly textures: readonly GPUTexture[];
  readonly views: readonly GPUTextureView[];
  readonly buffer: GPUBuffer;
  readonly bytesPerRow: number;
  readonly releaseAllocation: () => void;
  readonly pending: Set<GPUCommandEncoder>;
  readonly encoders: Set<GPUCommandEncoder>;
  retired: boolean;
}

/** AO visibility travels in a storage buffer: layered PBR already uses all 16 sampled textures. */
export class DeferredAmbientOcclusion {
  readonly neutral: GPUBufferBinding;
  private readonly _slots = new Set<Slot>();
  private readonly _neutralEncoders = new Set<GPUCommandEncoder>();
  private _destroyed = false;
  private _neutralReleased = false;
  private readonly _releaseNeutralAllocation: () => void;

  constructor(private readonly _device: GPUDevice, private readonly _budget: DeferredAllocationBudget = getDeferredAllocationBudget(_device)) {
    this._releaseNeutralAllocation = _budget.reserve(260);
    try { this.neutral = { buffer: _device.createBuffer({ label: 'DeferredAO.neutral', size: 260, usage: GPUBufferUsage.STORAGE }) }; }
    catch (error) { this._releaseNeutralAllocation(); throw error; }
  }

  countSources(input?: DeferredAmbientOcclusionInput): number {
    return input?.passes.reduce((count, pass) => count + (getLightingAmbientOcclusion(pass) ? 1 : 0), 0) ?? 0;
  }

  record(context: RenderCommandContext, viewKey: string, width: number, height: number,
    input?: DeferredAmbientOcclusionInput): GPUBufferBinding {
    if (this._destroyed || context.device !== this._device) throw new Error('Deferred AO owner is unavailable.');
    if (!context.afterSubmit) throw new Error('Deferred AO requires an afterSubmit lifecycle hook.');
    const sources = input?.passes.filter(pass => getLightingAmbientOcclusion(pass)) ?? [];
    const liveViews = context.viewFamily ? new Set(context.viewFamily.views.map(view => view.key)) : null;
    for (const slot of this._slots) {
      if ((liveViews && !liveViews.has(slot.viewKey)) || (slot.viewKey === viewKey &&
        (slot.width !== width || slot.height !== height || !sameSources(slot.sources, sources)))) this._retire(slot);
    }
    if (!sources.length) {
      if (!this._neutralEncoders.has(context.encoder)) {
        this._neutralEncoders.add(context.encoder);
        context.afterSubmit(queue => {
          const done = () => { this._neutralEncoders.delete(context.encoder); this._releaseNeutral(); };
          void queue.onSubmittedWorkDone().then(done, done);
        });
      }
      return this.neutral;
    }
    const visibilityBytes = deferredAoStorage(width, height, sources.length).bufferBytes;
    const capacity = Math.min(this._device.limits.maxBufferSize, this._device.limits.maxStorageBufferBindingSize);
    if (visibilityBytes > capacity) throw new DeferredLightingCapabilityError('ao-visibility-bytes', visibilityBytes, capacity);
    let slot = [...this._slots].find(s => !s.retired && s.viewKey === viewKey && s.width === width && s.height === height
      && !s.pending.size && sameSources(s.sources, sources));
    if (!slot) {
      const views = new Set([...this._slots].map(s => s.viewKey)); views.add(viewKey);
      if (views.size > 4) throw new DeferredLightingCapabilityError('ao-view-count', views.size, 4);
      const generations = [...this._slots].filter(s => s.viewKey === viewKey).length + 1;
      if (generations > 2) throw new DeferredLightingCapabilityError('ao-live-generations', generations, 2);
      slot = this._create(viewKey, width, height, sources); this._slots.add(slot);
    }
    const selected = slot;
    selected.pending.add(context.encoder); selected.encoders.add(context.encoder);
    context.afterSubmit(queue => {
      selected.pending.delete(context.encoder);
      const done = () => { selected.encoders.delete(context.encoder); if (selected.retired) this._retire(selected); };
      void queue.onSubmittedWorkDone().then(done, done);
    });
    const scene = input!.prepare();
    if (!scene.depth || !scene.normal || !scene.frame) throw new Error('Deferred AO requires prepared depth, normal and frame data.');
    for (const [index, pass] of selected.passes.entries()) {
      getLightingAmbientOcclusion(sources[index]!)!.configure(pass, index === 0);
      pass.setSceneTextures(scene);
      try {
        // The first pass ignores source color in occlusion display mode; subsequent AO passes multiply visibility.
        const source = index === 0 ? scene.normal : selected.textures[(index - 1) % 2]!;
        pass.apply(context.encoder, source, selected.views[index % 2]!, this._device);
        getLightingAmbientOcclusion(sources[index]!)!.recorded?.(pass);
      } finally { pass.setSceneTextures({}); }
    }
    context.encoder.copyTextureToBuffer({ texture: selected.textures[(sources.length - 1) % 2]! },
      { buffer: selected.buffer, offset: 256, bytesPerRow: selected.bytesPerRow }, [width, height]);
    return { buffer: selected.buffer };
  }

  destroy(abandon = false): void {
    this._destroyed = true;
    for (const slot of this._slots) { if (abandon) { slot.encoders.clear(); slot.pending.clear(); } this._retire(slot); }
    if (abandon) this._neutralEncoders.clear();
    this._releaseNeutral();
  }

  private _create(viewKey: string, width: number, height: number, sources: readonly PostProcessPass[]): Slot {
    const { bytesPerRow, bufferBytes, bytes } = deferredAoStorage(width, height, sources.length);
    const releaseAllocation = this._budget.reserve(bytes);
    let buffer: GPUBuffer | undefined;
    const textures: GPUTexture[] = [], passes: PostProcessPass[] = [];
    let views: GPUTextureView[];
    try {
      buffer = this._device.createBuffer({ label: 'DeferredAO.visibility', size: bufferBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
      new Uint32Array(buffer.getMappedRange(), 0, 4).set([width, height, bytesPerRow / 4, DEFERRED_AO_LAYOUT_VERSION]); buffer.unmap();
      for (let i = 0; i < Math.min(2, sources.length); i++) textures.push(this._device.createTexture({
        label: `DeferredAO.visibility:${i}`, size: [width, height], format: 'r16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      }));
      for (const source of sources) {
        const pass = getLightingAmbientOcclusion(source)!.create();
        passes.push(pass); pass.prepare(this._device, 'r16float', width, height);
      }
      views = textures.map(t => t.createView());
    } catch (error) {
      for (const pass of passes) pass.destroy();
      for (const texture of textures) texture.destroy();
      buffer?.destroy(); releaseAllocation(); throw error;
    }
    return { viewKey, width, height, sources, passes, textures, views, buffer: buffer!, bytesPerRow, releaseAllocation,
      pending: new Set(), encoders: new Set(), retired: false };
  }
  private _retire(slot: Slot): void {
    slot.retired = true;
    if (slot.encoders.size) return;
    for (const pass of slot.passes) pass.destroy();
    for (const texture of slot.textures) texture.destroy();
    slot.buffer.destroy(); slot.releaseAllocation(); this._slots.delete(slot);
  }
  private _releaseNeutral(): void {
    if (this._destroyed && !this._neutralReleased && !this._neutralEncoders.size) {
      this.neutral.buffer.destroy(); this._neutralReleased = true;
      this._releaseNeutralAllocation();
    }
  }
}
function sameSources(a: readonly PostProcessPass[], b: readonly PostProcessPass[]): boolean {
  return a.length === b.length && a.every((pass, index) => pass === b[index]);
}
