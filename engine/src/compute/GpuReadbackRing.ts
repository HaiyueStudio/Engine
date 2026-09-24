import type { RenderCommandContext } from '../core/RenderCommandContext';
export interface GpuReadbackResult {
  readonly requestId: number;
  readonly generation: number;
  readonly token: unknown;
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly bytes: Uint8Array | null;
  readonly error?: unknown;
}
interface Slot { buffer: GPUBuffer; state: 'idle' | 'reserved' | 'mapping'; cancel?: () => void; }
/** Bounded, nonblocking diagnostics/checkpoint readback. A busy ring returns
 * null: callers may skip diagnostics, never logical simulation work. */
export class GpuReadbackRing {
  private slots: Slot[];
  private generation = 0;
  private nextId = 0;
  private destroyed = false;
  private cursor = 0;
  private counters = { requested: 0, skipped: 0, completed: 0, cancelled: 0, failed: 0, copiedBytes: 0 };
  constructor(readonly device: GPUDevice, readonly byteCapacity: number, slotCount = 3) {
    if (!Number.isSafeInteger(byteCapacity) || byteCapacity < 4 || byteCapacity % 4 || byteCapacity > (device.limits?.maxBufferSize ?? Infinity)) throw new RangeError('Readback capacity must be aligned, positive and within device limits.');
    if (!Number.isSafeInteger(slotCount) || slotCount < 1 || slotCount > 16) throw new RangeError('Readback ring requires 1–16 slots.');
    this.slots = Array.from({ length: slotCount }, (_, i) => ({ buffer: device.createBuffer({ label: `GpuReadbackRing.${i}`, size: byteCapacity, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), state: 'idle' }));
  }
  get stats() { return Object.freeze({ ...this.counters, pending: this.slots.filter(s => s.state !== 'idle').length, generation: this.generation }); }
  request(context: RenderCommandContext, source: GPUBuffer, offset: number, size: number, token?: unknown): Promise<GpuReadbackResult> | null {
    if (this.destroyed) throw new Error('Readback ring is destroyed.');
    if (context.device !== this.device || !context.afterSubmit || context.passEncoder) throw new Error('Readback requires same-device context, afterSubmit and no active render pass.');
    if (![offset, size].every(Number.isSafeInteger) || offset < 0 || size < 4 || offset % 4 || size % 4 || size > this.byteCapacity || offset + size > source.size || !(source.usage & GPUBufferUsage.COPY_SRC)) throw new RangeError('Invalid readback range or source usage.');
    this.counters.requested++;
    const slot = Array.from({ length: this.slots.length }, (_, i) => this.slots[(this.cursor + i) % this.slots.length]!).find(s => s.state === 'idle');
    if (!slot) { this.counters.skipped++; return null; }
    this.cursor = (this.slots.indexOf(slot) + 1) % this.slots.length;
    slot.state = 'reserved';
    const requestId = ++this.nextId, generation = this.generation;
    let resolved = false;
    let resolve!: (result: GpuReadbackResult) => void;
    const promise = new Promise<GpuReadbackResult>(r => { resolve = r; });
    const finish = (status: GpuReadbackResult['status'], bytes: Uint8Array | null, error?: unknown) => {
      if (resolved) return;
      resolved = true; this.counters[status]++;
      resolve({ requestId, generation, token, status, bytes, ...(error === undefined ? {} : { error }) });
    };
    slot.cancel = () => finish('cancelled', null);
    try {
      context.encoder.copyBufferToBuffer(source, offset, slot.buffer, 0, size);
      this.counters.copiedBytes += size;
      context.afterSubmit(() => {
        slot.state = 'mapping';
        void Promise.resolve().then(() => slot.buffer.mapAsync(GPUMapMode.READ, 0, size)).then(() => {
          if (this.destroyed || generation !== this.generation) finish('cancelled', null);
          else finish('completed', new Uint8Array(slot.buffer.getMappedRange(0, size)).slice());
        }).catch(error => finish(this.destroyed || generation !== this.generation ? 'cancelled' : 'failed', null, error))
          .finally(() => {
            try { slot.buffer.unmap(); } catch { /* device loss */ }
            slot.state = 'idle'; delete slot.cancel;
            if (this.destroyed) slot.buffer.destroy();
          });
      });
    } catch (error) { slot.state = 'idle'; delete slot.cancel; finish('failed', null, error); }
    return promise;
  }
  /** Invalidates pending publications without reusing a reserved/mapped slot. */
  invalidate(): void { this.generation++; for (const slot of this.slots) slot.cancel?.(); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.invalidate();
    for (const slot of this.slots) if (slot.state === 'idle') slot.buffer.destroy();
  }
}
