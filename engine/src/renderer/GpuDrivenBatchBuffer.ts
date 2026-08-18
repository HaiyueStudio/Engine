import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { alignUp } from '../utils/align';
import { EngineError, EngineErrorCode } from '../core/EngineError';

const DRAW_COMMAND_WORDS = 9;
const DRAW_COMMAND_BYTES = DRAW_COMMAND_WORDS * 4;
const INDEXED_INDIRECT_WORDS = 5;
const DRAW_INDIRECT_WORDS = 4;
const BOUNDS_WORDS = 4;
const INSTANCE_TABLE_WORDS = 4;
const MATERIAL_TABLE_WORDS = 5;
const MEGA_BATCH_RUN_WORDS = 4;
const INDEXED_INDIRECT_BYTES = INDEXED_INDIRECT_WORDS * 4;
const DRAW_INDIRECT_BYTES = DRAW_INDIRECT_WORDS * 4;
const BOUNDS_BYTES = BOUNDS_WORDS * 4;
const INSTANCE_TABLE_BYTES = INSTANCE_TABLE_WORDS * 4;
const MATERIAL_TABLE_BYTES = MATERIAL_TABLE_WORDS * 4;
const MEGA_BATCH_RUN_BYTES = MEGA_BATCH_RUN_WORDS * 4;
const SORT_KEY_PADDING = 0xffffffff;

export interface GpuDrivenBatchCommand {
  entityId: number;
  geometryId: number;
  materialId: number;
  instanceCount: number;
  indexCount: number;
  vertexCount: number;
  sortKey: number;
  flags?: number;
  firstInstance?: number;
  boundsCenterX?: number | undefined;
  boundsCenterY?: number | undefined;
  boundsCenterZ?: number | undefined;
  boundsRadius?: number | undefined;
}

/** Mutable view over one batch's indexed/non-indexed indirect command slots. */
export interface GpuDrivenIndirectCommandView {
  indexedIndirectBuffer: GPUBuffer;
  drawIndirectBuffer: GPUBuffer;
  indexedIndirectOffset: number;
  drawIndirectOffset: number;
}

export interface GpuDrivenInstanceTableEntry {
  entityId: number;
  batchIndex: number;
  geometryId: number;
  materialSlot: number;
}

export interface GpuDrivenMaterialTableEntry {
  materialId: number;
  materialSlot: number;
  rendererSlot: number;
  firstBatch: number;
  batchCount: number;
}

export interface GpuDrivenMegaBatchRun {
  firstBatch: number;
  batchCount: number;
  materialSlot: number;
  rendererSlot: number;
}

export interface GpuDrivenBatchTables {
  instances?: readonly GpuDrivenInstanceTableEntry[];
  materials?: readonly GpuDrivenMaterialTableEntry[];
  megaBatchRuns?: readonly GpuDrivenMegaBatchRun[];
}

export interface GpuDrivenBatchUploadOptions {
  /**
   * Keeps the CPU command/table view used by the portable batched profile,
   * but skips command-buffer allocation and queue uploads when indirect draws
   * are unavailable or disabled.
   */
  gpuUpload?: boolean;
}

export type GpuDrivenReadbackStatus = 'completed' | 'cancelled' | 'failed';

export interface GpuDrivenReadbackResult {
  readonly requestId: number;
  readonly status: GpuDrivenReadbackStatus;
  readonly value: number | null;
  /** Opaque caller token, commonly the submitted frame id. */
  readonly token?: number | undefined;
  /** False when an older completion was deliberately kept out of the public last-value cache. */
  readonly published: boolean;
}

export interface GpuDrivenReadbackRequestOptions {
  /** Opaque caller token copied into the completion result. */
  token?: number | undefined;
  onComplete?(result: GpuDrivenReadbackResult): void;
}

export interface GpuDrivenReadbackPathDebugSnapshot {
  readonly requests: number;
  readonly accepted: number;
  readonly skipped: number;
  readonly mappingStarted: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly failed: number;
  readonly staleCompletions: number;
  readonly pending: number;
  readonly maxPending: number;
}

export interface GpuDrivenReadbackDebugSnapshot {
  readonly sortedIndices: GpuDrivenReadbackPathDebugSnapshot;
  readonly indexedInstanceCounts: GpuDrivenReadbackPathDebugSnapshot;
}

interface MutableReadbackPathDebugSnapshot {
  requests: number;
  accepted: number;
  skipped: number;
  mappingStarted: number;
  completed: number;
  cancelled: number;
  failed: number;
  staleCompletions: number;
  pending: number;
  maxPending: number;
}

export class GpuDrivenBatchBuffer {
  readonly label: string;

