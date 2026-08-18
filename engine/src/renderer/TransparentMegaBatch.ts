import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { GpuSortComputePass } from '../compute/GpuSortComputePass';
import { recordComputeResourcePass } from '../compute/ComputeResourceAccess';
import { alignUp } from '../utils/align';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { compareTransparentDepthBackToFront, quantizeTransparentDepthBackToFront } from './DepthSortPolicy';

const SORT_KEY_PADDING = 0xffffffff;
const TRANSPARENT_SORT_KEY_WORDS = 5;

export interface TransparentMegaBatchEntry<T> {
  payload: T;
  entityId: number;
  materialId: number;
  rendererKey: number;
  viewDepth: number;
  transparentOrder: number;
  depthSort: boolean;
}

export interface TransparentMegaBatchRun<T> {
  rendererKey: number;
  materialId: number;
  start: number;
  count: number;
  entries: readonly TransparentMegaBatchEntry<T>[];
}

interface TransparentMegaBatchSlot<T> extends TransparentMegaBatchEntry<T> {}

export class TransparentMegaBatch<T> {
  readonly label: string;

  private readonly _engine: IEngine | null;
  private readonly _entries: TransparentMegaBatchSlot<T>[] = [];
  private readonly _sortedIndices: number[] = [];
  private readonly _sortedIndicesScratch: number[] = [];
  private readonly _runs: TransparentMegaBatchRun<T>[] = [];
  private readonly _runPool: TransparentMegaBatchRun<T>[] = [];
  private readonly _compareSortedIndices = (aIndex: number, bIndex: number): number => {
    const a = this._entries[aIndex];
    const b = this._entries[bIndex];
    return a && b ? compareEntries(a, b) : a ? -1 : b ? 1 : 0;
  };
  private _gpuCapacity = 0;
  private _gpuPaddedCapacity = 0;
  private _sortKeyBuffer: GPUBuffer | null = null;
  private _sortIndexBuffer: GPUBuffer | null = null;
  private _sortIndexReadbackBuffer: GPUBuffer | null = null;
  private _sortKeyData = new Uint32Array(0);
  private _sortIndexData = new Uint32Array(0);
  private _lastGpuSortedIndices = new Uint32Array(0);
  private _gpuReadbackPending = false;
  private _count = 0;

  constructor(engine: IEngine | null = null, label = 'TransparentMegaBatch') {
    this._engine = engine;
    this.label = label;
  }

  get count(): number {
    return this._count;
  }

  get gpuPaddedCapacity(): number {
    return this._gpuPaddedCapacity;
  }

  get sortKeyBuffer(): GPUBuffer {
    if (!this._sortKeyBuffer) throwTransparentResourceNotReady(`${this.label}.sortKeyBuffer accessed before uploadGpu().`);
    return this._sortKeyBuffer;
  }

  get sortIndexBuffer(): GPUBuffer {
    if (!this._sortIndexBuffer) throwTransparentResourceNotReady(`${this.label}.sortIndexBuffer accessed before uploadGpu().`);
    return this._sortIndexBuffer;
  }

  get entries(): readonly TransparentMegaBatchEntry<T>[] {
    return this._entries;
  }

  get runs(): readonly TransparentMegaBatchRun<T>[] {
    return this._runs;
  }

  clear(): void {
    for (let i = 0; i < this._count; i++) {
      const entry = this._entries[i];
      if (entry) entry.payload = null as T;
    }
    this._count = 0;
    this._runs.length = 0;
  }

  push(entry: TransparentMegaBatchEntry<T>): void {
    let slot = this._entries[this._count];
    if (!slot) {
      slot = {
        payload: entry.payload,
        entityId: entry.entityId,
        materialId: entry.materialId,
        rendererKey: entry.rendererKey,
        viewDepth: entry.viewDepth,
        transparentOrder: entry.transparentOrder,
        depthSort: entry.depthSort,
      };
      this._entries.push(slot);
    } else {
      slot.payload = entry.payload;
      slot.entityId = entry.entityId;
      slot.materialId = entry.materialId;
      slot.rendererKey = entry.rendererKey;
      slot.viewDepth = entry.viewDepth;
      slot.transparentOrder = entry.transparentOrder;
      slot.depthSort = entry.depthSort;
    }
    this._sortedIndices[this._count] = this._count;
    this._count++;
  }

