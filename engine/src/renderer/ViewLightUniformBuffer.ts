import type { RenderCommandContext } from '../core/RenderCommandContext';
import { SCENE_RENDER_MAX_LIGHTS, type PbrLightInfo } from '../frame/SceneRenderEnvironment';
import { getSceneFrameUniformSnapshotMetadata, type SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import {isSceneFrameUniformStreamRetired} from '../frame/SceneFrameUniformLifetime';
import {SubmissionLifetime} from '../rtt/SubmissionLifetime';
import {EngineError,EngineErrorCode} from '../core/EngineError';
import { FrameRingResource } from './FrameRingResource';
import { writeBuffer } from './utils';

export const LIGHT_UNIFORM_BYTES = 16 + SCENE_RENDER_MAX_LIGHTS * 64;
export const LIGHT_UNIFORM_BINDING = Object.freeze({
  type: 'uniform' as const, hasDynamicOffset: true, minBindingSize: LIGHT_UNIFORM_BYTES,
});

interface Slot {
  readonly index: number;
  readonly data: Float32Array;
  readonly lifetime: SubmissionLifetime;
  readonly recordings: WeakSet<object>;
  reusable: boolean;
  valid: boolean;
  encoder: GPUCommandEncoder | undefined;
}

interface ViewSlots {
  readonly slots: Slot[];
  lastEpoch: number;
}

/** Renderer-owned light records. Stable views retain offsets; each encoded view reads its own bytes. */
export class ViewLightUniformBuffer {
  readonly dynamicOffset = new Uint32Array(1);
  private readonly _ring: FrameRingResource<GPUBuffer>;
  private readonly _views = new Map<object, ViewSlots>();
  private readonly _free: number[] = [];
  private readonly _scratch = new Float32Array(LIGHT_UNIFORM_BYTES / 4);
  private readonly _u32 = new Uint32Array(this._scratch.buffer);
  private readonly _stride: number;
  private readonly _fallback: Slot;
  private _slot: Slot;
  private _nextSlot = 0;
  private _epoch = 0;
  private _encoder: GPUCommandEncoder | undefined;
  private _context: RenderCommandContext | undefined;
  private _destroyed = false;
  uploadCount = 0;

  constructor(private readonly _device: GPUDevice, label: string) {
    const alignment = _device.limits?.minUniformBufferOffsetAlignment ?? 256;
    this._stride = Math.ceil(LIGHT_UNIFORM_BYTES / alignment) * alignment;
    this._ring = new FrameRingResource({
      label,
      initialCapacity: 32,
      maximumCapacity: Math.floor(Number(_device.limits?.maxBufferSize ?? 268435456) / this._stride),
      framesInFlight: 1,
      create: info => _device.createBuffer({
        label, size: info.capacity * this._stride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      destroy: buffer => buffer.destroy(),
    });
    this._fallback = this._slot = this._createSlot();
  }

  get buffer(): GPUBuffer { return this._ring.resource; }
  get viewCount(): number { return this._views.size; }

  selectView(snapshot: SceneFrameUniformSnapshot, context?: RenderCommandContext): boolean {
    const previousBuffer = this.buffer;
    this._context = context;
    if (context?.encoder !== this._encoder) {
      this._encoder = context?.encoder;
      this._epoch++;
      this._sweep();
    }
    const metadata = getSceneFrameUniformSnapshotMetadata(snapshot);
    const stream = metadata?.stream ?? snapshot;
    if (isSceneFrameUniformStreamRetired(stream)) throw new EngineError(EngineErrorCode.ResourceOwnerReleased, 'Light uniform snapshot owner has retired.');
    let view = this._views.get(stream);
    if (!view) { view = { slots: [], lastEpoch: this._epoch }; this._views.set(stream, view); }
    view.lastEpoch = this._epoch;
    const region = metadata ? (metadata.revision - 1) % 3 : 0;
    this._slot = view.slots[region] ?? (view.slots[region] = this._createSlot(context));
    this.dynamicOffset[0] = this._slot.index * this._stride;
    this._retainSlot(this._slot);
    this._ring.markUsed();
    return previousBuffer !== this.buffer;
  }

  upload(lights: readonly PbrLightInfo[]): void {
    packLights(this._scratch, this._u32, lights);
    let slot = this._slot;
    const changed = !slot.valid || !equalData(slot.data, this._scratch);
    // More than three phase revisions may be recorded before one submit. Never overwrite an encoded record.
    if (changed && slot.valid && this._context && slot.encoder === this._context.encoder) {
      slot = this._slot = this._createSlot(this._context);
      this.dynamicOffset[0] = slot.index * this._stride;
      this._retainSlot(slot);
      this._retireSlots([slot]);
    }
    if (changed) {
      writeBuffer(this._device.queue, this.buffer, slot.index * this._stride, this._scratch);
      slot.data.set(this._scratch);
      slot.valid = true;
      this.uploadCount++;
    }
    this._retainSlot(slot);
    slot.encoder = this._context?.encoder;
    this._ring.markUsed();
  }

  destroy(): void {
    this._destroyed = true;
    this._views.clear(); this._free.length = 0;
    this._context = undefined; this._encoder = undefined;
    this._ring.destroy();
  }

  private _createSlot(context?: RenderCommandContext): Slot {
    const index = this._free.pop() ?? this._nextSlot++;
    if (this._ring.ensureCapacity(index + 1, context)) {
      // Restore cached records into the new generation at the growth boundary.
      // Old encoded bindings retain the retiring buffer. Invalidating all view
      // regions instead spreads unchanged-light uploads over subsequent frames.
      this._restoreSlot(this._fallback);
      for (const view of this._views.values()) for (const slot of view.slots) if (slot) this._restoreSlot(slot);
    }
    const slot: Slot = { index, data: new Float32Array(this._scratch.length), valid: false, encoder: undefined, reusable: true, recordings: new WeakSet<object>(),
      lifetime: new SubmissionLifetime(this._device, () => { if (!this._destroyed && slot.reusable) this._free.push(index); }),
    };
    return slot;
  }

  private _restoreSlot(slot: Slot): void {
    if (!slot.valid) return;
    writeBuffer(this._device.queue, this.buffer, slot.index * this._stride, slot.data);
    this.uploadCount++;
    // The new generation has not encoded this slot yet.
    slot.encoder = undefined;
  }

  private _sweep(): void {
    for (const [stream, view] of this._views) {
      if (!isSceneFrameUniformStreamRetired(stream) && this._epoch - view.lastEpoch <= 120) continue;
      this._views.delete(stream);
      this._retireSlots(view.slots.filter(Boolean));
    }
  }

  private _retainSlot(slot: Slot): void {
    const context = this._context;
    if (context?.afterSubmit) {
      const token = context.encoder ?? context;
      if (slot.recordings.has(token)) return;
      slot.lifetime.retainSubmission(token,
        callback => context.afterSubmit!(callback),
        context.afterCancel ? callback => context.afterCancel!(callback) : undefined);
      slot.recordings.add(token);
    } else {
      // Legacy recordings lack a safe completion boundary. Keep their indices owned.
      slot.reusable = false;
    }
  }

  private _retireSlots(slots: readonly Slot[]): void {
    for (const slot of slots) slot.lifetime.retire();
  }
}

function equalData(a: Float32Array, b: Float32Array): boolean {
  for (let index = 0; index < a.length; index++) if (!Object.is(a[index], b[index])) return false;
  return true;
}

function packLights(out: Float32Array, u32: Uint32Array, lights: readonly PbrLightInfo[]): void {
  out.fill(0);
  const count = Math.min(SCENE_RENDER_MAX_LIGHTS, lights.length);
  u32[0] = count;
  for (let index = 0; index < count; index++) {
    const light = lights[index]!, base = 4 + index * 16;
    u32[base] = light.type;
    out.set(light.color, base + 4); out[base + 7] = light.intensity;
    out.set(light.direction, base + 8);
    out.set(light.position, base + 12); out[base + 15] = light.range;
  }
}