  private readonly _engine: IEngine;
  private readonly _sharedTables: GpuDrivenBatchBuffer | null;
  private _capacity = 0;
  private _paddedCapacity = 0;
  private _gpuCapacity = 0;
  private _gpuPaddedCapacity = 0;
  private _gpuUploadEnabled = false;
  private _commandBuffer: GPUBuffer | null = null;
  private _indexedIndirectBuffer: GPUBuffer | null = null;
  private _drawIndirectBuffer: GPUBuffer | null = null;
  private _boundsBuffer: GPUBuffer | null = null;
  private _instanceTableBuffer: GPUBuffer | null = null;
  private _materialTableBuffer: GPUBuffer | null = null;
  private _megaBatchRunBuffer: GPUBuffer | null = null;
  private _sortKeyBuffer: GPUBuffer | null = null;
  private _sortIndexBuffer: GPUBuffer | null = null;
  private _sortIndexReadbackBuffer: GPUBuffer | null = null;
  private _indexedInstanceCountReadbackBuffers: [GPUBuffer | null, GPUBuffer | null] = [null, null];
  private _commandData = new Uint32Array(0);
  private _indexedIndirectData = new Uint32Array(0);
  private _drawIndirectData = new Uint32Array(0);
  private _boundsData = new Float32Array(0);
  private _instanceTableData = new Uint32Array(0);
  private _materialTableData = new Uint32Array(0);
  private _megaBatchRunData = new Uint32Array(0);
  private _sortKeyData = new Uint32Array(0);
  private _sortIndexData = new Uint32Array(0);
  private _lastSortedIndices = new Uint32Array(0);
  private _lastIndexedInstanceCountSum: number | null = null;
  private _count = 0;
  private _instanceTableCount = 0;
  private _materialTableCount = 0;
  private _megaBatchRunCount = 0;
  private _readbackPending = false;
  private _indexedInstanceCountReadbackPending: [boolean, boolean] = [false, false];
  private _indexedInstanceCountReadbackCursor = 0;
  private _readbackGeneration = 0;
  private _nextReadbackRequestId = 0;
  private _lastIndexedReadbackRequestId = 0;
  private readonly _sortedReadbackDebug = createReadbackDebugState();
  private readonly _indexedReadbackDebug = createReadbackDebugState();

  constructor(engine: IEngine, label = 'GpuDrivenBatchBuffer', sharedTables: GpuDrivenBatchBuffer | null = null) {
    this._engine = engine;
    this.label = label;
    this._sharedTables = sharedTables;
  }

  get count(): number {
    return this._count;
  }

  get capacity(): number {
    return this._capacity;
  }

  get paddedCapacity(): number {
    return this._paddedCapacity;
  }

  /** True when the current command set was uploaded for indirect GPU draws. */
  get gpuUploadEnabled(): boolean {
    return this._gpuUploadEnabled;
  }

  get instanceTableCount(): number {
    return this._sharedTables?.instanceTableCount ?? this._instanceTableCount;
  }

  get materialTableCount(): number {
    return this._sharedTables?.materialTableCount ?? this._materialTableCount;
  }

  get megaBatchRunCount(): number {
    return this._megaBatchRunCount;
  }

  get commandBuffer(): GPUBuffer {
    if (!this._commandBuffer) throwRendererResourceNotReady(`${this.label}.commandBuffer accessed before upload().`);
    return this._commandBuffer;
  }

  get indexedIndirectBuffer(): GPUBuffer {
    if (!this._indexedIndirectBuffer) throwRendererResourceNotReady(`${this.label}.indexedIndirectBuffer accessed before upload().`);
    return this._indexedIndirectBuffer;
  }

  get drawIndirectBuffer(): GPUBuffer {
    if (!this._drawIndirectBuffer) throwRendererResourceNotReady(`${this.label}.drawIndirectBuffer accessed before upload().`);
    return this._drawIndirectBuffer;
  }

  get boundsBuffer(): GPUBuffer {
    if (!this._boundsBuffer) throwRendererResourceNotReady(`${this.label}.boundsBuffer accessed before upload().`);
    return this._boundsBuffer;
  }

  get instanceTableBuffer(): GPUBuffer {
    if (this._sharedTables) return this._sharedTables.instanceTableBuffer;
    if (!this._instanceTableBuffer) throwRendererResourceNotReady(`${this.label}.instanceTableBuffer accessed before upload().`);
    return this._instanceTableBuffer;
  }

  get materialTableBuffer(): GPUBuffer {
    if (this._sharedTables) return this._sharedTables.materialTableBuffer;
    if (!this._materialTableBuffer) throwRendererResourceNotReady(`${this.label}.materialTableBuffer accessed before upload().`);
    return this._materialTableBuffer;
  }

