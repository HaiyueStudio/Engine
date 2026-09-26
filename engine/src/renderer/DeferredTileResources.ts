import type { RenderCommandContext } from '../core/RenderCommandContext';
import { DeferredLightingCapabilityError } from '../frame/DeferredLightTable';
import { DEFERRED_TILE_LAYOUT as TILE } from '../shaders/generated/deferred-tile-layout.generated';
import { FrameRingResource } from './FrameRingResource';

export interface DeferredTileOptions {
  /** Diagnostic oracle forces the GPU culling/overflow path even when no reduction is possible. */
  readonly forceCulling?: boolean;
  /** Private diagnostic controls: smaller capacity must preserve full-list output. */
  readonly tileCapacity?: number;
  readonly maxTileRecords?: number;
}
export interface DeferredTilePlan {
  readonly columns: number; readonly rows: number; readonly tileCount: number;
  readonly storedTiles: number; readonly tileCapacity: number; readonly byteSize: number;
  readonly fullListTiles: number; readonly viewBytes: number;
}

export function planDeferredTiles(device: GPUDevice, width: number, height: number, options: DeferredTileOptions = {}): DeferredTilePlan {
  for (const value of [width, height]) if (!Number.isSafeInteger(value) || value < 1 || value > device.limits.maxTextureDimension2D) {
    throw new DeferredLightingCapabilityError('tile-extent', value, device.limits.maxTextureDimension2D);
  }
  const tileCapacity = options.tileCapacity ?? TILE.capacity;
  const limit = options.maxTileRecords ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(tileCapacity) || tileCapacity < 0 || tileCapacity > TILE.capacity) throw new RangeError('Invalid tile capacity.');
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid tile record limit.');
  for (const [key, required] of Object.entries({ maxComputeInvocationsPerWorkgroup: TILE.workgroupSize,
    maxComputeWorkgroupSizeX: TILE.workgroupSize, maxComputeWorkgroupStorageSize: (TILE.workgroupSize + 1) * 4,
    maxStorageBuffersPerShaderStage: 3, maxComputeWorkgroupsPerDimension: 1,
    maxStorageBufferBindingSize: 4, maxBufferSize: 4 })) {
    const actual = device.limits[key as keyof GPUSupportedLimits];
    if (typeof actual !== 'number' || actual < required) throw new DeferredLightingCapabilityError(`device-limit:${key}`, typeof actual === 'number' ? actual : 0, required);
  }
  const columns = Math.ceil(width / TILE.tileSize), rows = Math.ceil(height / TILE.tileSize), tileCount = columns * rows;
  if (Math.max(columns, rows) > device.limits.maxComputeWorkgroupsPerDimension) throw new DeferredLightingCapabilityError('tile-dispatch', Math.max(columns, rows), device.limits.maxComputeWorkgroupsPerDimension);
  const storedTiles = Math.min(tileCount, limit);
  const byteSize = Math.max(4, storedTiles * TILE.strideWords * 4);
  const supported = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
  if (byteSize > supported) throw new DeferredLightingCapabilityError('tile-buffer-bytes', byteSize, supported);
  const viewBytes = 28 * width * height + byteSize + 4 * 1024 + 32;
  if (viewBytes > 64 * 1024 * 1024) throw new DeferredLightingCapabilityError('view-deferred-bytes', viewBytes, 64 * 1024 * 1024);
  return { columns, rows, tileCount, storedTiles, tileCapacity, byteSize, fullListTiles: tileCount - storedTiles, viewBytes };
}

interface RecordBuffer { buffer: GPUBuffer; readonly encoders: Set<GPUCommandEncoder>; retired: boolean; destroyed: boolean }
interface ViewBuffers { ring: FrameRingResource<RecordBuffer>; readonly live: Set<RecordBuffer> }

/** GPU-produced lists are overwritten by compute immediately before their own resolve.
 * Reuse across submissions is safe; destruction still protects every referencing encoder. */
export class DeferredTileResources {
  private readonly _views = new Map<string, ViewBuffers>();
  private readonly _live = new Set<RecordBuffer>();
  private readonly _scopes = new Map<string, Set<RecordBuffer>>();
  private _destroyed = false;
  constructor(private readonly _device: GPUDevice) {}

  acquire(key: string, plan: DeferredTilePlan, context: RenderCommandContext): GPUBufferBinding {
    if (this._destroyed) throw new Error('Deferred tiles are destroyed.');
    if (context.device !== this._device) throw new Error('Deferred tiles device generation mismatch.');
    if (!context.afterSubmit) throw new Error('Deferred tiles require afterSubmit.');
    let view = this._views.get(key);
    if (!view) {
      if (!this._scopes.has(key) && this._scopes.size >= 4) throw new DeferredLightingCapabilityError('tile-view-count', this._scopes.size + 1, 4);
      const live = this._scopes.get(key) ?? new Set<RecordBuffer>();
      this._scopes.set(key, live);
      const ring = new FrameRingResource<RecordBuffer>({ label: `DeferredTiles:${key}`, framesInFlight: 1, growthFactor: 1 + Number.EPSILON,
        initialCapacity: plan.byteSize, maximumCapacity: Math.min(this._device.limits.maxStorageBufferBindingSize, this._device.limits.maxBufferSize),
        create: info => {
          if (live.size >= 2) throw new DeferredLightingCapabilityError('tile-live-generations', live.size + 1, 2);
          const record: RecordBuffer = { buffer: this._device.createBuffer({ label: `DeferredTiles:${key}`,
            size: info.capacity, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }), encoders: new Set(), retired: false, destroyed: false };
          live.add(record); this._live.add(record); return record;
        },
        destroy: record => { record.retired = true; this._release(record, live); },
      });
      view = { ring, live }; this._views.set(key, view);
    }
    // With integer byte requirements, this growth factor allocates exactly the required size.
    view.ring.ensureCapacity(plan.byteSize, context);
    const actualViewBytes = plan.viewBytes - plan.byteSize + view.ring.capacity;
    if (actualViewBytes > 64 * 1024 * 1024) throw new DeferredLightingCapabilityError('view-deferred-bytes', actualViewBytes, 64 * 1024 * 1024);
    const record = view.ring.resource;
    view.ring.markUsed();
    if (!record.encoders.has(context.encoder)) {
      record.encoders.add(context.encoder);
      const live = view.live;
      context.afterSubmit(queue => {
        const done = () => { record.encoders.delete(context.encoder); this._release(record, live); };
        void queue.onSubmittedWorkDone().then(done, done);
      });
    }
    return { buffer: record.buffer, size: plan.byteSize };
  }

  retain(keys: ReadonlySet<string>): void { for (const key of this._views.keys()) if (!keys.has(key)) this.releaseView(key); }
  releaseView(key: string): void { const view = this._views.get(key); if (view) { view.ring.destroy(); this._views.delete(key); } }
  destroy(abandon = false): void {
    this._destroyed = true;
    for (const key of this._views.keys()) this.releaseView(key);
    if (abandon) for (const record of this._live) { record.encoders.clear(); this._release(record); }
  }
  get stats() { return { views: this._views.size, liveBuffers: this._live.size, bytes: [...this._live].reduce((n, r) => n + r.buffer.size, 0) }; }
  private _release(record: RecordBuffer, live?: Set<RecordBuffer>): void {
    if (!record.retired || record.encoders.size || record.destroyed) return;
    record.destroyed = true; record.buffer.destroy(); live?.delete(record); this._live.delete(record);
    for (const [key, records] of this._scopes) { records.delete(record); if (!records.size) this._scopes.delete(key); }
  }
}
