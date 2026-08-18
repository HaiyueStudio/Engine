import {
  createGPUResourceOwner,
  getInstrumentedGPUResourceTracker,
  type GPUResourceOwner,
  type GPUResourceTracker,
} from '../core/GPUResourceTracker';
import {
  getSceneFrameUniformSnapshotMetadata,
  SceneFrameUniformLayout,
  type SceneFrameUniformSnapshot,
} from '../frame/SceneFrameUniformLayout';
import { writeBuffer } from './utils';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { FrameRingResource, type FrameRingGenerationInfo } from './FrameRingResource';

export interface SceneFrameGpuArenaOptions {
  /** Initial simultaneously addressable view streams. */
  maxViews?: number;
  /** Hard view-stream limit. Defaults to the GPUDevice maxBufferSize limit. */
  maximumViews?: number;
  /** CPU/GPU overlap protected by distinct buffer regions. */
  framesInFlight?: number;
}

export interface SceneFrameGpuArenaStats {
  readonly framesInFlight: number;
  readonly maxViews: number;
  readonly maximumViews: number;
  readonly remainingViews: number;
  readonly growableViews: number;
  readonly generation: number;
  readonly retiringGenerations: number;
  readonly viewCount: number;
  readonly slotStride: number;
  readonly bufferSize: number;
  readonly uploadCount: number;
}

interface SceneFrameGpuSlot {
  readonly slot: number;
  readonly uploadedRevisions: number[];
  references: number;
}

interface SceneFrameGpuGeneration {
  readonly info: FrameRingGenerationInfo;
  readonly buffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
}

const DEFAULT_MAX_VIEWS = 256;
const DEFAULT_FRAMES_IN_FLIGHT = 3;
const arenas = new WeakMap<GPUDevice, SceneFrameGpuArena>();

/** One SceneFrame uniform buffer and bind group shared by every compatible pipeline on a device. */
export class SceneFrameGpuArena {
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly slotStride: number;
  readonly framesInFlight: number;
  readonly maximumViews: number;

  private readonly _streamSlots = new WeakMap<object, SceneFrameGpuSlot>();
  private readonly _activeStreams = new Set<object>();
  private readonly _directStreams = new Set<object>();
  private readonly _freeSlots: number[] = [];
  private readonly _tracker: GPUResourceTracker | undefined;
  private readonly _owner: GPUResourceOwner | undefined;
  private readonly _ring: FrameRingResource<SceneFrameGpuGeneration>;
  private _viewCount = 0;
  private _nextSlot = 0;
  private _uploadCount = 0;
  private _destroyed = false;

  constructor(readonly device: GPUDevice, options: SceneFrameGpuArenaOptions = {}) {
    const alignment = device.limits?.minUniformBufferOffsetAlignment ?? 256;
    this.slotStride = alignTo(SceneFrameUniformLayout.size, alignment);
    this.framesInFlight = normalizePositiveInteger(options.framesInFlight ?? DEFAULT_FRAMES_IN_FLIGHT, 'framesInFlight');
    const requestedViews = normalizePositiveInteger(options.maxViews ?? DEFAULT_MAX_VIEWS, 'maxViews');
    const maxBufferSize = Number(device.limits?.maxBufferSize ?? Number.MAX_SAFE_INTEGER);
    const deviceViewLimit = Math.floor(maxBufferSize / this.slotStride / this.framesInFlight);
    this.maximumViews = Math.min(
      normalizePositiveInteger(options.maximumViews ?? deviceViewLimit, 'maximumViews'),
      deviceViewLimit,
    );
    const initialViews = Math.min(requestedViews, this.maximumViews);
    if (initialViews < 1) {
      throw new RangeError('GPUDevice maxBufferSize cannot fit one SceneFrame uniform arena slot.');
    }
    const maxBindingSize = Number(device.limits?.maxUniformBufferBindingSize ?? Number.MAX_SAFE_INTEGER);
    if (SceneFrameUniformLayout.size > maxBindingSize) {
      throw new RangeError(`SceneFrame uniform size ${SceneFrameUniformLayout.size} exceeds maxUniformBufferBindingSize ${maxBindingSize}.`);
    }

    this._tracker = getInstrumentedGPUResourceTracker(device);
    this._owner = this._tracker ? createGPUResourceOwner('engine', 'SceneFrameGpuArena') : undefined;
    this.bindGroupLayout = this._createBindGroupLayout();
    this._ring = new FrameRingResource<SceneFrameGpuGeneration>({
      label: 'SceneFrameGpuArena',
      initialCapacity: initialViews,
      maximumCapacity: this.maximumViews,
      framesInFlight: 1,
      create: info => this._createGenerationResources(info),
      destroy: resources => this._destroyGenerationResources(resources),
    });
  }

