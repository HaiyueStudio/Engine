import type { IEngine } from '../core/IEngine';
import { requireEngineDevice } from '../core/IEngine';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { getBuiltinSpecializedRenderingShader } from '../shader/BuiltinSpecializedRenderingShader';
import type { PrecompiledShaderPassV2 } from '../shader/PrecompiledShaderRuntime';

export type ConvolutionKernelName = 'identity' | 'blur' | 'sharpen' | 'edge' | 'emboss';

export const CONVOLUTION_KERNELS: Record<ConvolutionKernelName, number[]> = {
  identity: [
    0, 0, 0,
    0, 1, 0,
    0, 0, 0,
  ],
  blur: [
    1 / 9, 1 / 9, 1 / 9,
    1 / 9, 1 / 9, 1 / 9,
    1 / 9, 1 / 9, 1 / 9,
  ],
  sharpen: [
    0, -1, 0,
    -1, 5, -1,
    0, -1, 0,
  ],
  edge: [
    -1, -1, -1,
    -1, 8, -1,
    -1, -1, -1,
  ],
  emboss: [
    -2, -1, 0,
    -1, 1, 1,
    0, 1, 2,
  ],
};

export interface TextureConvolutionOptions {
  format?: GPUTextureFormat;
}

export interface TextureConvolutionProcessOptions {
  sourceView: GPUTextureView;
  width: number;
  height: number;
  kernel: number[] | Float32Array | ConvolutionKernelName;
  destination?: GPUTexture;
}

export class TextureConvolutionProcessor {
  private readonly engine: IEngine;
  private readonly format: GPUTextureFormat;
  private device: GPUDevice | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private paramsBuffer: GPUBuffer | null = null;
  private workgroupWidth = 0;
  private workgroupHeight = 0;

  constructor(engine: IEngine, options: TextureConvolutionOptions = {}) {
    this.engine = engine;
    this.format = options.format ?? 'rgba8unorm';
    if (this.format !== 'rgba8unorm') {
      throw new EngineError(
        EngineErrorCode.ComputeInvalidParameter,
        `TextureConvolutionProcessor does not support storage output format ${this.format}.`,
        {
          path: 'TextureConvolutionProcessor.options.format',
          context: { requestedFormat: this.format, supportedFormats: ['rgba8unorm'] },
          hint: 'Use format: "rgba8unorm" or add a shader/storage texture variant for the requested format.',
          docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
        },
      );
    }
    this.ensureResources();
  }

