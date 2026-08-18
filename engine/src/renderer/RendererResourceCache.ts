import { getInstrumentedGPUResourceTracker } from '../core/GPUResourceTracker';

type SharedRendererResource = object;

interface DeviceResourceCaches {
  pipelineLayouts: Map<string, GPUPipelineLayout>;
  resources: Map<string, SharedRendererResource>;
  maxPipelineLayouts: number;
  maxResources: number;
}

const deviceCaches = new WeakMap<GPUDevice, DeviceResourceCaches>();
const DEFAULT_MAX_PIPELINE_LAYOUTS = 256;
const DEFAULT_MAX_RESOURCES = 256;

function getDeviceCaches(device: GPUDevice): DeviceResourceCaches {
  let caches = deviceCaches.get(device);
  if (!caches) {
    caches = {
      pipelineLayouts: new Map(),
      resources: new Map(),
      maxPipelineLayouts: DEFAULT_MAX_PIPELINE_LAYOUTS,
      maxResources: DEFAULT_MAX_RESOURCES,
    };
    deviceCaches.set(device, caches);
  }
  return caches;
}

export class RendererPipelineLayoutCache {
  static get(device: GPUDevice, key: string, bindGroupLayouts: GPUBindGroupLayout[]): GPUPipelineLayout {
    const caches = getDeviceCaches(device);
    const cache = caches.pipelineLayouts;
    let layout = cache.get(key);
    if (layout) {
      getInstrumentedGPUResourceTracker(device)?.recordCacheAccess('renderer-pipeline-layout', true, { entries: cache.size });
      cache.delete(key);
      cache.set(key, layout);
      return layout;
    }
    layout = device.createPipelineLayout({ bindGroupLayouts });
    cache.set(key, layout);
    trimMap(cache, caches.maxPipelineLayouts);
    getInstrumentedGPUResourceTracker(device)?.recordCacheAccess('renderer-pipeline-layout', false, { entries: cache.size });
    return layout;
  }
}

export class RendererResourceCache {
  static get<T extends SharedRendererResource>(device: GPUDevice, key: string, create: () => T): T {
    const caches = getDeviceCaches(device);
    const cache = caches.resources;
    let resource = cache.get(key) as T | undefined;
    if (resource) {
      getInstrumentedGPUResourceTracker(device)?.recordCacheAccess('renderer-resource', true, { entries: cache.size });
      cache.delete(key);
      cache.set(key, resource);
      return resource;
    }
    resource = create();
    cache.set(key, resource);
    trimMap(cache, caches.maxResources, destroyIfPresent);
    getInstrumentedGPUResourceTracker(device)?.recordCacheAccess('renderer-resource', false, { entries: cache.size });
    return resource;
  }

  static delete(device: GPUDevice, key: string): void {
    const cache = getDeviceCaches(device).resources;
    const resource = cache.get(key);
    destroyIfPresent(resource);
    cache.delete(key);
  }

  static clear(device: GPUDevice): void {
    const caches = deviceCaches.get(device);
    if (!caches) return;
    for (const resource of caches.resources.values()) destroyIfPresent(resource);
    caches.resources.clear();
    caches.pipelineLayouts.clear();
  }

  static configure(device: GPUDevice, options: { maxResources?: number; maxPipelineLayouts?: number }): void {
    const caches = getDeviceCaches(device);
    if (options.maxResources !== undefined) caches.maxResources = normalizeLimit(options.maxResources);
    if (options.maxPipelineLayouts !== undefined) caches.maxPipelineLayouts = normalizeLimit(options.maxPipelineLayouts);
    trimMap(caches.resources, caches.maxResources, destroyIfPresent);
    trimMap(caches.pipelineLayouts, caches.maxPipelineLayouts);
  }

  static getStats(device: GPUDevice): { resources: number; pipelineLayouts: number; maxResources: number; maxPipelineLayouts: number } {
    const caches = getDeviceCaches(device);
    return {
      resources: caches.resources.size,
      pipelineLayouts: caches.pipelineLayouts.size,
      maxResources: caches.maxResources,
      maxPipelineLayouts: caches.maxPipelineLayouts,
    };
  }
}

function destroyIfPresent(resource: SharedRendererResource | undefined): void {
  const destroy = (resource as { destroy?: unknown } | undefined)?.destroy;
  if (typeof destroy === 'function') destroy.call(resource);
}

function trimMap<T>(map: Map<string, T>, maxEntries: number, destroy?: (value: T) => void): void {
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) return;
    const value = map.get(oldestKey);
    map.delete(oldestKey);
    if (value !== undefined) destroy?.(value);
  }
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.floor(limit));
}
