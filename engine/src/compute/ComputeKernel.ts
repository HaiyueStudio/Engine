import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { requireEngineDevice } from '../core/IEngine';
import { EngineError, EngineErrorCode } from '../core/EngineError';

export interface ComputeKernelOptions {
  label?: string;
  code: string;
  entryPoint?: string;
  bindGroupLayoutEntries: GPUBindGroupLayoutEntry[];
  constants?: Record<string, number>;
}

export class ComputeKernel {
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly pipeline: GPUComputePipeline;

  private readonly engine: IEngine;
  private readonly label: string;
  private readonly device: GPUDevice;

  constructor(engine: IEngine, options: ComputeKernelOptions) {
    this.engine = engine;
    const device = requireEngineDevice(engine);
    const label = options.label ?? 'ComputeKernel';
    this.label = label;
    this.device = device;
    const module = device.createShaderModule({
      label: `${label} Shader`,
      code: options.code,
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      label: `${label} BindGroupLayout`,
      entries: options.bindGroupLayoutEntries,
    });

    this.pipeline = device.createComputePipeline({
      label,
      layout: device.createPipelineLayout({
        label: `${label} PipelineLayout`,
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: {
        module,
        entryPoint: options.entryPoint ?? 'main',
        ...(options.constants === undefined ? {} : { constants: options.constants }),
      },
    });
  }

  createBindGroup(entries: GPUBindGroupEntry[], label?: string): GPUBindGroup {
    if (this.engine.device !== this.device) throw new Error('ComputeKernel belongs to a previous device; recreate after device loss.');
    return this.device.createBindGroup({
      ...(label === undefined ? {} : { label }),
      layout: this.bindGroupLayout,
      entries,
    });
  }

  dispatch(target: GPUCommandEncoder | RenderCommandContext, bindGroup: GPUBindGroup, x: number, y = 1, z = 1): void {
    validateDispatchSize(x, y, z);
    if (this.engine.device !== this.device) throw new Error('ComputeKernel belongs to a previous device; recreate after device loss.');
    if (isRenderCommandContext(target) && (target.passEncoder || target.device !== this.device)) throw new Error('ComputeKernel cannot dispatch during an active render pass.');
    const maximum = this.device.limits?.maxComputeWorkgroupsPerDimension ?? 65535;
    if (x > maximum || y > maximum || z > maximum) throw new RangeError(`Compute dispatch exceeds device limit ${maximum}.`);
    const commandEncoder = isRenderCommandContext(target) ? target.encoder : target;
    const pass = commandEncoder.beginComputePass({ label: this.label });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(x, y, z);
    pass.end();
  }

  dispatchNow(bindGroup: GPUBindGroup, x: number, y = 1, z = 1): void {
    validateDispatchSize(x, y, z);
    const device = requireEngineDevice(this.engine);
    const commandEncoder = device.createCommandEncoder();
    this.dispatch(commandEncoder, bindGroup, x, y, z);
    device.queue.submit([commandEncoder.finish()]);
  }
}

function isRenderCommandContext(value: GPUCommandEncoder | RenderCommandContext): value is RenderCommandContext {
  return 'encoder' in value;
}

function validateDispatchSize(x: number, y: number, z: number): void {
  if (
    !Number.isInteger(x) || x < 1 ||
    !Number.isInteger(y) || y < 1 ||
    !Number.isInteger(z) || z < 1
  ) {
    throw new EngineError(
      EngineErrorCode.ComputeInvalidParameter,
      `Compute dispatch workgroup counts must be positive integers; received (${x}, ${y}, ${z}).`,
      {
        hint: 'Clamp dispatch counts to at least 1 and use integer workgroup dimensions.',
        docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
      },
    );
  }
}
