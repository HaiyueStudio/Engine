import type { GpuInstanceSource } from './GpuInstanceSource';
import { validateGpuInstanceSource } from './GpuInstanceSource';
export interface ExternalInstanceBinding {
  source: GpuInstanceSource;
  materialBuf: GPUBuffer;
  bindGroup1: GPUBindGroup;
  materialId: number;
  materialRevision: number;
}
interface BindingVariant {
  readonly source: GpuInstanceSource;
  bindGroup1: GPUBindGroup;
  revision: number;
}
function sameBinding(a: GpuInstanceSource, b: GpuInstanceSource): boolean {
  return a.transforms === b.transforms && a.colors === b.colors
    && a.visibleIndices === b.visibleIndices && a.visibleOffset === b.visibleOffset
    && a.capacity === b.capacity;
}
/** Per-renderer borrowed-source binding cache. Only the tiny material uniform
 * is owned here; source buffers can be shared across body/weapon/LOD draws. */
export class GpuInstanceBindings {
  private entries = new Map<number, ExternalInstanceBinding>();
  // A view owns its visibility list. Retain a bounded set of immutable groups
  // so alternating views do not rebuild the same entity's binding every frame.
  private variants = new Map<number, BindingVariant[]>();
  private bindingRevision = 0;
  private entryRevisions = new WeakMap<ExternalInstanceBinding, number>();
  constructor(private device: GPUDevice, private bind: (source: GpuInstanceSource, uniform: GPUBuffer) => GPUBindGroup) {}
  get(id: number, source: GpuInstanceSource): ExternalInstanceBinding {
    validateGpuInstanceSource(this.device, source);
    let entry = this.entries.get(id);
    if (!entry) {
      const materialBuf = this.device.createBuffer({ label: `GpuInstances.${id}.material`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      entry = { source: { ...source }, materialBuf, bindGroup1: this.bind(source, materialBuf), materialId: -1, materialRevision: -1 };
      this.entries.set(id, entry);
      this.variants.set(id, [{ source: entry.source, bindGroup1: entry.bindGroup1, revision: this.bindingRevision }]);
      this.entryRevisions.set(entry, this.bindingRevision);
    } else {
      if (!sameBinding(entry.source, source) || this.entryRevisions.get(entry) !== this.bindingRevision) {
        const variants = this.variants.get(id)!;
        let selected: BindingVariant | undefined;
        for (const variant of variants) if (sameBinding(variant.source, source)) { selected = variant; break; }
        if (!selected) {
          selected = { source: { ...source }, bindGroup1: this.bind(source, entry.materialBuf), revision: this.bindingRevision };
          if (variants.length >= 16) variants.shift();
          variants.push(selected);
        } else if (selected.revision !== this.bindingRevision) {
          selected.bindGroup1 = this.bind(source, entry.materialBuf);
          selected.revision = this.bindingRevision;
        }
        entry.bindGroup1 = selected.bindGroup1;
        entry.source = selected.source;
        this.entryRevisions.set(entry, this.bindingRevision);
      }
    }
    return entry;
  }
  rebind(): void {
    // Borrowed visibility buffers in unused variants may already be retired.
    // Recreate only when a caller supplies that live source again.
    this.bindingRevision++;
  }
  release(live: { has(id: number): boolean }): void {
    for (const [id, entry] of this.entries) if (!live.has(id)) { entry.materialBuf.destroy(); this.entries.delete(id); this.variants.delete(id); }
  }
  destroy(): void { this.release({ has: () => false }); }
}