  get bindGroup(): GPUBindGroup { return this._ring.resource.bindGroup; }
  get buffer(): GPUBuffer { return this._ring.resource.buffer; }
  get maxViews(): number { return this._ring.capacity; }
  get remainingViews(): number { return Math.max(0, this.maxViews - this._viewCount); }
  get growableViews(): number { return Math.max(0, this.maximumViews - this._viewCount); }

  /** Uploads a snapshot at most once and returns its aligned dynamic buffer offset. */
  upload(snapshot: SceneFrameUniformSnapshot, context?: RenderCommandContext): number {
    return this._upload(snapshot, this._directStreams, context);
  }

  /** Grows once before encoding if the supplied snapshots may need new slots. */
  ensureCapacityForSnapshots(
    snapshots: readonly SceneFrameUniformSnapshot[],
    context?: RenderCommandContext,
  ): boolean {
    if (this._destroyed) throw new Error('SceneFrameGpuArena has been destroyed.');
    const missing = new Set<object>();
    for (const snapshot of snapshots) {
      const stream = getSceneFrameUniformSnapshotMetadata(snapshot)?.stream ?? snapshot;
      if (!this._streamSlots.has(stream)) missing.add(stream);
    }
    const required = this._nextSlot + Math.max(0, missing.size - this._freeSlots.length);
    return this._ensureCapacity(Math.max(1, required), context);
  }

  /** Creates a renderer/scene-scoped lease over the device-owned arena. */
  createBinding(): SceneFrameGpuBinding {
    if (this._destroyed) throw new Error('SceneFrameGpuArena has been destroyed.');
    return new SceneFrameGpuBinding(this);
  }

  /** @internal */
  _upload(
    snapshot: SceneFrameUniformSnapshot,
    retainedStreams: Set<object>,
    context?: RenderCommandContext,
  ): number {
    if (this._destroyed) throw new Error('SceneFrameGpuArena has been destroyed.');
    const metadata = getSceneFrameUniformSnapshotMetadata(snapshot);
    const stream = metadata?.stream ?? snapshot;
    const revision = metadata?.revision ?? fallbackRevision(snapshot);
    let slot = this._streamSlots.get(stream);
    if (!retainedStreams.has(stream)) {
      retainedStreams.add(stream);
      if (slot) {
        slot.references++;
      } else {
        const slotIndex = this._freeSlots.pop() ?? this._nextSlot++;
        this._ensureCapacity(slotIndex + 1, context);
        slot = { slot: slotIndex, uploadedRevisions: new Array<number>(this.framesInFlight).fill(0), references: 1 };
        this._streamSlots.set(stream, slot);
        this._activeStreams.add(stream);
        this._viewCount++;
      }
    }
    if (!slot) {
      // The retaining binding can only outlive a slot after arena disposal.
      throw new Error('SceneFrameGpuArena view slot is unavailable.');
    }
    const ringIndex = (revision - 1) % this.framesInFlight;
    const dynamicOffset = (ringIndex * this.maxViews + slot.slot) * this.slotStride;
    if (slot.uploadedRevisions[ringIndex] !== revision) {
      this._ring.markUsed();
      writeBuffer(this.device.queue, this._ring.resource.buffer, dynamicOffset, snapshot.data);
      slot.uploadedRevisions[ringIndex] = revision;
      this._uploadCount++;
    }
    return dynamicOffset;
  }

