import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { ComputeKernelOptions } from './ComputeKernel';
/** Async-initialized compute owner for advanced GPU simulation. It never
 * compiles in dispatch; borrowed bind resources remain caller-owned. */
export class GpuComputeProgram {
  private device: GPUDevice | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private layout: GPUBindGroupLayout | null = null;
  private bindings = new WeakSet<GPUBindGroup>();
  private generation = 0;
  private destroyed = false;
  private pending: Promise<void> | null = null;
  private options: ComputeKernelOptions;
  constructor(private engine: IEngine, options: ComputeKernelOptions) {
    this.options = { ...options, bindGroupLayoutEntries: options.bindGroupLayoutEntries.map(e => ({ ...e, ...(e.buffer ? { buffer: { ...e.buffer } } : {}) })), ...(options.constants ? { constants: { ...options.constants } } : {}) };
  }
  initialize(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('Compute program is destroyed.'));
    if (this.device === this.engine.device && this.pipeline) return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = ++this.generation, device = this.engine.device, label = this.options.label ?? 'GpuComputeProgram';
    this.pending = (async () => {
      const layout = device.createBindGroupLayout({ label, entries: this.options.bindGroupLayoutEntries });
      const module = device.createShaderModule({ label, code: this.options.code });
      const descriptor: GPUComputePipelineDescriptor = { label, layout: device.createPipelineLayout({ label, bindGroupLayouts: [layout] }), compute: { module, entryPoint: this.options.entryPoint ?? 'main', ...(this.options.constants ? { constants: this.options.constants } : {}) } };
      const pipeline = await device.createComputePipelineAsync(descriptor);
      if (this.destroyed || generation !== this.generation || this.engine.device !== device) throw new Error('Compute initialization was superseded by disposal/device loss.');
      this.device = device; this.layout = layout; this.pipeline = pipeline; this.bindings = new WeakSet();
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  createBindGroup(entries: GPUBindGroupEntry[]): GPUBindGroup {
    this.ready();
    const group = this.device!.createBindGroup({ label: this.options.label ?? 'GpuComputeProgram', layout: this.layout!, entries });
    this.bindings.add(group); return group;
  }
  dispatch(context: RenderCommandContext, group: GPUBindGroup, x: number, y = 1, z = 1): void {
    this.validateContext(context, group);
    const max = this.device!.limits.maxComputeWorkgroupsPerDimension;
    if (![x, y, z].every(n => Number.isSafeInteger(n) && n >= 0 && n <= max)) throw new RangeError('Compute workgroup count exceeds device limits.');
    if (x === 0 || y === 0 || z === 0) return;
    const pass = this.begin(context, group); pass.dispatchWorkgroups(x, y, z); pass.end();
  }
  dispatchIndirect(context: RenderCommandContext, group: GPUBindGroup, buffer: GPUBuffer, offset = 0): void {
    this.validateContext(context, group);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % 4 || offset + 12 > buffer.size || !(buffer.usage & GPUBufferUsage.INDIRECT)) throw new RangeError('Invalid indirect compute command.');
    const pass = this.begin(context, group); pass.dispatchWorkgroupsIndirect(buffer, offset); pass.end();
  }
  destroy(): void { this.destroyed = true; this.generation++; this.device = null; this.pipeline = null; this.layout = null; this.bindings = new WeakSet(); }
  private ready(): void { if (this.destroyed || !this.pipeline || this.device !== this.engine.device) throw new Error('Initialize the compute program on the current device before use.'); }
  private validateContext(context: RenderCommandContext, group: GPUBindGroup): void {
    this.ready();
    if (context.device !== this.device || context.passEncoder || !this.bindings.has(group)) throw new Error('Compute context/bind group is stale, foreign or inside a render pass.');
  }
  private begin(context: RenderCommandContext, group: GPUBindGroup): GPUComputePassEncoder {
    const pass = context.encoder.beginComputePass({ label: this.options.label ?? 'GpuComputeProgram' });
    pass.setPipeline(this.pipeline!); pass.setBindGroup(0, group); return pass;
  }
}