  get megaBatchRunBuffer(): GPUBuffer {
    if (!this._megaBatchRunBuffer) throwRendererResourceNotReady(`${this.label}.megaBatchRunBuffer accessed before upload().`);
    return this._megaBatchRunBuffer;
  }

  get sortKeyBuffer(): GPUBuffer {
    if (!this._sortKeyBuffer) throwRendererResourceNotReady(`${this.label}.sortKeyBuffer accessed before upload().`);
    return this._sortKeyBuffer;
  }

  get sortIndexBuffer(): GPUBuffer {
    if (!this._sortIndexBuffer) throwRendererResourceNotReady(`${this.label}.sortIndexBuffer accessed before upload().`);
    return this._sortIndexBuffer;
  }

  upload(
    commands: readonly GpuDrivenBatchCommand[],
    tables: GpuDrivenBatchTables = {},
    options: GpuDrivenBatchUploadOptions = {},
  ): void {
    this._count = commands.length;
    this._gpuUploadEnabled = options.gpuUpload !== false;
    if (!this._sharedTables) {
      this._instanceTableCount = tables.instances?.length ?? 0;
      this._materialTableCount = tables.materials?.length ?? 0;
    }
    this._megaBatchRunCount = tables.megaBatchRuns?.length ?? 0;
    this._ensureCapacity(commands.length, this._gpuUploadEnabled);

    // The portable batched profile uses this object as a stable CPU mapping
    // from view-local batch index to scene-global object slot. It never reads
    // the GPU command, bounds, sort, instance, or material buffers. Avoid
    // clearing and repacking every staging table when no GPU upload can consume
    // them; only firstInstance is required by getObjectSlot().
    if (!this._gpuUploadEnabled) {
      for (let i = 0; i < commands.length; i++) {
        this._indexedIndirectData[i * INDEXED_INDIRECT_WORDS + 4] =
          commands[i]?.firstInstance ?? 0;
      }
      return;
    }

    this._commandData.fill(0, 0, this._capacity * DRAW_COMMAND_WORDS);
    this._indexedIndirectData.fill(0, 0, this._capacity * INDEXED_INDIRECT_WORDS);
    this._drawIndirectData.fill(0, 0, this._capacity * DRAW_INDIRECT_WORDS);
    this._boundsData.fill(0, 0, this._capacity * BOUNDS_WORDS);
    if (!this._sharedTables) {
      this._instanceTableData.fill(0, 0, this._capacity * INSTANCE_TABLE_WORDS);
      this._materialTableData.fill(0, 0, this._capacity * MATERIAL_TABLE_WORDS);
    }
    this._megaBatchRunData.fill(0, 0, this._capacity * MEGA_BATCH_RUN_WORDS);
    this._sortKeyData.fill(SORT_KEY_PADDING, 0, this._paddedCapacity);
    this._sortIndexData.fill(SORT_KEY_PADDING, 0, this._paddedCapacity);

    for (const [i, command] of commands.entries()) {
      const base = i * DRAW_COMMAND_WORDS;
      this._commandData[base] = command.entityId >>> 0;
      this._commandData[base + 1] = command.geometryId >>> 0;
      this._commandData[base + 2] = command.materialId >>> 0;
      this._commandData[base + 3] = command.instanceCount >>> 0;
      this._commandData[base + 4] = command.indexCount >>> 0;
      this._commandData[base + 5] = command.vertexCount >>> 0;
      this._commandData[base + 6] = command.sortKey >>> 0;
      this._commandData[base + 7] = command.flags ?? 0;
      this._commandData[base + 8] = command.firstInstance ?? 0;

      const indexedBase = i * INDEXED_INDIRECT_WORDS;
      this._indexedIndirectData[indexedBase] = command.indexCount >>> 0;
      this._indexedIndirectData[indexedBase + 1] = command.instanceCount >>> 0;
      this._indexedIndirectData[indexedBase + 2] = 0;
      this._indexedIndirectData[indexedBase + 3] = 0;
      this._indexedIndirectData[indexedBase + 4] = command.firstInstance ?? 0;

      const drawBase = i * DRAW_INDIRECT_WORDS;
      this._drawIndirectData[drawBase] = command.vertexCount >>> 0;
      this._drawIndirectData[drawBase + 1] = command.instanceCount >>> 0;
      this._drawIndirectData[drawBase + 2] = 0;
      this._drawIndirectData[drawBase + 3] = command.firstInstance ?? 0;

      const boundsBase = i * BOUNDS_WORDS;
      this._boundsData[boundsBase] = command.boundsCenterX ?? 0;
      this._boundsData[boundsBase + 1] = command.boundsCenterY ?? 0;
      this._boundsData[boundsBase + 2] = command.boundsCenterZ ?? 0;
      this._boundsData[boundsBase + 3] = command.boundsRadius ?? Number.POSITIVE_INFINITY;

      this._sortKeyData[i] = command.sortKey >>> 0;
      this._sortIndexData[i] = i;
    }

    const instances = this._sharedTables ? [] : tables.instances ?? [];
    for (const [i, entry] of instances.entries()) {
      const base = i * INSTANCE_TABLE_WORDS;
      this._instanceTableData[base] = entry.entityId >>> 0;
      this._instanceTableData[base + 1] = entry.batchIndex >>> 0;
      this._instanceTableData[base + 2] = entry.geometryId >>> 0;
      this._instanceTableData[base + 3] = entry.materialSlot >>> 0;
    }

    const materials = this._sharedTables ? [] : tables.materials ?? [];
    for (const [i, entry] of materials.entries()) {
      const base = i * MATERIAL_TABLE_WORDS;
      this._materialTableData[base] = entry.materialId >>> 0;
      this._materialTableData[base + 1] = entry.materialSlot >>> 0;
      this._materialTableData[base + 2] = entry.rendererSlot >>> 0;
      this._materialTableData[base + 3] = entry.firstBatch >>> 0;
      this._materialTableData[base + 4] = entry.batchCount >>> 0;
    }

    const megaBatchRuns = tables.megaBatchRuns ?? [];
    for (const [i, run] of megaBatchRuns.entries()) {
      const base = i * MEGA_BATCH_RUN_WORDS;
      this._megaBatchRunData[base] = run.firstBatch >>> 0;
      this._megaBatchRunData[base + 1] = run.batchCount >>> 0;
      this._megaBatchRunData[base + 2] = run.materialSlot >>> 0;
      this._megaBatchRunData[base + 3] = run.rendererSlot >>> 0;
    }

    if (
      !this._commandBuffer
      || !this._indexedIndirectBuffer
      || !this._drawIndirectBuffer
      || !this._boundsBuffer
      || !this._megaBatchRunBuffer
      || !this._sortKeyBuffer
      || !this._sortIndexBuffer
      || (!this._sharedTables && (!this._instanceTableBuffer || !this._materialTableBuffer))
    ) {
      this._gpuUploadEnabled = false;
      return;
    }
    const queue = this._engine.device?.queue;
    if (!queue) {
      this._gpuUploadEnabled = false;
      return;
    }
    if (commands.length > 0) {
      writeQueueBuffer(queue, this._commandBuffer, this._commandData, commands.length * DRAW_COMMAND_WORDS);
      writeQueueBuffer(queue, this._indexedIndirectBuffer, this._indexedIndirectData, commands.length * INDEXED_INDIRECT_WORDS);
      writeQueueBuffer(queue, this._drawIndirectBuffer, this._drawIndirectData, commands.length * DRAW_INDIRECT_WORDS);
      writeQueueBuffer(queue, this._boundsBuffer, this._boundsData, commands.length * BOUNDS_WORDS);
    }
    if (instances.length > 0 && this._instanceTableBuffer) {
      writeQueueBuffer(queue, this._instanceTableBuffer, this._instanceTableData, instances.length * INSTANCE_TABLE_WORDS);
    }
    if (materials.length > 0 && this._materialTableBuffer) {
      writeQueueBuffer(queue, this._materialTableBuffer, this._materialTableData, materials.length * MATERIAL_TABLE_WORDS);
    }
    if (megaBatchRuns.length > 0) {
      writeQueueBuffer(queue, this._megaBatchRunBuffer, this._megaBatchRunData, megaBatchRuns.length * MEGA_BATCH_RUN_WORDS);
    }
    writeQueueBuffer(queue, this._sortKeyBuffer, this._sortKeyData, this._paddedCapacity);
    writeQueueBuffer(queue, this._sortIndexBuffer, this._sortIndexData, this._paddedCapacity);
  }