  /** @internal */
  _releaseStreams(streams: Set<object>): void {
    if (this._destroyed) {
      streams.clear();
      return;
    }
    for (const stream of streams) {
      const slot = this._streamSlots.get(stream);
      if (!slot) continue;
      slot.references--;
      if (slot.references === 0) {
        this._streamSlots.delete(stream);
        this._activeStreams.delete(stream);
        this._freeSlots.push(slot.slot);
        this._viewCount--;
      }
    }
    streams.clear();
  }

  getStats(): SceneFrameGpuArenaStats {
    return Object.freeze({
      framesInFlight: this.framesInFlight,
      maxViews: this.maxViews,
      maximumViews: this.maximumViews,
      remainingViews: this.remainingViews,
      growableViews: this.growableViews,
      generation: this._ring.generation,
      retiringGenerations: this._ring.getStats().retiringGenerations,
      viewCount: this._viewCount,
      slotStride: this.slotStride,
      bufferSize: this.buffer.size,
      uploadCount: this._uploadCount,
    });
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._ring.destroy();
    if (this._tracker && this._owner) this._tracker.releaseOwner(this._owner);
  }

  private _ensureCapacity(required: number, context?: RenderCommandContext): boolean {
    const grew = this._ring.ensureCapacity(required, context);
    if (!grew) return false;
    for (const stream of this._activeStreams) this._streamSlots.get(stream)?.uploadedRevisions.fill(0);
    return true;
  }

  private _createBindGroupLayout(): GPUBindGroupLayout {
    const create = () => {
      return this.device.createBindGroupLayout({
        label: 'SceneFrameGpuArena.bindGroupLayout',
        entries: [{
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform' as const,
            hasDynamicOffset: true,
            minBindingSize: SceneFrameUniformLayout.size,
          },
        }],
      });
    };
    return this._tracker && this._owner ? this._tracker.withOwner(this._owner, create) : create();
  }

  private _createGenerationResources(info: FrameRingGenerationInfo): SceneFrameGpuGeneration {
    const create = () => {
      const suffix = info.generation === 1 ? '' : `.generation.${info.generation}`;
      const buffer = this.device.createBuffer({
        label: `SceneFrameGpuArena.buffer${suffix}`,
        size: this.slotStride * info.capacity * this.framesInFlight,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = this.device.createBindGroup({
        label: `SceneFrameGpuArena.bindGroup${suffix}`,
        layout: this.bindGroupLayout,
        entries: [{ binding: 0, resource: { buffer, size: SceneFrameUniformLayout.size } }],
      });
      return { info, buffer, bindGroup };
    };
    return this._tracker && this._owner ? this._tracker.withOwner(this._owner, create) : create();
  }

  private _destroyGenerationResources(resources: SceneFrameGpuGeneration): void {
    this._tracker?.untrackObject(resources.bindGroup);
    this._tracker?.untrackBuffer(resources.buffer);
    resources.buffer.destroy();
  }
}

/** Renderer-scoped arena lease. Destroying it releases view slots without destroying shared GPU resources. */
export class SceneFrameGpuBinding {
  private readonly _streams = new Set<object>();
  private _destroyed = false;

  constructor(readonly arena: SceneFrameGpuArena) {}

  get bindGroupLayout(): GPUBindGroupLayout { return this.arena.bindGroupLayout; }
  get bindGroup(): GPUBindGroup { return this.arena.bindGroup; }

  upload(snapshot: SceneFrameUniformSnapshot, context?: RenderCommandContext): number {
    if (this._destroyed) throw new Error('SceneFrameGpuBinding has been destroyed.');
    return this.arena._upload(snapshot, this._streams, context);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.arena._releaseStreams(this._streams);
  }
}

export function getSceneFrameGpuArena(device: GPUDevice): SceneFrameGpuArena {
  let arena = arenas.get(device);
  if (!arena) {
    arena = new SceneFrameGpuArena(device);
    arenas.set(device, arena);
  }
  return arena;
}

export function disposeSceneFrameGpuArena(device: GPUDevice): void {
  const arena = arenas.get(device);
  if (!arena) return;
  arenas.delete(device);
  arena.destroy();
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer.`);
  return value;
}

function fallbackRevision(snapshot: SceneFrameUniformSnapshot): number {
  const revision = ((snapshot.frameId * 65537) + snapshot.phaseRevision) >>> 0;
  return revision === 0 ? 1 : revision;
}
