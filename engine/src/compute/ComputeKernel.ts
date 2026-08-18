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

  constructor(engine: IEngine, options: ComputeKernelOptions) {
    this.engine = engine;
    const device = requireEngineDevice(engine);
    const label = options.label ?? 'ComputeKernel';
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
    return requireEngineDevice(this.engine).createBindGroup({
      ...(label === undefined ? {} : { label }),
      layout: this.bindGroupLayout,
      entries,
    });
  }

  dispatch(target: GPUCommandEncoder | RenderCommandContext, bindGroup: GPUBindGroup, x: number, y = 1, z = 1): void {
    validateDispatchSize(x, y, z);
    const commandEncoder = isRenderCommandContext(target) ? target.encoder : target;
    const pass = commandEncoder.beginComputePass();
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