  getIndexedIndirectOffset(batchIndex: number): number {
    return batchIndex * INDEXED_INDIRECT_BYTES;
  }

  getDrawIndirectOffset(batchIndex: number): number {
    return batchIndex * DRAW_INDIRECT_BYTES;
  }

  /** Writes this buffer's view-local indirect locations into a reusable object. */
  writeIndirectCommandView<T extends GpuDrivenIndirectCommandView>(batchIndex: number, out: T): T {
    out.indexedIndirectBuffer = this.indexedIndirectBuffer;
    out.drawIndirectBuffer = this.drawIndirectBuffer;
    out.indexedIndirectOffset = this.getIndexedIndirectOffset(batchIndex);
    out.drawIndirectOffset = this.getDrawIndirectOffset(batchIndex);
    return out;
  }

  /** Returns the scene-global object slot encoded in a view-local indirect command. */
  getObjectSlot(batchIndex: number): number {
    if (batchIndex < 0 || batchIndex >= this._count) return batchIndex;
    return this._indexedIndirectData[batchIndex * INDEXED_INDIRECT_WORDS + 4] ?? batchIndex;
  }

  writeIndexedIndirect(batchIndex: number, indexCount: number, instanceCount: number, firstIndex = 0, baseVertex = 0, firstInstance = 0): void {
    if (!this._indexedIndirectBuffer || batchIndex < 0 || batchIndex >= this._capacity) return;
    const base = batchIndex * INDEXED_INDIRECT_WORDS;
    this._indexedIndirectData[base] = indexCount >>> 0;
    this._indexedIndirectData[base + 1] = instanceCount >>> 0;
    this._indexedIndirectData[base + 2] = firstIndex >>> 0;
    this._indexedIndirectData[base + 3] = baseVertex >>> 0;
    this._indexedIndirectData[base + 4] = firstInstance >>> 0;
    this._engine.device?.queue.writeBuffer(
      this._indexedIndirectBuffer,
      this.getIndexedIndirectOffset(batchIndex),
      this._indexedIndirectData,
      base,
      INDEXED_INDIRECT_WORDS,
    );
  }