  sort(): void {
    this._sortedIndices.length = this._count;
    for (let i = 0; i < this._count; i++) this._sortedIndices[i] = i;
    this._sortIndicesWithoutAllocating();
    this._rebuildRuns();
  }

  uploadGpu(engine: IEngine | null = this._engine): boolean {
    if (!engine?.device || this._count < 1) return false;
    this._ensureGpuCapacity(engine, this._count);
    if (!this._sortKeyBuffer || !this._sortIndexBuffer) return false;
    this._sortKeyData.fill(SORT_KEY_PADDING, 0, this._gpuPaddedCapacity * TRANSPARENT_SORT_KEY_WORDS);
    this._sortIndexData.fill(SORT_KEY_PADDING, 0, this._gpuPaddedCapacity);
    for (let i = 0; i < this._count; i++) {
      const entry = this._entries[i];
      if (!entry) continue;
      packGpuSortKey(entry, this._sortKeyData, i * TRANSPARENT_SORT_KEY_WORDS);
      this._sortIndexData[i] = i;
    }
    engine.device.queue.writeBuffer(
      this._sortKeyBuffer,
      0,
      this._sortKeyData.buffer as ArrayBuffer,
      this._sortKeyData.byteOffset,
      this._gpuPaddedCapacity * TRANSPARENT_SORT_KEY_WORDS * 4,
    );
    engine.device.queue.writeBuffer(
      this._sortIndexBuffer,
      0,
      this._sortIndexData.buffer as ArrayBuffer,
      this._sortIndexData.byteOffset,
      this._gpuPaddedCapacity * 4,
    );
    return true;
  }

  sortGpu(context: RenderCommandContext, sortPass: GpuSortComputePass): boolean {
    if (this._count <= 1 || !this._sortKeyBuffer || !this._sortIndexBuffer) return false;
    const token = sortPass.sort(context, {
      sortKeyBuffer: this._sortKeyBuffer,
      sortIndexBuffer: this._sortIndexBuffer,
      count: this._count,
      paddedCapacity: this._gpuPaddedCapacity,
      keyWords: TRANSPARENT_SORT_KEY_WORDS,
    });
    if (token) {
      recordComputeResourcePass(context, {
        label: 'TransparentMegaBatch.sortedIndexConsumption',
        path: 'TransparentMegaBatch.sortedIndexConsumption',
        after: [token],
        accesses: [{ resource: this._sortIndexBuffer, use: 'copy-read', path: 'TransparentMegaBatch.sortedIndexConsumption.sortIndexBuffer' }],
      });
    }
    return true;
  }

  requestGpuSortedIndexReadback(context: RenderCommandContext): boolean {
    if (!context.afterSubmit || !this._sortIndexBuffer || !this._sortIndexReadbackBuffer || this._count < 1 || this._gpuReadbackPending) return false;
    const byteLength = this._count * 4;
    context.encoder.copyBufferToBuffer(this._sortIndexBuffer, 0, this._sortIndexReadbackBuffer, 0, byteLength);
    this._gpuReadbackPending = true;
    const readback = this._sortIndexReadbackBuffer;
    const count = this._count;
    context.afterSubmit(() => {
      void readback.mapAsync(GPUMapMode.READ)
        .then(() => {
          const mapped = new Uint32Array(readback.getMappedRange());
          const next = new Uint32Array(count);
          let write = 0;
          for (let i = 0; i < count; i++) {
            const index = mapped[i];
            if (index !== undefined && index < count) next[write++] = index;
          }
          this._lastGpuSortedIndices = write === count ? next : next.slice(0, write);
        })
        .catch(() => {
          this._lastGpuSortedIndices = new Uint32Array(0);
        })
        .finally(() => {
          try {
            readback.unmap();
          } catch {
            // Buffer may already be destroyed during teardown.
          }
          this._gpuReadbackPending = false;
        });
    });
    return true;
  }

