import type { IEngine } from './IEngine';
import { getEngineGPUResourceTracker } from './EngineDiagnosticsAccess';

export type RenderPassLoadOp = 'clear' | 'load';
export type RenderPassStoreOp = 'store' | 'discard';

export interface RenderPassDescriptorCloneOptions {
  loadOp?: RenderPassLoadOp | undefined;
  storeOp?: RenderPassStoreOp | undefined;
  colorLoadOp?: RenderPassLoadOp | undefined;
  colorStoreOp?: RenderPassStoreOp | undefined;
  depthLoadOp?: RenderPassLoadOp | undefined;
  depthStoreOp?: RenderPassStoreOp | undefined;
  depth?: boolean;
}

interface CachedRenderPassDescriptor {
  version: number;
  descriptor: GPURenderPassDescriptor;
}

interface EngineRenderPassDescriptorCache {
  clear?: CachedRenderPassDescriptor;
  load?: CachedRenderPassDescriptor;
  inherit?: CachedRenderPassDescriptor;
}

interface RenderPassColorAttachmentState {
  attachment: GPURenderPassColorAttachment | null;
  view: GPUTexture | GPUTextureView | undefined;
  resolveTarget: GPUTexture | GPUTextureView | undefined;
  clearValue: GPUColor | undefined;
  loadOp: GPULoadOp | undefined;
  storeOp: GPUStoreOp | undefined;
  depthSlice: number | undefined;
}

interface RenderPassDepthAttachmentState {
  attachment: GPURenderPassDepthStencilAttachment;
  view: GPUTexture | GPUTextureView;
  depthClearValue: number | undefined;
  depthLoadOp: GPULoadOp | undefined;
  depthStoreOp: GPUStoreOp | undefined;
  depthReadOnly: boolean | undefined;
  stencilClearValue: number | undefined;
  stencilLoadOp: GPULoadOp | undefined;
  stencilStoreOp: GPUStoreOp | undefined;
  stencilReadOnly: boolean | undefined;
}

interface ClonedRenderPassDescriptorCacheEntry {
  descriptor: GPURenderPassDescriptor;
  label: string | undefined;
  colorAttachments: RenderPassColorAttachmentState[];
  depthStencilAttachment: RenderPassDepthAttachmentState | null;
  occlusionQuerySet: GPUQuerySet | undefined;
  timestampWrites: GPURenderPassTimestampWrites | undefined;
  maxDrawCount: number | undefined;
}

const engineRenderPassDescriptorCache = new WeakMap<IEngine, EngineRenderPassDescriptorCache>();
const clonedRenderPassDescriptorCache = new WeakMap<GPURenderPassDescriptor, Map<number, ClonedRenderPassDescriptorCacheEntry>>();

export function cloneRenderPassDescriptor(
  source: GPURenderPassDescriptor,
  options?: RenderPassLoadOp | RenderPassDescriptorCloneOptions,
): GPURenderPassDescriptor {
  const opts = typeof options === 'object' ? options : undefined;
  const loadOp = typeof options === 'string' ? options : opts?.loadOp;
  const colorLoadOp = opts?.colorLoadOp ?? loadOp;
  const colorStoreOp = opts?.colorStoreOp ?? opts?.storeOp;
  const depthLoadOp = opts?.depthLoadOp ?? loadOp;
  const depthStoreOp = opts?.depthStoreOp ?? opts?.storeOp;
  const includeDepth = opts?.depth !== false;
  const cacheKey = encodeCloneOptions(colorLoadOp, colorStoreOp, depthLoadOp, depthStoreOp, includeDepth);
  let sourceCache = clonedRenderPassDescriptorCache.get(source);
  const cached = sourceCache?.get(cacheKey);
  const sourceAttachments = Array.isArray(source.colorAttachments)
    ? source.colorAttachments as readonly (GPURenderPassColorAttachment | null | undefined)[]
    : null;
  if (cached && sourceAttachments && matchesSourceDescriptor(source, sourceAttachments, cached)) return cached.descriptor;

  const { depthStencilAttachment: sourceDepth, ...sourceWithoutDepth } = source;
  const resolvedDepthLoadOp = depthLoadOp ?? sourceDepth?.depthLoadOp;
  const resolvedDepthStoreOp = depthStoreOp ?? sourceDepth?.depthStoreOp;
  const descriptor: GPURenderPassDescriptor = {
    ...sourceWithoutDepth,
    colorAttachments: Array.from(source.colorAttachments, attachment => (
      attachment ? {
        ...attachment,
        loadOp: colorLoadOp ?? attachment.loadOp,
        storeOp: colorStoreOp ?? attachment.storeOp,
      } : attachment
    )),
    ...(!includeDepth || !sourceDepth ? {} : {
      depthStencilAttachment: {
        ...sourceDepth,
        ...(resolvedDepthLoadOp === undefined ? {} : { depthLoadOp: resolvedDepthLoadOp }),
        ...(resolvedDepthStoreOp === undefined ? {} : { depthStoreOp: resolvedDepthStoreOp }),
      },
    }),
  };
  if (!sourceCache) {
    sourceCache = new Map();
    clonedRenderPassDescriptorCache.set(source, sourceCache);
  }
  if (sourceAttachments) sourceCache.set(cacheKey, captureSourceDescriptor(source, sourceAttachments, descriptor));
  return descriptor;
}

