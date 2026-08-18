import { ObjectTableSlotAllocator } from './ObjectTableSlotAllocator';
import type { RenderCommandContext } from '../core/RenderCommandContext';

export interface RendererObjectTableOptions {
  device: GPUDevice;
  bindGroupLayout: GPUBindGroupLayout;
  binding?: number;
  label: string;
  floatsPerSlot: number;
  /** Optional independently-uploaded storage channel sharing the same object slots. */
  auxiliary?: {
    binding: number;
    floatsPerSlot: number;
    label?: string;
  };
  /** Minimum dirty ratio at which the actual cost model may select a whole-table upload. */
  wholeTableUploadThreshold?: number;
  /** Estimated CPU/driver cost of one queue.writeBuffer call, expressed as equivalent bytes. */
  writeCallCostBytes?: number;
  /** Optional maximum uploaded slots divided by dirty slots for one table flush. */
  maxUploadExpansionRatio?: number;
  /** @deprecated Use writeCallCostBytes. Preserved as gap slots multiplied by the slot stride. */
  mergeGapSlots?: number;
  /** @internal Creates a raw upload table without its own bind group. */
  createBindGroup?: boolean;
}

export interface RendererObjectTableFlushStats {
  dirtySlotCount: number;
  uploadRangeCount: number;
  uploadedSlotCount: number;
  wholeTableUpload: boolean;
}

const DEFAULT_WRITE_CALL_COST_BYTES = 1040;
const DEFAULT_WHOLE_TABLE_UPLOAD_THRESHOLD = 0.4;
const INITIAL_DIRTY_SLOT_CAPACITY = 16;

export class RendererObjectTable {
  readonly floatsPerSlot: number;
  readonly bytesPerSlot: number;

  private readonly _device: GPUDevice;
  private readonly _bindGroupLayout: GPUBindGroupLayout;
  private readonly _binding: number;
  private readonly _label: string;
  private readonly _writeCallCostBytes: number;
  private readonly _maxUploadExpansionRatio: number;
  private readonly _wholeTableUploadThreshold: number;
  private readonly _createBindGroup: boolean;
  private readonly _auxiliaryBinding: number | undefined;
  private readonly _auxiliary: RendererObjectTable | undefined;
  private readonly _slots = new ObjectTableSlotAllocator();
  private readonly _retiredBuffers: GPUBuffer[] = [];
  private readonly _lastFlushStats: RendererObjectTableFlushStats = {
    dirtySlotCount: 0,
    uploadRangeCount: 0,
    uploadedSlotCount: 0,
    wholeTableUpload: false,
  };

  private _capacity = 0;
  private _data = new Float32Array(0);
  /** Last CPU slot contents already queued (or pending) for this table. */
  private _committedData = new Float32Array(0);
  private _buffer: GPUBuffer | undefined;
  private _bindGroup: GPUBindGroup | undefined;
  private _dirtySlots = new Uint32Array(INITIAL_DIRTY_SLOT_CAPACITY);
  private _mergeGapScratch = new Uint32Array(INITIAL_DIRTY_SLOT_CAPACITY);
  private _dirtySlotMarks = new Uint32Array(0);
  private _frameVisitedSlotMarks = new Uint32Array(0);
  private _dirtySlotCount = 0;
  private _dirtySlotMax = 0;
  private _dirtyGeneration = 1;
  private _frameVisitedGeneration = 1;
  private _frameVisitedSlotCount = 0;
  private _frameVisitedSlotMin = 0;
  private _frameVisitedSlotMax = 0;
  private _submissionContext: RenderCommandContext | undefined;

