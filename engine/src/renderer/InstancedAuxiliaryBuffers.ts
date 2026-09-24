import type { IEngine } from '../core/IEngine';
import { IndirectDrawCommandBuffer } from './IndirectDrawCommandBuffer';
/** Legacy CPU instances pay for culling/sorting only when requested. */
export class InstancedAuxiliaryBuffers {
  private cull: { counterBuf: GPUBuffer; cullParamsBuf: GPUBuffer; cullBindGroup: GPUBindGroup } | null = null;
  private sort: { sortKeyBuf: GPUBuffer; sortIndexBuf: GPUBuffer; sortParamsBuf: GPUBuffer; sortBindGroup: GPUBindGroup } | null = null;
  private commands: IndirectDrawCommandBuffer | null = null;
  constructor(private engine: IEngine, private id: number, private capacity: number,
    private transforms: GPUBuffer, private visible: GPUBuffer, private frustum: GPUBuffer,
    private cullLayout: GPUBindGroupLayout, private sortLayout: GPUBindGroupLayout) {}
  get counter(): GPUBuffer | null { return this.cull?.counterBuf ?? null; }
  culling() {
    if (this.cull) return this.cull;
    const device = this.engine.device;
    const counterBuf = device.createBuffer({ label: `InstancedMesh3D.${this.id}.counter`, size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const cullParamsBuf = device.createBuffer({ label: `InstancedMesh3D.${this.id}.cullParams`, size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const cullBindGroup = device.createBindGroup({ layout: this.cullLayout, entries: [this.transforms, this.visible, counterBuf, this.frustum, cullParamsBuf].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    return this.cull = { counterBuf, cullParamsBuf, cullBindGroup };
  }
  sorting() {
    if (this.sort) return this.sort;
    const device = this.engine.device;
    const sortKeyBuf = device.createBuffer({ label: `InstancedMesh3D.${this.id}.sortKeys`, size: this.capacity * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const sortIndexBuf = device.createBuffer({ label: `InstancedMesh3D.${this.id}.sortIndices`, size: this.capacity * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const sortParamsBuf = device.createBuffer({ label: `InstancedMesh3D.${this.id}.sortParams`, size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sortBindGroup = device.createBindGroup({ layout: this.sortLayout, entries: [this.transforms, sortKeyBuf, sortIndexBuf, sortParamsBuf].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    return this.sort = { sortKeyBuf, sortIndexBuf, sortParamsBuf, sortBindGroup };
  }
  indirect(): IndirectDrawCommandBuffer {
    return this.commands ??= new IndirectDrawCommandBuffer(this.engine, `InstancedMesh3D.${this.id}`);
  }
  destroy(): void {
    this.cull?.counterBuf.destroy(); this.cull?.cullParamsBuf.destroy();
    this.sort?.sortKeyBuf.destroy(); this.sort?.sortIndexBuf.destroy(); this.sort?.sortParamsBuf.destroy();
    this.commands?.destroy(); this.cull = null; this.sort = null; this.commands = null;
  }
}
