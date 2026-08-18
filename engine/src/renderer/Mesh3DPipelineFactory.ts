import type { IEngine } from '../core/IEngine';
import type { BlendMode } from '../material/BasicMaterial';
import { createColorTargetState, createPrimitiveState } from './gpuDescriptors';

export interface Mesh3DPipelineOptions {
  topology: GPUPrimitiveTopology;
  cullMode: GPUCullMode;
  frontFace: GPUFrontFace;
  stripIndexFormat?: GPUIndexFormat | undefined;
  reverseZ: boolean;
  msaaSamples: 1 | 4;
  depthWriteEnabled: boolean;
  depthCompare?: GPUCompareFunction;
  colorWriteMask?: GPUColorWriteFlags;
  blendState?: GPUBlendState;
  skinned?: boolean;
}

export class Mesh3DPipelineFactory {
  constructor(
    private readonly _engine: IEngine,
    private readonly _shaderModule: GPUShaderModule,
    private readonly _skinnedShaderModule: GPUShaderModule,
    private readonly _pipelineLayout: GPUPipelineLayout,
    private readonly _skinnedPipelineLayout: GPUPipelineLayout,
  ) {}

  create(options: Mesh3DPipelineOptions): GPURenderPipeline {
    return this._engine.device.createRenderPipeline(this.descriptor(options));
  }

  descriptor(options: Mesh3DPipelineOptions): GPURenderPipelineDescriptor {
    const { format } = this._engine;
    const skinned = options.skinned ?? false;
    return {
      layout: skinned ? this._skinnedPipelineLayout : this._pipelineLayout,
      vertex: {
        module: skinned ? this._skinnedShaderModule : this._shaderModule,
        entryPoint: 'vs_main',
        buffers: createMesh3DVertexBufferLayouts(),
      },
      fragment: {
        module: skinned ? this._skinnedShaderModule : this._shaderModule,
        entryPoint: 'fs_main',
        targets: [createColorTargetState(format, options.blendState, options.colorWriteMask)],
      },
      primitive: createPrimitiveState(options.topology, options.cullMode, options.frontFace, options.stripIndexFormat),
      depthStencil: {
        format: this._engine.getDepthFormat(options.reverseZ),
        depthWriteEnabled: options.depthWriteEnabled,
        depthCompare: options.depthCompare ?? (options.reverseZ ? 'greater' : 'less'),
      },
      multisample: { count: options.msaaSamples },
    };
  }

  createBlend(
    blending: BlendMode,
    options: Omit<Mesh3DPipelineOptions, 'blendState'>,
  ): GPURenderPipeline {
    return this._engine.device.createRenderPipeline(this.blendDescriptor(blending, options));
  }

  blendDescriptor(
    blending: BlendMode,
    options: Omit<Mesh3DPipelineOptions, 'blendState'>,
  ): GPURenderPipelineDescriptor {
    const blendState: GPUBlendState = blending === 'additive'
      ? {
          color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        }
      : {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        };
    return this.descriptor({ ...options, blendState });
  }
}

export function createMesh3DVertexBufferLayouts(): GPUVertexBufferLayout[] {
  return [
    { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
    { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
    { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
    { arrayStride: 12, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x3' }] },
    { arrayStride: 12, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x3' }] },
    { arrayStride: 12, attributes: [{ shaderLocation: 5, offset: 0, format: 'float32x3' }] },
    { arrayStride: 12, attributes: [{ shaderLocation: 6, offset: 0, format: 'float32x3' }] },
  ];
}