  constructor(options: RendererObjectTableOptions) {
    this._device = options.device;
    this._bindGroupLayout = options.bindGroupLayout;
    this._binding = options.binding ?? 0;
    this._label = options.label;
    this._createBindGroup = options.createBindGroup ?? true;
    this.floatsPerSlot = options.floatsPerSlot;
    this.bytesPerSlot = this.floatsPerSlot * 4;
    const threshold = options.wholeTableUploadThreshold ?? DEFAULT_WHOLE_TABLE_UPLOAD_THRESHOLD;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new RangeError('RendererObjectTable wholeTableUploadThreshold must be in (0, 1].');
    }
    this._wholeTableUploadThreshold = threshold;
    const mergeGapSlots = options.mergeGapSlots;
    if (mergeGapSlots !== undefined && (!Number.isInteger(mergeGapSlots) || mergeGapSlots < 0)) {
      throw new RangeError('RendererObjectTable mergeGapSlots must be a non-negative integer.');
    }
    const writeCallCostBytes = options.writeCallCostBytes;
    if (
      writeCallCostBytes !== undefined
      && (!Number.isFinite(writeCallCostBytes) || writeCallCostBytes < 0)
    ) {
      throw new RangeError('RendererObjectTable writeCallCostBytes must be finite and non-negative.');
    }
    if (mergeGapSlots !== undefined && writeCallCostBytes !== undefined) {
      throw new TypeError(
        'RendererObjectTable mergeGapSlots and writeCallCostBytes are mutually exclusive.',
      );
    }
    this._writeCallCostBytes = writeCallCostBytes
      ?? (mergeGapSlots === undefined
        ? DEFAULT_WRITE_CALL_COST_BYTES
        : mergeGapSlots * this.bytesPerSlot);
    const maxUploadExpansionRatio = options.maxUploadExpansionRatio;
    if (
      maxUploadExpansionRatio !== undefined
      && (!Number.isFinite(maxUploadExpansionRatio) || maxUploadExpansionRatio < 1)
    ) {
      throw new RangeError(
        'RendererObjectTable maxUploadExpansionRatio must be finite and at least 1.',
      );
    }
    this._maxUploadExpansionRatio =
      maxUploadExpansionRatio ?? Number.POSITIVE_INFINITY;
    const auxiliary = options.auxiliary;
    if (auxiliary) {
      if (!this._createBindGroup) throw new TypeError('A raw RendererObjectTable cannot own an auxiliary channel.');
      if (auxiliary.binding === this._binding) throw new RangeError('RendererObjectTable bindings must be distinct.');
      this._auxiliaryBinding = auxiliary.binding;
      this._auxiliary = new RendererObjectTable({
        device: options.device,
        bindGroupLayout: options.bindGroupLayout,
        binding: auxiliary.binding,
        label: auxiliary.label ?? `${options.label}.auxiliary`,
        floatsPerSlot: auxiliary.floatsPerSlot,
        ...(options.wholeTableUploadThreshold === undefined ? {} : { wholeTableUploadThreshold: options.wholeTableUploadThreshold }),
        ...(options.writeCallCostBytes === undefined ? {} : { writeCallCostBytes: options.writeCallCostBytes }),
        ...(options.maxUploadExpansionRatio === undefined ? {} : { maxUploadExpansionRatio: options.maxUploadExpansionRatio }),
        ...(options.mergeGapSlots === undefined ? {} : { mergeGapSlots: options.mergeGapSlots }),
        createBindGroup: false,
      });
    }
  }

  get data(): Float32Array {
    return this._data;
  }

  get auxiliaryData(): Float32Array {
    if (!this._auxiliary) throw new Error('RendererObjectTable has no auxiliary channel.');
    return this._auxiliary.data;
  }

  get buffer(): GPUBuffer {
    this.ensureCapacity(1);
    return this._buffer!;
  }

  get bindGroup(): GPUBindGroup {
    if (!this._createBindGroup) throw new Error('Raw RendererObjectTable has no bind group.');
    this.ensureCapacity(1);
    return this._bindGroup!;
  }

  get capacity(): number {
    return this._capacity;
  }

  get dirtySlotCount(): number { return this._dirtySlotCount; }

  get lastFlushStats(): Readonly<RendererObjectTableFlushStats> { return this._lastFlushStats; }

  allocateSlot(): number {
    const slot = this._slots.allocate();
    this.ensureCapacity(slot + 1);
    return slot;
  }

  releaseSlot(slot: number): void {
    this._slots.release(slot);
  }

  ensureCapacity(requiredSlots: number): void {
    if (requiredSlots <= this._capacity && this._buffer && (!this._createBindGroup || this._bindGroup)) return;
    let capacity = Math.max(1, this._capacity);
    while (capacity < requiredSlots) capacity *= 2;

    const nextData = new Float32Array(capacity * this.floatsPerSlot);
    nextData.set(this._data.subarray(0, Math.min(this._data.length, nextData.length)));
    const nextCommittedData = new Float32Array(capacity * this.floatsPerSlot);
    // The new GPU buffer receives the complete CPU table below, so its
    // committed snapshot must match that upload, including previously dirty
    // slots and any values written immediately before growth.
    nextCommittedData.set(nextData);
    const previousBuffer = this._buffer;
    this._auxiliary?.ensureCapacity(capacity);

    this._buffer = this._device.createBuffer({
      label: this._label,
      size: capacity * this.bytesPerSlot,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (this._createBindGroup) {
      const entries: GPUBindGroupEntry[] = [{ binding: this._binding, resource: { buffer: this._buffer } }];
      if (this._auxiliary && this._auxiliaryBinding !== undefined) {
        entries.push({ binding: this._auxiliaryBinding, resource: { buffer: this._auxiliary.buffer } });
      }
      this._bindGroup = this._device.createBindGroup({ layout: this._bindGroupLayout, entries });
    }
    this._capacity = capacity;
    this._data = nextData;
    this._committedData = nextCommittedData;
    const nextMarks = new Uint32Array(capacity);
    nextMarks.set(this._dirtySlotMarks.subarray(0, Math.min(this._dirtySlotMarks.length, capacity)));
    this._dirtySlotMarks = nextMarks;
    const nextVisitedMarks = new Uint32Array(capacity);
    nextVisitedMarks.set(
      this._frameVisitedSlotMarks.subarray(
        0,
        Math.min(this._frameVisitedSlotMarks.length, capacity),
      ),
    );
    this._frameVisitedSlotMarks = nextVisitedMarks;
    this._device.queue.writeBuffer(this._buffer, 0, this._data);
    if (this._dirtySlotCount > 0) this._resetDirtySlots();
    if (previousBuffer) this._retireBuffer(previousBuffer);
  }

  /** Marks one CPU table slot dirty. GPU writes are issued only by flushUploads(). */
  writeSlot(slot: number): void {
    this.ensureCapacity(slot + 1);
    this._visitFrameSlot(slot);
    const start = slot * this.floatsPerSlot;
    const end = start + this.floatsPerSlot;
    if (floatRangeEquals(this._data, this._committedData, start, end)) return;
    copyFloatRange(this._data, this._committedData, start, end);
    if (this._dirtySlotMarks[slot] === this._dirtyGeneration) return;
    this._dirtySlotMarks[slot] = this._dirtyGeneration;
    if (this._dirtySlotCount >= this._dirtySlots.length) {
      const next = new Uint32Array(this._dirtySlots.length * 2);
      next.set(this._dirtySlots);
      this._dirtySlots = next;
      this._mergeGapScratch = new Uint32Array(next.length);
    }
    this._dirtySlots[this._dirtySlotCount++] = slot;
    this._dirtySlotMax = Math.max(this._dirtySlotMax, slot + 1);
  }

  /** Marks the matching slot in the independently-uploaded auxiliary channel. */
  writeAuxiliarySlot(slot: number): void {
    if (!this._auxiliary) throw new Error('RendererObjectTable has no auxiliary channel.');
    this.ensureCapacity(slot + 1);
    this._auxiliary.writeSlot(slot);
  }

  /** Supplies the frame submission boundary used to retire buffers replaced by growth. */
  beginUploads(submissionContext?: RenderCommandContext): void {
    this._auxiliary?.beginUploads(submissionContext);
    if (
      this._slots.highWaterMark === 0
      && submissionContext !== this._submissionContext
    ) {
      this._resetFrameVisitedSlots();
    }
    this._submissionContext = submissionContext;
  }

  flushUploads(): Readonly<RendererObjectTableFlushStats> {
    this._auxiliary?.flushUploads();
    const stats = this._lastFlushStats;
    stats.dirtySlotCount = this._dirtySlotCount;
    stats.uploadRangeCount = 0;
    stats.uploadedSlotCount = 0;
    stats.wholeTableUpload = false;
    if (this._dirtySlotCount < 1) return stats;

    const usedSlotCount = Math.max(1, this._slots.highWaterMark, this._dirtySlotMax);
    const frameVisitedSpanSlotCount =
      this._frameVisitedSlotMax - this._frameVisitedSlotMin;
    if (
      this._slots.highWaterMark === 0
      && this._frameVisitedSlotCount > 0
      && this._dirtySlotCount === this._frameVisitedSlotCount
      && frameVisitedSpanSlotCount === this._frameVisitedSlotCount
    ) {
      this._uploadRange(this._frameVisitedSlotMin, this._frameVisitedSlotMax);
      stats.uploadRangeCount = 1;
      stats.uploadedSlotCount = frameVisitedSpanSlotCount;
      stats.wholeTableUpload = true;
      this._resetDirtySlots();
      return stats;
    }
    // Distinct dirty marks covering every used slot prove that the exact sparse
    // lower bound already equals a whole-table upload. Avoid sorting the
    // high-churn case while preserving the same cost decision.
    if (this._dirtySlotCount === usedSlotCount) {
      this._uploadRange(0, usedSlotCount);
      stats.uploadRangeCount = 1;
      stats.uploadedSlotCount = usedSlotCount;
      stats.wholeTableUpload = true;
      this._resetDirtySlots();
      return stats;
    }
    sortUint32Prefix(this._dirtySlots, this._dirtySlotCount);

    // Cost model:
    //   range cost = uploaded bytes + one write-call cost
    // When a table-wide overupload cap is configured, candidate clean gaps are
    // selected globally from smallest to largest. A per-range cap would reject
    // useful local merges and regress sparse scenes.
    let mergeGapCount = 0;
    for (let index = 1; index < this._dirtySlotCount; index++) {
      const previousSlot = this._dirtySlots[index - 1]!;
      const slot = this._dirtySlots[index]!;
      const cleanGapSlots = slot - previousSlot - 1;
      if (cleanGapSlots * this.bytesPerSlot <= this._writeCallCostBytes) {
        this._mergeGapScratch[mergeGapCount++] = cleanGapSlots;
      }
    }
    let selectedGapCount = 0;
    let selectedCleanSlotCount = 0;
    let selectedGapCutoff = -1;
    let selectedAtCutoffCount = 0;
    if (Number.isFinite(this._maxUploadExpansionRatio)) {
      sortUint32Prefix(this._mergeGapScratch, mergeGapCount);
      const extraSlotBudget = Math.floor(
        this._dirtySlotCount * (this._maxUploadExpansionRatio - 1),
      );
      for (let index = 0; index < mergeGapCount; index++) {
        const cleanGapSlots = this._mergeGapScratch[index]!;
        if (selectedCleanSlotCount + cleanGapSlots > extraSlotBudget) break;
        selectedCleanSlotCount += cleanGapSlots;
        selectedGapCount++;
        if (cleanGapSlots === selectedGapCutoff) {
          selectedAtCutoffCount++;
        } else {
          selectedGapCutoff = cleanGapSlots;
          selectedAtCutoffCount = 1;
        }
      }
    } else {
      selectedGapCount = mergeGapCount;
      for (let index = 0; index < mergeGapCount; index++) {
        const cleanGapSlots = this._mergeGapScratch[index]!;
        selectedCleanSlotCount += cleanGapSlots;
        if (cleanGapSlots > selectedGapCutoff) {
          selectedGapCutoff = cleanGapSlots;
          selectedAtCutoffCount = 1;
        } else if (cleanGapSlots === selectedGapCutoff) {
          selectedAtCutoffCount++;
        }
      }
    }
    const sparseRangeCount = this._dirtySlotCount - selectedGapCount;
    const sparseUploadedSlotCount =
      this._dirtySlotCount + selectedCleanSlotCount;

    const sparseUploadCost = sparseUploadedSlotCount * this.bytesPerSlot
      + sparseRangeCount * this._writeCallCostBytes;
    const wholeTableUploadCost = usedSlotCount * this.bytesPerSlot
      + this._writeCallCostBytes;
    const wholeTableEligible = this._dirtySlotCount
      >= Math.ceil(usedSlotCount * this._wholeTableUploadThreshold)
      && usedSlotCount
        <= this._dirtySlotCount * this._maxUploadExpansionRatio;
    if (wholeTableEligible && wholeTableUploadCost <= sparseUploadCost) {
      this._uploadRange(0, usedSlotCount);
      stats.uploadRangeCount = 1;
      stats.uploadedSlotCount = usedSlotCount;
      stats.wholeTableUpload = true;
    } else {
      let rangeStart = this._dirtySlots[0]!;
      let rangeEnd = rangeStart + 1;
      let remainingAtCutoff = selectedAtCutoffCount;
      for (let index = 1; index < this._dirtySlotCount; index++) {
        const slot = this._dirtySlots[index]!;
        const cleanGapSlots = slot - rangeEnd;
        const merge = cleanGapSlots < selectedGapCutoff
          || (
            cleanGapSlots === selectedGapCutoff
            && remainingAtCutoff-- > 0
          );
        if (merge) {
          rangeEnd = slot + 1;
          continue;
        }
        this._uploadRange(rangeStart, rangeEnd);
        stats.uploadRangeCount++;
        stats.uploadedSlotCount += rangeEnd - rangeStart;
        rangeStart = slot;
        rangeEnd = slot + 1;
      }
      this._uploadRange(rangeStart, rangeEnd);
      stats.uploadRangeCount++;
      stats.uploadedSlotCount += rangeEnd - rangeStart;
    }
    this._resetDirtySlots();
    return stats;
  }

  destroy(): void {
    this._auxiliary?.destroy();
    this._buffer?.destroy();
    this._buffer = undefined;
    for (const buffer of this._retiredBuffers) buffer.destroy();
    this._retiredBuffers.length = 0;
    this._bindGroup = undefined;
    this._capacity = 0;
    this._dirtySlotCount = 0;
    this._dirtySlotMax = 0;
    this._dirtyGeneration = 1;
    this._dirtySlotMarks = new Uint32Array(0);
    this._frameVisitedGeneration = 1;
    this._frameVisitedSlotMarks = new Uint32Array(0);
    this._frameVisitedSlotCount = 0;
    this._frameVisitedSlotMin = 0;
    this._frameVisitedSlotMax = 0;
    this._mergeGapScratch = new Uint32Array(INITIAL_DIRTY_SLOT_CAPACITY);
    this._submissionContext = undefined;
    this._data = new Float32Array(0);
    this._committedData = new Float32Array(0);
    this._slots.reset();
  }

  private _uploadRange(startSlot: number, endSlot: number): void {
    const floatStart = startSlot * this.floatsPerSlot;
    const floatCount = (endSlot - startSlot) * this.floatsPerSlot;
    this._device.queue.writeBuffer(
      this._buffer!,
      startSlot * this.bytesPerSlot,
      this._data.buffer as ArrayBuffer,
      this._data.byteOffset + floatStart * 4,
      floatCount * 4,
    );
  }

  private _visitFrameSlot(slot: number): void {
    if (
      this._slots.highWaterMark !== 0
      || this._frameVisitedSlotMarks[slot] === this._frameVisitedGeneration
    ) return;
    this._frameVisitedSlotMarks[slot] = this._frameVisitedGeneration;
    if (this._frameVisitedSlotCount === 0) {
      this._frameVisitedSlotMin = slot;
      this._frameVisitedSlotMax = slot + 1;
    } else {
      this._frameVisitedSlotMin = Math.min(this._frameVisitedSlotMin, slot);
      this._frameVisitedSlotMax = Math.max(this._frameVisitedSlotMax, slot + 1);
    }
    this._frameVisitedSlotCount++;
  }

  private _resetFrameVisitedSlots(): void {
    this._frameVisitedSlotCount = 0;
    this._frameVisitedSlotMin = 0;
    this._frameVisitedSlotMax = 0;
    if (this._frameVisitedGeneration === 0xffff_ffff) {
      this._frameVisitedSlotMarks.fill(0);
      this._frameVisitedGeneration = 1;
    } else {
      this._frameVisitedGeneration++;
    }
  }

  private _resetDirtySlots(): void {
    this._dirtySlotCount = 0;
    this._dirtySlotMax = 0;
    if (this._dirtyGeneration === 0xffff_ffff) {
      this._dirtySlotMarks.fill(0);
      this._dirtyGeneration = 1;
    } else {
      this._dirtyGeneration++;
    }
  }

  private _retireBuffer(buffer: GPUBuffer): void {
    const context = this._submissionContext;
    if (!context?.afterSubmit) {
      this._retiredBuffers.push(buffer);
      return;
    }
    context.afterSubmit(queue => {
      const destroy = () => buffer.destroy();
      void queue.onSubmittedWorkDone().then(destroy, destroy);
    });
  }
}

function floatRangeEquals(a: Float32Array, b: Float32Array, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function copyFloatRange(source: Float32Array, target: Float32Array, start: number, end: number): void {
  for (let index = start; index < end; index++) target[index] = source[index]!;
}

function sortUint32Prefix(values: Uint32Array, count: number): void {
  for (let start = Math.floor(count / 2) - 1; start >= 0; start--) siftDown(values, start, count);
  for (let end = count - 1; end > 0; end--) {
    const first = values[0]!;
    values[0] = values[end]!;
    values[end] = first;
    siftDown(values, 0, end);
  }
}

function siftDown(values: Uint32Array, root: number, end: number): void {
  while (true) {
    const left = root * 2 + 1;
    if (left >= end) return;
    const right = left + 1;
    let child = left;
    if (right < end && values[right]! > values[left]!) child = right;
    if (values[root]! >= values[child]!) return;
    const value = values[root]!;
    values[root] = values[child]!;
    values[child] = value;
    root = child;
  }
}
