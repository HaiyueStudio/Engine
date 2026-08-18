import type {
  FrameDiagnostics,
  GpuPassTimingSnapshot,
  GpuPassTimingType,
} from './FrameDiagnostics';

const MAX_GPU_TIMED_PASSES = 128;
const GPU_TIMING_READBACK_SLOTS = 3;
const TIMESTAMP_BYTE_SIZE = 8;

export interface GpuPassTimingLabel {
  readonly type: GpuPassTimingType;
  readonly label: string;
}

export interface GpuPassTimingRecorder {
  setNextPass(label: GpuPassTimingLabel): void;
  decorateRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassDescriptor;
  decorateComputePass(descriptor?: GPUComputePassDescriptor): GPUComputePassDescriptor;
  resolve(encoder: GPUCommandEncoder): void;
  afterSubmit(): void;
  cancel(): void;
}

interface GpuPassTimingReadbackSlot {
  readonly buffer: GPUBuffer;
  state: 'idle' | 'reserved' | 'mapping';
}

interface PendingGpuPassTiming {
  readonly index: number;
  readonly type: GpuPassTimingType;
  readonly label: string;
}

/** Diagnostics-only timestamp query owner. It never blocks submission or reuses a mapped buffer. */
export class GpuPassProfiler {
  private readonly _querySet: GPUQuerySet;
  private readonly _resolveBuffer: GPUBuffer;
  private readonly _slots: GpuPassTimingReadbackSlot[];
  private _nextSlot = 0;
  private _destroyed = false;

  constructor(
    readonly device: GPUDevice,
    private readonly _diagnostics: FrameDiagnostics,
  ) {
    const byteSize = MAX_GPU_TIMED_PASSES * 2 * TIMESTAMP_BYTE_SIZE;
    this._querySet = device.createQuerySet({
      label: 'RenderPipeline.gpuPassTiming.queries',
      type: 'timestamp',
      count: MAX_GPU_TIMED_PASSES * 2,
    });
    this._resolveBuffer = device.createBuffer({
      label: 'RenderPipeline.gpuPassTiming.resolve',
      size: byteSize,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this._slots = new Array(GPU_TIMING_READBACK_SLOTS).fill(null).map((_, index) => ({
      buffer: device.createBuffer({
        label: `RenderPipeline.gpuPassTiming.readback.${index}`,
        size: byteSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      state: 'idle' as const,
    }));
  }

  beginFrame(frame: number): GpuPassTimingRecorder | null {
    if (this._destroyed) return null;
    for (let offset = 0; offset < this._slots.length; offset++) {
      const index = (this._nextSlot + offset) % this._slots.length;
      const slot = this._slots[index]!;
      if (slot.state !== 'idle') continue;
      slot.state = 'reserved';
      this._nextSlot = (index + 1) % this._slots.length;
      return new GpuPassTimingFrameRecorder(
        frame,
        this._querySet,
        this._resolveBuffer,
        slot,
        this._diagnostics,
      );
    }
    return null;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._querySet.destroy();
    this._resolveBuffer.destroy();
    for (const slot of this._slots) slot.buffer.destroy();
  }
}

class GpuPassTimingFrameRecorder implements GpuPassTimingRecorder {
  private readonly _passes: PendingGpuPassTiming[] = [];
  private _nextPass: GpuPassTimingLabel | null = null;
  private _resolved = false;
  private _submitted = false;
  private _truncated = false;

  constructor(
    private readonly _frame: number,
    private readonly _querySet: GPUQuerySet,
    private readonly _resolveBuffer: GPUBuffer,
    private readonly _slot: GpuPassTimingReadbackSlot,
    private readonly _diagnostics: FrameDiagnostics,
  ) {}

  setNextPass(label: GpuPassTimingLabel): void {
    this._nextPass = label;
  }

  decorateRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassDescriptor {
    const label = this._takeLabel('render', descriptor.label);
    if (descriptor.timestampWrites) return descriptor;
    const timestampWrites = this._allocateTimestampWrites(label);
    return timestampWrites ? { ...descriptor, timestampWrites } : descriptor;
  }

  decorateComputePass(descriptor: GPUComputePassDescriptor = {}): GPUComputePassDescriptor {
    const label = this._takeLabel('compute', descriptor.label);
    if (descriptor.timestampWrites) return descriptor;
    const timestampWrites = this._allocateTimestampWrites(label);
    return timestampWrites ? { ...descriptor, timestampWrites } : descriptor;
  }

  resolve(encoder: GPUCommandEncoder): void {
    if (this._resolved) return;
    this._resolved = true;
    const queryCount = this._passes.length * 2;
    if (queryCount === 0) {
      this.cancel();
      return;
    }
    const byteSize = queryCount * TIMESTAMP_BYTE_SIZE;
    encoder.resolveQuerySet(this._querySet, 0, queryCount, this._resolveBuffer, 0);
    encoder.copyBufferToBuffer(this._resolveBuffer, 0, this._slot.buffer, 0, byteSize);
  }

  afterSubmit(): void {
    if (this._submitted || this._slot.state !== 'reserved' || this._passes.length === 0) return;
    this._submitted = true;
    this._slot.state = 'mapping';
    const byteSize = this._passes.length * 2 * TIMESTAMP_BYTE_SIZE;
    void this._slot.buffer.mapAsync(GPUMapMode.READ, 0, byteSize)
      .then(() => {
        const timestamps = new BigUint64Array(this._slot.buffer.getMappedRange(0, byteSize)).slice();
        const snapshots: GpuPassTimingSnapshot[] = this._passes.map((pass, index) => {
          const start = timestamps[index * 2] ?? 0n;
          const end = timestamps[index * 2 + 1] ?? 0n;
          const durationNs = end > start ? end - start : 0n;
          return {
            index: pass.index,
            type: pass.type,
            label: pass.label,
            durationMs: Number(durationNs) / 1_000_000,
          };
        });
        this._diagnostics.setGpuPassDurations(this._frame, snapshots, this._truncated);
      })
      .catch(() => {})
      .finally(() => {
        safeUnmap(this._slot.buffer);
        this._slot.state = 'idle';
      });
  }

  cancel(): void {
    if (this._slot.state === 'reserved') this._slot.state = 'idle';
  }

  private _takeLabel(type: GpuPassTimingType, descriptorLabel: string | undefined): GpuPassTimingLabel {
    const next = this._nextPass;
    this._nextPass = null;
    if (next) return next;
    return { type, label: descriptorLabel?.trim() || `${type}-pass-${this._passes.length}` };
  }

  private _allocateTimestampWrites(label: GpuPassTimingLabel): GPURenderPassTimestampWrites | null {
    if (this._passes.length >= MAX_GPU_TIMED_PASSES) {
      this._truncated = true;
      return null;
    }
    const index = this._passes.length;
    this._passes.push({ index, type: label.type, label: label.label });
    return {
      querySet: this._querySet,
      beginningOfPassWriteIndex: index * 2,
      endOfPassWriteIndex: index * 2 + 1,
    };
  }
}

function safeUnmap(buffer: GPUBuffer): void {
  try {
    buffer.unmap();
  } catch {
    // mapAsync may reject during device loss or profiler destruction.
  }
}
