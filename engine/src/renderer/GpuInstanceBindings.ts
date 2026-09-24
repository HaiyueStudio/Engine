import type { GpuInstanceSource } from './GpuInstanceSource';
import { validateGpuInstanceSource } from './GpuInstanceSource';
export interface ExternalInstanceBinding {
  source: GpuInstanceSource;
  materialBuf: GPUBuffer;
  bindGroup1: GPUBindGroup;
  materialId: number;
  materialRevision: number;
}
/** Per-renderer borrowed-source binding cache. Only the tiny material uniform
 * is owned here; source buffers can be shared across body/weapon/LOD draws. */
export class GpuInstanceBindings {
  private entries = new Map<number, ExternalInstanceBinding>();
  constructor(private device: GPUDevice, private bind: (source: GpuInstanceSource, uniform: GPUBuffer) => GPUBindGroup) {}
  get(id: number, source: GpuInstanceSource): ExternalInstanceBinding {
    validateGpuInstanceSource(this.device, source);
    let entry = this.entries.get(id);
    if (!entry) {
      const materialBuf = this.device.createBuffer({ label: `GpuInstances.${id}.material`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      entry = { source: { ...source }, materialBuf, bindGroup1: this.bind(source, materialBuf), materialId: -1, materialRevision: -1 };
      this.entries.set(id, entry);
    } else {
      const previous = entry.source;
      if (previous.transforms !== source.transforms || previous.colors !== source.colors || previous.visibleIndices !== source.visibleIndices || previous.visibleOffset !== source.visibleOffset || previous.capacity !== source.capacity) {
        entry.bindGroup1 = this.bind(source, entry.materialBuf);
        entry.source = { ...source };
      }
    }
    return entry;
  }
  rebind(): void { for (const entry of this.entries.values()) entry.bindGroup1 = this.bind(entry.source, entry.materialBuf); }
  release(live: { has(id: number): boolean }): void {
    for (const [id, entry] of this.entries) if (!live.has(id)) { entry.materialBuf.destroy(); this.entries.delete(id); }
  }
  destroy(): void { this.release({ has: () => false }); }
}
