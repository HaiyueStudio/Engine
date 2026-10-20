import type { RenderCommandContext } from '../core/RenderCommandContext';
import { FrameRingResource } from './FrameRingResource';
import { DEFERRED_LIGHTING_ABI as ABI } from '../shaders/generated/deferred-lighting-abi.generated';
import { validateDeferredView, type DeferredLightSource, type DeferredLightView } from '../frame/DeferredLightTable';

interface Slot {
  readonly index: number;
  key: object | undefined;
  bytes: Uint8Array<ArrayBuffer>;
  readonly encoders: Set<GPUCommandEncoder>;
}

/** Immutable records protected until submission; buffers retire after GPU completion. */
export class DeferredImmutableBufferArena {
  private readonly _ring: FrameRingResource<GPUBuffer>;
  private readonly _slots: Slot[] = [];
  private readonly _keys = new WeakMap<object, Slot>();
  private readonly _bufferEncoders = new Map<GPUBuffer, Set<GPUCommandEncoder>>();
  private readonly _retiredBuffers = new Set<GPUBuffer>();
  private _destroyed = false;
  private _released = false;
  readonly stride: number;
  uploadCount = 0;
  uploadBytes = 0;

  constructor(private readonly _device: GPUDevice, label: string, byteSize: number, usage: GPUBufferUsageFlags) {
    const alignment = Math.max(_device.limits.minStorageBufferOffsetAlignment, _device.limits.minUniformBufferOffsetAlignment, 16);
    this.stride = Math.ceil(byteSize / alignment) * alignment;
    this._ring = new FrameRingResource({ label, framesInFlight: 1, initialCapacity: 4,
      maximumCapacity: Math.floor(_device.limits.maxBufferSize / this.stride),
      create: info => _device.createBuffer({ label, size: info.capacity * this.stride, usage: usage | GPUBufferUsage.COPY_DST }),
      destroy: buffer => this._retireBuffer(buffer),
    });
  }

  acquire(key: object, bytes: Uint8Array<ArrayBuffer>, context: RenderCommandContext): GPUBufferBinding {
    if (this._destroyed) throw new Error('Deferred light arena is destroyed.');
    if (context.device !== this._device) throw new Error('Deferred light arena device generation mismatch.');
    if (bytes.byteLength > this.stride) throw new RangeError('Deferred light arena record exceeds its ABI capacity.');
    // A submit hook is essential: queue completion before a pending encoder submits cannot retire its slots.
    if (!context.afterSubmit) throw new Error('Deferred light arena requires an afterSubmit lifecycle hook.');
    let slot = this._keys.get(key);
    if (!slot) {
      slot = this._slots.find(candidate => candidate.encoders.size === 0);
      if (!slot) {
        const index = this._slots.length;
        if (this._ring.ensureCapacity(index + 1, context)) {
          for (const previous of this._slots) if (previous.key) this._write(previous);
        }
        slot = { index, key: undefined, bytes, encoders: new Set() };
        this._slots.push(slot);
      }
      if (slot.key) this._keys.delete(slot.key);
      slot.key = key;
      // Own the uploaded bytes so caller scratch reuse cannot corrupt growth restoration.
      slot.bytes = bytes.slice();
      this._keys.set(key, slot);
      this._write(slot);
    }
    if (!slot.encoders.has(context.encoder)) {
      slot.encoders.add(context.encoder);
      const selected = slot;
      context.afterSubmit(() => {
        // queue.writeBuffer issued after submit is ordered after that submission.
        // Only unsubmitted encoders need immutable slots; completion notification
        // timing must not change offsets or create new bind groups each frame.
        selected.encoders.delete(context.encoder);
        this._finishDestroy();
      });
    }
    this._ring.markUsed();
    const buffer = this._ring.resource;
    let encoders = this._bufferEncoders.get(buffer);
    if (!encoders) { encoders = new Set(); this._bufferEncoders.set(buffer, encoders); }
    if (!encoders.has(context.encoder)) {
      encoders.add(context.encoder);
      const pending = encoders;
      context.afterSubmit(queue => {
        const done = () => {
          pending.delete(context.encoder);
          if (this._retiredBuffers.has(buffer)) this._retireBuffer(buffer);
        };
        void queue.onSubmittedWorkDone().then(done, done);
      });
    }
    return { buffer, offset: slot.index * this.stride, size: bytes.byteLength };
  }

