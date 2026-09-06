import type { GpuDrivenBatchBuffer } from './GpuDrivenBatchBuffer';

/** The binding subset shared by a render pass, a bundle, and the reusable state below. */
export interface RenderBatchBindingEncoder {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, group: GPUBindGroup, offsets?: Uint32Array): void;
  setVertexBuffer(index: number, buffer: GPUBuffer): void;
}

interface CachedBundle {
  readonly key: readonly unknown[];
  readonly bundles: GPURenderBundle[];
}

/**
 * Records one geometry/material range once, then submits it with executeBundles.
 * Only command bindings are cached: indirect counts/firstInstance, transforms,
 * clipping, material uniforms, and deformation contents stay live GPU data.
 */
export class IndirectBatchBundleCache implements RenderBatchBindingEncoder {
  readonly stats = { builds: 0, hits: 0, executions: 0, encodedDraws: 0, reusedDraws: 0, evictions: 0 };
  private _cache = new WeakMap<GPUBuffer, Map<number, CachedBundle>>();
  private readonly _key: unknown[] = [];
  private _pipeline: GPURenderPipeline | null = null;
  private readonly _groups: Array<GPUBindGroup | undefined> = new Array(4);
  private readonly _offsets: Array<number | undefined> = new Array(4);
  private readonly _vertices: Array<GPUBuffer | undefined> = new Array(8);
  private readonly _dynamicOffset = new Uint32Array(1);

  begin(): this {
    this._pipeline = null;
    this._groups.fill(undefined);
    this._offsets.fill(undefined);
    this._vertices.fill(undefined);
    return this;
  }

  setPipeline(pipeline: GPURenderPipeline): void { this._pipeline = pipeline; }
  setBindGroup(index: number, group: GPUBindGroup, offsets?: Uint32Array): void {
    this._groups[index] = group;
    // Built-in renderer bindings have at most one dynamic SceneFrame offset.
    if (offsets && offsets.length !== 1) throw new Error('Indirect batch expects one SceneFrame dynamic offset.');
    this._offsets[index] = offsets?.[0];
  }
  setVertexBuffer(index: number, buffer: GPUBuffer): void { this._vertices[index] = buffer; }

  draw(
    pass: GPURenderPassEncoder,
    device: GPUDevice,
    batches: GpuDrivenBatchBuffer,
    first: number,
    count: number,
    indexBuffer: GPUBuffer | null,
    indexFormat: GPUIndexFormat,
    colorFormats: readonly (GPUTextureFormat | null)[],
    depthStencilFormat: GPUTextureFormat,
    sampleCount: number,
  ): void {
    if (!this._pipeline || count < 1) return;
    const indirect = indexBuffer ? batches.indexedIndirectBuffer : batches.drawIndirectBuffer;
    const key = this._key;
    key.length = 0;
    key.push(this._pipeline, indexBuffer, indexFormat, count, depthStencilFormat, sampleCount);
    key.push(...this._groups, ...this._offsets, ...this._vertices, ...colorFormats);
    let cache = this._cache.get(indirect);
    if (!cache) this._cache.set(indirect, cache = new Map());
    let entry = cache.get(first);
    if (!entry || !sameKey(entry.key, key)) {
      const encoder = device.createRenderBundleEncoder({
        label: 'Render3D.indirectBatch', colorFormats, depthStencilFormat, sampleCount,
      });
      encoder.setPipeline(this._pipeline);
      for (let slot = 0; slot < this._groups.length; slot++) {
        const group = this._groups[slot];
        if (!group) continue;
        const offset = this._offsets[slot];
        if (offset === undefined) encoder.setBindGroup(slot, group);
        else {
          this._dynamicOffset[0] = offset;
          encoder.setBindGroup(slot, group, this._dynamicOffset);
        }
      }
      for (let slot = 0; slot < this._vertices.length; slot++) {
        const buffer = this._vertices[slot];
        if (buffer) encoder.setVertexBuffer(slot, buffer);
      }
      if (indexBuffer) encoder.setIndexBuffer(indexBuffer, indexFormat);
      for (let index = first; index < first + count; index++) {
        if (indexBuffer) encoder.drawIndexedIndirect(indirect, batches.getIndexedIndirectOffset(index));
        else encoder.drawIndirect(indirect, batches.getDrawIndirectOffset(index));
      }
      entry = { key: key.slice(), bundles: [encoder.finish()] };
      cache.set(first, entry);
      // A changing sort/run layout must not retain an unbounded command history.
      if (cache.size > 256) {
        cache.delete(cache.keys().next().value!);
        this.stats.evictions++;
      }
      this.stats.builds++;
      this.stats.encodedDraws += count;
    } else {
      this.stats.hits++;
      this.stats.reusedDraws += count;
    }
    pass.executeBundles(entry.bundles);
    this.stats.executions++;
  }

  clear(): void {
    // Weak buffer keys also release entries with retired view-ring generations.
    // Bundles own no destroyable allocation; buffer retirement stays with its owner.
    this._cache = new WeakMap();
    this._key.length = 0;
    this.begin();
  }
}

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