  writeDrawIndirect(batchIndex: number, vertexCount: number, instanceCount: number, firstVertex = 0, firstInstance = 0): void {
    if (!this._drawIndirectBuffer || batchIndex < 0 || batchIndex >= this._capacity) return;
    const base = batchIndex * DRAW_INDIRECT_WORDS;
    this._drawIndirectData[base] = vertexCount >>> 0;
    this._drawIndirectData[base + 1] = instanceCount >>> 0;
    this._drawIndirectData[base + 2] = firstVertex >>> 0;
    this._drawIndirectData[base + 3] = firstInstance >>> 0;
    this._engine.device?.queue.writeBuffer(
      this._drawIndirectBuffer,
      this.getDrawIndirectOffset(batchIndex),
      this._drawIndirectData,
      base,
      DRAW_INDIRECT_WORDS,
    );
  }

  copyCounterToIndexedInstanceCount(encoder: GPUCommandEncoder, batchIndex: number, counterBuffer: GPUBuffer): void {
    if (!this._indexedIndirectBuffer) return;
    encoder.copyBufferToBuffer(counterBuffer, 0, this._indexedIndirectBuffer, this.getIndexedIndirectOffset(batchIndex) + 4, 4);
  }

  copyCounterToDrawInstanceCount(encoder: GPUCommandEncoder, batchIndex: number, counterBuffer: GPUBuffer): void {
    if (!this._drawIndirectBuffer) return;
    encoder.copyBufferToBuffer(counterBuffer, 0, this._drawIndirectBuffer, this.getDrawIndirectOffset(batchIndex) + 4, 4);
  }

  requestSortedIndexReadback(context: RenderCommandContext): boolean {
    const debug = this._sortedReadbackDebug;
    debug.requests++;
    if (!context.afterSubmit || !this._sortIndexBuffer || !this._sortIndexReadbackBuffer || this._count < 1 || this._readbackPending) {
      debug.skipped++;
      return false;
    }
    const byteLength = this._count * 4;
    context.encoder.copyBufferToBuffer(this._sortIndexBuffer, 0, this._sortIndexReadbackBuffer, 0, byteLength);
    this._readbackPending = true;
    beginReadback(debug);
    const readback = this._sortIndexReadbackBuffer;
    const count = this._count;
    const generation = this._readbackGeneration;
    context.afterSubmit(() => {
      debug.mappingStarted++;
      void readback.mapAsync(GPUMapMode.READ)
        .then(() => {
          if (generation !== this._readbackGeneration || readback !== this._sortIndexReadbackBuffer) {
            debug.cancelled++;
            return;
          }
          const mapped = new Uint32Array(readback.getMappedRange());
          const next = new Uint32Array(count);
          let write = 0;
          for (let i = 0; i < count; i++) {
            const index = mapped[i];
            if (index !== undefined && index < count) next[write++] = index;
          }
          this._lastSortedIndices = write === count ? next : next.slice(0, write);
          debug.completed++;
        })
        .catch(() => {
          if (generation !== this._readbackGeneration || readback !== this._sortIndexReadbackBuffer) {
            debug.cancelled++;
          } else {
            this._lastSortedIndices = new Uint32Array(0);
            debug.failed++;
          }
        })
        .finally(() => {
          try {
            readback.unmap();
          } catch {
            // Buffer may already be destroyed during teardown.
          }
          if (generation === this._readbackGeneration && readback === this._sortIndexReadbackBuffer) {
            this._readbackPending = false;
          } else {
            readback.destroy();
          }
          debug.pending = Math.max(0, debug.pending - 1);
        });
    });
    return true;
  }