export function getCachedRenderPassDescriptor(
  engine: IEngine,
  loadOp?: RenderPassLoadOp,
): GPURenderPassDescriptor {
  const version = engine.getRenderPassDescriptorVersion?.();
  if (version === undefined) return cloneRenderPassDescriptor(engine.getRenderPassDescriptor(), loadOp);

  let cache = engineRenderPassDescriptorCache.get(engine);
  if (!cache) {
    cache = {};
    engineRenderPassDescriptorCache.set(engine, cache);
  }
  const key = loadOp ?? 'inherit';
  const cached = cache[key];
  if (cached && cached.version === version) {
    const tracker = getEngineGPUResourceTracker(engine);
    if (tracker?.debug) {
      tracker.recordCacheAccess('render-pass-descriptor', true, { entries: countCachedDescriptors(cache) });
    }
    return cached.descriptor;
  }

  const descriptor = cloneRenderPassDescriptor(engine.getRenderPassDescriptor(), loadOp);
  cache[key] = { version, descriptor };
  const tracker = getEngineGPUResourceTracker(engine);
  if (tracker?.debug) {
    tracker.recordCacheAccess('render-pass-descriptor', false, { entries: countCachedDescriptors(cache) });
  }
  return descriptor;
}

export function clearCachedRenderPassDescriptors(engine: IEngine): void {
  engineRenderPassDescriptorCache.delete(engine);
}

function countCachedDescriptors(cache: EngineRenderPassDescriptorCache): number {
  return (cache.clear ? 1 : 0) + (cache.load ? 1 : 0) + (cache.inherit ? 1 : 0);
}

function encodeCloneOptions(
  colorLoadOp: RenderPassLoadOp | undefined,
  colorStoreOp: RenderPassStoreOp | undefined,
  depthLoadOp: RenderPassLoadOp | undefined,
  depthStoreOp: RenderPassStoreOp | undefined,
  depth: boolean,
): number {
  let key = depth ? 1 : 0;
  key = key * 3 + encodeLoadOp(colorLoadOp);
  key = key * 3 + encodeStoreOp(colorStoreOp);
  key = key * 3 + encodeLoadOp(depthLoadOp);
  return key * 3 + encodeStoreOp(depthStoreOp);
}

function encodeLoadOp(value: RenderPassLoadOp | undefined): number {
  return value === 'clear' ? 1 : value === 'load' ? 2 : 0;
}

function encodeStoreOp(value: RenderPassStoreOp | undefined): number {
  return value === 'store' ? 1 : value === 'discard' ? 2 : 0;
}

function captureSourceDescriptor(
  source: GPURenderPassDescriptor,
  sourceAttachments: readonly (GPURenderPassColorAttachment | null | undefined)[],
  descriptor: GPURenderPassDescriptor,
): ClonedRenderPassDescriptorCacheEntry {
  const colorAttachments = new Array<RenderPassColorAttachmentState>(sourceAttachments.length);
  for (let i = 0; i < sourceAttachments.length; i++) {
    const attachment = sourceAttachments[i] ?? null;
    colorAttachments[i] = {
      attachment,
      view: attachment?.view,
      resolveTarget: attachment?.resolveTarget,
      clearValue: attachment?.clearValue,
      loadOp: attachment?.loadOp,
      storeOp: attachment?.storeOp,
      depthSlice: attachment?.depthSlice,
    };
  }
  const depth = source.depthStencilAttachment;
  return {
    descriptor,
    label: source.label,
    colorAttachments,
    depthStencilAttachment: depth ? {
      attachment: depth,
      view: depth.view,
      depthClearValue: depth.depthClearValue,
      depthLoadOp: depth.depthLoadOp,
      depthStoreOp: depth.depthStoreOp,
      depthReadOnly: depth.depthReadOnly,
      stencilClearValue: depth.stencilClearValue,
      stencilLoadOp: depth.stencilLoadOp,
      stencilStoreOp: depth.stencilStoreOp,
      stencilReadOnly: depth.stencilReadOnly,
    } : null,
    occlusionQuerySet: source.occlusionQuerySet,
    timestampWrites: source.timestampWrites,
    maxDrawCount: source.maxDrawCount,
  };
}

function matchesSourceDescriptor(
  source: GPURenderPassDescriptor,
  sourceAttachments: readonly (GPURenderPassColorAttachment | null | undefined)[],
  cached: ClonedRenderPassDescriptorCacheEntry,
): boolean {
  if (
    source.label !== cached.label
    || source.occlusionQuerySet !== cached.occlusionQuerySet
    || source.timestampWrites !== cached.timestampWrites
    || source.maxDrawCount !== cached.maxDrawCount
    || sourceAttachments.length !== cached.colorAttachments.length
  ) return false;
  for (let i = 0; i < sourceAttachments.length; i++) {
    const attachment = sourceAttachments[i] ?? null;
    const state = cached.colorAttachments[i];
    if (!state
      || attachment !== state.attachment
      || attachment?.view !== state.view
      || attachment?.resolveTarget !== state.resolveTarget
      || attachment?.clearValue !== state.clearValue
      || attachment?.loadOp !== state.loadOp
      || attachment?.storeOp !== state.storeOp
      || attachment?.depthSlice !== state.depthSlice
    ) return false;
  }
  const depth = source.depthStencilAttachment;
  const state = cached.depthStencilAttachment;
  return depth
    ? state !== null
      && depth === state.attachment
      && depth.view === state.view
      && depth.depthClearValue === state.depthClearValue
      && depth.depthLoadOp === state.depthLoadOp
      && depth.depthStoreOp === state.depthStoreOp
      && depth.depthReadOnly === state.depthReadOnly
      && depth.stencilClearValue === state.stencilClearValue
      && depth.stencilLoadOp === state.stencilLoadOp
      && depth.stencilStoreOp === state.stencilStoreOp
      && depth.stencilReadOnly === state.stencilReadOnly
    : state === null;
}