  getGpuSortedIndices(count = this._count): Uint32Array | null {
    if (count < 1 || this._lastGpuSortedIndices.length !== count) return null;
    return this._lastGpuSortedIndices;
  }

  destroyGpu(): void {
    this._sortKeyBuffer?.destroy();
    this._sortIndexBuffer?.destroy();
    this._sortIndexReadbackBuffer?.destroy();
    this._sortKeyBuffer = null;
    this._sortIndexBuffer = null;
    this._sortIndexReadbackBuffer = null;
    this._gpuCapacity = 0;
    this._gpuPaddedCapacity = 0;
    this._sortKeyData = new Uint32Array(0);
    this._sortIndexData = new Uint32Array(0);
    this._lastGpuSortedIndices = new Uint32Array(0);
    this._gpuReadbackPending = false;
  }

  forEachSorted(callback: (entry: TransparentMegaBatchEntry<T>, sortedIndex: number) => void): void {
    for (let i = 0; i < this._count; i++) {
      const sortedIndex = this._sortedIndices[i];
      const entry = sortedIndex === undefined ? undefined : this._entries[sortedIndex];
      if (entry) callback(entry, i);
    }
  }

  private _sortIndicesWithoutAllocating(): void {
    const count = this._count;
    if (count <= 1) return;

    const sorted = this._sortedIndices;
    const scratch = this._sortedIndicesScratch;
    scratch.length = count;
    let source = sorted;
    let target = scratch;

    for (let width = 1; width < count; width *= 2) {
      for (let start = 0; start < count; start += width * 2) {
        const middle = Math.min(start + width, count);
        const end = Math.min(start + width * 2, count);
        let left = start;
        let right = middle;
        let write = start;

        while (left < middle && right < end) {
          const leftIndex = source[left];
          const rightIndex = source[right];
          if (leftIndex === undefined || rightIndex === undefined) break;
          if (this._compareSortedIndices(leftIndex, rightIndex) <= 0) {
            target[write++] = leftIndex;
            left++;
          } else {
            target[write++] = rightIndex;
            right++;
          }
        }
        while (left < middle) {
          const index = source[left++];
          if (index !== undefined) target[write++] = index;
        }
        while (right < end) {
          const index = source[right++];
          if (index !== undefined) target[write++] = index;
        }
      }

      const previousSource = source;
      source = target;
      target = previousSource;
    }

    if (source !== sorted) {
      for (let i = 0; i < count; i++) {
        const index = source[i];
        if (index !== undefined) sorted[i] = index;
      }
    }
  }

  private _rebuildRuns(): void {
    const runs = this._runs;
    if (this._count < 1) {
      runs.length = 0;
      return;
    }
    let runCount = 0;

    let runStart = 0;
    const firstIndex = this._sortedIndices[0];
    let first = firstIndex === undefined ? undefined : this._entries[firstIndex];
    if (!first) return;
    let rendererKey = first.rendererKey;
    let materialId = first.materialId;
    for (let i = 1; i <= this._count; i++) {
      const sortedIndex = i < this._count ? this._sortedIndices[i] : undefined;
      const entry = sortedIndex === undefined ? null : this._entries[sortedIndex] ?? null;
      if (entry && entry.rendererKey === rendererKey && entry.materialId === materialId) continue;
      const runIndex = runCount++;
      let run = this._runPool[runIndex];
      if (!run) {
        run = { rendererKey, materialId, start: runStart, count: i - runStart, entries: this._entries };
        this._runPool.push(run);
      } else {
        run.rendererKey = rendererKey;
        run.materialId = materialId;
        run.start = runStart;
        run.count = i - runStart;
      }
      runs[runIndex] = run;
      if (entry) {
        runStart = i;
        rendererKey = entry.rendererKey;
        materialId = entry.materialId;
      }
    }
    runs.length = runCount;
  }