  destroy(): void { this._destroyed = true; this._finishDestroy(); }

  /** Device loss means pending command buffers can never execute. */
  abandon(): void {
    for (const slot of this._slots) slot.encoders.clear();
    for (const encoders of this._bufferEncoders.values()) encoders.clear();
    for (const buffer of this._retiredBuffers) this._retireBuffer(buffer);
    this.destroy();
  }

  private _retireBuffer(buffer: GPUBuffer): void {
    if (this._bufferEncoders.get(buffer)?.size) { this._retiredBuffers.add(buffer); return; }
    this._retiredBuffers.delete(buffer);
    this._bufferEncoders.delete(buffer);
    buffer.destroy();
  }

  private _finishDestroy(): void {
    if (!this._destroyed || this._released || this._slots.some(slot => slot.encoders.size)) return;
    this._released = true;
    this._ring.destroy();
    this._slots.length = 0;
  }

  private _write(slot: Slot): void {
    this._device.queue.writeBuffer(this._ring.resource, slot.index * this.stride, slot.bytes);
    this.uploadCount++;
    this.uploadBytes += slot.bytes.byteLength;
  }
}

/** One device/World source arena, independently keyed per-view records. No source upload on camera changes. */
export class DeferredLightGpuTable {
  private readonly _source: DeferredImmutableBufferArena;
  private readonly _views: DeferredImmutableBufferArena;
  private readonly _viewBytes = new WeakMap<DeferredLightView, Uint8Array<ArrayBuffer>>();
  readonly indexOffset: number;

  constructor(device: GPUDevice) {
    this.indexOffset = Math.ceil(ABI.blocks.viewHeader.byteSize / device.limits.minStorageBufferOffsetAlignment) * device.limits.minStorageBufferOffsetAlignment;
    this._source = new DeferredImmutableBufferArena(device, 'DeferredLights.source',
      ABI.blocks.sourceHeader.byteSize + (ABI.maxPoints + ABI.maxDirectionals) * ABI.blocks.light.byteSize, GPUBufferUsage.STORAGE);
    this._views = new DeferredImmutableBufferArena(device, 'DeferredLights.view', this.indexOffset + ABI.maxPoints * 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE);
  }

  bind(source: DeferredLightSource, view: DeferredLightView, context: RenderCommandContext): {
    source: GPUBufferBinding; header: GPUBufferBinding; indices: GPUBufferBinding;
  } {
    validateDeferredView(view, source);
    // Runtime-sized arrays require at least one record in the binding, even for zero lights.
    let sourceBytes = new Uint8Array(source.bytes);
    if (!source.records.length) {
      sourceBytes = new Uint8Array(ABI.blocks.sourceHeader.byteSize + ABI.blocks.light.byteSize);
      sourceBytes.set(new Uint8Array(source.bytes));
    }
    let bytes = this._viewBytes.get(view);
    if (!bytes) {
      bytes = new Uint8Array(this.indexOffset + Math.max(1, view.pointIndices.length) * 4);
      bytes.set(new Uint8Array(view.header));
      bytes.set(new Uint8Array(view.pointIndices.buffer), this.indexOffset);
      this._viewBytes.set(view, bytes);
    }
    const sourceBinding = this._source.acquire(source, sourceBytes, context);
    const viewBinding = this._views.acquire(view, bytes, context);
    return {
      source: sourceBinding,
      header: { ...viewBinding, size: ABI.blocks.viewHeader.byteSize },
      indices: { buffer: viewBinding.buffer, offset: viewBinding.offset! + this.indexOffset, size: Math.max(4, view.pointIndices.byteLength) },
    };
  }

  get stats() {
    return { sourceUploads: this._source.uploadCount, sourceUploadBytes: this._source.uploadBytes,
      viewUploads: this._views.uploadCount, viewUploadBytes: this._views.uploadBytes };
  }
  destroy(): void { this._source.destroy(); this._views.destroy(); }
  abandon(): void { this._source.abandon(); this._views.abandon(); }
}