  getSortedIndices(count = this._count): Uint32Array | null {
    if (count < 1 || this._lastSortedIndices.length !== count) return null;
    return this._lastSortedIndices;
  }

  get lastIndexedInstanceCountSum(): number | null {
    return this._lastIndexedInstanceCountSum;
  }

  requestIndexedInstanceCountReadback(
    context: RenderCommandContext,
    options: GpuDrivenReadbackRequestOptions = {},
  ): boolean {
    const debug = this._indexedReadbackDebug;
    debug.requests++;
    if (!context.afterSubmit || !this._indexedIndirectBuffer || this._count < 1) {
      debug.skipped++;
      return false;
    }
    const preferredSlot = this._indexedInstanceCountReadbackCursor;
    const fallbackSlot = preferredSlot === 0 ? 1 : 0;
    const slot = this._indexedInstanceCountReadbackPending[preferredSlot]
      ? (this._indexedInstanceCountReadbackPending[fallbackSlot] ? -1 : fallbackSlot)
      : preferredSlot;
    if (slot < 0) {
      debug.skipped++;
      return false;
    }
    const readback = this._indexedInstanceCountReadbackBuffers[slot];
    if (!readback) {
      debug.skipped++;
      return false;
    }
    this._indexedInstanceCountReadbackCursor = slot === 0 ? 1 : 0;
    const byteLength = this._count * INDEXED_INDIRECT_BYTES;
    context.encoder.copyBufferToBuffer(this._indexedIndirectBuffer, 0, readback, 0, byteLength);
    this._indexedInstanceCountReadbackPending[slot] = true;
    beginReadback(debug);
    const count = this._count;
    const generation = this._readbackGeneration;
    const requestId = ++this._nextReadbackRequestId;
    const token = options.token;
    context.afterSubmit(() => {
      debug.mappingStarted++;
      void readback.mapAsync(GPUMapMode.READ)
        .then(() => {
          if (generation !== this._readbackGeneration || readback !== this._indexedInstanceCountReadbackBuffers[slot]) {
            debug.cancelled++;
            emitReadbackResult(options, { requestId, status: 'cancelled', value: null, ...(token !== undefined ? { token } : {}), published: false });
            return;
          }
          const mapped = new Uint32Array(readback.getMappedRange());
          let sum = 0;
          for (let i = 0; i < count; i++) {
            sum += mapped[i * INDEXED_INDIRECT_WORDS + 1] ?? 0;
          }
          const published = requestId > this._lastIndexedReadbackRequestId;
          if (published) {
            this._lastIndexedReadbackRequestId = requestId;
            this._lastIndexedInstanceCountSum = sum;
          } else {
            debug.staleCompletions++;
          }
          debug.completed++;
          emitReadbackResult(options, { requestId, status: 'completed', value: sum, ...(token !== undefined ? { token } : {}), published });
        })
        .catch(() => {
          if (generation !== this._readbackGeneration || readback !== this._indexedInstanceCountReadbackBuffers[slot]) {
            debug.cancelled++;
            emitReadbackResult(options, { requestId, status: 'cancelled', value: null, ...(token !== undefined ? { token } : {}), published: false });
          } else {
            this._lastIndexedInstanceCountSum = null;
            debug.failed++;
            emitReadbackResult(options, { requestId, status: 'failed', value: null, ...(token !== undefined ? { token } : {}), published: false });
          }
        })
        .finally(() => {
          try {
            readback.unmap();
          } catch {
            // Buffer may already be destroyed during teardown.
          }
          if (generation === this._readbackGeneration && readback === this._indexedInstanceCountReadbackBuffers[slot]) {
            this._indexedInstanceCountReadbackPending[slot] = false;
          } else {
            readback.destroy();
          }
          debug.pending = Math.max(0, debug.pending - 1);
        });
    });
    return true;
  }

  getReadbackDebugSnapshot(): GpuDrivenReadbackDebugSnapshot {
    return Object.freeze({
      sortedIndices: freezeReadbackDebugState(this._sortedReadbackDebug),
      indexedInstanceCounts: freezeReadbackDebugState(this._indexedReadbackDebug),
    });
  }

