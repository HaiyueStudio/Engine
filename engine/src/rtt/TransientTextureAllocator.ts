import { captureFrameGraphAllocation, frameGraphCaptureActive } from '../core/FrameGraphCapture';
import { FrameGraphPlanCache } from '../core/FrameGraphPlanCache';
import { estimateTextureBytes } from '../core/GPUResourceTracker';
import type { RenderCommandContext } from '../core/RenderCommandContext';

export interface TransientTextureRequest {
  readonly name: string;
  readonly descriptor: GPUTextureDescriptor;
  readonly compatibility?: string;
  readonly firstUse: number;
  readonly lastUse: number;
}
interface Physical {
  readonly id: number;
  readonly key: string;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly bytes: number;
  readonly releaseBytes: () => void;
  readonly pending: Set<GPUCommandEncoder>;
  readonly submitted: Set<GPUCommandEncoder>;
  held: boolean;
  retired: boolean;
  epoch: number;
}
export interface TransientTextureAssignment extends TransientTextureRequest {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly physicalId: number;
  readonly bytes: number;
}

/** Private texture-object reuse. Intervals are inclusive WebGPU usage scopes, not heap aliases. */
export class TransientTextureAllocator {
  private readonly physical: Physical[] = [];
  private epoch = 0;
  private frame: unknown;
  private nextId = 0;
  private destroyed = false;
  // Private diagnostic ablation: retain the same descriptor/lifecycle contract without sharing.
  reuse = true;
  readonly planCache = new FrameGraphPlanCache<readonly { readonly index: number; readonly slot: number }[]>();
  private readonly dedicated = new Map<string, number>();
  readonly stats = { allocations: 0, reuses: 0, logicalBytes: 0, physicalBytes: 0, peakBytes: 0, pendingBytes: 0, pendingPeakBytes: 0, idleBytes: 0, activeBytes: 0 };
  lastAssignments: readonly TransientTextureAssignment[] = [];

  constructor(private readonly device: GPUDevice,
    private readonly reserveBytes: (bytes: number) => () => void = () => () => {},
    private readonly maximumTextures = 64, private readonly diagnosticOwner = 'transient') {}

  beginFrame(frame: unknown): void {
    if (frame === this.frame) return;
    this.frame = frame; this.epoch++;
    for (const item of this.physical) if (!item.held && !item.pending.size && !item.submitted.size && item.epoch < this.epoch - 1) item.retired = true;
    this.collect();
  }