  private ensureResources(): GPUDevice {
    const device = requireEngineDevice(this.engine);
    if (this.device === device && this.pipeline && this.bindGroupLayout && this.paramsBuffer) return device;
    this.releaseDeviceResources();
    const generated = getBuiltinSpecializedRenderingShader(device, 'texture-convolution');
    const contract = deriveConvolutionContract(generated.pass);
    if (this.format !== contract.format) {
      throw new EngineError(
        EngineErrorCode.ComputeInvalidParameter,
        `TextureConvolutionProcessor artifact requires ${contract.format}, received ${this.format}.`,
        {
          path: 'TextureConvolutionProcessor.options.format',
          context: { requestedFormat: this.format, artifactFormat: contract.format },
          hint: 'Use the storage texture format declared by the production shader artifact.',
          docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
        },
      );
    }
    this.device = device;
    this.bindGroupLayout = generated.bindGroupLayout;
    this.pipeline = device.createComputePipeline({
      label: 'TextureConvolutionProcessor',
      layout: generated.pipelineLayout,
      compute: { module: generated.module, entryPoint: generated.pass.entryPoints.compute! },
    });
    this.paramsBuffer = device.createBuffer({
      label: 'TextureConvolutionProcessor Params',
      size: contract.paramsByteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.workgroupWidth = contract.workgroupWidth;
    this.workgroupHeight = contract.workgroupHeight;
    return device;
  }

  process(options: TextureConvolutionProcessOptions): GPUTexture {
    const device = this.ensureResources();
    if (!Number.isFinite(options.width) || options.width < 1 || !Number.isFinite(options.height) || options.height < 1) {
      throw new EngineError(
        EngineErrorCode.ComputeInvalidParameter,
        `TextureConvolutionProcessor dimensions must be positive; received ${options.width}x${options.height}.`,
        {
          hint: 'Pass the source texture size in physical pixels.',
          docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
        },
      );
    }
    const destination = options.destination ?? device.createTexture({
      label: 'TextureConvolutionProcessor Output',
      size: [options.width, options.height],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    const kernel = this.resolveKernel(options.kernel);
    const data = new Float32Array(16);
    data.set(kernel, 0);
    const u32 = new Uint32Array(data.buffer);
    u32[12] = options.width;
    u32[13] = options.height;
    device.queue.writeBuffer(this.paramsBuffer!, 0, data);

    const bindGroup = device.createBindGroup({
      label: 'TextureConvolutionProcessor.bindGroup',
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: options.sourceView },
        { binding: 1, resource: destination.createView() },
        { binding: 2, resource: { buffer: this.paramsBuffer! } },
      ],
    });
    const encoder = device.createCommandEncoder({ label: 'TextureConvolutionProcessor.encoder' });
    const pass = encoder.beginComputePass({ label: 'TextureConvolutionProcessor.pass' });
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(options.width / this.workgroupWidth),
      Math.ceil(options.height / this.workgroupHeight),
    );
    pass.end();
    device.queue.submit([encoder.finish()]);
    return destination;
  }

  destroy(): void {
    this.releaseDeviceResources();
  }

  private releaseDeviceResources(): void {
    this.paramsBuffer?.destroy();
    this.paramsBuffer = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.device = null;
    this.workgroupWidth = 0;
    this.workgroupHeight = 0;
  }

  private resolveKernel(kernel: number[] | Float32Array | ConvolutionKernelName): Float32Array {
    const values = typeof kernel === 'string' ? CONVOLUTION_KERNELS[kernel] : kernel;
    if (!values || values.length !== 9) {
      throw new EngineError(
        EngineErrorCode.ComputeInvalidParameter,
        'Texture convolution kernel must contain exactly 9 values.',
        {
          hint: 'Use one of the built-in kernel names or provide a 3x3 kernel array.',
          docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
        },
      );
    }
    const resolved = new Float32Array(12);
    resolved.set(values);
    return resolved;
  }
}

interface ConvolutionArtifactContract {
  readonly format: GPUTextureFormat;
  readonly paramsByteSize: number;
  readonly workgroupWidth: number;
  readonly workgroupHeight: number;
}

function deriveConvolutionContract(pass: PrecompiledShaderPassV2): ConvolutionArtifactContract {
  const destination = pass.bindGroups
    .flatMap(group => group.bindings)
    .find(binding => binding.id === 'pass.convolutionDestination');
  const params = pass.uniformBlocks.find(block => block.id === 'pass.convolutionParameters');
  if (!destination || destination.layout.kind !== 'storage-texture' || !params) {
    throw new EngineError(
      EngineErrorCode.ComputeInvalidParameter,
      'Texture convolution artifact is missing its typed storage texture or parameter layout.',
      {
        path: 'TextureConvolutionProcessor.artifact',
        context: { passId: pass.id, canonicalHash: pass.canonicalHash },
        docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
      },
    );
  }
  if (!pass.passRequirements.includes('workgroup-size-8x8')) {
    throw new EngineError(
      EngineErrorCode.ComputeInvalidParameter,
      'Texture convolution artifact is missing the reviewed workgroup-size-8x8 requirement.',
      {
        path: 'TextureConvolutionProcessor.artifact.passRequirements',
        context: { passId: pass.id, requirements: pass.passRequirements },
        docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
      },
    );
  }
  return Object.freeze({
    format: destination.layout.format as GPUTextureFormat,
    paramsByteSize: params.byteSize,
    workgroupWidth: 8,
    workgroupHeight: 8,
  });
}