  destroy(): void {
    this._readbackGeneration++;
    this._commandBuffer?.destroy();
    this._indexedIndirectBuffer?.destroy();
    this._drawIndirectBuffer?.destroy();
    this._boundsBuffer?.destroy();
    if (!this._sharedTables) {
      this._instanceTableBuffer?.destroy();
      this._materialTableBuffer?.destroy();
    }
    this._megaBatchRunBuffer?.destroy();
    this._sortKeyBuffer?.destroy();
    this._sortIndexBuffer?.destroy();
    destroyReadbackWhenIdle(this._sortIndexReadbackBuffer, this._readbackPending);
    destroyReadbackWhenIdle(this._indexedInstanceCountReadbackBuffers[0], this._indexedInstanceCountReadbackPending[0]);
    destroyReadbackWhenIdle(this._indexedInstanceCountReadbackBuffers[1], this._indexedInstanceCountReadbackPending[1]);
    this._commandBuffer = null;
    this._indexedIndirectBuffer = null;
    this._drawIndirectBuffer = null;
    this._boundsBuffer = null;
    this._instanceTableBuffer = null;
    this._materialTableBuffer = null;
    this._megaBatchRunBuffer = null;
    this._sortKeyBuffer = null;
    this._sortIndexBuffer = null;
    this._sortIndexReadbackBuffer = null;
    this._indexedInstanceCountReadbackBuffers = [null, null];
    this._capacity = 0;
    this._paddedCapacity = 0;
    this._gpuCapacity = 0;
    this._gpuPaddedCapacity = 0;
    this._gpuUploadEnabled = false;
    this._count = 0;
    this._instanceTableCount = 0;
    this._materialTableCount = 0;
    this._megaBatchRunCount = 0;
    this._commandData = new Uint32Array(0);
    this._indexedIndirectData = new Uint32Array(0);
    this._drawIndirectData = new Uint32Array(0);
    this._boundsData = new Float32Array(0);
    this._instanceTableData = new Uint32Array(0);
    this._materialTableData = new Uint32Array(0);
    this._megaBatchRunData = new Uint32Array(0);
    this._sortKeyData = new Uint32Array(0);
    this._sortIndexData = new Uint32Array(0);
    this._lastSortedIndices = new Uint32Array(0);
    this._lastIndexedInstanceCountSum = null;
    this._readbackPending = false;
    this._indexedInstanceCountReadbackPending = [false, false];
    this._indexedInstanceCountReadbackCursor = 0;
  }

