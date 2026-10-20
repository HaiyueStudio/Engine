import type { PbrFullLightingState } from './PbrDeferredSurfacePort';

/** Retains binding provenance without extending the lifetime of retired scene groups. */
export class PbrSceneBindGroups {
  private readonly _entries = new WeakMap<GPUBindGroup, readonly GPUBindGroupEntry[]>();

  create(device: GPUDevice, layout: GPUBindGroupLayout, entries: readonly GPUBindGroupEntry[]): GPUBindGroup {
    const group = device.createBindGroup({ layout, entries });
    this._entries.set(group, entries);
    return group;
  }

  resolve(base: GPUBindGroup, fullLighting: PbrFullLightingState | null): GPUBindGroup {
    if (!fullLighting) return base;
    const entries = this._entries.get(base);
    if (!entries) throw new Error('Missing PBR scene binding provenance.');
    return fullLighting.bindGroup(base, entries);
  }
}