  acquire(requests: readonly TransientTextureRequest[], context: Pick<RenderCommandContext, 'device' | 'encoder' | 'afterSubmit' | 'frameData'>) {
    if (this.destroyed || context.device !== this.device || !context.afterSubmit) throw Error('Transient textures require a live device and submission boundary.');
    // Validate every descriptor and interval before any allocation or mutation.
    const keys = requests.map(request => {
      if (!Number.isSafeInteger(request.firstUse) || request.firstUse < 0 || !Number.isSafeInteger(request.lastUse) || request.lastUse < request.firstUse) throw Error('Invalid transient texture interval.');
      return textureKey(request.descriptor) + (request.compatibility ?? "");
    });
    if (new Set(requests.map(r => r.name)).size !== requests.length) throw Error('Duplicate transient texture name.');
    const frame = context.encoder;
    this.beginFrame(frame);
    const selected = new Map<Physical, number>();
    const created = new Set<Physical>();
    const assignments: TransientTextureAssignment[] = [];
    const planKey = JSON.stringify([this.reuse, requests.map((r, i) => [r.name, keys[i], r.firstUse, r.lastUse])]);
    let order = this.planCache.get(planKey);
    if (!order) {
      const slots: { key: string; lastUse: number }[] = [];
      order = Object.freeze(requests.map((request, index) => ({ request, index })).sort((a, b) => a.request.firstUse - b.request.firstUse).map(({ request, index }) => {
        const key = keys[index]!;
        let slot = this.reuse ? slots.findIndex(value => value.key === key && value.lastUse < request.firstUse) : -1;
        if (slot < 0) { slot = slots.length; slots.push({ key, lastUse: request.lastUse }); }
        else slots[slot]!.lastUse = request.lastUse;
        return Object.freeze({ index, slot });
      }));
      this.planCache.set(planKey, order);
    }
    const resolved = new Map<number, Physical>();
    const decisions: string[] | undefined = frameGraphCaptureActive() ? [] : undefined;
    try {
      for (const { index, slot } of order) {
        const request = requests[index]!, key = keys[index]!;
        const dedicatedKey = `${request.name}:${key}`;
        let item = resolved.get(slot) ?? this.physical.find(candidate => !candidate.retired && candidate.key === key &&
          !candidate.held &&
          (!candidate.pending.size || (candidate.pending.size === 1 && candidate.pending.has(context.encoder))) &&
          (this.reuse || this.dedicated.get(dedicatedKey) === candidate.id));
        if (decisions) decisions.push(resolved.has(slot) ? 'non-overlapping-lifetime-alias' : item ? 'compatible-available-texture' :
          this.physical.some(p => p.key === key && p.pending.size && !p.pending.has(context.encoder)) ? 'different-unsubmitted-encoder' :
          this.physical.some(p => p.key === key && p.held) ? 'overlapping-interval-or-live-lease' : 'no-compatible-available-texture');
        if (!item) {
          if (this.physical.length >= this.maximumTextures) throw Error('Transient texture capacity exceeded.');
          const descriptor = request.descriptor;
          const size = normalizedSize(descriptor.size);
          let bytes = 0;
          for (let mip = 0; mip < (descriptor.mipLevelCount ?? 1); mip++) bytes += estimateTextureBytes([Math.max(1, size[0] >> mip), Math.max(1, size[1] >> mip), descriptor.dimension === "3d" ? Math.max(1, size[2] >> mip) : size[2]], descriptor.format, descriptor.sampleCount ?? 1);
          const releaseBytes = this.reserveBytes(bytes);
          let texture: GPUTexture | undefined;
          try {
            texture = this.device.createTexture(descriptor);
            item = { id: ++this.nextId, key, texture, view: texture.createView(), bytes, releaseBytes,
              held: false, retired: false, epoch: this.epoch, pending: new Set(), submitted: new Set() };
          } catch (error) { texture?.destroy(); releaseBytes(); throw error; }
          this.physical.push(item); this.stats.allocations++;
          created.add(item);
          this.dedicated.set(dedicatedKey, item.id);
        } else this.stats.reuses++;
        resolved.set(slot, item);
        item.held = true; item.epoch = this.epoch; selected.set(item, request.lastUse);
        assignments.push({ ...request, texture: item.texture, view: item.view, physicalId: item.id, bytes: item.bytes });
      }
    } catch (error) {
      for (const item of selected.keys()) item.held = false;
      for (const item of created) item.retired = true;
      this.collect(); throw error;
    }
    for (const item of selected.keys()) {
      if (item.pending.has(context.encoder) || item.submitted.has(context.encoder)) continue;
      item.pending.add(context.encoder);
      context.afterSubmit(queue => {
        item.pending.delete(context.encoder); item.submitted.add(context.encoder); this.refresh();
        const done = () => { item.submitted.delete(context.encoder); this.collect(); };
        void queue.onSubmittedWorkDone().then(done, done);
      });
    }
    this.lastAssignments = assignments;
    this.stats.logicalBytes = assignments.reduce((sum, item) => sum + item.bytes, 0);
    this.refresh();
    if (decisions) captureFrameGraphAllocation(this, this.diagnosticOwner, assignments.map((assignment, i) => ({
      name: assignment.name, physicalId: assignment.physicalId, bytes: assignment.bytes, firstUse: assignment.firstUse, lastUse: assignment.lastUse,
      descriptor: textureKey(assignment.descriptor) + (assignment.compatibility ?? ''), decision: decisions[i]!,
    })), this.stats, this.planCache.stats);
    let released = false;
    return { assignments, release: () => {
      if (released) return; released = true;
      for (const item of selected.keys()) item.held = false;
      this.collect();
    } };
  }

  destroy(abandon = false): void {
    this.destroyed = true; this.planCache.clear();
    for (const item of this.physical) {
      item.held = false; item.retired = true;
      if (abandon) { item.pending.clear(); item.submitted.clear(); }
    }
    this.collect(); this.lastAssignments = [];
  }

  private collect(): void {
    for (let i = this.physical.length - 1; i >= 0; i--) {
      const item = this.physical[i]!;
      if (!item.retired || item.held || item.pending.size || item.submitted.size) continue;
      item.texture.destroy(); item.releaseBytes(); this.physical.splice(i, 1);
      for (const [key, id] of this.dedicated) if (id === item.id) this.dedicated.delete(key);
    }
    this.refresh();
  }
  private refresh(): void {
    const stats = this.stats;
    stats.physicalBytes = 0; stats.pendingBytes = 0; stats.idleBytes = 0; stats.activeBytes = 0;
    for (const item of this.physical) {
      stats.physicalBytes += item.bytes;
      if (item.pending.size || item.submitted.size) stats.pendingBytes += item.bytes;
      else if (item.held) stats.activeBytes += item.bytes;
      else stats.idleBytes += item.bytes;
    }
    stats.pendingPeakBytes = Math.max(stats.pendingPeakBytes, stats.pendingBytes);
    stats.peakBytes = Math.max(stats.peakBytes, stats.physicalBytes);
  }
}

function normalizedSize(size: GPUExtent3D): [number, number, number] {
  const values = Symbol.iterator in Object(size) ? [...size as Iterable<number>] : [
    (size as GPUExtent3DDict).width, (size as GPUExtent3DDict).height ?? 1, (size as GPUExtent3DDict).depthOrArrayLayers ?? 1,
  ];
  const result: [number, number, number] = [values[0]!, values[1] ?? 1, values[2] ?? 1];
  if (result.some(v => !Number.isSafeInteger(v) || v < 1)) throw Error('Invalid transient texture extent.');
  return result;
}
function textureKey(descriptor: GPUTextureDescriptor): string {
  // Entire resources only: exact usages/view formats, no subresource or format reinterpretation.
  return JSON.stringify([normalizedSize(descriptor.size), descriptor.format, descriptor.dimension ?? '2d',
    descriptor.sampleCount ?? 1, descriptor.mipLevelCount ?? 1, descriptor.usage, [...descriptor.viewFormats ?? []].sort()]);
}
