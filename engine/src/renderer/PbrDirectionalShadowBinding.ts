import { SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS } from '../frame/SceneRenderEnvironment';
import type { DirectionalShadowState } from './ShadowMapRenderer';
import { writeBuffer } from './utils';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { RecordedGpuResources } from './RecordedGpuResources';
import { retainDirectionalShadowView } from './DirectionalShadowResources';

const FLOATS_PER_SLOT = 20;
const BUFFER_BYTES = FLOATS_PER_SLOT * SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS * 4;

/** Owns the fixed PBR directional-shadow array binding and its packed uniform ABI. */
export class PbrDirectionalShadowBinding {
  buffer: GPUBuffer;
  private readonly recorded: RecordedGpuResources;
  readonly data = new Float32Array(BUFFER_BYTES / 4);
  private readonly _uploadedData = new Float32Array(BUFFER_BYTES / 4);
  view: GPUTextureView;
  sampler: GPUSampler;
  private _uploadedSlotSpan = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly defaultView: GPUTextureView,
    private readonly defaultSampler: GPUSampler,
  ) {
    this.recorded = new RecordedGpuResources(device);
    this.buffer = this.createBuffer();
    this.view = defaultView;
    this.sampler = defaultSampler;
  }

  update(shadows: readonly (DirectionalShadowState | null)[]): boolean {
    const first = shadows.find((shadow): shadow is DirectionalShadowState => shadow !== null);
    const view = first?.arrayView ?? first?.view ?? this.defaultView;
    const sampler = first?.sampler ?? this.defaultSampler;
    let bindingsChanged = this.view !== view || this.sampler !== sampler;
    this.view = view;
    this.sampler = sampler;
    this.data.fill(0);
    let activeSlotSpan = 0;
    for (let index = 0; index < SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS; index++) {
      const shadow = shadows[index] ?? null;
      const base = index * FLOATS_PER_SLOT;
      if (shadow) {
        this.data.set(shadow.lightViewProjection, base);
        activeSlotSpan = index + 1;
      }
      else writeIdentity(this.data, base);
      this.data[base + 16] = shadow?.enabled ? (shadow.layer ?? index) + 1 : 0;
      this.data[base + 17] = shadow?.bias ?? 0;
      this.data[base + 18] = shadow?.normalBias ?? 0;
      this.data[base + 19] = shadow ? 1 / shadow.mapSize : 1;
    }
    // Upload only the active prefix. When the shadow count shrinks, include the
    // previously uploaded suffix once so stale enabled slots are cleared.
    const uploadSlotSpan = Math.max(activeSlotSpan, this._uploadedSlotSpan);
    const uploadFloatCount = uploadSlotSpan * FLOATS_PER_SLOT;
    let changed = false;
    for (let index = 0; index < uploadFloatCount; index++) {
      if (!Object.is(this.data[index], this._uploadedData[index])) { changed = true; break; }
    }
    // A shadow-map redraw advances the scene revision even if its sampling
    // matrix and parameters are unchanged. Only upload changed uniform bytes.
    if (changed) {
      const fork = this.recorded.pending(this.buffer);
      if (fork) {
        const previous = this.buffer;
        this.buffer = this.createBuffer();
        this.recorded.retire(previous);
        bindingsChanged = true;
      }
      writeBuffer(
        this.device.queue,
        this.buffer,
        0,
        this.data,
        0,
        fork ? BUFFER_BYTES : uploadSlotSpan * FLOATS_PER_SLOT * 4,
      );
      for (let index = 0; index < (fork ? this.data.length : uploadFloatCount); index++) this._uploadedData[index] = this.data[index]!;
    }
    this._uploadedSlotSpan = activeSlotSpan;
    return bindingsChanged;
  }

  destroy(): void {
    this.recorded.retireAll();
  }

  retain(context?: RenderCommandContext): void {
    this.recorded.retain(this.buffer, context);
    retainDirectionalShadowView(this.view, context);
  }

  private createBuffer(): GPUBuffer {
    const buffer = this.device.createBuffer({ label: 'PbrRenderer.shadow', size: BUFFER_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return this.recorded.own(buffer, () => buffer.destroy());
  }
}

function writeIdentity(target: Float32Array, offset: number): void {
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 15] = 1;
}