  private _ensureCapacity(required: number, ensureGpuResources = true): void {
    const nextCapacity = nextCapacityFor(required);
    const nextPaddedCapacity = nextPowerOfTwo(Math.max(1, required));
    const cpuGrowth = nextCapacity > this._capacity || nextPaddedCapacity > this._paddedCapacity;
    if (cpuGrowth) {
      this._capacity = nextCapacity;
      this._paddedCapacity = nextPaddedCapacity;
      this._commandData = new Uint32Array(this._capacity * DRAW_COMMAND_WORDS);
      this._indexedIndirectData = new Uint32Array(this._capacity * INDEXED_INDIRECT_WORDS);
      this._drawIndirectData = new Uint32Array(this._capacity * DRAW_INDIRECT_WORDS);
      this._boundsData = new Float32Array(this._capacity * BOUNDS_WORDS);
      this._instanceTableData = this._sharedTables
        ? new Uint32Array(0)
        : new Uint32Array(this._capacity * INSTANCE_TABLE_WORDS);
      this._materialTableData = this._sharedTables
        ? new Uint32Array(0)
        : new Uint32Array(this._capacity * MATERIAL_TABLE_WORDS);
      this._megaBatchRunData = new Uint32Array(this._capacity * MEGA_BATCH_RUN_WORDS);
      this._sortKeyData = new Uint32Array(this._paddedCapacity);
      this._sortIndexData = new Uint32Array(this._paddedCapacity);
    }
    if (!ensureGpuResources) return;
    if (
      this._gpuCapacity >= this._capacity
      && this._gpuPaddedCapacity >= this._paddedCapacity
      && this._commandBuffer
      && this._indexedIndirectBuffer
      && this._drawIndirectBuffer
      && this._boundsBuffer
      && this._megaBatchRunBuffer
      && this._sortKeyBuffer
      && this._sortIndexBuffer
      && (this._sharedTables || (this._instanceTableBuffer && this._materialTableBuffer))
    ) return;

    const device = this._engine.device;
    if (!device) return;
    this._readbackGeneration++;
    this._commandBuffer?.destroy();
    this._indexedIndirectBuffer?.destroy();
    this._drawIndirectBuffer?.destroy();
    this._boundsBuffer?.destroy();
    if (!this._sharedTables) {
      this._instanceTableBuffer?.destroy();
      this._materialTableBuffer?.destroy();
    }
    this._megaBatchRunBuffer?.destroy();
    this._sortKeyBuffer?.destroy();
    this._sortIndexBuffer?.destroy();
    destroyReadbackWhenIdle(this._sortIndexReadbackBuffer, this._readbackPending);
    destroyReadbackWhenIdle(this._indexedInstanceCountReadbackBuffers[0], this._indexedInstanceCountReadbackPending[0]);
    destroyReadbackWhenIdle(this._indexedInstanceCountReadbackBuffers[1], this._indexedInstanceCountReadbackPending[1]);

    this._commandBuffer = device.createBuffer({
      label: `${this.label}.commands`,
      size: Math.max(4, this._capacity * DRAW_COMMAND_BYTES),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this._indexedIndirectBuffer = device.createBuffer({
      label: `${this.label}.indexedIndirect`,
      size: Math.max(INDEXED_INDIRECT_BYTES, this._capacity * INDEXED_INDIRECT_BYTES),
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this._drawIndirectBuffer = device.createBuffer({
      label: `${this.label}.drawIndirect`,
      size: Math.max(DRAW_INDIRECT_BYTES, this._capacity * DRAW_INDIRECT_BYTES),
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this._boundsBuffer = device.createBuffer({
      label: `${this.label}.bounds`,
      size: Math.max(BOUNDS_BYTES, this._capacity * BOUNDS_BYTES),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    if (!this._sharedTables) {
      this._instanceTableBuffer = device.createBuffer({
        label: `${this.label}.instanceTable`,
        size: Math.max(INSTANCE_TABLE_BYTES, this._capacity * INSTANCE_TABLE_BYTES),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      this._materialTableBuffer = device.createBuffer({
        label: `${this.label}.materialTable`,
        size: Math.max(MATERIAL_TABLE_BYTES, this._capacity * MATERIAL_TABLE_BYTES),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
    }
    this._megaBatchRunBuffer = device.createBuffer({
      label: `${this.label}.megaBatchRuns`,
      size: Math.max(MEGA_BATCH_RUN_BYTES, this._capacity * MEGA_BATCH_RUN_BYTES),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this._sortKeyBuffer = device.createBuffer({
      label: `${this.label}.sortKeys`,
      size: Math.max(4, this._paddedCapacity * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this._sortIndexBuffer = device.createBuffer({
      label: `${this.label}.sortIndices`,
      size: Math.max(4, this._paddedCapacity * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this._sortIndexReadbackBuffer = device.createBuffer({
      label: `${this.label}.sortIndices.readback`,
      size: Math.max(4, this._paddedCapacity * 4),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this._indexedInstanceCountReadbackBuffers = [0, 1].map(index => device.createBuffer({
      label: `${this.label}.indexedInstanceCounts.readback.${index}`,
      size: Math.max(INDEXED_INDIRECT_BYTES, this._capacity * INDEXED_INDIRECT_BYTES),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })) as [GPUBuffer, GPUBuffer];
    this._lastSortedIndices = new Uint32Array(0);
    this._lastIndexedInstanceCountSum = null;
    this._readbackPending = false;
    this._indexedInstanceCountReadbackPending = [false, false];
    this._indexedInstanceCountReadbackCursor = 0;
    this._gpuCapacity = this._capacity;
    this._gpuPaddedCapacity = this._paddedCapacity;
  }
}

function createReadbackDebugState(): MutableReadbackPathDebugSnapshot {
  return {
    requests: 0,
    accepted: 0,
    skipped: 0,
    mappingStarted: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    staleCompletions: 0,
    pending: 0,
    maxPending: 0,
  };
}

function beginReadback(debug: MutableReadbackPathDebugSnapshot): void {
  debug.accepted++;
  debug.pending++;
  debug.maxPending = Math.max(debug.maxPending, debug.pending);
}

function freezeReadbackDebugState(debug: MutableReadbackPathDebugSnapshot): GpuDrivenReadbackPathDebugSnapshot {
  return Object.freeze({ ...debug });
}

function emitReadbackResult(options: GpuDrivenReadbackRequestOptions, result: GpuDrivenReadbackResult): void {
  try {
    options.onComplete?.(Object.freeze(result));
  } catch {
    // Diagnostic consumers must not disrupt renderer cleanup.
  }
}

function destroyReadbackWhenIdle(buffer: GPUBuffer | null, pending: boolean): void {
  if (buffer && !pending) buffer.destroy();
  // A MAP_READ buffer must remain alive until mapAsync settles. The request's
  // finally handler owns native destruction after a generation change.
}

function nextCapacityFor(required: number): number {
  if (required <= 0) return 1;
  return alignUp(required, 16);
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result <<= 1;
  return result;
}

function throwRendererResourceNotReady(message: string): never {
  throw new EngineError(
    EngineErrorCode.RendererResourceNotReady,
    message,
    {
      hint: 'Call upload() with at least one command before accessing GPU buffers.',
      docsPath: 'errors/E_RENDERER_RESOURCE_NOT_READY',
    },
  );
}

function writeQueueBuffer(queue: GPUQueue, buffer: GPUBuffer, data: Uint32Array | Float32Array, words: number): void {
  queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, words * 4);
}
