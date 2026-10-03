import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { TransientRenderTargetPool } from './TransientRenderTargetPool';
import { TransientAttachmentCapacityError } from './TransientRenderTargetPool';
import { TransientTextureAllocator } from './TransientTextureAllocator';

interface Sequence {
  allocator: TransientTextureAllocator;
  release: (() => void) | undefined;
  views: Set<string>;
  pending: Map<string, Set<GPUCommandEncoder>>;
  surfaces: Map<string, { textures: readonly GPUTexture[]; views: readonly GPUTextureView[] }>;
}
const sequences = new WeakMap<TransientRenderTargetPool, Sequence>();

/** Same owner as the MRT pool. Latest G-buffer stays pinned for diagnostic reads until the next view. */
export function acquireSequentialAttachments(pool: TransientRenderTargetPool, scope: string, width: number, height: number,
  formats: readonly GPUTextureFormat[], context: RenderCommandContext,
  lifetime: { firstUse: number; lastUse: number }, reverseZ: boolean, reserveBytes: (bytes: number) => () => void) {
  let sequence = sequences.get(pool);
  if (!sequence) {
    sequence = { allocator: new TransientTextureAllocator(context.device, reserveBytes, 32, 'deferred-mrt'), release: undefined,
      views: new Set(), pending: new Map(), surfaces: new Map() };
    sequences.set(pool, sequence);
  }
  const live = context.viewFamily ? new Set(context.viewFamily.views.map(view => view.key)) : sequence.views;
  const viewCount = new Set([...live, ...sequence.pending.keys(), scope]).size;
  if (viewCount > 4) throw new TransientAttachmentCapacityError('view-count', viewCount, 4);
  const pending = sequence.pending.get(scope) ?? new Set<GPUCommandEncoder>();
  if (!pending.has(context.encoder) && pending.size >= 2) throw new TransientAttachmentCapacityError('live-target-generations', pending.size + 1, 2);
  sequence.views = live; sequence.views.add(scope);
  sequence.release?.(); sequence.release = undefined;
  const allocation = sequence.allocator.acquire(formats.map((format, i) => ({ name: `${scope}:gbuffer:${i}`,
    descriptor: { label: `TransientMRT:${scope}:${i}`, size: [width, height], format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC },
    compatibility: format.startsWith('depth') ? `reverseZ:${reverseZ}` : '', firstUse: lifetime.firstUse, lastUse: lifetime.lastUse,
  })), context);
  sequence.release = allocation.release;
  if (!pending.has(context.encoder)) {
    pending.add(context.encoder); sequence.pending.set(scope, pending);
    const owner = sequence;
    context.afterSubmit!(queue => {
      pending.delete(context.encoder);
      if (!pending.size) owner.pending.delete(scope);
      void queue;
    });
  }
  const key = allocation.assignments.map(a => a.physicalId).join(':');
  let surfaces = sequence.surfaces.get(key);
  if (!surfaces) {
    surfaces = { textures: allocation.assignments.map(a => a.texture), views: allocation.assignments.map(a => a.view) };
    if (sequence.surfaces.size >= 64) sequence.surfaces.delete(sequence.surfaces.keys().next().value!);
    sequence.surfaces.set(key, surfaces);
  }
  return surfaces;
}
export function getSequentialAttachmentAllocator(pool: TransientRenderTargetPool) { return sequences.get(pool)?.allocator; }
export function releaseSequentialAttachments(pool: TransientRenderTargetPool, abandon = false): void {
  const sequence = sequences.get(pool);
  sequence?.release?.();
  sequence?.allocator.destroy(abandon);
  if (sequence) { sequence.release = undefined; sequence.surfaces.clear(); sequence.views.clear(); if (abandon) sequence.pending.clear(); }
}