  private _ensureGpuCapacity(engine: IEngine, required: number): void {
    const nextCapacity = alignUp(Math.max(1, required), 16);
    const nextPaddedCapacity = nextPowerOfTwo(Math.max(1, required));
    if (nextCapacity <= this._gpuCapacity && nextPaddedCapacity <= this._gpuPaddedCapacity) return;

    const device = engine.device;
    this._sortKeyBuffer?.destroy();
    this._sortIndexBuffer?.destroy();
    this._sortIndexReadbackBuffer?.destroy();
    this._gpuCapacity = nextCapacity;
    this._gpuPaddedCapacity = nextPaddedCapacity;
    this._sortKeyData = new Uint32Array(this._gpuPaddedCapacity * TRANSPARENT_SORT_KEY_WORDS);
    this._sortIndexData = new Uint32Array(this._gpuPaddedCapacity);
    this._sortKeyBuffer = device.createBuffer({
      label: `${this.label}.sortKeys`,
      size: Math.max(4, this._gpuPaddedCapacity * TRANSPARENT_SORT_KEY_WORDS * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this._sortIndexBuffer = device.createBuffer({
      label: `${this.label}.sortIndices`,
      size: Math.max(4, this._gpuPaddedCapacity * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this._sortIndexReadbackBuffer = device.createBuffer({
      label: `${this.label}.sortIndices.readback`,
      size: Math.max(4, this._gpuPaddedCapacity * 4),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this._lastGpuSortedIndices = new Uint32Array(0);
    this._gpuReadbackPending = false;
  }
}

function compareEntries<T>(a: TransparentMegaBatchEntry<T>, b: TransparentMegaBatchEntry<T>): number {
  const orderDelta = a.transparentOrder - b.transparentOrder;
  if (orderDelta !== 0) return orderDelta;
  if (a.depthSort && b.depthSort) {
    const depthDelta = compareTransparentDepthBackToFront(a.viewDepth, b.viewDepth);
    if (depthDelta !== 0) return depthDelta;
  } else if (a.depthSort !== b.depthSort) {
    return a.depthSort ? -1 : 1;
  }
  const rendererDelta = a.rendererKey - b.rendererKey;
  if (rendererDelta !== 0) return rendererDelta;
  const materialDelta = a.materialId - b.materialId;
  if (materialDelta !== 0) return materialDelta;
  return a.entityId - b.entityId;
}

function packGpuSortKey<T>(entry: TransparentMegaBatchEntry<T>, target: Uint32Array, offset: number): void {
  target[offset] = signedToSortableUint32(entry.transparentOrder | 0);
  target[offset + 1] = packDepthSortKey(entry);
  target[offset + 2] = entry.rendererKey >>> 0;
  target[offset + 3] = entry.materialId >>> 0;
  target[offset + 4] = entry.entityId >>> 0;
}

function packDepthSortKey<T>(entry: TransparentMegaBatchEntry<T>): number {
  const sortFlag = entry.depthSort ? 0 : 1;
  const depth = entry.depthSort ? quantizeTransparentDepthBackToFront(entry.viewDepth) : 0x7fffffff;
  return (((sortFlag << 31) >>> 0) | depth) >>> 0;
}

function signedToSortableUint32(value: number): number {
  return ((value | 0) ^ 0x80000000) >>> 0;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result <<= 1;
  return result;
}

function throwTransparentResourceNotReady(message: string): never {
  throw new EngineError(
    EngineErrorCode.RendererResourceNotReady,
    message,
    {
      hint: 'Call uploadGpu() before accessing transparent sort GPU buffers.',
      docsPath: 'errors/E_RENDERER_RESOURCE_NOT_READY',
    },
  );
}
