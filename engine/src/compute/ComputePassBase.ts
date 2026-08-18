import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { createComputePipelineAsync, type PipelineWarmupPlan } from '../renderer/PipelineWarmup';

export interface ComputePassBaseOptions {
  label: string;
  shaderCode: string;
  bindGroupLayoutEntries: GPUBindGroupLayoutEntry[];
  entryPoint?: string;
}

export abstract class ComputePassBase {
  protected readonly engine: IEngine;
  protected readonly label: string;
  private readonly _shaderCode: string;
  private readonly _bindGroupLayoutEntries: GPUBindGroupLayoutEntry[];
  private readonly _entryPoint: string;
  private _pipeline: GPUComputePipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _pipelineLayout: GPUPipelineLayout | null = null;
  private _shader: GPUShaderModule | null = null;
  private readonly _warmupId = ++computePassWarmupId;
  private readonly _uniformBuffers = new Set<GPUBuffer>();
  private readonly _storageBuffers = new Set<GPUBuffer>();

  protected constructor(engine: IEngine, options: ComputePassBaseOptions) {
    this.engine = engine;
    this.label = options.label;
    this._shaderCode = options.shaderCode;
    this._bindGroupLayoutEntries = options.bindGroupLayoutEntries;
    this._entryPoint = options.entryPoint ?? 'cs_main';
  }

  protected get pipeline(): GPUComputePipeline | null {
    this.prepare();
    return this._pipeline;
  }

  protected get bindGroupLayout(): GPUBindGroupLayout | null {
    this.prepare();
    return this._bindGroupLayout;
  }

  protected prepare(): boolean {
    if (this._pipeline) return true;
    if (!this._prepareLayout()) return false;
    const device = this.engine.device;
    this._pipeline = device.createComputePipeline(this._pipelineDescriptor());
    return true;
  }

  /** Adds this pass' compute pipeline without compiling it synchronously. */
  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    if (!this._prepareLayout()) return;
    const device = this.engine.device;
    plan.add({
      id: `${this.constructor.name}#${this._warmupId}:compute`,
      label: this.label,
      compile: async () => {
        if (this._pipeline) return;
        const pipeline = await createComputePipelineAsync(device, this._pipelineDescriptor(), {
          owner: this.constructor.name,
          key: this._warmupId,
          label: this.label,
        });
        this._pipeline ??= pipeline;
      },
    });
  }

  private _prepareLayout(): boolean {
    if (this._bindGroupLayout && this._pipelineLayout && this._shader) return true;
    const device = this.engine.device;
    if (!device) return false;
    this._bindGroupLayout = device.createBindGroupLayout({
      label: `${this.label}.bindGroupLayout`,
      entries: this._bindGroupLayoutEntries,
    });
    this._shader = device.createShaderModule({
      label: `${this.label}.shader`,
      code: this._shaderCode,
    });
    this._pipelineLayout = device.createPipelineLayout({
      label: `${this.label}.pipelineLayout`,
      bindGroupLayouts: [this._bindGroupLayout],
    });
    return true;
  }

  private _pipelineDescriptor(): GPUComputePipelineDescriptor {
    return {
      label: this.label,
      layout: this._pipelineLayout!,
      compute: { module: this._shader!, entryPoint: this._entryPoint },
    };
  }

  protected createUniformBuffer(label: string, size: number): GPUBuffer | null {
    const device = this.engine.device;
    if (!device) return null;
    const buffer = device.createBuffer({
      label,
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._uniformBuffers.add(buffer);
    return buffer;
  }

  protected destroyUniformBuffer(buffer: GPUBuffer | null): void {
    if (!buffer) return;
    this._uniformBuffers.delete(buffer);
    buffer.destroy();
  }

  protected createStorageBuffer(label: string, size: number): GPUBuffer | null {
    const device = this.engine.device;
    if (!device) return null;
    const buffer = device.createBuffer({
      label,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._storageBuffers.add(buffer);
    return buffer;
  }

  protected destroyStorageBuffer(buffer: GPUBuffer | null): void {
    if (!buffer) return;
    this._storageBuffers.delete(buffer);
    buffer.destroy();
  }

  protected createBindGroup(label: string, entries: GPUBindGroupEntry[]): GPUBindGroup | null {
    const device = this.engine.device;
    const layout = this.bindGroupLayout;
    if (!device || !layout) return null;
    return device.createBindGroup({ label, layout, entries });
  }

  protected dispatch(context: RenderCommandContext, bindGroup: GPUBindGroup, x: number, y = 1, z = 1, dynamicOffsets?: number[]): void {
    const pipeline = this.pipeline;
    if (!pipeline) return;
    const pass = context.encoder.beginComputePass({ label: this.label });
    pass.setPipeline(pipeline);
    // WebIDL treats an explicitly passed `undefined` third argument as the
    // sequence overload on some WebGPU implementations. Omit the optional
    // argument entirely when this dispatch has no dynamic offsets.
    if (dynamicOffsets === undefined) pass.setBindGroup(0, bindGroup);
    else pass.setBindGroup(0, bindGroup, dynamicOffsets);
    pass.dispatchWorkgroups(x, y, z);
    pass.end();
  }

  destroy(): void {
    for (const buffer of this._uniformBuffers) buffer.destroy();
    this._uniformBuffers.clear();
    for (const buffer of this._storageBuffers) buffer.destroy();
    this._storageBuffers.clear();
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._pipelineLayout = null;
    this._shader = null;
  }
}

let computePassWarmupId = 0;
